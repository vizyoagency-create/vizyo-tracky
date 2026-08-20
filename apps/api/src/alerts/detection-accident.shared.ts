/**
 * Détection d'accident par la TÉLÉMÉTRIE — la logique pure.
 *
 * ── Pourquoi cette détection existe, alors qu'un capteur de choc serait meilleur ─────
 *
 * Elle ne remplace pas le capteur de choc, elle comble son absence. Constat du 20/08 :
 * le capteur n'a jamais été armé sur aucun boîtier, parce que la commande d'armement partait
 * sur un canal que ces boîtiers n'écoutent pas. Une fois l'armement réparé, le capteur restera
 * le signal de référence — il mesure une décélération réelle, là où nous ne faisons qu'inférer.
 *
 * ── Ce que la mesure a imposé, et qui n'était pas l'idée de départ ───────────────────
 *
 * L'intuition naturelle — « une chute brutale de vitesse = un choc » — est FAUSSE ici, et la
 * production le prouve. Sur 30 jours :
 *
 *   Chute de 50 km/h ou plus jusqu'à zéro ................ 612 fois, sur 34 boîtiers
 *   … dont suivies d'une immobilité de 15 minutes ........... 0
 *
 * Vingt par jour, et TOUTES suivies d'une reprise de route. À 20 secondes d'échantillonnage,
 * « 121 km/h puis 0 » ne décrit pas un choc : c'est un véhicule qui quitte la voie rapide et
 * s'arrête à un feu, ou un point de vitesse simplement faux. Alerter là-dessus aurait produit
 * une alerte toutes les 72 minutes, et enterré la vraie sous le bruit.
 *
 * ── D'où la règle COMBINÉE ───────────────────────────────────────────────────────────
 *
 * Deux signaux indépendants doivent être vrais ensemble :
 *
 *   1. le véhicule ROULAIT — dernière vitesse connue au-dessus d'un seuil ;
 *   2. le boîtier S'EST TU — plus aucune trame depuis un long moment.
 *
 * Le second est le discriminant. Mesuré sur les mêmes 30 jours : 3 occurrences seulement,
 * soit un dixième par jour. C'est la signature d'un boîtier arraché, écrasé ou privé
 * d'alimentation — donc d'un choc violent — et non celle d'un arrêt normal, qui laisse le
 * boîtier bavard pendant des heures.
 *
 * ── La limite, qu'il faut énoncer et non masquer ─────────────────────────────────────
 *
 * Aucun accident connu ne figure dans la fenêtre de données conservée : la plus vieille
 * position remonte à deux mois, et l'accident de référence lui est antérieur. On a donc mesuré
 * le taux de FAUSSES alertes, jamais le taux de détection. Cette règle peut se taire sur un
 * vrai accident sans qu'on le sache encore. C'est la raison d'être de la restriction aux
 * super-administrateurs : on observe ce qu'elle dit avant de la laisser réveiller un client.
 *
 * Aucun accès base, aucune dépendance Nest : ce module prend des faits et rend un verdict.
 */

/** Au-dessous, « il roulait » n'est pas défendable : une manœuvre de parking suffit à l'atteindre. */
export const VITESSE_MIN_KMH = 20;
/**
 * Silence au-delà duquel un boîtier qui roulait n'est plus explicable par un aléa réseau.
 *
 * Deux heures et non trente minutes : les boîtiers de ce parc perdent régulièrement le signal
 * sous un pont ou dans un parking, et se taisent aussi plusieurs dizaines de minutes en zone
 * blanche. À trente minutes, on décrirait la couverture réseau, pas les accidents.
 */
export const SILENCE_MIN_MS = 2 * 60 * 60 * 1000;
/**
 * Plafond de vraisemblance de la DERNIÈRE vitesse retenue.
 *
 * Sans lui, un point aberrant — et il en existe : 1,7 % des points d'un boîtier du parc
 * s'écartent de plus de 40 km/h de la vitesse déduite des coordonnées — suffirait à faire
 * croire qu'un véhicule à l'arrêt roulait à 250 km/h juste avant de se taire.
 */
