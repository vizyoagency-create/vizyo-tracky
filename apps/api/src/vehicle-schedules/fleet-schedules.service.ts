import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  getVehicleConnectivityState,
  type BulkScheduleApplyResponse,
  type BulkSchedulePreviewResponse,
  type FleetScheduleListResponse,
  type FleetScheduleRowDto,
  type FleetSchedulePendingReason,
} from '@vizyo/tracky-shared';
import type { VehicleSchedule } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { VehiclesService, type RequestedBy } from '../vehicles/vehicles.service';
import { computeNextTransition, evaluateSchedule } from './schedule-evaluator';
import { VehicleSchedulesService } from './vehicle-schedules.service';
import type { UpsertVehicleScheduleDto } from './dto/upsert-vehicle-schedule.dto';
import type { BulkScheduleApplyDto } from './dto/bulk-schedule-apply.dto';

/** Même seuil que la coupe auto (engine-control) : véhicule « en mouvement » si vitesse > 5 km/h. */
const MOVING_SPEED_KMH = 5;
/** Fenêtre d'immobilité min avant coupe auto (miroir de engine-control ; défaut 10 min). */
const SCHEDULE_CUT_MIN_STOPPED_MS = Math.max(0, Number(process.env.SCHEDULE_CUT_MIN_STOPPED_S) || 600) * 1000;
/** Garde-fou VPS 2 vCPU : nb max de scans « dernier mouvement » par requête liste (le reste → eta non précis). */
const MAX_AWAITING_STOP_SCANS = 80;

interface TargetVehicle {
  id: string;
  plate: string | null;
  hasTracker: boolean;
}

/**
 * Demande CDEF (2026-07) — Modèle de lecture + actions de MASSE de la page flotte « Horaires ».
 *
 * Lecture : réutilise `VehiclesService.snapshot` (déjà scopé par tenant + accessibleVehicleIds,
 * mis en cache 15 s, avec la dérivation tri-état de la coupe) et l'enrichit de la config planning
 * + de l'état dérivé (fenêtre courante, prochaine bascule, « roule encore / en attente d'arrêt »).
 *
 * Écriture (bulk) : délègue au chemin per-véhicule `VehicleSchedulesService.upsert` (source unique
 * de vérité, même que la fiche véhicule) → aucun doublon, effets immédiats identiques.
 */
@Injectable()
export class FleetSchedulesService {
  private readonly logger = new Logger(FleetSchedulesService.name);

  // Revue perf : cache du « prochain » par véhicule. computeNextTransition (jusqu'à 8j min-par-min)
  // ne se recalcule que si le planning a été édité (updatedAt) OU si la bascule mise en cache est
  // passée. Borné par la taille de la flotte (clé = vehicleId).
  private readonly nextTransitionCache = new Map<
    string,
    { updatedAt: number; at: string | null; action: 'CUT' | 'RESTORE' | null }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicles: VehiclesService,
    private readonly schedules: VehicleSchedulesService,
    private readonly resolver: PermissionsResolverService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  // ─────────────────────────────────────────── LECTURE (liste flotte) ───────────────────────────────────────────

