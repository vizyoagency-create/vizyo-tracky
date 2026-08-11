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
      <!--
        ELLE SORT DE LA PILE (B1 § F). Cette surface n'est PAS une porte : c'est une
        proposition refusable. Elle portait pourtant le meme voile opaque que le
        consentement et la verification d'appareil — donc le meme poids a l'oeil, alors
        qu'elle ne bloque rien. Le voile descend a 22 % : on voit l'application derriere,
        et on comprend avant de lire qu'on peut passer.
      -->
      <div class="tf-overlay" (click)="later()">
        <div class="tf-shell" role="dialog" aria-modal="true" aria-labelledby="tf-title" (click)="$event.stopPropagation()">
          <span class="tf-poignee" aria-hidden="true"></span>
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
            <button type="button" class="tf-link" (click)="never()" [disabled]="busy()">Ne plus me proposer</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
    /*
     * VOILE A 22 % — et non 78 %. C'etait le voile d'une PORTE, sur une surface qui ne
     * bloque rien : on lisait « vous ne passerez pas » avant meme le titre. A 22 %,
     * l'application reste visible derriere, et le refus se sent possible.
     */
    .tf-overlay {
      position: fixed; inset: 0; z-index: 3800;
      background: color-mix(in srgb, var(--bg-primary) 22%, transparent);
      backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center; padding: 16px; font-family: inherit;
    }
    .tf-shell {
      width: 100%; max-width: 420px; background: var(--bg-secondary);
      border: 1px solid var(--border-strong); border-radius: var(--radius-card, 18px);
      padding: 28px 26px 22px; text-align: center;
    }
    .tf-poignee { display: none; }
    .tf-badge {
      width: 52px; height: 52px; border-radius: 15px; margin: 0 auto 16px;
      background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent);
      color: var(--texte-succes); display: flex; align-items: center; justify-content: center;
    }
    .tf-title { margin: 0 0 10px; font-size: 1.3rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .tf-lead { margin: 0 0 22px; font-size: .92rem; line-height: 1.6; color: var(--fg-secondary); }
    .tf-lead strong { color: var(--fg-primary); font-weight: 700; }
    .tf-btn {
      width: 100%; min-height: 48px; font: inherit; font-weight: 700; font-size: .95rem;
      padding: 13px; border-radius: 12px; cursor: pointer; border: 0;
    }
    .tf-btn:disabled { opacity: .6; cursor: not-allowed; }
    .tf-btn--primary { background: var(--color-tracky-light); color: var(--accent-ink); }
    /*
     * TROIS SORTIES VISIBLES. « Ne plus me proposer » etait en --fg-tertiary : le refus
     * DEFINITIF, celui qui engage le plus, etait le MOINS lisible des trois. Les deux refus
     * prennent la meme couleur ; ce qui les distingue est leur libelle, pas leur contraste.
     * Un refus qu'on n'arrive pas a lire n'est pas une sortie offerte.
     */
    .tf-secondary { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
    .tf-link {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; padding: 4px 12px; border-radius: 10px;
      font: inherit; font-size: .84rem; font-weight: 600;
      background: none; border: 0; cursor: pointer; color: var(--fg-secondary);
    }
    .tf-link:hover:not(:disabled) { color: var(--fg-primary); text-decoration: underline; }

    /* ─── Sous 640 px : une FEUILLE, pas une boîte centrée ─────────────────────
       Même géométrie que la confirmation du kit : rayon et poignée depuis les
       jetons de plateforme — iOS 22 px / 36 × 5, Android 28 px / 32 × 4. Les
       aplatir donnerait une application étrangère sur les deux plateformes. */
    @media (max-width: 639px) {
      .tf-overlay { align-items: flex-end; padding: 0; }
      .tf-shell {
        max-width: none; border: 0;
        border-top-left-radius: var(--feuille-rayon);
        border-top-right-radius: var(--feuille-rayon);
        border-bottom-left-radius: 0; border-bottom-right-radius: 0;
        padding: 8px 20px calc(20px + env(safe-area-inset-bottom));
        max-height: 88dvh; overflow-y: auto;
      }
      .tf-poignee {
        display: block; margin: 4px auto 14px;
        width: var(--feuille-poignee-l); height: var(--feuille-poignee-h);
        border-radius: 9999px; background: var(--fg-secondary); opacity: .45;
      }
      /* Au pouce, les deux refus s'empilent plutot que de se serrer. */
      .tf-secondary { flex-direction: column; gap: 2px; }
      .tf-link { width: 100%; }
    }
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
