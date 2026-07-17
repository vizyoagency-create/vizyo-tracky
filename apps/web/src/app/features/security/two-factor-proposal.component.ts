import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { ConsentService } from '../../core/services/consent.service';
import { SecurityService } from '../../core/services/security.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Proposition DOUCE d'activer le 2FA — jamais imposée. Rendu par DashboardLayout
 * quand `security.propose()` (une connexion inhabituelle a été détectée pour un
 * utilisateur qui n'a pas encore activé le 2FA), et que rien de plus prioritaire ne
 * bloque. Refusable : « Plus tard » (réapparaîtra éventuellement) ou « Ne plus me
 * proposer » (définitif). Fermer en cliquant à l'extérieur = « Plus tard ».
 */
@Component({
  selector: 'app-two-factor-proposal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    @if (security.propose() && !security.mustVerify() && !consent.mustAccept()) {
      <div class="tf-overlay" (click)="later()">
        <div class="tf-shell" role="dialog" aria-modal="true" aria-labelledby="tf-title" (click)="$event.stopPropagation()">
          <span class="tf-badge"><lucide-icon [img]="ShieldCheck" [size]="24"></lucide-icon></span>
          <h1 id="tf-title" class="tf-title">Sécurisez votre compte</h1>
          <p class="tf-lead">
            Nous avons remarqué une connexion depuis un endroit ou un appareil inhabituel.
            Activez la <strong>vérification en 2 étapes</strong> : un simple code par e-mail vous
            protégera lors des connexions inhabituelles — sans vous gêner au quotidien.
          </p>

          <button type="button" class="tf-btn tf-btn--primary" (click)="enable()" [disabled]="busy()">
            {{ busy() ? 'Activation…' : 'Activer la vérification' }}
          </button>
          <div class="tf-secondary">
            <button type="button" class="tf-link" (click)="later()" [disabled]="busy()">Plus tard</button>
            <button type="button" class="tf-link tf-link--muted" (click)="never()" [disabled]="busy()">Ne plus me proposer</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .tf-overlay {
      position: fixed; inset: 0; z-index: 3800;
      background: color-mix(in srgb, var(--bg-primary) 78%, transparent);
      backdrop-filter: blur(5px);
      display: flex; align-items: center; justify-content: center; padding: 16px; font-family: inherit;
    }
    .tf-shell {
      width: 100%; max-width: 420px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 18px);
      box-shadow: 0 30px 80px -20px rgba(0,0,0,.55); padding: 28px 26px 22px; text-align: center;
    }
    .tf-badge {
      width: 52px; height: 52px; border-radius: 15px; margin: 0 auto 16px;
      background: color-mix(in srgb, var(--tracky-light) 16%, transparent);
      color: var(--tracky-light); display: flex; align-items: center; justify-content: center;
    }
    .tf-title { margin: 0 0 10px; font-size: 1.3rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .tf-lead { margin: 0 0 22px; font-size: .92rem; line-height: 1.6; color: var(--fg-secondary); }
    .tf-lead strong { color: var(--fg-primary); font-weight: 700; }
    .tf-btn {
      width: 100%; font: inherit; font-weight: 700; font-size: .95rem; padding: 13px; border-radius: 12px;
      cursor: pointer; border: 0;
    }
    .tf-btn:disabled { opacity: .6; cursor: not-allowed; }
    .tf-btn--primary { background: var(--tracky-light); color: #04130d; }
    .tf-secondary { display: flex; align-items: center; justify-content: center; gap: 18px; margin-top: 14px; }
    .tf-link { font: inherit; font-size: .84rem; font-weight: 600; background: none; border: 0; cursor: pointer; color: var(--fg-secondary); padding: 4px; }
    .tf-link--muted { color: var(--fg-tertiary); }
    .tf-link:hover:not(:disabled) { color: var(--fg-primary); text-decoration: underline; }
    `,
  ],
})
export class TwoFactorProposalComponent {
  readonly security = inject(SecurityService);
  readonly consent = inject(ConsentService);
  private readonly toast = inject(ToastService);

  readonly ShieldCheck = ShieldCheck;
  readonly busy = signal(false);

  async enable(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const ok = await this.security.enableTwoFactor();
    this.busy.set(false);
    if (ok) {
      this.toast.success('Vérification en 2 étapes activée', 'Votre compte est mieux protégé.');
    } else {
      this.toast.error("L'activation a échoué", 'Réessayez depuis Réglages → Sécurité.');
    }
  }

  /** Refus temporaire : ne persiste pas (pourra réapparaître plus tard). */
  later(): void {
    if (this.busy()) return;
    void this.security.dismissProposal(false);
  }

  /** Refus définitif : « ne plus me proposer ». */
  never(): void {
    if (this.busy()) return;
    void this.security.dismissProposal(true);
  }
}
