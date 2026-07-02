import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { WebPushService } from '../notifications/web-push.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { MaintenancePlansService } from './maintenance-plans.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function frDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * Sprint 7 — Rappels d'échéances de maintenance. Cron quotidien (7h) qui (1) re-matérialise
 * les prochaines échéances en VehicleEvent PLANNED (visibles dans l'agenda) et (2) notifie les
 * fleet-admins (web-push, infra existante) quand une échéance entre dans son préavis — une
 * seule fois par échéance (dédup via metadata de l'événement). Verrou anti-chevauchement.
 */
@Injectable()
export class MaintenanceReminderService {
  private readonly logger = new Logger(MaintenanceReminderService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MaintenancePlansService,
    private readonly webPush: WebPushService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  @Cron('0 0 7 * * *')
  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn('[maintenance] run precedent encore en cours — skip');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`[maintenance] run a echoue: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    const plans = await this.prisma.maintenancePlan.findMany({
      where: { enabled: true },
      include: { vehicle: { select: { plate: true } } },
    });
    let notified = 0;
    for (const plan of plans) {
      // 1) Visible : (re)matérialise l'échéance en VehicleEvent PLANNED.
      await this.plans.materializePlannedEvent(plan);

      // 2) Notifié : échéance dans le préavis + pas déjà notifiée pour CETTE date.
      const { nextDueAt } = this.plans.computeNextDue(plan);
      if (!nextDueAt) continue;
      const preavisStart = nextDueAt.getTime() - plan.reminderDaysBefore * DAY_MS;
      if (Date.now() < preavisStart) continue;

      const planned = await this.prisma.vehicleEvent.findFirst({
        where: { planId: plan.id, status: 'PLANNED' },
        select: { id: true, metadata: true },
      });
      const dueIso = nextDueAt.toISOString();
      const already =
        (planned?.metadata as { reminderNotifiedFor?: string } | null)?.reminderNotifiedFor === dueIso;
      if (already) continue;

      await this.notifyFleetAdmins(plan.fleetId, plan.vehicle?.plate ?? '?', plan.label, nextDueAt);
      notified++;
      if (planned) {
        await this.prisma.vehicleEvent.update({
          where: { id: planned.id },
          data: { metadata: { reminderNotifiedFor: dueIso } },
        });
      }
    }
    if (notified > 0) this.logger.log(`[maintenance] ${notified} rappel(s) d'echeance notifie(s)`);
  }

  private async notifyFleetAdmins(
    fleetId: string,
    plate: string,
    label: string,
    dueAt: Date,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { fleetId, role: UserRole.FLEET_ADMIN },
      select: { id: true },
    });
    const payload = {
      title: 'Maintenance a prevoir',
      body: `${plate} : ${label} prevu le ${frDate(dueAt)}`,
      severity: 'WARNING' as const,
      url: '/agenda',
      data: { kind: 'maintenance_due', fleetId },
    };
    const results = await Promise.all(
      admins.map((a) =>
        this.webPush.sendToUser(a.id, payload, fleetId).catch(() => ({ sent: 0, failed: 0 })),
      ),
    );
    // Angle mort : le rappel « tourne » mais PERSONNE ne le reçoit (flotte sans
    // FLEET_ADMIN, ou admins sans device push). La primitive push ne journalise
    // que les tentatives réelles → sans cette ligne, le raté serait invisible.
    if (admins.length === 0 || results.every((r) => r.sent === 0 && r.failed === 0)) {
      this.systemActivity.record({
        category: 'PUSH',
        action: 'maintenance_reminder_undelivered',
        status: admins.length === 0 ? 'FAILURE' : 'SKIPPED',
        actor: 'maintenance-cron',
        target: `${plate} : ${label}`,
        detail:
          admins.length === 0
            ? 'Aucun FLEET_ADMIN dans la flotte'
            : `${admins.length} admin(s) sans device push abonné`,
        fleetId,
        meta: { dueAt: dueAt.toISOString() },
      });
    }
  }
}
