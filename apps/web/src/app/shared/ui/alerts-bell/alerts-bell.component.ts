import { swallow } from '../../../core/error/swallow';
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Bell, AlertTriangle, Info, Check } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../../core/services/alerts.service';
import { RealtimeService } from '../../../core/services/realtime.service';
import { relativeTime } from '../../utils/relative-time';
import type { AlertEvent } from '@vizyo/tracky-shared';

/** Rafale d'alertes regroupées (même véhicule + type) pour ne pas spammer la cloche. */
interface BellCluster {
  key: string;
  lead: AlertEvent;
  items: AlertEvent[];
  count: number;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  newestAt: string;
  oldestAt: string;
}

@Component({
  selector: 'app-alerts-bell',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="relative">
      <button
        (click)="open.set(!open())"
        class="relative flex items-center justify-center w-11 h-11 rounded-full
               bg-bg-secondary border border-border-subtle text-fg-secondary
               hover:text-fg-primary transition-colors cursor-pointer"
        [attr.aria-label]="'Notifications, ' + (clusters().length > 0 ? clusters().length + ' alerte(s) non acquittée(s)' : 'aucune nouvelle alerte')"
        [attr.aria-expanded]="open()"
        aria-haspopup="true"
      >
        <lucide-icon [img]="Bell" [size]="18" aria-hidden="true"></lucide-icon>
        @if (clusters().length > 0) {
          <span class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1
                       rounded-full text-[10px] font-bold text-white
                       flex items-center justify-center"
                [class]="hasCriticalCluster() ? 'bg-red-500 animate-pulse' : 'bg-amber-500'"
                aria-hidden="true">
            {{ clusters().length }}
          </span>
        }
      </button>

      @if (open()) {
        <!--
          Mobile (<640px) : ancrage au viewport via position:fixed + right:8px
          pour eviter le clipping/debordement (la popup mesure jusqu'a 380px
          alors que le viewport mobile fait ~360px).
          Desktop (>=640px) : position:absolute ancree sous le bouton.
        -->
        <div class="alerts-popup fixed right-2 top-[calc(env(safe-area-inset-top,0px)+68px)] w-[calc(100vw-16px)]
                    sm:absolute sm:right-0 sm:top-12 sm:w-[380px]
                    z-[2000] max-w-[calc(100vw-16px)] max-h-[500px]
                    bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                    rounded-[--radius-card] shadow-2xl overflow-hidden flex flex-col">
          <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <span class="text-sm font-display font-semibold text-fg-primary">Alertes</span>
            @if (clusters().length > 0) {
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
              @for (c of clusters().slice(0, 10); track c.key) {
                <div class="flex items-start gap-3 px-4 py-3 border-b border-border-subtle
                            hover:bg-bg-tertiary/50 transition-colors">
                  @if (c.severity === 'CRITICAL') {
                    <lucide-icon [img]="AlertTriangle" [size]="16" class="text-red-400 shrink-0 mt-0.5"></lucide-icon>
                  } @else {
                    <lucide-icon [img]="Info" [size]="16" class="text-amber-400 shrink-0 mt-0.5"></lucide-icon>
                  }
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-semibold text-fg-primary">
                      {{ c.lead.title }}
                      @if (c.count > 1) {
                        <span class="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-bg-tertiary text-fg-secondary">×{{ c.count }}</span>
                      }
                    </p>
                    <p class="text-[10px] text-fg-tertiary">
                      {{ alertPlate(c.lead) }} · {{ relativeTime(c.newestAt) }}
                    </p>
                  </div>
                  <button
                    (click)="acknowledgeCluster(c); $event.stopPropagation()"
                    class="text-fg-tertiary hover:text-tracky-light shrink-0 cursor-pointer"
                    [title]="c.count > 1 ? 'Acquitter les ' + c.count + ' alertes' : 'Acquitter'"
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

  /**
   * Regroupe les alertes non acquittées par véhicule + type (fenêtre 30 min) →
   * la cloche compte des SITUATIONS distinctes, pas chaque occurrence (anti-spam).
   */
  protected readonly clusters = computed<BellCluster[]>(() => {
    const WINDOW_MS = 30 * 60 * 1000;
    const rank = (s: string) => (s === 'CRITICAL' ? 3 : s === 'WARNING' ? 2 : 1);
    const out: BellCluster[] = [];
    const open = new Map<string, BellCluster>();
    for (const a of this.realtime.alerts()) {
      const key = `${a.vehicleId ?? 'none'}|${a.type}`;
      const c = open.get(key);
      const ms = new Date(a.createdAt).getTime();
      if (c && new Date(c.oldestAt).getTime() - ms <= WINDOW_MS) {
        c.items.push(a);
        c.count = c.items.length;
        c.oldestAt = a.createdAt;
        if (rank(a.severity) > rank(c.severity)) c.severity = a.severity;
      } else {
        const nc: BellCluster = {
          key: `${key}|${a.id}`, lead: a, items: [a], count: 1,
          severity: a.severity, newestAt: a.createdAt, oldestAt: a.createdAt,
        };
        out.push(nc);
        open.set(key, nc);
      }
    }
    return out;
  });

  /** Y a-t-il au moins une situation critique non acquittée ? */
  protected readonly hasCriticalCluster = computed(() =>
    this.clusters().some((c) => c.severity === 'CRITICAL'),
  );

  /** Acquitte toutes les occurrences d'un cluster en une fois. */
  async acknowledgeCluster(cluster: BellCluster): Promise<void> {
    try {
      await Promise.all(cluster.items.map((a) => firstValueFrom(this.alertsApi.acknowledge(a.id))));
      cluster.items.forEach((a) => this.realtime.dismissAlert(a.id));
    } catch (err) {
      // toast handled by interceptor
      swallow('alerts-bell:acknowledgeCluster', err);
    }
  }

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent) {
    const el = (event.target as HTMLElement).closest('app-alerts-bell');
    if (!el) this.open.set(false);
  }

  async onAcknowledge(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.realtime.dismissAlert(id);
    } catch (err) {
      // toast handled by interceptor
      swallow('alerts-bell:onAcknowledge', err);
    }
  }

  async onAcknowledgeAll(): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledgeAll());
      for (const a of this.realtime.alerts()) {
        this.realtime.dismissAlert(a.id);
      }
    } catch (err) {
      // toast handled by interceptor
      swallow('alerts-bell:onAcknowledgeAll', err);
    }
  }

  protected alertPlate(alert: any): string {
    return alert?.vehicle?.plate ?? alert?.vehiclePlate ?? '';
  }
}
