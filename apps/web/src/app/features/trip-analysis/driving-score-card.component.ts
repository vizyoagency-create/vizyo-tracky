import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Gauge, Trophy, TrendingUp, TrendingDown, ChevronRight } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { DrivingScoreDetailDto, DrivingScoreScope } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';

/**
 * Compétition & motivation (2026-07) — CARTE de score PERSO d'une entité (véhicule / conducteur /
 * groupe), RÉUTILISABLE dans chaque fiche détail. Montre la note (0-100 + lettre), le RANG dans le
 * classement (podium 🥇🥈🥉), la comparaison à la MOYENNE de la flotte, et un message motivant. Le
 * but : situer chacun et l'encourager à s'améliorer. Explique en clair à quoi ça sert (débutants).
 */
@Component({
  selector: 'app-driving-score-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DecimalPipe, LucideAngularModule],
  template: `
    <section class="dsc">
      <header class="dsc-head">
        <span class="dsc-title"><lucide-icon [img]="GaugeIcon" [size]="14"></lucide-icon> Score de conduite</span>
        <a routerLink="/scores" class="dsc-link">Classement <lucide-icon [img]="ChevronIcon" [size]="13"></lucide-icon></a>
      </header>

      @if (loading()) {
        <div class="dsc-loading"><span class="dsc-spinner"></span></div>
      } @else if (data(); as d) {
        @if (d.row; as r) {
          <div class="dsc-body">
            <div class="dsc-grade" [attr.data-grade]="r.grade">{{ r.grade }}</div>
            <div class="dsc-main">
              <div class="dsc-score-row">
                <span class="dsc-score">{{ r.score }}<small>/100</small></span>
                @if (d.rank != null && d.total > 1) {
                  <span class="dsc-rank" [class.dsc-rank--podium]="d.rank <= 3">{{ medal(d.rank) }} {{ d.rank }}<sup>{{ d.rank === 1 ? 'er' : 'e' }}</sup> / {{ d.total }}</span>
                }
              </div>
              @if (d.total > 1 && d.vsOverall != null && d.overallScore != null) {
                <div class="dsc-vs" [class.up]="d.vsOverall >= 0" [class.down]="d.vsOverall < 0">
                  <lucide-icon [img]="d.vsOverall >= 0 ? UpIcon : DownIcon" [size]="13"></lucide-icon>
                  {{ d.vsOverall >= 0 ? '+' : '' }}{{ d.vsOverall }} pts {{ d.vsOverall >= 0 ? 'au-dessus' : 'en dessous' }} de la moyenne ({{ d.overallScore }})
                </div>
              }
            </div>
          </div>

          <p class="dsc-motiv" [attr.data-tier]="tier()">{{ motivation() }}</p>

          <div class="dsc-stats">
            <span>{{ r.tripCount }} trajet{{ r.tripCount > 1 ? 's' : '' }}</span>
            <span>{{ r.distanceKm | number:'1.0-0' }} km</span>
            @if (r.speedingTrips > 0) { <span class="dsc-warn">{{ r.speedingTrips }} avec excès</span> }
            @if (r.harshCount > 0) { <span>{{ r.harshCount }} à-coup{{ r.harshCount > 1 ? 's' : '' }}</span> }
          </div>

          <p class="dsc-help">La note ({{ '0 à 100' }}) résume la qualité de conduite de {{ subject() }} : elle monte quand il y a moins d'excès de vitesse, d'à-coups et de ralenti. Objectif : viser le haut du classement !</p>
        } @else {
          <div class="dsc-empty">
            <lucide-icon [img]="GaugeIcon" [size]="30" class="opacity-30"></lucide-icon>
            <p>Pas encore de trajet analysé</p>
            <span>Le score de {{ subject() }} apparaîtra ici dès qu'un trajet est analysé (bouton « Analyser » dans les trajets).</span>
          </div>
        }
      } @else {
        <p class="dsc-help">Score indisponible.</p>
      }
    </section>
  `,
  styles: [`
    .dsc { display: flex; flex-direction: column; gap: 11px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .dsc-head { display: flex; align-items: center; justify-content: space-between; }
    .dsc-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .dsc-title lucide-icon { color: var(--tracky-light, #10E0A0); }
    .dsc-link { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; font-weight: 700; color: var(--tracky-light, #10E0A0); }
    .dsc-loading { display: flex; justify-content: center; padding: 16px; }
    .dsc-spinner { width: 22px; height: 22px; border: 3px solid var(--border-subtle); border-top-color: var(--tracky-light, #10E0A0); border-radius: 50%; animation: dsc-rot .8s linear infinite; }
    @keyframes dsc-rot { to { transform: rotate(360deg); } }
    .dsc-body { display: flex; align-items: center; gap: 13px; }
    .dsc-grade { display: inline-flex; align-items: center; justify-content: center; width: 50px; height: 50px; border-radius: 14px; font-size: 25px; font-weight: 800; flex-shrink: 0; }
    .dsc-grade[data-grade="A"] { background: color-mix(in srgb, #10E0A0 18%, transparent); color: #10E0A0; }
    .dsc-grade[data-grade="B"] { background: color-mix(in srgb, #84CC16 18%, transparent); color: #84CC16; }
    .dsc-grade[data-grade="C"] { background: color-mix(in srgb, #F59E0B 18%, transparent); color: #F59E0B; }
    .dsc-grade[data-grade="D"] { background: color-mix(in srgb, #F97316 18%, transparent); color: #F97316; }
    .dsc-grade[data-grade="E"] { background: color-mix(in srgb, #EF4444 18%, transparent); color: #EF4444; }
    .dsc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .dsc-score-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .dsc-score { font-size: 26px; font-weight: 800; color: var(--fg-primary); line-height: 1; }
    .dsc-score small { font-size: 13px; color: var(--fg-tertiary); font-weight: 600; }
    .dsc-rank { font-size: 13px; font-weight: 800; color: var(--fg-secondary); white-space: nowrap; }
    .dsc-rank sup { font-size: 9px; }
    .dsc-rank--podium { color: var(--tracky-light, #10E0A0); }
    .dsc-vs { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; }
    .dsc-vs.up { color: #10E0A0; } .dsc-vs.down { color: #F59E0B; }
    .dsc-motiv { margin: 0; font-size: 13px; font-weight: 700; line-height: 1.4; padding: 9px 12px; border-radius: 10px; }
    .dsc-motiv[data-tier="great"] { background: color-mix(in srgb, #10E0A0 12%, transparent); color: #10E0A0; }
    .dsc-motiv[data-tier="good"] { background: color-mix(in srgb, #84CC16 12%, transparent); color: #84CC16; }
    .dsc-motiv[data-tier="mid"] { background: color-mix(in srgb, #F59E0B 12%, transparent); color: #F59E0B; }
    .dsc-motiv[data-tier="low"] { background: color-mix(in srgb, #F97316 12%, transparent); color: #F97316; }
    .dsc-stats { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; color: var(--fg-tertiary); }
    .dsc-warn { color: #EF4444; font-weight: 700; }
    .dsc-help { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--fg-tertiary); }
    .dsc-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 18px 10px; color: var(--fg-tertiary); }
    .dsc-empty p { margin: 0; font-weight: 700; color: var(--fg-secondary); }
    .dsc-empty span { font-size: 11.5px; max-width: 320px; }
  `],
})
export class DrivingScoreCardComponent {
  private readonly api = inject(TripAnalysisApiService);
  private readonly fleetFilter = inject(FleetFilterService);

