import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SurveillanceMode, UserRole } from '@prisma/client';
import {
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  isVehicleDormant,
} from '@vizyo/tracky-shared';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { isWithinSchedule } from './surveillance.helpers';
import type { ScheduleDay } from './surveillance.dto';
import { SurveillanceService } from './surveillance.service';

/**
 * Anti-flood du résumé « boîtiers muets ».
 *
 * Ce cron tourne CHAQUE minute et la dormance d'un boîtier dure des semaines : sans
 * palier, les 2 dormants observés en prod (FV-941-LZ, 89 j — FL-787-KV, 52 j)
 * écriraient 1440 lignes de log par jour pour répéter le même fait. Une fois par
 * heure suffit à rendre l'exclusion visible sans la noyer.
 */
const DORMANT_SUMMARY_THROTTLE_MS = 60 * 60 * 1000;

/** Nombre de véhicules cités nommément dans le résumé (le compte total, lui, est exact). */
const DORMANT_SUMMARY_MAX_SAMPLES = 5;

/**
 * V1.6 — Scheduler : arme/désarme automatiquement les profils selon leur mode.
 * Tourne toutes les minutes.
 *
 * Sémantique des modes :
 *   • OFF       : aucune action auto (le user peut quand même armer manuellement).
 *   • FULL_TIME : maintenir `currentlyArmed = true` en permanence (24/7).
 *   • SCHEDULED : armer/désarmer selon la plage horaire + jours actifs.
 *
 * Réutilise SurveillanceService.armProfile()/disarmProfile() pour profiter
 * de l'envoi de commandes Coban + audit + idempotence (même chemin que
 * l'armement manuel, juste avec source='scheduled').
 *
 * Erreurs par profil : on log et on continue — un tracker offline ne doit
 * pas bloquer les armements/désarmements des autres véhicules de la flotte.
 */
@Injectable()
export class SurveillanceSchedulerService {
  private readonly logger = new Logger(SurveillanceSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly surveillance: SurveillanceService,
    private readonly errorLogger: ErrorLogger,
    // Journal Système — module @Global, aucun import à ajouter au SurveillanceModule.
    private readonly systemActivity: SystemActivityService,
  ) {}

  private running = false;

  /** Dernier résumé « boîtiers muets » écrit — cf. DORMANT_SUMMARY_THROTTLE_MS. */
  private lastDormantSummaryAt = 0;

  /**
   * Dernière ligne de journal écrite PAR PROFIL — même palier horaire que le résumé.
   *
   * Clé = profile.id, borné par le nombre de profils actifs (37 en prod). Calque exact de
   * `SurveillanceService.lastScheduledFailureAt` : c'est la mécanique qu'on remplace ici.
   */
  private readonly lastDormantJournalAt = new Map<string, number>();

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    // Garde anti-chevauchement : si le tick précédent tourne encore (beaucoup de
    // profils × envoi SMS Coban), on saute ce tick plutôt que d'empiler des runs
    // concurrents (risque de saturation CPU/SMS). Le travail est repris au tick
    // suivant — l'état est ré-évalué depuis la DB, rien n'est perdu. Le try/catch
    // évite aussi qu'un échec de la requête globale ne rejette le cron.
    if (this.running) {
      this.logger.warn('[scheduler] tick précédent encore en cours — skip');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`[scheduler] run a échoué: ${err instanceof Error ? err.message : err}`);
      this.errorLogger.recordBackground(err instanceof Error ? err : new Error(String(err)), 'cron:surveillance');
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    // Sélectionne FULL_TIME et SCHEDULED — OFF est intentionnellement exclu :
    // pas d'auto-action mais le user peut toujours armer manuellement.
    const profiles = await this.prisma.surveillanceProfile.findMany({
      where: { mode: { in: [SurveillanceMode.FULL_TIME, SurveillanceMode.SCHEDULED] } },
      include: {
        vehicle: {
          select: {
            fleetId: true,
            plate: true,
            // Le boîtier est JOINT à la requête existante (aucune requête supplémentaire :
            // le VPS 2 vCPU est déjà saturé). `lastSeenAt` est la seule source de dormance —
            // ni Trip/Position (vides en mode vie privée alors que le boîtier parle), ni
            // `Tracker.status` (colonne collante, jamais remise à OFFLINE).
            tracker: { select: { id: true, lastSeenAt: true } },
          },
        },
      },
    });

    if (profiles.length === 0) return;

    const now = new Date();
    let armedCount = 0;
    let disarmedCount = 0;
    let errors = 0;
    let dormantSkipped = 0;
    const dormantSamples: string[] = [];

