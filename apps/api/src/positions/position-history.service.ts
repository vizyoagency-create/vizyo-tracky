import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint H4) — Historique des positions avec compaction adaptative.
 *
 * Strategie a 3 niveaux :
 *   - `detail = fine`           → table `positions` brute (retention env via DataRetentionService).
 *   - `detail = compact`        → polylignes Douglas-Peucker (epsilon 5m) deja
 *                                 calculees sur les trips clos (`Trip.polyline`).
 *                                 Garde la trace visuellement fidele en zone
 *                                 urbaine, mais 5-10x moins de points.
 *   - `detail = auto` (defaut)  → fine si range < 24h, compact au-dela.
 *
 * Retention de `positions` : geree UNIQUEMENT par `DataRetentionService`
 * (env-pilotee `POSITIONS_RETENTION_DAYS`, suppression PAR LOTS). L'ancien cron
 * 90j hardcode ici faisait double emploi (il supprimait en silence malgre le
 * contrat "retention infinie par defaut") et prenait un lock long (deleteMany
 * non borne) — il a ete retire (audit #4 / #15).
 */

const FINE_RANGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
// V1.10 (Sprint 6) — caps pour le mode fine.
//   MAX_FINE_POINTS_OUT : nombre max de points renvoyes au frontend. Au-dela,
//   le client commence a freezer (parse JSON + render layer polyline). 5000
//   est un compromis : visuellement riche, payload ~400 KB, parse < 50ms.
//   FORCE_COMPACT_ABOVE_MS : si le user demande detail=fine sur une fenetre
//   plus large que 14j, on force compact. Au-dela, meme downsample reste
//   pesant (transfert + parse), et les polylines Trip donnent un meilleur
//   visuel (Douglas-Peucker deja applique a la cloture du trip).
const MAX_FINE_POINTS_OUT = 5000;
const FORCE_COMPACT_ABOVE_MS = 14 * 24 * 60 * 60 * 1000;

interface RequestedBy {
  role: UserRole | string;
  fleetId: string | null;
  /** Liste des vehicleIds accessibles, ou 'ALL' = aucun filtre granulaire. */
  accessibleVehicleIds?: string[] | 'ALL';
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
      throw new BadRequestException('from / to doivent être des ISO datetime valides');
    }

    let trackerId = params.trackerId;
    let vehicleId = params.vehicleId;
    // Mode vie privée (RGPD) : renseigné à la résolution du véhicule ci-dessous.
    let privacyOn = false;
    const scopedIds =
      requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
        ? requestedBy.accessibleVehicleIds
        : null;

    // Resolve tracker/vehicle + tenant check (filtre fleetId integre au where).
    if (!trackerId && !vehicleId) {
      throw new BadRequestException('trackerId ou vehicleId requis');
    }
    if (!trackerId && vehicleId) {
      const vehicleWhere: Prisma.VehicleWhereInput = { id: vehicleId };
      if (requestedBy.role !== UserRole.SUPER_ADMIN) {
        if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
        vehicleWhere.fleetId = requestedBy.fleetId;
      }
      if (scopedIds && !scopedIds.includes(vehicleId)) {
        throw new NotFoundException('Véhicule introuvable');
      }
      const v = await this.prisma.vehicle.findFirst({
        where: vehicleWhere,
        include: { tracker: true },
      });
      if (!v) throw new NotFoundException('Véhicule introuvable');
      privacyOn = v.privacyModeEnabled;
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
          throw new NotFoundException('Tracker introuvable');
        }
      }
      if (scopedIds && t.vehicle && !scopedIds.includes(t.vehicle.id)) {
        throw new NotFoundException('Tracker introuvable');
      }
      vehicleId = t.vehicle?.id;
      privacyOn = !!t.vehicle?.privacyModeEnabled;
    }

    // Mode vie privée (RGPD) — masque tout l'historique du véhicule tant qu'il est actif.
    if (privacyOn) {
      return { detail: 'fine', points: [] };
    }

    const rangeMs = to.getTime() - from.getTime();
    let detail = this.resolveDetail(params.detail, rangeMs);

    // V1.10 (Sprint 6) — garde-fou : un user qui force detail=fine sur > 14j
    // recoit le mode compact malgre lui. Sinon on chargeait potentiellement
    // 100k+ positions, browser freeze garanti.
    if (detail === 'fine' && rangeMs > FORCE_COMPACT_ABOVE_MS) {
      this.logger.log(`Range > 14j with detail=fine, forcing compact (rangeMs=${rangeMs})`);
      detail = 'compact';
    }

    if (detail === 'fine') {
      const positions = await this.prisma.position.findMany({
        where: { trackerId, timestamp: { gte: from, lte: to }, valid: true },
        orderBy: { timestamp: 'asc' },
        take: 50_000,
      });
      // V1.10 (Sprint 6) — downsampling stride si on depasse le cap browser-safe.
      // Stride uniforme (1 point sur N) : preserve la repartition temporelle, pas
      // de logique geometrique (qui necessiterait Douglas-Peucker). Pour 50k -> 5k,
      // stride = 10 : 1 point toutes les 5 min en moyenne (vs 30s brut). Visuel
      // quasi-identique a l'oeil sur des ranges > 24h.
      const sampled = positions.length > MAX_FINE_POINTS_OUT
        ? this.strideSample(positions, MAX_FINE_POINTS_OUT)
        : positions;
      if (positions.length > MAX_FINE_POINTS_OUT) {
        this.logger.debug(
          `Downsampled ${positions.length} -> ${sampled.length} points (stride=${Math.ceil(positions.length / MAX_FINE_POINTS_OUT)})`,
        );
      }
      return {
        detail: 'fine',
        points: sampled.map((p) => ({
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

  // NOTE (audit #4/#15) : le cron `purgeOldFinePositions` (90j hardcode, deleteMany
  // non borne) a ete RETIRE d'ici. La retention de `positions` appartient desormais
  // a la seule autorite `DataRetentionService` (env `POSITIONS_RETENTION_DAYS`,
  // suppression par lots). Pour activer 90/365j en prod, fixer cette var dans .env.prod.

  private resolveDetail(req: 'auto' | 'fine' | 'compact' | undefined, rangeMs: number): 'fine' | 'compact' {
    if (req === 'fine' || req === 'compact') return req;
    return rangeMs <= FINE_RANGE_THRESHOLD_MS ? 'fine' : 'compact';
  }

  /**
   * Stride sampling uniforme : garde le 1er, le dernier, et 1 sur stride entre.
   * Ne reordonne pas (le tableau d'entree est suppose deja trie par timestamp).
   * Pas de logique geometrique (Douglas-Peucker serait mieux pour preserver les
   * virages mais plus cher CPU ; le stride convient pour 5x-10x reduction).
   */
  private strideSample<T>(items: T[], targetCount: number): T[] {
    if (items.length <= targetCount) return items;
    const stride = Math.ceil(items.length / targetCount);
    const out: T[] = [];
    for (let i = 0; i < items.length; i += stride) {
      out.push(items[i]!);
    }
    // Garantir d'inclure le dernier point pour ne pas tronquer la fin du trajet.
    const last = items[items.length - 1]!;
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }
}
