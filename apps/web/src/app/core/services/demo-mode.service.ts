import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { swallow } from '../error/swallow';

/**
 * Environnement de démonstration (2026-09) — docs/environnement-demo/PLAN-2026-09-07.md.
 *
 * Le web apprend qu'il parle à la DÉMO par `GET /api/health`, public — donc dès la page de
 * connexion, avant toute session. Le même bundle sert la production et la démo : c'est l'API
 * qui le dit, jamais le domaine ni une variable de build.
 *
 * Un échec (réseau, API dégradée en 503) laisse le drapeau à `false` : une démo sans bandeau
 * pendant une seconde vaut mieux qu'une production qui se croirait démo. Le bandeau apparaît dès
 * que la réponse arrive — le signal fait le reste.
 */
@Injectable({ providedIn: 'root' })
export class DemoModeService {
  private readonly http = inject(HttpClient);
  /** true = cette instance est l'environnement de démonstration. */
  readonly enabled = signal(false);
  private charge = false;

  async charger(): Promise<void> {
    if (this.charge) return;
    this.charge = true;
    try {
      const sante = await firstValueFrom(this.http.get<{ demo?: boolean }>('/api/health'));
      this.enabled.set(sante?.demo === true);
    } catch (err) {
      swallow('demo-mode:charger', err);
    }
  }
}