  async listForFleet(requestedBy: RequestedBy): Promise<FleetScheduleListResponse> {
    const now = new Date();
    const nowMs = now.getTime();

    // Réutilise le snapshot scopé/caché (télémétrie live + état coupe dérivé).
    const snap = await this.vehicles.snapshot(requestedBy);
    const vehicleIds = snap.map((s) => s.vehicleId);

    const schedules = vehicleIds.length
      ? await this.prisma.vehicleSchedule.findMany({ where: { vehicleId: { in: vehicleIds } } })
      : [];
    const byVehicle = new Map(schedules.map((s) => [s.vehicleId, s]));

    // 1er passage : construire les lignes + collecter les candidats « en attente d'arrêt »
    // (arrêtés, en ligne, hors plage, pas encore coupés) pour un scan borné du dernier mouvement.
    const rows: FleetScheduleRowDto[] = [];
    const awaitingScanByTracker: { row: FleetScheduleRowDto; trackerId: string }[] = [];

    for (const s of snap) {
      const sched = byVehicle.get(s.vehicleId) ?? null;
      const enabled = !!sched?.enabled;
      const overrideActive = !!(sched?.overrideUntil && sched.overrideUntil.getTime() > nowMs);

      const speed = s.lastSpeedKmh ?? 0;
      const moving = speed > MOVING_SPEED_KMH;

      const evalRes = enabled && sched ? evaluateSchedule(sched, now) : null;
      const windowState = evalRes?.state ?? null;

      // Prochaine bascule : seulement si planning actif ET non suspendu par un override.
      let nextTransitionAt: string | null = null;
      let nextTransitionAction: 'CUT' | 'RESTORE' | null = null;
      if (enabled && sched && !overrideActive) {
        const nt = this.cachedNextTransition(sched, now);
        nextTransitionAt = nt.at;
        nextTransitionAction = nt.action;
      }

      // Le planning « veut couper » (hors plage, non suspendu) mais le moteur n'est PAS encore coupé.
      const cutPending =
        enabled && !overrideActive && windowState === 'OUT_OF_WINDOW' && s.engineCutState === 'normal';

      let pendingReason: FleetSchedulePendingReason | null = null;
      if (cutPending) {
        if (moving) {
          pendingReason = 'DRIVING';
        } else {
          const conn = getVehicleConnectivityState(
            {
              trackerId: s.trackerId,
              lastSeenAt: s.lastSeenAt,
              lastPositionAt: s.lastPositionAt ?? null,
              lastIgnition: s.lastIgnition,
            },
            nowMs,
          );
          // En ligne + à l'arrêt → on attend la règle d'immobilité 10 min. Sinon la commande
          // ne peut pas être livrée (hors ligne / garé endormi / pas de boîtier).
          pendingReason = conn === 'ONLINE' || conn === 'AWAITING_GPS' ? 'AWAITING_STOP' : 'OFFLINE';
        }
      }

      const row: FleetScheduleRowDto = {
        vehicleId: s.vehicleId,
        fleetId: s.fleetId,
        plate: s.plate,
        brand: s.brand,
        model: s.model,
        group: s.group ?? null,
        trackerId: s.trackerId,
        hasTracker: !!s.trackerId,
        scheduleExists: !!sched,
        scheduleEnabled: enabled,
        timezone: sched?.timezone ?? null,
        windowDesc: evalRes?.windowDesc ?? null,
        windowState,
        overrideActive,
        overrideUntil: sched?.overrideUntil ? sched.overrideUntil.toISOString() : null,
        lastSpeedKmh: s.lastSpeedKmh,
        lastIgnition: s.lastIgnition,
        moving,
        lastPositionAt: s.lastPositionAt,
        lastSeenAt: s.lastSeenAt,
        engineCutState: s.engineCutState ?? null,
        nextTransitionAt,
        nextTransitionAction,
        cutPending,
        pendingReason,
        awaitingStopUntil: null,
      };
      rows.push(row);

      if (pendingReason === 'AWAITING_STOP' && s.trackerId) {
        awaitingScanByTracker.push({ row, trackerId: s.trackerId });
      }
    }

    // 2e passage borné : dernier mouvement (> 5 km/h) dans la fenêtre 10 min → eta d'arrêt précis.
    const truncated = awaitingScanByTracker.length > MAX_AWAITING_STOP_SCANS;
    const toScan = awaitingScanByTracker.slice(0, MAX_AWAITING_STOP_SCANS);
    if (SCHEDULE_CUT_MIN_STOPPED_MS > 0 && toScan.length > 0) {
      const windowStart = new Date(nowMs - SCHEDULE_CUT_MIN_STOPPED_MS);
      await Promise.all(
        toScan.map(async ({ row, trackerId }) => {
          const lastMove = await this.prisma.position
            .findFirst({
              where: { trackerId, speedKmh: { gt: MOVING_SPEED_KMH }, timestamp: { gte: windowStart } },
              orderBy: { timestamp: 'desc' },
              select: { timestamp: true },
            })
            .catch(() => null);
          if (lastMove) {
            // Coupe possible une fois immobile sur toute la fenêtre.
            row.awaitingStopUntil = new Date(lastMove.timestamp.getTime() + SCHEDULE_CUT_MIN_STOPPED_MS).toISOString();
          }
          // Sinon : immobile depuis ≥ la fenêtre → coupe imminente (awaitingStopUntil reste null).
        }),
      );
    }
    if (truncated) {
      this.logger.warn(
        { candidates: awaitingScanByTracker.length, scanned: MAX_AWAITING_STOP_SCANS },
        'Fleet schedules: awaiting-stop scan truncated (VPS guard)',
      );
    }

    return {
      items: rows,
      scheduleCutMinStoppedSec: Math.round(SCHEDULE_CUT_MIN_STOPPED_MS / 1000),
      serverNow: now.toISOString(),
      awaitingStopScanTruncated: truncated,
    };
  }

