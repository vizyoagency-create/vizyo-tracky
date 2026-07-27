import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { DORMANT_STOP_COUNTING_MS, formatSilenceLabel, isVehicleDormant } from '@vizyo/tracky-shared';
import { WebPushService } from '../notifications/web-push.service';
import { ErrorLogger } from '../observability/error-logger.service';
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
    private readonly errorLogger: ErrorLogger,
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
      this.errorLogger.recordBackground(err instanceof Error ? err : new Error(String(err)), 'cron:maintenance-reminder');
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    // `tracker.lastSeenAt` est joint à la requête des plans (aucune requête en plus) : il sert à
    // repérer les échéances KILOMÉTRIQUES devenues inévaluables (cf. plus bas).
    const plans = await this.prisma.maintenancePlan.findMany({
      where: { enabled: true },
      include: { vehicle: { select: { plate: true, tracker: { select: { id: true, lastSeenAt: true } } } } },
    });
    const now = Date.now();
    let notified = 0;
    let unevaluable = 0;
    for (const plan of plans) {
      // 1) Visible : (re)matérialise l'échéance en VehicleEvent PLANNED.
      await this.plans.materializePlannedEvent(plan);

      // Calculé UNE fois et partagé par les deux volets ci-dessous (km inévaluable, puis préavis
      // calendaire) : `computeNextDue` est pur, mais il porte la règle « qu'est-ce qui est
      // réellement dû » — la dupliquer ici ferait diverger le diagnostic de la notification.
      const { nextDueAt, nextDueKm } = this.plans.computeNextDue(plan);

      // 1 bis) ÉCHÉANCE KILOMÉTRIQUE INÉVALUABLE.
      //
      // « Vidange tous les 15 000 km » se règle sur le kilométrage du véhicule. Quand le boîtier
      // est muet depuis plus de 7 jours, plus aucun kilomètre ne remonte : personne ne peut plus
      // dire si l'échéance est passée, et le silence du cron ressemble à s'y méprendre à « rien à
      // signaler ». On journalise donc explicitement le fait, plutôt que de laisser un plan MUET
      // passer pour un plan SAIN — c'est la différence entre un entretien à jour et un entretien
      // oublié. Le cas qui coûte cher est le boîtier mort sur un véhicule qui ROULE encore : les
      // km s'accumulent hors radar, et c'est précisément là qu'on ne veut pas se taire.
      //
      // On ne touche PAS au volet calendaire : un contrôle technique daté reste dû et notifié,
      // que le boîtier parle ou non (l'obligation est légale, pas télématique).
      //
      // ⚠️ Condition sur `nextDueKm`, PAS sur `plan.intervalKm` : un plan qui porte un intervalle
      // km mais aucun `lastDoneKm` n'a AUCUNE échéance kilométrique calculable (cf.
      // `computeNextDue`), et ce n'est pas le boîtier qui manque, c'est le relevé de départ.
      // Accuser le silence du boîtier enverrait l'exploitant démonter un traceur alors qu'il
      // suffit de saisir le kilométrage du dernier entretien — tous les jours, indéfiniment.
      const tracker = plan.vehicle?.tracker ?? null;
      if (
        nextDueKm != null &&
        isVehicleDormant(
          { trackerId: tracker?.id ?? null, lastSeenAt: tracker?.lastSeenAt ?? null },
          now,
          // 7 j, EXPLICITEMENT. Le seuil « arrêter d'AGIR » (72 h) ne convient pas : on ne commande
          // rien ici, on constate. Écrit au lieu de reposer sur la valeur par défaut pour que le
          // seuil retenu se lise sur place — un changement de défaut ne doit pas pouvoir déplacer
          // en silence la frontière entre « garé le week-end » et « parc muet ».
          DORMANT_STOP_COUNTING_MS,
        )
      ) {
        unevaluable++;
        this.systemActivity.record({
          category: 'MAINTENANCE',
          action: 'maintenance_due_km_unevaluable',
          status: 'SKIPPED',
          actor: 'maintenance-cron',
          target: `${plan.vehicle?.plate ?? '?'} : ${plan.label}`,
          detail: `Echeance au kilometrage non evaluable — boitier muet depuis ${formatSilenceLabel(tracker?.lastSeenAt ?? null, now) ?? '?'}`,
          fleetId: plan.fleetId,
          // `nextDueKm` est le chiffre que l'exploitant doit comparer au compteur réel : sans lui,
          // l'entrée dit « quelque chose ne se calcule plus » sans dire quoi vérifier.
          meta: { vehicleId: plan.vehicleId, planId: plan.id, intervalKm: plan.intervalKm, nextDueKm },
        });
      }

      // 2) Notifié : échéance dans le préavis + pas déjà notifiée pour CETTE date.
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
    if (unevaluable > 0) {
      this.logger.warn(`[maintenance] ${unevaluable} echeance(s) au km non evaluable(s) (vehicule muet)`);
    }
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