  /** Sur quoi porte la carte. */
  readonly scope = input.required<DrivingScoreScope>();
  /** L'identifiant de l'entité (vehicleId / driverId / groupId). */
  readonly entityId = input.required<string>();
  /** Fenêtre en jours (défaut 90 : un score de conduite se lit sur la durée, jamais vide pour un véhicule actif). */
  readonly days = input<number>(90);

  protected readonly data = signal<DrivingScoreDetailDto | null>(null);
  protected readonly loading = signal(true);

  protected readonly GaugeIcon = Gauge;
  protected readonly TrophyIcon = Trophy;
  protected readonly UpIcon = TrendingUp;
  protected readonly DownIcon = TrendingDown;
  protected readonly ChevronIcon = ChevronRight;

  constructor() {
    // Recharge quand l'entité, le scope, OU la société sélectionnée (super-admin)
    // change — la cohorte (rang/moyenne) est bornée à cette société côté API.
    effect(() => {
      const id = this.entityId();
      const scope = this.scope();
      this.fleetFilter.selectedFleetId();
      if (id) void this.load(scope, id);
    });
  }

  protected medal(rank: number): string {
    return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
  }

  protected subject(): string {
    return this.scope() === 'driver' ? 'ce conducteur' : this.scope() === 'group' ? 'ce groupe' : 'ce véhicule';
  }

  protected readonly tier = computed<'great' | 'good' | 'mid' | 'low'>(() => {
    const s = this.data()?.row?.score ?? 0;
    return s >= 85 ? 'great' : s >= 70 ? 'good' : s >= 55 ? 'mid' : 'low';
  });

  protected readonly motivation = computed<string>(() => {
    const d = this.data();
    const r = d?.row;
    if (!d || !r) return '';
    const solo = d.total <= 1; // seul évalué : pas de « classement », on encourage sur la note brute.
    if (!solo && d.rank === 1) return '🏆 En tête du classement — quel exemple, continuez comme ça !';
    if (!solo && d.rank != null && d.rank <= 3 && d.total > 3) return '🎉 Sur le podium ! Excellente conduite.';
    if (!solo && d.vsOverall != null && d.vsOverall > 0) return '👍 Au-dessus de la moyenne de la flotte — bravo, gardez le cap.';
    if (r.score >= 85) return '🌟 Conduite exemplaire — continuez comme ça !';
    if (r.score >= 70) return '🙂 Bonne conduite. Un cran de plus et vous visez le haut du classement.';
    return '💡 Quelques trajets plus souples (anticiper, lever le pied) et la note remonte vite.';
  });

  private async load(scope: DrivingScoreScope, id: string): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await firstValueFrom(
        this.api.entityScore(scope, id, this.fromIso(), undefined, this.fleetFilter.selectedFleetId() ?? undefined),
      ));
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
