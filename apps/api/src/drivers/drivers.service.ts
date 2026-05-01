import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Driver } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/**
 * Phase 2 — Service Conducteurs.
 *
 * Toutes les operations sont fleet-scoped : un FLEET_ADMIN/MANAGER ne voit
 * que les drivers de sa fleet. SUPER_ADMIN voit tout.
 *
 * Soft delete : on n'efface jamais un driver pour preserver l'historique
 * Trip.driverId. La "suppression" set juste `isActive=false`.
 */
@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(requestedBy: RequestedBy, includeArchived = false): Promise<Driver[]> {
    return this.prisma.driver.findMany({
      where: {
        ...(requestedBy.role !== UserRole.SUPER_ADMIN
          ? { fleetId: requestedBy.fleetId ?? '__none__' }
          : {}),
        ...(includeArchived ? {} : { isActive: true }),
      },
      orderBy: [{ isActive: 'desc' }, { lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Driver> {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Conducteur introuvable');
    this.assertSameFleet(driver, requestedBy);
    return driver;
  }

  async create(dto: CreateDriverDto, requestedBy: RequestedBy): Promise<Driver> {
    if (requestedBy.role !== UserRole.SUPER_ADMIN && !requestedBy.fleetId) {
      throw new BadRequestException('Aucune fleet assignee a votre compte.');
    }
    if (!requestedBy.fleetId && requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new BadRequestException('Fleet requise.');
    }
    // Les non-SUPER_ADMIN sont implicitement contraints a leur propre fleet.
    const fleetId = requestedBy.fleetId!;
    return this.prisma.driver.create({
      data: {
        fleetId,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        phone: dto.phone?.trim() || null,
        email: dto.email?.trim().toLowerCase() || null,
        licenseNumber: dto.licenseNumber?.trim() || null,
        color: dto.color || '#10E0A0',
        notes: dto.notes?.trim() || null,
      },
    });
  }

  async update(id: string, dto: UpdateDriverDto, requestedBy: RequestedBy): Promise<Driver> {
    const existing = await this.findOne(id, requestedBy);
    return this.prisma.driver.update({
      where: { id: existing.id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName.trim() } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName.trim() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim().toLowerCase() || null } : {}),
        ...(dto.licenseNumber !== undefined ? { licenseNumber: dto.licenseNumber?.trim() || null } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  /**
   * Soft-delete : isActive=false. On ne supprime PAS l'enregistrement DB pour
   * preserver l'integrite des Trip.driverId historiques (sinon on perdrait la
   * reference apres ON DELETE SET NULL).
   *
   * Side-effect : retire le driver des Vehicle.currentDriverId — un conducteur
   * archive ne doit plus etre "actif" sur un vehicule.
   */
  async archive(id: string, requestedBy: RequestedBy): Promise<{ ok: true }> {
    const driver = await this.findOne(id, requestedBy);
    await this.prisma.$transaction([
      this.prisma.driver.update({ where: { id: driver.id }, data: { isActive: false } }),
      this.prisma.vehicle.updateMany({
        where: { currentDriverId: driver.id },
        data: { currentDriverId: null },
      }),
    ]);
    this.logger.log(`Driver ${driver.id} archive (fleet=${driver.fleetId})`);
    return { ok: true };
  }

  /**
   * Assigne un driver comme `currentDriver` d'un vehicule. driverId=null retire.
   * Cette assignation sert de defaut snape sur les futurs trajets (Trip.driverId
   * snape AUTO au finalize).
   */
  async assignToVehicle(
    vehicleId: string,
    driverId: string | null,
    requestedBy: RequestedBy,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw new NotFoundException('Vehicule introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }

    if (driverId) {
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundException('Conducteur introuvable');
      if (driver.fleetId !== vehicle.fleetId) {
        throw new BadRequestException('Le conducteur appartient a une autre fleet.');
      }
      if (!driver.isActive) {
        throw new BadRequestException('Conducteur archive — reactiver avant assignation.');
      }
    }

    return this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { currentDriverId: driverId },
      include: {
        currentDriver: {
          select: { id: true, firstName: true, lastName: true, color: true, isActive: true },
        },
      },
    });
  }

  /**
   * Affecte/change le driver d'un trip a posteriori. Set driverSource='MANUAL'.
   */
  async assignToTrip(
    tripId: string,
    driverId: string | null,
    requestedBy: RequestedBy,
  ) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trajet introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && trip.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }

    if (driverId) {
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw new NotFoundException('Conducteur introuvable');
      if (driver.fleetId !== trip.fleetId) {
        throw new BadRequestException('Le conducteur appartient a une autre fleet.');
      }
    }

    return this.prisma.trip.update({
      where: { id: tripId },
      data: {
        driverId,
        driverSource: driverId ? 'MANUAL' : null,
      },
      include: {
        vehicle: true,
        notesUpdatedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        driver: {
          select: { id: true, firstName: true, lastName: true, color: true, isActive: true },
        },
      },
    });
  }

  /** Garde-fou : un driver doit appartenir a la fleet du caller (sauf SUPER_ADMIN). */
  private assertSameFleet(driver: Driver, requestedBy: RequestedBy): void {
    if (requestedBy.role === UserRole.SUPER_ADMIN) return;
    if (driver.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
  }
}
