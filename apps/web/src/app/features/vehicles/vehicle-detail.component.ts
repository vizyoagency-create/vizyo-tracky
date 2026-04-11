import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule, ArrowLeft, Wifi, WifiOff, Gauge, MapPin, Radio,
  AlertTriangle, AlertCircle, Info, Check, Power, Route, BellOff, Map,
  History, Bell, Zap,
} from 'lucide-angular';
import type { AlertEvent } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../core/services/alerts.service';
import { EngineControlService, type EngineControlCommandDto } from '../../core/services/engine-control.service';
import { PositionsApiService, type PositionDto } from '../../core/services/positions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { TripsApiService } from '../../core/services/trips.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { MiniMapComponent } from '../../shared/ui/mini-map/mini-map.component';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';
import { relativeTime } from '../../shared/utils/relative-time';

@Component({
  selector: 'app-vehicle-detail',
  standalone: true,
  imports: [
    RouterLink, LucideAngularModule, DatePipe, DecimalPipe,
    MiniMapComponent, EngineControlButtonComponent,
  ],
  template: `
    @if (loading()) {
      <div class="flex items-center justify-center h-64">
        <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
      </div>
    } @else if (vehicle(); as v) {
      <div class="flex flex-col gap-6">
        <!-- Header -->
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-4">
            <a routerLink="/dashboard" class="flex items-center justify-center w-10 h-10 rounded-xl
                bg-bg-secondary border border-border-subtle text-fg-tertiary
                hover:text-fg-primary transition-colors cursor-pointer">
              <lucide-icon [img]="ArrowLeft" [size]="20"></lucide-icon>
            </a>
            <div>
              <h1 class="text-3xl font-display font-bold text-fg-primary">{{ v.plate }}</h1>
              <p class="text-sm text-fg-tertiary">
                {{ v.brand }} {{ v.model }}
                @if (v.year) { · {{ v.year }} }
                @if (v.color) { · {{ v.color }} }
              </p>
            </div>
          </div>

          @if (v.tracker && currentPosition(); as pos) {
            <app-engine-control-button
              [trackerId]="v.tracker.id"
              [vehiclePlate]="v.plate"
              [currentSpeedKmh]="pos.speedKmh"
              [validFix]="pos.valid"
              [positionAge]="positionAgeSeconds()"
              [ignition]="pos.ignition"
            />
          }
        </div>

        <!-- Stats -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="flex items-center gap-2 mb-2">
              @if (isOnline()) {
                <lucide-icon [img]="Wifi" [size]="16" class="text-tracky-light"></lucide-icon>
                <span class="text-xs text-fg-tertiary">Statut</span>
              } @else {
                <lucide-icon [img]="WifiOff" [size]="16" class="text-fg-tertiary"></lucide-icon>
                <span class="text-xs text-fg-tertiary">Statut</span>
              }
            </div>
            <p class="text-xl font-semibold" [class]="isOnline() ? 'text-tracky-light' : 'text-fg-tertiary'">
              {{ isOnline() ? 'En ligne' : 'Hors ligne' }}
            </p>
          </div>

          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="flex items-center gap-2 mb-2">
              <lucide-icon [img]="Gauge" [size]="16" class="text-tracky-light"></lucide-icon>
              <span class="text-xs text-fg-tertiary">Vitesse</span>
            </div>
            <p class="text-xl font-semibold text-fg-primary">
              @if (currentPosition(); as pos) { {{ pos.speedKmh | number:'1.0-0' }} km/h } @else { — }
            </p>
          </div>

          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="flex items-center gap-2 mb-2">
              <lucide-icon [img]="MapPin" [size]="16" class="text-tracky-light"></lucide-icon>
              <span class="text-xs text-fg-tertiary">Derniere position</span>
            </div>
            <p class="text-xl font-semibold text-fg-primary">
              @if (currentPosition(); as pos) { {{ relativeTime(pos.timestamp) }} } @else { Jamais }
            </p>
          </div>

          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="flex items-center gap-2 mb-2">
              <lucide-icon [img]="Radio" [size]="16" class="text-tracky-light"></lucide-icon>
              <span class="text-xs text-fg-tertiary">Tracker</span>
            </div>
            <p class="text-lg font-mono font-semibold text-fg-primary">
              @if (v.tracker) { {{ v.tracker.imei.slice(0,4) }}...{{ v.tracker.imei.slice(-4) }} } @else { Non assigne }
            </p>
          </div>
        </div>

        <!-- Tabs -->
        <div class="flex gap-1 border-b border-border-subtle">
          @for (tab of tabs; track tab.key) {
            <button
              (click)="activeTab.set(tab.key)"
              class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px"
              [class]="activeTab() === tab.key
                ? 'text-tracky-light border-tracky-light'
                : 'text-fg-tertiary border-transparent hover:text-fg-secondary'"
            >
              {{ tab.label }}
              @if (tab.key === 'alerts' && alerts().length > 0) {
                <span class="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-400">
                  {{ alerts().length }}
                </span>
              }
            </button>
          }
        </div>

        <!-- Tab content -->
        @if (activeTab() === 'map') {
          @if (currentPosition(); as pos) {
            <app-mini-map
              [center]="{ lat: pos.lat, lng: pos.lng }"
              [trail]="trail()"
              [speedKmh]="pos.speedKmh"
              height="500px"
            />
          } @else {
            <div class="flex flex-col items-center justify-center h-64 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="MapPin" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucune position connue</p>
            </div>
          }
        }

        @if (activeTab() === 'history') {
          @if (recentPositions().length > 0) {
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
              <table class="w-full text-sm">
                <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                  <tr>
                    <th class="p-3 text-left">Horodatage</th>
                    <th class="p-3 text-right">Vitesse</th>
                    <th class="p-3 text-left">Coordonnees</th>
                    <th class="p-3 text-center">Moteur</th>
                    <th class="p-3 text-center">Fix</th>
                  </tr>
                </thead>
                <tbody>
                  @for (pos of recentPositions(); track pos.id) {
                    <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                      <td class="p-3 text-fg-primary">{{ pos.timestamp | date:'dd/MM HH:mm:ss' }}</td>
                      <td class="p-3 text-right font-mono text-fg-primary">{{ pos.speedKmh | number:'1.0-1' }} km/h</td>
                      <td class="p-3 font-mono text-xs text-fg-tertiary">
                        {{ pos.lat | number:'1.4-4' }}, {{ pos.lng | number:'1.4-4' }}
                      </td>
                      <td class="p-3 text-center">
                        <span class="w-2 h-2 rounded-full inline-block" [class]="pos.valid ? 'bg-tracky-light' : 'bg-fg-tertiary'"></span>
                      </td>
                      <td class="p-3 text-center text-fg-tertiary">
                        @if (pos.valid) { ✓ } @else { ✗ }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="HistoryIcon" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucun historique</p>
            </div>
          }
        }

        @if (activeTab() === 'alerts') {
          @if (alerts().length > 0) {
            <div class="flex flex-col gap-2">
              @for (alert of alerts(); track alert.id) {
                <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4
                            flex items-start gap-3">
                  @if (alert.severity === 'CRITICAL') {
                    <div class="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="AlertTriangle" [size]="16" class="text-red-400"></lucide-icon>
                    </div>
                  } @else if (alert.severity === 'WARNING') {
                    <div class="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="AlertCircle" [size]="16" class="text-amber-400"></lucide-icon>
                    </div>
                  } @else {
                    <div class="w-8 h-8 rounded-full bg-sky-500/20 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="InfoIcon" [size]="16" class="text-sky-400"></lucide-icon>
                    </div>
                  }
                  <div class="flex-1">
                    <p class="text-sm font-semibold text-fg-primary">{{ alert.title }}</p>
                    <p class="text-xs text-fg-tertiary mt-0.5">{{ relativeTime(alert.createdAt) }}</p>
                  </div>
                  @if (!isAcknowledged(alert)) {
                    <button (click)="acknowledgeAlert(alert.id)"
                            class="text-xs px-2 py-1 rounded-lg bg-bg-tertiary text-fg-tertiary
                                   border border-border-subtle hover:text-tracky-light cursor-pointer">
                      <lucide-icon [img]="Check" [size]="12"></lucide-icon>
                    </button>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="BellOff" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucune alerte</p>
            </div>
          }
        }

        @if (activeTab() === 'commands') {
          @if (commands().length > 0) {
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
              <table class="w-full text-sm">
                <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                  <tr>
                    <th class="p-3 text-left">Date</th>
                    <th class="p-3 text-left">Action</th>
                    <th class="p-3 text-left">Statut</th>
                    <th class="p-3 text-left">Raison</th>
                    <th class="p-3 text-left">Erreur</th>
                  </tr>
                </thead>
                <tbody>
                  @for (cmd of commands(); track cmd.id) {
                    <tr class="border-b border-border-subtle/50">
                      <td class="p-3 text-fg-primary">{{ cmd.createdAt | date:'dd/MM HH:mm' }}</td>
                      <td class="p-3">
                        <span class="px-2 py-0.5 text-xs rounded-md"
                              [class]="cmd.action === 'CUT' ? 'bg-red-600/20 text-red-400' : 'bg-tracky/20 text-tracky-light'">
                          {{ cmd.action === 'CUT' ? 'Coupure' : 'Rallumage' }}
                        </span>
                      </td>
                      <td class="p-3">
                        <span class="px-2 py-0.5 text-xs rounded-md" [class]="statusClass(cmd.status)">
                          {{ statusLabel(cmd.status) }}
                        </span>
                      </td>
                      <td class="p-3 text-xs text-fg-tertiary">{{ cmd.reason ?? '—' }}</td>
                      <td class="p-3 text-xs text-fg-tertiary">{{ cmd.lastError ?? '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="Power" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucune commande</p>
            </div>
          }
        }
      </div>
    }
  `,
})
export class VehicleDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly positionsApi = inject(PositionsApiService);
  private readonly alertsApi = inject(AlertsApiService);
  private readonly engineControlApi = inject(EngineControlService);
  private readonly realtime = inject(RealtimeService);
  private readonly tripsApi = inject(TripsApiService);
  private readonly toast = inject(ToastService);

  protected readonly vehicle = signal<VehicleDetailDto | null>(null);
  protected readonly recentPositions = signal<PositionDto[]>([]);
  protected readonly alerts = signal<AlertEvent[]>([]);
  protected readonly commands = signal<EngineControlCommandDto[]>([]);
  protected readonly vehicleTrips = signal<any[]>([]);
  protected readonly loading = signal(true);
  protected readonly activeTab = signal<'map' | 'history' | 'alerts' | 'commands' | 'trips'>('map');

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Wifi = Wifi;
  protected readonly WifiOff = WifiOff;
  protected readonly Gauge = Gauge;
  protected readonly MapPin = MapPin;
  protected readonly Radio = Radio;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly AlertCircle = AlertCircle;
  protected readonly InfoIcon = Info;
  protected readonly Check = Check;
  protected readonly Power = Power;
  protected readonly BellOff = BellOff;
  protected readonly HistoryIcon = History;
  protected readonly relativeTime = relativeTime;

  protected readonly tabs = [
    { key: 'map' as const, label: 'Carte' },
    { key: 'history' as const, label: 'Historique' },
    { key: 'alerts' as const, label: 'Alertes' },
    { key: 'commands' as const, label: 'Commandes' },
    { key: 'trips' as const, label: 'Trajets' },
  ];

  private lastAlertCount = -1;
  private alertRefreshEffect = effect(() => {
    const wsAlerts = this.realtime.alerts();
    if (wsAlerts.length !== this.lastAlertCount) {
      this.lastAlertCount = wsAlerts.length;
      const v = this.vehicle();
      if (v) {
        firstValueFrom(this.alertsApi.list({ vehicleId: v.id, limit: '20' }))
          .then((res) => this.alerts.set((res as any).items ?? res))
          .catch(() => {});
      }
    }
  });

  // TODO: add command:status WS event for live command updates

  protected readonly livePosition = computed(() => {
    const tracker = this.vehicle()?.tracker;
    if (!tracker) return null;
    return this.realtime.positions().get(tracker.id) ?? null;
  });

  protected readonly currentPosition = computed(() => {
    const live = this.livePosition();
    if (live) {
      return { lat: live.lat, lng: live.lng, speedKmh: live.speedKmh, timestamp: live.timestamp, ignition: live.ignition, valid: live.valid };
    }
    const last = this.recentPositions()[0];
    if (last) {
      return { lat: last.lat, lng: last.lng, speedKmh: last.speedKmh, timestamp: last.timestamp, ignition: true, valid: last.valid };
    }
    return null;
  });

  protected readonly positionAgeSeconds = computed(() => {
    const pos = this.currentPosition();
    if (!pos) return undefined;
    return Math.floor((Date.now() - new Date(pos.timestamp).getTime()) / 1000);
  });

  protected readonly trail = computed(() =>
    this.recentPositions().slice(0, 20).reverse().map((p) => ({ lat: p.lat, lng: p.lng })),
  );

  protected readonly isOnline = computed(() => {
    const age = this.positionAgeSeconds();
    return age !== undefined && age < 180;
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.params['id'];
    if (!id) { this.router.navigate(['/dashboard']); return; }
    await this.loadAll(id);
  }

  private async loadAll(vehicleId: string): Promise<void> {
    this.loading.set(true);
    try {
      const v = await firstValueFrom(this.vehiclesApi.findOne(vehicleId));
      this.vehicle.set(v);

      const trackerId = v.tracker?.id;
      const [posRes, alertsRes, cmdsRes, tripsRes] = await Promise.all([
        trackerId ? firstValueFrom(this.positionsApi.list({ trackerId, limit: '100' })) : { items: [] },
        firstValueFrom(this.alertsApi.list({ vehicleId: v.id, limit: '20' })),
        trackerId ? firstValueFrom(this.engineControlApi.listCommands(trackerId, 20)) : [],
        firstValueFrom(this.tripsApi.list({ vehicleId: v.id, limit: '20' })),
      ]);

      this.recentPositions.set(posRes.items);
      this.alerts.set((alertsRes as any).items ?? alertsRes);
      this.commands.set(Array.isArray(cmdsRes) ? cmdsRes : []);
      this.vehicleTrips.set((tripsRes as any).items ?? []);
    } catch (err) {
      this.toast.error('Erreur de chargement', err instanceof HttpErrorResponse ? err.error?.message : String(err));
      this.router.navigate(['/dashboard']);
    } finally {
      this.loading.set(false);
    }
  }

  protected async acknowledgeAlert(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.alerts.update((list) => list.filter((a) => a.id !== id));
      this.toast.success('Alerte acquittee');
    } catch { /* handled */ }
  }

  protected isAcknowledged(alert: any): boolean {
    return !!alert.acknowledgedAt;
  }

  protected statusLabel(status: string): string {
    const labels: Record<string, string> = {
      PENDING: 'En attente', SENT: 'Envoyee', ACKNOWLEDGED: 'Confirmee',
      FAILED: 'Echouee', REJECTED_SPEED: 'Refusee',
    };
    return labels[status] ?? status;
  }

  protected statusClass(status: string): string {
    if (status === 'SENT' || status === 'ACKNOWLEDGED') return 'bg-tracky/10 text-tracky-light';
    if (status === 'REJECTED_SPEED') return 'bg-red-600/10 text-red-400';
    if (status === 'FAILED') return 'bg-amber-500/10 text-amber-400';
    return 'bg-bg-tertiary text-fg-tertiary';
  }
}
