import { Component, effect, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, AlertTriangle, AlertCircle, Info, Check, CheckCheck } from 'lucide-angular';
import type { AlertEvent } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../core/services/alerts.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { relativeTime } from '../../shared/utils/relative-time';

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Alertes</h1>
        <button
          (click)="onAcknowledgeAll()"
          class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl
                 bg-tracky/20 text-tracky-light border border-tracky/30
                 hover:bg-tracky/30 transition-colors cursor-pointer"
        >
          <lucide-icon [img]="CheckCheck" [size]="16"></lucide-icon>
          Tout acquitter
        </button>
      </div>

      <div class="flex items-center gap-3 flex-wrap">
        @for (sev of severities; track sev.value) {
          <button
            (click)="filterSeverity.set(filterSeverity() === sev.value ? null : sev.value)"
            class="px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer"
            [class]="filterSeverity() === sev.value
              ? 'bg-tracky/20 text-tracky-light border-tracky/30'
              : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'"
          >
            {{ sev.label }}
          </button>
        }
        <button
          (click)="showAcknowledged.set(!showAcknowledged())"
          class="px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer"
          [class]="showAcknowledged()
            ? 'bg-tracky/20 text-tracky-light border-tracky/30'
            : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'"
        >
          Afficher acquittees
        </button>
      </div>

      @if (alerts().length === 0 && !loading()) {
        <div class="flex items-center justify-center h-40 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle">
          <p class="text-fg-tertiary">Aucune alerte</p>
        </div>
      }

      <div class="grid gap-3">
        @for (alert of alerts(); track alert.id) {
          <div class="flex items-start gap-4 p-4 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle
                      transition-all duration-200 hover:border-border-strong">
            <div class="shrink-0 mt-0.5">
              @if (alert.severity === 'CRITICAL') {
                <div class="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                  <lucide-icon [img]="AlertTriangle" [size]="16" class="text-red-400"></lucide-icon>
                </div>
              } @else if (alert.severity === 'WARNING') {
                <div class="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
                  <lucide-icon [img]="AlertCircle" [size]="16" class="text-amber-400"></lucide-icon>
                </div>
              } @else {
                <div class="w-8 h-8 rounded-full bg-sky-500/20 flex items-center justify-center">
                  <lucide-icon [img]="Info" [size]="16" class="text-sky-400"></lucide-icon>
                </div>
              }
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold text-fg-primary">{{ alert.title }}</span>
                <span class="px-1.5 py-0.5 text-[10px] rounded font-medium"
                      [class]="severityBadge(alert.severity)">
                  {{ alert.severity }}
                </span>
              </div>
              <p class="text-xs text-fg-tertiary mt-0.5">
                @if (alert.vehicleId) {
                  <a [routerLink]="['/vehicles', alert.vehicleId]" class="text-tracky-light hover:underline">
                    {{ alert.vehiclePlate ?? 'Vehicule' }}
                  </a> ·
                } @else {
                  {{ alert.vehiclePlate ?? 'Vehicule inconnu' }} ·
                }
                {{ relativeTime(alert.createdAt) }}
              </p>
              @if (alert.message) {
                <p class="text-xs text-fg-secondary mt-1">{{ alert.message }}</p>
              }
            </div>
            <div class="shrink-0">
              @if (!isAcknowledged(alert)) {
                <button
                  (click)="onAcknowledge(alert.id)"
                  class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg
                         bg-bg-tertiary text-fg-tertiary border border-border-subtle
                         hover:text-tracky-light hover:border-tracky/30 transition-colors cursor-pointer"
                >
                  <lucide-icon [img]="Check" [size]="12"></lucide-icon>
                  Acquitter
                </button>
              } @else {
                <span class="text-[10px] text-fg-tertiary">Acquittee</span>
              }
            </div>
          </div>
        }
      </div>

      @if (nextCursor()) {
        <button
          (click)="loadMore()"
          [disabled]="loading()"
          class="self-center px-6 py-2 text-sm rounded-xl
                 bg-bg-tertiary text-fg-secondary border border-border-subtle
                 hover:text-fg-primary transition-colors cursor-pointer"
        >
          Charger plus
        </button>
      }
    </div>
  `,
})
export class AlertsComponent implements OnInit {
  private readonly alertsApi = inject(AlertsApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  protected readonly alerts = signal<AlertEvent[]>([]);
  protected readonly loading = signal(false);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly filterSeverity = signal<string | null>(null);
  protected readonly showAcknowledged = signal(false);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly AlertCircle = AlertCircle;
  protected readonly Info = Info;
  protected readonly Check = Check;
  protected readonly CheckCheck = CheckCheck;
  protected readonly relativeTime = relativeTime;

  protected readonly severities = [
    { value: 'CRITICAL', label: 'Critiques' },
    { value: 'WARNING', label: 'Avertissements' },
    { value: 'INFO', label: 'Informations' },
  ];

  private lastWsCount = -1;

  private syncEffect = effect(() => {
    const count = this.realtime.alerts().length;
    if (count !== this.lastWsCount) {
      this.lastWsCount = count;
      this.loadAlerts();
    }
  });

  ngOnInit(): void {
  }

  protected isAcknowledged(alert: any): boolean {
    return !!alert.acknowledgedAt;
  }

  protected severityBadge(severity: string): string {
    if (severity === 'CRITICAL') return 'bg-red-500/20 text-red-400';
    if (severity === 'WARNING') return 'bg-amber-500/20 text-amber-400';
    return 'bg-sky-500/20 text-sky-400';
  }

  protected async onAcknowledge(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.alerts.update((list) =>
        list.map((a) => (a.id === id ? { ...a, acknowledgedAt: new Date().toISOString() } as any : a)),
      );
      this.realtime.dismissAlert(id);
      this.toast.success('Alerte acquittee');
    } catch { /* handled */ }
  }

  protected async onAcknowledgeAll(): Promise<void> {
    try {
      const ids = this.alerts().filter((a) => !this.isAcknowledged(a)).map((a) => a.id);
      const { count } = await firstValueFrom(this.alertsApi.acknowledgeAll());
      ids.forEach((id) => this.realtime.dismissAlert(id));
      this.toast.success(`${count} alertes acquittees`);
      this.loadAlerts();
    } catch { /* handled */ }
  }

  protected loadMore(): void {
    this.loadAlerts(this.nextCursor() ?? undefined);
  }

  private async loadAlerts(cursor?: string): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string> = { limit: '20' };
      if (this.filterSeverity()) params['severity'] = this.filterSeverity()!;
      if (this.showAcknowledged()) params['acknowledged'] = 'true';
      else params['acknowledged'] = 'false';
      if (cursor) params['cursor'] = cursor;

      const res = await firstValueFrom(this.alertsApi.list(params));
      if (cursor) {
        this.alerts.update((list) => [...list, ...res.items]);
      } else {
        this.alerts.set(res.items);
      }
      this.nextCursor.set(res.nextCursor);
    } catch { /* handled */ } finally {
      this.loading.set(false);
    }
  }
}
