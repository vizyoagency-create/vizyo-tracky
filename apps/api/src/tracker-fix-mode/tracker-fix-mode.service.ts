import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Fleet, Tracker, Vehicle } from '@prisma/client';
import { TrackerCommandStatus } from '@prisma/client';
import {
  findTemplate,
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  isVehicleDormant,
} from '@vizyo/tracky-shared';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
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
// V1.19 (TRK-008) — REMONTÉ de 1 s au minimum matériel. Ce plancher avait été abaissé à 1 s
// (V1.15) pour sortir de FAILING les boîtiers qui émettent PLUS VITE que demandé et ne
// pouvaient ni converger ni s'aligner. Ce motif a disparu : `reconcile` ne les compte plus en
// échec du tout (cf. la garde « plus vite que demandé »). Le plancher peut donc redevenir ce
// qu'il n'aurait jamais dû cesser d'être — une cible que le matériel ne peut pas tenir ne doit
// pas pouvoir s'écrire. Défense en profondeur : avec la nouvelle garde, l'auto-alignement ne
// voit de toute façon plus que des intervalles supérieurs à la cible.
const AUTO_ALIGN_FLOOR_S = HARD_CAP_MIN_S;
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
  /** Anti-chevauchement du balayage des commandes périmées (TRK-007). */
  private expiring = false;
  /**
   * Échéance d'une `fix_continuous` sans accusé (env `FIX_COMMAND_EXPIRY_MIN`, défaut 30 min).
   * Bien au-delà de la fenêtre de grâce maximale (2 × 300 s = 10 min) : une commande encore
   * ouverte passé ce délai n'a plus aucune chance d'être confirmée.
   */
  private readonly commandExpiryMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SocketRegistryService,
    private readonly wireLogger: CobanWireLogger,
    private readonly sms: SmsGatewayService,
    private readonly ackWaiter: AckWaiterService,
  ) {
    const min = Number(process.env.FIX_COMMAND_EXPIRY_MIN);
    this.commandExpiryMs = (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
  }

  /**
   * V1.5 (Sprint I) — fallback SMS quand la socket TCP est indisponible > 5min.
   * Necessite que `Tracker.simPhoneNumber` soit renseigne (au provisionnement
   * SMS via /admin/sms/provision). Retourne true si le SMS a ete accepte
   * par le provider (pas de garantie de reception cote boitier).
   *
   * PORTE « BOITIER MUET » (seuil AGIR = 72 h) : ce repli est la SEULE primitive de ce
   * service qui coute de l'argent reel. Il est deja borne PAR LE BAS (silence > 5 min,
   * sinon la socket suffit) ; on le borne desormais aussi PAR LE HAUT. Entre les deux,
   * le boitier est joignable et le SMS a un sens. Au-dela de 72 h de silence, on sait
   * que l'alimentation, la SIM ou le boitier lui-meme ont disparu : le SMS serait
   * facture pour rien. `force` (override admin explicite) reste au-dessus de cette
   * porte — un humain qui decide de sonder un boitier silencieux garde ce droit.
   */
  private async tryFallbackSms(
    tracker: Pick<Tracker, 'id' | 'imei' | 'simPhoneNumber' | 'lastSeenAt'>,
    payload: string,
    commandId: string,
    force = false,
  ): Promise<boolean> {
    if (!tracker.simPhoneNumber) return false;
    const offlineMs = tracker.lastSeenAt
      ? Date.now() - tracker.lastSeenAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (offlineMs < 5 * 60 * 1000) return false;
    if (
      !force &&
      isVehicleDormant(
        { trackerId: tracker.id, lastSeenAt: tracker.lastSeenAt },
        Date.now(),
        DORMANT_STOP_ACTING_MS,
      )
    ) {
      this.logger.debug(
        `Repli SMS ignore: tracker ${tracker.imei} muet depuis ${formatSilenceLabel(tracker.lastSeenAt)} (> 72 h)`,
      );
      return false;
    }
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
   * TRK-013 — inverse d'`intervalLabel` : relit l'intervalle DEMANDÉ depuis
   * `TrackerCommand.params.interval` ('020s' → 20, '005m' → 300). Retourne null quand le
   * paramètre est absent ou illisible (anciennes lignes, JSON inattendu) : on ne devine
   * jamais une cible — et sans cible demandée, aucun verdict de succès n'est prononçable.
   */
  static intervalSeconds(label: unknown): number | null {
    if (typeof label !== 'string') return null;
    const m = /^(\d{1,3})([sm])$/.exec(label.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (n <= 0) return null;
    return m[2] === 'm' ? n * 60 : n;
  }

  /**
   * Generate an actionable diagnostic hint based on the current tracker state.
   * Used to populate `TrackerCommand.diagnosticHint` so an admin sees a concrete
   * suggestion in the UI without having to reason about the failure pattern.
   *
   * Rules are intentionally simple — they cover the 3-4 most common failure
   * modes observed on Coban-403D field deployments. Refine with field data.
   */
  /**
   * TRK-014 — inscrit un guetteur d'ACK après un envoi TCP réussi.
   *
   * Ce chemin écrivait `SENT`, journalisait la trame, et s'arrêtait là. Résultat : sur
   * **4071 commandes depuis le 2026-04-27, `ackedAt` et `ackResponse` sont NULL sans une
   * seule exception**. On en concluait que « le Coban n'accuse pas réception » — alors que
   * personne n'avait jamais écouté. Le motif (`/fix.*ok/i`) et le délai (15 s) existaient
   * déjà au catalogue, et `tcp-server.service` offre chaque trame entrante au guetteur : il
   * ne manquait que l'inscription.
   *
   * Ce que ça débloque : [TRK-012] (la cadence de 300 s jamais appliquée) repose entièrement
   * sur l'observation des trames, ce qui laisse trois causes indiscernables — commande non
   * reçue, rejetée en silence (mot de passe), ou acceptée sans être appliquée. Un `fix ok`,
   * ou même une absence de réponse ENFIN TRACÉE, tranche entre elles.
   *
   * ⚠️ **L'ACK informe, il ne décide de rien.** On ne touche PAS au `status` : ni
   * `ACKNOWLEDGED` en cas de réponse, ni `FAILED` en cas de silence. C'est la leçon
   * durement acquise de TRK-007 — reconditionner la clôture à une réponse du boîtier
   * laisserait de nouveau des commandes ouvertes à vie dès qu'il se tait, et le centre
   * d'alerte redeviendrait une file qui ne se vide pas. L'échéance PUREMENT TEMPORELLE
   * reste la seule fin de vie d'une commande.
   */
  private armAckListener(
    imei: string,
    commandId: string,
    template: { expectedAckPattern?: RegExp; ackTimeoutMs?: number },
  ): void {
    const pattern = template.expectedAckPattern;
    const timeoutMs = template.ackTimeoutMs;
    if (!pattern || !timeoutMs) return;

    const sentAt = Date.now();
    this.ackWaiter
      .waitForAck(imei, pattern, timeoutMs, commandId)
      .then(async (rawAck) => {
        this.wireLogger.ackMatch(imei, rawAck, commandId, Date.now() - sentAt);
        // Information ajoutée, statut inchangé (cf. ⚠️ ci-dessus).
        await this.prisma.trackerCommand.update({
          where: { id: commandId },
          data: { ackedAt: new Date(), ackResponse: rawAck },
        });
        this.logger.log(
          { imei, commandId, rawAck },
          `TRK-014 — premier accusé de réception reçu sur le chemin adaptatif`,
        );
      })
      .catch(async (err) => {
        // Le silence est une MESURE, pas un incident : il répond enfin à « le boîtier
        // répond-il ? ». Tracé au journal de trames ET dans l'indice de diagnostic, qui
        // lui est durable et visible à l'écran des commandes.
        this.wireLogger.ackTimeout(imei, commandId, pattern.source, timeoutMs);
        await this.prisma.trackerCommand
          .update({
            where: { id: commandId },
            data: {
              diagnosticHint: `Aucune réponse du boîtier en ${Math.round(timeoutMs / 1000)} s (motif attendu : ${pattern.source}). Le canal descendant est ouvert et la trame est partie — le boîtier ne confirme rien.`,
            },
          })
          .catch(() => undefined);
        this.logger.debug({ imei, commandId, err: (err as Error)?.message }, 'ACK timeout fix-mode');
      })
      // Un guetteur d'arrière-plan ne doit JAMAIS remonter jusqu'à l'appelant : il tourne
      // après que la commande a été rendue.
      .catch(() => undefined);
  }

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
        return 'Tracker jamais vu. Vérifier alimentation principale + carte SIM data + couverture GPRS.';
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
        return `Pas de trame GPS valide depuis ${lastValidMin}min alors que la socket est ouverte. Vérifier antenne GPS / occlusion (parking souterrain, garage).`;
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
  /**
   * V1.19 (TRK-007) — SOLDE LES COMMANDES `fix_continuous` RESTÉES SANS FIN.
   *
   * ══ Pourquoi ce balayage existe ═══════════════════════════════════════════════════════
   *
   * Une `fix_continuous` n'est jamais acquittée par le boîtier : le Coban n'émet pas d'ACK
   * fiable. Elle déclare pourtant comment la vérifier — « intervalle observé sur les 3
   * prochaines trames » — mais rien n'écrivait cette observation dans la commande. La seule
   * fermeture automatique existante se déclenche à la TRANSITION `fixCommandFailing`
   * false→true.
   *
   * Or cette transition peut ne JAMAIS survenir : la garde « véhicule garé » remet le
   * compteur d'échecs à zéro à chaque trame lente. Un boîtier immobile qui émet une trame
   * par heure (heartbeat ACC OFF) ne bascule donc jamais — et sa commande reste `SENT` à
   * vie. Constaté en prod : 3 commandes ouvertes, la plus ancienne depuis 13 h 40, sur des
   * boîtiers à 3600 s réels pour une cible de 20 s.
   *
   * ══ Pourquoi l'échéance est PUREMENT TEMPORELLE ═══════════════════════════════════════
   *
   * La conditionner à un état du boîtier (FAILING, en mouvement, joignable…) la ferait
   * retomber dans le même piège : c'est précisément la composition de deux gardes justes qui
   * a laissé la commande ouverte. Une commande sans accusé de réception doit avoir une fin
   * qui ne dépend que de l'horloge.
   *
   * ══ TRK-013 — le verdict COMPARE avant d'affirmer ═════════════════════════════════════
   *
   * Ce balayage écrivait `FAILED` sans jamais comparer la cadence réelle à celle demandée :
   * des clôtures « cadence réelle 20s pour une cible de 20s » archivées en échec, alors que
   * la commande avait RÉUSSI. Pire : la « cible » citée était `desiredFixIntervalS`, lue au
   * moment du balayage — pas celle de la commande (`params.interval`), réécrite entre-temps.
   * Désormais : cadence réelle dans la bande ±20 % (RECONCILE_TOLERANCE, la même que
   * `reconcile`) de l'intervalle DEMANDÉ → `ACKNOWLEDGED` « cible atteinte » ; sinon
   * `FAILED` — pas `CANCELLED` : la commande a bien été émise et n'a pas abouti — en citant
   * l'intervalle demandé. `observedResult` dit ce qui s'est passé, pas ce qu'on espérait.
   * Le QUAND de la clôture, lui, reste purement temporel (cf. ci-dessus).
   */
  @Cron('45 */10 * * * *')
  async expireStaleFixCommands(): Promise<void> {
    if (this.expiring) return;
    this.expiring = true;
    // ⚠️ AVANT le balayage, volontairement : la boucle ci-dessous sort tôt quand il n'y a
    // rien à fermer — le cas NORMAL. Placée après, la normalisation n'aurait tourné que les
    // jours où une commande traînait, c'est-à-dire presque jamais.
    await this.normalizeDriftedTargets();
    try {
      const cutoff = new Date(Date.now() - this.commandExpiryMs);
      const stale = await this.prisma.trackerCommand.findMany({
        where: {
          templateId: 'fix_continuous',
          status: { in: [TrackerCommandStatus.PENDING, TrackerCommandStatus.SENT] },
          acknowledgedAt: null,
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          createdAt: true,
          // TRK-013 — `params.interval` est la cible DEMANDÉE par la commande : c'est elle
          // qu'on compare et qu'on cite. `desiredFixIntervalS` (cible COURANTE du boîtier,
          // réécrite entre-temps par les commandes suivantes) n'est volontairement plus
          // chargée : la citer était le second défaut, on rend la récidive impossible.
          params: true,
          tracker: { select: { imei: true, currentFixIntervalS: true } },
        },
        take: 200,
      });
      if (!stale.length) return;

      let atteintes = 0;
      for (const c of stale) {
        const ageMin = Math.round((Date.now() - c.createdAt.getTime()) / 60_000);
        const reel = c.tracker.currentFixIntervalS;
        // TRK-013 — la cible est l'intervalle DEMANDÉ par la commande (params.interval),
        // jamais la cible courante du boîtier, réécrite entre-temps par d'autres commandes.
        const demandeS = TrackerFixModeService.intervalSeconds(
          (c.params as Record<string, unknown> | null)?.['interval'],
        );
        // Même bande ±20 % que `reconcile` (bornes incluses) : c'est déjà elle qui juge la
        // convergence trame par trame — juger autrement ici fabriquerait deux vérités.
        // À l'égalité stricte, 21 s pour 20 s demandés passerait pour un échec alors que le
        // boîtier honore sa consigne (cas FS-253-HR du 07/08).
        const cibleAtteinte =
          demandeS != null &&
          reel != null &&
          reel >= demandeS * (1 - RECONCILE_TOLERANCE) &&
          reel <= demandeS * (1 + RECONCILE_TOLERANCE);
        if (cibleAtteinte) atteintes += 1;
        // ⚠️ Le QUAND de la clôture reste PUREMENT temporel (leçon TRK-007) ; la comparaison
        // ne décide que du QUOI — le verdict écrit. Et on ne touche ni à `ackedAt` /
        // `ackResponse` (réservés à une vraie réponse du boîtier : TRK-014 mesure leur
        // absence, un faux ackedAt truquerait cette mesure) ni à `acknowledgedAt` (réservé
        // à l'acquittement manuel d'un admin).
        await this.prisma.trackerCommand
          .update({
            where: { id: c.id },
            data: cibleAtteinte
              ? {
                  status: TrackerCommandStatus.ACKNOWLEDGED,
                  observedResult:
                    `Cible atteinte : cadence réelle ${reel}s pour ${demandeS}s demandés — ` +
                    `sans accusé de réception du boîtier. Close par échéance après ${ageMin} min.`,
                }
              : {
                  status: TrackerCommandStatus.FAILED,
                  observedResult:
                    `Sans effet constaté après ${ageMin} min : cadence réelle ` +
                    `${reel != null ? `${reel}s` : 'inconnue'} pour ` +
                    `${demandeS != null ? `${demandeS}s demandés` : 'une cible demandée illisible'}. ` +
                    `Le boîtier n'acquitte pas ; commande close par échéance.`,
                },
          })
          .catch(() => undefined);
      }
      this.logger.log(
        `Fix-mode: ${stale.length} commande(s) fix_continuous close(s) par échéance (> ${Math.round(this.commandExpiryMs / 60_000)} min).`,
      );
    } catch (err) {
      // Un balayage qui échoue ne doit pas casser le service ; il repassera dans 10 min.
      this.logger.warn(`Fix-mode: échec du balayage des commandes périmées: ${err}`);
    } finally {
      this.expiring = false;
    }
  }

  /**
   * V1.19 (TRK-008) — remet dans les clous les cibles héritées de l'ancien auto-alignement.
   *
   * `reconcile` les CLAMPE déjà à la lecture : elles ne condamnent plus personne. Mais elles
   * restent écrites en base, où elles s'affichent sur la fiche véhicule — « cadence cible :
   * 1 s » n'a aucun sens pour un opérateur, et le prochain audit les recompterait comme si
   * rien n'avait changé. Un chiffre faux qui persiste finit par être cru.
   *
   * Écriture idempotente et bornée aux valeurs hors plage : sur un parc sain, ces deux
   * requêtes ne touchent aucune ligne.
   */
  private async normalizeDriftedTargets(): Promise<void> {
    try {
      const [tooFast, tooSlow] = await Promise.all([
        this.prisma.tracker.updateMany({
          where: { desiredFixIntervalS: { lt: HARD_CAP_MIN_S } },
          data: { desiredFixIntervalS: HARD_CAP_MIN_S },
        }),
        this.prisma.tracker.updateMany({
          where: { desiredFixIntervalS: { gt: HARD_CAP_S } },
          data: { desiredFixIntervalS: HARD_CAP_S },
        }),
      ]);
      const total = tooFast.count + tooSlow.count;
      if (total > 0) {
        this.logger.log(
          `Fix-mode: ${total} cible(s) de cadence ramenée(s) dans [${HARD_CAP_MIN_S}, ${HARD_CAP_S}]s (héritage de l'ancien auto-alignement).`,
        );
      }
    } catch (err) {
      this.logger.warn(`Fix-mode: échec de la normalisation des cibles: ${err}`);
    }
  }

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
    // V1.19 (TRK-008) — cible EFFECTIVE, clampée EXACTEMENT comme dans `requestChange`.
    //
    // `desiredFixIntervalS` avait deux auteurs et un seul bornait ce qu'il écrivait :
    // `requestChange` clampait à [20, 300], l'auto-alignement inscrivait l'observé BRUT.
    // Des cibles à 1 s, 2 s, 8 s se sont ainsi installées en base — sous le minimum matériel
    // du Coban GPS403D (20 s). Un boîtier émettant à sa cadence normale se retrouvait alors
    // hors bande en permanence, donc FAILING, donc réaligné plus bas encore : 72 commandes
    // par jour, 100 % en échec, pendant des mois.
    //
    // Clamper ICI neutralise immédiatement les cibles héritées, sans migration de données ni
    // attente d'un changement d'état. Une cible que le matériel ne peut pas tenir ne doit
    // servir à condamner personne.
    const targetS = Math.min(Math.max(HARD_CAP_MIN_S, tracker.desiredFixIntervalS), HARD_CAP_S);
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

    // V1.19 (TRK-008) — ÉMETTRE PLUS VITE QUE DEMANDÉ, EN MOUVEMENT, N'EST PAS UNE FAUTE.
    //
    // Symétrique de la garde ci-dessus. En MOUVEMENT, la cible (20 s) vise la PRÉCISION du
    // suivi : un boîtier qui envoie davantage de positions donne mieux que ce qu'on a demandé,
    // il ne dégrade rien. Le compter en échec avait deux effets nuisibles — déclencher
    // l'auto-alignement (qui corrompait la cible) et faire cesser l'envoi de commandes, figeant
    // le boîtier dans cet état. C'est ce qui avait imposé d'abaisser le plancher
    // d'auto-alignement à 1 s en V1.15, d'où toute la dérive.
    //
    // ⚠️ RESTREINT AU MOUVEMENT, volontairement. À l'ARRÊT, la cible (300 s) vise l'ÉCONOMIE
    // de batterie et de données : un boîtier qui émet plus vite y contrevient réellement, et
    // doit continuer d'être signalé. Une garde non restreinte aurait silencieusement annulé
    // cette économie — ce que trois tests de ce module vérifient depuis l'origine.
    //
    // L'information n'est pas perdue : la cadence réelle reste écrite dans
    // `currentFixIntervalS` et s'affiche sur la fiche. On cesse de la qualifier de panne.
    if (observedS < lower && movingNow) {
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
   *
   * `sent` dit si la commande a REELLEMENT quitte le serveur (write TCP accepte ou SMS
   * accepte par la passerelle). Un `commandId` est aussi renvoye quand l'envoi echoue —
   * la ligne existe alors en FAILED pour l'audit. Sans ce drapeau, l'appelant ne pouvait
   * pas distinguer « commande partie » de « ligne ecrite puis marquee FAILED », et
   * setManualOverride en tirait la conclusion inverse de la realite (cf. plus bas).
   */
  async requestChange(
    tracker: Tracker & { vehicle: (Vehicle & { fleet: Fleet }) | null },
    desiredS: number,
    reason: string,
    contextSnapshot: Record<string, unknown>,
    options?: { force?: boolean },
  ): Promise<{ commandId: string; sent: boolean } | null> {
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
    // à nouveau l'intervalle attendu (reconcile remet failureCount a 0).
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
    // TRK-012 — deux canaux, deux grammaires. La socket TCP reçoit `**,imei:<IMEI>,C,05m;`
    // (fréquence sur DEUX chiffres, fidèle à Traccar) ; le repli SMS garde la forme texte
    // `fix005m***n123456`, la seule que le firmware lit dans un SMS.
    const payloadTcp = template.buildTcpPayload
      ? template.buildTcpPayload(tracker.imei, { interval })
      : template.buildPayload(tracker.imei, { interval });
    const payloadSms = template.buildPayload(tracker.imei, { interval });

    // Persist command + snapshot before any wire IO.
    const command = await this.prisma.trackerCommand.create({
      data: {
        trackerId: tracker.id,
        templateId: 'fix_continuous',
        category: 'reporting',
        params: { interval } as object,
        payload: payloadTcp,
        channel: 'TCP',
        status: TrackerCommandStatus.PENDING,
        requestedBy: SYSTEM_USER_ID,
        outcomeReason: reason,
        expectedResult: `intervalle ~${target}s observe sur les 3 prochaines trames`,
        contextSnapshot: contextSnapshot as object,
      },
    });

    // Send via TCP socket (canal descendant deja ouvert par le boitier).
    const sent = this.registry.send(tracker.imei, payloadTcp);
    const diagnosticHint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: sent,
      failureCount: tracker.fixCommandFailureCount,
      lastSeenAt: tracker.lastSeenAt,
      lastValidFrameAt: tracker.lastValidFrameAt,
      desiredIntervalS: target,
    });

    if (!sent) {
      // Tentative fallback SMS si tracker offline > 5min ET simPhoneNumber connu.
      // `force` traverse la porte « boitier muet » du repli : un override admin explicite
      // reste autorise a sonder un boitier silencieux, l'automate non.
      const smsSent = await this.tryFallbackSms(tracker, payloadSms, command.id, force);
      if (smsSent) {
        await this.prisma.trackerCommand.update({
          where: { id: command.id },
          data: {
            status: TrackerCommandStatus.SENT,
            sentAt: new Date(),
            channel: 'SMS',
            // TRK-012 — la ligne d'audit porte la trame RÉELLEMENT partie : créée avec
            // l'enveloppe TCP, la commande a finalement pris le canal SMS.
            payload: payloadSms,
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
        return { commandId: command.id, sent: true };
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
      return { commandId: command.id, sent: false };
    }

    await this.prisma.trackerCommand.update({
      where: { id: command.id },
      data: {
        status: TrackerCommandStatus.SENT,
        sentAt: new Date(),
        diagnosticHint,
      },
    });

    this.wireLogger.out(tracker.imei, payloadTcp, {
      commandId: command.id,
      source: 'fix-mode-adaptive',
    });

    // TRK-014 — écouter la réponse du boîtier. Ce chemin ne l'a JAMAIS fait.
    this.armAckListener(tracker.imei, command.id, template);

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

    return { commandId: command.id, sent: true };
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
  ): Promise<{
    overrideUntil: string | null;
    commandId: string | null;
    /** L'indicateur FAILING n'est efface que si la commande est REELLEMENT partie. */
    failingCleared: boolean;
  }> {
    const overrideUntil = untilMinutes > 0 ? new Date(Date.now() + untilMinutes * 60 * 1000) : null;

    // L'override lui-meme est la decision de l'admin : on la pose TOUJOURS, en premier.
    //
    // ⚠️ On n'efface PLUS `fixCommandFailing`/`fixCommandFailureCount` ICI. Avant, les
    // deux etaient remis a zero AVANT meme de savoir si une commande partait : un boitier
    // au fond d'un parking (socket fermee, pas de SIM) voyait son indicateur d'echec
    // disparaitre alors que RIEN n'avait ete envoye ni corrige. L'alerte s'eteignait
    // toute seule, le boitier restait muet, et plus personne ne le voyait.
    //
    // Ce reset n'a jamais ete necessaire pour debloquer l'envoi : requestChange est
    // appele juste en dessous avec `force: true`, qui court-circuite deja la garde
    // FAILING. L'acquittement explicite « j'ai verifie, c'est regle » garde son chemin
    // dedie : POST /admin/alerts/trackers/:id/clear-failing.
    await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { fixModeOverrideUntil: overrideUntil },
    });

    let commandId: string | null = null;
    let failingCleared = false;
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

        // Le compteur d'echecs ne retombe a zero que si la commande a REELLEMENT quitte
        // le serveur. Un `commandId` seul ne suffit pas : la ligne existe aussi quand
        // l'envoi a echoue (elle est alors persistee en FAILED). C'est exactement le cas
        // qui effacait l'alerte a tort. Si le boitier continue d'ignorer la consigne,
        // reconcile() remontera le compteur tout seul aux trames suivantes.
        if (out?.sent) {
          await this.prisma.tracker.update({
            where: { id: trackerId },
            data: { fixCommandFailing: false, fixCommandFailureCount: 0 },
          });
          failingCleared = true;
        }
      }
    }

    return {
      overrideUntil: overrideUntil ? overrideUntil.toISOString() : null,
      commandId,
      failingCleared,
    };
  }
}
