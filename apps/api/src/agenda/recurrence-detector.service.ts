import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReverseGeocodeService } from '../geocoding/reverse-geocode.service';
import { PrismaService } from '../prisma/prisma.service';
import { fleetTzFormatter, localParts } from './fleet-tz.util';
import { TripStopDetectorService, haversineMeters, type TripStop } from './trip-stop-detector.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Fenêtre d'apprentissage. */
const LOOKBACK_WEEKS = 10;
/** Motif retenu si observé sur ≥ ce nb de semaines DISTINCTES. */
const MIN_ACTIVE_WEEKS = 4;
/** Anti-bruit : micro-trajets exclus (même esprit que la règle 0 km / 2 min). */
const MIN_TRIP_METERS = 300;
const MIN_TRIP_KM = MIN_TRIP_METERS / 1000;
const MIN_TRIP_DURATION_MS = 2 * 60 * 1000;
const MAX_TRIPS = 20_000;
/** Cellule de destination : coords arrondies à 2 décimales (~1,1 km) → sépare les destinations. */
const DEST_DECIMALS = 2;
/** Plafond de motifs enrichis (itinéraire) par analyse (quota Nominatim + latence bornée). */
const DEFAULT_MAX_GEOCODE = 40;
/** #3 — Rayon (m) autour du dépôt : un arrêt/point dans ce rayon = « à la base » (pas une destination). */
const DEPOT_RADIUS_M = 250;
/** #3 — Nombre max d'arrêts géocodés par itinéraire (les plus longs d'abord). */
const ITINERARY_MAX_STOPS = 3;

const DOW_LABELS = ['', 'lundis', 'mardis', 'mercredis', 'jeudis', 'vendredis', 'samedis', 'dimanches'];

/** Un trajet récurrent détecté : véhicule × jour-de-semaine × destination, avec créneau typique. */
export interface RecurringPattern {
  vehicleId: string;
  vehiclePlate: string | null;
  dayOfWeek: number; // 1-7 (lundi..dimanche)
  /** Créneau typique en minutes locales du jour (moyenne des semaines observées). */
  startMinutes: number;
  endMinutes: number;
  /** Centroïde du point d'arrivée récurrent. */
  destLat: number;
  destLng: number;
  /** Nom de lieu géocodé (Nominatim), ou null si non résolu / au-delà du plafond. */
  destinationLabel: string | null;
  /** #3 — Vrai ITINÉRAIRE : lieux réellement visités (arrêts ≥4 min hors dépôt), dans l'ordre.
   *  Ex. ["Borderouge", "Ramonville"]. Vide si non dérivable (pas de tracker / positions). */
  itinerary: string[];
  /** #3 — true si le trajet PART ET REVIENT au dépôt (boucle) : la « destination » utile est l'itinéraire. */
  roundTripFromDepot: boolean;
  activeWeeks: number;
  /** 0..1 = activeWeeks / fenêtre d'apprentissage. */
  confidence: number;
  /** Phrase de justification vulgarisée (« Observé 6 des 10 derniers lundis… »). */
  basis: string;
}

type Cluster = {
  vehicleId: string;
  plate: string | null;
  dow: number;
  /** weekKey -> enveloppe {minStart, maxEnd} en minutes locales. */
  weeks: Map<number, { minStart: number; maxEnd: number }>;
  sumLat: number;
  sumLng: number;
  count: number;
  /** #3 — Trajet REPRÉSENTATIF (le plus récent du cluster) pour dériver l'itinéraire réel. */
  rep: { trackerId: string | null; startedAt: Date; endedAt: Date | null; startLat: number; startLng: number } | null;
  repAt: number; // timestamp du rep (pour garder le plus récent)
};

/**
 * Refonte agenda/IA (2026-07, P3) — Détecteur de trajets RÉCURRENTS avec DESTINATION.
 * Regroupe les trajets des 10 dernières semaines par (véhicule × jour-de-semaine × cellule de
 * destination GPS ~1,1 km) ; un motif est retenu s'il est observé ≥ 4 semaines distinctes. Le
 * centroïde d'arrivée est géocodé (Nominatim, best-effort, plafonné) pour nommer « Carcassonne ».
 * La séparation PAR DESTINATION distingue naturellement l'aller (→ Carcassonne) du retour (→ dépôt)
 * et deux tournées différentes du même jour. Déterministe : aucun appel LLM, fiable et gratuit.
 */
@Injectable()
export class RecurrenceDetectorService {
  private readonly logger = new Logger(RecurrenceDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocode: ReverseGeocodeService,
    private readonly stops: TripStopDetectorService,
  ) {}

