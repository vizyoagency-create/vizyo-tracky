import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { ConsentService } from '../../core/services/consent.service';
import { PortesAccesService } from '../../core/services/portes-acces.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

const LEGAL_URL = 'https://tracky.vizyoagency.com/mentions-legales.html';

/**
 * Écran de consentement OBLIGATOIRE au login (P2) — overlay bloquant, non
 * dismissible. Rendu par DashboardLayoutComponent quand `consent.mustAccept()`.
 * Accepter → enregistre CGU + Confidentialité puis recharge (ré-init des données
 * qui avaient été bloquées par le gate 403). Refuser → déconnexion.
 */
@Component({
  selector: 'app-consent-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, LogoComponent],
  template: `
    @if (consent.mustAccept()) {
      <div class="cg-overlay" role="dialog" aria-modal="true" aria-labelledby="cg-title">
        <div class="cg-shell">
          <div class="cg-head">
            <span class="cg-badge"><lucide-icon [img]="ShieldCheck" [size]="22"></lucide-icon></span>
            <div>
              <h1 id="cg-title" class="cg-title">Bienvenue sur Vizyo Tracky</h1>
              <p class="cg-sub">
                @if (portes.libelle('consentement'); as rang) { {{ rang }} · }
                Un instant avant de démarrer
              </p>
            </div>
            <app-logo variant="icon" [size]="26" class="cg-logo" />
          </div>

          <p class="cg-lead">
            Merci de confirmer que vous acceptez nos conditions d'utilisation. Vos données
            sont hébergées en France, sécurisées, et vous en gardez le contrôle à tout
            moment (accès, rectification, suppression).
          </p>

          <label class="cg-check">
            <input type="checkbox" [checked]="accepted()" (change)="accepted.set(isChecked($event))" />
            <span>J'ai lu et j'accepte les
              <a [href]="legalUrl" target="_blank" rel="noopener">conditions d'utilisation et la politique de confidentialité</a>.</span>
          </label>

          <p class="cg-note">
            Pensez à informer vos conducteurs de l'utilisation du service.
          </p>

          @if (error()) { <p class="cg-error">{{ error() }}</p> }

          <div class="cg-actions">
            <button type="button" class="cg-btn cg-btn--ghost" (click)="refuse()" [disabled]="busy()">
              Refuser et me déconnecter
            </button>
            <button type="button" class="cg-btn cg-btn--primary"
                    (click)="accept()" [disabled]="!accepted() || busy()">
              {{ busy() ? 'Un instant…' : 'Accepter et continuer' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .cg-overlay {
      position: fixed; inset: 0; z-index: 4000;
      background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
      backdrop-filter: blur(8px) saturate(1.2);
      display: flex; align-items: center; justify-content: center; padding: 16px;
      font-family: inherit;
    }
    .cg-shell {
      width: 100%; max-width: 540px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 18px);
      box-shadow: 0 30px 80px -20px rgba(0,0,0,.55); padding: 26px 26px 22px;
      max-height: calc(100dvh - 32px); overflow-y: auto;
    }
    .cg-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .cg-badge {
      width: 46px; height: 46px; border-radius: 13px; flex: none;
      background: color-mix(in srgb, var(--tracky-light) 16%, transparent);
      color: var(--tracky-light); display: flex; align-items: center; justify-content: center;
    }
    .cg-title { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .cg-sub { margin: 2px 0 0; font-size: .84rem; color: var(--fg-tertiary); }
    .cg-logo { margin-left: auto; opacity: .9; }
    .cg-lead { margin: 0 0 18px; font-size: .93rem; line-height: 1.6; color: var(--fg-secondary); }
    .cg-check {
      display: flex; gap: 11px; align-items: flex-start; padding: 12px 0;
      font-size: .9rem; line-height: 1.5; color: var(--fg-secondary);
      border-top: 1px solid var(--border-subtle); cursor: pointer;
    }
    .cg-check input { width: 19px; height: 19px; margin-top: 1px; flex: none; accent-color: var(--tracky-light); cursor: pointer; }
    .cg-check a { color: var(--tracky-light); text-decoration: none; font-weight: 600; }
    .cg-check a:hover { text-decoration: underline; }
    .cg-note {
      margin: 14px 0 0; padding: 11px 13px; border-radius: 11px; font-size: .82rem; line-height: 1.5;
      background: var(--bg-tertiary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle);
    }
    .cg-error { margin: 12px 0 0; font-size: .85rem; color: #f2706b; font-weight: 600; }
    .cg-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; margin-top: 20px; }
    .cg-btn {
      font: inherit; font-weight: 700; font-size: .9rem; padding: 11px 18px; border-radius: 11px;
      cursor: pointer; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-primary);
    }
    .cg-btn:disabled { opacity: .5; cursor: not-allowed; }
    .cg-btn--ghost { color: var(--fg-secondary); }
    .cg-btn--primary { border: 0; background: var(--tracky-light); color: #04130d; }
    @media (max-width: 560px) { .cg-actions { flex-direction: column-reverse; } .cg-btn { width: 100%; } }
    `,
  ],
})
export class ConsentGateComponent {
  readonly consent = inject(ConsentService);
  /** Le rang de cette porte dans la file — calculé, jamais écrit (lot B0′). */
  readonly portes = inject(PortesAccesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  readonly ShieldCheck = ShieldCheck;
  readonly legalUrl = LEGAL_URL;

  readonly accepted = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  isChecked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  async accept(): Promise<void> {
    if (!this.accepted() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const ok = await this.consent.accept();
    if (ok) {
      // Recharge propre : ré-initialise les données qui avaient été bloquées (403) avant l'accord.
      window.location.reload();
    } else {
      this.busy.set(false);
      this.error.set("L'enregistrement a échoué. Réessayez, ou contactez-nous si cela persiste.");
    }
  }

  refuse(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.toast.error('Déconnecté', 'Vous devez accepter les conditions pour utiliser Vizyo Tracky.');
    void this.router.navigate(['/login']);
  }
}
