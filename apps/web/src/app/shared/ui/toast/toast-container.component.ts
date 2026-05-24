import { Component, inject } from '@angular/core';
import { LucideAngularModule, CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-angular';
import { ToastService, type Toast, type ToastKind } from './toast.service';

const ICON_MAP: Record<ToastKind, any> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLOR_MAP: Record<ToastKind, string> = {
  success: 'text-tracky-light',
  error: 'text-red-400',
  warning: 'text-amber-400',
  info: 'text-sky-400',
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

    /* Style CRITICAL : bordure rouge + halo subtil pour attirer le regard. */
    .toast-critical {
      border-color: rgba(220, 38, 38, 0.55) !important;
      box-shadow:
        0 12px 40px rgba(220, 38, 38, 0.15),
        0 0 0 1px rgba(220, 38, 38, 0.25),
        0 0 24px rgba(220, 38, 38, 0.18);
      animation:
        slideIn 0.3s ease-out,
        toast-critical-pulse 1.6s ease-in-out infinite;
    }
    @keyframes toast-critical-pulse {
      0%, 100% { box-shadow:
        0 12px 40px rgba(220, 38, 38, 0.15),
        0 0 0 1px rgba(220, 38, 38, 0.25),
        0 0 24px rgba(220, 38, 38, 0.18); }
      50% { box-shadow:
        0 12px 40px rgba(220, 38, 38, 0.22),
        0 0 0 1px rgba(220, 38, 38, 0.45),
        0 0 32px rgba(220, 38, 38, 0.32); }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast-critical { animation: slideIn 0.3s ease-out; }
    }

    /* Position : bas-droite, plus de bottom-bar à éviter. Mobile : safe-area + 16px. */
    .toast-stack { bottom: 1rem; }
    @media (max-width: 768px) {
      /* Mobile : la bottom-bar mesure ~60px (6 + 48 + 6) + safe-area, on
         decale le toast au-dessus pour ne pas qu'une notification se retrouve
         partiellement masquee par la barre de navigation. */
      .toast-stack {
        bottom: calc(env(safe-area-inset-bottom) + 76px);
        right: 12px;
        left: 12px;
        max-width: none;
      }
      /* En mode fullscreen (/map), la bottom-bar est cachee — on remet le
         toast pres du bord pour ne pas laisser un trou inutile.
         Le toast-container est rendu au niveau global (app.ts) donc on cible
         via body:has(...) plutot que :host-context(...) qui ne matche que
         dans la chaine d'ancetres du host. */
      body:has(.layout--fullscreen) .toast-stack {
        bottom: calc(env(safe-area-inset-bottom) + 16px);
      }
      /* Sur mobile, les toasts prennent toute la largeur disponible */
      .toast-stack > div {
        min-width: 0 !important;
        max-width: none !important;
        width: 100%;
      }
    }
    /* Quand un modal/drawer est ouvert (body scroll lock ou overlay actif),
       on déplace le toast vers le haut pour ne pas masquer les actions. */
    body:has(.mobile-overlay) .toast-stack,
    body:has(.tracky-mobile-sheet--open) .toast-stack,
    body:has(.dash-customizer-overlay) .toast-stack {
      bottom: auto !important;
      top: calc(env(safe-area-inset-top) + 12px) !important;
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
