import { Injectable, Logger } from '@nestjs/common';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import type { FuelStopOut, TripStopOut } from './trip-analysis.preprocessor';

/**
 * Stations-service & prix carburants (2026-07). Pour chaque ARRÊT d'un trajet, on regarde s'il tombe
 * sur une station-service connue :
 *  - localisation + PRIX temps réel via l'API officielle FR `prix-carburants` (gratuite, sans clé) ;
 *  - MARQUE (Total, Esso…) via OSM Overpass (best-effort, souvent absente) ;
 * puis on MÉMORISE la station (cache), on HISTORISE ses prix et on enregistre le passage
 * (`TripFuelStop`) — base des rapports « passe tous les X jours » + coût carburant estimé.
 *
 * 100 % BEST-EFFORT : aucun échec ne bloque l'analyse du trajet. Les indispos API remontent au
 * centre d'alerte (source `fuel-station`), une fois par analyse (pas une par arrêt).
 */
@Injectable()
export class FuelStationService {
  private readonly logger = new Logger(FuelStationService.name);

  /** Rayon « l'arrêt est À la station » (m). Un arrêt plus loin n'est pas un passage station. */
  private readonly MATCH_RADIUS_M = 160;
  /** Borne dure d'arrêts résolus par analyse (coût API). */
  private readonly MAX_LOOKUPS = 12;
  private readonly GOUV_URL =
    'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * Détecte les passages station parmi les arrêts d'un trajet, persiste (`TripFuelStop` + cache
   * station + historique prix) et renvoie la liste pour l'affichage. Re-analyse : les passages du
   * trajet sont REMPLACÉS.
   */
  async detectAndPersist(
    ctx: { tripId: string; fleetId: string; vehicleId: string; energy: string | null },
    stops: TripStopOut[],
  ): Promise<FuelStopOut[]> {
    // Re-analyse : on repart de zéro pour ce trajet (idempotent).
    await this.prisma.tripFuelStop.deleteMany({ where: { tripId: ctx.tripId } }).catch(() => { /* best-effort */ });
    if (!stops.length) return [];

    const fuelType = fuelTypeFor(ctx.energy);
    const out: FuelStopOut[] = [];
    let lookups = 0;
    let apiFailures = 0;
    let lastError: unknown = null;

    for (const stop of stops) {
      if (lookups >= this.MAX_LOOKUPS) break;
      lookups++;
      let station: GouvStation | null;
      try {
        station = await this.nearestGouvStation(stop.lat, stop.lng);
      } catch (e) {
        apiFailures++;
        lastError = e;
        continue; // API indisponible pour cet arrêt → on n'affirme rien
      }
      if (!station || !station.geom) continue; // arrêt pas à une station

      try {
        const saved = await this.upsertStation(station);
        await this.capturePrices(saved.id, station);
        const distanceM = Math.round(haversineM(stop.lat, stop.lng, saved.lat, saved.lng));
        const durationSec = Math.round(stop.durationMin * 60);
        const unitPriceEur = fuelType ? priceForType(station, fuelType) : null;

        await this.prisma.tripFuelStop.create({
          data: {
            tripId: ctx.tripId, fleetId: ctx.fleetId, vehicleId: ctx.vehicleId, stationId: saved.id,
            arrivedAt: new Date(stop.arrivedAt), durationSec, lat: stop.lat, lng: stop.lng, distanceM,
            fuelType, unitPriceEur,
          },
        });

        out.push({
          stationId: saved.id, brand: saved.brand, name: saved.name, city: saved.city, address: saved.address,
          lat: saved.lat, lng: saved.lng, arrivedAt: stop.arrivedAt, durationSec, distanceM, fuelType, unitPriceEur,
        });
      } catch (e) {
        // Persistance station/passage : on trace mais on ne casse pas l'analyse.
        this.logger.warn(`persistance passage station : ${(e as Error)?.message ?? e}`);
        void this.errorLogger.record(
          e instanceof Error ? e : new Error(String(e)),
          'fuel-station',
          { tripId: ctx.tripId, vehicleId: ctx.vehicleId, stage: 'persist' },
        );
      }
    }

    // API prix carburants systématiquement injoignable → une alerte (pas une par arrêt).
    if (lookups > 0 && apiFailures === lookups) {
      // Idem `speed-limit` : on nomme la dépendance et la conséquence. Une `AbortError` brute
      // (« This operation was aborted ») ne disait pas que c'était un TIMEOUT sur l'API publique
      // des prix carburants, ni que l'analyse du trajet restait valable sans elle.
      const cause = lastError instanceof Error ? lastError.message : String(lastError ?? 'injoignable');
      void this.errorLogger.record(
        new Error(
          `Passages en station non détectés : API publique des prix carburants injoignable sur ${lookups} arrêt(s) — ` +
            `aucun plein n'est affirmé sur ce trajet, le reste de l'analyse est conservé. Cause : ${cause}`,
        ),
        'fuel-station',
        { tripId: ctx.tripId, vehicleId: ctx.vehicleId, stage: 'lookup', stops: lookups, cause },
      );
    }

    return out;
  }

