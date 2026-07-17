import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface ConsentStatus {
  version: string;
  cgu: boolean;
  privacy: boolean;
  required: boolean;
}

/**
 * Gate de consentement RGPD côté front (P2). Miroir d'OnboardingService, mais NON
 * dismissible : tant que `mustAccept()` est vrai, le DashboardLayout rend un overlay
 * bloquant (app-consent-gate). Alimenté :
 *  - au boot du shell par `load()` (GET /api/consent/current — endpoint exempté du gate),
 *  - et en secours par l'interceptor HTTP sur un 403 { code:'CONSENT_REQUIRED' }.
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  private readonly http = inject(HttpClient);

  readonly mustAccept = signal(false);
  readonly version = signal<string | null>(null);

  /** Charge le statut et lève le gate si un accord est requis. */
  async load(): Promise<void> {
    try {
      const s = await firstValueFrom(this.http.get<ConsentStatus>('/api/consent/current'));
      this.version.set(s.version);
      this.mustAccept.set(!!s.required);
    } catch {
      // Silencieux : un 403 CONSENT_REQUIRED sur un autre appel lèvera le gate.
    }
  }

  /** Enregistre l'acceptation CGU + Confidentialité (version courante). */
  async accept(): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post('/api/consent/accept', {}));
      this.mustAccept.set(false);
      return true;
    } catch {
      return false;
    }
  }

  /** Backstop appelé par l'interceptor sur un 403 CONSENT_REQUIRED. */
  require(): void {
    this.mustAccept.set(true);
  }

  reset(): void {
    this.mustAccept.set(false);
  }
}
