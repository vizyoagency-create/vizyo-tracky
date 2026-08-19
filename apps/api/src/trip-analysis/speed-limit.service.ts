import { Injectable, Logger } from '@nestjs/common';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import type { LimitResolver } from './trip-analysis.preprocessor';
import {
  cleCellule, panneDeguisee, requeteLot, resoudrePoints, MATCH_M,
  type LimitePoint, type OverpassReponse,
} from './speed-limit.resolution';

// Réexporté pour les appelants historiques (ces symboles vivaient ici avant l'extraction).
export { distancePointSegment, inferFromHighway, parseMaxspeed } from './speed-limit.resolution';

/**
 * Limites de vitesse légales (OpenStreetMap `maxspeed` via Overpass) — pour transformer un « il
 * roule vite » en un EXCÈS CERTAIN (« 89 km/h en zone 50 »). Best-effort et NON bloquant :
 * timeout/échec → limite inconnue (l'analyse reste valable, l'excès juste non affirmé).
 *
 * ── CE QUI A ÉTÉ RÉPARÉ ICI, ET POURQUOI ─────────────────────────────────────────────
 *
 * Relevé du 2026-08-19 en production : le cache contenait 60 090 points dont 59 347 marqués
 * « inconnu » — 98,8 %. Conséquence : 75,3 % des trajets n'avaient AUCUNE limite résolue, donc
 * zéro excès calculable, donc un score de conduite moyen de 93,4/100 qui ne mesurait rien.
 *
 * Deux points tirés au hasard parmi ces « inconnus » se résolvaient pourtant parfaitement en les
 * rejouant : `motorway_link maxspeed=70` et `highway=tertiary` (→ 80 par inférence). La donnée OSM
 * était là depuis le début. C'est le cache qui mentait.
 *
 * LA CAUSE : Overpass sert ses erreurs de surcharge SOUS UN HTTP 200 — soit une page HTML, soit un
 * JSON parfaitement valide avec `elements: []` et un champ `remark`. L'ancien code testait
 * `if (!res.ok)`, qu'un 200 franchit ; il lisait la liste vide comme « aucune route ici » et la
 * mémorisait DÉFINITIVEMENT « pour ne pas re-taper ». Une indisponibilité de quelques secondes
 * devenait une vérité permanente, et le point n'était plus jamais réinterrogé.
 *
 * LES GARDE-FOUS :
 *   1. `remark` / corps non-JSON → échec de TRANSPORT (on lève), jamais un « inconnu » mémorisé ;
 *   2. AUCUNE route trouvée → on ne cache PAS. Un point GPS de véhicule en mouvement est sur une
 *      route par construction : zéro voie à 20 m est le symptôme d'une mauvaise réponse, pas un
 *      fait. On réessaiera. Seul un « route trouvée mais type inconnu » est un vrai négatif ;
 *   3. requêtes GROUPÉES : un trajet entier part en 1 à 8 appels au lieu d'être coupé au 12e point.
 *
 * ⚠️ LE RATTACHEMENT point → route vit dans `speed-limit.resolution.ts`, PAS ici : l'agent de
 *    rattrapage qui tourne sur le poste du propriétaire consomme le même module. Dupliquer cette
 *    logique ferait diverger les deux, et l'agent écrirait en base des limites que l'app n'aurait
 *    jamais déduites — de fausses données, sans rien pour le signaler.
 */
@Injectable()
export class SpeedLimitService {
  private readonly logger = new Logger(SpeedLimitService.name);
  private lastCallAt = 0;

