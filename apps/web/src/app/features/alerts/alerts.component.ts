import { ChangeDetectionStrategy, Component, effect, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, AlertTriangle, AlertCircle, Info, Check, CheckCheck } from 'lucide-angular';
import type { AlertEvent } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../core/services/alerts.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { relativeTime } from '../../shared/utils/relative-time';

@Component({
  selector: 'app-alerts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="a-page">
      <div class="a-blobs"></div>
      <div class="a-blob-c"></div>

      <!-- Header -->
      <div class="a-header">
        <div>
          <h1 class="a-title">Alertes</h1>
          <p class="a-sub">{{ alerts().length }} alerte(s) en cours</p>
        </div>
        @if (perms.can('alerts_acknowledge')) {
          <button (click)="onAcknowledgeAll()" class="a-ack-all">
            <lucide-icon [img]="CheckCheck" [size]="14"></lucide-icon> Tout acquitter
          </button>
        }
      </div>

      <!-- Filters -->
      <div class="a-filters">
        @for (sev of severities; track sev.value) {
          <button (click)="filterSeverity.set(filterSeverity() === sev.value ? null : sev.value)"
            class="a-filter" [class.active]="filterSeverity() === sev.value" [class]="sev.css">
            <span class="a-filter-dot" [class]="sev.dot"></span>
            {{ sev.label }}
          </button>
        }
        <button (click)="showAcknowledged.set(!showAcknowledged())"
          class="a-filter" [class.active]="showAcknowledged()">
          <lucide-icon [img]="Check" [size]="11"></lucide-icon> Acquittées
        </button>
      </div>

      @if (alerts().length === 0 && !loading()) {
        <div class="a-empty">
          <div class="a-empty-icon"><lucide-icon [img]="AlertTriangle" [size]="28"></lucide-icon></div>
          <p>Aucune alerte</p>
        </div>
      }

      <!-- Timeline -->
      <div class="timeline">
        @for (alert of alerts(); track alert.id; let i = $index) {
          <div class="tl-item" [class.acked]="isAcknowledged(alert)">
            <!-- Timeline line -->
            <div class="tl-line-wrap">
              <div class="tl-node" [class]="alert.severity === 'CRITICAL' ? 'critical' : alert.severity === 'WARNING' ? 'warning' : 'info'">
                @if (alert.severity === 'CRITICAL' && !isAcknowledged(alert)) {
                  <span class="tl-pulse" [class]="'critical'"></span>
                }
              </div>
              @if (i < alerts().length - 1) {
                <div class="tl-line"></div>
              }
            </div>

            <!-- Content card -->
            <div class="tl-card" [class]="alert.severity === 'CRITICAL' ? 'sev-critical' : alert.severity === 'WARNING' ? 'sev-warning' : 'sev-info'">
              <div class="tl-card-top">
                <div class="tl-card-info">
                  <span class="tl-alert-title">{{ alert.title }}</span>
                  <span class="tl-severity" [class]="severityBadge(alert.severity)">{{ alert.severity }}</span>
                </div>
                <span class="tl-time">{{ relativeTime(alert.createdAt) }}</span>
              </div>
              <div class="tl-card-mid">
                @if (alert.vehicleId) {
                  <a [routerLink]="['/vehicles', alert.vehicleId]" class="tl-vehicle">
                    {{ alertVehiclePlate(alert) }}
                  </a>
                }
                @if (alert.message) {
                  <span class="tl-msg">{{ alert.message }}</span>
                }
              </div>
              @if (!isAcknowledged(alert) && perms.can('alerts_acknowledge')) {
                <div class="tl-card-bottom">
                  <button (click)="onAcknowledge(alert.id)" class="tl-ack-btn">
                    <lucide-icon [img]="Check" [size]="12"></lucide-icon> Acquitter
                  </button>
                </div>
              } @else if (isAcknowledged(alert)) {
                <div class="tl-card-bottom">
                  <span class="tl-acked"><lucide-icon [img]="Check" [size]="10"></lucide-icon> Acquittée</span>
                </div>
              }
            </div>
          </div>
        }
      </div>

      @if (nextCursor()) {
        <button (click)="loadMore()" [disabled]="loading()" class="a-load-more">
          Charger plus
        </button>
      }
    </div>
  `,
  styles: [`
    .a-page { position: relative; min-height: 100% }
    .a-blobs { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden }
    .a-blobs::before {
      content: ''; position: absolute; top: -5%; right: -5%; width: 40%; height: 45%;
      background: radial-gradient(ellipse, rgba(239,68,68,.05) 0%, transparent 70%);
      border-radius: 50% 40% 60% 30%; animation: ab1 11s ease-in-out infinite alternate;
    }
    .a-blobs::after {
      content: ''; position: absolute; bottom: -10%; left: -8%; width: 45%; height: 50%;
      background: radial-gradient(ellipse, rgba(245,158,11,.05) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%; animation: ab2 13s ease-in-out infinite alternate;
    }
    .a-blob-c {
      position: fixed; top: 50%; left: 40%; transform: translate(-50%,-50%); width: 30%; height: 35%;
      background: radial-gradient(ellipse, rgba(59,130,246,.04) 0%, transparent 70%);
      border-radius: 60% 40% 50% 30%; pointer-events: none; z-index: 0;
      animation: ab3 15s ease-in-out infinite alternate;
    }
    @keyframes ab1 { 0%{border-radius:50% 40% 60% 30%;transform:translate(0,0)} 100%{border-radius:30% 60% 40% 50%;transform:translate(-3%,5%)} }
    @keyframes ab2 { 0%{border-radius:40% 60% 30% 50%;transform:translate(0,0)} 100%{border-radius:60% 30% 50% 40%;transform:translate(3%,-3%)} }
    @keyframes ab3 { 0%{border-radius:60% 40% 50% 30%;transform:translate(-50%,-50%) scale(1)} 100%{border-radius:40% 50% 30% 60%;transform:translate(-50%,-50%) scale(1.1)} }

    .a-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px }
    .a-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .a-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .a-ack-all {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px;
      font-size: 12px; font-weight: 700; background: rgba(16,224,160,.1); color: var(--tracky-light);
      border: 1px solid rgba(16,224,160,.2); cursor: pointer; transition: all .2s; white-space: nowrap;
    }
    .a-ack-all:hover { background: rgba(16,224,160,.18) }
    @media (max-width: 480px) {
      .a-title { font-size: 20px }
      .a-ack-all { padding: 6px 12px; font-size: 11px }
      .tl-item { gap: 10px }
      .tl-card { padding: 12px 14px }
    }

    .a-filters { position: relative; z-index: 1; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px }
    .a-filter {
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 20px;
      font-size: 11px; font-weight: 600; background: rgba(var(--bg-secondary-rgb,15,23,20),.5);
      backdrop-filter: blur(8px); border: 1px solid var(--border-subtle); color: var(--fg-tertiary);
      cursor: pointer; transition: all .2s;
    }
    .a-filter:hover { color: var(--fg-secondary) }
    .a-filter.active { border-color: rgba(16,224,160,.3); color: var(--tracky-light); background: rgba(16,224,160,.08) }
    .a-filter-dot { width: 6px; height: 6px; border-radius: 50% }
    .a-filter-dot.red { background: #ef4444 }
    .a-filter-dot.amber { background: #f59e0b }
    .a-filter-dot.blue { background: #3b82f6 }

    .a-empty {
      position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 50px 20px; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.08); color: var(--fg-tertiary); font-size: 14px;
    }
    .a-empty-icon { width: 56px; height: 56px; border-radius: 14px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }

    /* Timeline */
    .timeline { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 0; padding-left: 6px }

    .tl-item { display: flex; gap: 16px; position: relative }
    .tl-item.acked { opacity: .5 }

    .tl-line-wrap { display: flex; flex-direction: column; align-items: center; width: 16px; flex-shrink: 0; padding-top: 4px }
    .tl-node { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; position: relative; z-index: 1 }
    .tl-node.critical { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,.5) }
    .tl-node.warning { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,.4) }
    .tl-node.info { background: #3b82f6; box-shadow: 0 0 6px rgba(59,130,246,.4) }
    .tl-pulse {
      position: absolute; inset: -4px; border-radius: 50%; animation: tlpulse 2s ease infinite;
    }
    .tl-pulse.critical { background: rgba(239,68,68,.3) }
    @keyframes tlpulse { 0%,100%{transform:scale(1);opacity:.6} 50%{transform:scale(1.8);opacity:0} }

    .tl-line { width: 2px; flex: 1; min-height: 16px; background: var(--border-subtle); margin: 4px 0 }

    /* Card */
    .tl-card {
      flex: 1; padding: 14px 16px; border-radius: 12px; margin-bottom: 12px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.04); transition: all .25s;
    }
    .tl-card:hover { transform: translateX(4px) }
    .tl-card.sev-critical { border-left: 3px solid #ef4444 }
    .tl-card.sev-warning { border-left: 3px solid #f59e0b }
    .tl-card.sev-info { border-left: 3px solid #3b82f6 }

    :host-context([data-theme="light"]) .tl-card { background: rgba(255,255,255,.55); border-color: rgba(0,0,0,.06) }

    .tl-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px }
    .tl-card-info { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0 }
    .tl-alert-title { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .tl-severity { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: .04em }
    .tl-time { font-size: 10px; color: var(--fg-tertiary); white-space: nowrap; flex-shrink: 0 }

    .tl-card-mid { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap }
    .tl-vehicle { font-size: 11px; font-weight: 600; color: var(--tracky-light); text-decoration: none }
    .tl-vehicle:hover { text-decoration: underline }
    .tl-msg { font-size: 11px; color: var(--fg-tertiary) }

    .tl-card-bottom { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-subtle) }
    .tl-ack-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 8px;
      font-size: 11px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); cursor: pointer; transition: all .2s;
    }
    .tl-ack-btn:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.2) }
    .tl-acked { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--fg-tertiary) }

    .a-load-more {
      position: relative; z-index: 1; display: block; margin: 16px auto 0; padding: 10px 24px;
      border-radius: 10px; font-size: 12px; font-weight: 600;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(8px);
      border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; transition: all .2s;
    }
    .a-load-more:hover { color: var(--fg-primary); border-color: var(--border-strong) }
  `],
})
export class AlertsComponent implements OnInit {
  private readonly alertsApi = inject(AlertsApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);
  protected readonly perms = inject(PermissionsService);

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
    { value: 'CRITICAL', label: 'Critiques', css: '', dot: 'red' },
    { value: 'WARNING', label: 'Avertissements', css: '', dot: 'amber' },
    { value: 'INFO', label: 'Informations', css: '', dot: 'blue' },
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

  /**
   * REST `/api/alerts` returns the plate via the nested `vehicle.plate`,
   * while the WebSocket payload exposes a flat `vehiclePlate`. Read both so
   * the UI does not fall back to the literal "Véhicule" + a redundant
   * "Véhicule TE001ST" message side-by-side.
   */
  protected alertVehiclePlate(alert: any): string {
    return alert?.vehicle?.plate ?? alert?.vehiclePlate ?? 'Véhicule';
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
      this.toast.success('Alerte acquittée');
    } catch { /* handled */ }
  }

  protected async onAcknowledgeAll(): Promise<void> {
    try {
      const ids = this.alerts().filter((a) => !this.isAcknowledged(a)).map((a) => a.id);
      const { count } = await firstValueFrom(this.alertsApi.acknowledgeAll());
      ids.forEach((id) => this.realtime.dismissAlert(id));
      this.toast.success(`${count} alertes acquittées`);
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
