import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe, DatePipe } from '@angular/common';
import { LucideAngularModule, Fuel, MapPin, TrendingUp, TrendingDown } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { VehicleFuelReportDto } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';

/**
 * Carburant (P3) — CARTE « Suivi carburant » d'un véhicule, dans sa fiche détail. Montre la
 * FRÉQUENCE des passages en station (« ~1 tous les X jours »), les PRIX réellement constatés (avec
 * tendance), et le COÛT carburant estimé sur la période — au prix constaté vs au prix paramétré de
 * la flotte (pour montrer que les coûts s'appliquent et suivre les améliorations). Explique en clair.
 */
@Component({
  selector: 'app-fuel-report-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, DatePipe, LucideAngularModule],
  template: `
    <section class="frc">
      <header class="frc-head">
        <span class="frc-title"><lucide-icon [img]="FuelIcon" [size]="14"></lucide-icon> Suivi carburant</span>
        <span class="frc-period">{{ days() }} derniers jours</span>
      </header>

      @if (loading()) {
        <div class="frc-loading"><span class="frc-spin"></span></div>
      } @else if (data(); as d) {
        @if (d.visits > 0) {
          <!-- Fréquence des passages -->
          <div class="frc-freq">
            <span class="frc-freq-n">{{ d.visits }}</span>
            <span class="frc-freq-l">
              passage{{ d.visits > 1 ? 's' : '' }} en station-service
              @if (d.avgDaysBetween != null) { <strong>· environ 1 tous les {{ d.avgDaysBetween }} jour{{ d.avgDaysBetween >= 2 ? 's' : '' }}</strong> }
            </span>
          </div>

          <!-- Prix constatés + tendance -->
          @if (d.priceAvg != null) {
            <div class="frc-price">
              <div class="frc-price-head">
                <div>
                  <div class="frc-price-main">{{ d.priceAvg | number:'1.3-3' }} <small>€/L</small></div>
                  <div class="frc-price-sub">prix moyen constaté ({{ fuelLabel(d.fuelType) }})</div>
                </div>
                @if (spark(); as sp) {
                  <svg class="frc-spark" [attr.viewBox]="'0 0 ' + sp.w + ' ' + sp.h" [attr.width]="sp.w" [attr.height]="sp.h" preserveAspectRatio="none" aria-hidden="true">
                    <polyline [attr.points]="sp.points" fill="none" stroke="#A78BFA" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
                  </svg>
                }
              </div>
              <div class="frc-price-range">min {{ d.priceMin | number:'1.3-3' }} · max {{ d.priceMax | number:'1.3-3' }} · dernier {{ d.priceLatest | number:'1.3-3' }} €/L</div>
            </div>
          }

          <!-- Coût estimé + comparaison prix flotte -->
          @if (d.costAtObservedEur != null) {
            <div class="frc-cost">
              <div class="frc-cost-row">
                <span class="frc-cost-lbl">Coût carburant estimé <small>{{ d.estimatedLiters | number:'1.0-1' }} L · {{ d.distanceKm | number:'1.0-0' }} km</small></span>
                <strong class="frc-cost-val">{{ d.costAtObservedEur | number:'1.2-2' }} €</strong>
              </div>
              @if (d.costAtFleetPriceEur != null) {
                <p class="frc-cost-cmp" [attr.data-sign]="costSign()">
                  <lucide-icon [img]="costDelta()! >= 0 ? UpIcon : DownIcon" [size]="12"></lucide-icon>
                  au prix réel constaté — soit {{ deltaAbs() | number:'1.2-2' }} € {{ costDelta()! >= 0 ? 'de plus' : 'de moins' }} que le prix paramétré de la flotte ({{ d.costAtFleetPriceEur | number:'1.2-2' }} € à {{ d.fleetPriceEurL | number:'1.2-2' }} €/L)
                </p>
              }
            </div>
          }

          <!-- Stations fréquentées -->
          <ul class="frc-stations">
            @for (s of d.stations; track s.stationId) {
              <li>
                <lucide-icon [img]="PinIcon" [size]="12"></lucide-icon>
                <span class="frc-st-name">{{ s.brand || 'Station-service' }}</span>
                @if (s.city) { <span class="frc-st-city">{{ s.city }}</span> }
                <span class="frc-st-visits">×{{ s.visits }}</span>
                @if (s.lastPriceEur != null) { <span class="frc-st-price">{{ s.lastPriceEur | number:'1.3-3' }} €/L</span> }
              </li>
            }
          </ul>

          <!-- Cohérence des passages : km depuis le passage précédent (un vrai plein est espacé de km). -->
          @if (data()!.recentVisits.length) {
            <div class="frc-visits">
              <div class="frc-visits-h">Derniers passages · cohérence</div>
              @for (v of data()!.recentVisits; track v.at) {
                <div class="frc-visit" [class.frc-visit--warn]="v.suspiciouslyClose">
                  <span class="frc-visit-when">{{ v.at | date: 'dd/MM HH:mm' }}</span>
                  <span class="frc-visit-brand">{{ v.brand || 'Station' }}</span>
                  <span class="frc-visit-stop">arrêt {{ v.durationMin }}min</span>
                  <span class="frc-visit-km">
                    @if (v.kmSincePrev == null) { 1ᵉʳ passage }
                    @else { {{ v.kmSincePrev | number: '1.0-0' }} km depuis le précédent }
                  </span>
                  @if (v.suspiciouslyClose) {
                    <span class="frc-visit-flag" title="Peu (ou pas) de km depuis le passage précédent — vérifiez que c'est un vrai plein, pas un arrêt près d'une station sur la route">à vérifier</span>
                  }
                </div>
              }
            </div>
          }

          <p class="frc-help">Les passages en station sont détectés automatiquement quand un trajet analysé s'arrête à une station. Le prix est relevé au moment du passage (prix officiels des carburants). Objectif : suivre la fréquence, la consommation et les coûts — et constater les améliorations dans le temps.</p>
        } @else {
          <div class="frc-empty">
            <lucide-icon [img]="FuelIcon" [size]="28" class="opacity-30"></lucide-icon>
            <p>Aucun passage en station sur la période</p>
            <span>Les passages apparaissent quand un trajet <strong>analysé</strong> s'arrête à une station-service (prix + fréquence + coûts suivis automatiquement).</span>
          </div>
        }
      } @else {
        <p class="frc-help">Suivi indisponible.</p>
      }
    </section>
  `,
  styles: [`
    .frc { display: flex; flex-direction: column; gap: 11px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .frc-head { display: flex; align-items: center; justify-content: space-between; }
    .frc-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .frc-title lucide-icon { color: #A78BFA; }
    .frc-period { font-size: 11px; color: var(--fg-tertiary); }
    .frc-loading { display: flex; justify-content: center; padding: 16px; }
    .frc-spin { width: 22px; height: 22px; border: 3px solid var(--border-subtle); border-top-color: #A78BFA; border-radius: 50%; animation: frc-rot .8s linear infinite; }
    @keyframes frc-rot { to { transform: rotate(360deg); } }
    .frc-freq { display: flex; align-items: baseline; gap: 9px; }
    .frc-freq-n { font-size: 30px; font-weight: 800; color: #A78BFA; line-height: 1; }
    .frc-freq-l { font-size: 12.5px; color: var(--fg-secondary); line-height: 1.4; }
    .frc-freq-l strong { color: var(--fg-primary); }
    .frc-price { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 11px; background: color-mix(in srgb, #A78BFA 7%, var(--bg-tertiary)); border: 1px solid color-mix(in srgb, #A78BFA 16%, transparent); }
    .frc-price-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .frc-price-main { font-size: 20px; font-weight: 800; color: var(--fg-primary); line-height: 1; }
    .frc-price-main small { font-size: 12px; color: var(--fg-tertiary); font-weight: 600; }
    .frc-price-sub { font-size: 11px; color: var(--fg-tertiary); margin-top: 2px; }
    .frc-spark { flex-shrink: 0; }
    .frc-price-range { font-size: 11px; color: var(--fg-tertiary); }
    .frc-cost { display: flex; flex-direction: column; gap: 4px; }
    .frc-cost-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .frc-cost-lbl { font-size: 12.5px; font-weight: 700; color: var(--fg-secondary); }
    .frc-cost-lbl small { font-weight: 500; color: var(--fg-tertiary); margin-left: 4px; }
    .frc-cost-val { font-size: 18px; font-weight: 800; color: var(--fg-primary); }
    .frc-cost-cmp { margin: 0; display: inline-flex; align-items: baseline; gap: 5px; font-size: 11.5px; line-height: 1.45; color: var(--fg-tertiary); }
    .frc-cost-cmp lucide-icon { position: relative; top: 2px; flex-shrink: 0; }
    .frc-cost-cmp[data-sign="up"] { color: #F59E0B; }
    .frc-cost-cmp[data-sign="down"] { color: #10E0A0; }
    .frc-stations { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .frc-stations li { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-secondary); }
    .frc-stations lucide-icon { color: #A78BFA; flex-shrink: 0; }
    .frc-st-name { font-weight: 700; color: var(--fg-primary); }
    .frc-st-city { color: var(--fg-tertiary); }
    .frc-st-visits { color: var(--fg-tertiary); }
    .frc-st-price { margin-left: auto; font-weight: 700; color: #A78BFA; }
    .frc-visits { display: flex; flex-direction: column; gap: 4px; }
    .frc-visits-h { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); }
    .frc-visit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--fg-secondary); padding: 4px 8px; border-radius: 8px; background: var(--bg-tertiary, rgba(148,163,184,.08)); }
    .frc-visit--warn { background: color-mix(in srgb, #f59e0b 12%, transparent); }
    .frc-visit-when { color: var(--fg-tertiary); }
    .frc-visit-brand { font-weight: 700; color: var(--fg-primary); }
    .frc-visit-stop { color: var(--fg-tertiary); }
    .frc-visit-km { margin-left: auto; font-weight: 600; }
    .frc-visit-flag { color: #b45309; background: color-mix(in srgb, #f59e0b 22%, transparent); padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; }
    .frc-help { margin: 0; font-size: 11px; line-height: 1.5; color: var(--fg-tertiary); }
    .frc-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 16px 10px; color: var(--fg-tertiary); }
    .frc-empty p { margin: 0; font-weight: 700; color: var(--fg-secondary); }
    .frc-empty span { font-size: 11.5px; max-width: 340px; }
  `],
})
export class FuelReportCardComponent {
  private readonly api = inject(TripAnalysisApiService);

