import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Truck, Navigation, Activity, AlertTriangle, Radio } from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';
import { interval, startWith, switchMap, catchError, of } from 'rxjs';
import { MetricCardComponent } from '../../shared/components/metric-card.component';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehiclesApiService, type VehicleStatsDto } from '../../core/services/vehicles.service';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [MetricCardComponent, LucideAngularModule, DatePipe, EngineControlButtonComponent, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <h1 class="text-2xl font-display font-bold text-fg-primary">Vue d'ensemble</h1>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <app-metric-card
          label="Vehicules"
          [value]="stats()?.total ?? '—'"
          [trend]="stats()?.newThisMonth ? '+' + stats()!.newThisMonth + ' ce mois' : ''"
          [icon]="Truck"
        />
        <app-metric-card
          label="En mouvement"
          [value]="stats()?.moving ?? '—'"
          [trend]="stats()?.total ? Math.round((stats()!.moving / stats()!.total) * 100) + '% de la flotte' : ''"
          [icon]="Navigation"
        />
        <app-metric-card
          label="A l'arret"
          [value]="stats()?.idle ?? '—'"
          [icon]="Activity"
        />
        <app-metric-card
          label="Alertes"
          [value]="stats()?.criticalAlerts ?? '—'"
          [trend]="stats()?.criticalAlerts ? stats()!.criticalAlerts + ' critiques' : ''"
          [icon]="AlertTriangle"
        />
      </div>

      <div class="flex flex-col gap-4">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-display font-semibold text-fg-primary">Suivi temps reel</h2>
          @if (realtime.connected()) {
            <span class="flex items-center gap-1.5 text-xs text-tracky-light">
              <span class="w-2 h-2 rounded-full bg-tracky-light animate-pulse"></span>
              Connecte
            </span>
          } @else {
            <span class="flex items-center gap-1.5 text-xs text-fg-tertiary">
              <span class="w-2 h-2 rounded-full bg-fg-tertiary animate-pulse"></span>
              Connexion en cours...
            </span>
          }
        </div>

        @if (enrichedPositions().length === 0) {
          <div class="flex items-center justify-center h-32 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle">
            <p class="text-fg-tertiary text-sm">Aucune position en temps reel</p>
          </div>
        } @else {
          <div class="grid gap-3">
            @for (item of enrichedPositions(); track item.trackerId) {
              <div class="flex items-center gap-4 p-4 rounded-[--radius-card]
                          bg-bg-secondary border border-border-subtle
                          transition-all duration-300 ease-tracky
                          hover:border-border-strong hover:shadow-tracky-glow">
                <a [routerLink]="['/vehicles', item.vehicleId]"
                   class="flex items-center gap-4 flex-1 min-w-0 cursor-pointer">
                  <lucide-icon [img]="Radio" [size]="20" class="text-tracky-light shrink-0"></lucide-icon>
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-fg-primary font-mono truncate">
                      {{ item.trackerId.slice(0, 8) }}...
                    </p>
                    <p class="text-xs text-fg-tertiary">
                      {{ item.lat.toFixed(4) }}, {{ item.lng.toFixed(4) }}
                    </p>
                  </div>
                </a>
                <div class="text-right shrink-0 mr-2">
                  <p class="text-sm font-semibold text-fg-primary">
                    {{ item.speedKmh.toFixed(0) }} km/h
                  </p>
                  <p class="text-xs text-fg-tertiary">
                    {{ item.timestamp | date:'HH:mm:ss' }}
                  </p>
                </div>
                <app-engine-control-button
                  [trackerId]="item.trackerId"
                  [vehiclePlate]="item.trackerId.slice(0, 8)"
                  [currentSpeedKmh]="item.speedKmh"
                  [validFix]="item.valid"
                  [positionAge]="item.ageSeconds"
                  [ignition]="item.ignition"
                />
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class DashboardComponent {
  protected readonly realtime = inject(RealtimeService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  protected readonly Truck = Truck;
  protected readonly Navigation = Navigation;
  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Radio = Radio;
  protected readonly Math = Math;

  protected readonly stats = toSignal(
    interval(30_000).pipe(
      startWith(0),
      switchMap(() => this.vehiclesApi.stats()),
      catchError(() => of(null)),
    ),
  );

  protected readonly enrichedPositions = computed(() => {
    const now = Date.now();
    return this.realtime.positionsList().map((pos) => ({
      ...pos,
      ageSeconds: Math.round((now - new Date(pos.timestamp).getTime()) / 1000),
    }));
  });
}
