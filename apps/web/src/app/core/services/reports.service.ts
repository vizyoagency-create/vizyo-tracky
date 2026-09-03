import { swallow } from '../../core/error/swallow';
import { HttpClient, HttpErrorResponse, HttpParams, HttpResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ActivityTrackerService } from './activity-tracker.service';
import type {
  FleetReportDispatchDto,
  FleetReportScheduleDto,
  SendFleetReportNowResultDto,
  SetFleetReportScheduleDto,
} from '@vizyo/tracky-shared';

export interface FleetStatsReportDto {
  fleet: { id: string; name: string };
  period: { from: string; to: string; days: number };
  vehicles: { total: number; activeDuringPeriod: number };
  trips: {
    count: number;
    totalKm: number;
    totalDurationHours: number;
    avgKmPerVehicle: number;
    avgSpeedKmh: number;
    maxSpeedKmh: number;
  };
  alerts: {
    total: number;
    byType: { type: string; count: number }[];
    bySeverity: { severity: string; count: number }[];
  };
  consumption: {
    estimatedLiters: number;
    estimatedCostEur: number;
    fuelPriceEurL: number;
  };
  topVehicles: {
    vehicleId: string;
    plate: string;
    distanceKm: number;
    tripCount: number;
    estimatedConsumptionL: number;
    group?: { id: string; name: string } | null;
  }[];
}

export type CsvType = 'positions' | 'trips' | 'alerts' | 'commands';

export type PdfReportSection = 'kpi' | 'alerts' | 'topVehicles' | 'trips';

/**
 * Options de personnalisation pour POST /api/reports/pdf — alignees sur le DTO
 * backend `GeneratePdfDto`. Tous les champs sont optionnels ; en l'absence de
 * filtre la modal genere un rapport flotte complet (comportement legacy).
 */
export interface PdfExportConfig {
  /** Restreint a ces vehicules. Vide / absent => toute la flotte. */
  vehicleIds?: string[];
  /** Sections a inclure. Vide / absent => toutes les sections. */
  sections?: PdfReportSection[];
  /** Cap trajets detailles (default 30, max 500). */
  maxTrips?: number;
  /** Cap top vehicules (default 10, max 50). */
  topN?: number;
}

/**
 * V1.5 (Sprint L) — Rapports & export.
 *
 * Le PDF et le CSV sont des binaires/texte servis avec Content-Disposition:
 * attachment. Cote frontend, on declenche le download via un blob anchor.
 */
@Injectable({ providedIn: 'root' })
export class ReportsApiService {
  private readonly http = inject(HttpClient);
  private readonly tracker = inject(ActivityTrackerService);

  stats(fleetId: string | null, from: string, to: string) {
    const params: Record<string, string> = { from, to };
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<FleetStatsReportDto>('/api/reports/stats', { params });
  }

  async downloadPdf(fleetId: string | null, from: string, to: string): Promise<void> {
    let params = new HttpParams().set('from', from).set('to', to);
    if (fleetId) params = params.set('fleetId', fleetId);
    try {
      const blob = await firstValueFrom(
        this.http.get('/api/reports/pdf', { params, responseType: 'blob' }),
      );
      this.triggerDownload(blob, `tracky-rapport-${from.slice(0, 10)}_${to.slice(0, 10)}.pdf`);
    } catch (err) {
      swallow('reports:downloadPdf', err);
      throw new Error(await this.formatHttpError(err, 'PDF'));
    }
  }

  /**
   * Variante configurable du PDF — POST avec body JSON (vehicleIds + sections
   * + caps). Utilise par la modal d'export. L'ancienne `downloadPdf()` reste
   * dispo pour les appels rapides sans configuration.
   */
  async downloadConfiguredPdf(
    fleetId: string | null,
    from: string,
    to: string,
    config: PdfExportConfig,
  ): Promise<void> {
    const body: Record<string, unknown> = { from, to };
    if (fleetId) body['fleetId'] = fleetId;
    if (config.vehicleIds && config.vehicleIds.length > 0) body['vehicleIds'] = config.vehicleIds;
    if (config.sections && config.sections.length > 0) body['sections'] = config.sections;
    if (config.maxTrips != null) body['maxTrips'] = config.maxTrips;
    if (config.topN != null) body['topN'] = config.topN;

    try {
      const blob = await firstValueFrom(
        this.http.post('/api/reports/pdf', body, { responseType: 'blob' }),
      );
      this.triggerDownload(blob, `tracky-rapport-${from.slice(0, 10)}_${to.slice(0, 10)}.pdf`);
    } catch (err) {
      swallow('reports:downloadConfiguredPdf', err);
      throw new Error(await this.formatHttpError(err, 'PDF'));
    }
  }

  /**
   * `vehicleIds` : périmètre véhicule / groupe de l'écran. Sans lui, un CSV « trajets »
   * demandé depuis un rapport filtré sur EP-047-TY exportait toute la flotte — le fichier
   * ne correspondait pas à l'écran qui l'avait produit.
   */
  async downloadCsv(type: CsvType, fleetId: string | null, from: string, to: string, vehicleIds: string[] = []): Promise<void> {
    let params = new HttpParams().set('type', type).set('from', from).set('to', to);
    if (fleetId) params = params.set('fleetId', fleetId);
    if (vehicleIds.length > 0) params = params.set('vehicleIds', vehicleIds.join(','));
    try {
      const blob = await firstValueFrom(
        this.http.get('/api/reports/csv', { params, responseType: 'blob' }),
      );
      this.triggerDownload(blob, `tracky-${type}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`);
    } catch (err) {
      swallow('reports:downloadCsv', err);
      throw new Error(await this.formatHttpError(err, 'CSV'));
    }
  }

