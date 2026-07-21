import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Rétention du registre : 5 ans (obligation employeur) — la SEULE rétention longue, assumée. */
const REGISTRY_RETENTION_DAYS = 5 * 365;
/** Fenêtre de ré-agrégation à chaque run (rattrape les trajets re-segmentés/attribués tard). */
const REAGGREGATE_DAYS = 7;
const TZ = 'Europe/Paris';

interface TripLite {
  driverId: string;
  fleetId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  vehiclePlate: string | null;
}

export interface DayAggregate {
  driverId: string;
  fleetId: string;
  day: string; // YYYY-MM-DD (Europe/Paris)
  firstTripStart: Date;
  lastTripEnd: Date;
  drivingSeconds: number;
  tripsCount: number;
  vehiclePlates: string[];
}

/** Jour civil Europe/Paris d'un instant (YYYY-MM-DD). */
export function parisDayOf(d: Date): string {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Agrégation PURE (testable) : trajets → une entrée par (conducteur, jour Paris).
 * Conduite pure = somme des durées ; l'amplitude (first→last) se lit sur les bornes.
 */
export function aggregateTrips(trips: TripLite[]): DayAggregate[] {
  const byKey = new Map<string, DayAggregate>();
  for (const t of trips) {
    if (!t.driverId || !t.fleetId) continue;
    const day = parisDayOf(t.startedAt);
    const key = `${t.driverId}|${day}`;
    const end = t.endedAt ?? t.startedAt;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        driverId: t.driverId,
        fleetId: t.fleetId,
        day,
        firstTripStart: t.startedAt,
        lastTripEnd: end,
        drivingSeconds: t.durationSeconds || 0,
        tripsCount: 1,
        vehiclePlates: t.vehiclePlate ? [t.vehiclePlate] : [],
      });
    } else {
      if (t.startedAt < cur.firstTripStart) cur.firstTripStart = t.startedAt;
      if (end > cur.lastTripEnd) cur.lastTripEnd = end;
      cur.drivingSeconds += t.durationSeconds || 0;
      cur.tripsCount += 1;
      if (t.vehiclePlate && !cur.vehiclePlates.includes(t.vehiclePlate)) cur.vehiclePlates.push(t.vehiclePlate);
    }
  }
  return [...byKey.values()];
}

/**
 * RGPD 4.5 — Registre du temps de travail (justification employeur 5 ans, SANS positions).
 * Décisions actées le 21/07 : actif pour TOUTES les flottes (aucune donnée localisée) ; tous les
 * trajets ATTRIBUÉS comptent (AUTO comme MANUEL) ; conduite pure ET amplitude conservées ; les
 * entrées survivent à l'anonymisation (fiche anonyme) et aux purges de trajets (4.1) — c'est le but.
 */
@Injectable()
export class WorkTimeService {
  private readonly logger = new Logger(WorkTimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** 04h00 — après la rétention trajets (03h45) : on agrège AVANT que la purge ne raccourcisse l'historique. */
  @Cron('0 0 4 * * *')
  async run(): Promise<void> {
    try {
      await this.aggregateWindow();
      await this.purgeExpired();
    } catch (err) {
      this.errorLogger
        .record(err instanceof Error ? err : new Error(String(err)), 'work-time-registry', {}, 'ERROR')
        .catch((e) => this.logger.error('ErrorLogger persist failed', e));
    }
  }

  /** Ré-agrège les REAGGREGATE_DAYS derniers jours (upserts idempotents). */
  async aggregateWindow(now: Date = new Date()): Promise<{ entries: number }> {
    const from = new Date(now.getTime() - REAGGREGATE_DAYS * 86_400_000);
    from.setHours(0, 0, 0, 0);
    const trips = await this.prisma.trip.findMany({
      where: { driverId: { not: null }, startedAt: { gte: from } },
      select: {
        driverId: true, fleetId: true, startedAt: true, endedAt: true, durationSeconds: true,
        vehicle: { select: { plate: true } },
      },
    });
    const aggregates = aggregateTrips(
      trips.map((t) => ({
        driverId: t.driverId as string,
        fleetId: t.fleetId,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationSeconds: t.durationSeconds,
        vehiclePlate: t.vehicle?.plate ?? null,
      })),
    );
    for (const a of aggregates) {
      const day = new Date(`${a.day}T00:00:00.000Z`);
      const data = {
        fleetId: a.fleetId,
        firstTripStart: a.firstTripStart,
        lastTripEnd: a.lastTripEnd,
        drivingSeconds: a.drivingSeconds,
        tripsCount: a.tripsCount,
        vehiclePlates: a.vehiclePlates,
      };
      await this.prisma.workTimeEntry.upsert({
        where: { driverId_day: { driverId: a.driverId, day } },
        create: { driverId: a.driverId, day, ...data },
        update: data,
      });
    }
    if (aggregates.length) this.logger.log(`Registre temps de travail : ${aggregates.length} entrée(s) agrégée(s) (fenêtre ${REAGGREGATE_DAYS} j)`);
    return { entries: aggregates.length };
  }

  /** Purge les entrées > 5 ans (rétention propre du registre). */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - REGISTRY_RETENTION_DAYS * 86_400_000);
    const res = await this.prisma.workTimeEntry.deleteMany({ where: { day: { lt: cutoff } } });
    if (res.count > 0) {
      this.systemActivity.record({
        category: 'RETENTION',
        action: 'work_time_purged',
        status: 'SUCCESS',
        actor: 'retention-cron',
        target: 'Registre temps de travail',
        detail: `${res.count} entrée(s) de plus de 5 ans supprimée(s)`,
        meta: { deleted: res.count, retentionDays: REGISTRY_RETENTION_DAYS },
      });
    }
    return res.count;
  }

  /** Export CSV du registre d'un conducteur (audité côté contrôleur). */
  async exportCsv(driverId: string, fleetId: string, from?: string, to?: string): Promise<string> {
    const where: Prisma.WorkTimeEntryWhereInput = { driverId, fleetId };
    if (from || to) {
      where.day = {};
      if (from) where.day.gte = new Date(`${from}T00:00:00.000Z`);
      if (to) where.day.lte = new Date(`${to}T00:00:00.000Z`);
    }
    const rows = await this.prisma.workTimeEntry.findMany({ where, orderBy: { day: 'asc' } });
    const fmtH = (s: number): string => (s / 3600).toFixed(2).replace('.', ',');
    const hm = (d: Date): string => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
    const lines = [
      'jour;premiere_prise_de_service;derniere_fin;amplitude_h;conduite_h;trajets;vehicules',
      ...rows.map((r) => {
        const amplitude = (r.lastTripEnd.getTime() - r.firstTripStart.getTime()) / 1000;
        return [
          r.day.toISOString().slice(0, 10),
          hm(r.firstTripStart),
          hm(r.lastTripEnd),
          fmtH(Math.max(0, amplitude)),
          fmtH(r.drivingSeconds),
          r.tripsCount,
          r.vehiclePlates.join(' '),
        ].join(';');
      }),
    ];
    return lines.join('\n');
  }
}
