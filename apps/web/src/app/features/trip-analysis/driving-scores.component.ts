import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { PlanUpsellComponent } from '../../shared/ui/plan-upsell/plan-upsell.component';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, ChevronLeft, Gauge, Car, UserRound, Layers, RefreshCw, AlertTriangle, TrendingUp, Info, Trophy } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { DrivingScoreRowDto, DrivingScoreScope, DrivingScoresDto } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { apiErrorMessage } from '../../core/error/api-error';

type Period = '7d' | '30d' | '90d';

/**
 * Notation (2026-07) — VUE « Scores de conduite ». Classe véhicules / conducteurs / groupes par leur
 * NOTE de conduite (0-100, moyenne des éco-scores de leurs trajets : moins d'excès / d'à-coups / de
 * ralenti = meilleure note). 100 % déterministe (aucune IA affichée). Pensée pour des non-experts :
 * note lettrée A→E, explications, stats claires.
 */
@Component({
  selector: 'app-driving-scores',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DecimalPipe, LucideAngularModule, PlanUpsellComponent],
  template: `
    <div class="ds">
      <app-plan-upsell feature="scores" />
      <a routerLink="/reports" class="ds-back"><lucide-icon [img]="BackIcon" [size]="15"></lucide-icon> Rapports</a>
      <header class="ds-head">
        <div class="ds-title">
          <div class="ds-ico"><lucide-icon [img]="GaugeIcon" [size]="22"></lucide-icon></div>
          <div>
            <h1>Scores de conduite</h1>
            <p>Une note (0 à 100) pour chaque véhicule, conducteur et groupe : une <strong>compétition amicale</strong> pour progresser — {{ periodLabel() }}.</p>
          </div>
        </div>
        <button type="button" class="ds-refresh" (click)="reload()" [disabled]="loading()" aria-label="Rafraîchir">
          <lucide-icon [img]="RefreshIcon" [size]="15" [class.ds-spin]="loading()"></lucide-icon>
        </button>
      </header>

      <!-- Aide (débutants) -->
      <div class="ds-help">
        <lucide-icon [img]="InfoIcon" [size]="14"></lucide-icon>
        <span>La note résume la qualité de conduite : elle <strong>baisse</strong> avec les excès de vitesse, les freinages/accélérations brusques et le ralenti moteur. <strong>A</strong> = conduite exemplaire, <strong>E</strong> = à améliorer. Seuls les trajets déjà analysés comptent.</span>
      </div>

      <!-- Contrôles : scope + période -->
      <div class="ds-controls">
        <div class="ds-seg">
          <button type="button" (click)="setScope('vehicle')" [class.on]="scope() === 'vehicle'"><lucide-icon [img]="CarIcon" [size]="14"></lucide-icon> Véhicules</button>
          <button type="button" (click)="setScope('driver')" [class.on]="scope() === 'driver'"><lucide-icon [img]="UserIcon" [size]="14"></lucide-icon> Conducteurs</button>
          <button type="button" (click)="setScope('group')" [class.on]="scope() === 'group'"><lucide-icon [img]="LayersIcon" [size]="14"></lucide-icon> Groupes</button>
        </div>
        <div class="ds-seg ds-seg--sm">
          @for (p of periods; track p.key) {
            <button type="button" (click)="setPeriod(p.key)" [class.on]="period() === p.key">{{ p.label }}</button>
          }
        </div>
      </div>

      @if (error(); as e) { <div class="ds-alert"><lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon> {{ e }}</div> }

      @if (data(); as d) {
        <!-- Moyenne globale -->
        @if (d.overallScore != null) {
          <section class="ds-overall">
            <div class="ds-grade ds-grade--lg" [attr.data-grade]="d.overallGrade">{{ d.overallGrade }}</div>
            <div class="ds-overall-txt">
              <span class="ds-overall-n">{{ d.overallScore }}<small>/100</small></span>
              <span class="ds-overall-l">Score moyen de la flotte · {{ d.totalTrips }} trajet{{ d.totalTrips > 1 ? 's' : '' }} analysé{{ d.totalTrips > 1 ? 's' : '' }}</span>
            </div>
          </section>
        }

        <!-- Podium (top 3) — le cœur de la compétition. -->
        @if (podium(); as pod) {
          <section class="ds-podium-wrap">
            <span class="ds-podium-cap"><lucide-icon [img]="TrophyIcon" [size]="13"></lucide-icon> Podium — top 3 des {{ scopeNoun() }}s</span>
            <div class="ds-podium">
              @for (p of pod; track p.rank) {
                <div class="ds-pod" [attr.data-rank]="p.rank">
                  <span class="ds-pod-medal">{{ medal(p.rank) }}</span>
                  <span class="ds-pod-name" [title]="p.row.label">
                    @if (p.row.color) { <span class="ds-dot" [style.background]="p.row.color"></span> }
                    {{ p.row.label }}
                  </span>
                  <span class="ds-pod-score" [attr.data-grade]="p.row.grade">{{ p.row.score }}<small>/100</small></span>
                  <div class="ds-pod-step">{{ p.rank }}<sup>{{ p.rank === 1 ? 'er' : 'e' }}</sup></div>
                </div>
              }
            </div>
          </section>
        }

        @if (d.rows.length === 0) {
          <div class="ds-empty">
            <lucide-icon [img]="GaugeIcon" [size]="44" class="opacity-30"></lucide-icon>
            <p>Aucun {{ scopeNoun() }} noté sur la période.</p>
            <span>Analysez des trajets (bouton « Analyser » dans les rapports ou la fiche véhicule) pour alimenter les scores.</span>
          </div>
        } @else {
          <div class="ds-list">
            @for (r of d.rows; track r.id; let i = $index) {
              <article class="ds-row" [class.ds-row--podium]="i < 3">
                <span class="ds-rank" [class.ds-rank--medal]="i < 3">{{ i < 3 ? medal(i + 1) : (i + 1) }}</span>
                <span class="ds-grade" [attr.data-grade]="r.grade" [title]="'Note ' + r.grade">{{ r.grade }}</span>
                <div class="ds-row-main">
                  <div class="ds-row-top">
                    <span class="ds-row-label">
                      @if (r.color) { <span class="ds-dot" [style.background]="r.color"></span> }
                      {{ r.label }}
                    </span>
                    <span class="ds-row-score">{{ r.score }}<small>/100</small></span>
                  </div>
                  <div class="ds-bar"><div class="ds-bar-fill" [attr.data-grade]="r.grade" [style.width.%]="r.score"></div></div>
                  <div class="ds-row-stats">
                    @if (r.sublabel) { <span class="ds-row-sub">{{ r.sublabel }}</span> }
                    <span>{{ r.tripCount }} trajet{{ r.tripCount > 1 ? 's' : '' }}</span>
                    <span>{{ r.distanceKm | number:'1.0-0' }} km</span>
                    @if (r.speedingTrips > 0) {
                      @if (r.speedingTripRefs.length > 0) {
                        <a [routerLink]="['/vehicles', r.speedingTripRefs[0].vehicleId]"
                           [queryParams]="{ tab: 'reports', trip: r.speedingTripRefs[0].tripId, tripDate: r.speedingTripRefs[0].startedAt }"
                           class="ds-warn ds-warn-link" [title]="speedingTitle(r)">{{ r.speedingTrips }} avec excès →</a>
                      } @else {
                        <span class="ds-warn">{{ r.speedingTrips }} avec excès</span>
                      }
                    }
                    @if (r.harshCount > 0) { <span>{{ r.harshCount }} à-coup{{ r.harshCount > 1 ? 's' : '' }}</span> }
                    @if (r.fuelLiters > 0) { <span>{{ r.fuelLiters | number:'1.0-0' }} L</span> }
                  </div>
                </div>
              </article>
            }
          </div>
        }
      } @else if (loading()) {
        <div class="ds-loading"><span class="ds-spinner"></span></div>
      }
    </div>
  `,
  styles: [`
    .ds { max-width: 900px; margin: 0 auto; padding: 16px 16px 40px; display: flex; flex-direction: column; gap: 14px; }
    .ds-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); width: fit-content; }
    .ds-back:hover { color: var(--tracky-light, #10E0A0); }
    .ds-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .ds-title { display: flex; gap: 12px; align-items: center; }
    .ds-ico { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, transparent); color: var(--tracky-light, #10E0A0); flex-shrink: 0; }
    .ds-head h1 { margin: 0; font-size: 20px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em; }
    .ds-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--fg-tertiary); }
    .ds-refresh { width: 36px; height: 36px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-secondary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); flex-shrink: 0; }
    .ds-spin { animation: ds-rot 1s linear infinite; } @keyframes ds-rot { to { transform: rotate(360deg); } }
    .ds-help { display: flex; gap: 8px; align-items: flex-start; padding: 10px 13px; border-radius: 11px; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 7%, var(--bg-secondary)); border: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 20%, transparent); font-size: 12px; line-height: 1.5; color: var(--fg-secondary); }
    .ds-help lucide-icon { color: var(--tracky-light, #10E0A0); flex-shrink: 0; margin-top: 1px; }
    .ds-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .ds-seg { display: inline-flex; gap: 4px; background: var(--bg-tertiary); padding: 4px; border-radius: 12px; }
    .ds-seg button { display: inline-flex; align-items: center; gap: 5px; padding: 7px 13px; border-radius: 9px; font-size: 12.5px; font-weight: 700; color: var(--fg-tertiary); }
    .ds-seg button.on { background: var(--bg-secondary); color: var(--tracky-light, #10E0A0); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
    .ds-seg--sm button { padding: 6px 11px; font-size: 12px; }
    .ds-alert { display: flex; align-items: center; gap: 8px; padding: 10px 13px; border-radius: 10px; background: color-mix(in srgb, #EF4444 12%, transparent); color: #EF4444; font-size: 12.5px; }
    .ds-overall { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .ds-overall-txt { display: flex; flex-direction: column; }
    .ds-overall-n { font-size: 28px; font-weight: 800; color: var(--fg-primary); line-height: 1; }
    .ds-overall-n small { font-size: 14px; color: var(--fg-tertiary); font-weight: 600; }
    .ds-overall-l { font-size: 12px; color: var(--fg-tertiary); margin-top: 4px; }
    /* Note lettrée (couleur par grade) */
    .ds-grade { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; font-size: 16px; font-weight: 800; flex-shrink: 0; }
    .ds-grade--lg { width: 52px; height: 52px; font-size: 26px; border-radius: 14px; }
    .ds-grade[data-grade="A"] { background: color-mix(in srgb, #10E0A0 18%, transparent); color: #10E0A0; }
    .ds-grade[data-grade="B"] { background: color-mix(in srgb, #84CC16 18%, transparent); color: #84CC16; }
    .ds-grade[data-grade="C"] { background: color-mix(in srgb, #F59E0B 18%, transparent); color: #F59E0B; }
    .ds-grade[data-grade="D"] { background: color-mix(in srgb, #F97316 18%, transparent); color: #F97316; }
    .ds-grade[data-grade="E"] { background: color-mix(in srgb, #EF4444 18%, transparent); color: #EF4444; }
    /* Podium (top 3) */
    .ds-podium-wrap { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px 4px; border-radius: 14px; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 5%, var(--bg-secondary)); border: 1px solid var(--border-subtle); }
    .ds-podium-cap { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-tertiary); }
    .ds-podium-cap lucide-icon { color: #F5B301; }
    .ds-podium { display: flex; justify-content: center; align-items: flex-end; gap: 10px; }
    .ds-pod { flex: 1 1 0; max-width: 30%; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; min-width: 0; }
    .ds-pod-medal { font-size: 25px; line-height: 1; }
    .ds-pod[data-rank="1"] .ds-pod-medal { font-size: 32px; }
    .ds-pod-name { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 12px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ds-pod-score { font-size: 15px; font-weight: 800; color: var(--fg-secondary); }
    .ds-pod-score small { font-size: 9px; color: var(--fg-tertiary); font-weight: 600; }
    .ds-pod-score[data-grade="A"] { color: #10E0A0; } .ds-pod-score[data-grade="B"] { color: #84CC16; }
    .ds-pod-score[data-grade="C"] { color: #F59E0B; } .ds-pod-score[data-grade="D"] { color: #F97316; } .ds-pod-score[data-grade="E"] { color: #EF4444; }
    .ds-pod-step { width: 100%; border-radius: 10px 10px 0 0; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 6px; font-size: 13px; font-weight: 800; color: var(--fg-secondary); background: var(--bg-tertiary); }
    .ds-pod-step sup { font-size: 8px; }
    .ds-pod[data-rank="1"] .ds-pod-step { height: 60px; background: linear-gradient(180deg, color-mix(in srgb, #F5B301 30%, var(--bg-tertiary)), var(--bg-tertiary)); color: #F5B301; }
    .ds-pod[data-rank="2"] .ds-pod-step { height: 44px; }
    .ds-pod[data-rank="3"] .ds-pod-step { height: 32px; }
    .ds-list { display: flex; flex-direction: column; gap: 8px; }
    .ds-row { display: flex; align-items: center; gap: 11px; padding: 12px 14px; border-radius: 13px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .ds-row--podium { border-color: color-mix(in srgb, #F5B301 30%, var(--border-subtle)); }
    .ds-rank { font-size: 13px; font-weight: 800; color: var(--fg-tertiary); width: 18px; text-align: center; flex-shrink: 0; }
    .ds-rank--medal { font-size: 17px; }
    .ds-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
    .ds-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .ds-row-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ds-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .ds-row-score { font-size: 14px; font-weight: 800; color: var(--fg-primary); flex-shrink: 0; }
    .ds-row-score small { font-size: 10px; color: var(--fg-tertiary); font-weight: 600; }
    .ds-bar { height: 5px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
    .ds-bar-fill { height: 100%; border-radius: 3px; }
    .ds-bar-fill[data-grade="A"] { background: #10E0A0; } .ds-bar-fill[data-grade="B"] { background: #84CC16; }
    .ds-bar-fill[data-grade="C"] { background: #F59E0B; } .ds-bar-fill[data-grade="D"] { background: #F97316; } .ds-bar-fill[data-grade="E"] { background: #EF4444; }
    .ds-row-stats { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--fg-tertiary); }
    .ds-row-sub { font-weight: 600; }
    .ds-warn { color: #EF4444; font-weight: 700; }
    a.ds-warn-link { text-decoration: none; cursor: pointer; white-space: nowrap; }
    a.ds-warn-link:hover { text-decoration: underline; }
    .ds-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; padding: 40px 20px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); }
    .ds-empty p { margin: 0; font-weight: 700; color: var(--fg-secondary); }
    .ds-empty span { font-size: 12px; max-width: 340px; }
    .ds-loading { display: flex; justify-content: center; padding: 40px; }
    .ds-spinner { width: 26px; height: 26px; border: 3px solid var(--border-subtle); border-top-color: var(--tracky-light, #10E0A0); border-radius: 50%; animation: ds-rot .8s linear infinite; }
  `],
})
export class DrivingScoresComponent implements OnInit {
  private readonly api = inject(TripAnalysisApiService);
  private readonly fleetFilter = inject(FleetFilterService);

