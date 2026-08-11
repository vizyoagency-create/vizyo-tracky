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
    mixedUseEnabled: boolean;
    schedule: Prisma.VehicleWorkScheduleGetPayload<object> | null;
    effective: EffectivePrivacy;
  }> {
    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { id: true, fleetId: true, mixedUseEnabled: true, privacyModeEnabled: true, workOverrideUntil: true, workSchedule: true },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
      this.assertTenant(vehicle.fleetId, actor);
      return {
        vehicleId: vehicle.id,
        mixedUseEnabled: vehicle.mixedUseEnabled,
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

  /**
   * Lot 2 — déclare (ou retire) l'USAGE MIXTE d'un véhicule. C'est l'interrupteur de
   * proportionnalité : sans lui, aucune bascule privée n'a d'effet (le véhicule reste tracé 24/7,
   * antivol actif). Réservé au cadre (fleet-admin/gestionnaire, `schedules_manage`).
   *
   * Effet de bord VOULU quand on retire l'usage mixte : le véhicule redevient traçable — on
   * désactive donc aussi le privé manuel éventuel pour que l'état affiché reste vrai (jamais un
   * véhicule marqué « privé » alors que ses positions sont collectées). Journalisé des deux côtés
   * (journal Système + PrivacyModeEvent visible du conducteur) : aucune modification silencieuse.
   *
   * ⚠️ Aucune rétro-activation : les positions déjà écartées ne réapparaissent pas, et celles déjà
   * collectées ne sont pas requalifiées. Le changement ne vaut que pour l'avenir (gate d'ingestion).
   */
  async setMixedUse(vehicleId: string, enabled: boolean, actor: Actor): Promise<{ ok: true; mixedUseEnabled: boolean }> {
    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { id: true, fleetId: true, plate: true, mixedUseEnabled: true, privacyModeEnabled: true },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
      this.assertTenant(vehicle.fleetId, actor);
      if (vehicle.mixedUseEnabled === enabled) return { ok: true, mixedUseEnabled: enabled }; // idempotent

      await this.prisma.$transaction([
        this.prisma.vehicle.update({
          where: { id: vehicleId },
          // Retrait de l'usage mixte → on lève aussi le privé manuel (sinon état mensonger).
          data: enabled
            ? { mixedUseEnabled: true }
            : { mixedUseEnabled: false, privacyModeEnabled: false, privacyModeSince: null, privacyModeNote: null },
        }),
        this.prisma.privacyModeEvent.create({
          data: {
            vehicleId,
            fleetId: vehicle.fleetId,
            enabled,
            reason: enabled
              ? 'Usage mixte ACTIVÉ — hors temps de travail, aucune position ne sera enregistrée'
              : 'Usage mixte RETIRÉ — le véhicule redevient suivi en permanence',
            userId: actor.userId,
          },
        }),
      ]);

      this.systemActivity.record({
        category: 'PRIVACY',
        action: enabled ? 'mixed_use_enabled' : 'mixed_use_disabled',
        status: 'SUCCESS',
        actor: 'opérateur',
        target: vehicle.plate,
        detail: enabled
          ? "Usage mixte activé : hors des plages de temps de travail, plus aucune position n'est collectée"
          : 'Usage mixte retiré : le véhicule est de nouveau suivi 24/7 (antivol actif)',
        fleetId: vehicle.fleetId,
        triggeredByUserId: actor.userId,
        meta: { vehicleId, mixedUseEnabled: enabled },
      });
      this.logger.log({ vehicleId, enabled, by: actor.userId }, 'Mixed-use flag updated');
      return { ok: true, mixedUseEnabled: enabled };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.recordError(err, vehicleId, actor);
      throw err;
    }
  }

  /**
   * Lot 2 — COUVERTURE vie privée de la flotte : quels véhicules sont réellement protégés, et
   * lesquels ne le sont pas. L'absence de protection doit être VISIBLE, jamais silencieuse.
   * Fleet-scopé (un non-super ne voit que sa flotte).
   */
  async coverage(actor: Actor): Promise<{
    items: Array<{
      vehicleId: string;
      plate: string;
      fleetName: string;
      mixedUseEnabled: boolean;
      hasSchedule: boolean;
      scheduleEnabled: boolean;
      driverName: string | null;
      status: 'PROTEGE' | 'MIXTE_SANS_CADRE' | 'NON_COUVERT';
    }>;
    total: number;
    protectedCount: number;
    uncoveredCount: number;
  }> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: actor.role === UserRole.SUPER_ADMIN ? {} : { fleetId: actor.fleetId ?? '__none__' },
      select: {
        id: true,
        plate: true,
        mixedUseEnabled: true,
        fleet: { select: { name: true } },
        workSchedule: { select: { enabled: true } },
        currentDriver: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ plate: 'asc' }],
    });

    const items = vehicles.map((v) => {
      const hasSchedule = !!v.workSchedule;
      const scheduleEnabled = !!v.workSchedule?.enabled;
      // PROTEGE = usage mixte déclaré ET cadre actif (les deux conditions du gate d'ingestion).
      // MIXTE_SANS_CADRE = usage mixte déclaré mais aucun cadre actif → le véhicule reste
      // TRACÉ 24/7. Ce commentaire disait « serait privé en permanence » : c'est l'inverse.
      // Cf. resolveEffectivePrivacy, précédence n° 4 — sans cadre, on ne coupe jamais le
      // suivi, donc rien n'est protégé. La distinction compte : un cadre ACTIF mais vide
      // (enabled=true, aucun jour) rend bien le véhicule privé en permanence, lui.
      const status: 'PROTEGE' | 'MIXTE_SANS_CADRE' | 'NON_COUVERT' = v.mixedUseEnabled
        ? scheduleEnabled ? 'PROTEGE' : 'MIXTE_SANS_CADRE'
        : 'NON_COUVERT';
      return {
        vehicleId: v.id,
        plate: v.plate,
        fleetName: v.fleet?.name ?? '—',
        mixedUseEnabled: v.mixedUseEnabled,
        hasSchedule,
        scheduleEnabled,
        driverName: v.currentDriver ? `${v.currentDriver.firstName} ${v.currentDriver.lastName}`.trim() : null,
        status,
      };
    });

    return {
      items,
      total: items.length,
      protectedCount: items.filter((i) => i.status === 'PROTEGE').length,
      uncoveredCount: items.filter((i) => i.status !== 'PROTEGE').length,
    };
  }
}
