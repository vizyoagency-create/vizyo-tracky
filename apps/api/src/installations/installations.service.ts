import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, UserRole } from '@prisma/client';
import type { InstallationPlan, InstallationTask } from '@prisma/client';
import type {
  CompleteInstallationTaskResultDto,
  InstallationPlanDto,
  InstallationPlanSummaryDto,
  InstallationTaskDto,
  InstallationTaskStatus,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import type { CompleteInstallationTaskDto } from './dto/complete-installation-task.dto';
import type { CreateInstallationPlanDto } from './dto/create-installation-plan.dto';
import type { ReorderInstallationTasksDto } from './dto/reorder-tasks.dto';
import type { UpdateInstallationPlanDto } from './dto/update-installation-plan.dto';
import type { UpsertInstallationTaskDto } from './dto/upsert-installation-task.dto';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/** Statuts d'un plan visibles cote client (FLEET_ADMIN). DRAFT/CANCELLED = caches. */
const CLIENT_VISIBLE_STATUSES: Prisma.InstallationPlanWhereInput['status'] = {
  in: ['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'],
};

const IMEI_REGEX = /^\d{15}$/;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

type PlanWithTasks = InstallationPlan & { tasks: InstallationTask[] };

/**
 * V1.15 — Service Plannings d'installation.
 *
 * Acces (par role, pas par permission — FLEET_ADMIN bypasse les permissions) :
 * - SUPER_ADMIN : gestion complete, voit tous les plans.
 * - FLEET_ADMIN : voit les plans PUBLISHED+ de SA flotte (lecture) et peut
 *   reordonner le sens d'installation (reorderTasks).
 * Le controller gate les routes par @Roles ; le service re-filtre par fleetId.
 */
@Injectable()
export class InstallationsService {
  private readonly logger = new Logger(InstallationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ---- Lecture ----

  async list(rb: RequestedBy): Promise<InstallationPlanSummaryDto[]> {
    const plans = await this.prisma.installationPlan.findMany({
      where: this.planWhereForRead(rb),
      orderBy: { createdAt: 'desc' },
      include: { tasks: { select: { status: true } } },
    });
    return plans.map((p) =>
      this.mapSummary(p, p.tasks.map((t) => t.status as InstallationTaskStatus)),
    );
  }

  async findOne(id: string, rb: RequestedBy): Promise<InstallationPlanDto> {
    const plan = await this.prisma.installationPlan.findFirst({
      where: { id, ...this.planWhereForRead(rb) },
      include: { tasks: this.taskOrder() },
    });
    if (!plan) throw new NotFoundException('Planning introuvable');
    return this.mapPlan(plan);
  }

  // ---- Gestion plan (SUPER_ADMIN — gate au controller) ----

  async create(dto: CreateInstallationPlanDto): Promise<InstallationPlanDto> {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: dto.fleetId },
      select: { id: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable');

    const plan = await this.prisma.installationPlan.create({
      data: {
        fleetId: dto.fleetId,
        clientName: dto.clientName.trim(),
        clientAddress: dto.clientAddress?.trim() || null,
        description: dto.description?.trim() || null,
        startDate: this.parseDate(dto.startDate),
        endDate: this.parseDate(dto.endDate),
      },
      include: { tasks: this.taskOrder() },
    });
    return this.mapPlan(plan);
  }

  async update(id: string, dto: UpdateInstallationPlanDto): Promise<InstallationPlanDto> {
    await this.findManagedPlanOr404(id);

    const data: Prisma.InstallationPlanUpdateInput = {};
    if (dto.clientName !== undefined) data.clientName = dto.clientName.trim();
    if (dto.clientAddress !== undefined) data.clientAddress = dto.clientAddress?.trim() || null;
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.startDate !== undefined) data.startDate = this.parseDate(dto.startDate);
    if (dto.endDate !== undefined) data.endDate = this.parseDate(dto.endDate);
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.dayThemes !== undefined) {
      if (dto.dayThemes === null) {
        data.dayThemes = Prisma.DbNull;
      } else {
        for (const v of Object.values(dto.dayThemes)) {
          if (typeof v !== 'string') {
            throw new BadRequestException('dayThemes: les valeurs doivent être des chaînes');
          }
        }
        data.dayThemes = dto.dayThemes as Prisma.InputJsonValue;
      }
    }

    const plan = await this.prisma.installationPlan.update({
      where: { id },
      data,
      include: { tasks: this.taskOrder() },
    });
    return this.mapPlan(plan);
  }

  async remove(id: string): Promise<void> {
    await this.findManagedPlanOr404(id);
    // Cascade supprime les taches ; les Vehicle/Tracker provisionnes (FK SetNull
    // portee par la tache) ne sont PAS supprimes.
    await this.prisma.installationPlan.delete({ where: { id } });
  }

  // ---- Gestion taches (SUPER_ADMIN) ----

  async addTask(planId: string, dto: UpsertInstallationTaskDto): Promise<InstallationTaskDto> {
    await this.findManagedPlanOr404(planId);
    if (!dto.plate || !dto.plate.trim()) {
      throw new BadRequestException('Plaque requise');
    }
    let orderIndex = dto.orderIndex;
    if (orderIndex === undefined) {
      const max = await this.prisma.installationTask.aggregate({
        where: { planId },
        _max: { orderIndex: true },
      });
      orderIndex = (max._max.orderIndex ?? -1) + 1;
    }
    const task = await this.prisma.installationTask.create({
      data: {
        planId,
        orderIndex,
        scheduledDate: this.parseDate(dto.scheduledDate),
        plate: dto.plate.trim(),
        brand: dto.brand?.trim() || null,
        model: dto.model?.trim() || null,
        energy: dto.energy ?? null,
        firstRegistrationDate: this.parseDate(dto.firstRegistrationDate),
        cutoffProcedure: dto.cutoffProcedure?.trim() || null,
        status: dto.status ?? 'PENDING',
        imei: dto.imei?.trim() || null,
        simNumber: dto.simNumber?.trim() || null,
        fieldNotes: dto.fieldNotes?.trim() || null,
      },
    });
    await this.recomputePlanStatus(planId);
    return this.mapTask(task);
  }

  async updateTask(
    planId: string,
    taskId: string,
    dto: UpsertInstallationTaskDto,
  ): Promise<InstallationTaskDto> {
    await this.findManagedPlanOr404(planId);
    const existing = await this.prisma.installationTask.findFirst({ where: { id: taskId, planId } });
    if (!existing) throw new NotFoundException('Tâche introuvable');

    const data: Prisma.InstallationTaskUpdateInput = {};
    if (dto.orderIndex !== undefined) data.orderIndex = dto.orderIndex;
    if (dto.scheduledDate !== undefined) data.scheduledDate = this.parseDate(dto.scheduledDate);
    if (dto.plate !== undefined && dto.plate.trim()) data.plate = dto.plate.trim();
    if (dto.brand !== undefined) data.brand = dto.brand?.trim() || null;
    if (dto.model !== undefined) data.model = dto.model?.trim() || null;
    if (dto.energy !== undefined) data.energy = dto.energy ?? null;
    if (dto.firstRegistrationDate !== undefined) {
      data.firstRegistrationDate = this.parseDate(dto.firstRegistrationDate);
    }
    if (dto.cutoffProcedure !== undefined) data.cutoffProcedure = dto.cutoffProcedure?.trim() || null;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.fieldNotes !== undefined) data.fieldNotes = dto.fieldNotes?.trim() || null;
    if (dto.imei !== undefined) data.imei = dto.imei?.trim() || null;
    if (dto.simNumber !== undefined) data.simNumber = dto.simNumber?.trim() || null;

    const task = await this.prisma.installationTask.update({ where: { id: taskId }, data });

    // "Modifiable" : si la tache est deja provisionnee et qu'on touche IMEI/SIM,
    // on resynchronise le tracker lie.
    if (existing.trackerId && (dto.imei !== undefined || dto.simNumber !== undefined)) {
      await this.resyncTracker(existing.trackerId, task.imei, task.simNumber);
    }
    await this.recomputePlanStatus(planId);
    return this.mapTask(task);
  }

  async removeTask(planId: string, taskId: string): Promise<void> {
    await this.findManagedPlanOr404(planId);
    const existing = await this.prisma.installationTask.findFirst({
      where: { id: taskId, planId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Tâche introuvable');
    await this.prisma.installationTask.delete({ where: { id: taskId } });
    await this.recomputePlanStatus(planId);
  }

  // ---- Pose + provisioning ----

  async completeTask(
    planId: string,
    taskId: string,
    dto: CompleteInstallationTaskDto,
  ): Promise<CompleteInstallationTaskResultDto> {
    await this.findManagedPlanOr404(planId);
    const existing = await this.prisma.installationTask.findFirst({ where: { id: taskId, planId } });
    if (!existing) throw new NotFoundException('Tâche introuvable');
    if (!IMEI_REGEX.test(dto.imei)) {
      throw new BadRequestException('IMEI doit contenir exactement 15 chiffres');
    }

    const effStatus: InstallationTaskStatus = dto.status ?? 'DONE';
    const sim = dto.simNumber?.trim() || null;

    // 1) Capture (toujours conservee, meme si le provisioning echoue ensuite).
    await this.prisma.installationTask.update({
      where: { id: taskId },
      data: {
        status: effStatus,
        // On ne tamponne "posé le …" que si la pose est validée (DONE).
        installedAt: effStatus === 'DONE'
          ? (dto.installedAt ? new Date(dto.installedAt) : (existing.installedAt ?? new Date()))
          : existing.installedAt,
        imei: dto.imei.trim(),
        simNumber: sim,
        ...(dto.fieldNotes !== undefined ? { fieldNotes: dto.fieldNotes?.trim() || null } : {}),
      },
    });

    // 2) Provisioning auto (best-effort) uniquement si la pose est validee.
    let provisioned = false;
    let provisionError: string | null = null;
    if (effStatus === 'DONE') {
      try {
        await this.provisionTask(planId, taskId);
        provisioned = true;
      } catch (err) {
        provisionError = err instanceof Error ? err.message : 'Provisioning échoué';
        this.logger.warn(`Provisioning tâche ${taskId} échoué: ${provisionError}`);
      }
    }

    await this.recomputePlanStatus(planId);
    const task = await this.prisma.installationTask.findUniqueOrThrow({ where: { id: taskId } });
    return { task: this.mapTask(task), provisioned, provisionError };
  }

  /** Endpoint public (SUPER_ADMIN) — resync/retry manuel du provisioning. */
  async provision(planId: string, taskId: string): Promise<InstallationTaskDto> {
    await this.findManagedPlanOr404(planId);
    const r = await this.provisionTask(planId, taskId);
    await this.recomputePlanStatus(planId);
    return this.mapTask(r.task);
  }

  /**
   * Cree/lie le Vehicle + Tracker reels dans la flotte du plan, en une
   * transaction idempotente. Reutilise par cle naturelle (plaque/flotte, IMEI).
   */
  private async provisionTask(
    planId: string,
    taskId: string,
  ): Promise<{ task: InstallationTask; vehicleId: string; trackerId: string }> {
    const task = await this.prisma.installationTask.findFirst({
      where: { id: taskId, planId },
      include: { plan: { select: { fleetId: true } } },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    const imei = task.imei;
    if (!imei || !IMEI_REGEX.test(imei)) {
      throw new BadRequestException('IMEI (15 chiffres) requis avant le provisioning');
    }
    const sim = task.simNumber?.trim() || null;
    if (sim && !E164_REGEX.test(sim)) {
      throw new BadRequestException('SIM: format E.164 attendu (ex +33612345678)');
    }
    const fleetId = task.plan.fleetId;

    // Deja provisionnee : on resynchronise l'IMEI/SIM du tracker lie. La pose
    // reste ainsi "modifiable" — corriger le numero (IMEI/SIM) met a jour le
    // vrai tracker, et pas seulement la ligne de planning.
    if (task.vehicleId && task.trackerId) {
      await this.resyncTracker(task.trackerId, imei, sim);
      return { task, vehicleId: task.vehicleId, trackerId: task.trackerId };
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1) Vehicule : reutilise par id snape, sinon par (fleetId, plate), sinon cree.
        let vehicle = task.vehicleId
          ? await tx.vehicle.findUnique({ where: { id: task.vehicleId } })
          : await tx.vehicle.findUnique({ where: { fleetId_plate: { fleetId, plate: task.plate } } });
        if (!vehicle) {
          vehicle = await tx.vehicle.create({
            data: {
              fleetId,
              plate: task.plate,
              type: 'CAR',
              brand: task.brand ?? undefined,
              model: task.model ?? undefined,
              // Sprint 10 — synchro à la pose : le véhicule hérite l'énergie du planning.
              energy: task.energy ?? undefined,
            },
          });
        }

        // 2) Tracker : reutilise par id snape, sinon par imei, sinon cree.
        let tracker = task.trackerId
          ? await tx.tracker.findUnique({ where: { id: task.trackerId } })
          : await tx.tracker.findUnique({ where: { imei } });
        if (!tracker) {
          tracker = await tx.tracker.create({
            data: { imei, model: 'COBAN_GPS403D', simPhoneNumber: sim },
          });
        } else {
          if (tracker.vehicleId && tracker.vehicleId !== vehicle.id) {
            const other = await tx.vehicle.findUnique({
              where: { id: tracker.vehicleId },
              select: { plate: true },
            });
            throw new ConflictException(
              `IMEI ${imei} déjà assigné au véhicule ${other?.plate ?? tracker.vehicleId}`,
            );
          }
          // Sync IMEI (tracker snape obsolete) + SIM vers les valeurs de la tache.
          const data: Prisma.TrackerUpdateInput = {};
          if (tracker.imei !== imei) data.imei = imei;
          if (sim && tracker.simPhoneNumber !== sim) data.simPhoneNumber = sim;
          if (Object.keys(data).length > 0) {
            tracker = await tx.tracker.update({ where: { id: tracker.id }, data });
          }
        }

        // 3) Lier tracker -> vehicule (Tracker.vehicleId @unique).
        const vt = await tx.vehicle.findUnique({
          where: { id: vehicle.id },
          include: { tracker: { select: { id: true, imei: true } } },
        });
        if (vt?.tracker && vt.tracker.id !== tracker.id) {
          throw new ConflictException(
            `Le véhicule ${vehicle.plate} a déjà un tracker (${vt.tracker.imei})`,
          );
        }
        if (tracker.vehicleId !== vehicle.id) {
          tracker = await tx.tracker.update({
            where: { id: tracker.id },
            data: { vehicleId: vehicle.id },
          });
        }

        // 4) Ecrire les FK sur la tache.
        const updatedTask = await tx.installationTask.update({
          where: { id: task.id },
          data: {
            vehicleId: vehicle.id,
            trackerId: tracker.id,
            status: 'DONE',
            installedAt: task.installedAt ?? new Date(),
          },
        });
        return { task: updatedTask, vehicleId: vehicle.id, trackerId: tracker.id };
      });

      // Events APRES commit (sync allowlist vizyo-texto cf. trackers.service).
      this.eventEmitter.emit('tracker.assigned', { trackerId: result.trackerId, imei });
      if (sim) {
        this.eventEmitter.emit('tracker.sim-changed', { trackerId: result.trackerId, imei });
      }
      this.logger.log(`Tache ${taskId} provisionnee: vehicle=${result.vehicleId} tracker=${result.trackerId}`);
      return result;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Plaque ou IMEI déjà utilisés par un autre véhicule/tracker');
      }
      throw err;
    }
  }

  // ---- Reordonnancement (SUPER_ADMIN + FLEET_ADMIN de la flotte) ----

  async reorderTasks(
    planId: string,
    dto: ReorderInstallationTasksDto,
    rb: RequestedBy,
  ): Promise<InstallationPlanDto> {
    const plan = await this.prisma.installationPlan.findFirst({
      where: { id: planId, ...this.planWhereForRead(rb) },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('Planning introuvable');

    const ids = dto.tasks.map((t) => t.id);
    if (ids.length === 0) return this.findOne(planId, rb);
    const count = await this.prisma.installationTask.count({
      where: { planId, id: { in: ids } },
    });
    if (count !== ids.length) {
      throw new BadRequestException("Une tâche n'appartient pas à ce planning");
    }

    await this.prisma.$transaction(
      dto.tasks.map((t) =>
        this.prisma.installationTask.update({
          where: { id: t.id },
          data: {
            orderIndex: t.orderIndex,
            ...(t.scheduledDate !== undefined
              ? { scheduledDate: this.parseDate(t.scheduledDate) }
              : {}),
          },
        }),
      ),
    );
    return this.findOne(planId, rb);
  }

  // ---- Helpers ----

  private planWhereForRead(rb: RequestedBy): Prisma.InstallationPlanWhereInput {
    if (rb.role === UserRole.SUPER_ADMIN) return {};
    if (!rb.fleetId) return { id: '__none__' };
    return { fleetId: rb.fleetId, status: CLIENT_VISIBLE_STATUSES };
  }

  private async findManagedPlanOr404(id: string): Promise<void> {
    const plan = await this.prisma.installationPlan.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('Planning introuvable');
  }

  private taskOrder() {
    // En Postgres, ORDER BY ... ASC place les NULL en dernier par defaut :
    // les taches non planifiees (scheduledDate null) se retrouvent en fin.
    return {
      orderBy: [{ scheduledDate: 'asc' }, { orderIndex: 'asc' }],
    } satisfies Prisma.InstallationPlan$tasksArgs;
  }

  /** Resync IMEI/SIM du tracker lie apres edition de la tache. */
  private async resyncTracker(
    trackerId: string,
    imei: string | null,
    sim: string | null,
  ): Promise<void> {
    const tracker = await this.prisma.tracker.findUnique({ where: { id: trackerId } });
    if (!tracker) return;
    const data: Prisma.TrackerUpdateInput = {};
    let imeiChanged = false;
    let simChanged = false;
    if (imei && IMEI_REGEX.test(imei) && imei !== tracker.imei) {
      data.imei = imei;
      imeiChanged = true;
    }
    const normSim = sim?.trim() || null;
    if (normSim !== tracker.simPhoneNumber) {
      data.simPhoneNumber = normSim;
      simChanged = true;
    }
    if (!imeiChanged && !simChanged) return;
    try {
      const updated = await this.prisma.tracker.update({ where: { id: trackerId }, data });
      if (simChanged) {
        this.eventEmitter.emit('tracker.sim-changed', { trackerId, imei: updated.imei });
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('IMEI déjà utilisé par un autre tracker');
      }
      throw err;
    }
  }

  private async recomputePlanStatus(planId: string): Promise<void> {
    const plan = await this.prisma.installationPlan.findUnique({
      where: { id: planId },
      include: { tasks: { select: { status: true } } },
    });
    if (!plan) return;
    // Transitions auto uniquement entre PUBLISHED / IN_PROGRESS / COMPLETED.
    if (!['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'].includes(plan.status)) return;
    const total = plan.tasks.length;
    const done = plan.tasks.filter((t) => t.status === 'DONE').length;
    let next = plan.status;
    if (total > 0 && done >= total) next = 'COMPLETED';
    else if (done > 0) next = 'IN_PROGRESS';
    else next = 'PUBLISHED';
    if (next !== plan.status) {
      await this.prisma.installationPlan.update({ where: { id: planId }, data: { status: next } });
    }
  }

  private parseDate(value?: string | null): Date | null {
    if (!value) return null;
    // "YYYY-MM-DD" -> minuit UTC (colonne @db.Date, sans fuseau).
    return new Date(`${value}T00:00:00.000Z`);
  }

  private toIsoDate(d: Date | null): string | null {
    return d ? d.toISOString().slice(0, 10) : null;
  }

  private mapTask(t: InstallationTask): InstallationTaskDto {
    return {
      id: t.id,
      planId: t.planId,
      orderIndex: t.orderIndex,
      scheduledDate: this.toIsoDate(t.scheduledDate),
      plate: t.plate,
      brand: t.brand,
      model: t.model,
      energy: t.energy,
      firstRegistrationDate: this.toIsoDate(t.firstRegistrationDate),
      cutoffProcedure: t.cutoffProcedure,
      status: t.status,
      installedAt: t.installedAt ? t.installedAt.toISOString() : null,
      imei: t.imei,
      simNumber: t.simNumber,
      fieldNotes: t.fieldNotes,
      vehicleId: t.vehicleId,
      trackerId: t.trackerId,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private mapSummary(
    plan: InstallationPlan,
    statuses: InstallationTaskStatus[],
  ): InstallationPlanSummaryDto {
    return {
      id: plan.id,
      fleetId: plan.fleetId,
      clientName: plan.clientName,
      clientAddress: plan.clientAddress,
      description: plan.description,
      startDate: this.toIsoDate(plan.startDate),
      endDate: this.toIsoDate(plan.endDate),
      status: plan.status,
      doneCount: statuses.filter((s) => s === 'DONE').length,
      totalCount: statuses.length,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  private mapPlan(plan: PlanWithTasks): InstallationPlanDto {
    const tasks = plan.tasks ?? [];
    return {
      ...this.mapSummary(plan, tasks.map((t) => t.status as InstallationTaskStatus)),
      dayThemes: (plan.dayThemes as Record<string, string> | null) ?? null,
      tasks: tasks.map((t) => this.mapTask(t)),
    };
  }
}