  /** Recharge le classement quand le super-admin change de société (sélecteur top-bar).
   *  On saute le 1er run de l'effect (ngOnInit fait déjà le chargement initial). */
  private fleetEffectFirstRun = true;
  private readonly fleetChangeEffect = effect(() => {
    this.fleetFilter.selectedFleetId();
    if (this.fleetEffectFirstRun) { this.fleetEffectFirstRun = false; return; }
    void this.reload();
  });

  protected readonly scope = signal<DrivingScoreScope>('vehicle');
  protected readonly period = signal<Period>('90d');
  protected readonly data = signal<DrivingScoresDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly periods: { key: Period; label: string }[] = [
    { key: '7d', label: '7 j' }, { key: '30d', label: '30 j' }, { key: '90d', label: '90 j' },
  ];

  protected readonly BackIcon = ChevronLeft;
  protected readonly GaugeIcon = Gauge;
  protected readonly CarIcon = Car;
  protected readonly UserIcon = UserRound;
  protected readonly LayersIcon = Layers;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly TrendIcon = TrendingUp;
  protected readonly InfoIcon = Info;
  protected readonly TrophyIcon = Trophy;

  protected periodLabel(): string {
    return this.period() === '7d' ? '7 derniers jours' : this.period() === '90d' ? '90 derniers jours' : '30 derniers jours';
  }
  protected scopeNoun(): string {
    return this.scope() === 'driver' ? 'conducteur' : this.scope() === 'group' ? 'groupe' : 'véhicule';
  }

