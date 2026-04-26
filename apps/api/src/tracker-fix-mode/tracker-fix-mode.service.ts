import { Injectable, Logger } from '@nestjs/common';
import type { Fleet, Tracker, Vehicle } from '@prisma/client';
import { TrackerCommandStatus } from '@prisma/client';
import { findTemplate } from '@vizyo/tracky-shared';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';

/**
 * V1.5 (Sprint H3) — Pilotage adaptatif du fix interval boitier (Coban `fix...***n`).
 *
 * Le seul levier qui reduit reellement la consommation electrique du boitier
 * est de changer la frequence de fix GPS / GPRS. Le serveur observe les
 * transitions d'etat (MOVING / IDLE_ENGINE_ON / STOPPED) calculees par le
 * sampling adaptatif et envoie une commande Coban via la socket TCP deja
 * ouverte pour ajuster l'intervalle.
 *
 * Politique :
 *   - MOVING / IDLE_ENGINE_ON         → 30s ('030s')   — fluidite live + reactivite
 *   - STOPPED, ignition OFF > 10min   → 300s ('005m')  — economie batterie + data
 *
 * Garde-fous :
 *   - Quota anti-flapping : max 2 changements par tracker / jour
 *   - Hard-cap superieur : jamais > 300s automatiquement
 *   - Override admin : `Tracker.fixModeOverrideUntil` bloque les transitions auto
 *   - Feature flag fleet : `Fleet.adaptiveFixModeEnabled = false` desactive le pilotage
 *
 * Reconciliation : a chaque trame valide, on observe le delta deviceTime et
 * on confirme `currentFixIntervalS` quand il converge vers la cible. Si la
 * commande est ignoree par le boitier sur 3 tentatives → flag FAILING.
 */

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const STOPPED_GRACE_MS = 10 * 60 * 1000;
const RECONCILE_TOLERANCE = 0.2;
const FAILING_THRESHOLD = 3;
const FLAPPING_WINDOW_MS = 24 * 60 * 60 * 1000;
const FLAPPING_MAX_CHANGES = 2;
const HARD_CAP_S = 300;

export type AdaptiveTrackerState = 'MOVING' | 'IDLE_ENGINE_ON' | 'STOPPED';

interface FrameContext {
  deviceTime: Date;
  speedKmh: number;
  ignition: boolean | null | undefined;
  lat: number;
  lng: number;
}

@Injectable()
export class TrackerFixModeService {
  private readonly logger = new Logger(TrackerFixModeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SocketRegistryService,
    private readonly wireLogger: CobanWireLogger,
  ) {}

  /**
   * Convert an interval in seconds to the Coban param string ('030s', '005m', etc.).
   * Coban supports `NNNs` (1-999s) and `NNNm` (1-999m). Past 60s, prefer minutes.
   */
  static intervalLabel(seconds: number): string {
    if (seconds < 60) return `${String(seconds).padStart(3, '0')}s`;
    const minutes = Math.round(seconds / 60);
    return `${String(minutes).padStart(3, '0')}m`;
  }

  /**
   * Decide the desired interval given the sampling state + ignition history.
   * Conservative: returns 30s in any ambiguous case (UX-first).
   */
  desiredIntervalFor(
    state: AdaptiveTrackerState,
    tracker: Pick<Tracker, 'lastIgnitionChangeAt' | 'lastKnownIgnition'>,
    now: Date = new Date(),
  ): number {
    if (state === 'MOVING' || state === 'IDLE_ENGINE_ON') return 30;

    // STOPPED — only switch to 300s if ignition has been OFF for > 10 min.
    // This avoids flipping during a short stop (e.g., red light, brief delivery).
    const ignitionOffSince = tracker.lastKnownIgnition === false ? tracker.lastIgnitionChangeAt : null;
    if (ignitionOffSince && now.getTime() - ignitionOffSince.getTime() > STOPPED_GRACE_MS) {
      return 300;
    }
    return 30;
  }

