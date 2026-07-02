import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SurveillanceEventStatus,
  SurveillanceMode,
  SurveillanceSensitivity,
  UserRole,
} from '@prisma/client';
import type {
  SurveillanceEvent,
  SurveillanceEventTrigger,
  SurveillanceProfile,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { TrackerCommandsService } from '../tracker-commands/tracker-commands.service';
import {
  AcknowledgeEventDto,
  UpdateSurveillanceProfileDto,
} from './surveillance.dto';
import { mapSensitivityToCobanLevel } from './surveillance.helpers';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/** Anti-flood : le scheduler retente CHAQUE minute un tracker offline. On ne journalise
 *  un échec PLANIFIÉ qu'au plus une fois par heure et par (profil, action). */
const SCHEDULED_FAILURE_THROTTLE_MS = 60 * 60 * 1000;

interface ListEventsFilters {
  vehicleId?: string;
  status?: SurveillanceEventStatus;
  limit?: number;
  cursor?: string;
}

@Injectable()
export class SurveillanceService {
  private readonly logger = new Logger(SurveillanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackerCommands: TrackerCommandsService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /**
   * Journal Système — l'armement/désarmement antivol est l'exact analogue du
   * coupe-circuit (catégorie ENGINE) : commandes Coban réelles, déclenchées à la
   * main OU par le planificateur. Le FAILURE est le cas le plus précieux (le
   * scheduler avale les erreurs par profil → un tracker offline qui empêche
   * l'armement resterait invisible sans cette ligne).
   */
  private readonly lastScheduledFailureAt = new Map<string, number>();

  private recordSurveillance(
    action: 'surveillance_armed' | 'surveillance_disarmed',
    profile: SurveillanceProfile,
    requestedBy: RequestedBy,
    source: 'manual' | 'scheduled',
    status: 'SUCCESS' | 'FAILURE',
    detail: string,
  ): void {
    // Un échec planifié répété (tracker offline, ré-essayé chaque minute) ne
    // s'écrit qu'une fois/heure — les succès et TOUTES les actions manuelles passent.
    if (status === 'FAILURE' && source === 'scheduled') {
      const key = `${profile.id}|${action}`;
      const last = this.lastScheduledFailureAt.get(key) ?? 0;
      if (Date.now() - last < SCHEDULED_FAILURE_THROTTLE_MS) return;
      this.lastScheduledFailureAt.set(key, Date.now());
    }
    this.prisma.vehicle
      .findUnique({ where: { id: profile.vehicleId }, select: { plate: true } })
      .then((v) =>
        this.systemActivity.record({
          category: 'SURVEILLANCE',
          action,
          status,
          actor: source === 'scheduled' ? 'planning' : 'utilisateur',
          target: v?.plate ?? profile.vehicleId,
          detail,
          fleetId: profile.fleetId,
          triggeredByUserId: source === 'manual' ? requestedBy.userId : null,
        }),
      )
      .catch(() => {
        /* le journal ne casse jamais l'action métier */
      });
  }

  // ─── Profile CRUD ───────────────────────────────────────────────────

  async getOrCreateProfile(
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfile> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      vehicle.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }

    const existing = await this.prisma.surveillanceProfile.findUnique({
      where: { vehicleId },
    });
    if (existing) return existing;

    return this.prisma.surveillanceProfile.create({
      data: {
        vehicleId: vehicle.id,
        fleetId: vehicle.fleetId,
        mode: SurveillanceMode.OFF,
        sensitivity: SurveillanceSensitivity.MEDIUM,
        triggerVibration: true,
        triggerMovement: true,
        triggerDoor: false,
        additionalNotifyUserIds: [],
        createdBy: requestedBy.userId,
      },
    });
  }

  async updateProfile(
    vehicleId: string,
    dto: UpdateSurveillanceProfileDto,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfile> {
    const profile = await this.getOrCreateProfile(vehicleId, requestedBy);

    // Validations métier
    if (dto.mode === SurveillanceMode.SCHEDULED) {
      const start = dto.scheduleStartTime ?? profile.scheduleStartTime;
      const end = dto.scheduleEndTime ?? profile.scheduleEndTime;
      if (!start || !end) {
        throw new BadRequestException(
          'Mode SCHEDULED requiert scheduleStartTime et scheduleEndTime',
        );
      }
    }

    // Validation : si additionalNotifyUserIds change, vérifier appartenance fleet.
    if (dto.additionalNotifyUserIds) {
      if (dto.additionalNotifyUserIds.length > 0) {
        const users = await this.prisma.user.findMany({
          where: { id: { in: dto.additionalNotifyUserIds } },
          select: { id: true, fleetId: true, role: true, isActive: true },
        });
        for (const id of dto.additionalNotifyUserIds) {
          const u = users.find((x) => x.id === id);
          if (!u) throw new NotFoundException(`Utilisateur ${id} introuvable`);
          if (!u.isActive) {
            throw new BadRequestException(`Utilisateur ${id} inactif`);
          }
          if (
            requestedBy.role !== UserRole.SUPER_ADMIN &&
            u.fleetId !== profile.fleetId
          ) {
            throw new ForbiddenException(
              `Utilisateur ${id} hors de la flotte`,
            );
          }
          if (
            u.role !== UserRole.FLEET_ADMIN &&
            u.role !== UserRole.FLEET_MANAGER &&
            u.role !== UserRole.SUPER_ADMIN
          ) {
            throw new BadRequestException(
              `Utilisateur ${id} doit être FLEET_ADMIN ou FLEET_MANAGER`,
            );
          }
        }
      }
    }

    return this.prisma.surveillanceProfile.update({
      where: { id: profile.id },
      data: {
        mode: dto.mode ?? undefined,
        sensitivity: dto.sensitivity ?? undefined,
        scheduleStartTime:
          dto.scheduleStartTime === undefined ? undefined : dto.scheduleStartTime,
        scheduleEndTime:
          dto.scheduleEndTime === undefined ? undefined : dto.scheduleEndTime,
        scheduleDays:
          dto.scheduleDays === undefined
            ? undefined
            : (dto.scheduleDays as unknown as Prisma.InputJsonValue),
        triggerVibration: dto.triggerVibration ?? undefined,
        triggerMovement: dto.triggerMovement ?? undefined,
        triggerDoor: dto.triggerDoor ?? undefined,
        additionalNotifyUserIds: dto.additionalNotifyUserIds ?? undefined,
      },
    });
  }

  // ─── Arm / Disarm ───────────────────────────────────────────────────

  /**
   * Armement manuel par un utilisateur. Envoie les commandes Coban (shock +
   * sensitivity) via TrackerCommandsService. Si une commande échoue (tracker
   * offline par exemple), on remonte l'erreur sans modifier `currentlyArmed`.
   */
  async armNow(
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfile> {
    const profile = await this.getOrCreateProfile(vehicleId, requestedBy);
    return this.armProfile(profile, requestedBy, 'manual');
  }

  async disarmNow(
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfile> {
    const profile = await this.getOrCreateProfile(vehicleId, requestedBy);
    return this.disarmProfile(profile, requestedBy, 'manual');
  }

  /**
   * Armement utilisé à la fois par armNow() et par le scheduler. La distinction
   * `source` sert uniquement aux logs.
   */
  async armProfile(
    profile: SurveillanceProfile,
    requestedBy: RequestedBy,
    source: 'manual' | 'scheduled',
  ): Promise<SurveillanceProfile> {
    const tracker = await this.findTrackerForVehicle(profile.vehicleId);
    if (!tracker) {
      throw new BadRequestException(
        'Aucun tracker associé à ce véhicule — impossible d\'armer',
      );
    }

    // Envoyer en séquence : sensitivity puis shock (l'ordre importe : on règle
    // d'abord la sensibilité, ensuite on arme).
    try {
      await this.trackerCommands.request(
        tracker.id,
        'sensitivity',
        { level: mapSensitivityToCobanLevel(profile.sensitivity) },
        null,
        requestedBy,
      );
      await this.trackerCommands.request(
        tracker.id,
        'shock_on',
        {},
        null,
        requestedBy,
      );
    } catch (err) {
      this.recordSurveillance('surveillance_armed', profile, requestedBy, source, 'FAILURE',
        `Armement échoué (${profile.mode}, sens. ${profile.sensitivity}) : ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    this.logger.log(
      `[surveillance] ARM ${source} vehicle=${profile.vehicleId} ` +
        `sens=${profile.sensitivity} by=${requestedBy.userId}`,
    );
    this.recordSurveillance('surveillance_armed', profile, requestedBy, source, 'SUCCESS',
      `Armé (${profile.mode}, sensibilité ${profile.sensitivity})`);

    return this.prisma.surveillanceProfile.update({
      where: { id: profile.id },
      data: {
        currentlyArmed: true,
        lastArmedAt: new Date(),
      },
    });
  }

  async disarmProfile(
    profile: SurveillanceProfile,
    requestedBy: RequestedBy,
    source: 'manual' | 'scheduled',
  ): Promise<SurveillanceProfile> {
    const tracker = await this.findTrackerForVehicle(profile.vehicleId);
    if (tracker) {
      try {
        await this.trackerCommands.request(
          tracker.id,
          'shock_off',
          {},
          null,
          requestedBy,
        );
      } catch (err) {
        this.recordSurveillance('surveillance_disarmed', profile, requestedBy, source, 'FAILURE',
          `Désarmement échoué : ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    this.logger.log(
      `[surveillance] DISARM ${source} vehicle=${profile.vehicleId} by=${requestedBy.userId}`,
    );
    this.recordSurveillance('surveillance_disarmed', profile, requestedBy, source, 'SUCCESS', 'Désarmé');

    return this.prisma.surveillanceProfile.update({
      where: { id: profile.id },
      data: {
        currentlyArmed: false,
        lastDisarmedAt: new Date(),
      },
    });
  }

  // ─── Events ─────────────────────────────────────────────────────────

  async listEvents(
    requestedBy: RequestedBy,
    filters: ListEventsFilters,
  ): Promise<{ items: SurveillanceEvent[]; nextCursor: string | null }> {
    const where: Prisma.SurveillanceEventWhereInput = {};

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return { items: [], nextCursor: null };
      where.fleetId = requestedBy.fleetId;
    }
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;
    if (filters.status) where.status = filters.status;

    const limit = Math.min(filters.limit ?? 50, 200);
    const items = await this.prisma.surveillanceEvent.findMany({
      where,
      orderBy: { triggeredAt: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        vehicle: { select: { id: true, plate: true } },
      },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async acknowledgeEvent(
    eventId: string,
    dto: AcknowledgeEventDto,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceEvent> {
    const event = await this.prisma.surveillanceEvent.findUnique({
      where: { id: eventId },
    });
    if (!event) throw new NotFoundException('Événement introuvable');

    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      event.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé');
    }

    return this.prisma.surveillanceEvent.update({
      where: { id: eventId },
      data: {
        status: dto.status,
        notes: dto.notes ?? event.notes,
        acknowledgedAt: new Date(),
        acknowledgedBy: requestedBy.userId,
      },
    });
  }

  /**
   * Enregistre un déclenchement reçu via une trame Coban. Appelée par
   * AlertsService.createFromCobanFrame() quand un véhicule armé matche un trigger.
   * Le SurveillanceEvent est lié à l'Alert créée — la severity de l'Alert est
   * déjà CRITICAL côté appelant.
   */
  async recordTrigger(params: {
    profileId: string;
    vehicleId: string;
    fleetId: string;
    alertId: string;
    trigger: SurveillanceEventTrigger;
    latitude: number | null;
    longitude: number | null;
    speedKmh: number | null;
  }): Promise<SurveillanceEvent> {
    return this.prisma.surveillanceEvent.create({
      data: {
        profileId: params.profileId,
        vehicleId: params.vehicleId,
        fleetId: params.fleetId,
        alertId: params.alertId,
        trigger: params.trigger,
        latitude: params.latitude,
        longitude: params.longitude,
        speedKmh: params.speedKmh,
      },
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async findTrackerForVehicle(vehicleId: string) {
    return this.prisma.tracker.findFirst({
      where: { vehicle: { id: vehicleId } },
    });
  }
}