  readonly vehicleId = input.required<string>();
  readonly days = input<number>(90);

  protected readonly data = signal<VehicleFuelReportDto | null>(null);
  protected readonly loading = signal(true);

  protected readonly FuelIcon = Fuel;
  protected readonly PinIcon = MapPin;
  protected readonly UpIcon = TrendingUp;
  protected readonly DownIcon = TrendingDown;

  constructor() {
    effect(() => {
      const id = this.vehicleId();
      if (id) void this.load(id);
    });
  }

  /** Écart coût constaté − coût paramétré (€). > 0 = les coûts réels dépassent le budget flotte. */
  protected readonly costDelta = computed<number | null>(() => {
    const d = this.data();
    if (!d || d.costAtObservedEur == null || d.costAtFleetPriceEur == null) return null;
    return Math.round((d.costAtObservedEur - d.costAtFleetPriceEur) * 100) / 100;
  });
  protected deltaAbs(): number { return Math.abs(this.costDelta() ?? 0); }
  protected costSign(): 'up' | 'down' { return (this.costDelta() ?? 0) >= 0 ? 'up' : 'down'; }

  /** Mini-sparkline de la tendance des prix constatés. */
  protected readonly spark = computed<{ w: number; h: number; points: string } | null>(() => {
    const t = this.data()?.priceTrend ?? [];
    if (t.length < 2) return null;
    const w = 110, h = 26, pad = 3;
    const prices = t.map((p) => p.priceEur);
    const min = Math.min(...prices), max = Math.max(...prices);
    const range = max - min || 1;
    const pts = t.map((p, i) => {
      const x = pad + (i / (t.length - 1)) * (w - 2 * pad);
      const y = pad + (1 - (p.priceEur - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { w, h, points: pts.join(' ') };
  });

  protected fuelLabel(t: string | null): string {
    switch (t) {
      case 'gazole': return 'Gazole';
      case 'sp95': return 'SP95';
      case 'sp98': return 'SP98';
      case 'e10': return 'E10';
      case 'e85': return 'E85';
      case 'gplc': return 'GPL';
      default: return 'carburant';
    }
  }

  private async load(vehicleId: string): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await firstValueFrom(this.api.fuelReport(vehicleId, this.fromIso())));
    } catch {
      this.data.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  private fromIso(): string {
    return new Date(Date.now() - this.days() * 24 * 3600 * 1000).toISOString();
  }
}
