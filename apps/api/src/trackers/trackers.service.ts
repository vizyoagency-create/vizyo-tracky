import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, UserRole } from '@prisma/client';
import type { Tracker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTrackerDto } from './dto/create-tracker.dto';
import type { UpdateTrackerDto } from './dto/update-tracker.dto';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class TrackersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateTrackerDto, _requestedBy: RequestedBy): Promise<Tracker> {
    if (!/^\d{15}$/.test(dto.imei)) {
      throw new BadRequestException('IMEI doit contenir exactement 15 chiffres');
    }

    try {
      return await this.prisma.tracker.create({
        data: {
          imei: dto.imei,
          model: dto.model ?? 'COBAN_GPS403D',
        },
        include: { vehicle: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Si le tracker existe deja et est non-assigne, on le reutilise
        // (cas typique : create+assign a echoue a l'etape assign, retry avec le meme IMEI).
        const existing = await this.prisma.tracker.findUnique({
          where: { imei: dto.imei },
          include: { vehicle: true },
        });
        if (existing && !existing.vehicleId) {
          return existing;
        }
        throw new ConflictException(`IMEI "${dto.imei}" déjà enregistré`);
      }
      throw err;
    }
  }

  async findAll(
    requestedBy: RequestedBy,
    filters?: { status?: string; unassigned?: string; limit?: number },
  ): Promise<Tracker[]> {
    const isSuperAdmin = requestedBy.role === UserRole.SUPER_ADMIN;
    const maxLimit = isSuperAdmin ? 500 : 50;
    const limit = Math.min(filters?.limit ?? maxLimit, maxLimit);
    const where: Prisma.TrackerWhereInput = {};

    if (!isSuperAdmin && requestedBy.fleetId) {
      where.vehicle = { fleetId: requestedBy.fleetId };
    }

    if (filters?.status) {
      where.status = filters.status as any;
    }

    if (filters?.unassigned === 'true') {
      where.vehicleId = null;
    }

    return this.prisma.tracker.findMany({
      where,
      include: { vehicle: isSuperAdmin ? { include: { fleet: true } } : true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Tracker> {
    // V1.10 (Sprint 6) — IDOR fix : filtre tenant integre au where (404 si
    // tracker d'une autre flotte). SUPER_ADMIN voit tout (incl. trackers
    // orphelins en stock). Non-SUPER ne voit que les trackers attaches a
    // un vehicule de sa flotte ; les trackers libres restent invisibles.
    const where: Prisma.TrackerWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Tracker introuvable');
      where.vehicle = { fleetId: requestedBy.fleetId };
    }
    const tracker = await this.prisma.tracker.findFirst({
      where,
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    return tracker;
  }

  async update(id: string, dto: UpdateTrackerDto, requestedBy: RequestedBy): Promise<Tracker> {
    await this.findOne(id, requestedBy);

    // V1.7 — accConnected reglable UNIQUEMENT par SUPER_ADMIN. Decision a fort
    // impact sur la fiabilite ignition (responsabilite installation hardware).
    if (dto.accConnected !== undefined && requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Le réglage matériel ACC est réservé au SUPER_ADMIN',
      );
    }

    // Construction explicite du payload pour ne pas envoyer `undefined` a Prisma
    // (qui le traite comme "ne rien changer", correct ici, mais on prefere
    // n'inclure que les champs explicitement modifies).
    const data: Prisma.TrackerUpdateInput = {};
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.accConnected !== undefined) data.accConnected = dto.accConnected;
    // V1.14 — SIM data du tracker (chaine vide => effacer). Sert au fallback SMS
    // + a l'allowlist vizyo-texto (auto-sync via l'event tracker.sim-changed).
    const simChanged = dto.simPhoneNumber !== undefined;
    if (simChanged) {
      data.simPhoneNumber = dto.simPhoneNumber?.trim() ? dto.simPhoneNumber.trim() : null;
    }

    const updated = await this.prisma.tracker.update({
      where: { id },
      data,
      include: { vehicle: true },
    });

    if (simChanged) {
      this.eventEmitter.emit('tracker.sim-changed', { trackerId: id, imei: updated.imei });
    }
    return updated;
  }

  async remove(id: string, requestedBy: RequestedBy): Promise<void> {
    const tracker = await this.findOne(id, requestedBy);

    if (tracker.vehicleId) {
      throw new BadRequestException('Détachez le tracker du véhicule avant suppression');
    }

    await this.prisma.tracker.delete({ where: { id } });

    // V1.14 — si le tracker avait une SIM, reconcilier l'allowlist (drop orphelin).
    if (tracker.simPhoneNumber) {
      this.eventEmitter.emit('tracker.sim-changed', { trackerId: id, imei: tracker.imei });
    }
  }

  async assign(
    trackerId: string,
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<Tracker> {
    // V1.10 (Sprint 6) — IDOR fix : filtre tenant integre au where pour le
    // vehicule (404 si autre flotte) et pour le tracker (libre OU dans la
    // flotte du caller).
    const vehicleWhere: Prisma.VehicleWhereInput = { id: vehicleId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
      vehicleWhere.fleetId = requestedBy.fleetId;
    }
    const vehicle = await this.prisma.vehicle.findFirst({
      where: vehicleWhere,
      include: { tracker: true },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    const trackerWhere: Prisma.TrackerWhereInput = { id: trackerId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      // requestedBy.fleetId est garanti non-null ici car le check sur vehicleWhere
      // au-dessus a deja throw NotFoundException si null. Re-asserter pour TS.
      const fleetId = requestedBy.fleetId;
      if (!fleetId) throw new NotFoundException('Tracker introuvable');
      // Tracker libre (vehicleId null) OU rattache a un vehicule de la flotte.
      trackerWhere.OR = [
        { vehicleId: null },
        { vehicle: { fleetId } },
      ];
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: trackerWhere,
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');

    if (tracker.vehicleId && tracker.vehicleId !== vehicleId) {
      const currentVehicle = (tracker as any).vehicle;
      throw new BadRequestException(
        `Tracker déjà assigné au véhicule ${currentVehicle?.plate ?? tracker.vehicleId}`,
      );
    }

    if (vehicle.tracker && (vehicle.tracker as any).id !== trackerId) {
      throw new BadRequestException(
        `Le véhicule ${vehicle.plate} a déjà le tracker ${(vehicle.tracker as any).imei}`,
      );
    }

    const updated = await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { vehicleId },
      include: { vehicle: true },
    });

    this.eventEmitter.emit('tracker.assigned', { trackerId, imei: updated.imei });
    return updated;
  }

  async unassign(trackerId: string, requestedBy: RequestedBy): Promise<Tracker> {
    const tracker = await this.findOne(trackerId, requestedBy);

    if (!tracker.vehicleId) {
      return tracker;
    }

    const updated = await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { vehicleId: null },
      include: { vehicle: true },
    });

    this.eventEmitter.emit('tracker.unassigned', { trackerId, imei: updated.imei });
    return updated;
  }
}
