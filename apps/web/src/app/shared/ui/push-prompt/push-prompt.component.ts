import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Bell, BellRing, LucideAngularModule, X } from 'lucide-angular';
import { NotificationsApiService } from '../../../core/services/notifications.service';
import { ToastService } from '../toast/toast.service';

const DISMISS_KEY = 'tracky.push-prompt.dismissed-at';
const IOS_HINT_DISMISS_KEY = 'tracky.push-prompt-ios-hint.dismissed-at';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const SHOW_DELAY_MS = 2500; // delai avant affichage au boot — evite de surprendre

/**
 * Onboarding : prompt discret invitant l'utilisateur a activer les notifications
 * push. Affiche peu apres l'arrivee sur le dashboard pour que l'utilisateur
 * acquiesce avant qu'une alerte critique n'arrive.
 *
 * Le delai de 2.5s evite de spammer la perm dialog des le premier paint, et la
 * permission Notification API doit etre demandee depuis un handler d'interaction
 * (clic "Activer") — d'ou le 2-step prompt (notre toast → clic → perm system).
 *
 * Conditions d'affichage (TOUTES requises) :
 *   - serveur push actif (VAPID keys configurees)
 *   - browser push supporte (Chrome/Firefox/Edge, Safari iOS PWA only)
 *   - permission systeme pas deja explicitement refusee
 *   - pas deja abonne sur ce device
 *   - pas dismiss dans les 7 derniers jours
 *   - delai d'affichage ecoule (eviter clignotement au boot)
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
    } @else if (visibleIosPwaHint()) {
      <div class="push-prompt" role="dialog" aria-live="polite" aria-labelledby="ios-pwa-prompt-title">
        <div class="prompt-icon prompt-icon--ios">
          <lucide-icon [img]="BellRingIcon" [size]="20"></lucide-icon>
        </div>
        <div class="prompt-content">
          <p id="ios-pwa-prompt-title" class="prompt-title">Notifications sur iPhone</p>
          <p class="prompt-subtitle">
            Pour les recevoir : Partager → "Sur l'écran d'accueil", puis ouvre Tracky depuis l'icône.
          </p>
        </div>
        <div class="prompt-actions">
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
    .prompt-icon--ios {
      /* Vert Tracky pour le hint iOS — different visuellement du prompt
         "activer" (gradient ambre/rouge urgent). C'est un onboarding pas
         une alerte. */
      background: linear-gradient(135deg, #10E0A0 0%, #059669 100%);
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
export class PushPromptComponent implements OnInit {
  protected readonly notif = inject(NotificationsApiService);
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
  /**
   * Vrai apres SHOW_DELAY_MS — evite que le prompt apparaisse pendant le splash
   * et bloque le premier paint utile (KPI dashboard).
   */
  private readonly delayElapsed = signal(false);

  protected readonly visible = computed(() => {
    if (!this.delayElapsed()) return false;
    if (this.dismissedThisSession()) return false;
    if (this.notif.pushEnabled() !== true) return false;
    if (!this.notif.isPushSupported()) return false;
    if (this.notif.isSubscribed()) return false;
    // Si l'utilisateur a explicitement refuse au niveau navigateur, on ne peut
    // plus rien lui proposer — le bouton "Activer" ouvrirait juste une perm
    // dialog auto-rejetee. Garder le toast cache, il devra passer par les
    // settings du browser.
    if (this.isPermissionDenied()) return false;
    if (this.isCooldownActive(DISMISS_KEY)) return false;
    return true;
  });

  /**
   * Variante pour iOS Safari NON-PWA : `isPushSupported` retourne false (pas
   * de PushManager hors standalone), donc le prompt classique ne s'affiche
   * pas. Ce hint guide l'utilisateur a ajouter Tracky a l'ecran d'accueil
   * (etape obligatoire pour debloquer le push iOS).
   */
  protected readonly visibleIosPwaHint = computed(() => {
    if (!this.delayElapsed()) return false;
    if (this.dismissedThisSession()) return false;
    if (this.notif.pushEnabled() !== true) return false;
    // Seulement sur iOS sans PWA installee. Si la PWA est lancee depuis
    // l'ecran d'accueil et que iOS supporte push, c'est `visible` qui prend.
    if (!this.notif.isIOS()) return false;
    if (this.notif.isStandalone()) return false;
    if (this.isCooldownActive(IOS_HINT_DISMISS_KEY)) return false;
    return true;
  });

  ngOnInit(): void {
    // Affiche le prompt apres un court delai si toutes les conditions sont reunies.
    // Le computed `visible` reevalue automatiquement quand `delayElapsed` passe a true.
    setTimeout(() => this.delayElapsed.set(true), SHOW_DELAY_MS);
  }

  private isPermissionDenied(): boolean {
    try {
      return typeof Notification !== 'undefined' && Notification.permission === 'denied';
    } catch {
      return false;
    }
  }

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
    // Determine quelle cle dismiss enregistrer : si on est sur le hint iOS,
    // on stocke separement pour que le prompt "Activer" classique reapparaisse
    // une fois la PWA installee (sinon dismiss = 7j sans aucun prompt).
    const key = this.visibleIosPwaHint() && !this.visible() ? IOS_HINT_DISMISS_KEY : DISMISS_KEY;
    try {
      localStorage.setItem(key, String(Date.now()));
    } catch {/* localStorage indisponible */}
    this.dismissedThisSession.set(true);
  }

  private isCooldownActive(key: string): boolean {
    try {
      const at = Number(localStorage.getItem(key) ?? '0') || 0;
      if (at <= 0) return false;
      return Date.now() - at < DISMISS_COOLDOWN_MS;
    } catch {
      return false;
    }
  }
}
