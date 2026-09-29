import { ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { MaintenancePlan, Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type { MaintenancePlanDto, RecordMaintenanceDoneDto, UpsertMaintenancePlanDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { formatFleetDate } from '../common/utils/datetime';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleEventsService } from './vehicle-events.service';

type PlanRow = MaintenancePlan;

/** Ce qu'un plan « dit » dans le journal : son rythme et sa dernière réalisation. */
type EtatPlan = Pick<
  PlanRow,
  'label' | 'category' | 'intervalMonths' | 'intervalKm' | 'lastDoneAt' | 'lastDoneKm' | 'reminderDaysBefore' | 'reminderKmBefore' | 'enabled'
>;

/** « tous les 12 mois ou 20 000 km » — ce que lit un exploitant, sans champ technique. */
function rythme(p: Pick<PlanRow, 'intervalMonths' | 'intervalKm'>): string {
  const parts: string[] = [];
  if (p.intervalMonths) parts.push(`${p.intervalMonths} mois`);
  if (p.intervalKm) parts.push(`${p.intervalKm.toLocaleString('fr-FR')} km`);
  return parts.length > 0 ? `tous les ${parts.join(' ou ')}` : 'sans rythme';
}

/** Les champs changés d'un plan, en clair (« rythme tous les 12 mois → tous les 6 mois »). */
function changementsPlan(avant: EtatPlan, apres: EtatPlan): string[] {
  const out: string[] = [];
  if (avant.label !== apres.label) out.push(`nom « ${avant.label} » → « ${apres.label} »`);
  if (avant.intervalMonths !== apres.intervalMonths || avant.intervalKm !== apres.intervalKm) {
    out.push(`rythme ${rythme(avant)} → ${rythme(apres)}`);
  }
  const fait = (p: EtatPlan) =>
    p.lastDoneAt ? `${formatFleetDate(p.lastDoneAt)}${p.lastDoneKm != null ? ` à ${p.lastDoneKm.toLocaleString('fr-FR')} km` : ''}` : 'jamais';
  if ((avant.lastDoneAt?.getTime() ?? null) !== (apres.lastDoneAt?.getTime() ?? null) || avant.lastDoneKm !== apres.lastDoneKm) {
    out.push(`dernier entretien ${fait(avant)} → ${fait(apres)}`);
  }
  if (avant.reminderDaysBefore !== apres.reminderDaysBefore || avant.reminderKmBefore !== apres.reminderKmBefore) out.push('rappel modifié');
  if (avant.category !== apres.category) out.push(`catégorie ${avant.category} → ${apres.category}`);
  if (avant.enabled !== apres.enabled) out.push(apres.enabled ? 'réactivé' : 'désactivé');
  return out;
}

/** Marqueur "système" pour createdBy des événements auto-générés (pas de FK, simple traçabilité). */
const SYSTEM_UUID = '00000000-0000-0000-0000-000000000000';

function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  r.setMonth(r.getMonth() + months);
  return r;
}

/**
 * Sprint 7 — Plans de maintenance récurrents (CT/vidange « tous les X mois/km »). Chaque plan
 * GÉNÈRE un `VehicleEvent` PLANNED reflétant la prochaine échéance (matérialisation idempotente),
 * visible dans l'agenda. Scoping délégué à `VehicleEventsService.assertVehicleAccess`.
 */
@Injectable()
export class MaintenancePlansService {
  private readonly logger = new Logger(MaintenancePlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: VehicleEventsService,
    // Journal métier (29/09, @Global) — en dernier et @Optional : sans lui, rien ne casse.
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {}

  /**
   * Une ligne `plan_entretien_modifie` (catégorie AGENDA) sur la société DU PLAN — jamais celle de
   * l'utilisateur. La plaque est relue à part (le plan n'en porte pas) et une lecture qui échoue
   * laisse la ligne sans plaque : le journal ne fait jamais échouer le geste qu'il trace.
   */
  private async journaliser(
    user: AuthUser,
    plan: Pick<PlanRow, 'id' | 'fleetId' | 'vehicleId' | 'label'>,
    operation: 'cree' | 'modifie' | 'supprime' | 'fait',
    detail: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.systemActivity) return;
    try {
      let plate: string | null = null;
      try {
        const v = await this.prisma.vehicle.findUnique({ where: { id: plan.vehicleId }, select: { plate: true } });
        plate = v?.plate ?? null;
      } catch {
        plate = null;
      }
      this.systemActivity.record({
        category: 'AGENDA',
        action: 'plan_entretien_modifie',
        actor: 'utilisateur',
        target: plate,
        detail,
        fleetId: plan.fleetId,
        triggeredByUserId: user.id,
        meta: { planId: plan.id, vehicleId: plan.vehicleId, operation, ...meta },
      });
    } catch (e) {
      this.logger.warn(`journal plan d'entretien non écrit : ${(e as Error)?.message ?? e}`);
    }
  }

  async list(user: AuthUser, vehicleId?: string): Promise<MaintenancePlanDto[]> {
    const where: Prisma.MaintenancePlanWhereInput = {};
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      where.fleetId = user.fleetId;
    }
    if (vehicleId) {
      await this.events.assertVehicleAccess(user, vehicleId);
      where.vehicleId = vehicleId;
    }
    const rows = await this.prisma.maintenancePlan.findMany({ where, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  async upsert(user: AuthUser, id: string | null, dto: UpsertMaintenancePlanDto): Promise<MaintenancePlanDto> {
    const fleetId = await this.events.assertVehicleAccess(user, dto.vehicleId);
    const data = {
      category: dto.category,
      label: dto.label.trim(),
      intervalMonths: dto.intervalMonths ?? null,
      intervalKm: dto.intervalKm ?? null,
      lastDoneAt: dto.lastDoneAt ? new Date(dto.lastDoneAt) : null,
      lastDoneKm: dto.lastDoneKm ?? null,
      reminderDaysBefore: dto.reminderDaysBefore ?? 30,
      reminderKmBefore: dto.reminderKmBefore ?? null,
      enabled: dto.enabled ?? true,
    };
    let plan: PlanRow;
    let avant: PlanRow | null = null;
    if (id) {
      avant = await this.loadScoped(user, id);
      plan = await this.prisma.maintenancePlan.update({ where: { id }, data });
    } else {
      plan = await this.prisma.maintenancePlan.create({ data: { ...data, fleetId, vehicleId: dto.vehicleId } });
    }
    await this.materializePlannedEvent(plan);
    const echeance = this.echeanceLisible(plan);
    if (avant) {
      const changes = changementsPlan(avant, plan);
      // Un enregistrement sans changement n'est pas un geste à relire : pas de ligne.
      if (changes.length > 0) {
        await this.journaliser(user, plan, 'modifie', `Plan d'entretien « ${plan.label} » modifié — ${changes.join(' ; ')}${echeance}`, {
          avant: this.etatJournal(avant),
          apres: this.etatJournal(plan),
        });
      }
    } else {
      await this.journaliser(user, plan, 'cree', `Plan d'entretien « ${plan.label} » créé — ${rythme(plan)}${echeance}`, {
        apres: this.etatJournal(plan),
      });
    }
    return this.toDto(plan);
  }

  async remove(user: AuthUser, id: string): Promise<{ ok: true }> {
    const plan = await this.loadScoped(user, id);
    await this.prisma.maintenancePlan.delete({ where: { id } });
    await this.journaliser(user, plan, 'supprime', `Plan d'entretien « ${plan.label} » supprimé (${rythme(plan)})`, {
      avant: this.etatJournal(plan),
    });
    return { ok: true };
  }

  /** « · prochaine échéance le 05/10/2026 » (heure de Paris), ou rien si le plan n'en calcule pas. */
  private echeanceLisible(plan: PlanRow): string {
    const { nextDueAt, nextDueKm } = this.computeNextDue(plan);
    const parts: string[] = [];
    if (nextDueAt) parts.push(`le ${formatFleetDate(nextDueAt)}`);
    if (nextDueKm != null) parts.push(`à ${nextDueKm.toLocaleString('fr-FR')} km`);
    return plan.enabled && parts.length > 0 ? ` · prochaine échéance ${parts.join(' ou ')}` : '';
  }

  /** L'état d'un plan pour `meta` (machine) : dates ISO, valeurs brutes. */
  private etatJournal(p: EtatPlan): Record<string, unknown> {
    return {
      label: p.label,
      category: p.category,
      intervalMonths: p.intervalMonths,
      intervalKm: p.intervalKm,
      lastDoneAt: p.lastDoneAt ? p.lastDoneAt.toISOString() : null,
      lastDoneKm: p.lastDoneKm,
      enabled: p.enabled,
    };
  }

  /** Enregistre un entretien réalisé : VehicleEvent DONE + MAJ du plan (lastDone) + re-matérialise. */
  async recordDone(user: AuthUser, id: string, body: RecordMaintenanceDoneDto): Promise<MaintenancePlanDto> {
    const plan = await this.loadScoped(user, id);
    const doneAt = body.doneAt ? new Date(body.doneAt) : new Date();
    const doneKm = body.doneKm ?? null;
    await this.prisma.vehicleEvent.create({
      data: {
        fleetId: plan.fleetId,
        vehicleId: plan.vehicleId,
        type: VehicleEventType.MAINTENANCE,
        category: plan.category,
        status: VehicleEventStatus.DONE,
        title: plan.label,
        description: body.note ?? null,
        startAt: doneAt,
        allDay: true,
        odometerKm: doneKm,
        planId: plan.id,
        resolvedAt: doneAt,
        createdBy: user.id,
        source: 'MANUAL',
      },
    });
    const updated = await this.prisma.maintenancePlan.update({
      where: { id },
      data: { lastDoneAt: doneAt, lastDoneKm: doneKm ?? undefined },
    });
    if (doneKm != null) {
      // Passe par le garde non-régressif (ne recule jamais le baseline km).
      await this.events.maybeUpdateOdometer(plan.vehicleId, doneKm, doneAt).catch(() => undefined);
    }
    await this.materializePlannedEvent(updated);
    await this.journaliser(
      user,
      updated,
      'fait',
      `Entretien « ${plan.label} » fait le ${formatFleetDate(doneAt)}` +
        (doneKm != null ? ` à ${doneKm.toLocaleString('fr-FR')} km` : '') +
        this.echeanceLisible(updated),
      { doneAt: doneAt.toISOString(), doneKm, avant: this.etatJournal(plan), apres: this.etatJournal(updated) },
    );
    return this.toDto(updated);
  }

  computeNextDue(plan: {
    intervalMonths: number | null;
    intervalKm: number | null;
    lastDoneAt: Date | null;
    lastDoneKm: number | null;
  }): { nextDueAt: Date | null; nextDueKm: number | null } {
    const nextDueAt = plan.intervalMonths && plan.lastDoneAt ? addMonths(plan.lastDoneAt, plan.intervalMonths) : null;
    const nextDueKm = plan.intervalKm && plan.lastDoneKm != null ? plan.lastDoneKm + plan.intervalKm : null;
    return { nextDueAt, nextDueKm };
  }

  /** Garantit qu'UN VehicleEvent PLANNED reflète la prochaine échéance du plan (idempotent). */
  async materializePlannedEvent(plan: PlanRow): Promise<void> {
    const { nextDueAt } = this.computeNextDue(plan);
    const existing = await this.prisma.vehicleEvent.findFirst({
      where: { planId: plan.id, status: VehicleEventStatus.PLANNED },
      select: { id: true },
    });
    if (!plan.enabled || !nextDueAt) {
      if (existing) await this.prisma.vehicleEvent.delete({ where: { id: existing.id } });
      return;
    }
    if (existing) {
      await this.prisma.vehicleEvent.update({
        where: { id: existing.id },
        data: { startAt: nextDueAt, title: plan.label, category: plan.category },
      });
    } else {
      await this.prisma.vehicleEvent.create({
        data: {
          fleetId: plan.fleetId,
          vehicleId: plan.vehicleId,
          type: VehicleEventType.MAINTENANCE,
          category: plan.category,
          status: VehicleEventStatus.PLANNED,
          title: plan.label,
          startAt: nextDueAt,
          allDay: true,
          planId: plan.id,
          createdBy: SYSTEM_UUID,
          source: 'AUTO',
        },
      });
    }
  }

  private async loadScoped(user: AuthUser, id: string): Promise<PlanRow> {
    const plan = await this.prisma.maintenancePlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan introuvable');
    await this.events.assertVehicleAccess(user, plan.vehicleId);
    return plan;
  }

  toDto(p: PlanRow): MaintenancePlanDto {
    const { nextDueAt, nextDueKm } = this.computeNextDue(p);
    return {
      id: p.id,
      fleetId: p.fleetId,
      vehicleId: p.vehicleId,
      category: p.category,
      label: p.label,
      intervalMonths: p.intervalMonths,
      intervalKm: p.intervalKm,
      lastDoneAt: p.lastDoneAt?.toISOString() ?? null,
      lastDoneKm: p.lastDoneKm,
      reminderDaysBefore: p.reminderDaysBefore,
      reminderKmBefore: p.reminderKmBefore,
      enabled: p.enabled,
      nextDueAt: nextDueAt?.toISOString() ?? null,
      nextDueKm,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}