  // ─────────────────────────────────────────── APERÇU (avant bulk) ───────────────────────────────────────────

  async preview(user: AuthUser, dto: BulkScheduleApplyDto): Promise<BulkSchedulePreviewResponse> {
    const targets = await this.resolveTargets(user, dto.vehicleIds ?? null, dto.fleetId ?? null);
    const targetIds = new Set(targets.map((t) => t.id));

    // Télémétrie live pour classer l'effet immédiat (roule / à l'arrêt / hors ligne).
    const requestedBy = this.toRequestedBy(user);
    const snap = (await this.vehicles.snapshot(requestedBy)).filter((s) => targetIds.has(s.vehicleId));
    const snapByVehicle = new Map(snap.map((s) => [s.vehicleId, s]));

    const proto = this.buildScheduleShape(dto.schedule);
    const now = new Date();
    const nowMs = now.getTime();

    const res: BulkSchedulePreviewResponse = {
      total: targets.length,
      inWindowNow: 0,
      outOfWindowNow: 0,
      wouldCutNow: 0,
      wouldDeferDwell: 0,
      wouldDeferMoving: 0,
      wouldDeferOffline: 0,
      withoutTracker: 0,
    };

    // Candidats « en ligne + à l'arrêt + hors plage » : la coupe réelle applique la règle des
    // 10 min (engine-control SCHEDULER). On les scanne pour distinguer coupe immédiate vs différée.
    const dwellCandidates: string[] = [];

    for (const t of targets) {
      if (!t.hasTracker) {
        res.withoutTracker++;
        continue;
      }
      if (!dto.schedule.enabled) {
        // Désactivation en masse : aucune coupe ; on ne compte pas comme « dans la plage ».
        continue;
      }
      const state = evaluateSchedule(proto, now).state;
      if (state === 'IN_WINDOW') {
        res.inWindowNow++;
        continue;
      }
      res.outOfWindowNow++;
      const s = snapByVehicle.get(t.id);
      const moving = (s?.lastSpeedKmh ?? 0) > MOVING_SPEED_KMH;
      const conn = getVehicleConnectivityState(
        {
          trackerId: s?.trackerId ?? t.id,
          lastSeenAt: s?.lastSeenAt ?? null,
          lastPositionAt: s?.lastPositionAt ?? null,
          lastIgnition: s?.lastIgnition ?? null,
        },
        nowMs,
      );
      if (moving) res.wouldDeferMoving++;
      else if ((conn === 'ONLINE' || conn === 'AWAITING_GPS') && s?.trackerId) dwellCandidates.push(s.trackerId);
      else res.wouldDeferOffline++;
    }

    // Applique la règle des 10 min : arrêt < 10 min → différé, sinon coupé maintenant.
    if (dwellCandidates.length > 0 && SCHEDULE_CUT_MIN_STOPPED_MS > 0) {
      const windowStart = new Date(nowMs - SCHEDULE_CUT_MIN_STOPPED_MS);
      const scans = await Promise.all(
        dwellCandidates.slice(0, MAX_AWAITING_STOP_SCANS).map((trackerId) =>
          this.prisma.position
            .findFirst({
              where: { trackerId, speedKmh: { gt: MOVING_SPEED_KMH }, timestamp: { gte: windowStart } },
              orderBy: { timestamp: 'desc' },
              select: { id: true },
            })
            .catch(() => null),
        ),
      );
      for (const recentMovement of scans) {
        if (recentMovement) res.wouldDeferDwell++;
        else res.wouldCutNow++;
      }
      // Au-delà du plafond de scan : compté « coupé maintenant » par défaut (best-effort borné VPS).
      res.wouldCutNow += Math.max(0, dwellCandidates.length - MAX_AWAITING_STOP_SCANS);
    } else {
      res.wouldCutNow += dwellCandidates.length;
    }

    return res;
  }

