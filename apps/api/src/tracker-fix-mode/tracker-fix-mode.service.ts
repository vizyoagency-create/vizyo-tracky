import { Injectable, Logger } from '@nestjs/common';
import type { Fleet, Tracker, Vehicle } from '@prisma/client';
import { TrackerCommandStatus } from '@prisma/client';
import { findTemplate } from '@vizyo/tracky-shared';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
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
 * Politique (V1.14 — respect minimum hardware Coban GPS403D = 20s) :
 *   - MOVING                          → 20s ('020s')   — haute precision live
 *   - IDLE_ENGINE_ON                  → 30s ('030s')   — fluidite live moderee
 *   - STOPPED, ignition OFF > 10min   → 300s ('005m')  — economie batterie + data
 *
 * IDLE_ENGINE_ON garde 30s : un vehicule contact ON immobile n'a pas besoin de
 * precision (feu rouge, livraison, file d'attente) et 20s gaspillerait batterie+data.
 *
 * Garde-fous :
 *   - Quota anti-flapping : max 2 changements par tracker / jour
 *   - Hard-cap : intervalle clampe entre 10s et 300s
 *   - Override admin : `Tracker.fixModeOverrideUntil` bloque les transitions auto
 *   - Feature flag fleet : `Fleet.adaptiveFixModeEnabled = false` desactive le pilotage
 *
 * Reconciliation : a chaque trame valide, on observe le delta deviceTime et
 * on confirme `currentFixIntervalS` quand il converge vers la cible. Si la
 * commande est ignoree par le boitier sur 3 tentatives → flag FAILING.
 *
 * Note Coban GPS403D : min officiel documente = 20s. Le HARD_CAP_MIN_S est
 * aligne sur cette valeur pour eviter de demander un intervalle que le firmware
 * ne peut pas honorer (cause principale de FAILING persistant).
 */

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const STOPPED_GRACE_MS = 10 * 60 * 1000;
const RECONCILE_TOLERANCE = 0.2;
const FAILING_THRESHOLD = 3;
const FLAPPING_WINDOW_MS = 24 * 60 * 60 * 1000;
const FLAPPING_MAX_CHANGES = 2;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min minimum entre deux commandes
const HARD_CAP_MIN_S = 20;
const HARD_CAP_S = 300;
// V1.15 — Plancher d'auto-alignement. Quand un boitier emet plus vite que le
// minimum hardware (observe en prod : 2s, 10s), on accepte quand meme son
// intervalle reel pour le sortir de la boucle FAILING (cf reconcile()).
const AUTO_ALIGN_FLOOR_S = 1;
// V1.18 — Au-dela de cette vitesse (km/h) on considere le vehicule en mouvement :
// un intervalle plus lent que la cible devient alors un vrai echec (le boitier
// devrait emettre vite). En dessous, contact coupe = veille attendue, pas un echec.
// Aligne sur PositionSamplingService.MOVING_SPEED_KMH.
const PARKED_SPEED_KMH = 3;

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
    private readonly sms: SmsGatewayService,
  ) {}

  /**
   * V1.5 (Sprint I) — fallback SMS quand la socket TCP est indisponible > 5min.
   * Necessite que `Tracker.simPhoneNumber` soit renseigne (au provisionnement
   * SMS via /admin/sms/provision). Retourne true si le SMS a ete accepte
   * par le provider (pas de garantie de reception cote boitier).
   */
  private async tryFallbackSms(
    tracker: Pick<Tracker, 'imei' | 'simPhoneNumber' | 'lastSeenAt'>,
    payload: string,
    commandId: string,
  ): Promise<boolean> {
    if (!tracker.simPhoneNumber) return false;
    const offlineMs = tracker.lastSeenAt
      ? Date.now() - tracker.lastSeenAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (offlineMs < 5 * 60 * 1000) return false;
    if (!this.sms.isEnabled()) return false;
    const result = await this.sms.send(tracker.simPhoneNumber, payload, {
      imei: tracker.imei,
      commandId,
      template: 'fix_mode_fallback', source: 'fix-mode-fallback',
    });
    return result.ok;
  }

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
   * Generate an actionable diagnostic hint based on the current tracker state.
   * Used to populate `TrackerCommand.diagnosticHint` so an admin sees a concrete
   * suggestion in the UI without having to reason about the failure pattern.
   *
   * Rules are intentionally simple — they cover the 3-4 most common failure
   * modes observed on Coban-403D field deployments. Refine with field data.
   */
  static buildDiagnosticHint(input: {
    sentViaSocket: boolean;
    failureCount: number;
    lastSeenAt: Date | null | undefined;
    lastValidFrameAt: Date | null | undefined;
    desiredIntervalS: number;
    now?: Date;
  }): string | null {
    const now = input.now ?? new Date();

    // 1) Socket TCP indisponible — boitier offline ou GPRS coupe.
    if (!input.sentViaSocket) {
      const lastSeenMin = input.lastSeenAt
        ? Math.round((now.getTime() - input.lastSeenAt.getTime()) / 60000)
        : null;
      if (lastSeenMin === null) {
        return 'Tracker jamais vu. Verifier alimentation principale + carte SIM data + couverture GPRS.';
      }
      if (lastSeenMin > 60) {
        return `Tracker offline depuis ${lastSeenMin}min. Probable coupure GPRS prolongee — verifier la couverture sur la zone de stationnement, ou la carte SIM.`;
      }
      return `Socket TCP indisponible (dernier contact il y a ${lastSeenMin}min). Retry automatique au prochain reconnect.`;
    }

    // 2) Echecs repetes — firmware probablement bloque.
    if (input.failureCount >= 3) {
      return `${input.failureCount} commandes consecutives ignorees par le boitier. Tester un reset SMS (commande "RESET123456" via 07-sms-gateway) ou planifier une intervention physique.`;
    }
    if (input.failureCount === 2) {
      return 'Deuxieme tentative apres echec. Si cette commande echoue aussi, le boitier sera marque FAILING — preparer un diagnostic SMS.';
    }

    // 3) Derniere trame valide trop ancienne mais socket OK = probleme GPS.
    if (input.lastValidFrameAt) {
      const lastValidMin = Math.round((now.getTime() - input.lastValidFrameAt.getTime()) / 60000);
      if (lastValidMin > 30) {
        return `Pas de trame GPS valide depuis ${lastValidMin}min alors que la socket est ouverte. Verifier antenne GPS / occlusion (parking souterrain, garage).`;
      }
    }

    // 4) Premiere tentative, conditions normales — pas de hint particulier.
    return null;
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
    // V1.14 — Haute precision en MOVING (20s = minimum hardware Coban GPS403D).
    // IDLE_ENGINE_ON garde 30s : un vehicule contact ON immobile (feu rouge,
    // livraison) n'a pas besoin de precision maximale.
    if (state === 'MOVING') return HARD_CAP_MIN_S;
    if (state === 'IDLE_ENGINE_ON') return 30;

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
    /** V1.14 — Si le boitier ignore les commandes, on aligne desired sur l'observe. */
    autoAlignDesiredS: number | null;
  } {
    const prev = tracker.lastValidFrameAt;
    if (!prev) {
      return {
        nextCurrentFixIntervalS: tracker.currentFixIntervalS,
        nextFailureCount: tracker.fixCommandFailureCount,
        nextFailing: tracker.fixCommandFailureCount >= FAILING_THRESHOLD,
        autoAlignDesiredS: null,
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
        autoAlignDesiredS: null,
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
        autoAlignDesiredS: null,
      };
    }

    // V1.18 — Faux positif "vehicule gare". Quand le boitier emet PLUS LENTEMENT
    // que la cible alors qu'il n'est pas en mouvement (contact coupe / en veille),
    // c'est le comportement attendu du Coban GPS403D : ACC OFF, il repasse en
    // heartbeat ~horaire et ignore l'intervalle d'upload. Ce n'est donc pas un
    // echec. Sans cette garde, tout vehicule stationne finissait FAILING a tort
    // (observe en prod 2026-06-15 : 3 trackers gares, reel ~3600s vs cible 300s/10s).
    // On enregistre l'intervalle reel mais on remet le compteur a zero — ce qui
    // purge aussi un FAILING deja pose des la trame suivante (auto-guerison).
    const movingNow = frame.ignition === true || frame.speedKmh > PARKED_SPEED_KMH;
    if (observedS > upper && !movingNow) {
      return {
        nextCurrentFixIntervalS: observedS,
        nextFailureCount: 0,
        nextFailing: false,
        autoAlignDesiredS: null,
      };
    }

    // V1.15 — Compteur d'echecs borne au seuil FAILING. Une fois le boitier marque
    // FAILING, requestChange n'envoie plus de commandes : continuer d'incrementer a
    // chaque trame ne ferait que gonfler un compteur sans signification (observe en
    // prod : 316). On plafonne donc a FAILING_THRESHOLD.
    const nextFailureCount = Math.min(tracker.fixCommandFailureCount + 1, FAILING_THRESHOLD);
    const nextFailing = nextFailureCount >= FAILING_THRESHOLD;

    // V1.15 — Auto-alignement : quand le boitier ignore durablement les commandes
    // (FAILING), on aligne `desired` sur l'intervalle reellement observe pour sortir
    // de la boucle clear→re-fail. On accepte desormais aussi les intervalles SOUS le
    // minimum hardware (boitiers qui emettent plus vite que demande, ex. 2s/10s) :
    // sans ca ils restaient FAILING a vie, incapables de converger (reel != desired)
    // comme de s'aligner (l'ancien plancher etait HARD_CAP_MIN_S = 20s).
    const autoAlignDesiredS =
      nextFailing && observedS >= AUTO_ALIGN_FLOOR_S && observedS <= HARD_CAP_S
        ? observedS
        : null;

    return {
      nextCurrentFixIntervalS: observedS,
      nextFailureCount,
      nextFailing,
      autoAlignDesiredS,
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
    options?: { force?: boolean },
  ): Promise<{ commandId: string } | null> {
    // V1.14 — Hard cap : intervalle clampe entre 20s (minimum hardware Coban
    // GPS403D) et 300s (HARD_CAP_S, anti-spam economie batterie).
    const target = Math.min(Math.max(HARD_CAP_MIN_S, desiredS), HARD_CAP_S);
    const force = options?.force === true;

    // No-op if already aligned.
    if (tracker.desiredFixIntervalS === target && tracker.currentFixIntervalS === target) {
      return null;
    }

    // V1.6 — Cooldown apres FAILING : si le tracker est marque FAILING, on
    // arrete de tenter de nouvelles commandes jusqu'a ce qu'un admin l'acquitte
    // via /admin/alerts/trackers/:id/clear-failing OU jusqu'a ce qu'on observe
    // a nouveau l'intervalle attendu (reconcile remet failureCount a 0).
    // V1.14 — Le parametre `force` permet a un override admin de passer outre.
    if (tracker.fixCommandFailing && !force) {
      return null;
    }

    // Feature flag fleet.
    if (!tracker.vehicle || !tracker.vehicle.fleet.adaptiveFixModeEnabled) {
      return null;
    }

    // Override admin actif → ne pas changer (sauf force).
    if (!force && tracker.fixModeOverrideUntil && tracker.fixModeOverrideUntil.getTime() > Date.now()) {
      return null;
    }

    // Anti-flapping : cooldown 5 min + max 2 commandes/jour (bypasse en mode force).
    if (!force) {
      const lastFixCommand = await this.prisma.trackerCommand.findFirst({
        where: { trackerId: tracker.id, templateId: 'fix_continuous' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (lastFixCommand && Date.now() - lastFixCommand.createdAt.getTime() < COOLDOWN_MS) {
        this.logger.debug(
          `Cooldown: tracker ${tracker.imei} — derniere commande il y a ${Math.round((Date.now() - lastFixCommand.createdAt.getTime()) / 1000)}s, skip`,
        );
        return null;
      }

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
    const diagnosticHint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: sent,
      failureCount: tracker.fixCommandFailureCount,
      lastSeenAt: tracker.lastSeenAt,
      lastValidFrameAt: tracker.lastValidFrameAt,
      desiredIntervalS: target,
    });

    if (!sent) {
      // Tentative fallback SMS si tracker offline > 5min ET simPhoneNumber connu.
      const smsSent = await this.tryFallbackSms(tracker, payload, command.id);
      if (smsSent) {
        await this.prisma.trackerCommand.update({
          where: { id: command.id },
          data: {
            status: TrackerCommandStatus.SENT,
            sentAt: new Date(),
            channel: 'SMS',
            diagnosticHint,
          },
        });
        await this.prisma.tracker.update({
          where: { id: tracker.id },
          data: {
            desiredFixIntervalS: target,
            lastFixIntervalSyncAt: new Date(),
          },
        });
        this.logger.log(
          { trackerId: tracker.id, imei: tracker.imei, target },
          `Fix mode change envoye via SMS fallback (TCP indisponible)`,
        );
        return { commandId: command.id };
      }

      // Pas de fallback possible — la prochaine reconnexion permettra un retry au prochain reconcile.
      await this.prisma.trackerCommand.update({
        where: { id: command.id },
        data: {
          status: TrackerCommandStatus.FAILED,
          lastError: 'Tracker offline — socket TCP indisponible et fallback SMS impossible',
          diagnosticHint,
        },
      });
      return { commandId: command.id };
    }

    await this.prisma.trackerCommand.update({
      where: { id: command.id },
      data: {
        status: TrackerCommandStatus.SENT,
        sentAt: new Date(),
        diagnosticHint,
      },
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

    // V1.14 — Reset FAILING + override en une seule ecriture. L'admin qui pose
    // un override veut reprendre le controle → on remet le compteur a zero pour
    // que requestChange puisse passer (et on utilise force:true en securite).
    await this.prisma.tracker.update({
      where: { id: trackerId },
      data: {
        fixModeOverrideUntil: overrideUntil,
        fixCommandFailing: false,
        fixCommandFailureCount: 0,
      },
    });

    let commandId: string | null = null;
    if (desiredS && overrideUntil) {
      const tracker = await this.prisma.tracker.findUnique({
        where: { id: trackerId },
        include: { vehicle: { include: { fleet: true } } },
      });
      if (tracker) {
        const out = await this.requestChange(
          tracker as Tracker & { vehicle: (Vehicle & { fleet: Fleet }) | null },
          desiredS,
          'MANUAL_OPERATOR',
          { manualOverrideBy: requestedByUserId, untilMinutes },
          { force: true },
        );
        commandId = out?.commandId ?? null;
      }
    }

    return {
      overrideUntil: overrideUntil ? overrideUntil.toISOString() : null,
      commandId,
    };
  }
}
