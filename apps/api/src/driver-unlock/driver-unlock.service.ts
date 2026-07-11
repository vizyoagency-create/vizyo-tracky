import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EngineAction, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { EngineControlService } from '../engine-control/engine-control.service';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { UnlockTokenService } from './unlock-token.service';
import type { UnlockDriverDto } from './dto/unlock-driver.dto';

/**
 * Distance max (m) entre le téléphone du conducteur et la dernière position du véhicule pour
 * autoriser le déverrouillage. Contrôle de proximité anti-abus (décision user). Réglable par
 * l'env plateforme `DRIVER_UNLOCK_MAX_DISTANCE_M` (défaut 150 m, plancher 10 m).
 */
const MAX_DISTANCE_M = Math.max(10, Number(process.env.DRIVER_UNLOCK_MAX_DISTANCE_M) || 150);

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * feat/comptes-conducteurs (4b) — déverrouillage d'un véhicule par un conducteur via QR.
 *
 * Verrous cumulés (tous requis) :
 *   1. jeton QR signé valide → vehicleId ;
 *   2. tenant : même flotte que le conducteur (sauf super-admin) ;
 *   3. autorisation per-véhicule `engine_control` (accordée par le fleet-admin sur ce périmètre) ;
 *   4. PROXIMITÉ : téléphone à ≤ MAX_DISTANCE_M de la dernière position du véhicule.
 * Puis RESTORE moteur (source MANUAL → suspend le planning jusqu'à la prochaine bascule, cf. incr.1)
 * + attribution du conducteur courant (trajets snappés). Le conducteur ne peut JAMAIS couper (CUT).
 */
@Injectable()
export class DriverUnlockService {
  private readonly logger = new Logger(DriverUnlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly unlockToken: UnlockTokenService,
    private readonly perms: PermissionsResolverService,
    private readonly engineControl: EngineControlService,
  ) {}

  async unlock(
    user: AuthUser,
    dto: UnlockDriverDto,
  ): Promise<{ ok: true; vehicleId: string; plate: string; distanceM: number; message: string }> {
    const vehicleId = this.unlockToken.verifyVehicleToken(dto.token);
    if (!vehicleId) throw new BadRequestException('QR invalide ou illisible.');

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { tracker: { select: { id: true } } },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.');

    // Tenant (anti cross-fleet).
    if (user.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== user.fleetId) {
      throw new ForbiddenException("Ce véhicule n'appartient pas à votre flotte.");
    }

    // Autorisation per-véhicule (accordée par le fleet-admin sur le périmètre du conducteur).
    const allowed = await this.perms.canOnVehicle(user, vehicleId, 'engine_control');
    if (!allowed) {
      throw new ForbiddenException("Vous n'êtes pas autorisé à déverrouiller ce véhicule.");
    }

    if (!vehicle.tracker) {
      throw new BadRequestException("Ce véhicule n'a pas de boîtier — déverrouillage impossible.");
    }

    // Contrôle de proximité (anti-abus : le QR n'est pas un secret, la présence est requise).
    const lastPos = await this.prisma.position.findFirst({
      where: { trackerId: vehicle.tracker.id },
      orderBy: { timestamp: 'desc' },
      select: { lat: true, lng: true },
    });
    if (!lastPos) {
      throw new ForbiddenException('Position du véhicule inconnue — impossible de vérifier la proximité.');
    }
    const distanceM = haversineMeters(dto.lat, dto.lng, lastPos.lat, lastPos.lng);
    if (distanceM > MAX_DISTANCE_M) {
      throw new ForbiddenException(
        `Vous êtes trop loin du véhicule (${Math.round(distanceM)} m, max ${MAX_DISTANCE_M} m). Rapprochez-vous.`,
      );
    }

    // Déverrouillage = RESTORE moteur. Source MANUAL → le planning horaire est suspendu jusqu'à
    // la prochaine bascule (le conducteur prend la voiture hors plage → tient jusqu'au créneau).
    await this.engineControl.requestCommand(
      vehicle.tracker.id,
      EngineAction.RESTORE,
      'Déverrouillage par QR (conducteur, proximité vérifiée)',
      { userId: user.id, role: user.role, fleetId: user.fleetId },
      'MANUAL',
    );

    // Attribution : le conducteur (Driver lié à son compte) devient conducteur courant du véhicule
    // → les trajets suivants lui sont snappés. Best-effort (ne casse pas le déverrouillage).
    const driver = await this.prisma.driver.findFirst({
      where: { userId: user.id, fleetId: vehicle.fleetId, isActive: true },
      select: { id: true },
    });
    if (driver) {
      await this.prisma.vehicle
        .update({ where: { id: vehicleId }, data: { currentDriverId: driver.id } })
        .catch((e) => this.logger.warn(`currentDriver set failed: ${(e as Error).message}`));
    }

    this.logger.log({ vehicleId, userId: user.id, distanceM: Math.round(distanceM) }, 'Driver unlock OK');
    return {
      ok: true,
      vehicleId,
      plate: vehicle.plate,
      distanceM: Math.round(distanceM),
      message: 'Véhicule déverrouillé. Vous pouvez démarrer.',
    };
  }
}
