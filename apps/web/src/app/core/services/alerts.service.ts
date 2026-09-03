import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AlertEvent,
  FleetSpeedAlertSettingsDto,
  SetFleetSpeedAlertSettingsDto,
  SetVehicleSpeedAlertOverrideDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom, Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AlertsApiService {
  private readonly http = inject(HttpClient);

  list(params: Record<string, string> = {}): Observable<{ items: AlertEvent[]; nextCursor: string | null }> {
    return this.http.get<{ items: AlertEvent[]; nextCursor: string | null }>('/api/alerts', { params });
  }

  count(): Observable<{ total: number; critical: number }> {
    return this.http.get<{ total: number; critical: number }>('/api/alerts/unacknowledged/count');
  }

  acknowledge(id: string): Observable<AlertEvent> {
    return this.http.post<AlertEvent>(`/api/alerts/${id}/acknowledge`, {});
  }

  acknowledgeAll(): Observable<{ count: number }> {
    return this.http.post<{ count: number }>('/api/alerts/acknowledge-all', {});
  }

  // ── Lot V5 — alertes de vitesse nées de l'analyse de trajet ────────────────────────
  // `fleetId` : la société du sélecteur chez un super-admin ; `null` = la sienne pour les autres.

  private fleetParams(fleetId: string | null): Record<string, string> {
    return fleetId ? { fleetId } : {};
  }

  speedSettings(fleetId: string | null): Promise<FleetSpeedAlertSettingsDto> {
    return firstValueFrom(this.http.get<FleetSpeedAlertSettingsDto>('/api/alerts/speed-settings', { params: this.fleetParams(fleetId) }));
  }

  setSpeedSettings(fleetId: string | null, body: SetFleetSpeedAlertSettingsDto): Promise<FleetSpeedAlertSettingsDto> {
    return firstValueFrom(this.http.put<FleetSpeedAlertSettingsDto>('/api/alerts/speed-settings', body, { params: this.fleetParams(fleetId) }));
  }

  setVehicleSpeedOverride(fleetId: string | null, vehicleId: string, body: SetVehicleSpeedAlertOverrideDto): Promise<FleetSpeedAlertSettingsDto> {
    return firstValueFrom(this.http.put<FleetSpeedAlertSettingsDto>(`/api/alerts/speed-settings/vehicles/${vehicleId}`, body, { params: this.fleetParams(fleetId) }));
  }
}
