import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface ConnectionDecision {
  action: 'allow' | 'challenge';
  propose: boolean;
  location: { city: string | null; region: string | null; country: string | null };
  maskedEmail: string;
}

/**
 * Sécurité des connexions (2FA app opt-in adaptatif) — état côté front.
 *
 * Au boot, `connect()` appelle /api/security/connection : le serveur journalise la
 * connexion (appareil + position géo-IP) et décide. Si l'utilisateur a activé le 2FA
 * et que la connexion est anormale → `mustVerify` (écran de code). Sinon, si une
 * anomalie est détectée et que le 2FA n'est pas activé → `propose` (proposition douce
 * et refusable). Rien n'est imposé.
 */
@Injectable({ providedIn: 'root' })
export class SecurityService {
  private readonly http = inject(HttpClient);

  /** Un code e-mail est requis (challenge en cours). */
  readonly mustVerify = signal(false);
  /** Proposer (en douceur) d'activer le 2FA. */
  readonly propose = signal(false);
  readonly maskedEmail = signal<string | null>(null);
  readonly location = signal<{ city: string | null; region: string | null; country: string | null } | null>(null);
  /** 2FA activé par l'utilisateur. */
  readonly twoFactorEnabled = signal(false);

  /** Boot : enregistre la connexion et applique la décision (challenge / proposition). */
  async connect(): Promise<void> {
    try {
      const d = await firstValueFrom(
        this.http.post<ConnectionDecision>('/api/security/connection', {}),
      );
      this.maskedEmail.set(d.maskedEmail ?? null);
      this.location.set(d.location ?? null);
      if (d.action === 'challenge') this.mustVerify.set(true);
      else if (d.propose) this.propose.set(true);
    } catch {
      // Silencieux : un 403 DEVICE_VERIFICATION_REQUIRED sur un autre appel lèvera le gate.
    }
  }

  async verify(code: string): Promise<boolean> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean }>('/api/security/verify', { code }),
      );
      if (r?.ok) this.mustVerify.set(false);
      return !!r?.ok;
    } catch {
      return false;
    }
  }

  async resend(): Promise<{ ok: boolean; email?: string }> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; email?: string }>('/api/security/resend', {}),
      );
      if (r?.email) this.maskedEmail.set(r.email);
      return { ok: !!r?.ok, email: r?.email };
    } catch {
      return { ok: false };
    }
  }

  // ── 2FA opt-in ────────────────────────────────────────────────────────────────

  async loadTwoFactorStatus(): Promise<void> {
    try {
      const s = await firstValueFrom(
        this.http.get<{ enabled: boolean; dismissed: boolean }>('/api/security/2fa/status'),
      );
      this.twoFactorEnabled.set(!!s?.enabled);
    } catch {
      /* silencieux */
    }
  }

  async enableTwoFactor(): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post('/api/security/2fa/enable', {}));
      this.twoFactorEnabled.set(true);
      this.propose.set(false);
      return true;
    } catch {
      return false;
    }
  }

  /** Désactivation — étape 1 : demande l'envoi d'un code e-mail de confirmation. */
  async sendDisableCode(): Promise<{ ok: boolean; email?: string }> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; email?: string }>('/api/security/2fa/disable/send-code', {}),
      );
      return { ok: !!r?.ok, email: r?.email };
    } catch {
      return { ok: false };
    }
  }

  /** Désactivation — étape 2 : confirme avec le code reçu (échoue si code invalide). */
  async disableTwoFactor(code: string): Promise<boolean> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; enabled: boolean }>('/api/security/2fa/disable', { code }),
      );
      if (r?.ok) this.twoFactorEnabled.set(false);
      return !!r?.ok;
    } catch {
      return false;
    }
  }

  /** Écarte la proposition. `persist=true` → « ne plus me proposer » (serveur). */
  async dismissProposal(persist: boolean): Promise<void> {
    this.propose.set(false);
    if (persist) {
      try {
        await firstValueFrom(this.http.post('/api/security/2fa/dismiss', {}));
      } catch {
        /* best-effort */
      }
    }
  }

  /** Backstop appelé par l'interceptor sur un 403 DEVICE_VERIFICATION_REQUIRED. */
  require(): void {
    this.mustVerify.set(true);
  }
}