  // ─── Rapport hebdomadaire : réglage par société + journal des envois ───────────────

  private scheduleParams(fleetId: string | null, extra: Record<string, string> = {}): HttpParams {
    let params = new HttpParams();
    if (fleetId) params = params.set('fleetId', fleetId);
    for (const [k, v] of Object.entries(extra)) params = params.set(k, v);
    return params;
  }

  getReportSchedule(fleetId: string | null): Promise<FleetReportScheduleDto> {
    return firstValueFrom(this.http.get<FleetReportScheduleDto>('/api/reports/schedule', { params: this.scheduleParams(fleetId) }));
  }

  setReportSchedule(fleetId: string | null, body: SetFleetReportScheduleDto): Promise<FleetReportScheduleDto> {
    return firstValueFrom(this.http.put<FleetReportScheduleDto>('/api/reports/schedule', body, { params: this.scheduleParams(fleetId) }));
  }

  sendReportNow(fleetId: string | null): Promise<SendFleetReportNowResultDto> {
    return firstValueFrom(this.http.post<SendFleetReportNowResultDto>('/api/reports/schedule/send-now', {}, { params: this.scheduleParams(fleetId) }));
  }

  listReportDispatches(fleetId: string | null, limit = 20): Promise<FleetReportDispatchDto[]> {
    return firstValueFrom(this.http.get<FleetReportDispatchDto[]>('/api/reports/schedule/dispatches', { params: this.scheduleParams(fleetId, { limit: String(limit) }) }));
  }

  async downloadSpeedAnalysis(tripId: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get(`/api/reports/speed-analysis/${tripId}`, { responseType: 'blob', observe: 'response' }),
      );
      // Le serveur nomme le fichier par plaque et date (« rapport-vitesse-EP-047-TY-2026-08-11 ») :
      // on le reprend, au lieu d'un identifiant tronqué qui ne disait rien.
      const filename = this.filenameFromResponse(res, `rapport-vitesse-${tripId.slice(0, 8)}.html`);
      this.triggerDownload(res.body ?? new Blob(), filename);
    } catch (err) {
      swallow('reports:downloadSpeedAnalysis', err);
      throw new Error(await this.formatHttpError(err, 'Rapport vitesse'));
    }
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE.
   * POST /api/reports/excel { vehicleId, from, to } → .xlsx en streaming.
   * `from`/`to` sont les bornes de la période courante (le `to` est déjà
   * exclusif côté composant, ce que le backend attend : from < to strict).
   * Le nom de fichier est lu depuis le Content-Disposition (le backend nomme
   * `tracky-{plaque}-{from}_{to}.xlsx`), avec un fallback générique.
   */
  async downloadExcel(vehicleId: string, from: string, to: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post('/api/reports/excel', { vehicleId, from, to }, {
          responseType: 'blob',
          observe: 'response',
        }),
      );
      const filename = this.filenameFromResponse(res, 'tracky-export.xlsx');
      this.triggerDownload(res.body ?? new Blob(), filename);
    } catch (err) {
      swallow('reports:downloadExcel', err);
      throw new Error(await this.formatHttpError(err, 'Excel'));
    }
  }

  /**
   * Extrait le filename du header Content-Disposition d'une réponse, sinon
   * `fallback`. Gère `filename="..."` et `filename*=UTF-8''...` (RFC 5987).
   */
  private filenameFromResponse(res: HttpResponse<unknown>, fallback: string): string {
    const cd = res.headers.get('Content-Disposition') ?? res.headers.get('content-disposition');
    if (!cd) return fallback;
    // filename*=UTF-8''nom%20encode.xlsx  (prioritaire si présent)
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    if (star?.[1]) {
      try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fallthrough */ }
    }
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    if (plain?.[1]) return plain[1].trim();
    return fallback;
  }

  /** Extrait le message d'erreur reel renvoye par l'API.
   *  Avec responseType:'blob', l'error.error d'Angular est un Blob → on le parse.
   *  Robuste face aux 3 formes que NestJS peut renvoyer :
   *   - { message: "string" }                          (BadRequestException simple)
   *   - { message: ["err1", "err2"] }                  (class-validator)
   *   - { message: [{ constraints: {...}, property }] } (class-validator detaille) */
  private async formatHttpError(err: unknown, kind: 'PDF' | 'CSV' | 'Excel' | 'Rapport vitesse'): Promise<string> {
    if (err instanceof HttpErrorResponse) {
      const detail = await this.extractErrorDetail(err);
      return `Echec export ${kind} (${err.status})${detail ? ' : ' + detail : ''}`;
    }
    return `Echec export ${kind}`;
  }

  private async extractErrorDetail(err: HttpErrorResponse): Promise<string> {
    let raw: unknown = err.error;
    if (raw instanceof Blob) {
      try {
        const text = await raw.text();
        try { raw = JSON.parse(text); } catch { return text; }
      } catch { return ''; }
    }
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const msg = obj['message'];
      if (typeof msg === 'string') return msg;
      if (Array.isArray(msg)) {
        return msg
          .map((m) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const mObj = m as Record<string, unknown>;
              const constraints = mObj['constraints'];
              if (constraints && typeof constraints === 'object') {
                return Object.values(constraints).join(', ');
              }
              return JSON.stringify(m);
            }
            return String(m);
          })
          .filter(Boolean)
          .join(' ; ');
      }
      if (typeof obj['error'] === 'string') return obj['error'] as string;
      try { return JSON.stringify(obj); } catch { return ''; }
    }
    return String(raw);
  }

  private triggerDownload(blob: Blob, filename: string): void {
    // Trace explicite de l'export (le clic synthétique a.click() est ignoré par le
    // tracker — isTrusted=false) : le nom de fichier porte type + période.
    this.tracker.trackClick(`export:${filename}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
