import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { LimitResolver } from './trip-analysis.preprocessor';

/**
 * Limites de vitesse légales (OpenStreetMap `maxspeed` via Overpass) — pour transformer un « il roule
 * vite » en un EXCÈS CERTAIN (« 89 km/h en zone 50 »). Best-effort et NON bloquant : timeout/échec →
 * limite inconnue (l'analyse reste valable, l'excès juste non affirmé). Fortement caché en base
 * (`speed_limit_cache`, clé ~11 m) : un point déjà résolu ne re-tape jamais Overpass ; on mémorise
 * MÊME l'inconnu. Appels LIVE bornés + throttlés (respect du quota Overpass public).
 */
@Injectable()
export class SpeedLimitService {
  private readonly logger = new Logger(SpeedLimitService.name);
  private lastCallAt = 0;

  /** Plafond d'appels Overpass LIVE par analyse (le reste vient du cache ou reste inconnu). */
  private readonly MAX_LIVE = 12;
  /** Rayon de recherche de la route (m). */
  private readonly RADIUS_M = 20;

  constructor(private readonly prisma: PrismaService) {}

  /** Clé de cache : coords arrondies à 4 décimales (~11 m) → mutualise un segment de route. */
  private key(lat: number, lng: number): string {
    return `${lat.toFixed(4)},${lng.toFixed(4)}`;
  }

  /**
   * Pré-résout les limites pour un ensemble de points (dédupliqués par cellule), puis renvoie un
   * RÉSOLVEUR SYNCHRONE (lookup en mémoire) consommable par le préprocesseur. Cache d'abord, Overpass
   * ensuite (borné/throttlé). Les points non résolus renvoient null (limite inconnue).
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

    // 2. Overpass pour les manquants (borné).
    let live = 0;
    for (const [k, p] of cells) {
      if (map.has(k)) continue;
      if (live >= this.MAX_LIVE) { map.set(k, null); continue; } // au-delà du plafond → inconnu (non re-tapé)
      live++;
      const limit = await this.fetchMaxspeed(p.lat, p.lng);
      map.set(k, limit);
      this.prisma.speedLimitCache.create({ data: { key: k, maxspeed: limit, lat: p.lat, lng: p.lng } }).catch(() => { /* course : sans gravité */ });
    }

    return (lat: number, lng: number) => {
      const v = map.get(this.key(lat, lng));
      return v ?? null;
    };
  }

  /**
   * Interroge Overpass pour la limite de la route la plus proche. Priorité au tag `maxspeed`
   * EXPLICITE (certain) ; à défaut, INFÉRENCE par type de voie (défauts FR) car beaucoup de routes
   * n'ont pas de tag maxspeed (limite implicite). null si aucune route trouvée / Overpass indisponible.
   */
  private async fetchMaxspeed(lat: number, lng: number): Promise<number | null> {
    await this.throttle();
    const base = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').replace(/\/$/, '');
    const q = `[out:json][timeout:10];way(around:${this.RADIUS_M},${lat},${lng})[highway];out tags 12;`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': 'Tracky/1.0 (contact@vizyoagency.com)' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
      // Voies ROUTABLES uniquement (exclut trottoirs/pistes/chemins qui fausseraient la limite).
      const ways = (json.elements ?? []).map((e) => e.tags ?? {}).filter((t) => t.highway && !NON_DRIVABLE.has(t.highway));
      if (ways.length === 0) return null;
      // 1. Une route avec maxspeed EXPLICITE prime (certain).
      for (const t of ways) { const m = parseMaxspeed(t.maxspeed); if (m != null) return m; }
      // 2. Sinon, inférence par le type de la 1re route reconnue (défaut FR).
      const drivable = ways.find((t) => INFER[t.highway] != null) ?? ways[0];
      return inferFromHighway(drivable.highway);
    } catch (e) {
      this.logger.warn(`Overpass échec (${lat},${lng}) : ${(e as Error)?.message ?? e}`);
      return null;
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
