import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { ConsentService } from '../../core/services/consent.service';
import { PortesAccesService } from '../../core/services/portes-acces.service';
import { SecurityService } from '../../core/services/security.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

/**
 * Écran de saisie du code (2FA app) — overlay bloquant, rendu par DashboardLayout
 * quand `security.mustVerify()` ET que le consentement ne bloque pas. Le code a
 * déjà été envoyé par /connection ; ici on le saisit (ou on le renvoie / se
 * déconnecte). Ne s'affiche QUE sur une vraie anomalie pour un utilisateur qui a
 * activé le 2FA — jamais imposé.
 */
@Component({
  selector: 'app-device-verification-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, LogoComponent],
  template: `
    @if (security.mustVerify() && !consent.mustAccept()) {
      <div class="dv-overlay" role="dialog" aria-modal="true" aria-labelledby="dv-title">
        <div class="dv-shell">
          <div class="dv-head">
            <span class="dv-badge"><lucide-icon [img]="ShieldCheck" [size]="22"></lucide-icon></span>
            <div>
              <h1 id="dv-title" class="dv-title">Confirmez cette connexion</h1>
              <p class="dv-sub">
                @if (portes.libelle('verification'); as rang) { {{ rang }} · }
                Connexion inhabituelle détectée
              </p>
            </div>
            <app-logo variant="icon" [size]="26" class="dv-logo" />
          </div>

          <p class="dv-lead">
            Vous avez activé la vérification en 2 étapes. Un code vient d'être envoyé à
            <strong>{{ security.maskedEmail() || 'votre adresse e-mail' }}</strong> — saisissez-le
            pour continuer.
          </p>

          <input class="dv-input" type="text" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="6" placeholder="— — — — — —" [value]="code()"
                 (input)="onCode($event)" (keyup.enter)="verify()"
                 aria-label="Code de vérification à 6 chiffres" />

          @if (error()) { <p class="dv-error">{{ error() }}</p> }

          <div class="dv-actions">
            <button type="button" class="dv-btn dv-btn--ghost" (click)="logout()" [disabled]="verifying()">
              Se déconnecter
            </button>
            <button type="button" class="dv-btn dv-btn--primary"
                    (click)="verify()" [disabled]="code().length !== 6 || verifying()">
              {{ verifying() ? 'Vérification…' : 'Vérifier' }}
            </button>
          </div>

          <button type="button" class="dv-resend" (click)="resend()"
                  [disabled]="sending() || cooldown() > 0">
            {{ sending() ? 'Envoi…' : cooldown() > 0 ? 'Renvoyer le code (' + cooldown() + 's)' : 'Renvoyer le code' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .dv-overlay {
      position: fixed; inset: 0; z-index: 3950;
      background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
      backdrop-filter: blur(8px) saturate(1.2);
      display: flex; align-items: center; justify-content: center; padding: 16px; font-family: inherit;
    }
    .dv-shell {
      width: 100%; max-width: 460px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 18px);
      box-shadow: 0 30px 80px -20px rgba(0,0,0,.55); padding: 26px 26px 20px;
      max-height: calc(100dvh - 32px); overflow-y: auto; text-align: left;
    }
    .dv-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .dv-badge {
      width: 46px; height: 46px; border-radius: 13px; flex: none;
      background: color-mix(in srgb, var(--tracky-light) 16%, transparent);
      color: var(--tracky-light); display: flex; align-items: center; justify-content: center;
    }
    .dv-title { margin: 0; font-size: 1.25rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .dv-sub { margin: 2px 0 0; font-size: .82rem; color: var(--fg-tertiary); }
    .dv-logo { margin-left: auto; opacity: .9; }
    .dv-lead { margin: 0 0 18px; font-size: .92rem; line-height: 1.6; color: var(--fg-secondary); }
    .dv-lead strong { color: var(--fg-primary); font-weight: 700; }
    .dv-input {
      width: 100%; box-sizing: border-box; font: inherit; font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
      font-size: 1.7rem; font-weight: 600; letter-spacing: .35em; text-align: center;
      padding: 13px 12px; border-radius: 12px; color: var(--fg-primary);
      background: var(--bg-tertiary); border: 1px solid var(--border-strong); outline: none;
    }
    .dv-input:focus { border-color: var(--tracky-light); }
    .dv-error { margin: 12px 0 0; font-size: .85rem; color: #f2706b; font-weight: 600; }
    .dv-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; margin-top: 18px; }
    .dv-btn {
      font: inherit; font-weight: 700; font-size: .9rem; padding: 11px 18px; border-radius: 11px;
      cursor: pointer; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-primary);
    }
    .dv-btn:disabled { opacity: .5; cursor: not-allowed; }
    .dv-btn--ghost { color: var(--fg-secondary); }
    .dv-btn--primary { border: 0; background: var(--tracky-light); color: #04130d; }
    .dv-resend {
      display: block; margin: 16px auto 0; font: inherit; font-size: .84rem; font-weight: 600;
      background: none; border: 0; color: var(--tracky-light); cursor: pointer; padding: 4px 8px;
    }
    .dv-resend:disabled { color: var(--fg-tertiary); cursor: default; }
    @media (max-width: 480px) { .dv-actions { flex-direction: column-reverse; } .dv-btn { width: 100%; } }
    `,
  ],
})
export class DeviceVerificationGateComponent {
  readonly security = inject(SecurityService);
  readonly consent = inject(ConsentService);
  /** Le rang de cette porte dans la file — calculé, jamais écrit (lot B0′). */
  readonly portes = inject(PortesAccesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  readonly ShieldCheck = ShieldCheck;

  readonly code = signal('');
  readonly sending = signal(false);
  readonly verifying = signal(false);
  readonly error = signal<string | null>(null);
  readonly cooldown = signal(0);

  private cooldownTimer?: ReturnType<typeof setInterval>;

  onCode(e: Event): void {
    const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
    this.code.set(v);
    if (this.error()) this.error.set(null);
  }

  async resend(): Promise<void> {
    if (this.sending() || this.cooldown() > 0) return;
    this.error.set(null);
    this.sending.set(true);
    const r = await this.security.resend();
    this.sending.set(false);
    if (!r.ok) this.error.set("L'envoi du code a échoué. Patientez un instant puis réessayez.");
    this.startCooldown(30);
  }

  async verify(): Promise<void> {
    if (this.code().length !== 6 || this.verifying()) return;
    this.verifying.set(true);
    this.error.set(null);
    const ok = await this.security.verify(this.code());
    if (ok) {
      window.location.reload();
    } else {
      this.verifying.set(false);
      this.error.set('Code incorrect ou expiré. Réessayez, ou renvoyez un nouveau code.');
    }
  }

  logout(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.toast.error('Déconnecté', 'Confirmez la connexion pour accéder à Vizyo Tracky.');
    void this.router.navigate(['/login']);
  }

  private startCooldown(seconds: number): void {
    this.cooldown.set(seconds);
    if (this.cooldownTimer) clearInterval(this.cooldownTimer);
    this.cooldownTimer = setInterval(() => {
      const n = this.cooldown() - 1;
      this.cooldown.set(n);
      if (n <= 0 && this.cooldownTimer) {
        clearInterval(this.cooldownTimer);
        this.cooldownTimer = undefined;
      }
    }, 1000);
  }
}
