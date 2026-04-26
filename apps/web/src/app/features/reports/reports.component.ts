import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, BarChart3, Route, Clock, Gauge, Play } from 'lucide-angular';
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

      <div class="flex items-center gap-3 flex-wrap">
        <select [(ngModel)]="selectedVehicleId" (ngModelChange)="loadData()"
                class="px-3 py-2 text-sm rounded-xl bg-bg-secondary border border-border-subtle text-fg-primary">
          <option value="">Tous les véhicules</option>
          @for (v of vehicles(); track v.id) {
            <option [value]="v.id">{{ v.plate }}</option>
          }
        </select>

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
          <button (click)="onRecompute()" [disabled]="!selectedVehicleId || recomputing()"
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

  protected selectedVehicleId = '';
  protected periodFrom = '';
  protected periodTo = '';

  protected readonly Route = Route;
  protected readonly BarChart3 = BarChart3;
  protected readonly Clock = Clock;
  protected readonly Gauge = Gauge;
  protected readonly Play = Play;

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
      if (this.selectedVehicleId) params['vehicleId'] = this.selectedVehicleId;
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
    if (!this.selectedVehicleId || !this.periodFrom || !this.periodTo) return;
    this.recomputing.set(true);
    try {
      const res = await firstValueFrom(this.tripsApi.recompute({
        vehicleId: this.selectedVehicleId,
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