  // ─────────────────────────────────────────── BULK (appliquer) ───────────────────────────────────────────

  async bulkApply(user: AuthUser, dto: BulkScheduleApplyDto): Promise<BulkScheduleApplyResponse> {
    const targets = await this.resolveTargets(user, dto.vehicleIds ?? null, dto.fleetId ?? null);
    const requestedBy = this.toRequestedBy(user);
    const results: BulkScheduleApplyResponse['results'] = [];

    // SÉQUENTIEL volontaire (VPS 2 vCPU) : un for-await, pas un Promise.all — évite un burst
    // de dizaines de commandes moteur / dispatch TCP simultanés lors d'une activation de masse.
    for (const t of targets) {
      try {
        const updated = await this.schedules.upsert(
          t.id,
          dto.schedule as unknown as UpsertVehicleScheduleDto,
          requestedBy,
        );
        results.push({ vehicleId: t.id, plate: t.plate, ok: true, immediate: this.classifyImmediate(updated) });
      } catch (err) {
        this.logger.warn({ vehicleId: t.id, error: (err as Error).message }, 'Bulk schedule apply: vehicle failed');
        results.push({ vehicleId: t.id, plate: t.plate, ok: false, error: (err as Error).message });
      }
    }

    const applied = results.filter((r) => r.ok).length;
    return { total: targets.length, applied, failed: results.length - applied, results };
  }

  // ─────────────────────────────────────────── Internes ───────────────────────────────────────────

  /** Prochaine bascule mise en cache par (véhicule, updatedAt) — cf. nextTransitionCache. */
  private cachedNextTransition(sched: VehicleSchedule, now: Date): { at: string | null; action: 'CUT' | 'RESTORE' | null } {
    const updatedAt = sched.updatedAt.getTime();
    const hit = this.nextTransitionCache.get(sched.vehicleId);
    if (hit && hit.updatedAt === updatedAt && (hit.at === null || new Date(hit.at).getTime() > now.getTime())) {
      return { at: hit.at, action: hit.action };
    }
    const nt = computeNextTransition(sched, now);
    const entry = { updatedAt, at: nt ? nt.at.toISOString() : null, action: nt ? nt.action : null };
    this.nextTransitionCache.set(sched.vehicleId, entry);
    return { at: entry.at, action: entry.action };
  }

  private toRequestedBy(user: AuthUser): RequestedBy {
    return { userId: user.id, role: user.role, fleetId: user.fleetId };
  }

