import { Component, inject } from '@angular/core';
import { LucideAngularModule, CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-angular';
import { ToastService, type Toast, type ToastKind } from './toast.service';

const ICON_MAP: Record<ToastKind, any> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

/**
 * Les quatre types du toast, sur la famille de PETIT TEXTE — le pictogramme fait 20 px
 * mais il se lit comme du texte coloré, et `text-red-400` / `text-amber-400` /
 * `text-sky-400` sont des couleurs de la palette Tailwind, hors du système : elles ne
 * suivent pas le thème clair et doublent des jetons qui existent.
 */
const COLOR_MAP: Record<ToastKind, string> = {
  success: 'toast-ic--succes',
  error: 'toast-ic--alerte',
  warning: 'toast-ic--attente',
  info: 'toast-ic--info',
};

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="toast-stack fixed right-4 z-[6000] flex flex-col gap-2 pointer-events-none"
         role="region"
         aria-label="Notifications"
         aria-live="polite"
         aria-atomic="false">
      @if (toastService.toasts().length >= 2) {
        <button
          (click)="toastService.dismissAll()"
          class="pointer-events-auto self-end text-xs font-medium text-fg-tertiary hover:text-fg-primary
                 bg-bg-secondary/95 backdrop-blur-md border border-border-subtle rounded-lg px-2.5 py-1
                 flex items-center gap-1 cursor-pointer shadow-lg"
          aria-label="Fermer toutes les notifications">
          <lucide-icon [img]="X" [size]="12" aria-hidden="true"></lucide-icon>
          Tout fermer
        </button>
      }
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="pointer-events-auto animate-slide-in
                    bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                    rounded-xl p-4 min-w-[260px] max-w-[400px]
                    flex items-start gap-3 shadow-lg"
             [class.toast-critical]="toast.severity === 'critical'"
             [attr.role]="toast.kind === 'error' ? 'alert' : 'status'"
             [attr.aria-live]="toast.kind === 'error' ? 'assertive' : 'polite'">
          <lucide-icon
            [img]="iconFor(toast.kind)"
            [size]="20"
            [class]="colorFor(toast.kind) + ' shrink-0 mt-0.5'"
            aria-hidden="true"
          ></lucide-icon>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-fg-primary">{{ toast.title }}</p>
            @if (toast.message) {
              <p class="text-xs text-fg-tertiary mt-0.5">{{ toast.message }}</p>
            }
            @if (toast.action || toast.extraAction) {
              <div class="mt-2 flex items-center gap-3">
                @if (toast.action) {
                  <button
                    (click)="runAction(toast, 'primary')"
                    class="text-xs font-semibold text-tracky-light hover:underline cursor-pointer">
                    {{ toast.action.label }}
                  </button>
                }
                @if (toast.extraAction) {
                  <button
                    (click)="runAction(toast, 'extra')"
                    class="text-xs font-semibold text-fg-secondary hover:text-fg-primary hover:underline cursor-pointer">
                    {{ toast.extraAction.label }}
                  </button>
                }
              </div>
            }
          </div>
          <button
            (click)="toastService.dismiss(toast.id)"
            class="text-fg-tertiary hover:text-fg-primary shrink-0 cursor-pointer"
            aria-label="Fermer la notification"
          >
            <lucide-icon [img]="X" [size]="14" aria-hidden="true"></lucide-icon>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    .animate-slide-in { animation: slideIn 0.3s ease-out; }

    .toast-ic--succes { color: var(--texte-succes) }
    .toast-ic--alerte { color: var(--texte-alerte) }
    .toast-ic--attente { color: var(--texte-attente) }
    .toast-ic--info { color: var(--texte-info) }

    /* Style CRITICAL : bordure rouge + halo subtil pour attirer le regard. */
    .toast-critical {
      border-color: color-mix(in srgb, var(--texte-alerte) 55%, transparent) !important;
      box-shadow:
        0 12px 40px color-mix(in srgb, var(--texte-alerte) 15%, transparent),
        0 0 0 1px color-mix(in srgb, var(--texte-alerte) 25%, transparent),
        0 0 24px color-mix(in srgb, var(--texte-alerte) 18%, transparent);
      animation:
        slideIn 0.3s ease-out,
        toast-critical-pulse 1.6s ease-in-out infinite;
    }
    @keyframes toast-critical-pulse {
      0%, 100% { box-shadow:
        0 12px 40px color-mix(in srgb, var(--texte-alerte) 15%, transparent),
        0 0 0 1px color-mix(in srgb, var(--texte-alerte) 25%, transparent),
        0 0 24px color-mix(in srgb, var(--texte-alerte) 18%, transparent); }
      50% { box-shadow:
        0 12px 40px color-mix(in srgb, var(--texte-alerte) 22%, transparent),
        0 0 0 1px color-mix(in srgb, var(--texte-alerte) 45%, transparent),
        0 0 32px color-mix(in srgb, var(--texte-alerte) 32%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast-critical { animation: slideIn 0.3s ease-out; }
    }

    /* Sur PC : bas-droite. Il n'y a pas de barre d'onglets à éviter, et le coin bas
       droit est hors du chemin de lecture. */
    .toast-stack { bottom: 1rem; }

    /* ─── SUR MOBILE, LE TOAST EST EN HAUT ─────────────────────────────────────
     *
     * Règle du kit (Kit Partage) : « le toast est en haut : le bas est occupé par la
     * barre d'onglets, un toast qui s'y superpose masque la navigation ». Et son
     * corollaire : « le toast est en haut et la feuille en bas, les deux surfaces ne
     * se disputent jamais la même zone ».
     *
     * Le code d'avant restait EN BAS et remontait de 76 px pour passer au-dessus de
     * la barre — puis redescendait en plein écran, puis remontait tout en haut dès
     * qu'une modale s'ouvrait. Trois positions pour une même surface, chacune
     * rattrapant la précédente, et une collision garantie avec la feuille du bas.
     * Le haut n'a aucun de ces conflits : rien d'autre n'y vit sur mobile. */
    @media (max-width: 768px) {
      .toast-stack {
        top: calc(env(safe-area-inset-top) + 12px);
        bottom: auto;
        right: 12px;
        left: 12px;
        max-width: none;
      }
      /* Sur mobile, les toasts prennent toute la largeur disponible */
      .toast-stack > div {
        min-width: 0 !important;
        max-width: none !important;
        width: 100%;
      }
      /* Le toast arrive du haut, pas de la droite : une entrée latérale sur un
         bandeau pleine largeur donne l'impression qu'il vient de nulle part. */
      .animate-slide-in { animation-name: slideDown; }
    }
    @keyframes slideDown {
      from { transform: translateY(-120%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `],
})
export class ToastContainerComponent {
  protected readonly toastService = inject(ToastService);
  protected readonly X = X;

  iconFor(kind: ToastKind) {
    return ICON_MAP[kind];
  }

  colorFor(kind: ToastKind): string {
    return COLOR_MAP[kind];
  }

  runAction(toast: Toast, slot: 'primary' | 'extra' = 'primary'): void {
    const action = slot === 'extra' ? toast.extraAction : toast.action;
    action?.callback();
    this.toastService.dismiss(toast.id);
  }
}
