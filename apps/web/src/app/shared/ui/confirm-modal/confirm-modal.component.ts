import { Component, HostListener, input, output } from '@angular/core';
import { LucideAngularModule, AlertTriangle, Info } from 'lucide-angular';

@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onCancel()"></div>
        <div class="relative bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                    p-6 max-w-md w-full mx-4 shadow-2xl">
          <div class="flex items-start gap-3 mb-4">
            @if (danger()) {
              <lucide-icon [img]="AlertTriangle" [size]="24" class="text-red-400 shrink-0 mt-0.5"></lucide-icon>
            } @else {
              <lucide-icon [img]="Info" [size]="24" class="text-tracky-light shrink-0 mt-0.5"></lucide-icon>
            }
            <div>
              <h3 class="text-lg font-display font-semibold text-fg-primary">{{ title() }}</h3>
              @if (description()) {
                <p class="text-sm text-fg-secondary mt-1" [innerHTML]="description()"></p>
              }
            </div>
          </div>

          <ng-content />

          <div class="flex items-center justify-end gap-3 mt-6">
            <button
              (click)="onCancel()"
              [disabled]="loading()"
              class="px-4 py-2 text-sm font-medium rounded-xl
                     bg-bg-tertiary text-fg-secondary border border-border-subtle
                     hover:text-fg-primary transition-colors cursor-pointer
                     disabled:opacity-50"
            >
              {{ cancelLabel() }}
            </button>
            <button
              (click)="onConfirm()"
              [disabled]="loading()"
              class="px-4 py-2 text-sm font-medium rounded-xl text-white
                     transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2"
              [class]="danger() ? 'bg-red-600 hover:bg-red-700' : 'bg-tracky hover:bg-tracky-dark'"
            >
              @if (loading()) {
                <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
              }
              {{ confirmLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmModalComponent {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly confirmLabel = input('Confirmer');
  readonly cancelLabel = input('Annuler');
  readonly danger = input(false);
  readonly loading = input(false);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Info = Info;

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open() && !this.loading()) this.onCancel();
  }

  onConfirm() {
    this.confirmed.emit();
  }

  onCancel() {
    if (!this.loading()) this.cancelled.emit();
  }
}
