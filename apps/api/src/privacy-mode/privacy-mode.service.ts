import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  PrivacyModeEventDto,
  PrivacyModeStateDto,
  SetPrivacyModeRequestDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { isWithinWorkHours } from './effective-privacy';

/**
 * Auteur d'une bascule/lecture. `role`/`fleetId` servent au contrôle de tenant (anti
 * cross-fleet, cf. revue adversariale) et au libellé d'acteur du feed (« conducteur » vs
 * « opérateur »). Optionnels : absents sur les ré-lectures internes déjà tenant-vérifiées.
 */
type Actor = { userId: string | null; role?: UserRole; fleetId?: string | null };

/**
 * Mode vie privée conducteur (par véhicule). Bascule ON/OFF la PAUSE de collecte
 * des positions : quand ON, `PositionsService.ingest()` jette les trames du véhicule
 * (aucune position stockée/diffusée). Chaque bascule est TRACÉE : état courant sur le
 * véhicule + historique (`PrivacyModeEvent`) + feed « Système ». Toute erreur est
 * journalisée dans le centre d'alerte (source `privacy-mode`).
 */
@Injectable()
export class PrivacyModeService {
  private readonly logger = new Logger(PrivacyModeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly errors: ErrorLogger,
  ) {}

  private async nameOf(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!u) return null;
    return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || null;
  }

  /**
   * Garde de tenant (anti cross-fleet IDOR) : un non-super ne peut lire/agir que sur un
   * véhicule de SA flotte. `canOnVehicle` (scope ALL) ne borne PAS la flotte et
   * `UserVehicleAccess` n'a pas de colonne fleetId → on re-vérifie ici, exactement comme
   * EngineControlService et VehiclesService.findOne. 404 (ne révèle pas l'existence).
   */
  private assertTenant(vehicleFleetId: string, actor?: Actor): void {
    if (!actor || actor.role === UserRole.SUPER_ADMIN) return;
    if (actor.fleetId !== vehicleFleetId) throw new NotFoundException('Véhicule introuvable.');
  }

  async getState(vehicleId: string, actor?: Actor): Promise<PrivacyModeStateDto> {
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, fleetId: true, privacyModeEnabled: true, privacyModeSince: true, privacyModeById: true, privacyModeNote: true },
    });
    if (!v) throw new NotFoundException('Véhicule introuvable.');
    this.assertTenant(v.fleetId, actor);
    return {
      vehicleId: v.id,
      enabled: v.privacyModeEnabled,
      since: v.privacyModeSince ? v.privacyModeSince.toISOString() : null,
      byUserId: v.privacyModeById,
      byName: await this.nameOf(v.privacyModeById),
      note: v.privacyModeNote,
    };
  }

  async getHistory(vehicleId: string, limit = 30, actor?: Actor): Promise<PrivacyModeEventDto[]> {
    // Tenant (anti cross-fleet) : l'historique porte des données personnelles (auteur, note, horodatage).
    const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { fleetId: true } });
    if (!v) throw new NotFoundException('Véhicule introuvable.');
    this.assertTenant(v.fleetId, actor);
    const rows = await this.prisma.privacyModeEvent.findMany({
      where: { vehicleId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    // Résout les noms d'auteurs en une passe.
    const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
      : [];
    const byName = new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || null]));
    return rows.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      reason: r.reason,
      userId: r.userId,
      byName: r.userId ? byName.get(r.userId) ?? null : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async setPrivacyMode(vehicleId: string, dto: SetPrivacyModeRequestDto, actor: Actor): Promise<PrivacyModeStateDto> {
    const reason = dto.reason?.trim() || null;
    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: {
          id: true,
          fleetId: true,
          plate: true,
          privacyModeEnabled: true,
          workSchedule: true,
          currentDriver: { select: { userId: true } },
        },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
      this.assertTenant(vehicle.fleetId, actor);

      // Incr.4 — contraintes CONDUCTEUR : (1) borné à SON véhicule courant (celui qu'il conduit),
      // même s'il porte privacy_manage sur un scope large → ferme le cas de bord IDOR ; (2) il ne
      // peut JAMAIS privatiser une plage déclarée temps de travail (droit de l'employeur). Les
      // admins/gestionnaires (qui définissent le cadre) ne sont pas bornés.
      if (actor.role === UserRole.DRIVER) {
        if (!actor.userId || vehicle.currentDriver?.userId !== actor.userId) {
          throw new ForbiddenException('Vous ne pouvez gérer que le véhicule que vous conduisez.');
        }
        if (dto.enabled && isWithinWorkHours(vehicle.workSchedule)) {
          throw new ForbiddenException(
            "Cette plage est déclarée temps de travail : le passage en mode privé n'est pas autorisé.",
          );
        }
      }

      // Idempotent : même état demandé → pas de nouvel événement (pas de bruit).
      if (vehicle.privacyModeEnabled === dto.enabled) return this.getState(vehicleId);

      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.vehicle.update({
          where: { id: vehicleId },
          data: {
            privacyModeEnabled: dto.enabled,
            privacyModeSince: dto.enabled ? now : null,
            privacyModeById: actor.userId,
            privacyModeNote: reason,
          },
        }),
        this.prisma.privacyModeEvent.create({
          data: { vehicleId, fleetId: vehicle.fleetId, enabled: dto.enabled, reason, userId: actor.userId },
        }),
      ]);

      this.systemActivity.record({
        category: 'PRIVACY',
        action: dto.enabled ? 'privacy_enabled' : 'privacy_disabled',
        status: 'SUCCESS',
        // Libellé lisible du feed : reflète le rôle réel (un conducteur gère SON véhicule).
        actor: actor.role === UserRole.DRIVER ? 'conducteur' : 'opérateur',
        target: vehicle.plate,
        detail: dto.enabled
          ? `Mode vie privée ACTIVÉ (collecte des positions en pause)${reason ? ` — ${reason}` : ''}`
          : `Mode vie privée DÉSACTIVÉ (reprise de la collecte)${reason ? ` — ${reason}` : ''}`,
        fleetId: vehicle.fleetId,
        triggeredByUserId: actor.userId,
        meta: { vehicleId, enabled: dto.enabled },
      });

      return this.getState(vehicleId);
    } catch (err) {
      // Refus ATTENDUS (introuvable / hors-périmètre / plage de travail) → on propage sans polluer
      // le centre d'alerte (réservé aux vraies pannes).
      if (err instanceof NotFoundException || err instanceof ForbiddenException) throw err;
      // Erreur inattendue → centre d'alerte (source repérable) + on propage.
      const message = err instanceof Error ? err.message : String(err);
      this.errors
        .record(err instanceof Error ? err : new Error(message), 'privacy-mode', { vehicleId, userId: actor.userId ?? undefined }, 'ERROR')
        .catch((e) => this.logger.error('ErrorLogger persist failed', e));
      throw err;
    }
  }
}
