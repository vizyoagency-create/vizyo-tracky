import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { VehicleSchedule } from '@prisma/client';
import { EngineControlService } from '../engine-control/engine-control.service';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateSchedule } from './schedule-evaluator';
import type { UpsertVehicleScheduleDto } from './dto/upsert-vehicle-schedule.dto';

const SCHEDULER_USER_ID = '00000000-0000-0000-0000-000000000000';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class VehicleSchedulesService {
  private readonly logger = new Logger(VehicleSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engineControl: EngineControlService,
  ) {}

  async get(vehicleId: string, requestedBy: RequestedBy): Promise<VehicleSchedule | null> {
    await this.assertAccess(vehicleId, requestedBy);
    return this.prisma.vehicleSchedule.findUnique({ where: { vehicleId } });
  }

  async upsert(
    vehicleId: string,
    dto: UpsertVehicleScheduleDto,
    requestedBy: RequestedBy,
  ): Promise<VehicleSchedule> {
    await this.assertAccess(vehicleId, requestedBy);

    // If enabling, verify vehicle has a tracker
    if (dto.enabled) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        include: { tracker: true },
      });
      if (!vehicle?.tracker) {
        throw new BadRequestException(
          'Impossible d\'activer le scheduling : aucun tracker assigné',
        );
      }
    }

    // Detect transition enabled=true → false
    const existing = await this.prisma.vehicleSchedule.findUnique({
      where: { vehicleId },
    });
    const wasEnabled = existing?.enabled ?? false;
    const willBeEnabled = dto.enabled;
    const wasCut = existing?.lastEvaluatedState === 'OUT_OF_WINDOW';

    // V1.5 (Sprint K) — caster les champs JSON (slots / customDates) au type
    // Prisma input pour passer le typecheck. Les class-validator DTO sont des
    // arrays de classes plain, pas reconnus comme InputJsonValue.
    const jsonifiedDto: Record<string, unknown> = { ...dto };
    for (const key of [
      'mondaySlots', 'tuesdaySlots', 'wednesdaySlots', 'thursdaySlots',
      'fridaySlots', 'saturdaySlots', 'sundaySlots', 'customDates',
    ] as const) {
      if (key in dto) {
        const v = dto[key];
        jsonifiedDto[key] = v == null ? Prisma.JsonNull : (v as unknown as Prisma.InputJsonValue);
      }
    }

    // Reset lastEvaluatedState when disabling (clean slate for next activation)
    const updateData = wasEnabled && !willBeEnabled
      ? { ...jsonifiedDto, lastEvaluatedState: null, lastEvaluatedAt: null }
      : jsonifiedDto;

    const updated = await this.prisma.vehicleSchedule.upsert({
      where: { vehicleId },
      create: { vehicleId, ...jsonifiedDto } as Prisma.VehicleScheduleUncheckedCreateInput,
      update: updateData as Prisma.VehicleScheduleUncheckedUpdateInput,
    });

    // If we just disabled → check if a CUT is active and send RESTORE.
    // On ne se fie plus à lastEvaluatedState seul : on vérifie la dernière commande réelle.
    if (wasEnabled && !willBeEnabled) {
      const tracker = await this.prisma.tracker.findFirst({ where: { vehicleId } });
      if (tracker) {
        // Inclure FAILED : un CUT FAILED = envoyé au boîtier mais ACK timeout.
        // Le véhicule est probablement coupé, on envoie RESTORE par sécurité.
        const lastCmd = await this.prisma.engineControlCommand.findFirst({
          where: {
            trackerId: tracker.id,
            source: { not: 'DEVICE_OBSERVED' },
            OR: [
              { status: { in: [CommandStatus.SENT, CommandStatus.ACKNOWLEDGED] } },
              { status: CommandStatus.FAILED, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });
        const isCutActive = lastCmd?.action === EngineAction.CUT;

        if (isCutActive) {
          this.logger.log(
            { vehicleId, trackerId: tracker.id, lastCmdId: lastCmd.id },
            'Schedule disabled while CUT active → emitting RESTORE',
          );
          try {
            await this.engineControl.requestCommand(
              tracker.id,
              EngineAction.RESTORE,
              'Automatisation horaire désactivée',
              requestedBy,
              'MANUAL',
            );
          } catch (err) {
            this.logger.warn(
              { vehicleId, error: (err as Error).message },
              'Failed to emit RESTORE on scheduler disable (tracker may be offline)',
            );
          }
        }
      }
    }

    // Evaluation immediate : ne pas attendre le prochain tick cron.
    // Si hors fenetre → CUT immédiat. Si en fenetre → juste initialiser le state.
    if (willBeEnabled) {
      const evaluation = evaluateSchedule(updated);
      const state = evaluation.state;

      if (state === 'IN_WINDOW') {
        // Vehicule autorise a rouler — juste poser le baseline
        await this.prisma.vehicleSchedule.update({
          where: { id: updated.id },
          data: { lastEvaluatedState: state, lastEvaluatedAt: new Date() },
        });
        this.logger.log({ vehicleId, state }, 'Schedule enabled — in window, no action');
      } else {
        // Hors fenetre → CUT immediat
        const tracker = await this.prisma.tracker.findFirst({ where: { vehicleId } });
        if (tracker) {
          try {
            await this.engineControl.requestCommand(
              tracker.id,
              EngineAction.CUT,
              `Automatisation horaire activée hors plage autorisée`,
              { userId: SCHEDULER_USER_ID, role: 'SUPER_ADMIN' as any, fleetId: null },
              'SCHEDULER',
            );
            await this.prisma.vehicleSchedule.update({
              where: { id: updated.id },
              data: { lastEvaluatedState: state, lastEvaluatedAt: new Date() },
            });
            this.logger.log({ vehicleId, state }, 'Schedule enabled — out of window, CUT sent');
          } catch (err) {
            // CUT echoue (stale, offline...) → cron retentera au prochain tick
            this.logger.warn(
              { vehicleId, error: (err as Error).message },
              'Immediate CUT on schedule enable failed (cron will retry)',
            );
          }
        }
      }
    }

    // Retourner l'état frais (lastEvaluatedState peut avoir changé par l'évaluation immédiate)
    return this.prisma.vehicleSchedule.findUnique({ where: { id: updated.id } }) as Promise<VehicleSchedule>;
  }

  private async assertAccess(vehicleId: string, requestedBy: RequestedBy): Promise<void> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { fleetId: true },
    });

    if (!vehicle) {
      throw new NotFoundException('Véhicule introuvable');
    }

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé à cette flotte');
      }
    }
  }
}
