import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  PrivacyModeEventDto,
  PrivacyModeStateDto,
  SetPrivacyModeRequestDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Auteur d'une bascule (opérateur authentifié, ou null si système/auto). */
type Actor = { userId: string | null };

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

  async getState(vehicleId: string): Promise<PrivacyModeStateDto> {
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, privacyModeEnabled: true, privacyModeSince: true, privacyModeById: true, privacyModeNote: true },
    });
    if (!v) throw new NotFoundException('Véhicule introuvable.');
    return {
      vehicleId: v.id,
      enabled: v.privacyModeEnabled,
      since: v.privacyModeSince ? v.privacyModeSince.toISOString() : null,
      byUserId: v.privacyModeById,
      byName: await this.nameOf(v.privacyModeById),
      note: v.privacyModeNote,
    };
  }

  async getHistory(vehicleId: string, limit = 30): Promise<PrivacyModeEventDto[]> {
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
        select: { id: true, fleetId: true, plate: true, privacyModeEnabled: true },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');

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
        actor: 'opérateur',
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
      if (err instanceof NotFoundException) throw err;
      // Erreur inattendue → centre d'alerte (source repérable) + on propage.
      const message = err instanceof Error ? err.message : String(err);
      this.errors
        .record(err instanceof Error ? err : new Error(message), 'privacy-mode', { vehicleId, userId: actor.userId ?? undefined }, 'ERROR')
        .catch((e) => this.logger.error('ErrorLogger persist failed', e));
      throw err;
    }
  }
}