  /**
   * Résout les véhicules cibles d'une action de masse, DOUBLE gate :
   *  1) périmètre tenant + accès (accessibleVehicleIds) — l'appelant ne voit que son périmètre ;
   *  2) permission `schedules_manage` résolue PAR véhicule (VEHICLE > GROUP > ALL) — un opérateur
   *     scopé ne peut modifier que les véhicules qu'il gère. Admins (SA/FA) → tout leur tenant.
   */
  private async resolveTargets(
    user: AuthUser,
    vehicleIds: string[] | null,
    fleetId: string | null,
  ): Promise<TargetVehicle[]> {
    const where: Prisma.VehicleWhereInput = {};
    if (user.role === UserRole.SUPER_ADMIN) {
      // GARDE ANTI-CATASTROPHE (revue prod) : un super-admin voit toutes les flottes ; une action
      // de masse SANS flotte ni véhicules explicites toucherait TOUTES les flottes. On l'INTERDIT :
      // il doit choisir une flotte (filtre société) ou fournir des véhicules précis.
      if (fleetId) {
        where.fleetId = fleetId;
      } else if (!vehicleIds || vehicleIds.length === 0) {
        throw new BadRequestException(
          'Sélectionnez une société/flotte (filtre en haut) avant d\'appliquer des horaires en masse.',
        );
      }
    } else {
      if (!user.fleetId) return []; // fail-closed
      where.fleetId = user.fleetId; // non-super : toujours scopé à sa flotte (fleetId param ignoré)
    }
    if (vehicleIds && vehicleIds.length > 0) where.id = { in: vehicleIds };

    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: { id: true, plate: true, tracker: { select: { id: true } } },
    });
    if (vehicles.length === 0) return [];

    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const permsMap = await this.resolver.resolveForVehicles(
      user,
      vehicles.map((v) => v.id),
    );

    return vehicles
      .filter((v) => {
        const inScope = accessible === 'ALL' || accessible.includes(v.id);
        const perms = permsMap.get(v.id);
        return inScope && perms?.schedules_manage === true;
      })
      .map((v) => ({ id: v.id, plate: v.plate, hasTracker: !!v.tracker }));
  }

  /** Effet immédiat de l'upsert, lu sur l'état fraîchement évalué renvoyé par le service. */
  private classifyImmediate(updated: VehicleSchedule): 'cut' | 'deferred' | 'none' {
    if (!updated.enabled) return 'none';
    if (updated.lastEvaluatedState === 'OUT_OF_WINDOW') return 'cut'; // coupe immédiate réussie
    if (updated.lastEvaluatedState === 'IN_WINDOW') return 'none'; // dans la plage, rien à couper
    // enabled mais state non avancé → coupe voulue mais différée (véhicule roule / arrêt trop récent).
    const state = evaluateSchedule(updated).state;
    return state === 'OUT_OF_WINDOW' ? 'deferred' : 'none';
  }

  /**
   * Construit un objet façon `VehicleSchedule` à partir du DTO bulk pour l'évaluer (aperçu).
   * Remplit des défauts alignés sur les défauts Prisma pour les champs omis.
   */
  private buildScheduleShape(dto: UpsertVehicleScheduleDto): VehicleSchedule {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
    const base: Record<string, unknown> = {
      id: 'preview',
      vehicleId: 'preview',
      enabled: dto.enabled,
      timezone: dto.timezone ?? 'Europe/Paris',
      countryCode: dto.countryCode ?? 'FR',
      customDates: dto.customDates ?? null,
      lastEvaluatedAt: null,
      lastEvaluatedState: null,
      overrideUntil: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const weekendDefaultOff = new Set(['saturday', 'sunday']);
    for (const d of days) {
      const enabledKey = `${d}Enabled` as keyof UpsertVehicleScheduleDto;
      base[`${d}Enabled`] =
        dto[enabledKey] !== undefined ? (dto[enabledKey] as boolean) : !weekendDefaultOff.has(d);
      base[`${d}Start`] = (dto[`${d}Start` as keyof UpsertVehicleScheduleDto] as string | undefined) ?? null;
      base[`${d}End`] = (dto[`${d}End` as keyof UpsertVehicleScheduleDto] as string | undefined) ?? null;
      base[`${d}Slots`] = (dto[`${d}Slots` as keyof UpsertVehicleScheduleDto] as unknown) ?? null;
    }
    return base as unknown as VehicleSchedule;
  }
}
