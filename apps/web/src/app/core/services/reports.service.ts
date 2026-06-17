import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
      throw new Error(await this.formatHttpError(err, 'PDF'));
    }
  }

  async downloadCsv(type: CsvType, fleetId: string | null, from: string, to: string): Promise<void> {
    let params = new HttpParams().set('type', type).set('from', from).set('to', to);
    if (fleetId) params = params.set('fleetId', fleetId);
    try {
      const blob = await firstValueFrom(
        this.http.get('/api/reports/csv', { params, responseType: 'blob' }),
      );
      this.triggerDownload(blob, `tracky-${type}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`);
    } catch (err) {
      throw new Error(await this.formatHttpError(err, 'CSV'));
    }
  }

  async downloadSpeedAnalysis(tripId: string): Promise<void> {
    try {
      const blob = await firstValueFrom(
        this.http.get(`/api/reports/speed-analysis/${tripId}`, { responseType: 'blob' }),
      );
      this.triggerDownload(blob, `rapport-vitesse-${tripId.slice(0, 8)}.html`);
    } catch (err) {
      throw new Error(await this.formatHttpError(err, 'PDF'));
    }
  }

  /** Extrait le message d'erreur reel renvoye par l'API.
   *  Avec responseType:'blob', l'error.error d'Angular est un Blob → on le parse.
   *  Robuste face aux 3 formes que NestJS peut renvoyer :
   *   - { message: "string" }                          (BadRequestException simple)
   *   - { message: ["err1", "err2"] }                  (class-validator)
   *   - { message: [{ constraints: {...}, property }] } (class-validator detaille) */
  private async formatHttpError(err: unknown, kind: 'PDF' | 'CSV'): Promise<string> {
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