export const VITESSE_MAX_PLAUSIBLE_KMH = 200;

/** Ce qu'on sait d'un boîtier au moment de l'examen. */
export interface EtatBoitier {
  trackerId: string;
  /** Plaque, pour que le constat soit lisible sans requête supplémentaire. */
  plaque: string | null;
  /** Dernière trame reçue, quelle qu'elle soit. */
  derniereTrameA: Date | null;
  /** Vitesse du dernier point connu. */
  derniereVitesseKmh: number | null;
  /** Position du dernier point connu — c'est là qu'il faut aller regarder. */
  lat: number | null;
  lng: number | null;
  /** Une alerte accident a-t-elle déjà été posée pour ce silence ? */
  dejaAlerte: boolean;
}

export interface SoupconAccident {
  trackerId: string;
  plaque: string | null;
  derniereVitesseKmh: number;
  silenceMs: number;
  lat: number | null;
  lng: number | null;
  /** Ce qu'on affirme, en une phrase, sans jargon et sans surpromesse. */
  constat: string;
}

/** Le silence est-il long ET le véhicule roulait-il ? Les deux, ou rien. */
export function estSoupconAccident(e: EtatBoitier, maintenantMs: number): boolean {
  if (e.dejaAlerte) return false;
  if (e.derniereTrameA === null) return false;
  const v = e.derniereVitesseKmh;
  // `null` n'est pas « zéro » : sans vitesse connue, on ne sait pas s'il roulait, donc on
  // ne conclut pas. Traiter l'inconnu comme un arrêt serait tout aussi arbitraire.
  if (v === null || !Number.isFinite(v)) return false;
  if (v < VITESSE_MIN_KMH || v > VITESSE_MAX_PLAUSIBLE_KMH) return false;
  return maintenantMs - e.derniereTrameA.getTime() >= SILENCE_MIN_MS;
}

const heures = (ms: number) => (ms / 3_600_000).toFixed(1).replace('.', ',');

/**
 * Rédige le constat.
 *
 * Il dit ce qui est OBSERVÉ, jamais « accident détecté ». La nuance n'est pas de la prudence
 * de façade : celui qui reçoit l'alerte doit savoir qu'il lui reste à vérifier, sinon la
 * première fois que le motif sera une panne d'alimentation, il cessera de croire les
 * suivantes.
 */
export function redigerConstat(e: EtatBoitier, maintenantMs: number): string {
  const nom = e.plaque ?? 'Un véhicule';
  const silence = heures(maintenantMs - (e.derniereTrameA?.getTime() ?? maintenantMs));
  const v = Math.round(e.derniereVitesseKmh ?? 0);
  return (
    nom + ' roulait à ' + String(v) + ' km/h et son boîtier n\'émet plus depuis ' + silence +
    ' h. Choc, arrachement ou coupure d\'alimentation : à vérifier sur place.'
  );
}

/** Filtre et met en forme les soupçons d'une passe d'examen. */
export function soupconsAccident(
  boitiers: readonly EtatBoitier[],
  maintenantMs: number,
): SoupconAccident[] {
  return boitiers
    .filter((e) => estSoupconAccident(e, maintenantMs))
    .map((e) => ({
      trackerId: e.trackerId,
      plaque: e.plaque,
      derniereVitesseKmh: e.derniereVitesseKmh!,
      silenceMs: maintenantMs - e.derniereTrameA!.getTime(),
      lat: e.lat,
      lng: e.lng,
      constat: redigerConstat(e, maintenantMs),
    }))
    // Le plus rapide d'abord : à silence égal, c'est celui qui allait le plus vite qu'on va
    // voir en premier.
    .sort((a, b) => b.derniereVitesseKmh - a.derniereVitesseKmh);
}
