import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, BarChart3, Route, Clock, Gauge, Play, ChevronDown, Truck, Check } from 'lucide-angular';
import type { TripDailySummaryDto, TripDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { TripsApiService } from '../../core/services/trips.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AuthService } from '../../core/services/auth.service';
import { TripReplayComponent } from './trip-replay.component';

@Component({
  selector: 'app-reports',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, DatePipe, DecimalPipe, TripReplayComponent],
  template: `
    <div class="flex flex-col gap-6">
      <h1 class="text-2xl font-display font-bold text-fg-primary">Rapports</h1>

      <div class="flex items-center gap-2 flex-wrap">
        <!-- Dropdown véhicule custom -->
        <div class="rep-dropdown-wrapper">
          <button type="button"
                  (click)="vehicleDropdownOpen.set(!vehicleDropdownOpen())"
                  class="rep-dropdown-trigger"
                  [class.rep-dropdown-trigger--open]="vehicleDropdownOpen()">
            <lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon>
            <span class="rep-dropdown-label">{{ selectedVehicleLabel() }}</span>
            <lucide-icon [img]="ChevronDown" [size]="14" class="rep-dropdown-chevron"></lucide-icon>
          </button>
          @if (vehicleDropdownOpen()) {
            <div class="rep-dropdown-backdrop" (click)="vehicleDropdownOpen.set(false)"></div>
            <div class="rep-dropdown-menu">
              <button type="button"
                      (click)="onSelectVehicle('')"
                      class="rep-dropdown-item"
                      [class.rep-dropdown-item--active]="!selectedVehicleId()">
                <span>Tous les véhicules</span>
                @if (!selectedVehicleId()) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
              </button>
              @if (vehicles().length > 0) {
                <div class="rep-dropdown-divider"></div>
              }
              @for (v of vehicles(); track v.id) {
                <button type="button"
                        (click)="onSelectVehicle(v.id)"
                        class="rep-dropdown-item"
                        [class.rep-dropdown-item--active]="selectedVehicleId() === v.id">
                  <span class="rep-dropdown-item-content">
                    <span class="rep-dropdown-item-plate">{{ v.plate }}</span>
                    @if (v.brand || v.model) {
                      <span class="rep-dropdown-item-meta">{{ v.brand }} {{ v.model }}</span>
                    }
                  </span>
                  @if (selectedVehicleId() === v.id) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
              }
            </div>
          }
        </div>

        @for (p of periods; track p.label) {
          <button (click)="setPeriod(p.from, p.to)"
                  class="px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer"
                  [class]="periodFrom === p.from && periodTo === p.to
                    ? 'bg-tracky/20 text-tracky-light border-tracky/30'
                    : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
            {{ p.label }}
          </button>
        }

        @if (isAdmin()) {
          <button (click)="onRecompute()" [disabled]="!selectedVehicleId() || recomputing()"
                  class="px-3 py-1.5 text-xs rounded-lg border border-amber-500/30
                         bg-amber-500/10 text-amber-400 hover:bg-amber-500/20
                         transition-colors cursor-pointer disabled:opacity-40">
            @if (recomputing()) { Recalcul... } @else { Recalculer }
          </button>
        }
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex items-center gap-2 mb-2">
            <lucide-icon [img]="Route" [size]="16" class="text-tracky-light"></lucide-icon>
            <span class="text-xs text-fg-tertiary">Trajets</span>
          </div>
          <p class="text-xl font-semibold text-fg-primary">{{ kpis().tripCount }}</p>
        </div>
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex items-center gap-2 mb-2">
            <lucide-icon [img]="BarChart3" [size]="16" class="text-tracky-light"></lucide-icon>
            <span class="text-xs text-fg-tertiary">Distance</span>
          </div>
          <p class="text-xl font-semibold text-fg-primary">{{ (kpis().totalDistance / 1000) | number:'1.1-1' }} km</p>
        </div>
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex items-center gap-2 mb-2">
            <lucide-icon [img]="Clock" [size]="16" class="text-tracky-light"></lucide-icon>
            <span class="text-xs text-fg-tertiary">Durée totale</span>
          </div>
          <p class="text-xl font-semibold text-fg-primary">{{ formatDuration(kpis().totalDuration) }}</p>
        </div>
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex items-center gap-2 mb-2">
            <lucide-icon [img]="Gauge" [size]="16" class="text-tracky-light"></lucide-icon>
            <span class="text-xs text-fg-tertiary">Vitesse max</span>
          </div>
          <p class="text-xl font-semibold text-fg-primary">{{ kpis().maxSpeed | number:'1.0-0' }} km/h</p>
        </div>
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (trips().length === 0) {
        <div class="flex items-center justify-center h-32 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary">
          Aucun trajet pour cette période
        </div>
      } @else {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
          <table class="w-full text-sm" style="min-width:600px">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Départ</th>
                <th class="p-3 text-left">Arrivée</th>
                <th class="p-3 text-right">Durée</th>
                <th class="p-3 text-right">Distance</th>
                <th class="p-3 text-right">V. moy</th>
                <th class="p-3 text-right">V. max</th>
                <th class="p-3 text-center">Replay</th>
              </tr>
            </thead>
            <tbody>
              @for (trip of trips(); track trip.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors">
                  <td class="p-3 text-fg-primary">{{ trip.startedAt | date:'dd/MM HH:mm' }}</td>
                  <td class="p-3 text-fg-primary">{{ trip.endedAt | date:'dd/MM HH:mm' }}</td>
                  <td class="p-3 text-right font-mono text-fg-secondary">{{ formatDuration(trip.durationSeconds) }}</td>
                  <td class="p-3 text-right font-mono text-fg-secondary">{{ (max0(trip.distanceMeters) / 1000) | number:'1.1-1' }} km</td>
                  <td class="p-3 text-right text-fg-secondary">{{ trip.avgSpeed | number:'1.0-0' }}</td>
                  <td class="p-3 text-right text-fg-secondary">{{ trip.maxSpeed | number:'1.0-0' }}</td>
                  <td class="p-3 text-center">
                    @if (trip.polyline) {
                      <button (click)="openReplay(trip)" class="text-tracky-light hover:underline cursor-pointer">
                        <lucide-icon [img]="Play" [size]="16"></lucide-icon>
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <app-trip-replay
      [open]="!!replayTrip()"
      [trip]="replayTrip()"
      [vehicleType]="replayVehicleType()"
      (closed)="replayTrip.set(null)"
    />
  `,
  styles: [`
    /* ─── Dropdown véhicule custom ─── */
    .rep-dropdown-wrapper {
      position: relative;
      min-width: 0;
    }
    .rep-dropdown-trigger {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      min-width: 180px;
      max-width: 240px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      color: var(--fg-primary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
    }
    .rep-dropdown-trigger:hover { border-color: var(--border-strong) }
    .rep-dropdown-trigger--open {
      border-color: var(--tracky);
      background: var(--bg-tertiary);
    }
    .rep-dropdown-trigger lucide-icon { color: var(--tracky-light); flex-shrink: 0 }
    .rep-dropdown-label {
      flex: 1;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rep-dropdown-chevron {
      transition: transform .2s;
      color: var(--fg-tertiary) !important;
    }
    .rep-dropdown-trigger--open .rep-dropdown-chevron { transform: rotate(180deg) }

    .rep-dropdown-backdrop {
      position: fixed; inset: 0; z-index: 50;
      background: transparent;
    }
    .rep-dropdown-menu {
      position: absolute; top: calc(100% + 6px); left: 0;
      min-width: 240px; max-width: 320px;
      max-height: 320px; overflow-y: auto;
      z-index: 60;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 4px 12px rgba(0,0,0,.08);
      padding: 6px;
      animation: rep-dropdown-pop 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes rep-dropdown-pop {
      from { opacity: 0; transform: translateY(-6px) scale(.98) }
      to   { opacity: 1; transform: translateY(0) scale(1) }
    }
    .rep-dropdown-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      padding: 9px 12px;
      border-radius: 10px;
      background: transparent;
      border: 0;
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: all .12s;
    }
    .rep-dropdown-item:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .rep-dropdown-item--active {
      background: rgba(16,224,160,.10);
      color: var(--tracky-light);
      font-weight: 700;
    }
    .rep-dropdown-item--active lucide-icon { color: var(--tracky-light) }
    .rep-dropdown-item-content {
      display: flex; flex-direction: column;
      min-width: 0; flex: 1;
    }
    .rep-dropdown-item-plate {
      font-family: var(--font-mono, monospace);
      font-weight: 700;
      font-size: 13px;
      color: inherit;
    }
    .rep-dropdown-item-meta {
      font-size: 11px;
      color: var(--fg-tertiary);
      font-weight: 400;
      margin-top: 2px;
    }
    .rep-dropdown-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 6px 4px;
    }

    @media (max-width: 640px) {
      .rep-dropdown-trigger { min-width: 0; max-width: none; flex: 1 }
      .rep-dropdown-menu { left: 0; right: 0; max-width: none }
    }
  `],
})
export class ReportsComponent implements OnInit {
  private readonly tripsApi = inject(TripsApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly authService = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly trips = signal<TripDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly recomputing = signal(false);
  protected readonly replayTrip = signal<TripDto | null>(null);

  protected readonly selectedVehicleId = signal('');
  protected periodFrom = '';
  protected periodTo = '';

  protected readonly Route = Route;
  protected readonly BarChart3 = BarChart3;
  protected readonly Clock = Clock;
  protected readonly Gauge = Gauge;
  protected readonly Play = Play;
  protected readonly ChevronDown = ChevronDown;
  protected readonly TruckIcon = Truck;
  protected readonly Check = Check;

  protected readonly vehicleDropdownOpen = signal(false);

  /** Label affiché dans le bouton du dropdown selon la sélection courante. */
  protected readonly selectedVehicleLabel = computed(() => {
    const id = this.selectedVehicleId();
    if (!id) return 'Tous les véhicules';
    const v = this.vehicles().find((x) => x.id === id);
    return v?.plate ?? 'Tous les véhicules';
  });

  protected onSelectVehicle(id: string): void {
    this.selectedVehicleId.set(id);
    this.vehicleDropdownOpen.set(false);
    this.loadData();
  }

  protected readonly periods = [
    { label: 'Aujourd\'hui', from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 86400000).toISOString().slice(0, 10) },
    { label: '7 jours', from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), to: new Date(Date.now() + 86400000).toISOString().slice(0, 10) },
    { label: '30 jours', from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), to: new Date(Date.now() + 86400000).toISOString().slice(0, 10) },
  ];

  protected readonly kpis = computed(() => {
    const t = this.trips();
    return {
      tripCount: t.length,
      // Defense en profondeur : si une ligne legacy a une distance negative,
      // on la traite comme 0 plutot que de fausser le total.
      totalDistance: t.reduce((s, tr) => s + Math.max(0, tr.distanceMeters), 0),
      totalDuration: t.reduce((s, tr) => s + tr.durationSeconds, 0),
      maxSpeed: t.reduce((s, tr) => Math.max(s, tr.maxSpeed), 0),
    };
  });

  /** Helper template-friendly pour clamper une distance >= 0 a l'affichage. */
  protected max0(n: number): number {
    return Math.max(0, n ?? 0);
  }

  protected readonly replayVehicleType = computed(() => {
    const trip = this.replayTrip();
    if (!trip) return 'OTHER';
    const v = this.vehicles().find((v) => v.id === trip.vehicleId);
    return v?.type ?? 'OTHER';
  });

  protected readonly isAdmin = computed(() => {
    const role = this.authService.user()?.role;
    return role === 'SUPER_ADMIN' || role === 'FLEET_ADMIN';
  });

  ngOnInit(): void {
    this.setPeriod(this.periods[0]!.from, this.periods[0]!.to);
    this.loadVehicles();
  }

  protected setPeriod(from: string, to: string): void {
    this.periodFrom = from;
    this.periodTo = to;
    this.loadData();
  }

  protected async loadData(): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string> = { limit: '100' };
      const id = this.selectedVehicleId();
      if (id) params['vehicleId'] = id;
      if (this.periodFrom) params['from'] = this.periodFrom;
      if (this.periodTo) params['to'] = this.periodTo;

      const res = await firstValueFrom(this.tripsApi.list(params));
      this.trips.set(res.items);
    } catch { this.trips.set([]); }
    finally { this.loading.set(false); }
  }

  protected openReplay(trip: TripDto): void {
    this.replayTrip.set(trip);
  }

  protected async onRecompute(): Promise<void> {
    const id = this.selectedVehicleId();
    if (!id || !this.periodFrom || !this.periodTo) return;
    this.recomputing.set(true);
    try {
      const res = await firstValueFrom(this.tripsApi.recompute({
        vehicleId: id,
        from: this.periodFrom,
        to: this.periodTo,
      }));
      this.toast.success(`Recalcul terminé`, `${res.deleted} supprimés, ${res.created} créés`);
      await this.loadData();
    } catch { this.toast.error('Échec du recalcul'); }
    finally { this.recomputing.set(false); }
  }

  protected formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
    return `${m}min`;
  }

  private async loadVehicles(): Promise<void> {
    try {
      const list = await firstValueFrom(this.vehiclesApi.list());
      this.vehicles.set(list);
    } catch { /* silent */ }
  }
}
