/**
 * Pool de miroirs Overpass, avec mémoire des refus.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────
 *
 * Le 2026-08-19, deux IP ont été bannies d'`overpass-api.de` en une seule journée : celle du
 * VPS le matin, celle du poste l'après-midi. Dans les deux cas le scénario était identique —
 * une série de HTTP 429, puis un ECONNREFUSED immédiat qui ressemble à une panne réseau alors
 * que c'est une porte fermée.
 *
 * La leçon n'est pas « changer de miroir » mais « écouter ce que le miroir dit ». Un 429 est un
 * avertissement : il faut RALENTIR, pas insister. Sans ça on épuise les instances une par une,
 * et il n'en reste plus une seule le jour où on en a besoin.
 *
 * ── LES TROIS RÈGLES ─────────────────────────────────────────────────────────────────
 *
 *   1. ROTATION — on ne tape jamais deux fois de suite le même miroir. La charge se répartit,
 *      aucun ne voit une pression soutenue ;
 *   2. RALENTISSEMENT PROGRESSIF — chaque 429 double la pause propre à ce miroir (jusqu'à
 *      5 min). Chaque succès la réduit d'un quart. Le pool trouve donc tout seul la cadence
 *      que les serveurs acceptent, au lieu de la deviner ;
 *   3. MISE À L'ÉCART — un refus de connexion ou un délai dépassé, c'est un bannissement, pas
 *      un aléa : le miroir est écarté une heure. On ne le harcèle pas pendant qu'il nous ferme
 *      la porte, ce qui laisse le bannissement expirer au lieu de le prolonger.
 *
 * Ce module est PUR côté décision (aucun réseau) : `choisir()` et les deux retours d'expérience
 * sont testables sans toucher Internet.
 */

/** Cadence de départ par miroir, en ms. Volontairement calme : on repart d'un ban. */
const PAUSE_INITIALE_MS = 6_000;
/** Jamais plus lent que ça — au-delà, autant s'arrêter et le dire. */
const PAUSE_MAX_MS = 300_000;
/** Mise à l'écart après un refus franc (connexion refusée, délai dépassé). */
const ECART_MS = 60 * 60 * 1000;

/** Miroirs planétaires connus. Ordre indifférent : la rotation les égalise. */
const MIROIRS_PAR_DEFAUT = [
  { nom: 'overpass-api.de', url: 'https://overpass-api.de/api/interpreter' },
  { nom: 'kumi.systems', url: 'https://overpass.kumi.systems/api/interpreter' },
  { nom: 'private.coffee', url: 'https://overpass.private.coffee/api/interpreter' },
  { nom: 'maps.mail.ru', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
];

/**
 * Un refus est-il un BANNISSEMENT (porte fermée) plutôt qu'un simple encombrement ?
 *
 * ⚠️ La distinction est celle qui manquait. Un 429 dit « ralentis » ; un ECONNREFUSED dit
 * « va-t'en ». Les traiter pareil, c'est soit abandonner un miroir qui voulait juste souffler,
 * soit s'acharner sur un miroir qui nous a fermé la porte — et prolonger le bannissement.
 */
function estBannissement(motif) {
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|fetch failed|aborted|timeout|délai/i.test(String(motif));
}

class PoolMiroirs {
  constructor(miroirs = MIROIRS_PAR_DEFAUT, maintenant = () => Date.now()) {
    this.maintenant = maintenant;
    this.etats = miroirs.map((m) => ({
      ...m,
      pauseMs: PAUSE_INITIALE_MS,
      /** Instant avant lequel ce miroir ne doit pas être sollicité. */
      libreA: 0,
      /** Instant avant lequel il est mis à l'écart pour bannissement. */
      ecarteJusqua: 0,
      succes: 0,
      refus: 0,
      bannissements: 0,
    }));
    this.dernier = null;
  }

  /**
   * Choisit le prochain miroir : le disponible le plus tôt, en évitant de reprendre le même
   * deux fois de suite tant qu'un autre est prêt.
   *
   * Renvoie `{ miroir, attendreMs }` — l'appelant attend puis appelle. `null` si tous les
   * miroirs sont écartés : il faut alors s'arrêter, pas boucler à vide.
   */
  choisir() {
    const t = this.maintenant();
    const dispo = this.etats.filter((e) => e.ecarteJusqua <= t);
    if (dispo.length === 0) return null;

    // On évite le dernier utilisé tant qu'un autre existe : c'est la rotation.
    const candidats = dispo.length > 1 && this.dernier
      ? dispo.filter((e) => e.nom !== this.dernier)
      : dispo;
    const choisi = candidats.reduce((a, b) => (a.libreA <= b.libreA ? a : b));
    return { miroir: choisi, attendreMs: Math.max(0, choisi.libreA - t) };
  }

  /** Le miroir a répondu : on peut le solliciter un peu plus vite la prochaine fois. */
  succes(miroir) {
    const e = this.etats.find((x) => x.nom === miroir.nom);
    if (!e) return;
    e.succes += 1;
    e.pauseMs = Math.max(PAUSE_INITIALE_MS, Math.round(e.pauseMs * 0.75));
    e.libreA = this.maintenant() + e.pauseMs;
    this.dernier = e.nom;
  }

  /**
   * Le miroir a refusé. Deux traitements très différents selon le motif — c'est le cœur du
   * module, et ce qui a manqué le 2026-08-19.
   */
  echec(miroir, motif) {
    const e = this.etats.find((x) => x.nom === miroir.nom);
    if (!e) return { ecarte: false };
    e.refus += 1;
    this.dernier = e.nom;
    if (estBannissement(motif)) {
      e.bannissements += 1;
      e.ecarteJusqua = this.maintenant() + ECART_MS;
      return { ecarte: true };
    }
    // Encombrement (429, 504…) : on ralentit CE miroir, on ne l'abandonne pas.
    e.pauseMs = Math.min(PAUSE_MAX_MS, e.pauseMs * 2);
    e.libreA = this.maintenant() + e.pauseMs;
    return { ecarte: false };
  }

  /** Vrai quand plus aucun miroir n'est joignable : l'appelant doit s'arrêter proprement. */
  tousEcartes() {
    const t = this.maintenant();
    return this.etats.every((e) => e.ecarteJusqua > t);
  }

  resume() {
    const t = this.maintenant();
    return this.etats
      .map((e) => {
        const etat = e.ecarteJusqua > t ? `ecarte ${Math.ceil((e.ecarteJusqua - t) / 60000)} min` : `${Math.round(e.pauseMs / 1000)}s`;
        return `${e.nom} ${e.succes}/${e.succes + e.refus} (${etat})`;
      })
      .join(' · ');
  }
}

module.exports = { PoolMiroirs, estBannissement, MIROIRS_PAR_DEFAUT, PAUSE_INITIALE_MS, PAUSE_MAX_MS, ECART_MS };
