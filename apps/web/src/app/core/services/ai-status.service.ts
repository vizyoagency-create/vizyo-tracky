import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { AiStatusDto, FleetAiSettingDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * IA — état & interrupteur maître par flotte (2026-07). Le front masque les actions IA quand l'IA est
 * DÉSACTIVÉE pour la flotte de l'utilisateur (l'analyse déterministe des trajets/stations/scores reste
 * accessible). Optimiste par défaut (`enabled=true`) tant que le statut n'est pas chargé : le vrai
 * garde-fou reste côté serveur (403), l'UI n'est qu'un confort.
 */
@Injectable({ providedIn: 'root' })
export class AiStatusService {
  private readonly http = inject(HttpClient);
  private readonly _status = signal<AiStatusDto | null>(null);
  private loading = false;

  readonly status = this._status.asReadonly();
  /** IA utilisable pour la flotte de l'utilisateur (config serveur + interrupteur maître ON). */
  readonly enabled = computed(() => this._status()?.enabled ?? true);
  /** Au moins une clé provider présente côté serveur. */
  readonly configured = computed(() => this._status()?.configured ?? false);

  /** Charge le statut une seule fois (à appeler à l'init d'un composant IA). */
  ensureLoaded(): void {
    if (this._status() || this.loading) return;
    this.refresh();
  }

  /** (Re)charge le statut IA (best-effort, silencieux). */
  refresh(): void {
    this.loading = true;
    this.http.get<AiStatusDto>('/api/ai/status').subscribe({
      next: (s) => { this._status.set(s); this.loading = false; },
      error: () => { this.loading = false; /* garde l'état optimiste */ },
    });
  }

  /** Réglage IA courant d'une flotte (pour l'UI de réglages). */
  getFleetEnabled(fleetId?: string): Observable<FleetAiSettingDto> {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<FleetAiSettingDto>('/api/ai/fleet-enabled', { params });
  }

  /** Active/désactive TOUTE l'IA d'une flotte (fleet-admin : sa flotte ; super-admin : `fleetId`). */
  setFleetEnabled(enabled: boolean, fleetId?: string): Observable<FleetAiSettingDto> {
    return this.http.put<FleetAiSettingDto>('/api/ai/fleet-enabled', fleetId ? { enabled, fleetId } : { enabled });
  }
}
