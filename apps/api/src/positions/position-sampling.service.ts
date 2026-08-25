import { Injectable, Logger } from '@nestjs/common';
import type { Tracker } from '@prisma/client';
import { distanceMeters } from '../common/utils/haversine';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint H1) — Sampling adaptatif des positions cote serveur.
 *
 * Decide si une trame entrante doit etre persistee dans `positions` ou skippee.
 * Le broadcast WS reste integral (UX-first) — seul le stockage est filtre.
 *
 * Politique :
 *   - MOVING            (vitesse > 3 km/h OU mouvement > 15m) → INSERT chaque trame
 *   - IDLE_ENGINE_ON    (ignition ON, immobile)               → INSERT toutes les 90s
 *   - STOPPED           (ignition OFF, immobile)              → INSERT toutes les 300s
 *
 * Toujours forcer l'INSERT sur :
 *   - transition d'etat (MOVING → STOPPED, etc.) — capture des bornes de trip
 *   - mode verbose admin (debugging) — Tracker.verboseUntil > now
 *   - fleet en mode "tracage continu" — Fleet.adaptiveSamplingEnabled = false
 */

export type VehicleState = 'MOVING' | 'IDLE_ENGINE_ON' | 'STOPPED';

export type SamplingDecision =
  | 'INSERTED'
  | 'INSERTED_VERBOSE'
  | 'SKIPPED_DUP'
  | 'SKIPPED_THROTTLE'
  // Trame non autoritaire rejetee par le garde-fou d'ingestion (replay buffer
  // boitier : deviceTime anterieur, ou saut infaisable). Cf. PositionsService.ingest.
  | 'SKIPPED_REPLAY'
  // TRK-015 — trame anterieure PERSISTEE parce qu'aucune position n'existait a cet
  // horodatage : c'est un rattrapage de tampon, pas un fantome. La ligne `positions` est
  // ecrite, la baseline du tracker n'est PAS touchee. Volontairement distincte de
  // SKIPPED_REPLAY : sans quoi on ne pourrait plus mesurer ce qu'on a recupere, ni ce
  // qu'on continue d'ecarter — et c'est cette mesure qui prouve que le garde-fou vit
  // encore. Cf. PositionsService.recupererTrameTamponnee.
  | 'RECOVERED_BUFFER';

export interface SamplingOutcome {
  shouldInsert: boolean;
  decision: SamplingDecision;
  state: VehicleState;
  reason: string;
  distanceM: number | null;
}

interface ClassifyInput {
  speedKmh: number;
  ignition: boolean | null | undefined;
  lat: number;
  lng: number;
  prevLat: number | null | undefined;
  prevLng: number | null | undefined;
}

const MOVING_SPEED_KMH = 3;
const MOVING_DISTANCE_M = 15;
const IDLE_THROTTLE_MS = 90 * 1000;
/**
 * Espacement des ÉCRITURES à l'arrêt. Exporté (TRK-047) : c'est LA constante qui sépare
 * « ce que le boîtier envoie » (une trame / ~20 s) de « ce que la base garde » (une position /
 * 5 min à l'arrêt — 87 % des trames sont volontairement écartées). Tout seuil qui juge une
 * absence de POSITIONS doit se calibrer sur elle, jamais sur la cadence des trames.
 */
export const STOPPED_THROTTLE_MS = 300 * 1000;

