import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Truck, Navigation, Activity, AlertTriangle, Radio } from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';
import { MetricCardComponent } from '../../shared/components/metric-card.component';
import { RealtimeService } from '../../core/services/realtime.service';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [MetricCardComponent, LucideAngularModule, DatePipe, EngineControlButtonComponent],
  template: `
    <div class="flex flex-col gap-6">
      <h1 class="text-2xl font-display font-bold text-fg-primary">Vue d'ensemble</h1>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <app-metric-card label="Vehicules" [value]="24" trend="+2 ce mois" [icon]="Truck" />
        <app-metric-card label="En mouvement" [value]="8" trend="33% de la flotte" [icon]="Navigation" />
        <app-metric-card label="A l'arret" [value]="14" [icon]="Activity" />
        <app-metric-card label="Alertes" [value]="3" trend="2 critiques" [icon]="AlertTriangle" />
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
                <lucide-icon [img]="Radio" [size]="20" class="text-tracky-light shrink-0"></lucide-icon>
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-fg-primary font-mono truncate">
                    {{ item.trackerId.slice(0, 8) }}...
                  </p>
                  <p class="text-xs text-fg-tertiary">
                    {{ item.lat.toFixed(4) }}, {{ item.lng.toFixed(4) }}
                  </p>
                </div>
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
                  [validFix]="item.valid ?? true"
                  [positionAge]="item.ageSeconds"
                  [ignition]="item.ignition ?? true"
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
  protected readonly Truck = Truck;
  protected readonly Navigation = Navigation;
  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Radio = Radio;

  protected readonly enrichedPositions = computed(() => {
    const now = Date.now();
    return this.realtime.positionsList().map((pos) => ({
      ...pos,
      ageSeconds: Math.round((now - new Date(pos.timestamp).getTime()) / 1000),
    }));
  });
}