  /** Détecte les trajets récurrents d'une flotte (avec destination géocodée, triés par confiance). */
  async detect(fleetId: string, opts?: { maxGeocode?: number }): Promise<RecurringPattern[]> {
    const learnFrom = new Date(Date.now() - LOOKBACK_WEEKS * WEEK_MS);
    const where: Prisma.TripWhereInput = {
      fleetId,
      startedAt: { gte: learnFrom },
      endLat: { not: null },
      endLng: { not: null },
      OR: [{ distanceMeters: { gte: MIN_TRIP_METERS } }, { distanceKm: { gte: MIN_TRIP_KM } }],
    };
    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        vehicleId: true, startedAt: true, endedAt: true, trackerId: true,
        startLat: true, startLng: true, endLat: true, endLng: true,
        vehicle: { select: { plate: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: MAX_TRIPS,
    });
    if (trips.length >= MAX_TRIPS) this.logger.warn(`detect(${fleetId}) : ${MAX_TRIPS} trajets (apprentissage tronqué).`);

    // #3 — DÉPÔT de la flotte (base) : la cellule la plus fréquente parmi les départs ET arrivées.
    // Sert à écarter le dépôt de l'« itinéraire utile » (un aller-retour à la base n'est pas une destination).
    const depot = this.detectDepot(trips);

    const fmt = fleetTzFormatter();
    const clusters = new Map<string, Cluster>();

    for (const t of trips) {
      if (t.endLat == null || t.endLng == null) continue;
      if (t.endedAt && t.endedAt.getTime() - t.startedAt.getTime() < MIN_TRIP_DURATION_MS) continue;
      const start = localParts(fmt, t.startedAt.getTime());
      const endMin = t.endedAt
        ? Math.max(start.minutes, localParts(fmt, t.endedAt.getTime()).minutes)
        : start.minutes + 60; // fin inconnue → +1 h par défaut
      const weekKey = Math.floor(Date.parse(`${start.dateKey}T00:00:00Z`) / WEEK_MS);
      const cell = `${t.endLat.toFixed(DEST_DECIMALS)},${t.endLng.toFixed(DEST_DECIMALS)}`;
      const key = `${t.vehicleId}|${start.dow}|${cell}`;

      let c = clusters.get(key);
      if (!c) {
        c = { vehicleId: t.vehicleId, plate: t.vehicle?.plate ?? null, dow: start.dow, weeks: new Map(), sumLat: 0, sumLng: 0, count: 0, rep: null, repAt: 0 };
        clusters.set(key, c);
      }
      c.sumLat += t.endLat;
      c.sumLng += t.endLng;
      c.count += 1;
      // Trajet REPRÉSENTATIF = le plus récent du cluster (itinéraire à jour).
      const ts = t.startedAt.getTime();
      if (ts >= c.repAt) {
        c.repAt = ts;
        c.rep = { trackerId: t.trackerId ?? null, startedAt: t.startedAt, endedAt: t.endedAt ?? null, startLat: t.startLat, startLng: t.startLng };
      }
      const wk = c.weeks.get(weekKey);
      if (!wk) c.weeks.set(weekKey, { minStart: start.minutes, maxEnd: endMin });
      else {
        wk.minStart = Math.min(wk.minStart, start.minutes);
        wk.maxEnd = Math.max(wk.maxEnd, endMin);
      }
    }

    // Motifs retenus + créneau typique (moyenne des enveloppes hebdo) + centroïde.
    const built: { pattern: RecurringPattern; cluster: Cluster }[] = [];
    for (const c of clusters.values()) {
      const activeWeeks = c.weeks.size;
      if (activeWeeks < MIN_ACTIVE_WEEKS) continue;
      let sumStart = 0;
      let sumEnd = 0;
      for (const w of c.weeks.values()) {
        sumStart += w.minStart;
        sumEnd += w.maxEnd;
      }
      const startMinutes = Math.round(sumStart / activeWeeks);
      const endMinutes = Math.min(23 * 60 + 59, Math.max(startMinutes + 15, Math.round(sumEnd / activeWeeks)));
      const destLat = c.sumLat / c.count;
      const destLng = c.sumLng / c.count;
      built.push({
        cluster: c,
        pattern: {
          vehicleId: c.vehicleId,
          vehiclePlate: c.plate,
          dayOfWeek: c.dow,
          startMinutes,
          endMinutes,
          destLat,
          destLng,
          destinationLabel: null,
          itinerary: [],
          roundTripFromDepot: !!depot && haversineMeters(destLat, destLng, depot.lat, depot.lng) <= DEPOT_RADIUS_M,
          activeWeeks,
          confidence: Math.round((activeWeeks / LOOKBACK_WEEKS) * 100) / 100,
          basis: `Observé ${activeWeeks}/${LOOKBACK_WEEKS} ${DOW_LABELS[c.dow] ?? ''}`.trim(),
        },
      });
    }

    // Confiance décroissante : on enrichit d'abord les motifs les plus solides (plafond quota).
    built.sort((a, b) => b.pattern.confidence - a.pattern.confidence || b.pattern.activeWeeks - a.pattern.activeWeeks);
    const cap = Math.max(0, opts?.maxGeocode ?? DEFAULT_MAX_GEOCODE);
    for (let i = 0; i < built.length && i < cap; i++) {
      await this.enrichDestination(built[i].pattern, built[i].cluster, depot);
    }
    return built.map((b) => b.pattern);
  }

