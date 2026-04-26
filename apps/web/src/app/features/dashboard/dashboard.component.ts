import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Truck, Navigation, Activity, AlertTriangle, Radio } from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';
import { interval, startWith, switchMap, catchError, of } from 'rxjs';
// MetricCardComponent replaced by inline metrics
import { RealtimeService } from '../../core/services/realtime.service';
import { VehiclesApiService, type VehicleStatsDto } from '../../core/services/vehicles.service';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, EngineControlButtonComponent, RouterLink],
  template: `
    <div class="dash-page">
      <!-- Background grid -->
      <div class="dash-grid-bg"></div>
      <div class="dash-glow"></div>

      <!-- Header -->
      <div class="dash-header">
        <div>
          <h1 class="dash-title">Vue d'ensemble</h1>
          <p class="dash-sub">Suivi en temps réel de votre flotte</p>
        </div>
        <div class="dash-status">
          @if (realtime.connected()) {
            <span class="status-dot online"></span>
            <span class="status-text online">Connecté</span>
          } @else {
            <span class="status-dot"></span>
            <span class="status-text">Connexion...</span>
          }
        </div>
      </div>

      <!-- Metrics -->
      <div class="metrics-grid">
        @for (m of metrics(); track m.label) {
          <div class="metric-card" [class]="m.accent">
            <div class="metric-icon-wrap" [class]="m.accent">
              <lucide-icon [img]="m.icon" [size]="18"></lucide-icon>
            </div>
            <div class="metric-content">
              <span class="metric-value">{{ m.value }}</span>
              <span class="metric-label">{{ m.label }}</span>
            </div>
            @if (m.trend) {
              <span class="metric-trend">{{ m.trend }}</span>
            }
          </div>
        }
      </div>

      <!-- Live tracking -->
      <div class="live-section">
        <div class="live-header">
          <h2 class="live-title">
            <lucide-icon [img]="Radio" [size]="18" class="text-tracky-light"></lucide-icon>
            Suivi temps réel
          </h2>
          <span class="live-count">{{ enrichedPositions().length }} actif(s)</span>
        </div>

        @if (enrichedPositions().length === 0) {
          <div class="live-empty">
            <lucide-icon [img]="Radio" [size]="32" style="opacity:.2"></lucide-icon>
            <p>Aucune position en temps réel</p>
          </div>
        } @else {
          <div class="live-list">
            @for (item of enrichedPositions(); track item.trackerId) {
              <a [routerLink]="['/vehicles', item.vehicleId]" class="live-row">
                <div class="live-indicator" [class]="item.speedKmh > 5 ? 'moving' : 'idle'"></div>
                <div class="live-info">
                  <p class="live-id">{{ item.trackerId.slice(0, 8) }}...</p>
                  <p class="live-coords">{{ item.lat.toFixed(4) }}, {{ item.lng.toFixed(4) }}</p>
                </div>
                <div class="live-speed" [class]="item.speedKmh > 90 ? 'fast' : item.speedKmh > 50 ? 'medium' : item.speedKmh > 0 ? 'slow' : 'stopped'">
                  {{ item.speedKmh.toFixed(0) }} <span class="speed-unit">km/h</span>
                </div>
                <span class="live-time">{{ item.timestamp | date:'HH:mm:ss' }}</span>
                <app-engine-control-button
                  [trackerId]="item.trackerId"
                  [vehiclePlate]="item.trackerId.slice(0, 8)"
                  [currentSpeedKmh]="item.speedKmh"
                  [validFix]="item.valid"
                  [positionAge]="item.ageSeconds"
                  [ignition]="item.ignition"
                />
              </a>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .dash-page { position: relative; overflow: hidden }

    /* Grid background */
    .dash-grid-bg {
      position: absolute; inset: 0; pointer-events: none; z-index: 0;
      background-image:
        radial-gradient(circle, var(--border-subtle) 1px, transparent 1px);
      background-size: 24px 24px;
      mask-image: radial-gradient(ellipse at 50% 0%, black 0%, transparent 70%);
      -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black 0%, transparent 70%);
      opacity: .5;
    }
    .dash-glow {
      position: absolute; top: -80px; left: 50%; transform: translateX(-50%); width: 600px; height: 300px;
      background: radial-gradient(ellipse, rgba(16,224,160,.07) 0%, transparent 70%);
      pointer-events: none; z-index: 0;
    }

    /* Header */
    .dash-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px }
    .dash-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .dash-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .dash-status { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; background: var(--bg-secondary); border: 1px solid var(--border-subtle) }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-tertiary); animation: pulse 2s ease infinite }
    .status-dot.online { background: var(--tracky-light) }
    .status-text { font-size: 11px; font-weight: 600; color: var(--fg-tertiary) }
    .status-text.online { color: var(--tracky-light) }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

    /* Metrics */
    .metrics-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px }
    .metric-card {
      position: relative; padding: 18px; border-radius: 14px; overflow: hidden;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      transition: all .3s var(--ease-tracky, ease);
    }
    .metric-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-tracky-glow) }
    .metric-card::before {
      content: ''; position: absolute; top: 0; right: 0; width: 80px; height: 80px;
      border-radius: 0 0 0 80px; opacity: .06; pointer-events: none;
    }
    .metric-card.green::before { background: var(--tracky-light) }
    .metric-card.blue::before { background: #3b82f6 }
    .metric-card.amber::before { background: #f59e0b }
    .metric-card.red::before { background: #ef4444 }

    .metric-icon-wrap {
      width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 14px;
    }
    .metric-icon-wrap.green { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .metric-icon-wrap.blue { background: rgba(59,130,246,.12); color: #3b82f6 }
    .metric-icon-wrap.amber { background: rgba(245,158,11,.12); color: #f59e0b }
    .metric-icon-wrap.red { background: rgba(239,68,68,.12); color: #ef4444 }

    .metric-content { display: flex; flex-direction: column }
    .metric-value { font-size: 28px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, Poppins, sans-serif); letter-spacing: -.02em; line-height: 1 }
    .metric-label { font-size: 12px; font-weight: 500; color: var(--fg-tertiary); margin-top: 4px }
    .metric-trend { font-size: 11px; color: var(--fg-secondary); margin-top: 8px }

    /* Live section */
    .live-section { position: relative; z-index: 1 }
    .live-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px }
    .live-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .live-count { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); padding: 4px 10px; border-radius: 20px; background: var(--bg-secondary); border: 1px solid var(--border-subtle) }

    .live-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
      height: 120px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); font-size: 13px;
    }

    .live-list { display: flex; flex-direction: column; gap: 6px }
    .live-row {
      display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); text-decoration: none; color: inherit;
      transition: all .25s; cursor: pointer;
    }
    .live-row:hover { border-color: var(--border-strong); box-shadow: var(--shadow-tracky-glow) }

    .live-indicator { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: var(--fg-tertiary) }
    .live-indicator.moving { background: var(--tracky-light); box-shadow: 0 0 8px rgba(16,224,160,.4); animation: pulse 2s ease infinite }
    .live-indicator.idle { background: var(--fg-tertiary) }

    .live-info { flex: 1; min-width: 0 }
    .live-id { font-size: 13px; font-weight: 600; color: var(--fg-primary); font-family: var(--font-mono, monospace) }
    .live-coords { font-size: 10px; color: var(--fg-tertiary); margin-top: 1px }

    .live-speed { font-size: 18px; font-weight: 800; font-family: var(--font-display, Poppins, sans-serif); min-width: 70px; text-align: right }
    .live-speed.fast { color: #ef4444 }
    .live-speed.medium { color: #f59e0b }
    .live-speed.slow { color: var(--tracky-light) }
    .live-speed.stopped { color: var(--fg-tertiary) }
    .speed-unit { font-size: 10px; font-weight: 500; opacity: .6 }

    .live-time { font-size: 10px; color: var(--fg-tertiary); min-width: 50px; text-align: right }

    @media (max-width: 1024px) { .metrics-grid { grid-template-columns: repeat(2, 1fr) } }
    @media (max-width: 640px) {
      .metrics-grid { grid-template-columns: 1fr }
      .live-row { gap: 10px; padding: 10px 12px }
      .live-speed { min-width: 58px; font-size: 16px }
      .live-time { display: none }
      .live-coords { display: none }
    }
  `],
})
export class DashboardComponent implements OnInit {
  protected readonly realtime = inject(RealtimeService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  protected readonly Radio = Radio;
  protected readonly Math = Math;

  private readonly accessibleVehicleIds = signal<Set<string> | 'ALL'>('ALL');

  protected readonly metrics = computed(() => {
    const s = this.stats();
    return [
      { label: 'Véhicules', value: s?.total ?? '—', trend: s?.newThisMonth ? `+${s.newThisMonth} ce mois` : '', icon: Truck, accent: 'green' },
      { label: 'En mouvement', value: s?.moving ?? '—', trend: s?.total ? `${Math.round((s.moving / s.total) * 100)}% de la flotte` : '', icon: Navigation, accent: 'blue' },
      { label: 'À l\'arrêt', value: s?.idle ?? '—', trend: '', icon: Activity, accent: 'amber' },
      { label: 'Alertes', value: s?.criticalAlerts ?? '—', trend: s?.criticalAlerts ? `${s.criticalAlerts} critiques` : '', icon: AlertTriangle, accent: 'red' },
    ];
  });

  protected readonly stats = toSignal(
    interval(30_000).pipe(
      startWith(0),
      switchMap(() => this.vehiclesApi.stats()),
      catchError(() => of(null)),
    ),
  );

  protected readonly enrichedPositions = computed(() => {
    const now = Date.now();
    const ids = this.accessibleVehicleIds();
    return this.realtime.positionsList()
      .filter((pos) => ids === 'ALL' || ids.has(pos.vehicleId))
      .map((pos) => ({
        ...pos,
        ageSeconds: Math.round((now - new Date(pos.timestamp).getTime()) / 1000),
      }));
  });

  async ngOnInit(): Promise<void> {
    try {
      const vehicles = await firstValueFrom(this.vehiclesApi.list());
      this.accessibleVehicleIds.set(new Set(vehicles.map((v) => v.id)));
    } catch { /* fallback to ALL */ }
  }
}
