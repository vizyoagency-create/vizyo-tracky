import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import {
  LucideAngularModule, Gauge, TrendingDown, Truck, Route, Info, CalendarRange, Sparkles,
} from 'lucide-angular';
import type { FleetOptimizationDto, UtilizationSlot, VehicleUtilizationDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../core/services/agenda.service';

type Period = 7 | 28 | 90;

const SLOT_LABELS: Record<UtilizationSlot, string> = {
  night: 'Nuit',
  morning: 'Matin',
  afternoon: 'Après-midi',
  evening: 'Soir',
};
const SLOT_ORDER: UtilizationSlot[] = ['night', 'morning', 'afternoon', 'evening'];
const DOW_SHORT = ['', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

@Component({
  selector: 'app-fleet-optimization',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, LucideAngularModule],
  template: `
    <div class="flex flex-col gap-5">
      <!-- Header -->
      <header class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h1 class="text-2xl font-display font-bold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="GaugeIcon" [size]="22" class="text-tracky-light"></lucide-icon>
            Optimisation de la flotte
          </h1>
          <p class="text-sm text-fg-tertiary mt-0.5">
            Utilisation réelle dérivée des trajets — repérez les véhicules sous-utilisés et les créneaux mutualisables.
          </p>
        </div>
        <div class="fo-seg" role="tablist" aria-label="Période">
          @for (p of periods; track p) {
            <button type="button" role="tab" [attr.aria-selected]="period() === p"
                    class="fo-seg-btn" [class.fo-seg-btn--on]="period() === p" (click)="setPeriod(p)">
              {{ p }}j
            </button>
          }
        </div>
      </header>

      @if (loading()) {
        <div class="fo-skel"></div>
        <div class="fo-skel"></div>
      } @else if (error()) {
        <div class="fo-empty fo-empty--err">{{ error() }}</div>
      } @else if (data(); as d) {
        <!-- KPIs -->
        <div class="fo-kpis">
          <div class="fo-kpi">
            <div class="fo-kpi-ic fo-kpi-ic--blue"><lucide-icon [img]="TruckIcon" [size]="16"></lucide-icon></div>
            <div class="fo-kpi-body">
              <span class="fo-kpi-val">{{ d.vehicles.length }}</span>
              <span class="fo-kpi-lbl">Véhicules</span>
            </div>
          </div>
          <div class="fo-kpi">
            <div class="fo-kpi-ic fo-kpi-ic--amber"><lucide-icon [img]="TrendingDownIcon" [size]="16"></lucide-icon></div>
            <div class="fo-kpi-body">
              <span class="fo-kpi-val">{{ underutilized().length }}</span>
              <span class="fo-kpi-lbl">Sous-utilisés</span>
            </div>
          </div>
          <div class="fo-kpi">
            <div class="fo-kpi-ic fo-kpi-ic--green"><lucide-icon [img]="GaugeIcon" [size]="16"></lucide-icon></div>
            <div class="fo-kpi-body">
              <span class="fo-kpi-val">{{ avgUtilization() | number:'1.0-0' }}%</span>
              <span class="fo-kpi-lbl">Utilisation moy.</span>
            </div>
          </div>
          <div class="fo-kpi">
            <div class="fo-kpi-ic fo-kpi-ic--violet"><lucide-icon [img]="RouteIcon" [size]="16"></lucide-icon></div>
            <div class="fo-kpi-body">
              <span class="fo-kpi-val">{{ totalKm() | number:'1.0-0' }}</span>
              <span class="fo-kpi-lbl">km · {{ d.periodDays }}j</span>
            </div>
          </div>
        </div>

        <!-- Opportunités de mutualisation -->
        @if (underutilized().length > 0) {
          <section class="fo-card">
            <div class="fo-card-head">
              <h2 class="fo-card-title">
                <lucide-icon [img]="SparklesIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                Opportunités de mutualisation
              </h2>
              <span class="fo-card-sub">{{ underutilized().length }} véhicule(s) sous-utilisé(s)</span>
            </div>
            <div class="fo-oppo-grid">
              @for (v of underutilized(); track v.vehicleId) {
                <div class="fo-oppo">
                  <div class="fo-oppo-top">
                    <span class="fo-plate">{{ v.vehiclePlate || '—' }}</span>
                    <span class="fo-util-badge" [style.--p]="v.utilizationRatio">
                      {{ v.utilizationRatio * 100 | number:'1.0-0' }}%
                    </span>
                  </div>
                  <div class="fo-oppo-meta">
                    {{ v.activeDays }} j actifs · {{ v.activeHours | number:'1.0-1' }} h · {{ v.tripCount }} trajets
                  </div>
                  @if (v.freePatterns.length > 0) {
                    <div class="fo-free-chips">
                      @for (fp of v.freePatterns; track fp) {
                        <span class="fo-free-chip">Libre {{ fp }}</span>
                      }
                    </div>
                  } @else {
                    <div class="fo-free-empty">Très peu utilisé sur la période</div>
                  }
                </div>
              }
            </div>
          </section>
        }

        <!-- Heatmap d'utilisation -->
        <section class="fo-card">
          <div class="fo-card-head">
            <h2 class="fo-card-title">
              <lucide-icon [img]="CalendarRangeIcon" [size]="16" class="text-tracky-light"></lucide-icon>
              Carte d'utilisation
            </h2>
            <div class="fo-legend">
              <span class="fo-legend-lbl">Libre</span>
              <span class="fo-legend-grad"></span>
              <span class="fo-legend-lbl">Occupé</span>
            </div>
          </div>

          @if (d.vehicles.length === 0) {
            <div class="fo-empty">Aucun véhicule dans votre périmètre.</div>
          } @else {
            <div class="fo-heat-scroll">
              <div class="fo-heat">
                <!-- En-tête jours/créneaux -->
                <div class="fo-heat-corner"></div>
                @for (dow of dows; track dow) {
                  <div class="fo-heat-day">{{ dowShort(dow) }}</div>
                }
                <!-- Lignes véhicules -->
                @for (v of d.vehicles; track v.vehicleId) {
                  <div class="fo-heat-veh">
                    <span class="fo-plate fo-plate--sm">{{ v.vehiclePlate || '—' }}</span>
                    <span class="fo-heat-util">{{ v.utilizationRatio * 100 | number:'1.0-0' }}%</span>
                  </div>
                  @for (dow of dows; track dow) {
                    <div class="fo-heat-cellgrp">
                      @for (slot of slotOrder; track slot) {
                        <span class="fo-heat-cell"
                              [style.background]="cellBg(occ(v, dow, slot))"
                              [title]="dowShort(dow) + ' ' + slotLabel(slot) + ' · ' + (occ(v, dow, slot) * 100 | number:'1.0-0') + '%'"></span>
                      }
                    </div>
                  }
                }
              </div>
            </div>
            <div class="fo-heat-foot">
              <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
              Chaque jour = 4 créneaux (nuit · matin · après-midi · soir), heure locale. Vert = roulé ; vide = libre.
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    /* Segmented période */
    .fo-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .fo-seg-btn { padding: 5px 12px; border-radius: 7px; font-size: 13px; font-weight: 600; color: var(--fg-tertiary); transition: all .15s; }
    .fo-seg-btn--on { background: var(--bg-primary); color: var(--fg-primary); box-shadow: 0 1px 3px rgba(0,0,0,.18); }

    /* KPIs */
    .fo-kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    @media (min-width: 720px) { .fo-kpis { grid-template-columns: repeat(4, 1fr); } }
    .fo-kpi { display: flex; align-items: center; gap: 11px; padding: 13px 15px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .fo-kpi-ic { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .fo-kpi-ic--blue { background: rgba(56,189,248,.14); color: #38BDF8; }
    .fo-kpi-ic--amber { background: rgba(245,158,11,.15); color: #F59E0B; }
    .fo-kpi-ic--green { background: rgba(16,224,160,.14); color: var(--tracky-light, #10E0A0); }
    .fo-kpi-ic--violet { background: rgba(167,139,250,.15); color: #A78BFA; }
    .fo-kpi-body { display: flex; flex-direction: column; min-width: 0; }
    .fo-kpi-val { font-size: 20px; font-weight: 800; color: var(--fg-primary); line-height: 1.1; font-family: var(--font-display, inherit); }
    .fo-kpi-lbl { font-size: 11.5px; color: var(--fg-tertiary); }

    /* Cartes */
    .fo-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 16px; }
    .fo-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 13px; flex-wrap: wrap; }
    .fo-card-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); display: flex; align-items: center; gap: 7px; font-family: var(--font-display, inherit); }
    .fo-card-sub { font-size: 12px; color: var(--fg-tertiary); }

    /* Opportunités */
    .fo-oppo-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
    @media (min-width: 640px) { .fo-oppo-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1024px) { .fo-oppo-grid { grid-template-columns: repeat(3, 1fr); } }
    .fo-oppo { padding: 12px 13px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .fo-oppo-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fo-oppo-meta { font-size: 11.5px; color: var(--fg-tertiary); margin-top: 4px; }
    .fo-plate { font-weight: 800; font-size: 14px; color: var(--fg-primary); letter-spacing: .3px; }
    .fo-plate--sm { font-size: 12.5px; }
    .fo-util-badge { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px;
      color: color-mix(in srgb, #F59E0B calc(var(--p) * 100%), #EF4444); background: rgba(245,158,11,.13); }
    .fo-free-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
    .fo-free-chip { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 7px; background: rgba(16,224,160,.12); color: var(--tracky-light, #10E0A0); }
    .fo-free-empty { font-size: 11px; color: var(--fg-muted); margin-top: 8px; font-style: italic; }

    /* Légende */
    .fo-legend { display: flex; align-items: center; gap: 7px; }
    .fo-legend-lbl { font-size: 11px; color: var(--fg-tertiary); }
    .fo-legend-grad { width: 64px; height: 9px; border-radius: 5px; border: 1px solid var(--border-subtle);
      background: linear-gradient(90deg, var(--bg-tertiary), rgba(16,224,160,.35), rgba(16,224,160,1)); }

    /* Heatmap */
    .fo-heat-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .fo-heat { display: grid; grid-template-columns: 132px repeat(7, minmax(56px, 1fr)); gap: 4px; min-width: 560px; }
    .fo-heat-corner { }
    .fo-heat-day { text-align: center; font-size: 11px; font-weight: 700; color: var(--fg-tertiary); padding-bottom: 2px; }
    .fo-heat-veh { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-right: 8px; }
    .fo-heat-util { font-size: 11px; font-weight: 700; color: var(--fg-tertiary); }
    .fo-heat-cellgrp { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; }
    .fo-heat-cell { height: 18px; border-radius: 3px; border: 1px solid var(--border-subtle); }
    .fo-heat-foot { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-muted); margin-top: 11px; }

    /* États */
    .fo-skel { height: 80px; border-radius: 14px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: fo-sh 1.3s infinite; }
    @keyframes fo-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .fo-empty { padding: 28px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
    .fo-empty--err { color: #EF4444; }
  `],
})
export class FleetOptimizationComponent implements OnInit {
  private readonly api = inject(AgendaApiService);

