import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Bell, BellRing, LucideAngularModule, X } from 'lucide-angular';
import { NotificationsApiService } from '../../../core/services/notifications.service';
import { RealtimeService } from '../../../core/services/realtime.service';
import { ToastService } from '../toast/toast.service';

const DISMISS_KEY = 'tracky.push-prompt.dismissed-at';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/**
 * Onboarding contextuel : prompt discret invitant l'utilisateur a activer les
 * notifications push, declenche au moment ou ca compte vraiment (au moins une
 * alerte CRITICAL non acquittee). Tant qu'aucune CRITICAL n'arrive, le toggle
 * reste cache dans /account et le user n'est pas spamme.
 *
 * Conditions d'affichage (TOUTES requises) :
 *   - serveur push actif (VAPID keys configurees)
 *   - browser push supporte (Chrome/Firefox/Edge, Safari iOS PWA only)
 *   - pas deja abonne sur ce device
 *   - pas dismiss dans les 7 derniers jours
 *   - au moins 1 alerte CRITICAL non acquittee dans la session courante
 */
@Component({
  selector: 'app-push-prompt',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="push-prompt" role="dialog" aria-live="polite" aria-labelledby="push-prompt-title">
        <div class="prompt-icon">
          <lucide-icon [img]="BellRingIcon" [size]="20"></lucide-icon>
        </div>
        <div class="prompt-content">
          <p id="push-prompt-title" class="prompt-title">Activer les notifications</p>
          <p class="prompt-subtitle">
            Recevez les alertes critiques meme app fermee, sur ce device.
          </p>
        </div>
        <div class="prompt-actions">
          <button (click)="onActivate()"
                  class="prompt-cta"
                  [disabled]="loading()"
                  type="button">
            {{ loading() ? '…' : 'Activer' }}
          </button>
          <button (click)="onDismiss()"
                  class="prompt-close"
                  aria-label="Plus tard"
                  type="button">
            <lucide-icon [img]="XIcon" [size]="16"></lucide-icon>
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .push-prompt {
      position: fixed;
      top: calc(env(safe-area-inset-top) + 64px);
      right: 16px;
      left: 16px;
      z-index: 8500;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-strong);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(10px);
      animation: push-prompt-slide-down 0.32s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @media (min-width: 768px) {
      .push-prompt {
        top: calc(env(safe-area-inset-top) + 72px);
        left: auto;
        right: 24px;
        max-width: 380px;
      }
    }
    .prompt-icon {
      width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #f59e0b 0%, #dc2626 100%);
      color: #fff;
    }
    .prompt-content { flex: 1; min-width: 0; }
    .prompt-title {
      font-size: 13px; font-weight: 700; color: var(--fg-primary); margin: 0;
    }
    .prompt-subtitle {
      font-size: 11px; color: var(--fg-secondary); margin: 2px 0 0 0; line-height: 1.4;
    }
    .prompt-actions {
      display: flex; align-items: center; gap: 6px; flex-shrink: 0;
    }
    .prompt-cta {
      padding: 8px 14px; border-radius: 10px; border: none;
      background: var(--tracky-light, #10E0A0);
      color: var(--bg-primary, #0b0f12);
      font-size: 12px; font-weight: 700; cursor: pointer;
      transition: transform 80ms, opacity 80ms, filter 120ms;
    }
    .prompt-cta:hover:not([disabled]) { filter: brightness(1.05); }
    .prompt-cta:active:not([disabled]) { transform: scale(0.96); opacity: 0.9; }
    .prompt-cta[disabled] { opacity: 0.55; cursor: not-allowed; }
    .prompt-close {
      width: 28px; height: 28px; border-radius: 8px; border: none;
      background: transparent; color: var(--fg-tertiary); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: color 120ms, background 120ms;
    }
    .prompt-close:hover { color: var(--fg-primary); background: var(--bg-tertiary); }

    @keyframes push-prompt-slide-down {
      from { transform: translateY(-120%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `],
})
export class PushPromptComponent {
  protected readonly notif = inject(NotificationsApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  protected readonly BellIcon = Bell;
  protected readonly BellRingIcon = BellRing;
  protected readonly XIcon = X;

  protected readonly loading = signal(false);
  /**
   * Signal local pour masquer en cas de dismiss session (pas de re-evaluation
   * du localStorage, l'effet est immediat). Reset au prochain reload.
   */
  private readonly dismissedThisSession = signal(false);

  protected readonly visible = computed(() => {
    if (this.dismissedThisSession()) return false;
    if (this.notif.pushEnabled() !== true) return false;
    if (!this.notif.isPushSupported()) return false;
    if (this.notif.isSubscribed()) return false;
    if (!this.realtime.hasCritical()) return false;
    if (this.isCooldownActive()) return false;
    return true;
  });

  protected async onActivate(): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.notif.subscribePush();
      if (result.ok) {
        this.toast.success('Notifications activees', 'Vous recevrez les alertes critiques meme app fermee.');
        this.dismissedThisSession.set(true);
      } else {
        this.toast.error(result.reason ?? 'Echec de l\'activation', 'Verifiez les permissions du navigateur.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  protected onDismiss(): void {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {/* localStorage indisponible */}
    this.dismissedThisSession.set(true);
  }

  private isCooldownActive(): boolean {
    try {
      const at = Number(localStorage.getItem(DISMISS_KEY) ?? '0') || 0;
      if (at <= 0) return false;
      return Date.now() - at < DISMISS_COOLDOWN_MS;
    } catch {
      return false;
    }
  }
}
