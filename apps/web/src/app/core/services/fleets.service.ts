import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface FleetSummary {
  id: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class FleetsApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<FleetSummary[]> {
    return this.http.get<FleetSummary[]>('/api/fleets');
  }
}