  /**
   * Reconcile the observed inter-frame interval against the desired one.
   * Returns the new currentFixIntervalS to write back, plus failing flags.
   *
   * Heuristic: a single observation isn't enough — we incrementally update
   * `currentFixIntervalS` to the latest delta as long as it's within ±20% of
   * `desiredFixIntervalS`. Otherwise we increment the failure counter and
   * flag FAILING after 3 misses.
   */
  reconcile(
    tracker: Pick<Tracker, 'desiredFixIntervalS' | 'currentFixIntervalS' | 'fixCommandFailureCount' | 'lastValidFrameAt' | 'lastFixIntervalSyncAt'>,
    frame: FrameContext,
  ): {
    nextCurrentFixIntervalS: number | null;
    nextFailureCount: number;
    nextFailing: boolean;
  } {
    const prev = tracker.lastValidFrameAt;
    if (!prev) {
      return {
        nextCurrentFixIntervalS: tracker.currentFixIntervalS,
        nextFailureCount: tracker.fixCommandFailureCount,
        nextFailing: tracker.fixCommandFailureCount >= FAILING_THRESHOLD,
      };
    }

    const observedS = Math.max(1, Math.round((frame.deviceTime.getTime() - prev.getTime()) / 1000));
    const targetS = tracker.desiredFixIntervalS;
    const lower = targetS * (1 - RECONCILE_TOLERANCE);
    const upper = targetS * (1 + RECONCILE_TOLERANCE);

    if (observedS >= lower && observedS <= upper) {
      // Convergence: the device is honouring the target interval.
      return {
        nextCurrentFixIntervalS: observedS,
        nextFailureCount: 0,
        nextFailing: false,
      };
    }

    // Skip sync windows: if we just sent a command, give the device 2 frames to react.
    if (
      tracker.lastFixIntervalSyncAt &&
      Date.now() - tracker.lastFixIntervalSyncAt.getTime() < 2 * targetS * 1000
    ) {
      return {
        nextCurrentFixIntervalS: tracker.currentFixIntervalS,
        nextFailureCount: tracker.fixCommandFailureCount,
        nextFailing: tracker.fixCommandFailureCount >= FAILING_THRESHOLD,
      };
    }

    const nextFailureCount = tracker.fixCommandFailureCount + 1;
    return {
      nextCurrentFixIntervalS: observedS,
      nextFailureCount,
      nextFailing: nextFailureCount >= FAILING_THRESHOLD,
    };
  }

