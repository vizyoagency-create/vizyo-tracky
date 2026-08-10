import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MaintenancePlan, Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type { MaintenancePlanDto, RecordMaintenanceDoneDto, UpsertMaintenancePlanDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleEventsService } from './vehicle-events.service';

type PlanRow = MaintenancePlan;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: VehicleEventsService,
  ) {}

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
    if (id) {
      await this.loadScoped(user, id);
      plan = await this.prisma.maintenancePlan.update({ where: { id }, data });
    } else {
      plan = await this.prisma.maintenancePlan.create({ data: { ...data, fleetId, vehicleId: dto.vehicleId } });
    }
    await this.materializePlannedEvent(plan);
    return this.toDto(plan);
  }

  async remove(user: AuthUser, id: string): Promise<{ ok: true }> {
    await this.loadScoped(user, id);
    await this.prisma.maintenancePlan.delete({ where: { id } });
    return { ok: true };
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