@Injectable()
export class PositionSamplingService {
  private readonly logger = new Logger(PositionSamplingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Classify the vehicle state from the incoming frame and last known position. */
  classify(input: ClassifyInput): { state: VehicleState; distanceM: number | null } {
    const distanceM =
      input.prevLat != null && input.prevLng != null
        ? distanceMeters(input.prevLat, input.prevLng, input.lat, input.lng)
        : null;

    if (input.speedKmh > MOVING_SPEED_KMH || (distanceM !== null && distanceM > MOVING_DISTANCE_M)) {
      return { state: 'MOVING', distanceM };
    }

    if (input.ignition === true) {
      return { state: 'IDLE_ENGINE_ON', distanceM };
    }

    return { state: 'STOPPED', distanceM };
  }

  /**
   * Decide whether to persist this frame.
   *
   * @param tracker          tracker fetched in `ingest()` (must include lastWriteAt + lastSampledState + verboseUntil)
   * @param state            classification computed via `classify()`
   * @param distanceM        haversine vs last persisted position (or null on first ever frame)
   * @param adaptiveEnabled  fleet-level feature flag (false = always insert — legal mode)
   * @param now              injectable clock (default Date.now()), useful for tests
   */
  decide(
    tracker: Pick<Tracker, 'lastWriteAt' | 'lastSampledState' | 'verboseUntil'>,
    state: VehicleState,
    distanceM: number | null,
    adaptiveEnabled: boolean,
    now: number = Date.now(),
  ): SamplingOutcome {
    // Verbose mode forced by admin → bypass sampling completely.
    if (tracker.verboseUntil && tracker.verboseUntil.getTime() > now) {
      return {
        shouldInsert: true,
        decision: 'INSERTED_VERBOSE',
        state,
        reason: `mode verbose actif jusqu'a ${tracker.verboseUntil.toISOString()}`,
        distanceM,
      };
    }

    // Fleet opt-out → always insert (continuous tracking required).
    if (!adaptiveEnabled) {
      return {
        shouldInsert: true,
        decision: 'INSERTED',
        state,
        reason: 'sampling adaptatif desactive sur la fleet',
        distanceM,
      };
    }

    // No previous write → always insert (initial point).
    if (!tracker.lastWriteAt) {
      return {
        shouldInsert: true,
        decision: 'INSERTED',
        state,
        reason: 'premiere position du tracker',
        distanceM,
      };
    }

    // Transition d'etat → always insert (capture des bornes de trip).
    const prevState = tracker.lastSampledState;
    if (prevState && prevState !== state) {
      return {
        shouldInsert: true,
        decision: 'INSERTED',
        state,
        reason: `transition ${prevState} -> ${state}`,
        distanceM,
      };
    }

    // En mouvement → toujours INSERT (frequence native 30s du boitier).
    if (state === 'MOVING') {
      return {
        shouldInsert: true,
        decision: 'INSERTED',
        state,
        reason: distanceM !== null
          ? `mouvement actif (${distanceM.toFixed(1)}m vs derniere pos)`
          : 'mouvement actif',
        distanceM,
      };
    }

    // A l'arret → throttle.
    const ageMs = now - tracker.lastWriteAt.getTime();
    const throttleMs = state === 'IDLE_ENGINE_ON' ? IDLE_THROTTLE_MS : STOPPED_THROTTLE_MS;

    if (ageMs >= throttleMs) {
      return {
        shouldInsert: true,
        decision: 'INSERTED',
        state,
        reason: `throttle ${state} expire (${(ageMs / 1000).toFixed(0)}s >= ${throttleMs / 1000}s)`,
        distanceM,
      };
    }

    // Skip — position quasi identique, throttle actif.
    const distanceLabel = distanceM !== null ? `${distanceM.toFixed(1)}m` : '?';
    return {
      shouldInsert: false,
      decision: 'SKIPPED_THROTTLE',
      state,
      reason: `${state} immobile, throttle ${throttleMs / 1000}s actif (last write ${(ageMs / 1000).toFixed(0)}s ago, distance ${distanceLabel})`,
      distanceM,
    };
  }

  /** Persist the audit trail row. Errors are swallowed (audit is non-critical). */
  async recordDecision(
    trackerId: string,
    outcome: SamplingOutcome,
    speedKmh: number,
    ignition: boolean | null | undefined,
  ): Promise<void> {
    try {
      await this.prisma.positionSamplingDecision.create({
        data: {
          trackerId,
          decision: outcome.decision,
          state: outcome.state,
          reason: outcome.reason,
          speedKmh,
          ignition: ignition ?? null,
          distanceM: outcome.distanceM,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist PositionSamplingDecision for tracker ${trackerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Aggregate stats for the admin sampling dashboard.
   *
   * The audit trail (`position_sampling_decisions`) is rolling-7d, so requesting
   * a longer range silently caps at 7d. The frontend should show the effective range.
   */
  async getStats(trackerId: string, rangeHours: number): Promise<{
    rangeHours: number;
    received: number;
    inserted: number;
    skipped: number;
    insertRatio: number;
    byState: { state: VehicleState; inserted: number; skipped: number }[];
    byDecision: { decision: SamplingDecision; count: number }[];
  }> {
    const since = new Date(Date.now() - rangeHours * 3600 * 1000);

    const rows = await this.prisma.positionSamplingDecision.groupBy({
      by: ['state', 'decision'],
      where: { trackerId, receivedAt: { gte: since } },
      _count: { _all: true },
    });

    let received = 0;
    let inserted = 0;
    let skipped = 0;
    const byStateMap = new Map<string, { inserted: number; skipped: number }>();
    const byDecisionMap = new Map<string, number>();

    for (const row of rows) {
      const count = row._count._all;
      received += count;
      const isInsert = row.decision === 'INSERTED' || row.decision === 'INSERTED_VERBOSE';
      if (isInsert) inserted += count;
      else skipped += count;

      const stateBucket = byStateMap.get(row.state) ?? { inserted: 0, skipped: 0 };
      if (isInsert) stateBucket.inserted += count;
      else stateBucket.skipped += count;
      byStateMap.set(row.state, stateBucket);

      byDecisionMap.set(row.decision, (byDecisionMap.get(row.decision) ?? 0) + count);
    }

    return {
      rangeHours,
      received,
      inserted,
      skipped,
      insertRatio: received > 0 ? inserted / received : 0,
      byState: Array.from(byStateMap, ([state, c]) => ({
        state: state as VehicleState,
        inserted: c.inserted,
        skipped: c.skipped,
      })),
      byDecision: Array.from(byDecisionMap, ([decision, count]) => ({
        decision: decision as SamplingDecision,
        count,
      })),
    };
  }

  /**
   * Hourly histogram of decisions for the last N days, used to draw the
   * timeline chart on the admin page (one row per hour bucket).
   */
  async getHourlyHistogram(
    trackerId: string,
    days: number,
  ): Promise<{ hour: string; inserted: number; skipped: number }[]> {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    // Postgres-side bucketing for efficiency. `date_trunc('hour', "receivedAt")`
    // returns one row per (tracker, hour, decision-type).
    const rows = await this.prisma.$queryRaw<
      { hour: Date; inserted: bigint; skipped: bigint }[]
    >`
      SELECT
        date_trunc('hour', "receivedAt") AS hour,
        SUM(CASE WHEN "decision" IN ('INSERTED', 'INSERTED_VERBOSE') THEN 1 ELSE 0 END) AS inserted,
        SUM(CASE WHEN "decision" IN ('SKIPPED_DUP', 'SKIPPED_THROTTLE', 'SKIPPED_REPLAY') THEN 1 ELSE 0 END) AS skipped
      FROM "position_sampling_decisions"
      WHERE "trackerId" = ${trackerId}::uuid AND "receivedAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return rows.map((r) => ({
      hour: r.hour.toISOString(),
      inserted: Number(r.inserted),
      skipped: Number(r.skipped),
    }));
  }

  /** Last N decisions for inspection (skip list). */
  async getRecentDecisions(trackerId: string, limit: number): Promise<{
    id: string;
    decision: SamplingDecision;
    state: VehicleState;
    reason: string | null;
    speedKmh: number | null;
    ignition: boolean | null;
    distanceM: number | null;
    receivedAt: string;
  }[]> {
    const rows = await this.prisma.positionSamplingDecision.findMany({
      where: { trackerId },
      orderBy: { receivedAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      decision: r.decision as SamplingDecision,
      state: r.state as VehicleState,
      reason: r.reason,
      speedKmh: r.speedKmh,
      ignition: r.ignition,
      distanceM: r.distanceM,
      receivedAt: r.receivedAt.toISOString(),
    }));
  }

  /**
   * Toggle verbose mode for a tracker — bypasses sampling for `durationMinutes`.
   * Useful for diagnosing a misbehaving tracker without disabling sampling fleet-wide.
   * Pass `0` to clear the override immediately.
   */
  async setVerboseMode(trackerId: string, durationMinutes: number): Promise<{ verboseUntil: string | null }> {
    const verboseUntil = durationMinutes > 0 ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;
    const updated = await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { verboseUntil },
      select: { verboseUntil: true },
    });
    return { verboseUntil: updated.verboseUntil ? updated.verboseUntil.toISOString() : null };
  }
}
