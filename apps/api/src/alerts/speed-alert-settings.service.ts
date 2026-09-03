import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { FleetSpeedAlertSettingsDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import type { SetSpeedAlertSettingsDto, SetVehicleSpeedAlertOverrideDto } from './dto/set-speed-alert-settings.dto';

/**
 * Lot V5 — RÉGLAGE des alertes de vitesse : par société, surchargeable par véhicule.
 *
 * Mêmes règles d'accès que le rapport hebdomadaire : un super-admin règle la société qu'il
 * a choisie dans le sélecteur ; un administrateur ou gestionnaire de flotte règle la sienne,
 * et seulement la sienne. Le droit `alerts_configure` est exigé par le contrôleur pour
 * écrire ; lire demande `alerts_view`.
 *
 * Chaque écriture porte son auteur et sa date, et s'inscrit au journal serveur : un seuil
 * d'alerte qui change doit avoir un nom en face.
 */
@Injectable()
export class SpeedAlertSettingsService {
  private readonly logger = new Logger(SpeedAlertSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private resolveFleetId(user: AuthUser, fleetIdQ?: string): string {
    if (user.role === UserRole.SUPER_ADMIN) {
      if (!fleetIdQ) throw new BadRequestException('Choisissez une société');
      return fleetIdQ;
    }
    if (fleetIdQ && fleetIdQ !== user.fleetId) throw new ForbiddenException('Société hors périmètre');
    if (!user.fleetId) throw new ForbiddenException('Aucune société rattachée');
    return user.fleetId;
  }

  async get(user: AuthUser, fleetIdQ?: string): Promise<FleetSpeedAlertSettingsDto> {
    return this.toDto(this.resolveFleetId(user, fleetIdQ));
  }

  async set(user: AuthUser, body: SetSpeedAlertSettingsDto, fleetIdQ?: string): Promise<FleetSpeedAlertSettingsDto> {
    const fleetId = this.resolveFleetId(user, fleetIdQ);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
    if (!fleet) throw new NotFoundException('Société introuvable');

    await this.prisma.fleet.update({
      where: { id: fleetId },
      data: {
        speedAlertEnabled: body.enabled,
        speedAlertOverKmh: body.overKmh,
        speedAlertAbsoluteKmh: body.absoluteKmh,
        speedAlertUpdatedAt: new Date(),
        speedAlertUpdatedById: user.id,
      },
    });
    this.logger.log(
      `Alertes de vitesse réglées pour ${fleet.name} par ${user.email} : ${body.enabled ? 'actives' : 'coupées'}, ` +
        `dépassement ≥ ${body.overKmh} km/h, plafond ${body.absoluteKmh ?? 'aucun'}`,
    );
    return this.toDto(fleetId);
  }

  async setVehicle(
    user: AuthUser,
    vehicleId: string,
    body: SetVehicleSpeedAlertOverrideDto,
    fleetIdQ?: string,
  ): Promise<FleetSpeedAlertSettingsDto> {
    const fleetId = this.resolveFleetId(user, fleetIdQ);
    // 404 et non 403 : ne pas révéler qu'un véhicule existe hors périmètre.
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, fleetId }, select: { id: true, plate: true } });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { speedAlertEnabled: body.enabled, speedAlertOverKmh: body.overKmh },
    });
    // La société porte la date : une dérogation véhicule EST une modification du réglage.
    await this.prisma.fleet.update({
      where: { id: fleetId },
      data: { speedAlertUpdatedAt: new Date(), speedAlertUpdatedById: user.id },
    });
    const resume = body.enabled === null && body.overKmh === null
      ? 'dérogation retirée'
      : `${body.enabled === null ? 'activation héritée' : body.enabled ? 'activé' : 'coupé'}, seuil ${body.overKmh ?? 'hérité'}`;
    this.logger.log(`Alertes de vitesse de ${vehicle.plate} réglées par ${user.email} : ${resume}`);
    return this.toDto(fleetId);
  }

  private async toDto(fleetId: string): Promise<FleetSpeedAlertSettingsDto> {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: {
        id: true, name: true,
        speedAlertEnabled: true, speedAlertOverKmh: true, speedAlertAbsoluteKmh: true,
        speedAlertUpdatedAt: true, speedAlertUpdatedById: true,
      },
    });
    if (!fleet) throw new NotFoundException('Société introuvable');

    const [vehicles, auteur] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { fleetId, OR: [{ speedAlertEnabled: { not: null } }, { speedAlertOverKmh: { not: null } }] },
        select: { id: true, plate: true, speedAlertEnabled: true, speedAlertOverKmh: true },
        orderBy: { plate: 'asc' },
      }),
      fleet.speedAlertUpdatedById
        ? this.prisma.user.findUnique({
            where: { id: fleet.speedAlertUpdatedById },
            select: { firstName: true, lastName: true, email: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      fleetId: fleet.id,
      fleetName: fleet.name,
      enabled: fleet.speedAlertEnabled,
      overKmh: fleet.speedAlertOverKmh,
      absoluteKmh: fleet.speedAlertAbsoluteKmh,
      updatedAt: fleet.speedAlertUpdatedAt?.toISOString() ?? null,
      updatedBy: auteur ? ([auteur.firstName, auteur.lastName].filter(Boolean).join(' ') || auteur.email) : null,
      vehicles: vehicles.map((v) => ({
        vehicleId: v.id, plate: v.plate, enabled: v.speedAlertEnabled, overKmh: v.speedAlertOverKmh,
      })),
    };
  }
}
