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
import { SystemActivityService } from '../system-activity/system-activity.service';
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
    private readonly systemActivity: SystemActivityService,
  ) {}

  async unlock(user: AuthUser, dto: UnlockDriverDto): Promise<{ ok: true; message: string }> {
    const method = dto.vehicleId ? 'in-app' : 'QR';
    let vehicleId: string | null = null;
    let plate: string | null = null;
    let fleetId: string | null = user.fleetId;
    let distanceM: number | undefined; // arrondi, hoisté pour la trace d'échec (motif « où »).
    try {
      // vehicleId in-app (« Mes véhicules ») OU résolu du jeton QR. L'autorisation + la proximité
      // (ci-dessous) restent le vrai verrou, quel que soit le point d'entrée.
      vehicleId = dto.vehicleId ?? this.unlockToken.verifyVehicleToken(dto.token);
      if (!vehicleId) throw new BadRequestException('QR invalide ou véhicule non spécifié.');

      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        include: { tracker: { select: { id: true } } },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
      plate = vehicle.plate;
      fleetId = vehicle.fleetId;

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

      // Contrôle de proximité (anti-abus). On IGNORE les fixes GPS invalides (valid=false) —
      // sinon une position aberrante (ex. 0,0) fausserait la distance. NB : les coordonnées du
      // téléphone sont AUTO-DÉCLARÉES par le client (cf. revue adversariale) → la proximité est
      // une barrière anti-abus, PAS une preuve infalsifiable de présence ; on la trace « déclarée ».
      const lastPos = await this.prisma.position.findFirst({
        where: { trackerId: vehicle.tracker.id, valid: true },
        orderBy: { timestamp: 'desc' },
        select: { lat: true, lng: true },
      });
      if (!lastPos) {
        throw new ForbiddenException('Position du véhicule inconnue — impossible de vérifier la proximité.');
      }
      distanceM = Math.round(haversineMeters(dto.lat, dto.lng, lastPos.lat, lastPos.lng));
      if (distanceM > MAX_DISTANCE_M) {
        // Message SANS distance exacte : la renvoyer formerait un oracle de trilatération de la
        // position du véhicule (contournerait le mode vie privée). La distance réelle reste tracée
        // côté serveur (meta d'audit du catch) pour le « qui / où », mais n'est pas divulguée au client.
        throw new ForbiddenException('Vous êtes trop loin du véhicule. Rapprochez-vous et réessayez.');
      }

      // Déverrouillage = RESTORE moteur. On NE touche PAS au planning horaire (preserveSchedule) :
      // le RESTORE est TRANSITOIRE et le scheduler reprend la main à la prochaine bascule sans être
      // interrompu (décision produit : un conducteur n'interrompt jamais le mode horaire de la flotte).
      await this.engineControl.requestCommand(
        vehicle.tracker.id,
        EngineAction.RESTORE,
        `Déverrouillage ${method} (conducteur, proximité déclarée ~${distanceM} m)`,
        { userId: user.id, role: user.role, fleetId: user.fleetId },
        'MANUAL',
        undefined, // disableSchedule : non
        true, // preserveSchedule : ne PAS interrompre le mode horaire
      );

      // Attribution : le conducteur (Driver lié à son compte) devient conducteur courant → trajets
      // suivants snappés. Best-effort (ne casse pas le déverrouillage).
      const driver = await this.prisma.driver.findFirst({
        where: { userId: user.id, fleetId: vehicle.fleetId, isActive: true },
        select: { id: true },
      });
      if (driver) {
        await this.prisma.vehicle
          .update({ where: { id: vehicleId }, data: { currentDriverId: driver.id } })
          .catch((e) => this.logger.warn(`currentDriver set failed: ${(e as Error).message}`));
      }

      // Traçabilité — action « qui déverrouille quoi, quand, comment » (journal Système, feed admin).
      // NB : la plaque + la distance sont journalisées CÔTÉ SERVEUR (audit), mais JAMAIS renvoyées
      // au conducteur (cf. réponse minimale ci-dessous).
      this.systemActivity.record({
        category: 'ENGINE',
        action: 'driver_unlock',
        status: 'SUCCESS',
        actor: 'conducteur',
        target: plate,
        detail: `Déverrouillage conducteur (${method}, proximité déclarée ~${distanceM} m)`,
        fleetId,
        triggeredByUserId: user.id,
        meta: { vehicleId, distanceM, method },
      });
      this.logger.log({ vehicleId, userId: user.id, distanceM, method }, 'Driver unlock OK');
      // Réponse VOLONTAIREMENT minimale : le conducteur ne voit qu'une confirmation, aucune donnée
      // flotte (plaque, distance, mode vie privée…). Décision produit « juste déverrouiller, pas d'info ».
      return { ok: true, message: 'Véhicule déverrouillé. Vous pouvez démarrer.' };
    } catch (err) {
      // Traçabilité des refus/échecs — motif dans le journal Système (status FAILURE). On ne pollue
      // PAS le centre d'alerte pour un refus ATTENDU (trop loin / non autorisé) ; les vraies pannes
      // moteur (dispatch impossible) y remontent déjà via EngineControlService.
      const reason = err instanceof Error ? err.message : String(err);
      this.systemActivity.record({
        category: 'ENGINE',
        action: 'driver_unlock',
        status: 'FAILURE',
        actor: 'conducteur',
        target: plate,
        detail: `Déverrouillage refusé (${method})`,
        fleetId,
        triggeredByUserId: user.id,
        meta: { vehicleId, method, ...(distanceM !== undefined ? { distanceM } : {}), error: reason },
      });
      throw err;
    }
  }
}
