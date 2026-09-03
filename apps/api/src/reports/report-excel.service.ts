import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { formatFleetDate, formatFleetDateTime, parisDayKey } from '../common/utils/datetime';
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
        calibratedConsumptionL100km: true,
        calibratedTanks: true,
        fleetId: true,
        privacyModeEnabled: true,
        fleet: { select: { id: true, name: true, fuelPriceEurL: true } },
      },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');
    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      vehicle.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }
    // Mode vie privée (RGPD) : les trajets révèlent les déplacements → export bloqué tant qu'actif.
    if (vehicle.privacyModeEnabled) {
      throw new ForbiddenException('Véhicule en mode vie privée : export indisponible tant que le mode privé est actif.');
    }

    // 3) Trajets du véhicule sur la période (capés, triés). PAS de positions.
    const trips = await this.prisma.trip.findMany({
      where: { vehicleId, startedAt: { gte: from, lt: to }, endedAt: { not: null } },
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

    // 3bis) Passages en station-service du véhicule sur la période (prix DATÉ à chaque passage) —
    //       base du suivi de coût réel et de la future section d'auto-calcul à la pompe.
    const fuelStops = await this.prisma.tripFuelStop.findMany({
      where: { vehicleId, arrivedAt: { gte: from, lte: to } },
      select: {
        arrivedAt: true, durationSec: true, fuelType: true, unitPriceEur: true,
        station: { select: { brand: true, name: true, city: true, address: true } },
      },
      orderBy: { arrivedAt: 'asc' },
    });

    // 4) Agrégation KPI à partir des trajets chargés (+ prix constaté depuis les passages station).
    const kpis = this.aggregate(trips, vehicle, fuelStops);

    // 5) Construit le classeur.
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Vizyo Tracky';
    workbook.created = new Date();

    this.buildSynthese(workbook, vehicle, from, to, kpis);
    this.buildTrajets(workbook, trips);
    this.buildParJour(workbook, trips);
    if (fuelStops.length) this.buildPassagesStation(workbook, fuelStops);

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
    vehicle: { type: string; fuelConsumptionL100km: number | null; calibratedConsumptionL100km: number | null; calibratedTanks: number; fleet: { fuelPriceEurL: number } | null },
    fuelStops: FuelStopRow[],
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

    // Conso EFFECTIVE : calibrée (méthode du plein) si mesurée, sinon paramétrée, sinon défaut type.
    const consL100 = (vehicle.calibratedTanks > 0 ? vehicle.calibratedConsumptionL100km : null)
      ?? vehicle.fuelConsumptionL100km
      ?? DEFAULT_CONSUMPTION_L100KM[vehicle.type]
      ?? 8;
    const estimatedLiters = (totalKm * consL100) / 100;
    const fuelPrice = vehicle.fleet?.fuelPriceEurL ?? 1.85;

    // Prix RÉELLEMENT CONSTATÉ en station (moyenne des prix captés aux passages du véhicule sur la période).
    const priced = fuelStops.filter((s) => s.unitPriceEur != null).map((s) => s.unitPriceEur as number);
    const observedPriceEurL = priced.length ? Math.round((priced.reduce((a, b) => a + b, 0) / priced.length) * 1000) / 1000 : null;
    const fuelType = fuelStops.find((s) => s.fuelType)?.fuelType ?? null;

    return {
      tripCount: trips.length,
      totalKm: round1(totalKm),
      totalDurationSeconds,
      avgSpeedKmh: round1(avgSpeed),
      maxSpeedKmh: round1(maxSpeed),
      estimatedLiters: round1(estimatedLiters),
      estimatedCostEur: Math.round(estimatedLiters * fuelPrice * 100) / 100,
      fuelPriceEurL: fuelPrice,
      fuelVisits: fuelStops.length,
      fuelType,
      observedPriceEurL,
      estimatedCostAtObservedEur: observedPriceEurL != null ? Math.round(estimatedLiters * observedPriceEurL * 100) / 100 : null,
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
      // Fin INCLUSE : la borne `to` est le lendemain minuit, « au 03/09 » aurait promis un jour de plus.
      ['Période (du)', formatFleetDate(from)],
      ['Période (au, inclus)', formatFleetDate(new Date(to.getTime() - 1))],
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
      ['Coût estimé — prix paramétré (€)', k.estimatedCostEur, '#,##0.00'],
      ['Prix carburant paramétré (€/L)', k.fuelPriceEurL, '#,##0.000'],
    ];
    // Prix RÉELLEMENT CONSTATÉ en station sur la période (si des passages ont été captés).
    if (k.fuelVisits > 0) {
      kpiRows.push(['Passages en station', k.fuelVisits, '#,##0']);
      if (k.observedPriceEurL != null) {
        kpiRows.push([`Prix constaté en station (€/L${k.fuelType ? ' — ' + fuelLabelXlsx(k.fuelType) : ''})`, k.observedPriceEurL, '#,##0.000']);
        kpiRows.push(['Coût au prix constaté (€)', k.estimatedCostAtObservedEur ?? 0, '#,##0.00']);
      }
    }
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
      // Heure de PARIS, écrite en texte : une cellule Date passe à Excel un instant UTC, que
      // le tableur affiche sans fuseau — un départ à 07:30 se lisait 05:30, alors que le PDF
      // du même véhicule disait 07:30.
      { header: 'Départ (heure de Paris)', key: 'start', width: 20 },
      { header: 'Arrivée (heure de Paris)', key: 'end', width: 20 },
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
        start: formatFleetDateTime(t.startedAt),
        end: t.endedAt ? formatFleetDateTime(t.endedAt) : '',
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
      // Jour civil de Paris — même règle que le résumé journalier de l'écran.
      const date = parisDayKey(t.startedAt);
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
  // Feuille « Passages station » — chaque passage DATÉ + prix du moment (matière brute
  // pour le suivi de coût réel et la future section d'auto-calcul à la pompe).
  // ---------------------------------------------------------------------------

  private buildPassagesStation(wb: ExcelJS.Workbook, fuelStops: FuelStopRow[]): void {
    const ws = wb.addWorksheet('Passages station', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Date/heure', key: 'at', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
      { header: 'Station', key: 'station', width: 24 },
      { header: 'Ville', key: 'city', width: 18 },
      { header: 'Adresse', key: 'address', width: 30 },
      { header: 'Carburant', key: 'fuel', width: 16 },
      { header: 'Prix (€/L)', key: 'price', width: 12, style: { numFmt: '#,##0.000' } },
      { header: 'Durée arrêt', key: 'dur', width: 14 },
    ];
    this.styleHeaderRow(ws.getRow(1));

    let sumPrice = 0;
    let priced = 0;
    for (const s of fuelStops) {
      if (s.unitPriceEur != null) { sumPrice += s.unitPriceEur; priced++; }
      ws.addRow({
        at: s.arrivedAt,
        station: s.station?.brand || s.station?.name || 'Station-service',
        city: s.station?.city ?? '',
        address: s.station?.address ?? '',
        fuel: s.fuelType ? fuelLabelXlsx(s.fuelType) : '',
        price: s.unitPriceEur ?? null,
        dur: fmtDuration(s.durationSec),
      });
    }
    // Ligne PRIX MOYEN constaté sur la période.
    if (priced > 0) {
      const avgRow = ws.addRow({ at: 'PRIX MOYEN', price: Math.round((sumPrice / priced) * 1000) / 1000 });
      avgRow.font = { bold: true };
      avgRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_TOTAL_FILL } }; });
      (avgRow.getCell('price') as ExcelJS.Cell).numFmt = '#,##0.000';
    }

    if (ws.rowCount >= 1) this.applyBorders(ws, `A1:G${ws.rowCount}`);
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

  /** Jours civils de Paris, fin INCLUSE (la borne `to` est le lendemain minuit). */
  private dateSuffix(from: Date, to: Date): string {
    return `${parisDayKey(from)}_${parisDayKey(new Date(to.getTime() - 1))}`;
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
  fuelPriceEurL: number;
  /** Nombre de passages en station sur la période. */
  fuelVisits: number;
  fuelType: string | null;
  /** Prix moyen RÉELLEMENT CONSTATÉ en station (€/L) sur la période, ou null si aucun passage capté. */
  observedPriceEurL: number | null;
  /** Coût carburant estimé au prix constaté (litres × prix constaté), ou null. */
  estimatedCostAtObservedEur: number | null;
}

interface FuelStopRow {
  arrivedAt: Date;
  durationSec: number;
  fuelType: string | null;
  unitPriceEur: number | null;
  station: { brand: string | null; name: string | null; city: string | null; address: string | null } | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Libellé lisible d'un carburant de l'API (gazole → « Gazole », gplc → « GPL »…). */
function fuelLabelXlsx(t: string): string {
  switch (t) {
    case 'gazole': return 'Gazole';
    case 'sp95': return 'SP95';
    case 'sp98': return 'SP98';
    case 'e10': return 'E10';
    case 'e85': return 'E85 (Superéthanol)';
    case 'gplc': return 'GPL';
    default: return t;
  }
}

/** Formate une durée en secondes vers `Xh YYmin` (ou `YYmin` si < 1h). */
function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m}min`;
}

/** Date lisible « 24/07/2026 07:38 », heure de Paris — comme le PDF et les e-mails. */
function fmtDate(d: Date): string {
  return formatFleetDateTime(d);
}
