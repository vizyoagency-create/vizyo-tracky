import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint H4) — Historique des positions avec compaction adaptative.
 *
 * Strategie a 3 niveaux :
 *   - `detail = fine`           → table `positions` brute (max 90j de retention).
 *   - `detail = compact`        → polylignes Douglas-Peucker (epsilon 5m) deja
 *                                 calculees sur les trips clos (`Trip.polyline`).
 *                                 Garde la trace visuellement fidele en zone
 *                                 urbaine, mais 5-10x moins de points.
 *   - `detail = auto` (defaut)  → fine si range < 24h, compact au-dela.
 *
 * Job de purge nocturne : supprime `positions` > 90 jours pour eviter la
 * croissance lineaire. Les trips clos conservent leur polyline compactee
 * indefiniment (cout marginal vs le volume positions).
 */

const FINE_RANGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const FINE_RETENTION_DAYS = 90;

interface RequestedBy {
  role: UserRole | string;
  fleetId: string | null;
}

@Injectable()
export class PositionHistoryService {
  private readonly logger = new Logger(PositionHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async history(
    requestedBy: RequestedBy,
    params: {
      trackerId?: string;
      vehicleId?: string;
      from: string;
      to: string;
      detail?: 'auto' | 'fine' | 'compact';
    },
  ): Promise<{
    detail: 'fine' | 'compact';
    points: { lat: number; lng: number; timestamp?: string; speedKmh?: number }[];
    trips?: { id: string; startedAt: string; endedAt: string | null; pointCount: number }[];
  }> {
    if (!params.from || !params.to) {
      throw new BadRequestException('from et to (ISO datetime) requis');
    }
    const from = new Date(params.from);
    const to = new Date(params.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from / to doivent etre des ISO datetime valides');
    }

    let trackerId = params.trackerId;
    let vehicleId = params.vehicleId;

    // Resolve tracker/vehicle + tenant check
    if (!trackerId && !vehicleId) {
      throw new BadRequestException('trackerId ou vehicleId requis');
    }
    if (!trackerId && vehicleId) {
      const v = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        include: { tracker: true },
      });
      if (!v) throw new NotFoundException('Vehicule introuvable');
      if (requestedBy.role !== UserRole.SUPER_ADMIN && v.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Acces refuse');
      }
      trackerId = v.tracker?.id;
      if (!trackerId) {
        return { detail: 'fine', points: [] };
      }
    } else if (trackerId) {
      const t = await this.prisma.tracker.findUnique({
        where: { id: trackerId },
        include: { vehicle: true },
      });
      if (!t) throw new NotFoundException('Tracker introuvable');
      if (requestedBy.role !== UserRole.SUPER_ADMIN) {
        if (!t.vehicle || t.vehicle.fleetId !== requestedBy.fleetId) {
          throw new ForbiddenException('Acces refuse');
        }
      }
      vehicleId = t.vehicle?.id;
    }

    const rangeMs = to.getTime() - from.getTime();
    const detail = this.resolveDetail(params.detail, rangeMs);

    if (detail === 'fine') {
      const positions = await this.prisma.position.findMany({
        where: { trackerId, timestamp: { gte: from, lte: to }, valid: true },
        orderBy: { timestamp: 'asc' },
        take: 50_000,
      });
      return {
        detail: 'fine',
        points: positions.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          timestamp: p.timestamp.toISOString(),
          speedKmh: p.speedKmh,
        })),
      };
    }

    // detail === 'compact' — agrege les Trip.polyline qui chevauchent la fenetre.
    if (!vehicleId) {
      return { detail: 'compact', points: [] };
    }
    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        endedAt: { not: null },
        startedAt: { lte: to },
        OR: [{ endedAt: { gte: from } }, { endedAt: null }],
      },
      orderBy: { startedAt: 'asc' },
      take: 500,
    });

    const points: { lat: number; lng: number }[] = [];
    const tripsMeta: { id: string; startedAt: string; endedAt: string | null; pointCount: number }[] = [];

    for (const trip of trips) {
      let parsed: { lat: number; lng: number }[] = [];
      try {
        parsed = trip.polyline ? (JSON.parse(trip.polyline) as { lat: number; lng: number }[]) : [];
      } catch {
        continue;
      }
      if (parsed.length === 0) continue;
      points.push(...parsed);
      tripsMeta.push({
        id: trip.id,
        startedAt: trip.startedAt.toISOString(),
        endedAt: trip.endedAt?.toISOString() ?? null,
        pointCount: parsed.length,
      });
    }

    return { detail: 'compact', points, trips: tripsMeta };
  }

  private resolveDetail(req: 'auto' | 'fine' | 'compact' | undefined, rangeMs: number): 'fine' | 'compact' {
    if (req === 'fine' || req === 'compact') return req;
    return rangeMs <= FINE_RANGE_THRESHOLD_MS ? 'fine' : 'compact';
  }

  /**
   * Job de purge nocturne : supprime les positions brutes au-dela de 90 jours.
   * Les Trip.polyline conservent la trace compactee indefiniment.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOldFinePositions(): Promise<void> {
    const cutoff = new Date(Date.now() - FINE_RETENTION_DAYS * 24 * 3600 * 1000);
    const result = await this.prisma.position.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });
    this.logger.log(
      `Purge positions: ${result.count} lignes supprimees (anterieures a ${cutoff.toISOString()})`,
    );
  }
}
