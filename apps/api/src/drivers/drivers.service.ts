import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Driver } from '@prisma/client';
import { Prisma, UserRole } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly errors: ErrorLogger,
  ) {}

  async list(requestedBy: RequestedBy, includeArchived = false) {
    // V1.15 — Inclus les compteurs (currentVehicles + trips) pour la liste
    // /drivers : utile pour les badges contextuels (X vehicules · Y trajets)
    // sans round-trip supplementaire. Prisma `_count` est une COUNT subquery
    // peu couteuse avec les index existants sur Vehicle.currentDriverId et
    // Trip.driverId.
    return this.prisma.driver.findMany({
      where: {
        ...(requestedBy.role !== UserRole.SUPER_ADMIN
          ? { fleetId: requestedBy.fleetId ?? '__none__' }
          : {}),
        ...(includeArchived ? {} : { isActive: true }),
      },
      include: {
        // V2 — véhicules actuellement attribués (drill-down depuis la card conducteur).
        currentVehicles: { select: { id: true, plate: true }, orderBy: { plate: 'asc' } },
        _count: { select: { currentVehicles: true, trips: true } },
      },
      orderBy: [{ isActive: 'desc' }, { lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Driver> {
    // Filtre tenant integre au where : un user d'une autre flotte recoit 404
    // (pas 403) -> pas de leak d'existence via timing NotFoundException.
    const where: Prisma.DriverWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Conducteur introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const driver = await this.prisma.driver.findFirst({ where });
    if (!driver) throw new NotFoundException('Conducteur introuvable');
    return driver;
  }

  async create(dto: CreateDriverDto, requestedBy: RequestedBy): Promise<Driver> {
    if (requestedBy.role !== UserRole.SUPER_ADMIN && !requestedBy.fleetId) {
      throw new BadRequestException('Aucune fleet assignee à votre compte.');
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
    // Filtre tenant integre au where : 404 si le vehicule appartient a une autre flotte.
    const vehicleWhere: Prisma.VehicleWhereInput = { id: vehicleId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
      vehicleWhere.fleetId = requestedBy.fleetId;
    }
    const vehicle = await this.prisma.vehicle.findFirst({ where: vehicleWhere });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    if (driverId) {
      // Le driver doit imperativement appartenir a la meme flotte que le vehicule
      // (deja validee comme accessible). On filtre dans le where -> pas d'enumeration.
      const driver = await this.prisma.driver.findFirst({
        where: { id: driverId, fleetId: vehicle.fleetId },
      });
      if (!driver) throw new NotFoundException('Conducteur introuvable');
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
    // Filtre tenant integre au where : 404 si le trajet appartient a une autre flotte.
    const tripWhere: Prisma.TripWhereInput = { id: tripId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Trajet introuvable');
      tripWhere.fleetId = requestedBy.fleetId;
    }
    const trip = await this.prisma.trip.findFirst({ where: tripWhere });
    if (!trip) throw new NotFoundException('Trajet introuvable');

    if (driverId) {
      // trip.fleetId est nullable au type Prisma mais ne devrait jamais l'etre
      // en prod (cree avec fleetId obligatoire). Defensive : refus si null.
      if (!trip.fleetId) throw new NotFoundException('Trajet introuvable');
      const driver = await this.prisma.driver.findFirst({
        where: { id: driverId, fleetId: trip.fleetId },
      });
      if (!driver) throw new NotFoundException('Conducteur introuvable');
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

  /**
   * RGPD 4.3 — droit d'accès (art. 15) : export COMPLET des données d'un conducteur, en JSON.
   * Fleet-scoped (404 cross-flotte via findOne). L'export lui-même est AUDITÉ (catégorie EXPORT) :
   * remettre les données d'une personne est une action sensible qui doit se voir dans le journal.
   */
  async gdprExport(id: string, requestedBy: RequestedBy) {
    const driver = await this.findOne(id, requestedBy);
    try {
      const [user, accessScopes, trips, privacyEvents, activity] = await Promise.all([
        driver.userId
          ? this.prisma.user.findUnique({
              where: { id: driver.userId },
              select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, createdAt: true },
            })
          : Promise.resolve(null),
        driver.userId
          ? this.prisma.userVehicleAccess.findMany({
              where: { userId: driver.userId },
              select: { accessType: true, groupId: true, vehicleId: true, permissions: true, createdAt: true },
            })
          : Promise.resolve([]),
        this.prisma.trip.findMany({
          where: { driverId: driver.id },
          select: {
            id: true, startedAt: true, endedAt: true, durationSeconds: true,
            distanceKm: true, maxSpeed: true, driverSource: true,
            vehicle: { select: { plate: true } },
          },
          orderBy: { startedAt: 'desc' },
          take: 50_000,
        }),
        driver.userId
          ? this.prisma.privacyModeEvent.findMany({
              where: { userId: driver.userId },
              select: { vehicleId: true, enabled: true, reason: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            })
          : Promise.resolve([]),
        driver.userId
          ? this.prisma.systemActivityLog.findMany({
              where: { triggeredByUserId: driver.userId, category: { in: ['ENGINE', 'PRIVACY'] } },
              select: { category: true, action: true, status: true, target: true, detail: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
              take: 1000,
            })
          : Promise.resolve([]),
      ]);

      this.systemActivity.record({
        category: 'EXPORT',
        action: 'gdpr_driver_export',
        status: 'SUCCESS',
        actor: 'opérateur',
        target: `${driver.firstName} ${driver.lastName}`.trim(),
        detail: `Export RGPD (art. 15) du conducteur — ${trips.length} trajet(s), ${privacyEvents.length} évènement(s) vie privée`,
        fleetId: driver.fleetId,
        triggeredByUserId: requestedBy.userId,
        meta: { driverId: driver.id, trips: trips.length, privacyEvents: privacyEvents.length, activity: activity.length },
      });

      return {
        exportedAt: new Date().toISOString(),
        exportKind: 'RGPD article 15 — droit d’accès',
        driver: {
          id: driver.id, firstName: driver.firstName, lastName: driver.lastName,
          phone: driver.phone, email: driver.email, licenseNumber: driver.licenseNumber,
          notes: driver.notes, isActive: driver.isActive, createdAt: driver.createdAt,
        },
        account: user,
        accessScopes,
        trips: { count: trips.length, items: trips },
        privacyModeEvents: privacyEvents,
        activityLog: activity,
      };
    } catch (err) {
      this.errors
        .record(err instanceof Error ? err : new Error(String(err)), 'drivers-rgpd', { driverId: id, phase: 'export' }, 'ERROR')
        .catch((e) => this.logger.error('ErrorLogger persist failed', e));
      throw err;
    }
  }

  /**
   * RGPD 4.4 — droit à l'effacement (art. 17) : ANONYMISATION irréversible d'un conducteur.
   * Écrase toute la PII du Driver (nom → « Conducteur anonymisé », tél/email/permis/notes → null),
   * détache ses véhicules, et anonymise/désactive le compte User lié (e-mail neutralisé, accès
   * supprimés — plus aucune connexion possible). `Trip.driverId` est CONSERVÉ : les trajets
   * pointent vers une fiche anonyme (intégrité kilométrique sans données personnelles) et
   * disparaissent d'eux-mêmes par la rétention 4.1. Distinct de l'archivage (réversible).
   */
  async anonymize(id: string, requestedBy: RequestedBy): Promise<{ ok: true }> {
    const driver = await this.findOne(id, requestedBy);
    const previousName = `${driver.firstName} ${driver.lastName}`.trim();
    try {
      const ops: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.driver.update({
          where: { id: driver.id },
          data: {
            firstName: 'Conducteur',
            lastName: 'anonymisé',
            phone: null,
            email: null,
            licenseNumber: null,
            notes: null,
            isActive: false,
            userId: null,
          },
        }),
        this.prisma.vehicle.updateMany({ where: { currentDriverId: driver.id }, data: { currentDriverId: null } }),
      ];
      if (driver.userId) {
        ops.push(
          this.prisma.userVehicleAccess.deleteMany({ where: { userId: driver.userId } }),
          this.prisma.user.update({
            where: { id: driver.userId },
            data: {
              email: `anonyme-${driver.id}@supprime.tracky.invalid`,
              firstName: 'Compte',
              lastName: 'supprimé',
              isActive: false,
            },
          }),
        );
      }
      await this.prisma.$transaction(ops);

      this.systemActivity.record({
        category: 'PRIVACY',
        action: 'driver_anonymized',
        status: 'SUCCESS',
        actor: 'opérateur',
        target: previousName || driver.id,
        detail: `Anonymisation RGPD (art. 17) du conducteur — PII effacée, compte désactivé${driver.userId ? ' (User lié anonymisé)' : ''}`,
        fleetId: driver.fleetId,
        triggeredByUserId: requestedBy.userId,
        meta: { driverId: driver.id, hadUser: !!driver.userId },
      });
      this.logger.log(`Driver ${driver.id} anonymise (fleet=${driver.fleetId}) par ${requestedBy.userId}`);
      return { ok: true };
    } catch (err) {
      this.errors
        .record(err instanceof Error ? err : new Error(String(err)), 'drivers-rgpd', { driverId: id, phase: 'anonymize' }, 'ERROR')
        .catch((e) => this.logger.error('ErrorLogger persist failed', e));
      throw err;
    }
  }
}
