import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import type { AuthUser } from '../auth/types/auth-user';

/**
 * Sprint 5 (Rapports & filtres v2) — Export Excel « soigné » PAR VÉHICULE.
 *
 * Différent du CSV brut (dump papaparse) : un vrai classeur `.xlsx` mis en forme
 * (en-têtes stylés, bordures, formats nombre/durée, en-tête figé, lignes total)
 * sur 3 feuilles : Synthèse · Trajets · Par jour.
 *
 * Périmètre / sécurité (cf. PART A) :
 *   - le `vehicleId` demandé DOIT appartenir au périmètre véhicules de
 *     l'appelant (resolveReportVehicleScope → 403 si hors périmètre) ;
 *   - ET à la flotte de l'appelant (défense en profondeur, 403 si autre flotte).
 *
 * Perf (cf. ANALYSE §7) : 1 seul véhicule, trajets capés (≤ 5000), AUCUNE
 * position brute (le full-scan dangereux). Génération en Buffer mémoire.
 */

/** Cap défensif sur le nombre de trajets embarqués dans le classeur. */
const TRIPS_CAP = 5000;

/** Consommation par défaut (L/100km) par type véhicule — aligné reports-stats. */
const DEFAULT_CONSUMPTION_L100KM: Record<string, number> = {
  CAR: 7,
  TRUCK: 22,
  VAN: 10,
  MOTORCYCLE: 4,
  BICYCLE: 0,
  BUS: 28,
  CONSTRUCTION: 18,
  OTHER: 8,
};

const COLOR_HEADER_FILL = 'FF10E0A0'; // vert tracky (ARGB)
const COLOR_HEADER_FONT = 'FF06281F';
const COLOR_TOTAL_FILL = 'FFECFDF5';
const COLOR_TITLE_FONT = 'FF1F2937';

