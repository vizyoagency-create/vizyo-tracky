import { Component, inject } from '@angular/core';
import { LucideAngularModule, CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-angular';
import { ToastService, type ToastKind } from './toast.service';

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
    <div class="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="pointer-events-auto animate-slide-in
                    bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                    rounded-xl p-4 min-w-[300px] max-w-[400px]
                    flex items-start gap-3 shadow-lg">
          <lucide-icon
            [img]="iconFor(toast.kind)"
            [size]="20"
            [class]="colorFor(toast.kind) + ' shrink-0 mt-0.5'"
          ></lucide-icon>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-fg-primary">{{ toast.title }}</p>
            @if (toast.message) {
              <p class="text-xs text-fg-tertiary mt-0.5">{{ toast.message }}</p>
            }
          </div>
          <button
            (click)="toastService.dismiss(toast.id)"
            class="text-fg-tertiary hover:text-fg-primary shrink-0 cursor-pointer"
          >
            <lucide-icon [img]="X" [size]="14"></lucide-icon>
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
}