  /** #3 — Dépôt = cellule (départ + arrivée) la plus fréquente ; null si pas de base nette. */
  private detectDepot(
    trips: { startLat: number; startLng: number; endLat: number | null; endLng: number | null }[],
  ): { lat: number; lng: number } | null {
    const counts = new Map<string, { lat: number; lng: number; n: number }>();
    const add = (lat: number | null | undefined, lng: number | null | undefined) => {
      if (lat == null || lng == null || (lat === 0 && lng === 0)) return; // (0,0) = coord manquante
      const k = `${lat.toFixed(DEST_DECIMALS)},${lng.toFixed(DEST_DECIMALS)}`;
      const e = counts.get(k) ?? { lat, lng, n: 0 };
      e.n += 1;
      counts.set(k, e);
    };
    for (const t of trips) { add(t.startLat, t.startLng); add(t.endLat, t.endLng); }
    let best: { lat: number; lng: number; n: number } | null = null;
    for (const e of counts.values()) if (!best || e.n > best.n) best = e;
    // Base NETTE : le top-lieu doit concentrer une part significative des extrémités.
    if (!best || best.n < Math.max(6, trips.length * 2 * 0.15)) return null;
    return { lat: best.lat, lng: best.lng };
  }

  /**
   * #3 — Remplit `destinationLabel` + `itinerary` d'un motif à partir des ARRÊTS RÉELS du trajet
   * représentatif (hors dépôt), géocodés. Repli sur le point d'arrivée si aucun arrêt dérivable.
   */
  private async enrichDestination(
    p: RecurringPattern,
    c: Cluster,
    depot: { lat: number; lng: number } | null,
  ): Promise<void> {
    const rep = c.rep;
    let stops: TripStop[] = [];
    if (rep?.trackerId && rep.endedAt) {
      try {
        stops = await this.stops.deriveStops(rep.trackerId, rep.startedAt, rep.endedAt);
      } catch (e) {
        this.logger.warn(`deriveStops(${rep.trackerId}) : ${(e as Error)?.message ?? e}`);
      }
    }
    // Écarte les arrêts « à la base » (dépôt) → il reste les vrais lieux servis.
    const meaningful = stops.filter((s) => !depot || haversineMeters(s.lat, s.lng, depot.lat, depot.lng) > DEPOT_RADIUS_M);

    if (meaningful.length > 0) {
      // On géocode les N arrêts les PLUS LONGS (quota), remis dans l'ordre CHRONOLOGIQUE pour l'itinéraire.
      const chosen = [...meaningful]
        .sort((a, b) => b.durationMin - a.durationMin)
        .slice(0, ITINERARY_MAX_STOPS)
        .sort((a, b) => a.arrivedAt.getTime() - b.arrivedAt.getTime());
      const labels: string[] = [];
      for (const s of chosen) {
        const label = await this.geocode.label(s.lat, s.lng);
        if (label && !labels.includes(label)) labels.push(label);
      }
      if (labels.length > 0) {
        p.itinerary = labels;
        p.destinationLabel = labels[0]; // destination principale = 1er lieu réel (chronologique)
        p.destLat = chosen[0].lat;
        p.destLng = chosen[0].lng;
        // Trace l'itinéraire complet dans la justification (persistée sur la proposition, re-rendable).
        if (labels.length > 1) p.basis += ` · itinéraire : ${labels.join(' → ')}`;
        return;
      }
    }
    // Repli : pas d'arrêt dérivable → comportement historique (géocode du point d'arrivée).
    p.destinationLabel = await this.geocode.label(p.destLat, p.destLng);
  }
}
