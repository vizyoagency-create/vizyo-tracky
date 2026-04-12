import { Component, HostListener, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Bell, AlertTriangle, Info, Check } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../../core/services/alerts.service';
import { RealtimeService } from '../../../core/services/realtime.service';
import { relativeTime } from '../../utils/relative-time';

@Component({
  selector: 'app-alerts-bell',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="relative">
      <button
        (click)="open.set(!open())"
        class="relative flex items-center justify-center w-10 h-10 rounded-full
               bg-bg-secondary border border-border-subtle text-fg-secondary
               hover:text-fg-primary transition-colors cursor-pointer"
      >
        <lucide-icon [img]="Bell" [size]="18"></lucide-icon>
        @if (realtime.unacknowledgedCount() > 0) {
          <span class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1
                       rounded-full text-[10px] font-bold text-white
                       flex items-center justify-center"
                [class]="realtime.hasCritical() ? 'bg-red-500 animate-pulse' : 'bg-amber-500'">
            {{ realtime.unacknowledgedCount() }}
          </span>
        }
      </button>

      @if (open()) {
        <div class="absolute right-0 top-12 z-[2000] w-[380px] max-w-[calc(100vw-24px)] max-h-[500px]
                    bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                    rounded-[--radius-card] shadow-2xl overflow-hidden flex flex-col">
          <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <span class="text-sm font-display font-semibold text-fg-primary">Alertes</span>
            @if (realtime.unacknowledgedCount() > 0) {
              <button
                (click)="onAcknowledgeAll()"
                class="text-xs text-tracky-light hover:underline cursor-pointer">
                Tout acquitter
              </button>
            }
          </div>

          <div class="flex-1 overflow-auto">
            @if (realtime.alerts().length === 0) {
              <div class="flex items-center justify-center h-24">
                <p class="text-xs text-fg-tertiary">Aucune alerte</p>
              </div>
            } @else {
              @for (alert of realtime.alerts().slice(0, 10); track alert.id) {
                <div class="flex items-start gap-3 px-4 py-3 border-b border-border-subtle
                            hover:bg-bg-tertiary/50 transition-colors">
                  @if (alert.severity === 'CRITICAL') {
                    <lucide-icon [img]="AlertTriangle" [size]="16" class="text-red-400 shrink-0 mt-0.5"></lucide-icon>
                  } @else {
                    <lucide-icon [img]="Info" [size]="16" class="text-amber-400 shrink-0 mt-0.5"></lucide-icon>
                  }
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-semibold text-fg-primary">{{ alert.title }}</p>
                    <p class="text-[10px] text-fg-tertiary">
                      {{ alert.vehiclePlate ?? '' }} · {{ relativeTime(alert.createdAt) }}
                    </p>
                  </div>
                  <button
                    (click)="onAcknowledge(alert.id); $event.stopPropagation()"
                    class="text-fg-tertiary hover:text-tracky-light shrink-0 cursor-pointer"
                    title="Acquitter"
                  >
                    <lucide-icon [img]="Check" [size]="14"></lucide-icon>
                  </button>
                </div>
              }
            }
          </div>

          <div class="px-4 py-2 border-t border-border-subtle">
            <a routerLink="/alerts" (click)="open.set(false)"
               class="text-xs text-tracky-light hover:underline">
              Voir toutes les alertes
            </a>
          </div>
        </div>
      }
    </div>
  `,
})
export class AlertsBellComponent {
  protected readonly realtime = inject(RealtimeService);
  private readonly alertsApi = inject(AlertsApiService);
  protected readonly open = signal(false);
  protected readonly Bell = Bell;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Info = Info;
  protected readonly Check = Check;
  protected readonly relativeTime = relativeTime;

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent) {
    const el = (event.target as HTMLElement).closest('app-alerts-bell');
    if (!el) this.open.set(false);
  }

  async onAcknowledge(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.realtime.dismissAlert(id);
    } catch { /* toast handled by interceptor */ }
  }

  async onAcknowledgeAll(): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledgeAll());
      for (const a of this.realtime.alerts()) {
        this.realtime.dismissAlert(a.id);
      }
    } catch { /* toast handled by interceptor */ }
  }
}
