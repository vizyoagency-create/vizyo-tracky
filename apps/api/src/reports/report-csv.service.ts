import { Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { PrismaService } from '../prisma/prisma.service';
import { VEHICLE_GROUP_SELECT, vehicleGroupOf } from '../common/vehicle-group';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';

/**
 * V1.5 (Sprint L) — Export CSV brut.
 *
 * Format Excel-friendly : BOM UTF-8 + separateur ';' (les Excel FR/EU utilisent
 * ';' par defaut, ',' rentre en conflit avec la virgule decimale).
 *
 * 🔒 Sprint 5 — chaque export est borne au PERIMETRE UTILISATEUR : un VIEWER /
 * FLEET_MANAGER scope groupe ou vehicules ne peut exporter QUE ses vehicules
 * accessibles (pas toute la flotte). `accessibleVehicleIds === 'ALL'` (admins)
 * => comportement historique (toute la flotte). Le filtre `fleetId` est conserve
 * en defense en profondeur dans tous les cas.
 */

const BOM = '﻿';

@Injectable()
export class ReportCsvService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne la liste des vehicleIds qui bornent un export, ou null quand
   * l'appelant a acces a tout (=> pas de borne vehicule, seulement le fleetId).
   */
  private scopedVehicleIds(accessibleVehicleIds: string[] | 'ALL'): string[] | null {
    const scope = resolveReportVehicleScope(accessibleVehicleIds);
    return scope === 'ALL' ? null : scope;
  }

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

  async positions(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const positions = await this.prisma.position.findMany({
      where: {
        timestamp: { gte: from, lte: to },
        // Borne flotte (defense en profondeur) + perimetre user via le vehicule
        // du tracker. `positions`/`commands` n'ont pas de vehicleId direct.
        // Mode vie privée (RGPD) : on exclut les véhicules actuellement en mode privé.
        tracker: { vehicle: ids ? { fleetId, id: { in: ids }, privacyModeEnabled: false } : { fleetId, privacyModeEnabled: false } },
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

  async trips(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const trips = await this.prisma.trip.findMany({
      // Mode vie privée (RGPD) : exclut les trajets d'un véhicule actuellement en mode privé.
      where: { fleetId, startedAt: { gte: from, lte: to }, ...(ids ? { vehicleId: { in: ids } } : {}), NOT: { vehicle: { privacyModeEnabled: true } } },
      orderBy: { startedAt: 'desc' },
      include: {
        vehicle: { select: { plate: true, ...VEHICLE_GROUP_SELECT } },
        notesUpdatedBy: { select: { firstName: true, lastName: true, email: true } },
        driver: { select: { id: true, firstName: true, lastName: true } },
      },
      take: 50_000,
    });
    const rows = trips.map((t) => ({
      trip_id: t.id,
      plate: t.vehicle?.plate ?? '',
      group: vehicleGroupOf(t.vehicle)?.name ?? '',
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

  async alerts(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const alerts = await this.prisma.alert.findMany({
      // Quand un perimetre est actif, les alertes sans vehicleId (tracker isole)
      // sont exclues par definition du sous-ensemble (cf. reports-stats).
      // Mode vie privée (RGPD) : exclut les alertes d'un véhicule en mode privé (garde les alertes flotte sans véhicule).
      where: { fleetId, createdAt: { gte: from, lte: to }, ...(ids ? { vehicleId: { in: ids } } : {}), NOT: { vehicle: { privacyModeEnabled: true } } },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { plate: true, ...VEHICLE_GROUP_SELECT } } },
      take: 50_000,
    });
    const rows = alerts.map((a) => ({
      created_at: a.createdAt.toISOString(),
      plate: a.vehicle?.plate ?? '',
      group: vehicleGroupOf(a.vehicle)?.name ?? '',
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

  async commands(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const commands = await this.prisma.engineControlCommand.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        tracker: { vehicle: ids ? { fleetId, id: { in: ids } } : { fleetId } },
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
