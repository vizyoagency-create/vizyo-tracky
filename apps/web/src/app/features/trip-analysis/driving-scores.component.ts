import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { PlanUpsellComponent } from '../../shared/ui/plan-upsell/plan-upsell.component';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, ChevronLeft, Gauge, Car, UserRound, Layers, RefreshCw, AlertTriangle, TrendingUp, Info, Trophy, Users } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { partLibelle } from '@vizyo/tracky-shared';
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
          <!-- « Conducteur, sinon groupe » : la seule portée qui répond à « qui conduit
               comment ? » quand les conducteurs ne sont renseignés que sur une partie du
               parc — c'est-à-dire, mesuré le 2026-09-05, sur toutes les sociétés. -->
          <button type="button" (click)="setScope('attribution')" [class.on]="scope() === 'attribution'"><lucide-icon [img]="UsersIcon" [size]="14"></lucide-icon> Conducteur ou groupe</button>
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
            <span class="ds-podium-cap"><lucide-icon [img]="TrophyIcon" [size]="13"></lucide-icon> Podium — top 3 des {{ scopeNounPluriel() }}</span>
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

        <!-- ══ CE QUI N'EST IMPUTÉ À PERSONNE ══════════════════════════════════════════
             Compté, jamais noté — et rendu QUEL QUE SOIT l'état du classement. Une première
             version ne l'affichait que si le classement était vide : chez cdef31, 17 groupes
             notés auraient masqué les trajets hors de toute imputation, et un gestionnaire
             aurait cru lire une image complète. -->
        @if (d.unattributed; as na) {
          @if (na.totalTripCount > 0) {
            <div class="ds-non-attribue" role="status">
              <lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon>
              <div>
                <strong>{{ na.totalTripCount | number }} trajet{{ na.totalTripCount > 1 ? 's' : '' }}</strong>
                sur {{ na.periodTripCount | number }} ({{ partLibelle(na.totalTripCount, na.periodTripCount) }},
                {{ na.distanceKm | number:'1.0-0' }} km) n'{{ na.totalTripCount > 1 ? 'ont' : 'a' }} <strong>ni conducteur, ni groupe</strong> :
                {{ na.totalTripCount > 1 ? 'ils ne peuvent être notés' : 'il ne peut être noté' }} pour personne.
                <a routerLink="/vehicles">Renseignez un conducteur ou un groupe</a> sur ces véhicules
                pour que leurs trajets comptent.
              </div>
            </div>
          }
        }

        @if (d.rows.length === 0) {
          <div class="ds-empty">
            <lucide-icon [img]="GaugeIcon" [size]="44" class="opacity-30"></lucide-icon>
            <p>Aucun {{ scopeNoun() }} noté sur la période.</p>
            @if (nonAttribueDomine(d.unattributed)) {
              <span>La plupart des trajets de la période ne sont imputés à personne : les analyser n'y changera rien tant qu'un conducteur ou un groupe n'est pas renseigné.</span>
            } @else {
              <span>Analysez des trajets (bouton « Analyser » dans les rapports ou la fiche véhicule) pour alimenter les scores.</span>
            }
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
                    <!--
                      ⚠️ « N analysés sur M » et non « N trajets ». L'écran n'affichait que
                      le nombre d'analyses : on lisait « 1 trajet » pour un véhicule qui en
                      avait fait 75, dont un seul analysé. Impossible de voir que la note
                      portait sur 1,3 % de son activité — et il arrivait 2e du classement.
                    -->
                    <span [title]="analysisRateTitle(r)">
                      {{ r.tripCount }} analysé{{ r.tripCount > 1 ? 's' : '' }}
                      @if (r.totalTripCount > r.tripCount) {
                        <em class="ds-rate">sur {{ r.totalTripCount }} ({{ analysisRate(r) }} %)</em>
                      }
                    </span>
                    <!--
                      ⚠️ SUR COMBIEN D'ANALYSES ANCIENNES CETTE NOTE EST-ELLE CALCULÉE ?
                      Les écrans ne comptent plus les faux excès de ces analyses, mais la NOTE,
                      elle, est toujours calculée dessus : un conducteur pouvait être classé sur
                      40 analyses dont 35 écrites sous l'ancienne règle, et rien ne le disait.
                      C'est une RÉSERVE sur ce que la note mesure, pas une erreur — d'où le ton
                      neutre et la place discrète, à côté du taux d'analyse.
                    -->
                    @if (r.oldFormulaTripCount > 0) {
                      <span class="ds-ancien" [title]="ancienneteTitle(r)">{{ ancienneteLabel(r) }}</span>
                    }
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

          <!--
            ⚠️ ÉCARTÉS DU CLASSEMENT, PAS CACHÉS.
            Avant ce filtre, un véhicule noté sur UN trajet analysé (sur 75 parcourus)
            arrivait 2e de la flotte avec 100/100 : le podium récompensait ceux qui
            étaient le MOINS analysés. Leurs notes restent visibles ici — elles ne
            faussent simplement plus le classement ni la moyenne de flotte.
          -->
          @if (d.insufficientCount > 0) {
            <details class="ds-insuf">
              <summary>
                {{ d.insufficientCount }} non classé{{ d.insufficientCount > 1 ? 's' : '' }} —
                moins de {{ d.minAnalysesForRanking }} trajets analysés
              </summary>
              <p class="ds-insuf-why">
                Une note calculée sur quelques trajets ne dit rien de la conduite : elle dit
                seulement que peu de trajets ont été analysés. Ces lignes sont donc affichées
                à part, sans peser sur le classement ni sur la moyenne de la flotte.
              </p>
              @for (r of d.insufficientRows; track r.id) {
                <div class="ds-insuf-row">
                  <span class="ds-insuf-label">{{ r.label }}</span>
                  @if (scope() === 'attribution' && r.sublabel) { <span class="ds-insuf-sub">{{ r.sublabel }}</span> }
                  <span class="ds-insuf-score">{{ r.score }}/100</span>
                  <span class="ds-insuf-meta">
                    {{ r.tripCount }} analysé{{ r.tripCount > 1 ? 's' : '' }}
                    @if (r.totalTripCount > r.tripCount) { sur {{ r.totalTripCount }} }
                  </span>
                  <!-- Même réserve que dans le classement : ces lignes affichent déjà un
                       compte d'analyses, donc la même question se pose sur leur note.
                       ⚠️ SŒUR du compte, et non imbriquée dedans : à 375 px, mesuré sur banc,
                       la phrase allongeait tellement la métadonnée qu'elle coupait la plaque
                       en deux (« HD-292- » / « SH »). En enfant direct de la ligne, elle passe
                       à la ligne suivante au lieu d'écraser le libellé. -->
                  @if (r.oldFormulaTripCount > 0) {
                    <span class="ds-ancien" [title]="ancienneteTitle(r)">{{ ancienneteLabel(r) }}</span>
                  }
                </div>
              }
            </details>
          }
        }
      } @else if (loading()) {
        <div class="ds-loading"><span class="ds-spinner"></span></div>
      }
    </div>
  `,
  styles: [`
    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : retour, actualisation et bascules de période sous le seuil. */
    @media (max-width: 768px) {
      .ds-back, .ds-refresh, .ds-seg button, .ds-toggle, button.on { min-width: 44px; min-height: 44px }
    }
    .ds { max-width: 900px; margin: 0 auto; padding: 16px 16px 40px; display: flex; flex-direction: column; gap: 14px; }
    .ds-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); width: fit-content; }
    .ds-back:hover { color: var(--texte-succes); }
    .ds-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .ds-title { display: flex; gap: 12px; align-items: center; }
    /* Pictogramme sur son propre lavis a 14 % : le vert de marque tombe a ~2,9:1
       en clair. --texte-succes tient dans les deux themes. */
    .ds-ico { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, transparent); color: var(--texte-succes); flex-shrink: 0; }
    .ds-head h1 { margin: 0; font-size: 20px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em; }
    .ds-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--fg-tertiary); }
    .ds-refresh { width: 36px; height: 36px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-secondary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); flex-shrink: 0; }
    .ds-spin { animation: ds-rot 1s linear infinite; } @keyframes ds-rot { to { transform: rotate(360deg); } }
    .ds-help { display: flex; gap: 8px; align-items: flex-start; padding: 10px 13px; border-radius: 11px; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 7%, var(--bg-secondary)); border: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 20%, transparent); font-size: 12px; line-height: 1.5; color: var(--fg-secondary); }
    .ds-help lucide-icon { color: var(--tracky-light, #10E0A0); flex-shrink: 0; margin-top: 1px; }
    .ds-rate { font-style: normal; color: var(--fg-tertiary); }
    /* Réserve « dont N analyses anciennes » : même gris que le reste des métadonnées, jamais
       une couleur d'alerte. Ce n'est pas un défaut de la ligne, c'est une précision sur ce que
       sa note mesure. Le souligné pointillé signale l'info-bulle, seul endroit où la phrase
       complète tient. */
    .ds-ancien { color: var(--fg-tertiary); border-bottom: 1px dotted var(--border-subtle); cursor: help; }
    .ds-insuf { border: 1px solid var(--border-subtle); border-radius: 11px; background: var(--bg-secondary); padding: 10px 13px; font-size: 12.5px; }
    .ds-insuf summary { cursor: pointer; font-weight: 700; color: var(--fg-secondary); }
    .ds-insuf-why { margin: 8px 0 10px; color: var(--fg-tertiary); line-height: 1.5; }
    /* Retour à la ligne autorisé : sans lui, la réserve « dont N analyses anciennes » volait
       assez de place au libellé pour couper une plaque en deux à 375 px (mesuré sur banc). */
    .ds-insuf-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 6px 0; border-top: 1px solid var(--border-subtle); }
    .ds-insuf-label { font-weight: 700; color: var(--fg-primary); }
    .ds-insuf-sub { font-size: 11.5px; color: var(--fg-tertiary); }
    .ds-insuf-score { color: var(--fg-secondary); }
    .ds-insuf-meta { margin-left: auto; color: var(--fg-tertiary); }
    .ds-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    /* Quatre portées depuis le point 2 (2026-09-05) : sans retour à la ligne, la barre dépassait les 343 px utiles d un écran de 375 px. */
    .ds-seg { display: inline-flex; flex-wrap: wrap; max-width: 100%; gap: 4px; background: var(--bg-tertiary); padding: 4px; border-radius: 12px; }
    .ds-seg button { display: inline-flex; align-items: center; gap: 5px; padding: 7px 13px; border-radius: 9px; font-size: 12.5px; font-weight: 700; color: var(--fg-tertiary); }
    /* Convention du kit (styles.css) : l'etat actif prend --texte-succes, pas
       le vert de marque. Sur --bg-secondary clair : 3,43 -> 5,97:1.
       Le repli #10E0A0 saute au passage : --tracky-light est bien declaree, donc
       il ne servait jamais — mais un hexadecimal en repli gagne des que le nom
       de tete manque, et il aurait fige le theme sombre sur les deux themes. */
    .ds-seg button.on { background: var(--bg-secondary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
    .ds-seg--sm button { padding: 6px 11px; font-size: 12px; }
    .ds-alert { display: flex; align-items: center; gap: 8px; padding: 10px 13px; border-radius: 10px; background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--texte-alerte); font-size: 12.5px; }
    .ds-overall { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .ds-overall-txt { display: flex; flex-direction: column; }
    .ds-overall-n { font-size: 28px; font-weight: 800; color: var(--fg-primary); line-height: 1; }
    .ds-overall-n small { font-size: 14px; color: var(--fg-tertiary); font-weight: 600; }
    .ds-overall-l { font-size: 12px; color: var(--fg-tertiary); margin-top: 4px; }
    /* Note lettrée (couleur par grade). La lettre est un TEXTE : elle prend le
       jeton --texte-* de sa famille, jamais la couleur vive — le A en #10E0A0
       rendait 1,8:1 en theme clair sur sa propre teinte. Le lavis vient de la
       couleur de base du theme (verif:contraste, section « Notes de conduite »). */
    .ds-grade { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; font-size: 16px; font-weight: 800; flex-shrink: 0; }
    .ds-grade--lg { width: 52px; height: 52px; font-size: 26px; border-radius: 14px; }
    .ds-grade[data-grade="A"] { background: color-mix(in srgb, var(--tracky-light) 18%, transparent); color: var(--texte-succes); }
    .ds-grade[data-grade="B"] { background: color-mix(in srgb, var(--lime) 18%, transparent); color: var(--texte-lime); }
    .ds-grade[data-grade="C"] { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--texte-attente); }
    .ds-grade[data-grade="D"] { background: color-mix(in srgb, var(--orange) 18%, transparent); color: var(--texte-orange); }
    .ds-grade[data-grade="E"] { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--texte-alerte); }
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
    .ds-pod-score[data-grade="A"] { color: var(--texte-succes); } .ds-pod-score[data-grade="B"] { color: var(--texte-lime); }
    .ds-pod-score[data-grade="C"] { color: var(--texte-attente); } .ds-pod-score[data-grade="D"] { color: var(--texte-orange); } .ds-pod-score[data-grade="E"] { color: var(--texte-alerte); }
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
    .ds-bar-fill[data-grade="A"] { background: var(--tracky-light); } .ds-bar-fill[data-grade="B"] { background: var(--lime); }
    .ds-bar-fill[data-grade="C"] { background: var(--warning); } .ds-bar-fill[data-grade="D"] { background: var(--orange); } .ds-bar-fill[data-grade="E"] { background: var(--danger); }
    .ds-row-stats { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--fg-tertiary); }
    .ds-row-sub { font-weight: 600; }
    .ds-warn { color: var(--texte-alerte); font-weight: 700; }
    a.ds-warn-link { text-decoration: none; cursor: pointer; white-space: nowrap; }
    a.ds-warn-link:hover { text-decoration: underline; }
    .ds-non-attribue {
      display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; padding: 12px 14px;
      border-radius: 12px; font-size: 13px; line-height: 1.5; color: var(--fg-secondary);
      border: 1px solid color-mix(in srgb, var(--texte-attente) 35%, transparent);
      background: color-mix(in srgb, var(--texte-attente) 8%, transparent);
    }
    .ds-non-attribue lucide-icon { color: var(--texte-attente); flex-shrink: 0; margin-top: 2px; }
    .ds-non-attribue strong { color: var(--fg-primary); }
    .ds-non-attribue a { color: var(--texte-succes); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
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
  protected readonly UsersIcon = Users;
  protected readonly TrendIcon = TrendingUp;
  protected readonly InfoIcon = Info;
  protected readonly TrophyIcon = Trophy;

  protected periodLabel(): string {
    return this.period() === '7d' ? '7 derniers jours' : this.period() === '90d' ? '90 derniers jours' : '30 derniers jours';
  }
  protected scopeNoun(): string {
    return this.scope() === 'driver' ? 'conducteur' : this.scope() === 'group' ? 'groupe' : this.scope() === 'attribution' ? 'conducteur ou groupe' : 'véhicule';
  }
  /** Pluriel du titre du podium — « des conducteur ou groupes » n'est pas du français. */
  protected scopeNounPluriel(): string {
    return this.scope() === 'driver' ? 'conducteurs' : this.scope() === 'group' ? 'groupes' : this.scope() === 'attribution' ? 'conducteurs et groupes' : 'véhicules';
  }
  /**
   * Part en pourcentage, sans jamais contredire les nombres qu'elle accompagne : « 1 sur 1 000 »
   * n'est pas « 0 % » et « 999 sur 1 000 » n'est pas « 100 % » — l'arrondi ne peut affirmer un
   * extrême que si les nombres l'atteignent vraiment. Dénominateur nul : « 0 % ».
   *
   * ⚠️ LA RÈGLE VIT DANS LE CONTRAT PARTAGÉ, plus ici : cet écran, la page Rapports et le PDF
   * affichent la même mention sur les mêmes trajets, ils ne peuvent pas arrondir autrement.
   *
   * ⚠️ Réexposée en propriété de classe parce que le GABARIT l'appelle : une fonction de module
   * n'est pas atteignable depuis un template Angular.
   */
  protected readonly partLibelle = partLibelle;
  /**
   * Le trou de données DOMINE-t-il la période (au moins un trajet réel sur deux) ? C'est la
   * seule situation où l'état vide peut dire « personne » : un seul trajet orphelin au milieu
   * d'une flotte imputée mais sous le seuil de classement appelle le conseil habituel — analyser.
   */
  protected nonAttribueDomine(na: DrivingScoresDto['unattributed']): boolean {
    return !!na && na.periodTripCount > 0 && na.totalTripCount * 2 >= na.periodTripCount;
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

  /**
   * Part des trajets réellement analysés, en pourcentage entier.
   *
   * C'est ce que vaut la note : à 1 %, elle décrit un trajet sur cent, pas une conduite.
   */
  protected analysisRate(r: { tripCount: number; totalTripCount: number }): number {
    if (!r.totalTripCount) return 0;
    return Math.round((r.tripCount / r.totalTripCount) * 100);
  }

  /** Info-bulle : dit explicitement sur quoi la note est calculée. */
  protected analysisRateTitle(r: { tripCount: number; totalTripCount: number }): string {
    if (r.totalTripCount <= r.tripCount) return 'Tous les trajets de la période sont analysés.';
    return (
      `Note calculée sur ${r.tripCount} trajet(s) analysé(s) parmi ${r.totalTripCount} ` +
      `parcouru(s), soit ${this.analysisRate(r)} % de l'activité de la période.`
    );
  }

  /**
   * Mention discrète, à côté du taux d'analyse : « dont N analyse(s) ancienne(s) ».
   *
   * ⚠️ Le libellé ne qualifie JAMAIS la note, seulement les analyses : « ancienne » dit d'où
   * vient la donnée, là où « faussée » aurait accusé le conducteur d'une note qu'il n'a pas
   * choisie. Le détail de ce que ça change tient dans l'info-bulle ci-dessous.
   */
  protected ancienneteLabel(r: DrivingScoreRowDto): string {
    const n = r.oldFormulaTripCount;
    return `dont ${n} analyse${n > 1 ? 's' : ''} ancienne${n > 1 ? 's' : ''}`;
  }

  /**
   * Info-bulle de la réserve : une phrase, qui dit ce que ça change et pourquoi ça se résorbe.
   *
   * Les trois choses qu'un gestionnaire doit savoir, et rien d'autre : ces analyses ont été
   * écrites avant la règle actuelle, leur DÉTAIL peut contenir de faux excès (des dépassements
   * bâtis sur un seul point GPS), la note est calculée dessus — et le rattrapage les reprendra
   * tant que les positions du trajet existent, donc le nombre baissera tout seul.
   *
   * ⚠️ « faux » qualifie le détail stocké, jamais la note : la note reste la meilleure mesure
   * disponible, et l'écran ne doit pas laisser croire qu'un conducteur est mal noté à tort.
   */
  protected ancienneteTitle(r: DrivingScoreRowDto): string {
    const n = r.oldFormulaTripCount;
    const pluriel = n > 1;
    return (
      `${n} des ${r.tripCount} analyses qui font cette note ${pluriel ? 'ont été écrites' : 'a été écrite'} ` +
      `avant la règle actuelle : ${pluriel ? 'leur' : 'son'} détail peut contenir de faux excès, ` +
      `la note en dépend, et ${pluriel ? 'elles seront reprises' : 'elle sera reprise'} par le ` +
      `rattrapage tant que les positions du trajet existent.`
    );
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

  /**
   * Numéro de la dernière demande partie. ⚠️ Deux bascules rapides (Véhicules → Conducteur ou
   * groupe) font partir deux requêtes ; si la première revient APRÈS la seconde, elle écrasait
   * l'écran avec un classement d'une autre portée — et l'encart « non attribué » avec.
   */
  private requete = 0;

  protected async reload(): Promise<void> {
    const jeton = ++this.requete;
    this.loading.set(true);
    this.error.set(null);
    try {
      const d = await firstValueFrom(
        this.api.scores(this.scope(), this.fromIso(), undefined, this.fleetFilter.selectedFleetId() ?? undefined),
      );
      if (jeton !== this.requete) return; // une demande plus récente est partie : son résultat prime
      this.data.set(d);
    } catch (e) {
      if (jeton !== this.requete) return;
      swallow('driving-scores:reload', e);
      this.error.set(apiErrorMessage(e, 'Chargement des scores impossible.'));
    } finally {
      if (jeton === this.requete) this.loading.set(false);
    }
  }
}
