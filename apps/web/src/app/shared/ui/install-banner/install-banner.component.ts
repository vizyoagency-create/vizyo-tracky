import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideAngularModule, Download, Share, X, Plus } from 'lucide-angular';
import { InstallPromptService } from '../../../core/services/install-prompt.service';

/**
 * Banniere "Ajouter a l'ecran d'accueil" affichee une fois que l'utilisateur
 * a visite l'app au moins 3 fois et qu'on est dans un contexte installable.
 *
 * - Android Chrome : bouton qui declenche le prompt natif.
 * - iOS Safari : instructions visuelles (Partager -> Sur l'ecran d'accueil).
 *
 * Auto-masquee si :
 *  - l'app est deja en mode standalone,
 *  - l'utilisateur a rejete la banniere il y a < 30 jours.
 */
@Component({
  selector: 'app-install-banner',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="install-banner" role="dialog" aria-live="polite">
        <div class="banner-icon">
          <lucide-icon [img]="DownloadIcon" [size]="20"></lucide-icon>
        </div>
        <div class="banner-content">
          <p class="banner-title">Installer Tracky sur votre appareil</p>
          @if (mode() === 'android') {
            <p class="banner-subtitle">Acces rapide depuis l'ecran d'accueil, plein ecran, fonctionne hors-ligne.</p>
          } @else {
            <p class="banner-subtitle">
              Touchez
              <lucide-icon [img]="ShareIcon" [size]="14" class="inline-icon"></lucide-icon>
              puis "Sur l'ecran d'accueil"
              <lucide-icon [img]="PlusIcon" [size]="14" class="inline-icon"></lucide-icon>
            </p>
          }
        </div>
        <div class="banner-actions">
          @if (mode() === 'android') {
            <button (click)="onInstall()" class="banner-cta">Installer</button>
          }
          <button (click)="onDismiss()" class="banner-close" aria-label="Fermer">
            <lucide-icon [img]="XIcon" [size]="16"></lucide-icon>
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .install-banner {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: calc(60px + env(safe-area-inset-bottom) + 16px);
      z-index: 9000;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-strong);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(10px);
      animation: banner-slide-up 0.32s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @media (min-width: 768px) {
      .install-banner {
        bottom: 24px;
        left: auto;
        right: 24px;
        max-width: 420px;
      }
    }
    .banner-icon {
      width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #10e0a0 0%, #047857 100%);
      color: #042F2A;
    }
    .banner-content { flex: 1; min-width: 0; }
    .banner-title {
      font-size: 13px; font-weight: 700; color: var(--fg-primary); margin: 0;
    }
    .banner-subtitle {
      font-size: 11px; color: var(--fg-secondary); margin: 2px 0 0 0; line-height: 1.4;
    }
    .inline-icon {
      display: inline-block; vertical-align: middle; color: var(--tracky-light); margin: 0 1px;
    }
    .banner-actions {
      display: flex; align-items: center; gap: 6px; flex-shrink: 0;
    }
    .banner-cta {
      padding: 8px 14px; border-radius: 10px; border: none;
      background: var(--tracky); color: white;
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: transform 80ms, opacity 80ms;
    }
    .banner-cta:active { transform: scale(0.96); opacity: 0.9; }
    .banner-close {
      width: 28px; height: 28px; border-radius: 8px; border: none;
      background: transparent; color: var(--fg-tertiary); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: color 120ms, background 120ms;
    }
    .banner-close:hover { color: var(--fg-primary); background: var(--bg-tertiary); }

    @keyframes banner-slide-up {
      from { transform: translateY(120%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `],
})
export class InstallBannerComponent {
  private readonly install = inject(InstallPromptService);

  protected readonly DownloadIcon = Download;
  protected readonly ShareIcon = Share;
  protected readonly XIcon = X;
  protected readonly PlusIcon = Plus;

  protected readonly visible = computed(() => this.install.shouldShowBanner());
  protected readonly mode = computed<'android' | 'ios'>(() =>
    this.install.canInstall() ? 'android' : 'ios'
  );

  protected onInstall(): void {
    this.install.promptInstall();
  }

  protected onDismiss(): void {
    this.install.dismissBanner();
  }
}
