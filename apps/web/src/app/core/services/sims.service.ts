import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AssignableTrackerDto,
  BulkCreateSimResultDto,
  CreateSimDto,
  SimConsumptionPointDto,
  SimDto,
  SimEventDto,
  SimStatsDto,
  UpdateSimDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';

/**
 * V1.16 — Client API Parc SIM (WhereverSIM).
 * Lecture / assignation : sims_view / sims_assign (FLEET_ADMIN + SUPER_ADMIN
 * bypassent). Gestion (sync, allocation, cycle de vie) : SUPER_ADMIN (gate serveur).
 */
@Injectable({ providedIn: 'root' })
export class SimsApiService {
  private readonly http = inject(HttpClient);

  list(params: { q?: string; unassigned?: boolean; fleetId?: string } = {}): Promise<SimDto[]> {
    let p = new HttpParams();
    if (params.q) p = p.set('q', params.q);
    if (params.unassigned) p = p.set('unassigned', 'true');
    if (params.fleetId) p = p.set('fleetId', params.fleetId);
    return firstValueFrom(this.http.get<SimDto[]>('/api/sims', { params: p }));
  }

  findOne(id: string): Promise<SimDto> {
    return firstValueFrom(this.http.get<SimDto>(`/api/sims/${id}`));
  }

  assignableTrackers(): Promise<AssignableTrackerDto[]> {
    return firstValueFrom(this.http.get<AssignableTrackerDto[]>('/api/sims/assignable-trackers'));
  }

  stats(): Promise<SimStatsDto> {
    return firstValueFrom(this.http.get<SimStatsDto>('/api/sims/stats'));
  }

  sync(): Promise<{ synced: number; total: number }> {
    return firstValueFrom(this.http.post<{ synced: number; total: number }>('/api/sims/sync', {}));
  }

  create(data: CreateSimDto): Promise<SimDto> {
    return firstValueFrom(this.http.post<SimDto>('/api/sims', data));
  }

  bulkCreate(raw: string): Promise<BulkCreateSimResultDto> {
    return firstValueFrom(this.http.post<BulkCreateSimResultDto>('/api/sims/bulk', { raw }));
  }

  update(id: string, data: UpdateSimDto): Promise<SimDto> {
    return firstValueFrom(this.http.patch<SimDto>(`/api/sims/${id}`, data));
  }

  remove(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/sims/${id}`));
  }

  assign(id: string, trackerId: string): Promise<SimDto> {
    return firstValueFrom(this.http.post<SimDto>(`/api/sims/${id}/assign`, { trackerId }));
  }

  unassign(id: string): Promise<SimDto> {
    return firstValueFrom(this.http.post<SimDto>(`/api/sims/${id}/unassign`, {}));
  }

  setStatus(id: string, statusId: number): Promise<SimDto> {
    return firstValueFrom(this.http.post<SimDto>(`/api/sims/${id}/status`, { statusId }));
  }

  setDataLimit(id: string, bytes: number | null): Promise<SimDto> {
    return firstValueFrom(this.http.post<SimDto>(`/api/sims/${id}/data-limit`, { bytes }));
  }

  sendSms(id: string, text: string): Promise<{ sent: boolean }> {
    return firstValueFrom(this.http.post<{ sent: boolean }>(`/api/sims/${id}/sms`, { text }));
  }

  consumption(id: string, from?: string, to?: string): Promise<SimConsumptionPointDto[]> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return firstValueFrom(
      this.http.get<SimConsumptionPointDto[]>(`/api/sims/${id}/consumption`, { params: p }),
    );
  }

  events(id: string, nextToken?: string): Promise<{ items: SimEventDto[]; nextToken: string | null }> {
    let p = new HttpParams();
    if (nextToken) p = p.set('nextToken', nextToken);
    return firstValueFrom(
      this.http.get<{ items: SimEventDto[]; nextToken: string | null }>(`/api/sims/${id}/events`, {
        params: p,
      }),
    );
  }
}
