import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { VehicleSchedule } from '@prisma/client';
import { EngineControlService } from '../engine-control/engine-control.service';
import { ErrorLogger } from '../observability/error-logger.service';
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
    private readonly errorLogger: ErrorLogger,
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

    // Reset lastEvaluatedState when disabling (clean slate for next activation).
    // Sync fiche↔flotte (incident 2026-07-14) : ACTIVER un planning efface un override PÉRIMÉ
    // (sinon la fiche affiche « activé » mais la page flotte « suspendu »). On PRÉSERVE un
    // blocage veilleur volontaire (sentinelle lointaine 9999).
    const clearStaleOverride =
      willBeEnabled && !!existing?.overrideUntil && existing.overrideUntil.getFullYear() < 2900;
    const updateData = wasEnabled && !willBeEnabled
      ? { ...jsonifiedDto, lastEvaluatedState: null, lastEvaluatedAt: null }
      : clearStaleOverride
        ? { ...jsonifiedDto, overrideUntil: null }
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
            // Contrairement aux reports du cron, PERSONNE ne retentera ce RESTORE :
            // le planning passe enabled=false (hors du where du cron). Un véhicule
            // peut donc rester coupé en silence → centre d'alerte obligatoire.
            this.errorLogger.recordBackground(err instanceof Error ? err : new Error(String(err)), 'vehicle-schedules', {
              vehicleId, phase: 'restore-on-disable',
            });
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
      } else if (updated.overrideUntil && new Date() < updated.overrideUntil) {
        // Revue : un override manuel est actif (grâce 1h après un RESTORE, ou hold veilleur).
        // On NE coupe PAS immédiatement — même règle que le cron (schedule-cron:111). On laisse
        // lastEvaluatedState=null : à l'expiration de l'override, le cron verra OUT_OF_WINDOW ≠ null
        // et coupera (en respectant la règle des 10 min). Sinon un bulk « appliquer horaires »
        // écraserait une grâce manuelle en cours.
        this.logger.log(
          { vehicleId, overrideUntil: updated.overrideUntil },
          'Schedule enabled out-of-window but manual override active — deferring cut to cron',
        );
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

  /**
   * « Réactiver » (incident 2026-07-14) : efface l'override manuel d'un véhicule « Suspendu »
   * pour qu'il REJOIGNE le cycle horaire comme les autres. On force la réconciliation en posant
   * lastEvaluatedState à l'OPPOSÉ de l'état courant → au prochain tick cron (< 1 min) la transition
   * due est appliquée (coupe si hors plage, rallume si dans la plage), source SCHEDULER (PAS de
   * nouvel override). Lève AUSSI un blocage veilleur (action fleet-admin délibérée).
   */
  async reactivate(vehicleId: string, requestedBy: RequestedBy): Promise<VehicleSchedule> {
    await this.assertAccess(vehicleId, requestedBy);
    const sched = await this.prisma.vehicleSchedule.findUnique({ where: { vehicleId } });
    if (!sched) throw new NotFoundException('Aucun horaire programmé pour ce véhicule');
    const state = sched.enabled ? evaluateSchedule(sched).state : null;
    const opposite = state === 'IN_WINDOW' ? 'OUT_OF_WINDOW' : state === 'OUT_OF_WINDOW' ? 'IN_WINDOW' : null;
    return this.prisma.vehicleSchedule.update({
      where: { vehicleId },
      data: { overrideUntil: null, lastEvaluatedState: opposite },
    });
  }

  private async assertAccess(vehicleId: string, requestedBy: RequestedBy): Promise<void> {
    // Filtre tenant integre au where : 404 plutot que 403 pour ne pas leak
    // l'existence d'un vehicule d'une autre flotte via timing NotFoundException.
    const where: Prisma.VehicleWhereInput = { id: vehicleId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const vehicle = await this.prisma.vehicle.findFirst({
      where,
      select: { fleetId: true },
    });
    if (!vehicle) {
      throw new NotFoundException('Véhicule introuvable');
    }
  }
}
