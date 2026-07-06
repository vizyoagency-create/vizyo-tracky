import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReverseGeocodeService } from '../geocoding/reverse-geocode.service';
import { PrismaService } from '../prisma/prisma.service';
import { fleetTzFormatter, localParts } from './fleet-tz.util';

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
/** Plafond d'appels géocodage par analyse (respect quota Nominatim + latence bornée). */
const DEFAULT_MAX_GEOCODE = 40;

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
        vehicleId: true, startedAt: true, endedAt: true, endLat: true, endLng: true,
        vehicle: { select: { plate: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: MAX_TRIPS,
    });
    if (trips.length >= MAX_TRIPS) this.logger.warn(`detect(${fleetId}) : ${MAX_TRIPS} trajets (apprentissage tronqué).`);

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
        c = { vehicleId: t.vehicleId, plate: t.vehicle?.plate ?? null, dow: start.dow, weeks: new Map(), sumLat: 0, sumLng: 0, count: 0 };
        clusters.set(key, c);
      }
      c.sumLat += t.endLat;
      c.sumLng += t.endLng;
      c.count += 1;
      const wk = c.weeks.get(weekKey);
      if (!wk) c.weeks.set(weekKey, { minStart: start.minutes, maxEnd: endMin });
      else {
        wk.minStart = Math.min(wk.minStart, start.minutes);
        wk.maxEnd = Math.max(wk.maxEnd, endMin);
      }
    }

    // Motifs retenus + créneau typique (moyenne des enveloppes hebdo) + centroïde.
    const patterns: RecurringPattern[] = [];
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
      patterns.push({
        vehicleId: c.vehicleId,
        vehiclePlate: c.plate,
        dayOfWeek: c.dow,
        startMinutes,
        endMinutes,
        destLat: c.sumLat / c.count,
        destLng: c.sumLng / c.count,
        destinationLabel: null,
        activeWeeks,
        confidence: Math.round((activeWeeks / LOOKBACK_WEEKS) * 100) / 100,
        basis: `Observé ${activeWeeks}/${LOOKBACK_WEEKS} ${DOW_LABELS[c.dow] ?? ''}`.trim(),
      });
    }

    // Confiance décroissante : on géocode d'abord les motifs les plus solides (plafond quota).
    patterns.sort((a, b) => b.confidence - a.confidence || b.activeWeeks - a.activeWeeks);
    const cap = Math.max(0, opts?.maxGeocode ?? DEFAULT_MAX_GEOCODE);
    for (let i = 0; i < patterns.length && i < cap; i++) {
      patterns[i].destinationLabel = await this.geocode.label(patterns[i].destLat, patterns[i].destLng);
    }
    return patterns;
  }
}
