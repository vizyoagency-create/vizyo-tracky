import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule, Leaf, OctagonX, Gauge, Fuel, Sparkles, Loader, AlertTriangle } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { TripAnalysisDto } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { apiErrorMessage } from '../../core/error/api-error';

/**
 * Traçabilité fine (Palier 4) — RANGÉE DE BADGES d'analyse d'un trajet, RÉUTILISABLE : fiche véhicule
 * (onglet Trajets), Rapports, Replay. Reçoit l'analyse pré-chargée (`analysis`) OU propose un bouton
 * « Analyser » (POST) si absente. Émet `analyzed` pour que le parent mette en cache. Zéro appel si
 * l'analyse est déjà fournie (le parent la charge en LOT via listForVehicle).
 */
@Component({
  selector: 'app-trip-analysis-badges',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
    @if (current(); as a) {
      <div class="tab-badges" role="group" aria-label="Analyse du trajet">
        <!-- Éco-conduite (couleur = score) -->
        <span class="tab-badge tab-badge--eco" [attr.data-tier]="ecoTier()" [title]="'Score éco-conduite : ' + a.ecoScore + '/100'">
          <lucide-icon [img]="LeafIcon" [size]="12"></lucide-icon> Éco {{ a.ecoScore }}
        </span>

        @if (a.speedingCount > 0) {
          <span class="tab-badge tab-badge--danger" [title]="speedingTitle(a)">
            <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
            {{ a.speedingCount }} excès@if (a.limitsKnown && a.maxOverKmh > 0) { <span class="tab-badge-sub">+{{ a.maxOverKmh | number:'1.0-0' }}</span> }
          </span>
        }

        @if (a.stopCount > 0) {
          <span class="tab-badge" title="Arrêts significatifs (≥ 4 min)">
            <lucide-icon [img]="StopIcon" [size]="12"></lucide-icon> {{ a.stopCount }} arrêt{{ a.stopCount > 1 ? 's' : '' }}
          </span>
        }

        @if (a.harshAccel + a.harshBrake > 0) {
          <span class="tab-badge tab-badge--warn" title="Accélérations / freinages brusques">
            <lucide-icon [img]="GaugeIcon" [size]="12"></lucide-icon> {{ a.harshAccel + a.harshBrake }} à-coup{{ (a.harshAccel + a.harshBrake) > 1 ? 's' : '' }}
          </span>
        }

        @if (a.idleSec >= 60) {
          <span class="tab-badge" title="Temps moteur tournant à l'arrêt (gaspillage)">
            ⏱ ralenti {{ minutes(a.idleSec) }} min
          </span>
        }

        @if (a.fuelLiters != null) {
          <span class="tab-badge" [title]="'Consommation estimée · ' + (a.co2Kg | number:'1.1-1') + ' kg CO₂'">
            <lucide-icon [img]="FuelIcon" [size]="12"></lucide-icon> {{ a.fuelLiters | number:'1.1-1' }} L
          </span>
        }

        <button type="button" class="tab-refresh" (click)="runAnalyze()" [disabled]="busy()" title="Recalculer l'analyse">
          @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="12" class="tab-spin"></lucide-icon> }
          @else { <lucide-icon [img]="SparklesIcon" [size]="12"></lucide-icon> }
        </button>
      </div>
    } @else {
      <button type="button" class="tab-analyze" (click)="runAnalyze()" [disabled]="busy()" title="Analyser ce trajet (arrêts, excès, éco-conduite)">
        @if (busy()) {
          <lucide-icon [img]="LoaderIcon" [size]="13" class="tab-spin"></lucide-icon> Analyse…
        } @else {
          <lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon> Analyser
        }
      </button>
    }
    @if (error(); as e) { <span class="tab-err">{{ e }}</span> }
  `,
  styles: [`
    :host { display: block; }
    .tab-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .tab-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .tab-badge lucide-icon { flex-shrink: 0; }
    .tab-badge-sub { opacity: .8; font-weight: 800; margin-left: 1px; }
    /* Éco : vert ≥80, ambre ≥50, rouge <50 */
    .tab-badge--eco[data-tier="good"] { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); color: var(--tracky-light, #10E0A0); border-color: transparent; }
    .tab-badge--eco[data-tier="mid"]  { background: color-mix(in srgb, #F59E0B 16%, transparent); color: #F59E0B; border-color: transparent; }
    .tab-badge--eco[data-tier="bad"]  { background: color-mix(in srgb, #EF4444 16%, transparent); color: #EF4444; border-color: transparent; }
    .tab-badge--danger { background: color-mix(in srgb, #EF4444 14%, transparent); color: #EF4444; border-color: transparent; }
    .tab-badge--warn { background: color-mix(in srgb, #F59E0B 13%, transparent); color: #F59E0B; border-color: transparent; }
    .tab-analyze, .tab-refresh {
      display: inline-flex; align-items: center; gap: 5px;
      border-radius: 8px; cursor: pointer; font-weight: 700;
      color: var(--tracky-light, #10E0A0);
      background: color-mix(in srgb, var(--tracky-light, #10E0A0) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 24%, transparent);
      transition: background .15s;
    }
    .tab-analyze { padding: 5px 11px; font-size: 11.5px; }
    .tab-refresh { padding: 4px 7px; font-size: 11px; }
    .tab-analyze:hover:not(:disabled), .tab-refresh:hover:not(:disabled) { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); }
    .tab-analyze:disabled, .tab-refresh:disabled { opacity: .6; cursor: default; }
    .tab-spin { animation: tab-rot .9s linear infinite; }
    @keyframes tab-rot { to { transform: rotate(360deg); } }
    .tab-err { font-size: 11px; color: #EF4444; }
  `],
})
export class TripAnalysisBadgesComponent {
  private readonly api = inject(TripAnalysisApiService);

  /** Trajet analysé. */
  readonly tripId = input.required<string>();
  /** Analyse pré-chargée (par le parent, en lot). null = pas encore analysé. */
  readonly analysis = input<TripAnalysisDto | null>(null);
  /** Émis après (ré)analyse → le parent met à jour son cache. */
  readonly analyzed = output<TripAnalysisDto>();

  /** État local (l'analyse fraîche prime sur l'input le temps de la session). */
  private readonly fresh = signal<TripAnalysisDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Analyse effective = la fraîche (si recalculée) sinon celle du parent. */
  protected readonly current = computed(() => this.fresh() ?? this.analysis());

  protected readonly ecoTier = computed(() => {
    const a = this.current();
    const s = a?.ecoScore ?? 100;
    return s >= 80 ? 'good' : s >= 50 ? 'mid' : 'bad';
  });

  protected readonly LeafIcon = Leaf;
  protected readonly StopIcon = OctagonX;
  protected readonly GaugeIcon = Gauge;
  protected readonly FuelIcon = Fuel;
  protected readonly SparklesIcon = Sparkles;
  protected readonly LoaderIcon = Loader;
  protected readonly AlertIcon = AlertTriangle;

  protected minutes(sec: number): number { return Math.round(sec / 60); }
  protected speedingTitle(a: TripAnalysisDto): string {
    return a.limitsKnown
      ? `${a.speedingCount} excès de vitesse — dépassement max +${Math.round(a.maxOverKmh)} km/h`
      : `${a.speedingCount} pointe(s) de vitesse (limites légales non résolues — excès probable)`;
  }

  protected async runAnalyze(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.analyze(this.tripId()));
      this.fresh.set(res);
      this.analyzed.emit(res);
    } catch (e) {
      this.error.set(apiErrorMessage(e, 'Analyse impossible.'));
    } finally {
      this.busy.set(false);
    }
  }
}
