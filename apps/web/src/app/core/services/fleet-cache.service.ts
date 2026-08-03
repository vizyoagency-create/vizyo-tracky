import { swallow } from '../../core/error/swallow';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { FleetsApiService } from './fleets.service';

/**
 * V1.15 — Cache local des flottes pour le shell.
 *
 * Permet aux pages "liste avec cards" d'afficher le nom de flotte (badge
 * contextuel SUPER_ADMIN) sans faire un round-trip par card. Chargement
 * paresseux : on n'appelle l'API que si SUPER_ADMIN (les autres roles
 * n'ont qu'une seule flotte, pas besoin de badge).
 *
 * Pattern : signal-based getter, retour synchrone apres `loadIfNeeded()`.
 * La carte fleetId -> name est stockee en memoire — ttl session (re-chargee
 * au prochain mount du shell apres login/logout).
 */
@Injectable({ providedIn: 'root' })
export class FleetCacheService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(FleetsApiService);

  private readonly _fleets = signal<Map<string, string>>(new Map());
  private loading = false;
  private loaded = false;

  /** Reactive signal — utilise par les composants qui veulent reagir au load. */
  readonly fleets = this._fleets.asReadonly();

  /**
   * Charge la liste des flottes (une seule fois, idempotent). No-op si
   * l'utilisateur n'est pas SUPER_ADMIN (les autres roles ont une seule
   * flotte, le contexte n'est pas utile).
   */
  async loadIfNeeded(): Promise<void> {
    if (this.loaded || this.loading) return;
    if (this.auth.user()?.role !== 'SUPER_ADMIN') return;
    this.loading = true;
    try {
      const list = await firstValueFrom(this.api.list());
      const map = new Map<string, string>();
      for (const f of list) map.set(f.id, f.name);
      this._fleets.set(map);
      this.loaded = true;
    } catch (err) {
      // silencieux : badge restera vide si le fetch echoue, c'est non bloquant
      swallow('fleet-cache:loadIfNeeded', err);
    } finally {
      this.loading = false;
    }
  }

  /** Lookup synchrone du nom de flotte. Retourne null si introuvable (ou pas SA). */
  getName(fleetId: string | null | undefined): string | null {
    if (!fleetId) return null;
    return this._fleets().get(fleetId) ?? null;
  }
}