  // ── Sources externes ─────────────────────────────────────────────────────

  /** Station la plus proche d'un point via l'API FR (dans le rayon). LÈVE si l'API est indisponible. */
  private async nearestGouvStation(lat: number, lng: number): Promise<GouvStation | null> {
    const where = `within_distance(geom, geom'POINT(${lng} ${lat})', ${this.MATCH_RADIUS_M}m)`;
    const url = `${this.GOUV_URL}?where=${encodeURIComponent(where)}&limit=5`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': FUEL_UA }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`prix-carburants HTTP ${res.status}`);
      const json = (await res.json()) as { results?: GouvStation[] };
      const list = json.results ?? [];
      let best: GouvStation | null = null;
      let bestD = Infinity;
      for (const s of list) {
        if (!s.geom) continue;
        const d = haversineM(lat, lng, s.geom.lat, s.geom.lon);
        if (d <= this.MATCH_RADIUS_M && d < bestD) { bestD = d; best = s; }
      }
      return best;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Marque OSM (Total/Esso…) — best-effort, jamais lève (retourne null si Overpass indisponible). */
  private async osmBrand(lat: number, lng: number): Promise<string | null> {
    const base = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').replace(/\/$/, '');
    const q = `[out:json][timeout:8];node(around:120,${lat},${lng})[amenity=fuel];out tags 3;`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': FUEL_UA },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
      const tags = json.elements?.[0]?.tags ?? {};
      return tags.brand || tags.name || tags.operator || null;
    } catch {
      return null; // Overpass flaky : la marque est un bonus, jamais bloquant
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Persistance ──────────────────────────────────────────────────────────

  /** Mémorise la station (cache). À la CRÉATION seulement : tente d'enrichir la marque via OSM (une fois). */
  private async upsertStation(s: GouvStation): Promise<{ id: string; brand: string | null; name: string | null; city: string | null; address: string | null; lat: number; lng: number }> {
    const externalId = String(s.id);
    const lat = s.geom!.lat;
    const lng = s.geom!.lon;
    const existing = await this.prisma.fuelStation.findUnique({
      where: { source_externalId: { source: 'gouv-fr', externalId } },
      select: { id: true, brand: true, name: true, city: true, address: true, lat: true, lng: true },
    });
    if (existing) return existing;

    const brand = await this.osmBrand(lat, lng); // best-effort (une seule fois par station)
    return this.prisma.fuelStation.create({
      data: {
        source: 'gouv-fr', externalId, brand, name: null,
        address: s.adresse ?? null, city: s.ville ?? null, postalCode: s.cp ?? null, lat, lng,
      },
      select: { id: true, brand: true, name: true, city: true, address: true, lat: true, lng: true },
    });
  }

  /** Historise les prix de la station (dédup par relevé source : un même prix n'est stocké qu'une fois). */
  private async capturePrices(stationId: string, s: GouvStation): Promise<void> {
    const rows: { fuelType: string; price?: number | null; maj?: string | null }[] = [
      { fuelType: 'gazole', price: s.gazole_prix, maj: s.gazole_maj },
      { fuelType: 'sp95', price: s.sp95_prix, maj: s.sp95_maj },
      { fuelType: 'sp98', price: s.sp98_prix, maj: s.sp98_maj },
      { fuelType: 'e10', price: s.e10_prix, maj: s.e10_maj },
      { fuelType: 'e85', price: s.e85_prix, maj: s.e85_maj },
      { fuelType: 'gplc', price: s.gplc_prix, maj: s.gplc_maj },
    ];
    for (const r of rows) {
      if (r.price == null || r.price <= 0) continue;
      const sourceUpdatedAt = r.maj ? new Date(r.maj) : new Date();
      if (Number.isNaN(sourceUpdatedAt.getTime())) continue;
      await this.prisma.fuelStationPrice
        .upsert({
          where: { stationId_fuelType_sourceUpdatedAt: { stationId, fuelType: r.fuelType, sourceUpdatedAt } },
          create: { stationId, fuelType: r.fuelType, priceEur: r.price, sourceUpdatedAt },
          update: {}, // relevé déjà capté
        })
        .catch(() => { /* course/dup : sans gravité */ });
    }
  }
}

const FUEL_UA = 'Tracky/1.0 (contact@vizyoagency.com)';

/** Station telle que renvoyée par l'API FR (champs utiles + colonnes de prix aplaties). */
export interface GouvStation {
  id: number | string;
  adresse?: string | null;
  ville?: string | null;
  cp?: string | null;
  geom?: { lat: number; lon: number } | null;
  gazole_prix?: number | null; gazole_maj?: string | null;
  sp95_prix?: number | null; sp95_maj?: string | null;
  sp98_prix?: number | null; sp98_maj?: string | null;
  e10_prix?: number | null; e10_maj?: string | null;
  e85_prix?: number | null; e85_maj?: string | null;
  gplc_prix?: number | null; gplc_maj?: string | null;
}

/** Mappe l'énergie du véhicule (libre) vers un carburant de l'API. null = pas de carburant liquide pertinent. */
export function fuelTypeFor(energy: string | null): string | null {
  if (!energy) return null;
  const e = energy.toUpperCase();
  if (e.includes('DIESEL') || e.includes('GAZOLE') || e.includes('GASOIL') || e.includes('GAZOIL')) return 'gazole';
  if (e.includes('GPL') || e.includes('LPG')) return 'gplc';
  if (e.includes('E85') || e.includes('ETHANOL') || e.includes('SUPERETHANOL')) return 'e85';
  if (e.includes('ELEC') || e.includes('HYBRID')) return null; // électrique/hybride : pas de prix carburant liquide
  if (e.includes('SP98')) return 'sp98';
  if (e.includes('SP95') || e.includes('E10')) return 'e10';
  if (e.includes('ESSENCE') || e.includes('GASOLINE') || e.includes('PETROL') || e.includes('BENZIN')) return 'e10';
  return null;
}

/** Prix au litre pour un carburant donné (repli essence e10→sp95). null si indisponible. */
export function priceForType(s: GouvStation, fuelType: string): number | null {
  const map: Record<string, number | null | undefined> = {
    gazole: s.gazole_prix, sp95: s.sp95_prix, sp98: s.sp98_prix, e10: s.e10_prix, e85: s.e85_prix, gplc: s.gplc_prix,
  };
  const v = map[fuelType];
  if (v != null && v > 0) return v;
  if (fuelType === 'e10' && s.sp95_prix != null && s.sp95_prix > 0) return s.sp95_prix; // repli essence
  return null;
}

/** Distance haversine en mètres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