  /**
   * Podium (top 3) en ordre SCÉNIQUE — 2e à gauche, 1er au centre (plus haut), 3e à droite. Dès 2
   * entités notées (petites flottes) : 1er + 2e. Sous 2, pas de podium (rien à départager).
   */
  protected readonly podium = computed<{ row: DrivingScoresDto['rows'][number]; rank: number }[] | null>(() => {
    const rows = this.data()?.rows ?? [];
    if (rows.length < 2) return null;
    if (rows.length === 2) return [{ row: rows[0], rank: 1 }, { row: rows[1], rank: 2 }];
    return [
      { row: rows[1], rank: 2 },
      { row: rows[0], rank: 1 },
      { row: rows[2], rank: 3 },
    ];
  });

  protected medal(rank: number): string {
    return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
  }

  /** Info-bulle du lien « N avec excès » → ouvre le trajet fautif le plus récent + son récit IA. */
  protected speedingTitle(r: DrivingScoreRowDto): string {
    const suffix = r.speedingTrips > 1 ? ` (le plus récent sur ${r.speedingTrips})` : '';
    return `Ouvrir le trajet à excès${suffix} et son récit IA`;
  }

  ngOnInit(): void { void this.reload(); }

  protected setScope(s: DrivingScoreScope): void { if (s === this.scope()) return; this.scope.set(s); void this.reload(); }
  protected setPeriod(p: Period): void { if (p === this.period()) return; this.period.set(p); void this.reload(); }

  private fromIso(): string {
    const days = this.period() === '7d' ? 7 : this.period() === '90d' ? 90 : 30;
    return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await firstValueFrom(
        this.api.scores(this.scope(), this.fromIso(), undefined, this.fleetFilter.selectedFleetId() ?? undefined),
      ));
    } catch (e) {
      swallow('driving-scores:reload', e);
      this.error.set(apiErrorMessage(e, 'Chargement des scores impossible.'));
    } finally {
      this.loading.set(false);
    }
  }
}