  /**
   * Send a `fix...***n` command via TCP if the tracker is online.
   *
   * Returns the created TrackerCommand row, or null if anti-flapping or feature
   * flag prevents the change. Errors are logged but don't propagate — the
   * sampling pipeline must remain robust to fix mode failures.
   */
  async requestChange(
    tracker: Tracker & { vehicle: (Vehicle & { fleet: Fleet }) | null },
    desiredS: number,
    reason: string,
    contextSnapshot: Record<string, unknown>,
  ): Promise<{ commandId: string } | null> {
    // Hard cap.
    const target = Math.min(Math.max(30, desiredS), HARD_CAP_S);

    // No-op if already aligned.
    if (tracker.desiredFixIntervalS === target && tracker.currentFixIntervalS === target) {
      return null;
    }

    // Feature flag fleet.
    if (!tracker.vehicle || !tracker.vehicle.fleet.adaptiveFixModeEnabled) {
      return null;
    }

    // Override admin actif → ne pas changer.
    if (tracker.fixModeOverrideUntil && tracker.fixModeOverrideUntil.getTime() > Date.now()) {
      return null;
    }

    // Anti-flapping : max 2 commandes/jour.
    const recentCount = await this.prisma.trackerCommand.count({
      where: {
        trackerId: tracker.id,
        templateId: 'fix_continuous',
        createdAt: { gte: new Date(Date.now() - FLAPPING_WINDOW_MS) },
      },
    });
    if (recentCount >= FLAPPING_MAX_CHANGES) {
      this.logger.debug(
        `Anti-flapping: tracker ${tracker.imei} a deja ${recentCount} commandes fix mode dans les 24h, skip`,
      );
      return null;
    }

    // Build payload.
    const interval = TrackerFixModeService.intervalLabel(target);
    const template = findTemplate('fix_continuous');
    if (!template) {
      this.logger.error('Template fix_continuous introuvable dans COBAN_COMMAND_CATALOG');
      return null;
    }
    const payload = template.buildPayload(tracker.imei, { interval });

    // Persist command + snapshot before any wire IO.
    const command = await this.prisma.trackerCommand.create({
      data: {
        trackerId: tracker.id,
        templateId: 'fix_continuous',
        category: 'reporting',
        params: { interval } as object,
        payload,
        channel: 'TCP',
        status: TrackerCommandStatus.PENDING,
        requestedBy: SYSTEM_USER_ID,
        outcomeReason: reason,
        expectedResult: `intervalle ~${target}s observe sur les 3 prochaines trames`,
        contextSnapshot: contextSnapshot as object,
      },
    });

    // Send via TCP socket (canal descendant deja ouvert par le boitier).
    const sent = this.registry.send(tracker.imei, payload);
    if (!sent) {
      // Boitier offline — la prochaine reconnexion permettra un retry au prochain reconcile.
      await this.prisma.trackerCommand.update({
        where: { id: command.id },
        data: {
          status: TrackerCommandStatus.FAILED,
          lastError: 'Tracker offline — socket TCP indisponible',
          diagnosticHint: 'Verifier la couverture GPRS / l\'alimentation. Retry automatique au prochain reconcile.',
        },
      });
      return { commandId: command.id };
    }

    await this.prisma.trackerCommand.update({
      where: { id: command.id },
      data: { status: TrackerCommandStatus.SENT, sentAt: new Date() },
    });

    this.wireLogger.out(tracker.imei, payload, {
      commandId: command.id,
      source: 'fix-mode-adaptive',
    });

    // Update tracker desired + sync timestamp. The reconciler will confirm later.
    await this.prisma.tracker.update({
      where: { id: tracker.id },
      data: {
        desiredFixIntervalS: target,
        lastFixIntervalSyncAt: new Date(),
      },
    });

    this.logger.log(
      { trackerId: tracker.id, imei: tracker.imei, target, reason, commandId: command.id },
      `Fix mode change requested: ${tracker.desiredFixIntervalS}s -> ${target}s`,
    );

    return { commandId: command.id };
  }

  /**
   * Set / clear an admin override. While `until > now`, automatic transitions
   * are blocked. If `desiredS` is provided, also forces a one-shot command to
   * that interval.
   */
  async setManualOverride(
    trackerId: string,
    untilMinutes: number,
    desiredS: number | null,
    requestedByUserId: string,
  ): Promise<{ overrideUntil: string | null; commandId: string | null }> {
    const overrideUntil = untilMinutes > 0 ? new Date(Date.now() + untilMinutes * 60 * 1000) : null;
    await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { fixModeOverrideUntil: overrideUntil },
    });

    let commandId: string | null = null;
    if (desiredS && overrideUntil) {
      const tracker = await this.prisma.tracker.findUnique({
        where: { id: trackerId },
        include: { vehicle: { include: { fleet: true } } },
      });
      if (tracker) {
        // Bypass the override check by resetting it momentarily to send the command.
        await this.prisma.tracker.update({
          where: { id: trackerId },
          data: { fixModeOverrideUntil: null },
        });
        const out = await this.requestChange(
          tracker as Tracker & { vehicle: (Vehicle & { fleet: Fleet }) | null },
          desiredS,
          'MANUAL_OPERATOR',
          { manualOverrideBy: requestedByUserId, untilMinutes },
        );
        await this.prisma.tracker.update({
          where: { id: trackerId },
          data: { fixModeOverrideUntil: overrideUntil },
        });
        commandId = out?.commandId ?? null;
      }
    }

    return {
      overrideUntil: overrideUntil ? overrideUntil.toISOString() : null,
      commandId,
    };
  }
}
