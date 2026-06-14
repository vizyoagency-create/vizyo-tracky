import { Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint L) — Export CSV brut.
 *
 * Format Excel-friendly : BOM UTF-8 + separateur ';' (les Excel FR/EU utilisent
 * ';' par defaut, ',' rentre en conflit avec la virgule decimale).
 */

const BOM = '﻿';

@Injectable()
export class ReportCsvService {
  constructor(private readonly prisma: PrismaService) {}

  private wrap(rows: Record<string, string | number | null | undefined>[], filename: string, truncated = false): {
    filename: string;
    contentType: string;
    body: string;
  } {
    const csv = Papa.unparse(rows, { delimiter: ';', header: true });
    // #23 — troncature VISIBLE : si l'export a atteint son cap memoire (tout est
    // bufferise en RAM), on suffixe le nom `-PARTIEL` pour que l'utilisateur sache
    // qu'il manque des lignes (avant : troncature silencieuse) et resserre la periode.
    const finalName = truncated ? filename.replace(/\.csv$/, '-PARTIEL.csv') : filename;
    return {
      filename: finalName,
      contentType: 'text/csv; charset=utf-8',
      body: BOM + csv,
    };
  }

  async positions(fleetId: string, from: Date, to: Date) {
    const positions = await this.prisma.position.findMany({
      where: {
        timestamp: { gte: from, lte: to },
        tracker: { vehicle: { fleetId } },
      },
      orderBy: { timestamp: 'asc' },
      include: { tracker: { include: { vehicle: { select: { plate: true } } } } },
      take: 100_000,
    });
    const rows = positions.map((p) => ({
      timestamp: p.timestamp.toISOString(),
      plate: p.tracker.vehicle?.plate ?? '',
      lat: p.lat,
      lng: p.lng,
      speed_kmh: p.speedKmh,
      heading: p.heading,
      ignition: p.ignition === null ? '' : p.ignition ? 'on' : 'off',
      valid: p.valid ? 'yes' : 'no',
    }));
    return this.wrap(rows, `tracky-positions-${this.dateSuffix(from, to)}.csv`, rows.length >= 100_000);
  }

  async trips(fleetId: string, from: Date, to: Date) {
    const trips = await this.prisma.trip.findMany({
      where: { fleetId, startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'desc' },
      include: {
        vehicle: { select: { plate: true } },
        notesUpdatedBy: { select: { firstName: true, lastName: true, email: true } },
        driver: { select: { id: true, firstName: true, lastName: true } },
      },
      take: 50_000,
    });
    const rows = trips.map((t) => ({
      trip_id: t.id,
      plate: t.vehicle?.plate ?? '',
      started_at: t.startedAt.toISOString(),
      ended_at: t.endedAt?.toISOString() ?? '',
      duration_seconds: t.durationSeconds,
      distance_km: t.distanceKm.toFixed(2),
      max_speed_kmh: t.maxSpeed.toFixed(1),
      avg_speed_kmh: t.avgSpeed.toFixed(1),
      position_count: t.positionCount,
      start_lat: t.startLat,
      start_lng: t.startLng,
      end_lat: t.endLat ?? '',
      end_lng: t.endLng ?? '',
      driver_id: t.driverId ?? '',
      driver_name: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : '',
      driver_source: t.driverSource ?? '',
      notes: t.notes ?? '',
      notes_author: this.formatAuthor(t.notesUpdatedBy),
      notes_updated_at: t.notesUpdatedAt?.toISOString() ?? '',
    }));
    return this.wrap(rows, `tracky-trips-${this.dateSuffix(from, to)}.csv`, rows.length >= 50_000);
  }

  /** Formate l'auteur de note pour l'export : "Prenom Nom" sinon email sinon vide. */
  private formatAuthor(
    author: { firstName: string | null; lastName: string | null; email: string } | null,
  ): string {
    if (!author) return '';
    const fn = author.firstName ?? '';
    const ln = author.lastName ?? '';
    const full = `${fn} ${ln}`.trim();
    return full || author.email;
  }

  async alerts(fleetId: string, from: Date, to: Date) {
    const alerts = await this.prisma.alert.findMany({
      where: { fleetId, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { plate: true } } },
      take: 50_000,
    });
    const rows = alerts.map((a) => ({
      created_at: a.createdAt.toISOString(),
      plate: a.vehicle?.plate ?? '',
      type: a.type,
      severity: a.severity,
      title: a.title,
      message: a.message ?? '',
      acknowledged_at: a.acknowledgedAt?.toISOString() ?? '',
      latitude: a.latitude ?? '',
      longitude: a.longitude ?? '',
    }));
    return this.wrap(rows, `tracky-alerts-${this.dateSuffix(from, to)}.csv`, rows.length >= 50_000);
  }

  async commands(fleetId: string, from: Date, to: Date) {
    const commands = await this.prisma.engineControlCommand.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        tracker: { vehicle: { fleetId } },
      },
      orderBy: { createdAt: 'desc' },
      include: { tracker: { include: { vehicle: { select: { plate: true } } } } },
      take: 20_000,
    });
    const rows = commands.map((c) => ({
      created_at: c.createdAt.toISOString(),
      plate: c.tracker.vehicle?.plate ?? '',
      action: c.action,
      status: c.status,
      source: c.source,
      sent_at: c.sentAt?.toISOString() ?? '',
      acked_at: c.ackedAt?.toISOString() ?? '',
      reason: c.reason ?? '',
      last_error: c.lastError ?? '',
    }));
    return this.wrap(rows, `tracky-commands-${this.dateSuffix(from, to)}.csv`, rows.length >= 20_000);
  }

  private dateSuffix(from: Date, to: Date): string {
    const f = from.toISOString().slice(0, 10);
    const t = to.toISOString().slice(0, 10);
    return `${f}_${t}`;
  }
}
