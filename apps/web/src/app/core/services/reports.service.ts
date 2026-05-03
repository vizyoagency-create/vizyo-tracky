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
  }[];
}

export type CsvType = 'positions' | 'trips' | 'alerts' | 'commands';

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

  /** Extrait le message d'erreur reel renvoye par l'API.
   *  Avec responseType:'blob', l'error.error d'Angular est un Blob → on le parse. */
  private async formatHttpError(err: unknown, kind: 'PDF' | 'CSV'): Promise<string> {
    if (err instanceof HttpErrorResponse) {
      let detail = '';
      if (err.error instanceof Blob) {
        try {
          const text = await err.error.text();
          const parsed = JSON.parse(text);
          detail = parsed?.message ?? parsed?.error ?? text;
        } catch {
          detail = '';
        }
      } else if (typeof err.error === 'string') {
        detail = err.error;
      } else if (err.error?.message) {
        detail = err.error.message;
      }
      return `Echec export ${kind} (${err.status})${detail ? ' : ' + detail : ''}`;
    }
    return `Echec export ${kind}`;
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
