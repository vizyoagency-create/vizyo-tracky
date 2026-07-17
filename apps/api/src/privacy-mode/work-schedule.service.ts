import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { resolveEffectivePrivacy, type EffectivePrivacy } from './effective-privacy';
import type { SetWorkScheduleDto } from './dto/set-work-schedule.dto';

type Actor = { userId: string | null; role?: UserRole; fleetId?: string | null };

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/**
 * Incr.5 RGPD — CADRE de temps de travail par véhicule (usage mixte). Défini par le fleet-admin
 * (l'employeur déclare le temps de travail) ; hors des plages = mode privé automatique à
 * l'ingestion (cf. resolveEffectivePrivacy). Toute édition du cadre est AUDITÉE (journal Système +
 * `PrivacyModeEvent` → visible du conducteur via l'historique). Le conducteur ne peut PAS l'éditer.
 * Toute erreur inattendue est remontée au centre d'alerte (source `work-schedule`).
 */
@Injectable()
export class WorkScheduleService {
  private readonly logger = new Logger(WorkScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly errors: ErrorLogger,
  ) {}

  /** Tenant (anti cross-fleet) : un non-super n'accède qu'aux véhicules de SA flotte. */
  private assertTenant(fleetId: string, actor?: Actor): void {
    if (!actor || actor.role === UserRole.SUPER_ADMIN) return;
    if (actor.fleetId !== fleetId) throw new NotFoundException('Véhicule introuvable.');
  }

  /** Erreur inattendue → centre d'alerte (non bloquant) + propagation. */
  private recordError(err: unknown, vehicleId: string, actor: Actor): void {
    const message = err instanceof Error ? err.message : String(err);
    this.errors
      .record(err instanceof Error ? err : new Error(message), 'work-schedule', { vehicleId, userId: actor.userId ?? undefined }, 'ERROR')
      .catch((e) => this.logger.error('ErrorLogger persist failed', e));
  }

  /** Lit le cadre + l'état de confidentialité EFFECTIF courant (pour l'UI admin ET conducteur). */
  async get(vehicleId: string, actor: Actor): Promise<{
    vehicleId: string;
    schedule: Prisma.VehicleWorkScheduleGetPayload<object> | null;
    effective: EffectivePrivacy;
  }> {
    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { id: true, fleetId: true, privacyModeEnabled: true, workOverrideUntil: true, workSchedule: true },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
      this.assertTenant(vehicle.fleetId, actor);
      return {
        vehicleId: vehicle.id,
        schedule: vehicle.workSchedule,
        effective: resolveEffectivePrivacy(vehicle, vehicle.workSchedule, new Date()),
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err; // refus attendu (introuvable / hors-flotte)
      this.recordError(err, vehicleId, actor);
      throw err;
    }
  }

  /** Crée/met à jour le cadre. Réservé au cadre (fleet-admin/gestionnaire) — jamais au conducteur. */
  async set(vehicleId: string, dto: SetWorkScheduleDto, actor: Actor): Promise<{ ok: true }> {
    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { id: true, fleetId: true, plate: true },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
      this.assertTenant(vehicle.fleetId, actor);

      // Mappe le DTO { enabled, timezone, days:{monday:{...}} } vers les colonnes du modèle.
      const data: Record<string, unknown> = { enabled: dto.enabled };
      if (dto.timezone) data.timezone = dto.timezone;
      if (dto.countryCode !== undefined) data.countryCode = dto.countryCode;
      for (const d of DAYS) {
        const day = dto.days?.[d];
        if (!day) continue;
        if (day.enabled !== undefined) data[`${d}Enabled`] = day.enabled;
        if (day.start !== undefined) data[`${d}Start`] = day.start;
        if (day.end !== undefined) data[`${d}End`] = day.end;
        if (day.slots !== undefined) data[`${d}Slots`] = day.slots ?? Prisma.JsonNull;
      }

      await this.prisma.vehicleWorkSchedule.upsert({
        where: { vehicleId },
        create: { ...data, vehicleId } as Prisma.VehicleWorkScheduleUncheckedCreateInput,
        update: data as Prisma.VehicleWorkScheduleUncheckedUpdateInput,
      });

      // Audit — « qui modifie le cadre, quand » : journal Système (feed admin) + PrivacyModeEvent
      // (même timeline que les bascules → VISIBLE DU CONDUCTEUR via l'historique). Ligne rouge (b) :
      // aucune modification silencieuse du cadre d'un conducteur.
      await this.prisma.privacyModeEvent.create({
        data: {
          vehicleId,
          fleetId: vehicle.fleetId,
          enabled: dto.enabled,
          reason: `Cadre de temps de travail ${dto.enabled ? 'mis à jour' : 'désactivé'}`,
          userId: actor.userId,
        },
      });
      this.systemActivity.record({
        category: 'PRIVACY',
        action: 'work_schedule_updated',
        status: 'SUCCESS',
        actor: actor.role === UserRole.DRIVER ? 'conducteur' : 'opérateur',
        target: vehicle.plate,
        detail: `Cadre de temps de travail ${dto.enabled ? 'activé/mis à jour' : 'désactivé'}`,
        fleetId: vehicle.fleetId,
        triggeredByUserId: actor.userId,
        meta: { vehicleId },
      });

      this.logger.log({ vehicleId, enabled: dto.enabled, by: actor.userId }, 'Work schedule updated');
      return { ok: true };
    } catch (err) {
      if (err instanceof NotFoundException) throw err; // refus attendu — pas une panne
      this.recordError(err, vehicleId, actor);
      throw err;
    }
  }
}
