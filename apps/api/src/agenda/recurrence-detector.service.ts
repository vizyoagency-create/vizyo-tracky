import { Injectable, Logger } from '@nestjs/common';
import { AlertType, Prisma } from '@prisma/client';
import { DORMANT_STOP_ACTING_MS, isVehicleDormant } from '@vizyo/tracky-shared';
import { ReverseGeocodeService } from '../geocoding/reverse-geocode.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { fleetTzFormatter, localParts } from './fleet-tz.util';
import { TripStopDetectorService, haversineMeters, type TripStop } from './trip-stop-detector.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Fenêtre d'apprentissage. */
const LOOKBACK_WEEKS = 10;
/** Motif retenu si observé sur ≥ ce nb de semaines DISTINCTES. */
const MIN_ACTIVE_WEEKS = 4;
/**
 * RÉCENCE du motif : au-delà, l'habitude est éteinte même si elle a été très régulière.
 *
 * 3 semaines. Le trou que ça bouche : avec 10 semaines d'apprentissage et 4 semaines suffisantes,
 * une tournée ARRÊTÉE fin mai « justifie » encore une réservation ferme fin juillet — l'agent
 * bloquait un véhicule pour un trajet que plus personne ne fait. 3 semaines tolère deux occurrences
 * manquées d'affilée (congés, pont, véhicule à l'atelier) sans ressusciter une tournée morte, et
 * reste cohérent avec l'horizon de projection de 14 jours.
 */
const PATTERN_RECENCY_MS = 3 * WEEK_MS;
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
  /** #5 — ZONES (géofences) traversées par le trajet type (ex. ["Sortie Toulouse"]). Vide si aucune. */
  zones: string[];
  activeWeeks: number;
  /** 0..1 = activeWeeks / fenêtre d'apprentissage. */
  confidence: number;
  /** Phrase de justification vulgarisée (« Observé 6 des 10 derniers lundis… »). */
  basis: string;
}

/**
 * Résultat d'une détection + ce qui a été ÉCARTÉ. Les compteurs existent pour qu'un « 0 récurrence
 * détectée » ne soit jamais un mystère : l'agent les reverse dans son bilan de passage.
 */
export interface RecurrenceDetectionResult {
  patterns: RecurringPattern[];
  /** Véhicules dont le boîtier s'est tu depuis > 72 h : ils ne roulent plus, leurs habitudes non plus. */
  skippedDormantVehicles: number;
  /** Motifs réguliers mais ÉTEINTS (dernière occurrence > {@link PATTERN_RECENCY_MS}). */
  skippedStalePatterns: number;
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
 *
 * DEUX GARDES DE VIVACITÉ, parce qu'un motif se déduit d'un passé qui, lui, ne bouge plus :
 *  - le VÉHICULE doit être vivant (boîtier entendu dans les 72 h) ;
 *  - le MOTIF doit être récent (dernière occurrence < 3 semaines).
 * Toutes deux sont dérivées au read-time — rien n'est écrit, rien n'est supprimé, et un véhicule
 * qui recommence à émettre retrouve ses récurrences tout seul.
 */
@Injectable()
export class RecurrenceDetectorService {
  private readonly logger = new Logger(RecurrenceDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocode: ReverseGeocodeService,
    private readonly stops: TripStopDetectorService,
    // Centre d'alerte (@Global) : remonte les échecs DB best-effort (zones/arrêts) qui, sinon,
    // resteraient invisibles (l'analyse dégrade en silence). Omis dans les specs (construction manuelle).
    private readonly errorLogger?: ErrorLogger,
  ) {}

  /** Détecte les trajets récurrents d'une flotte (avec destination géocodée, triés par confiance). */
  async detect(fleetId: string, opts?: { maxGeocode?: number }): Promise<RecurringPattern[]> {
    return (await this.detectWithStats(fleetId, opts)).patterns;
  }