@Injectable()
export class ReportExcelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  /**
   * Génère le classeur Excel d'un véhicule sur une période.
   * @returns buffer .xlsx + nom de fichier `tracky-{plaque}-{from}_{to}.xlsx`.
   */
  async generate(
    vehicleId: string,
    from: Date,
    to: Date,
    requestedBy: AuthUser,
  ): Promise<{ buffer: Buffer; filename: string }> {
    // 1) 🔒 Périmètre utilisateur : lève ForbiddenException si vehicleId hors
    //    périmètre accessible (VIEWER/FLEET_MANAGER scope groupe/véhicules).
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(requestedBy);
    resolveReportVehicleScope(accessible, [vehicleId]);

    // 2) Charge le véhicule (+ flotte) et vérifie l'appartenance flotte (défense
    //    en profondeur — un SUPER_ADMIN passe ; un non-super d'une autre flotte
    //    est rejeté même si la règle d'accès était incohérente).
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        id: true,
        plate: true,
        brand: true,
        model: true,
        type: true,
        fuelConsumptionL100km: true,
        fleetId: true,
        fleet: { select: { id: true, name: true, fuelPriceEurL: true } },
      },
    });
    if (!vehicle) throw new NotFoundException('Vehicule introuvable');
    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      vehicle.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Acces refuse a ce vehicule');
    }

    // 3) Trajets du véhicule sur la période (capés, triés). PAS de positions.
    const trips = await this.prisma.trip.findMany({
      where: { vehicleId, startedAt: { gte: from, lte: to }, endedAt: { not: null } },
      select: {
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        distanceKm: true,
        maxSpeed: true,
        avgSpeed: true,
        notes: true,
        driver: { select: { firstName: true, lastName: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: TRIPS_CAP,
    });

    // 4) Agrégation KPI à partir des trajets chargés (pas de calcul DB séparé).
    const kpis = this.aggregate(trips, vehicle);

    // 5) Construit le classeur.
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Vizyo Tracky';
    workbook.created = new Date();

    this.buildSynthese(workbook, vehicle, from, to, kpis);
    this.buildTrajets(workbook, trips);
    this.buildParJour(workbook, trips);

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
    const filename = `tracky-${this.safePlate(vehicle.plate)}-${this.dateSuffix(from, to)}.xlsx`;
    return { buffer, filename };
  }

  // ---------------------------------------------------------------------------
  // Agrégation KPI
  // ---------------------------------------------------------------------------

  private aggregate(
    trips: TripRow[],
    vehicle: { type: string; fuelConsumptionL100km: number | null; fleet: { fuelPriceEurL: number } | null },
  ): Kpis {
    let totalKm = 0;
    let totalDurationSeconds = 0;
    let maxSpeed = 0;
    let avgSpeedWeightedSum = 0; // moyenne pondérée par durée
    for (const t of trips) {
      const km = Math.max(0, t.distanceKm);
      totalKm += km;
      const dur = Math.max(0, t.durationSeconds);
      totalDurationSeconds += dur;
      maxSpeed = Math.max(maxSpeed, Math.max(0, t.maxSpeed));
      avgSpeedWeightedSum += Math.max(0, t.avgSpeed) * dur;
    }
    const avgSpeed = totalDurationSeconds > 0 ? avgSpeedWeightedSum / totalDurationSeconds : 0;

    const consL100 = vehicle.fuelConsumptionL100km
      ?? DEFAULT_CONSUMPTION_L100KM[vehicle.type]
      ?? 8;
    const estimatedLiters = (totalKm * consL100) / 100;
    const fuelPrice = vehicle.fleet?.fuelPriceEurL ?? 1.85;

    return {
      tripCount: trips.length,
      totalKm: round1(totalKm),
      totalDurationSeconds,
      avgSpeedKmh: round1(avgSpeed),
      maxSpeedKmh: round1(maxSpeed),
      estimatedLiters: round1(estimatedLiters),
      estimatedCostEur: Math.round(estimatedLiters * fuelPrice * 100) / 100,
    };
  }

  // ---------------------------------------------------------------------------
  // Feuille « Synthèse »
  // ---------------------------------------------------------------------------

  private buildSynthese(
    wb: ExcelJS.Workbook,
    vehicle: { plate: string; brand: string | null; model: string | null; fleet: { name: string } | null },
    from: Date,
    to: Date,
    k: Kpis,
  ): void {
    const ws = wb.addWorksheet('Synthèse', {
      properties: { defaultColWidth: 22 },
      views: [{ showGridLines: false }],
    });
    ws.columns = [{ width: 28 }, { width: 26 }];

    // Titre.
    ws.mergeCells('A1:B1');
    const title = ws.getCell('A1');
    title.value = 'Rapport véhicule — Vizyo Tracky';
    title.font = { bold: true, size: 16, color: { argb: COLOR_TITLE_FONT } };
    ws.getRow(1).height = 24;

    const marqueModele = [vehicle.brand, vehicle.model].filter(Boolean).join(' ') || '—';
    const headerRows: Array<[string, string]> = [
      ['Plaque', vehicle.plate],
      ['Marque / modèle', marqueModele],
      ['Flotte', vehicle.fleet?.name ?? '—'],
      ['Période (du)', fmtDate(from)],
      ['Période (au)', fmtDate(to)],
    ];
    let r = 3;
    for (const [label, value] of headerRows) {
      const lc = ws.getCell(`A${r}`);
      const vc = ws.getCell(`B${r}`);
      lc.value = label;
      lc.font = { bold: true, color: { argb: COLOR_TITLE_FONT } };
      vc.value = value;
      r++;
    }

    // Section KPIs.
    r += 1;
    const kpiHeader = ws.getCell(`A${r}`);
    ws.mergeCells(`A${r}:B${r}`);
    kpiHeader.value = 'Indicateurs';
    kpiHeader.font = { bold: true, size: 13, color: { argb: COLOR_HEADER_FONT } };
    kpiHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_FILL } };
    kpiHeader.alignment = { vertical: 'middle' };
    ws.getRow(r).height = 20;
    r++;

    const kpiRows: Array<[string, string | number, string | undefined]> = [
      ['Nombre de trajets', k.tripCount, '#,##0'],
      ['Distance totale (km)', k.totalKm, '#,##0.0'],
      ['Durée totale', fmtDuration(k.totalDurationSeconds), undefined],
      ['Vitesse moyenne (km/h)', k.avgSpeedKmh, '#,##0.0'],
      ['Vitesse max (km/h)', k.maxSpeedKmh, '#,##0.0'],
      ['Conso estimée (L)', k.estimatedLiters, '#,##0.0'],
      ['Coût estimé (€)', k.estimatedCostEur, '#,##0.00'],
    ];
    const kpiStart = r;
    for (const [label, value, fmt] of kpiRows) {
      const lc = ws.getCell(`A${r}`);
      const vc = ws.getCell(`B${r}`);
      lc.value = label;
      lc.font = { bold: true, color: { argb: COLOR_TITLE_FONT } };
      vc.value = value;
      if (fmt) vc.numFmt = fmt;
      vc.alignment = { horizontal: 'right' };
      r++;
    }
    // Bordures sur le bloc KPI.
    this.applyBorders(ws, `A${kpiStart}:B${r - 1}`);
    this.applyBorders(ws, `A${kpiStart - 1}:B${kpiStart - 1}`);
  }

  // ---------------------------------------------------------------------------
  // Feuille « Trajets »
  // ---------------------------------------------------------------------------

  private buildTrajets(wb: ExcelJS.Workbook, trips: TripRow[]): void {
    const ws = wb.addWorksheet('Trajets', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Départ', key: 'start', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
      { header: 'Arrivée', key: 'end', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
      { header: 'Durée', key: 'dur', width: 12 },
      { header: 'Distance (km)', key: 'km', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'V. moy (km/h)', key: 'avg', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'V. max (km/h)', key: 'max', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'Conducteur', key: 'driver', width: 22 },
      { header: 'Notes', key: 'notes', width: 40 },
    ];
    this.styleHeaderRow(ws.getRow(1));

    let sumKm = 0;
    let sumDur = 0;
    for (const t of trips) {
      const km = round1(Math.max(0, t.distanceKm));
      const dur = Math.max(0, t.durationSeconds);
      sumKm += km;
      sumDur += dur;
      ws.addRow({
        start: t.startedAt,
        end: t.endedAt,
        dur: fmtDuration(dur),
        km,
        avg: round1(Math.max(0, t.avgSpeed)),
        max: round1(Math.max(0, t.maxSpeed)),
        driver: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : '',
        notes: t.notes ?? '',
      });
    }

    // Ligne TOTAL.
    const totalRow = ws.addRow({
      start: 'TOTAL',
      dur: fmtDuration(sumDur),
      km: round1(sumKm),
    });
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_TOTAL_FILL } };
    });
    (totalRow.getCell('km') as ExcelJS.Cell).numFmt = '#,##0.0';

    // Bordures sur tout le tableau (header + lignes + total).
    if (ws.rowCount >= 1) {
      this.applyBorders(ws, `A1:H${ws.rowCount}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Feuille « Par jour »
  // ---------------------------------------------------------------------------

  private buildParJour(wb: ExcelJS.Workbook, trips: TripRow[]): void {
    const ws = wb.addWorksheet('Par jour', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Nb trajets', key: 'count', width: 12, style: { numFmt: '#,##0' } },
      { header: 'Distance (km)', key: 'km', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'Durée', key: 'dur', width: 12 },
      { header: 'V. max (km/h)', key: 'max', width: 14, style: { numFmt: '#,##0.0' } },
    ];
    this.styleHeaderRow(ws.getRow(1));

    const byDate = new Map<string, { count: number; km: number; dur: number; max: number }>();
    for (const t of trips) {
      const date = t.startedAt.toISOString().slice(0, 10);
      const e = byDate.get(date) ?? { count: 0, km: 0, dur: 0, max: 0 };
      e.count++;
      e.km += Math.max(0, t.distanceKm);
      e.dur += Math.max(0, t.durationSeconds);
      e.max = Math.max(e.max, Math.max(0, t.maxSpeed));
      byDate.set(date, e);
    }
    // Tri chronologique des jours.
    for (const date of [...byDate.keys()].sort()) {
      const e = byDate.get(date)!;
      ws.addRow({
        date,
        count: e.count,
        km: round1(e.km),
        dur: fmtDuration(e.dur),
        max: round1(e.max),
      });
    }

    if (ws.rowCount >= 1) {
      this.applyBorders(ws, `A1:E${ws.rowCount}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers de mise en forme
  // ---------------------------------------------------------------------------

  private styleHeaderRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: COLOR_HEADER_FONT } };
    row.height = 18;
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_FILL } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
  }

  private applyBorders(ws: ExcelJS.Worksheet, range: string): void {
    const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFD1D5DB' } };
    const [start, end] = range.split(':');
    const startCell = ws.getCell(start);
    const endCell = ws.getCell(end);
    for (let r = startCell.fullAddress.row; r <= endCell.fullAddress.row; r++) {
      for (let c = startCell.fullAddress.col; c <= endCell.fullAddress.col; c++) {
        const cell = ws.getCell(r, c);
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      }
    }
  }

  private safePlate(plate: string): string {
    // Nom de fichier sûr : alphanumérique + tirets.
    return plate.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vehicule';
  }

  private dateSuffix(from: Date, to: Date): string {
    return `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
  }
}

// -----------------------------------------------------------------------------
// Types internes
// -----------------------------------------------------------------------------

interface TripRow {
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  distanceKm: number;
  maxSpeed: number;
  avgSpeed: number;
  notes: string | null;
  driver: { firstName: string; lastName: string } | null;
}

interface Kpis {
  tripCount: number;
  totalKm: number;
  totalDurationSeconds: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  estimatedLiters: number;
  estimatedCostEur: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Formate une durée en secondes vers `Xh YYmin` (ou `YYmin` si < 1h). */
function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m}min`;
}

/** Date ISO courte lisible `yyyy-mm-dd HH:MM` (UTC). */
function fmtDate(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}
