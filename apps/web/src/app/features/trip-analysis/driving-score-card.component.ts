import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Gauge, Trophy, TrendingUp, TrendingDown, ChevronRight, Unplug } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { DrivingScoreDetailDto, DrivingScoreScope } from '@vizyo/tracky-shared';
import { formatSilenceLabel, isVehicleDormant } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { RealtimeService } from '../../core/services/realtime.service';

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
                <!-- DORMANCE — un véhicule muet depuis 89 jours n'a plus sa place dans une
                     compétition qui se joue sur la période courante : son rang serait figé sur
                     des trajets d'il y a trois mois, et il pousserait mécaniquement les autres
                     d'un cran. On retire le RANG, pas la NOTE (l'historique reste vrai). -->
                @if (d.rank != null && d.total > 1 && !isDormant()) {
                  <span class="dsc-rank" [class.dsc-rank--podium]="d.rank <= 3">{{ medal(d.rank) }} {{ d.rank }}<sup>{{ d.rank === 1 ? 'er' : 'e' }}</sup> / {{ d.total }}</span>
                }
              </div>
              @if (!isDormant() && d.total > 1 && d.vsOverall != null && d.overallScore != null) {
                <!-- Même raison : comparer une note figée à une moyenne qui, elle, continue de
                     bouger produit un écart qui ne veut plus rien dire. -->
                <div class="dsc-vs" [class.up]="d.vsOverall >= 0" [class.down]="d.vsOverall < 0">
                  <lucide-icon [img]="d.vsOverall >= 0 ? UpIcon : DownIcon" [size]="13"></lucide-icon>
                  {{ d.vsOverall >= 0 ? '+' : '' }}{{ d.vsOverall }} pts {{ d.vsOverall >= 0 ? 'au-dessus' : 'en dessous' }} de la moyenne ({{ d.overallScore }})
                </div>
              }
            </div>
          </div>

          @if (isDormant()) {
            <!-- À la place du message motivant (« 🏆 En tête du classement ! » sur un véhicule
                 disparu depuis trois mois serait grotesque) : le FAIT, daté. -->
            <p class="dsc-dormant">
              <lucide-icon [img]="DormantIcon" [size]="14"></lucide-icon>
              <span>
                Boîtier muet depuis {{ silenceLabel() ?? 'plus d\\'une semaine' }} — plus de rang ni de
                comparaison à la moyenne tant qu'il n'a pas réémis. La note ci-dessus porte sur ses
                derniers trajets connus. Rien à réactiver : tout revient dès la première trame reçue.
              </span>
            </p>
          } @else {
            <p class="dsc-motiv" [attr.data-tier]="tier()">{{ motivation() }}</p>
          }

          <div class="dsc-stats">
            <span>{{ r.tripCount }} trajet{{ r.tripCount > 1 ? 's' : '' }}</span>
            <span>{{ r.distanceKm | number:'1.0-0' }} km</span>
            @if (r.speedingTrips > 0) { <span class="dsc-warn">{{ r.speedingTrips }} avec excès</span> }
            @if (r.harshCount > 0) { <span>{{ r.harshCount }} à-coup{{ r.harshCount > 1 ? 's' : '' }}</span> }
          </div>

          <p class="dsc-help">La note ({{ '0 à 100' }}) résume la qualité de conduite de {{ subject() }} : elle monte quand il y a moins d'excès de vitesse, d'à-coups et de ralenti.@if (!isDormant()) { Objectif : viser le haut du classement ! }</p>
        } @else {
          <div class="dsc-empty">
            <lucide-icon [img]="isDormant() ? DormantIcon : GaugeIcon" [size]="30" class="opacity-30"></lucide-icon>
            @if (isDormant()) {
              <!-- « Le score apparaîtra dès qu'un trajet est analysé » ferait attendre pour rien
                   sur un boîtier muet depuis 89 jours : aucun trajet n'arrivera. On dit pourquoi. -->
              <p>Aucun trajet — boîtier muet depuis {{ silenceLabel() ?? 'plus d\\'une semaine' }}</p>
              <span>Tant que le boîtier n'émet pas, aucun trajet n'est enregistré, donc pas de score ni de classement. Rien à réactiver : la première trame reçue suffit.</span>
            } @else {
              <p>Pas encore de trajet analysé</p>
              <span>Le score de {{ subject() }} apparaîtra ici dès qu'un trajet est analysé (bouton « Analyser » dans les trajets).</span>
            }
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
    /* DORMANCE — ambre brûlé #d97706, même teinte que le badge « Dormant » du reste de l'app
       (délibérément plus soutenu que l'ambre « Hors ligne » : ce n'est pas la même urgence). */
    .dsc-dormant { margin: 0; display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.45; font-weight: 600; padding: 9px 12px; border-radius: 10px; background: color-mix(in srgb, #d97706 12%, transparent); color: #d97706; }
    .dsc-dormant lucide-icon { flex-shrink: 0; margin-top: 1px; }
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
  private readonly realtime = inject(RealtimeService);

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
  /** Même icône que le badge « Dormant » de l'app — un seul symbole pour un seul état. */
  protected readonly DormantIcon = Unplug;

  /**
   * DORMANCE du véhicule noté — lue dans le snapshot temps réel DÉJÀ en mémoire (aucun appel
   * réseau ajouté). On ne passe pas par une entrée du composant : cette carte est instanciée
   * depuis plusieurs écrans (onglet Rapports d'un véhicule, tiroir conducteur) et exiger d'eux
   * qu'ils transportent `lastSeenAt` aurait laissé le cas non traité partout où on l'oublie.
   *
   * Seuil COUNTING (7 j) par défaut : on parle ici de CLASSEMENT et de comparaison, c'est-à-dire
   * de comptage — jamais d'une commande envoyée au boîtier (celles-là restent à 72 h).
   *
   * `scope !== 'vehicle'` → jamais dormant : un conducteur ou un groupe ne se tait pas, c'est un
   * boîtier qui se tait. Snapshot pas encore hydraté → pas dormant non plus : on n'invente pas un
   * état à partir d'une absence de donnée, on reste sur l'affichage habituel.
   */
  private readonly dormancy = computed<{ dormant: boolean; silence: string | null }>(() => {
    if (this.scope() !== 'vehicle') return { dormant: false, silence: null };
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === this.entityId());
    if (!snap) return { dormant: false, silence: null };
    const dormant = isVehicleDormant({ trackerId: snap.trackerId, lastSeenAt: snap.lastSeenAt });
    return { dormant, silence: dormant ? formatSilenceLabel(snap.lastSeenAt) : null };
  });

  protected readonly isDormant = computed(() => this.dormancy().dormant);
  /** « 89 j » — l'ancienneté qui remplace le rang et la comparaison. */
  protected readonly silenceLabel = computed(() => this.dormancy().silence);

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
    // Garde de sûreté doublant le `@if` du template : trois des six phrases ci-dessous
    // s'appuient sur le rang ou la moyenne. Si un jour quelqu'un rebranche ce texte sans
    // regarder, « 🏆 En tête du classement » ne doit pas ressortir sur un véhicule disparu.
    if (this.isDormant()) return '';
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
