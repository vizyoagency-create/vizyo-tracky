import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { GpsZoneDiagnosticDto, TraiterZoneDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/** Diagnostics de qualité GPS — produits par l'agent sur poste, lus ici. */
@Injectable({ providedIn: 'root' })
export class GpsDiagnosticApiService {
  private readonly http = inject(HttpClient);

  zones(tous = false): Observable<GpsZoneDiagnosticDto[]> {
    return this.http.get<GpsZoneDiagnosticDto[]>('/api/gps-diagnostics/zones', {
      params: tous ? { tous: 'true' } : {},
    });
  }

  traiter(id: string, dto: TraiterZoneDto): Observable<GpsZoneDiagnosticDto> {
    return this.http.post<GpsZoneDiagnosticDto>(
      `/api/gps-diagnostics/zones/${encodeURIComponent(id)}/traiter`,
      dto,
    );
  }
}
