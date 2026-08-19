import { Injectable, Logger } from '@nestjs/common';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import type { LimitResolver } from './trip-analysis.preprocessor';

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
 * LES TROIS GARDE-FOUS AJOUTÉS :
 *   1. `remark` / corps non-JSON → échec de TRANSPORT (on lève), jamais un « inconnu » mémorisé ;
 *   2. AUCUNE route trouvée → on ne cache PAS. Un point GPS de véhicule en mouvement est sur une
 *      route par construction : zéro voie à 20 m est le symptôme d'une mauvaise réponse, pas un
 *      fait. On réessaiera. Seul un « route trouvée mais type inconnu » est un vrai négatif ;
 *   3. requêtes GROUPÉES : un trajet entier part en 1 à 8 appels au lieu d'être coupé au 12e point.
 *      Le rattachement point → route se fait localement sur la géométrie renvoyée.
 */
@Injectable()
export class SpeedLimitService {
  private readonly logger = new Logger(SpeedLimitService.name);
  private lastCallAt = 0;

  /** Points par requête Overpass groupée. */
  private readonly CHUNK = 40;
  /**
   * Plafond de requêtes GROUPÉES par analyse — soit 320 points, contre 12 auparavant. Le plafond
   * borne toujours la charge sur l'instance publique, mais il ne coupe plus un trajet en deux.
   */
  private readonly MAX_CHUNKS = 8;
  /** Rayon de recherche de la route (m). */
  private readonly RADIUS_M = 20;
  /** Marge de rattachement local (m) : Overpass a filtré à RADIUS_M, on tolère l'arrondi. */
  private readonly MATCH_M = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Clé de cache : coords arrondies à 4 décimales (~11 m) → mutualise un segment de route. */
  private key(lat: number, lng: number): string {
    return `${lat.toFixed(4)},${lng.toFixed(4)}`;
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
    if (requetes > 0 && echecs === requetes) {
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

  /**
   * Interroge Overpass pour UN LOT de points, en une seule requête, et rattache chaque point à la
   * route la plus proche via la géométrie renvoyée.
   *
   * Retourne, pour chaque point dans l'ordre : la limite (ou null) et `trouvee` — vrai seulement si
   * une voie routable a réellement été rattachée. C'est `trouvee` qui autorise la mise en cache.
   */
  private async fetchLot(points: { lat: number; lng: number }[]): Promise<{ limite: number | null; trouvee: boolean }[]> {
    await this.throttle();
    const base = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').replace(/\/$/, '');
    const clauses = points.map((p) => `way(around:${this.RADIUS_M},${p.lat},${p.lng})[highway];`).join('');
    // `out tags geom` : la géométrie est indispensable pour savoir QUELLE route va avec QUEL point.
    const q = `[out:json][timeout:60];(${clauses});out tags geom;`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70_000);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': 'Tracky/1.0 (contact@vizyoagency.com)' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      // Échec TRANSPORT franc (Overpass down / throttlé / 5xx) → on LÈVE.
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

      const texte = await res.text();
      let json: OverpassReponse;
      try {
        json = JSON.parse(texte) as OverpassReponse;
      } catch {
        // ⚠️ Overpass sert ses pages d'erreur EN HTTP 200 (« The server is probably too busy »).
        //    Un corps non-JSON est une panne, pas une absence de route.
        throw new Error(`Overpass a répondu 200 avec un corps non-JSON (${texte.slice(0, 80).replace(/\s+/g, ' ')})`);
      }
      // ⚠️ ET il sert aussi ses erreurs EN JSON VALIDE, avec `elements: []` et un `remark`. C'est CE
      //    cas qui a empoisonné le cache : lu comme « aucune route », mémorisé pour toujours.
      if (typeof json.remark === 'string' && json.remark.length > 0) {
        throw new Error(`Overpass a répondu 200 avec une erreur applicative : ${json.remark.slice(0, 120)}`);
      }

      const voies = (json.elements ?? [])
        .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1)
        // Voies ROUTABLES uniquement (exclut trottoirs/pistes/chemins qui fausseraient la limite).
        .filter((e) => e.tags?.['highway'] && !NON_DRIVABLE.has(e.tags['highway']));

      return points.map((p) => {
        const proche = this.voieLaPlusProche(p, voies);
        if (!proche) return { limite: null, trouvee: false };
        // 1. Un maxspeed EXPLICITE prime (certain).
        const explicite = parseMaxspeed(proche.tags?.['maxspeed']);
        if (explicite != null) return { limite: explicite, trouvee: true };
        // 2. Sinon, inférence par le type de voie (défauts FR). null ici est un VRAI négatif : la
        //    route existe, son type n'est simplement pas interprétable — cache légitime.
        return { limite: inferFromHighway(proche.tags?.['highway']), trouvee: true };
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Voie routable la plus proche du point, dans la limite de MATCH_M. */
  private voieLaPlusProche(p: { lat: number; lng: number }, voies: OverpassWay[]): OverpassWay | null {
    let meilleure: OverpassWay | null = null;
    let min = this.MATCH_M;
    for (const v of voies) {
      const g = v.geometry!;
      for (let i = 1; i < g.length; i++) {
        const d = distancePointSegment(p.lat, p.lng, g[i - 1]!.lat, g[i - 1]!.lon, g[i]!.lat, g[i]!.lon);
        if (d < min) { min = d; meilleure = v; }
      }
    }
    return meilleure;
  }

  /** Sérialise les appels Overpass (≤ ~1/s). */
  private async throttle(): Promise<void> {
    const MIN = 1100;
    const wait = this.lastCallAt + MIN - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}

interface OverpassWay {
  type?: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
interface OverpassReponse {
  elements?: OverpassWay[];
  /** Présent quand Overpass signale une erreur SOUS un HTTP 200 (timeout, surcharge). */
  remark?: string;
}

/**
 * Distance (m) d'un point à un segment, en projection équirectangulaire locale. À l'échelle de
 * quelques dizaines de mètres l'approximation est négligeable devant la précision GPS.
 */
export function distancePointSegment(
  plat: number, plng: number,
  alat: number, alng: number,
  blat: number, blng: number,
): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const cosLat = Math.cos(plat * rad);
  const px = plng * rad * cosLat * R, py = plat * rad * R;
  const ax = alng * rad * cosLat * R, ay = alat * rad * R;
  const bx = blng * rad * cosLat * R, by = blat * rad * R;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Limite INFÉRÉE (km/h) par type de voie OSM `highway`, défauts FRANCE (fallback quand aucun tag
 * `maxspeed` explicite). Approximatif (l'urbain/rural sur primary/secondary reste ambigu) : à
 * considérer comme « probable ». motorway=130, trunk=110, voies structurantes=90/80, urbain=50/30/20.
 */
/** Voies NON routables (à ignorer : elles ne portent pas la limite d'un véhicule). */
const NON_DRIVABLE = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'corridor', 'platform', 'construction', 'proposed']);

const INFER: Record<string, number> = {
  motorway: 130, motorway_link: 90, trunk: 110, trunk_link: 70,
  primary: 90, primary_link: 50, secondary: 80, secondary_link: 50,
  tertiary: 80, tertiary_link: 50, unclassified: 80,
  residential: 50, living_street: 20, service: 30, road: 50,
};
export function inferFromHighway(highway: string | undefined): number | null {
  return highway ? (INFER[highway] ?? null) : null;
}

/** Convertit une valeur OSM `maxspeed` en km/h. Gère les mph, les catégories FR, `none`, `walk`. */
export function parseMaxspeed(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === 'none' || s === 'signals' || s === 'variable') return null;
  if (s === 'walk') return 6;
  // Catégories implicites françaises (zones/urban/rural/motorway).
  const cat: Record<string, number> = { 'fr:urban': 50, 'fr:rural': 80, 'fr:trunk': 110, 'fr:motorway': 130, 'fr:living_street': 20, 'fr:zone30': 30, 'fr:walk': 6 };
  if (cat[s] != null) return cat[s];
  const mph = /mph/.test(s);
  const num = parseFloat(s);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(mph ? num * 1.60934 : num);
}
