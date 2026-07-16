import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SurveillanceMode, UserRole } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { isWithinSchedule } from './surveillance.helpers';
import type { ScheduleDay } from './surveillance.dto';
import { SurveillanceService } from './surveillance.service';

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
  ) {}

  private running = false;

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
      include: { vehicle: { select: { fleetId: true } } },
    });

    if (profiles.length === 0) return;

    const now = new Date();
    let armedCount = 0;
    let disarmedCount = 0;
    let errors = 0;

    for (const profile of profiles) {
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
        `[scheduler] tick : armed=${armedCount} disarmed=${disarmedCount} errors=${errors} / ${profiles.length} profiles`,
      );
    }
  }
}