  /**
   * Points par requête Overpass groupée. Calibré en mesurant l'instance publique :
   *   40 points → 87 Ko en ~5 s ·  100 → 156 Ko en 9 s ·  200 → 198 Ko en 13 s ·  400 → HTTP 429.
   * 200 est le meilleur rapport : cinq fois moins de requêtes qu'à 40, et on reste sous le quota.
   */
  private readonly CHUNK = 200;
  /**
   * Plafond de requêtes GROUPÉES par analyse — soit 1 600 points, contre 12 auparavant. Le plafond
   * borne toujours la charge sur l'instance publique, mais il ne coupe plus un trajet en deux.
   */
  private readonly MAX_CHUNKS = 8;
  /**
   * Attentes avant de rejouer un lot refusé. Overpass alloue des « slots » par IP : un 429 n'est
   * pas une panne, c'est « reviens dans un instant ». Sans reprise, un quota momentané faisait
   * perdre les 200 points du lot — et le trajet repartait sans limites.
   */
  private readonly BACKOFF_MS = [4_000, 12_000];
  /**
   * ⚠️ UNE indisponibilité Overpass est UNE information, pas une par trajet.
   *
   * Sans ce silence, le rattrapage de l'historique du 2026-08-19 a produit 39 alertes
   * « Overpass injoignable » en onze minutes — et un mail au propriétaire. Le correctif qui
   * rendait enfin les pannes visibles s'est mis à les crier. Une application qui spamme ses
   * propres alertes cesse d'être lue, ce qui est exactement le défaut qu'on venait de réparer
   * ailleurs. On trace donc au plus une fois par fenêtre, quel que soit le nombre de trajets.
   */
  private readonly SILENCE_ALERTE_MS = 30 * 60 * 1000;
  private derniereAlerteAt = 0;
  /** Rayon de recherche de la route (m). */
  private readonly RADIUS_M = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Clé de cache : coords arrondies à 4 décimales (~11 m) → mutualise un segment de route. */
  private key(lat: number, lng: number): string {
    return cleCellule(lat, lng);
  }

  /**
   * Pré-résout les limites pour un ensemble de points (dédupliqués par cellule), puis renvoie un
   * RÉSOLVEUR SYNCHRONE (lookup en mémoire) consommable par le préprocesseur. Cache d'abord,
   * Overpass ensuite (groupé, borné, throttlé). Points non résolus → null (limite inconnue).
   */
  async buildResolver(points: { lat: number; lng: number }[]): Promise<LimitResolver> {
    const map = new Map<string, number | null>();
    // Dédup par cellule.
    const cells = new Map<string, { lat: number; lng: number }>();
    for (const p of points) {
      const k = this.key(p.lat, p.lng);
      if (!cells.has(k)) cells.set(k, p);
    }
    if (cells.size === 0) return () => null;

    // 1. Cache DB.
    const keys = [...cells.keys()];
    let cached: { key: string; maxspeed: number | null }[] = [];
    try {
      cached = await this.prisma.speedLimitCache.findMany({ where: { key: { in: keys } }, select: { key: true, maxspeed: true } });
    } catch (e) {
      this.logger.warn(`cache read : ${(e as Error)?.message ?? e}`);
    }
    for (const c of cached) map.set(c.key, c.maxspeed);

    // 2. Overpass GROUPÉ pour les manquants. On COMPTE les échecs de transport pour remonter UNE
    //    seule alerte par analyse (pas une par point) au centre d'alerte.
    const manquants = [...cells.entries()].filter(([k]) => !map.has(k));
    let requetes = 0;
    let echecs = 0;
    let lastError: unknown = null;

    for (let i = 0; i < manquants.length; i += this.CHUNK) {
      if (requetes >= this.MAX_CHUNKS) {
        // Au-delà du plafond → inconnu POUR CETTE ANALYSE, et surtout NON mémorisé : la prochaine
        // analyse retentera. C'est ce « non mémorisé » qui manquait et qui figeait les trous.
        for (const [k] of manquants.slice(i)) map.set(k, null);
        break;
      }
      const lot = manquants.slice(i, i + this.CHUNK);
      requetes++;
      try {
        const resolus = await this.fetchLot(lot.map(([, p]) => p));
        for (let j = 0; j < lot.length; j++) {
          const k = lot[j]![0];
          const r = resolus[j]!;
          map.set(k, r.limite);
          // ⚠️ On ne mémorise QUE ce qui est concluant. `trouvee === false` (aucune voie à 20 m)
          //    n'est pas un fait sur le terrain : c'est le symptôme d'une réponse dégradée. Le
          //    mémoriser est exactement le bug qui a stérilisé 59 347 points.
          if (r.trouvee) {
            this.prisma.speedLimitCache
              .create({ data: { key: k, maxspeed: r.limite, lat: lot[j]![1].lat, lng: lot[j]![1].lng } })
              .catch(() => { /* course : sans gravité */ });
          }
        }
      } catch (e) {
        echecs++;
        lastError = e;
        for (const [k] of lot) map.set(k, null); // inconnu ici, NON caché → sera retenté
      }
    }

    // Overpass systématiquement injoignable → l'excès de vitesse n'a pas pu être affirmé : on TRACE
    // (une alerte, source `trip-analysis`, visible dans /admin/alerts). Best-effort : jamais bloquant.
    const maintenant = Date.now();
    if (requetes > 0 && echecs === requetes && maintenant - this.derniereAlerteAt >= this.SILENCE_ALERTE_MS) {
      this.derniereAlerteAt = maintenant;
      // Le message porte la DÉPENDANCE et la CONSÉQUENCE. L'erreur brute du transport
      // (« fetch failed », « This operation was aborted ») ne disait ni ce qui était injoignable,
      // ni ce que ça coûtait — illisible au centre d'alerte, et impossible à trier d'une vraie panne.
      const cause = lastError instanceof Error ? lastError.message : String(lastError ?? 'injoignable');
      void this.errorLogger.record(
        new Error(
          `Limites de vitesse indisponibles : Overpass (OpenStreetMap) injoignable sur ${requetes} requête(s) — ` +
            `les excès de vitesse ne sont pas affirmés sur ce trajet, le reste de l'analyse est conservé. Cause : ${cause}`,
        ),
        'trip-analysis',
        { feature: 'speed-limit-osm', requetes, overpass: process.env.OVERPASS_URL || 'public', cause },
      );
    }

    return (lat: number, lng: number) => {
      const v = map.get(this.key(lat, lng));
      return v ?? null;
    };
  }

