import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AssignDriverDto,
  CreateDriverDto,
  DriverDto,
  DriverSummaryDto,
  TripDto,
  UpdateDriverDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom, Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class DriversApiService {
  private readonly http = inject(HttpClient);

  list(includeArchived = false): Promise<DriverDto[]> {
    const params: Record<string, string> = {};
    if (includeArchived) params['includeArchived'] = 'true';
    return firstValueFrom(this.http.get<DriverDto[]>('/api/drivers', { params }));
  }

  findOne(id: string): Observable<DriverDto> {
    return this.http.get<DriverDto>(`/api/drivers/${id}`);
  }

  create(data: CreateDriverDto): Observable<DriverDto> {
    return this.http.post<DriverDto>('/api/drivers', data);
  }

  update(id: string, data: UpdateDriverDto): Observable<DriverDto> {
    return this.http.patch<DriverDto>(`/api/drivers/${id}`, data);
  }

  /** Soft-delete : isActive=false (preserve historique Trip.driverId). */
  archive(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/drivers/${id}`);
  }

  /** RGPD art. 15 — export JSON complet des données du conducteur (blob → téléchargement). */
  gdprExport(id: string): Observable<Blob> {
    return this.http.get(`/api/drivers/${id}/gdpr-export`, { responseType: 'blob' });
  }

  /** RGPD art. 17 — anonymisation IRRÉVERSIBLE (PII effacée, compte désactivé). */
  anonymize(id: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`/api/drivers/${id}/anonymize`, { confirm: true });
  }

  /** Defini/retire le conducteur courant d'un vehicule. */
  assignToVehicle(vehicleId: string, driverId: string | null): Observable<{ currentDriver: DriverSummaryDto | null } & Record<string, unknown>> {
    const body: AssignDriverDto = { driverId };
    return this.http.patch<{ currentDriver: DriverSummaryDto | null } & Record<string, unknown>>(
      `/api/vehicles/${vehicleId}/driver`,
      body,
    );
  }

  /** Reaffecte le conducteur d'un trajet a posteriori (driverSource='MANUAL'). */
  assignToTrip(tripId: string, driverId: string | null): Observable<TripDto> {
    const body: AssignDriverDto = { driverId };
    return this.http.patch<TripDto>(`/api/trips/${tripId}/driver`, body);
  }
}