  /**
   * Même détection, mais qui rend AUSSI ce qu'elle a écarté (véhicules dormants, motifs éteints).
   * C'est la variante que consomme l'agent : sans elle, une flotte dont la moitié des boîtiers
   * s'est tue verrait ses propositions fondre sans qu'aucun écran ne dise pourquoi.
   */
  async detectWithStats(fleetId: string, opts?: { maxGeocode?: number }): Promise<RecurrenceDetectionResult> {
    const nowMs = Date.now();
    const learnFrom = new Date(nowMs - LOOKBACK_WEEKS * WEEK_MS);
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
        // `tracker.lastSeenAt` est JOINT ici (aucune requête supplémentaire) : c'est la seule
        // source fiable pour savoir si le véhicule roule encore. On ne peut PAS le déduire des
        // trajets eux-mêmes — en mode vie privée les positions sont jetées alors que le boîtier
        // parle, on classerait « mort » tout véhicule sous RGPD.
        vehicle: { select: { plate: true, tracker: { select: { id: true, lastSeenAt: true } } } },
      },
      // ⚠️ `desc` et non `asc` : `take` TRONQUE, et la garde de récence ci-dessous juge un motif sur
      // sa DERNIÈRE occurrence. En ordre croissant, une flotte qui dépasse MAX_TRIPS ne recevait que
      // ses trajets les PLUS VIEUX — chaque `repAt` se retrouvait au fond de la fenêtre de 10
      // semaines et TOUS les motifs de la flotte tombaient d'un coup en « habitude éteinte », alors
      // que ces véhicules roulent tous les jours. À 20 000 trajets sur 70 jours (~285/jour, soit
      // ~8 trajets/véhicule/jour sur un parc de 37), le seuil est atteignable par un vrai client.
      // Rien d'autre ne dépend de l'ordre (agrégats par cluster, `repAt` par max, tri final explicite),
      // et sous le plafond les deux sens rendent exactement le même ensemble.
      orderBy: { startedAt: 'desc' },
      take: MAX_TRIPS,
    });
    if (trips.length >= MAX_TRIPS) this.logger.warn(`detect(${fleetId}) : ${MAX_TRIPS} trajets (apprentissage tronqué).`);

    // #3 — DÉPÔT de la flotte (base) : la cellule la plus fréquente parmi les départs ET arrivées.
    // Sert à écarter le dépôt de l'« itinéraire utile » (un aller-retour à la base n'est pas une destination).
    const depot = this.detectDepot(trips);

    const fmt = fleetTzFormatter();
    const clusters = new Map<string, Cluster>();
    /** Véhicules écartés pour dormance (Set : un véhicule compte UNE fois, pas une par trajet). */
    const dormantVehicles = new Set<string>();

    for (const t of trips) {
      // DORMANCE (seuil « arrêter d'agir », 72 h) : ce détecteur alimente un agent qui RÉSERVE
      // des véhicules. Un boîtier muet depuis 3 jours n'ajoutera plus un seul trajet à cet
      // historique — continuer d'en tirer des habitudes revient à bloquer un créneau pour un
      // véhicule qui, très probablement, n'est plus sur la route.
      //
      // Le cas qui MORD est le silence intermédiaire, pas l'extrême : à 89 jours (FV-941-LZ) la
      // fenêtre d'apprentissage de 10 semaines ne voit déjà plus aucun trajet. À 52 jours
      // (FL-787-KV) elle en voit encore ~5 semaines — largement de quoi franchir le seuil des
      // 4 semaines et faire pré-réserver, la nuit prochaine, un véhicule qui ne bouge plus.
      //
      // On ne touche NI aux trajets NI aux propositions déjà créées : l'historique reste entier,
      // et la première trame reçue remet le véhicule dans la détection dès le passage suivant.
      // Un véhicule sans boîtier (ou dont le boîtier n'a jamais émis) n'est pas dormant : ses
      // trajets — s'il en a — continuent de compter.
      if (
        isVehicleDormant(
          { trackerId: t.vehicle?.tracker?.id ?? null, lastSeenAt: t.vehicle?.tracker?.lastSeenAt ?? null },
          nowMs,
          DORMANT_STOP_ACTING_MS,
        )
      ) {
        dormantVehicles.add(t.vehicleId);
        continue;
      }
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
    let skippedStalePatterns = 0;
    for (const c of clusters.values()) {
      const activeWeeks = c.weeks.size;
      if (activeWeeks < MIN_ACTIVE_WEEKS) continue;
      // RÉCENCE : `repAt` est le trajet le plus RÉCENT du motif. Régulier hier ≠ vivant aujourd'hui —
      // une tournée abandonnée reste « observée 6/10 » pendant des semaines. Compté après le seuil
      // de régularité pour ne mesurer que les vraies habitudes éteintes (pas le bruit).
      if (nowMs - c.repAt > PATTERN_RECENCY_MS) {
        skippedStalePatterns++;
        continue;
      }
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
          zones: [],
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
    if (dormantVehicles.size > 0 || skippedStalePatterns > 0) {
      this.logger.log(
        `detect(${fleetId}) : ${dormantVehicles.size} véhicule(s) au boîtier muet et ` +
          `${skippedStalePatterns} motif(s) éteint(s) écartés.`,
      );
    }
    return {
      patterns: built.map((b) => b.pattern),
      skippedDormantVehicles: dormantVehicles.size,
      skippedStalePatterns,
    };
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

    // #5 — Zones (géofences) traversées par le trajet type : contexte MÉTIER (l'admin a dessiné ces
    // zones exprès, ex. « Sortie Toulouse ») → aide l'IA à comprendre le déplacement.
    if (rep?.endedAt) {
      try {
        p.zones = await this.deriveZones(c.vehicleId, rep.startedAt, rep.endedAt);
        if (p.zones.length > 0) p.basis += ` · zones : ${p.zones.join(', ')}`;
      } catch (e) {
        this.logger.warn(`deriveZones(${c.vehicleId}) : ${(e as Error)?.message ?? e}`);
        void this.errorLogger
          ?.record(e as Error, 'AGENDA_RECURRENCE', { vehicleId: c.vehicleId, phase: 'deriveZones' })
          .catch(() => {});
      }
    }

    let stops: TripStop[] = [];
    if (rep?.trackerId && rep.endedAt) {
      try {
        stops = await this.stops.deriveStops(rep.trackerId, rep.startedAt, rep.endedAt);
      } catch (e) {
        this.logger.warn(`deriveStops(${rep.trackerId}) : ${(e as Error)?.message ?? e}`);
        void this.errorLogger
          ?.record(e as Error, 'AGENDA_RECURRENCE', { trackerId: rep.trackerId, vehicleId: c.vehicleId, phase: 'deriveStops' })
          .catch(() => {});
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

  /**
   * #5 — Zones (géofences) traversées par un véhicule sur une fenêtre = noms distincts des
   * franchissements ENTER/EXIT (dans l'ordre). Le nom est extrait du titre de l'alerte
   * (`… zone "X"`). Vide si la flotte n'a pas de géofence sur ce trajet. Borné (perf).
   */
  private async deriveZones(vehicleId: string, from: Date, to: Date): Promise<string[]> {
    const alerts = await this.prisma.alert.findMany({
      where: {
        vehicleId,
        type: { in: [AlertType.GEOFENCE_ENTER, AlertType.GEOFENCE_EXIT] },
        createdAt: { gte: from, lte: to },
      },
      select: { title: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const names: string[] = [];
    for (const a of alerts) {
      const name = a.title.match(/"([^"]+)"/)?.[1];
      if (name && !names.includes(name)) names.push(name);
    }
    return names.slice(0, 5);
  }
}