  protected readonly GaugeIcon = Gauge;
  protected readonly TrendingDownIcon = TrendingDown;
  protected readonly TruckIcon = Truck;
  protected readonly RouteIcon = Route;
  protected readonly InfoIcon = Info;
  protected readonly CalendarRangeIcon = CalendarRange;
  protected readonly SparklesIcon = Sparkles;

  protected readonly periods: Period[] = [7, 28, 90];
  protected readonly dows = [1, 2, 3, 4, 5, 6, 7];
  protected readonly slotOrder = SLOT_ORDER;

  protected readonly period = signal<Period>(28);
  protected readonly data = signal<FleetOptimizationDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly underutilized = computed(() =>
    (this.data()?.vehicles ?? []).filter((v) => v.underutilized),
  );
  protected readonly avgUtilization = computed(() => {
    const vs = this.data()?.vehicles ?? [];
    if (vs.length === 0) return 0;
    return (vs.reduce((s, v) => s + v.utilizationRatio, 0) / vs.length) * 100;
  });
  protected readonly totalKm = computed(() =>
    (this.data()?.vehicles ?? []).reduce((s, v) => s + v.distanceKm, 0),
  );
  /** Pré-calcul O(1) des occupations par cellule (évite un .find() par cellule à chaque rendu). */
  private readonly cellMaps = computed(() => {
    const m = new Map<string, Map<string, number>>();
    for (const v of this.data()?.vehicles ?? []) {
      const cm = new Map<string, number>();
      for (const c of v.cells) cm.set(`${c.dayOfWeek}:${c.slot}`, c.occupancy);
      m.set(v.vehicleId, cm);
    }
    return m;
  });