    for (const profile of profiles) {
      // ─── PORTE « BOÎTIER MUET » (seuil AGIR = 72 h) ───────────────────────────
      // Cas réel : FV-941-LZ, profil antivol actif, boîtier muet depuis 89 jours.
      // Chaque minute ce tick appelait armProfile() → TrackerCommandsService.request()
      // créait une ligne `tracker_commands` PENDING, échouait (« Tracker offline »),
      // la repassait FAILED puis levait. `currentlyArmed` restant à false, le tick
      // suivant recommençait : ~1440 lignes mortes/jour et autant de passages au
      // centre d'alertes, pour un boîtier dont on SAIT déjà qu'il ne répondra pas.
      //
      // 72 h : un boîtier alimenté émet au moins toutes les ~300 s même à l'arrêt ;
      // 72 h de silence total = batterie débranchée, SIM coupée ou boîtier déposé —
      // jamais un simple stationnement. On sort AVANT toute écriture : aucune ligne,
      // aucune alerte, aucune facturation.
      //
      // On ne touche NI le profil NI `currentlyArmed` : rien n'est effacé, la fiche
      // reste consultable et l'état affiché reste le dernier état RÉELLEMENT connu du
      // boîtier (prétendre « désarmé » sur un boîtier injoignable serait un mensonge).
      // Dès la première trame reçue, `lastSeenAt` redevient frais et le tick suivant
      // reprend l'armement tout seul — aucun drapeau, aucune réactivation manuelle.
      const tracker = profile.vehicle?.tracker ?? null;
      if (
        isVehicleDormant(
          { trackerId: tracker?.id, lastSeenAt: tracker?.lastSeenAt },
          now.getTime(),
          DORMANT_STOP_ACTING_MS,
        )
      ) {
        dormantSkipped++;
        const silence = formatSilenceLabel(tracker?.lastSeenAt, now.getTime());
        if (dormantSamples.length < DORMANT_SUMMARY_MAX_SAMPLES) {
          dormantSamples.push(`${profile.vehicle?.plate ?? profile.vehicleId} (muet depuis ${silence})`);
        }
        // JOURNAL SYSTÈME — la seule surface où l'exploitant VOIT ce qui se passe.
        // Avant cette porte, chaque tentative ratée écrivait une ligne SURVEILLANCE
        // FAILURE (« Armement échoué : Tracker hors ligne »), déjà limitée à 1/h par
        // profil côté SurveillanceService. Se contenter d'un log Docker ferait
        // DISPARAÎTRE de l'écran un antivol qui n'arme plus : l'exploitant croirait son
        // véhicule protégé. On remplace donc l'échec par un SKIPPED explicite, au même
        // palier horaire et par profil — même flotte, même véhicule, même lisibilité.
        const lastJournalAt = this.lastDormantJournalAt.get(profile.id) ?? 0;
        if (now.getTime() - lastJournalAt >= DORMANT_SUMMARY_THROTTLE_MS) {
          this.lastDormantJournalAt.set(profile.id, now.getTime());
          this.systemActivity.record({
            category: 'SURVEILLANCE',
            // Action NEUTRE, et non `surveillance_armed`/`_disarmed` : on ne sait pas — et on
            // n'a pas à deviner — laquelle des deux aurait été due cette minute-là. Une action
            // inconnue de l'UI n'affiche simplement aucun badge (cf. sysActionBadge) ; la ligne
            // reste lisible : « Surveillance · ignoré · FV-941-LZ · … ».
            action: 'surveillance_skipped_dormant',
            status: 'SKIPPED',
            actor: 'planning',
            target: profile.vehicle?.plate ?? profile.vehicleId,
            detail:
              `Antivol non piloté — boîtier muet depuis ${silence} : le planificateur n'arme ni ne désarme ` +
              `ce véhicule (l'état affiché est le dernier réellement connu ; reprise automatique dès la première trame).`,
            fleetId: profile.fleetId,
            meta: {
              profileId: profile.id,
              vehicleId: profile.vehicleId,
              silence,
              currentlyArmed: profile.currentlyArmed,
              reason: 'tracker_dormant',
            },
          });
        }
        continue;
      }

      // Détermine si on doit être armé maintenant selon le mode.
      let shouldBeArmed: boolean;
      if (profile.mode === SurveillanceMode.FULL_TIME) {
        shouldBeArmed = true;
      } else {
        // SCHEDULED : on doit avoir des horaires définis.
        if (!profile.scheduleStartTime || !profile.scheduleEndTime) continue;
        const days = (profile.scheduleDays as ScheduleDay[] | null) ?? null;
        shouldBeArmed = isWithinSchedule(
          now,
          profile.scheduleStartTime,
          profile.scheduleEndTime,
          days,
        );
      }

      const requestedBy = {
        userId: profile.createdBy,
        role: UserRole.SUPER_ADMIN, // bypass des contrôles RBAC pour les actions système
        fleetId: profile.fleetId,
      };

      try {
        if (shouldBeArmed && !profile.currentlyArmed) {
          await this.surveillance.armProfile(profile, requestedBy, 'scheduled');
          armedCount++;
        } else if (!shouldBeArmed && profile.currentlyArmed) {
          await this.surveillance.disarmProfile(profile, requestedBy, 'scheduled');
          disarmedCount++;
        }
      } catch (err) {
        errors++;
        this.logger.warn(
          `[scheduler] profile ${profile.id} (vehicle=${profile.vehicleId}) failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
        this.errorLogger.recordBackground(
          err instanceof Error ? err : new Error(String(err)),
          'cron:surveillance',
          { profileId: profile.id, vehicleId: profile.vehicleId, fleetId: profile.fleetId },
        );
      }
    }

    if (armedCount > 0 || disarmedCount > 0 || errors > 0) {
      this.logger.log(
        `[scheduler] tick : armed=${armedCount} disarmed=${disarmedCount} errors=${errors} dormants=${dormantSkipped} / ${profiles.length} profiles`,
      );
    }

    // On EXCLUT, donc on COMPTE et on EXPOSE. Deux surfaces complémentaires : le journal
    // Système ci-dessus (par véhicule, visible à l'écran, c'est celle qui compte pour
    // l'exploitant) et ce résumé chiffré, destiné à l'exploitation (`docker logs`) pour
    // voir d'un coup d'œil combien de profils sont en attente. Écrit au plus une fois par
    // heure — le fait, lui, dure des semaines.
    if (dormantSkipped > 0 && Date.now() - this.lastDormantSummaryAt >= DORMANT_SUMMARY_THROTTLE_MS) {
      this.lastDormantSummaryAt = Date.now();
      const suffix = dormantSkipped > dormantSamples.length ? ', …' : '';
      this.logger.warn(
        `[scheduler] ${dormantSkipped} profil(s) non armés/désarmés — boîtier muet > 72 h : ${dormantSamples.join(', ')}${suffix}`,
      );
    }
  }
}
