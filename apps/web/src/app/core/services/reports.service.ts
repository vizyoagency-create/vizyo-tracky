import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

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
    const params = new URLSearchParams({ from, to });
    if (fleetId) params.set('fleetId', fleetId);
    const res = await fetch(`/api/reports/pdf?${params.toString()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('vizyo-tracky-token') ?? ''}` },
    });
    if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
    const blob = await res.blob();
    this.triggerDownload(blob, `tracky-rapport-${from.slice(0, 10)}_${to.slice(0, 10)}.pdf`);
  }

  async downloadCsv(type: CsvType, fleetId: string | null, from: string, to: string): Promise<void> {
    const params = new URLSearchParams({ type, from, to });
    if (fleetId) params.set('fleetId', fleetId);
    const res = await fetch(`/api/reports/csv?${params.toString()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('vizyo-tracky-token') ?? ''}` },
    });
    if (!res.ok) throw new Error(`CSV download failed (${res.status})`);
    const blob = await res.blob();
    this.triggerDownload(blob, `tracky-${type}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`);
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