  ngOnInit(): void {
    void this.load();
  }

  protected setPeriod(p: Period): void {
    if (p === this.period()) return;
    this.period.set(p);
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const to = new Date();
    const from = new Date(to.getTime() - this.period() * 24 * 60 * 60 * 1000);
    try {
      const res = await firstValueFrom(
        this.api.getUtilization({ from: from.toISOString(), to: to.toISOString() }),
      );
      this.data.set(res);
    } catch {
      this.error.set('Impossible de charger les données d\'utilisation.');
    } finally {
      this.loading.set(false);
    }
  }

  protected dowShort(dow: number): string {
    return DOW_SHORT[dow] ?? '';
  }
  protected slotLabel(slot: UtilizationSlot): string {
    return SLOT_LABELS[slot];
  }

  /** Occupation d'une cellule (jour × créneau) pour un véhicule. */
  protected occ(v: VehicleUtilizationDto, dow: number, slot: UtilizationSlot): number {
    return this.cellMaps().get(v.vehicleId)?.get(`${dow}:${slot}`) ?? 0;
  }

  /** Fond d'une cellule : neutre si libre, intensité verte selon l'occupation. */
  protected cellBg(occupancy: number): string {
    if (occupancy <= 0) return 'var(--bg-tertiary)';
    const alpha = 0.18 + occupancy * 0.82;
    return `rgba(16, 224, 160, ${alpha.toFixed(2)})`;
  }
}