  /** Interroge Overpass pour UN LOT, en rejouant les refus de quota. */
  private async fetchLot(points: { lat: number; lng: number }[]): Promise<LimitePoint[]> {
    for (let essai = 0; ; essai++) {
      try {
        return await this.tenterLot(points);
      } catch (e) {
        // Un refus de quota ou une passerelle saturée mérite une seconde chance ; une réponse
        // applicative erronée (corps non-JSON, `remark`) aussi — c'est le même engorgement.
        if (essai >= this.BACKOFF_MS.length || !estRejouable(e)) throw e;
        await new Promise((r) => setTimeout(r, this.BACKOFF_MS[essai]));
      }
    }
  }

  /** Une tentative unique : construit la requête, la lit, rattache chaque point à sa route. */
  private async tenterLot(points: { lat: number; lng: number }[]): Promise<LimitePoint[]> {
    await this.throttle();
    const base = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').replace(/\/$/, '');
    // Un lot de 200 points s'exécute en ~13 s à vide ; on laisse de la marge sous charge.
    const q = requeteLot(points, this.RADIUS_M, 180);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 190_000);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': 'Tracky/1.0 (contact@vizyoagency.com)' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      // Échec TRANSPORT franc (Overpass down / throttlé / 5xx) → on LÈVE. 429 et 5xx sont
      // REJOUABLES : le premier est un quota momentané, le second une passerelle saturée.
      if (!res.ok) throw new ErreurOverpass(`Overpass HTTP ${res.status}`, res.status === 429 || res.status >= 500);

      const texte = await res.text();
      // ⚠️ Overpass sert aussi ses erreurs SOUS un HTTP 200 : page HTML, ou JSON valide portant un
      //    `remark`. Les lire comme « aucune route » et les mémoriser est ce qui avait marqué
      //    98,8 % du cache « inconnu », définitivement.
      const panne = panneDeguisee(texte);
      if (panne) throw new ErreurOverpass(`Overpass a répondu 200 avec une ${panne.motif}`, true);

      // Rattachement point → route : implémentation UNIQUE, partagée avec l'agent de rattrapage.
      return resoudrePoints(points, JSON.parse(texte) as OverpassReponse, MATCH_M);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sérialise les appels Overpass (≤ ~1/s). */
  private async throttle(): Promise<void> {
    const MIN = 1100;
    const wait = this.lastCallAt + MIN - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}

/** Erreur Overpass portant l'information « ça vaut le coup de réessayer ». */
class ErreurOverpass extends Error {
  constructor(message: string, readonly rejouable: boolean) {
    super(message);
    this.name = 'ErreurOverpass';
  }
}

/**
 * Une erreur mérite-t-elle une seconde tentative ? Les refus de quota, les passerelles saturées et
 * les coupures réseau, oui. Une erreur de programmation, non — la rejouer ne ferait que la répéter.
 */
export function estRejouable(e: unknown): boolean {
  if (e instanceof ErreurOverpass) return e.rejouable;
  // Coupure réseau / abandon sur timeout : le transport a lâché, pas la logique.
  return e instanceof Error && /fetch failed|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(e.message);
}
