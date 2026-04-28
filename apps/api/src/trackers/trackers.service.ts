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
        throw new ConflictException(`IMEI "${dto.imei}" déjà enregistré`);
      }
      throw err;
    }
  }

  async findAll(
    requestedBy: RequestedBy,
    filters?: { status?: string; unassigned?: string; limit?: number },
  ): Promise<Tracker[]> {
    const limit = Math.min(filters?.limit ?? 50, 50);
    const where: Prisma.TrackerWhereInput = {};

    if (requestedBy.role !== UserRole.SUPER_ADMIN && requestedBy.fleetId) {
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
      include: { vehicle: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Tracker> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id },
      include: { vehicle: true },
    });

    if (!tracker) throw new NotFoundException('Tracker introuvable');

    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      tracker.vehicleId &&
      (tracker as any).vehicle?.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé à ce tracker');
    }

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

    return this.prisma.tracker.update({
      where: { id },
      data,
      include: { vehicle: true },
    });
  }

  async remove(id: string, requestedBy: RequestedBy): Promise<void> {
    const tracker = await this.findOne(id, requestedBy);

    if (tracker.vehicleId) {
      throw new BadRequestException('Détachez le tracker du véhicule avant suppression');
    }

    await this.prisma.tracker.delete({ where: { id } });
  }

  async assign(
    trackerId: string,
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<Tracker> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });

    if (!tracker) throw new NotFoundException('Tracker introuvable');

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { tracker: true },
    });

    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Le véhicule appartient à une autre flotte');
      }
    }

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
