import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, Leaf, Gauge, Fuel, Sparkles, Loader, AlertTriangle, ShieldCheck, FileText, X, MapPin, Lock,
  Clock, RefreshCw, ArrowRight, OctagonX, Info,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { AiProviderId, TripAnalysisDto } from '@vizyo/tracky-shared';
import { excesDuTrajet, analyseAvantRegleActuelle, analyseHorsDePortee } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { AiStatusService } from '../../core/services/ai-status.service';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { apiErrorMessage } from '../../core/error/api-error';

/**
 * Note lettrée du score de conduite — MÊMES paliers que le classement (/scores,
 * `driving-score.service.ts#grade`). Trois échelles cohabitaient (éco 80/50, fiabilité 75/45,
 * notes 85/70/55) avec les mêmes trois couleurs : « Éco 74 » ambre à côté d'un « 82 » bleu.
 */
export function gradeOf(score: number): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

/**
 * Bloc « Analyse » d'un trajet — RÉUTILISABLE (cartes Rapports, cellule du tableau, fiche
 * véhicule, replay).
 *
 * ── CE QUI A CHANGÉ (2026-09-02) ─────────────────────────────────────────────────────
 *
 * Avant : une rangée plate de huit à dix pastilles de même poids (Éco 74 · 3 excès +2 ·
 * 2 arrêts · 3 à-coups · ⏱ ralenti 3 min · 9,5 L · 82 · [Récit IA] · [✦]), sans hiérarchie
 * ni état, dont un « 82 » sans libellé et une étincelle qui RECALCULAIT les chiffres à côté
 * d'un bouton « Récit IA » qui ne faisait que les LIRE — même style, même icône. Le
 * propriétaire ne voyait pas la différence ; personne ne pouvait.
 *
 * Maintenant, trois lignes hiérarchisées et UNE action :
 *   L1  note de conduite (A-E, comme le classement) + le seul badge d'alerte (excès) ;
 *   L2  faits secondaires en texte : arrêts, à-coups, ralenti, passage en station ;
 *   L3  estimations et fiabilité, en gris : « ≈ 9,5 L · ≈ 25 kg CO₂ · fiabilité GPS 82 » ;
 *   L4  extrait du récit (deux lignes) quand il existe ;
 *   →   « Lire le récit » (plein) ou « Voir l'analyse » (discret).
 *
 * Six états : pas analysé · analysé sans récit (récit en préparation) · récit disponible ·
 * option IA coupée sans récit · option coupée avec récit (le récit appartient au client) ·
 * analyse vide (aucune position exploitable).
 *
 * Le recalcul des chiffres devient une action SECONDAIRE, nommée, dans la modale, réservée
 * aux gestionnaires. Aucune génération de récit côté API : les récits sont rédigés chaque
 * nuit par l'agent sur poste (coût zéro) — proposer un bouton « Générer » ici reviendrait
 * à facturer un appel modèle pour un travail déjà planifié.
 */
@Component({
  selector: 'app-trip-analysis-badges',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DecimalPipe, RouterLink],
  template: `
    @if (current(); as a) {
      @if (isEmptyAnalysis()) {
        <!-- ÉTAT 6 — analyse vide : aucune position pour un trajet qui a roulé. Un « Éco 100 »
             vert s'affichait ici sur 157 km sans une seule mesure. -->
        <div class="tab" [class.tab--row]="layout() === 'row'" role="group" aria-label="Analyse du trajet">
          <p class="tab-empty-line">
            <lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon>
            Aucune position exploitable pour ce trajet
          </p>
          @if (canRecompute()) {
            <button type="button" class="tab-btn tab-btn--ghost" (click)="runAnalyze()" [disabled]="busy()">
              @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="tab-spin"></lucide-icon> Analyse… }
              @else { <lucide-icon [img]="RefreshIcon" [size]="13"></lucide-icon> Réanalyser }
            </button>
          }
        </div>
      } @else {
        <div class="tab" [class.tab--row]="layout() === 'row'" role="group" aria-label="Analyse du trajet">
          <!-- L1 — note + le seul badge d'alerte -->
          <div class="tab-l1">
            @if (a.ecoScore !== null) {
              <span class="tab-grade" [attr.data-grade]="grade()" [attr.aria-label]="'Conduite notée ' + grade() + ', ' + a.ecoScore + ' sur 100'">
                <lucide-icon [img]="LeafIcon" [size]="12"></lucide-icon>
                <b>{{ grade() }}</b> Conduite {{ a.ecoScore }}
              </span>
            } @else {
              <span class="tab-grade" title="Aucune position exploitable : la note n'est pas calculable pour ce trajet.">
                <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon> Note non calculable
              </span>
            }
            @if (nbExces() > 0) {
              <span class="tab-alert" [attr.aria-label]="speedingTitle(a)">
                <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                {{ nbExces() }} excès
                @if (a.limitsKnown && a.maxOverKmh > 0) { <span class="tab-alert-sub">· +{{ a.maxOverKmh | number:'1.0-0' }} km/h</span> }
                @else if (!a.limitsKnown) { <span class="tab-alert-sub">· limites inconnues</span> }
              </span>
            }
          </div>

          <!-- L2 — faits secondaires, en texte -->
          @if (facts().length > 0) {
            <p class="tab-l2">{{ facts().join(' · ') }}</p>
          }

          <!-- L3 — estimations et fiabilité, en gris -->
          @if (estimates().length > 0 && layout() !== 'row') {
            <p class="tab-l3">{{ estimates().join(' · ') }}</p>
          }

          <!-- L4 — extrait du récit -->
          @if (a.narrative && layout() !== 'row') {
            <p class="tab-l4">« {{ a.narrative }} »</p>
          }

          <!-- L'ACTION, une seule -->
          <div class="tab-action">
            @if (a.narrative) {
              <button type="button" class="tab-btn tab-btn--primary" (click)="openDetail()">
                <lucide-icon [img]="FileIcon" [size]="14"></lucide-icon> Lire le récit
                <lucide-icon [img]="ArrowIcon" [size]="14" class="tab-btn-arrow"></lucide-icon>
              </button>
            } @else {
              <button type="button" class="tab-btn tab-btn--ghost" (click)="openDetail()">
                Voir l'analyse
                <lucide-icon [img]="ArrowIcon" [size]="13" class="tab-btn-arrow"></lucide-icon>
              </button>
              @if (aiEnabled()) {
                <span class="tab-pending"><lucide-icon [img]="ClockIcon" [size]="12"></lucide-icon> Récit en préparation</span>
              } @else if (canConfigureAi()) {
                <a routerLink="/settings" class="tab-locked"><lucide-icon [img]="LockIcon" [size]="11"></lucide-icon> Récit IA — option désactivée</a>
              }
            }
          </div>
        </div>
      }
    } @else {
      <!-- ÉTAT 1 — pas encore analysé : l'analyse tourne chaque heure côté serveur. -->
      <div class="tab tab--todo" [class.tab--row]="layout() === 'row'" role="group" aria-label="Analyse du trajet">
        <p class="tab-empty-line">
          <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
          Pas encore analysé · analyse automatique chaque heure
        </p>
        @if (canRecompute()) {
          <button type="button" class="tab-btn tab-btn--ghost" (click)="runAnalyze()" [disabled]="busy()">
            @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="tab-spin"></lucide-icon> Analyse… }
            @else { Analyser maintenant }
          </button>
        }
      </div>
    }
    @if (error(); as e) { <span class="tab-err">{{ e }}</span> }

    <!-- ── Détail : récit, conseils, chiffres expliqués, recalcul ── -->
    @if (detailOpen()) {
      <div class="taid-overlay" (click)="closeDetail()">
        <div class="taid-card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-label="Analyse du trajet">
          <header class="taid-head">
            <h3><lucide-icon [img]="SparklesIcon" [size]="16"></lucide-icon> Analyse du trajet</h3>
            <button type="button" class="taid-x" (click)="closeDetail()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </header>
          <div class="taid-body">
            @if (current(); as a) {
              <!-- ══ CE QUE LES CHIFFRES NE COUVRENT PAS (A09) ══════════════════════════
                   Au-delà du plafond de lecture, seules les PREMIÈRES positions sont
                   analysées : sur un trajet de douze heures, les chiffres décrivent le
                   début et sont présentés comme s'ils décrivaient le tout. Une analyse
                   partielle affichée comme complète est pire qu'une analyse absente — ses
                   chiffres sont plausibles, cohérents entre eux, et faux. -->
              <!-- ══ CHIFFRES D'AVANT LA RÈGLE ACTUELLE ═══════════════════════════════
                   Cette analyse a été écrite avant le 4 septembre 2026 : elle n'a ni le taux
                   de couverture des limites, ni la réserve sur la vitesse annoncée, et son
                   détail peut contenir de FAUX excès — des dépassements bâtis sur un seul
                   point. L'écran ne les COMPTE plus (il relit le détail avec la règle
                   actuelle), mais les chiffres restent ceux d'hier, et rien ne le disait.

                   ⚠️ Deux cas, deux phrases : celle qui attend son tour, et celle qui ne
                   l'aura jamais. Les confondre ferait attendre une correction qui n'arrivera
                   pas — c'est la faute déjà payée sur les trajets figés. -->
              @if (analyseAncienne()) {
                <p class="taid-ancienne">
                  <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
                  @if (horsDePortee()) {
                    Chiffres calculés avant le 4 septembre 2026, et <b>ils ne seront pas recalculés</b> :
                    les positions GPS de ce trajet ne sont plus conservées. Le nombre d'excès affiché
                    ci-dessus applique bien la règle actuelle ; le détail enregistré, lui, reste celui d'hier.
                  } @else {
                    Chiffres calculés avant le 4 septembre 2026. Ce trajet est dans la file de
                    recalcul automatique ; d'ici là, le nombre d'excès affiché applique déjà la
                    règle actuelle, mais le détail enregistré reste celui d'hier.
                  }
                </p>
              }
              @if (a.detail.partielle; as pa) {
                <p class="taid-partielle">
                  <lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon>
                  Analyse PARTIELLE : ce trajet compte plus de {{ pa.plafond }} positions, et seules
                  les {{ pa.positionsLues }} premières ont été lues. Les chiffres ci-dessous décrivent
                  le DÉBUT du trajet, pas son ensemble.
                </p>
              }
              @if (a.narrative) {
                <section class="taid-sec taid-sec--recit">
                  <h4>Récit @if (a.provider) { <span class="taid-prov">par {{ providerLabel(a.provider) }}</span> }</h4>
                  @if (recitPerime()) {
                    <p class="taid-perime">
                      <lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon>
                      Ce récit a été écrit avant le dernier recalcul des chiffres. Il décrit le trajet
                      tel qu'il était analysé auparavant.
                    </p>
                  }
                  <p>{{ a.narrative }}</p>
                </section>
                @if (a.advice) {
                  <section class="taid-sec taid-sec--advice">
                    <h4><lucide-icon [img]="LeafIcon" [size]="13"></lucide-icon> Conseils d'éco-conduite</h4>
                    @for (line of adviceLines(); track $index) { <p>{{ line }}</p> }
                  </section>
                }
              } @else if (isEmptyAnalysis()) {
                <p class="taid-empty">Aucune position GPS exploitable n'a été trouvée pour ce trajet : les chiffres ci-dessous ne sont pas significatifs.</p>
              } @else if (aiEnabled()) {
                <p class="taid-empty">
                  <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
                  Récit en préparation — il est rédigé automatiquement chaque nuit à partir des chiffres ci-dessous.
                </p>
              } @else {
                <p class="taid-empty">
                  <lucide-icon [img]="LockIcon" [size]="13"></lucide-icon>
                  Le récit rédigé de ce trajet fait partie de l'option IA, désactivée pour votre société.
                </p>
              }

              <!-- Chiffres expliqués : ce que les badges disaient en infobulle, invisible au doigt. -->
              <section class="taid-sec">
                <h4><lucide-icon [img]="GaugeIcon" [size]="13"></lucide-icon> Chiffres clés</h4>
                <dl class="taid-kv">
                  <div>
                    <dt>Conduite</dt>
                    <dd>
                      @if (a.ecoScore !== null) {
                        <b>{{ grade() }}</b> · {{ a.ecoScore }}/100
                        @if (penalites().length > 0) {
                          <small>Points retirés :</small>
                          <ul class="taid-note">
                            @for (p of penalites(); track p.code) {
                              <li>−{{ p.points }} · {{ p.phrase }}</li>
                            }
                          </ul>
                        } @else {
                          <small>aucun point retiré sur ce trajet</small>
                        }
                        @if (plafondNote(); as pl) { <small class="taid-note-plafond">{{ pl }}</small> }
                      } @else {
                        Non calculable <small>aucune position exploitable : une note inventée vaudrait moins que pas de note</small>
                      }
                    </dd>
                  </div>
                  <div><dt>Excès de vitesse</dt><dd>{{ nbExces() }} <small>@if (!a.limitsKnown) { limites légales non résolues sur ce trajet } @else if (nbExces() === 0) { aucun dépassement de la limite légale relevé } @else { au-dessus de la limite légale — plus fort dépassement +{{ a.maxOverKmh | number:'1.0-0' }} km/h }</small></dd></div>
                  <div><dt>Arrêts</dt><dd>{{ a.stopCount }} <small>arrêts d'au moins 4 minutes</small></dd></div>
                  <div><dt>À-coups</dt><dd>{{ a.harshAccel + a.harshBrake }} <small>{{ a.harshAccel }} accélérations, {{ a.harshBrake }} freinages brusques</small></dd></div>
                  <div><dt>Ralenti</dt><dd>{{ minutes(a.idleSec) }} min <small>moteur tournant à l'arrêt</small></dd></div>
                  @if (a.fuelLiters != null) {
                    <div><dt>Carburant</dt><dd>≈ {{ a.fuelLiters | number:'1.1-1' }} L @if (a.co2Kg != null) { · ≈ {{ a.co2Kg | number:'1.0-0' }} kg CO₂ }
                      <!-- ⚠️ La phrase disait « d'après la consommation du véhicule » MÊME quand
                           aucune consommation n'était renseignée sur la fiche : le calcul retombait
                           alors sur un défaut de type. Le client ne pouvait pas savoir que le
                           chiffre reposait sur une valeur qu'il n'avait jamais donnée — ni qu'il
                           pouvait l'améliorer en trente secondes. -->
                      @if (a.detail.carburant; as c) {
                        @if (c.source === 'vehicule') {
                          <small>estimation d'après la consommation renseignée sur la fiche du véhicule ({{ c.l100km | number:'1.1-1' }} L/100 km), pas une mesure</small>
                        } @else {
                          <small>estimation d'après une valeur PAR DÉFAUT ({{ c.l100km | number:'1.1-1' }} L/100 km, déduite du type de véhicule) : aucune consommation n'est renseignée sur la fiche.
                            <a [routerLink]="['/vehicles', a.vehicleId]" class="lien-conso">La renseigner</a> rendra ce chiffre juste.</small>
                        }
                      } @else {
                        <small>estimation d'après la consommation du véhicule, pas une mesure</small>
                      }
                    </dd></div>
                  }
                  @if (pointeNonCorroboree(); as pointe) {
                    <div><dt>Pointe écartée</dt><dd>{{ pointe }} km/h <small>annoncés par le boîtier, mais la distance réellement parcourue ne les soutient pas. Cette valeur n'est retenue ni comme vitesse maximale, ni comme excès.</small></dd></div>
                  }
                  <!-- ⚠️ Comptés, jamais effacés : c'est la mesure de ce qu'on a refusé de
                       croire. Depuis le 4 septembre, l'analyse écarte les mêmes bonds de
                       position que le trajet — auparavant elle les comptait dans sa distance
                       là où le trajet les rejetait, et les deux chiffres divergeaient. -->
                  @if (a.detail.vitesse?.pointsInvraisemblables; as bonds) {
                    <div><dt>Positions écartées</dt><dd>{{ bonds }} <small>bond{{ bonds > 1 ? 's' : '' }} de position que le temps écoulé ne permet pas — écarté{{ bonds > 1 ? 's' : '' }} du calcul, comme le fait déjà le trajet.</small></dd></div>
                  }
                  <div><dt>Fiabilité GPS</dt><dd>@if (a.trustScore != null) { {{ a.trustScore }}/100 } @else { {{ (a.gpsValidRatio * 100) | number:'1.0-0' }} % de mesures valides } <small>{{ a.gpsPoints }} positions@if (a.gpsLostCount > 0) { , {{ a.gpsLostCount }} perte(s) de signal }</small></dd></div>
                </dl>
              </section>

              @if (fuelStops().length) {
                <section class="taid-sec">
                  <h4><lucide-icon [img]="PumpIcon" [size]="13"></lucide-icon> Passages en station-service</h4>
                  <ul class="taid-fuel">
                    @for (fs of fuelStops(); track fs.stationId + fs.arrivedAt) {
                      <li class="taid-fuel-row">
                        <span class="taid-fuel-name">{{ fs.brand || 'Station-service' }}</span>
                        <span class="taid-fuel-where">{{ fuelWhere(fs) }}</span>
                        <span class="taid-fuel-price">
                          @if (fs.unitPriceEur != null) { {{ fuelTypeLabel(fs.fuelType) }} · <strong>{{ fs.unitPriceEur | number:'1.3-3' }} €/L</strong> }
                          @else { <span class="taid-fuel-noprice">prix indisponible</span> }
                        </span>
                        <span class="taid-fuel-dur">arrêt {{ minutes(fs.durationSec) }} min</span>
                      </li>
                    }
                  </ul>
                  <p class="taid-fuel-note">Prix relevé au moment du passage (prix officiels des carburants en France). Alimente le suivi des coûts dans les rapports.</p>
                </section>
              }

              @if (canRecompute()) {
                <div class="taid-actions">
                  <button type="button" class="taid-btn taid-btn--ghost" (click)="runAnalyze()" [disabled]="busy()">
                    @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="tab-spin"></lucide-icon> Recalcul… }
                    @else { <lucide-icon [img]="RefreshIcon" [size]="14"></lucide-icon> Recalculer les chiffres }
                  </button>
                  <span class="taid-actions-note">Relit les positions GPS et les limites de vitesse. Le récit n'est pas modifié.</span>
                </div>
              }
              @if (error(); as e) { <p class="taid-err">{{ e }}</p> }
            } @else {
              <!-- ══ LIEN PROFOND SANS ANALYSE EN MAIN ═══════════════════════════════════
                   Venu de /scores, ce composant reçoit un identifiant de trajet mais pas toujours
                   l'analyse. La modale ne s'ouvrait alors PAS DU TOUT : le lien semblait
                   mort, et l'utilisateur cliquait deux ou trois fois avant d'abandonner.
                   Elle s'ouvre désormais toujours, et dit laquelle des deux situations
                   elle est : on attend, ou il n'y a rien à attendre. -->
              @if (chargementAuto()) {
                <p class="taid-empty">
                  <lucide-icon [img]="LoaderIcon" [size]="13" class="tab-spin"></lucide-icon>
                  Chargement de l'analyse…
                </p>
              } @else {
                <p class="taid-empty">
                  <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
                  Ce trajet n'a pas encore été analysé.
                  @if (canRecompute()) {
                    L'analyse relit les positions GPS et les limites de vitesse ; elle ne coûte aucun crédit d'IA.
                  } @else {
                    Elle est calculée automatiquement chaque nuit.
                  }
                </p>
                @if (canRecompute()) {
                  <div class="taid-actions">
                    <button type="button" class="taid-btn" (click)="runAnalyze()" [disabled]="busy()">
                      @if (busy()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="tab-spin"></lucide-icon> Analyse… }
                      @else { <lucide-icon [img]="RefreshIcon" [size]="14"></lucide-icon> Analyser maintenant }
                    </button>
                  </div>
                }
              }
              @if (error(); as e) { <p class="taid-err">{{ e }}</p> }
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }

    /* ── Bloc carte (mobile d'abord) ── */
    .tab {
      display: flex; flex-direction: column; gap: 6px;
      padding: 10px 12px; border-radius: 12px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      min-width: 0;
    }
    .tab--todo { background: transparent; border-style: dashed; border-color: var(--border-strong, var(--border-subtle)); }
    .tab-l1 { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    /* Note lettrée : lavis de la couleur de base + texte en jeton --texte-* (jamais la couleur vive). */
    .tab-grade {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 9px; border-radius: 999px; font-size: 12px; font-weight: 700;
      background: var(--bg-secondary); color: var(--fg-secondary); border: 1px solid var(--border-subtle);
    }
    .tab-grade b { font-size: 13px; font-weight: 900; }
    .tab-grade[data-grade="A"], .tab-grade[data-grade="B"] { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); color: var(--texte-succes); border-color: transparent; }
    .tab-grade[data-grade="C"] { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--texte-attente); border-color: transparent; }
    .tab-grade[data-grade="D"], .tab-grade[data-grade="E"] { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--texte-alerte); border-color: transparent; }
    .tab-alert {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 9px; border-radius: 999px; font-size: 12px; font-weight: 700;
      background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--texte-alerte);
    }
    .tab-alert-sub { font-weight: 600; opacity: .9; }
    .tab-l2 { margin: 0; font-size: 11.5px; line-height: 1.4; color: var(--fg-secondary); }
    .tab-l3 { margin: 0; font-size: 11px; line-height: 1.4; color: var(--fg-tertiary); }
    .tab-l4 {
      margin: 2px 0 0; font-size: 12px; line-height: 1.45; font-style: italic; color: var(--fg-secondary);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .tab-action { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 2px; }
    .tab-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      min-height: 40px; padding: 8px 14px; border-radius: 10px;
      font-size: 12.5px; font-weight: 800; cursor: pointer; border: 1px solid transparent;
      transition: background .15s, border-color .15s;
    }
    .tab-btn--primary { flex: 1 1 auto; background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); }
    .tab-btn--primary:hover:not(:disabled) { filter: brightness(1.04); }
    .tab-btn--ghost { background: transparent; color: var(--fg-secondary); border-color: var(--border-strong, var(--border-subtle)); }
    .tab-btn--ghost:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--tracky-light, #10E0A0); }
    .tab-btn:disabled { opacity: .6; cursor: default; }
    .tab-btn-arrow { margin-left: auto; }
    .tab-pending { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--fg-tertiary); }
    .tab-locked { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--fg-tertiary); text-decoration: none; border-bottom: 1px dashed var(--border-strong, var(--border-subtle)); }
    .tab-locked:hover { color: var(--fg-primary); }
    .tab-empty-line { margin: 0; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); }
    .tab-spin { animation: tab-rot .9s linear infinite; }
    @keyframes tab-rot { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .tab-spin { animation-duration: 2s; } }
    .tab-err { display: block; margin-top: 4px; font-size: 11px; color: var(--texte-alerte); }

    /* ── Variante RANGÉE (cellule du tableau en large) : tout sur une ligne, sans fond. ── */
    .tab--row { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 0; background: transparent; border: none; }
    .tab--row .tab-l1 { flex-wrap: nowrap; }
    .tab--row .tab-l2 { flex: 1 1 140px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tab--row .tab-action { margin: 0; }
    .tab--row .tab-btn { min-height: 32px; padding: 5px 10px; font-size: 12px; }
    .tab--row .tab-btn--primary { flex: 0 0 auto; }
    .tab--row.tab--todo { padding: 0; border: none; }
    /* ⚠️ AU DOIGT, 44 px — la norme que le reste de l'application tient déjà.
       Relevé en mesurant la liste des trajets de la page Rapports sur un écran de 320 px :
       « Lire le récit » rendait 40 px en carte et 32 px en ligne. C'est l'action qui ouvre
       le récit d'un trajet, souvent la seule d'une ligne dense, et la plus facile à rater.
       ⚠️ Bloc placé APRÈS les deux déclarations de base — dont .tab--row .tab-btn, de
       spécificité supérieure : une media query n'en ajoute aucune, seul l'ordre tranche.
       À la souris (au-delà de 768 px) les hauteurs compactes d'origine sont conservées. */
    @media (max-width: 768px) {
      .tab-btn, .tab--row .tab-btn { min-height: 44px; }
    }

    /* ── Modale détail ── */
    .taid-overlay { position: fixed; inset: 0; z-index: 9500; display: flex; align-items: flex-end; justify-content: center; padding: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(3px); }
    /*
     * ── LA FEUILLE NE DOIT JAMAIS POUSSER SON EN-TÊTE HORS DE L'ÉCRAN ──
     *
     * Signalé sur iPhone : « ça ouvre directement le rapport et il n'y a pas de croix pour
     * fermer ». Cette feuille est ancrée EN BAS (align-items: flex-end) : sa croix est en
     * haut de la carte, donc tout ce qui la fait dépasser en hauteur la pousse au-dessus du
     * cadre, hors d'atteinte. Et sur un téléphone en application installée, il n'y a ni
     * barre d'adresse ni bouton retour pour s'en sortir.
     *
     * Deux garde-fous, dans cet ordre :
     *
     *   1. 92vh AVANT 92dvh. Sans unité dvh (Safari antérieur à 15.4), la seconde
     *      déclaration est INVALIDE donc ignorée — et il ne restait alors AUCUN plafond :
     *      la carte prenait la hauteur de son contenu, un récit de vingt lignes la faisait
     *      déborder, et la croix sortait par le haut. ⚠️ L'ordre EST la correction : à
     *      sélecteur égal, c'est la dernière déclaration comprise qui gagne.
     *   2. padding-top sur la zone sûre : en application installée avec une barre d'état
     *      translucide (black-translucent, cf. index.html), le contenu passe SOUS l'heure
     *      et la batterie. La croix tombait à 13 px de l'îlot dynamique.
     */
    .taid-card {
      width: 100%; max-width: 720px; max-height: 92vh; max-height: 92dvh; display: flex; flex-direction: column;
      border-radius: 18px 18px 0 0; background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      box-shadow: 0 20px 60px rgba(0,0,0,.4); overflow: hidden;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    @media (min-width: 640px) {
      .taid-overlay { align-items: center; padding: 16px; }
      .taid-card { border-radius: 16px; max-height: 88vh; padding-bottom: 0; }
    }
    .taid-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); }
    .taid-head h3 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .taid-head h3 lucide-icon { color: var(--tracky-light, #10E0A0); }
    .taid-x { width: 44px; height: 44px; margin: -8px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-tertiary); background: none; border: none; cursor: pointer; }
    .taid-x:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .taid-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
    .taid-sec h4 { margin: 0 0 6px; display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 800; color: var(--fg-primary); text-transform: uppercase; letter-spacing: .03em; }
    .taid-prov { text-transform: none; letter-spacing: 0; font-weight: 600; font-size: 11px; color: var(--fg-tertiary); }
    .taid-sec p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--fg-secondary); white-space: pre-line; }
    .taid-sec--recit p { font-size: 14px; color: var(--fg-primary); }
    .taid-sec--advice p { color: var(--fg-primary); padding-left: 14px; position: relative; margin-bottom: 4px; }
    .taid-sec--advice p::before { content: '•'; position: absolute; left: 2px; color: var(--tracky-light, #10E0A0); }
    .taid-empty { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.5; padding: 10px 12px; border-radius: 10px; background: var(--bg-tertiary); }
    .taid-perime { margin: 0 0 8px !important; display: flex; align-items: flex-start; gap: 7px; font-size: 12px !important; line-height: 1.45; color: var(--texte-attente) !important; padding: 8px 10px; border-radius: 9px; background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .taid-perime lucide-icon { flex-shrink: 0; margin-top: 1px; }
    .taid-kv { margin: 0; display: grid; grid-template-columns: 1fr; gap: 6px; }
    .taid-kv > div { display: grid; grid-template-columns: 110px 1fr; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border-subtle); }
    .taid-kv > div:first-child { border-top: none; }
    .taid-kv dt { font-size: 11.5px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .03em; padding-top: 2px; }
    .taid-kv dd { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--fg-primary); }
    .taid-note { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
    .taid-note li { font-size: 12px; font-weight: 500; color: var(--fg-secondary); }
    .taid-note-plafond { color: var(--texte-attente) !important; }
    .taid-kv dd small { display: block; font-size: 11.5px; font-weight: 500; color: var(--fg-tertiary); margin-top: 1px; }
    .taid-fuel { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .taid-fuel-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: baseline; padding: 9px 12px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .taid-fuel-name { font-size: 13px; font-weight: 800; color: var(--fg-primary); }
    .taid-fuel-price { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); text-align: right; }
    .taid-fuel-noprice { color: var(--fg-tertiary); font-weight: 600; }
    .taid-fuel-where { grid-column: 1; font-size: 11.5px; color: var(--fg-tertiary); }
    .taid-fuel-dur { grid-column: 2; text-align: right; font-size: 11.5px; color: var(--fg-tertiary); }
    .taid-fuel-note { margin: 8px 0 0; font-size: 11px; line-height: 1.45; color: var(--fg-tertiary); }
    .taid-actions { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; border-top: 1px solid var(--border-subtle); }
    .taid-actions-note { font-size: 11.5px; color: var(--fg-tertiary); }
    .taid-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 9px 14px; border-radius: 10px; font-size: 12.5px; font-weight: 800; cursor: pointer; background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); border: none; }
    .taid-btn:disabled { opacity: .6; cursor: default; }
    .taid-btn--ghost { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-strong, var(--border-subtle)); }
    .taid-btn--ghost:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--tracky-light, #10E0A0); }
    .taid-err { margin: 0; font-size: 12px; color: var(--texte-alerte); }
    .taid-ancienne {
      display: flex; align-items: flex-start; gap: 7px; margin: 0 0 10px;
      padding: 9px 11px; border-radius: 10px;
      font-size: 12.5px; line-height: 1.5;
      color: var(--fg-secondary);
      border: 1px dashed var(--border-subtle);
      background: var(--bg-tertiary);
    }
    .taid-ancienne b { color: var(--fg-primary); }
    .taid-partielle {
      display: flex; align-items: flex-start; gap: 7px; margin: 0 0 10px;
      padding: 9px 11px; border-radius: 10px;
      font-size: 12.5px; line-height: 1.5; font-weight: 600;
      color: var(--texte-attente);
      border: 1px solid color-mix(in srgb, var(--texte-attente) 35%, transparent);
      background: color-mix(in srgb, var(--texte-attente) 10%, transparent);
    }
    .lien-conso { color: var(--texte-succes); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
  `],
})
export class TripAnalysisBadgesComponent {
  private readonly api = inject(TripAnalysisApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /**
   * Option IA de la SOCIÉTÉ (interrupteur maître), pas le drapeau global de génération :
   * c'est elle qui dit si le client verra le récit une fois rédigé par l'agent. La génération
   * côté API est coupée exprès (zéro coût) et n'est plus proposée nulle part ici.
   */
  protected readonly aiEnabled = computed(() => this.aiStatus.enabled());
  /** Le rôle peut activer l'option (fleet admin) : lui seul reçoit le lien vers les réglages. */
  protected readonly canConfigureAi = computed(() => this.perms.can('ai_configure'));
  /** Recalcul des chiffres : gestionnaires et admins — pas un lecteur. */
  protected readonly canRecompute = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'SUPER_ADMIN' || role === 'FLEET_ADMIN' || role === 'FLEET_MANAGER';
  });

  constructor() {
    this.aiStatus.ensureLoaded();
    /**
     * ── LE LIEN PROFOND N'OUVRAIT RIEN QUAND L'ANALYSE MANQUAIT ────────────────────────
     *
     * La condition exigeait `current()` : arrivé de /scores sur un trajet jamais analysé —
     * ou simplement pas encore chargé — le clic ne produisait AUCUN effet visible. Pas de
     * modale vide, ce qui aurait au moins été un signe : rien. L'utilisateur recliquait,
     * puis concluait que le lien était cassé.
     *
     * La modale s'ouvre maintenant TOUJOURS, et va chercher elle-même l'analyse si personne
     * ne la lui a donnée. Ses trois états sont dès lors dicibles : on charge, voilà, ou il
     * n'y en a pas.
     */
    effect(() => {
      if (!this.autoOpen() || this.autoOpened) return;
      this.autoOpened = true;
      this.openDetail();
      if (!this.current()) void this.chargerPourLienProfond();
    });
  }

  readonly tripId = input.required<string>();
  readonly analysis = input<TripAnalysisDto | null>(null);
  /** Deep-link : ouvre automatiquement le détail de ce trajet (une seule fois). */
  readonly autoOpen = input<boolean>(false);
  /** 'card' (défaut) = bloc à trois lignes ; 'row' = une ligne compacte pour une cellule de tableau. */
  readonly layout = input<'card' | 'row'>('card');
  readonly analyzed = output<TripAnalysisDto>();
  private autoOpened = false;

  private readonly fresh = signal<TripAnalysisDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly detailOpen = signal(false);
  /** Lecture en cours déclenchée par un lien profond — distingue « on attend » de « il n'y a rien ». */
  protected readonly chargementAuto = signal(false);

  protected readonly current = computed(() => this.fresh() ?? this.analysis());

  /**
   * Horizon de rétention des positions, en jours — au-delà, une analyse n'est plus reprenable.
   *
   * ⚠️ Fourni par l'écran hôte quand il le connaît ; à défaut, la valeur du produit (60 j).
   * Une constante recopiée ici DIVERGERAIT du serveur le jour où la rétention change, et le
   * bandeau dirait « ne sera pas recalculé » d'un trajet que le rattrapage prendra le soir même.
   */
  readonly retentionJours = input<number>(60);

  /** Cette analyse a-t-elle été écrite avant la règle actuelle (lot V1, 4 septembre 2026) ? */
  protected readonly analyseAncienne = computed(() => analyseAvantRegleActuelle(this.current()));

  /**
   * Et ses positions ont-elles été purgées ? Alors elle ne sera JAMAIS reprise.
   *
   * ⚠️ La date de référence est celle du TRAJET, pas celle de l'analyse : c'est le trajet dont
   * les positions se purgent. Une analyse recalculée hier sur un trajet de juin serait
   * « récente » et pourtant irréparable.
   */
  protected readonly horsDePortee = computed(() => {
    const a = this.current();
    if (!a || !this.analyseAncienne()) return false;
    const depart = this.departTrajet();
    if (!depart) return false;
    const horizon = Date.now() - this.retentionJours() * 86_400_000;
    return analyseHorsDePortee(depart, horizon);
  });

  /** Date de départ du trajet — passée par l'écran hôte, sinon déduite du tracé de l'analyse. */
  readonly tripStartedAt = input<string | null>(null);
  private readonly departTrajet = computed(() => {
    const fourni = this.tripStartedAt();
    if (fourni) return fourni;
    // ⚠️ Repli sur le PREMIER POINT du tracé : `computedAt` daterait le calcul, pas le trajet —
    // une analyse recalculée hier ferait passer un trajet de juin pour tout frais.
    return this.current()?.detail?.track?.[0]?.t ?? null;
  });

  /** Analyse persistée sans aucune position : les chiffres sont des zéros inventés, pas des faits. */
  protected readonly isEmptyAnalysis = computed(() => {
    const a = this.current();
    return !!a && a.gpsPoints === 0 && a.distanceKm === 0;
  });

  protected readonly grade = computed(() => gradeOf(this.current()?.ecoScore ?? 0));

  /**
   * Lot V7 — LE compte des excès, celui que lisent aussi le rapport de vitesse et le PDF.
   *
   * On lisait `speedingCount`, le compteur écrit au moment de l'analyse. Sur les analyses
   * antérieures au lot V2, il inclut des segments de durée nulle que la règle actuelle écarte :
   * l'écran annonçait donc un nombre d'excès que la pièce disciplinaire, elle, ne retenait pas.
   */
  protected readonly nbExces = computed(() => excesDuTrajet(this.current()).nombre);

  /**
   * Les points retirés, du plus lourd au plus léger. C'est la raison d'être du lot : une note
   * qu'on peut défendre devant un client se lit, elle ne s'assène pas.
   */
  protected readonly penalites = computed(() =>
    [...(this.current()?.detail?.note?.penalites ?? [])].sort((a, b) => b.points - a.points),
  );

  /** Raison du plafonnement de la note, quand les limites étaient trop peu connues. */
  protected readonly plafondNote = computed<string | null>(() => this.current()?.detail?.note?.plafond?.raison ?? null);

  /**
   * Pointe annoncée par le boîtier que la trajectoire contredit, en km/h, ou `null`.
   *
   * On l'affiche au lieu de la faire disparaître : le client a vu « 180 km/h » sur son écran,
   * lui retirer le chiffre sans explication reviendrait à déplacer le problème. On ne la montre
   * que si elle dépasse nettement la vitesse retenue, sinon la mention n'apprend rien.
   */
  protected readonly pointeNonCorroboree = computed<number | null>(() => {
    const a = this.current();
    const v = a?.detail?.vitesse;
    if (!a || !v || v.pointsEcartes <= 0) return null;
    return v.pointeBruteKmh > a.maxSpeedKmh + 1 ? Math.round(v.pointeBruteKmh) : null;
  });

  /**
   * Récit écrit AVANT le dernier recalcul des chiffres. Le recalcul remplace toutes les
   * mesures et conserve le texte : sans ce repère, un récit qui parle de « deux freinages
   * appuyés » pouvait accompagner des chiffres qui n'en comptent plus aucun.
   *
   * Une minute de battement : l'analyse et le récit s'écrivent à quelques secondes d'écart
   * lors d'un passage normal de l'agent, et cet écart-là n'est pas une péremption.
   */
  protected readonly recitPerime = computed(() => {
    const a = this.current();
    if (!a?.narrative || !a.narratedAt) return false;
    return new Date(a.computedAt).getTime() - new Date(a.narratedAt).getTime() > 60_000;
  });

  /** Passages en station-service détectés sur ce trajet (P2 stations). */
  protected readonly fuelStops = computed(() => this.current()?.detail?.fuelStops ?? []);

  /** L2 — faits secondaires, en texte. */
  protected readonly facts = computed<string[]>(() => {
    const a = this.current();
    if (!a) return [];
    const out: string[] = [];
    if (a.stopCount > 0) out.push(`${a.stopCount} arrêt${a.stopCount > 1 ? 's' : ''}`);
    const jolts = a.harshAccel + a.harshBrake;
    if (jolts > 0) out.push(`${jolts} à-coup${jolts > 1 ? 's' : ''}`);
    if (a.idleSec >= 60) out.push(`ralenti ${this.minutes(a.idleSec)} min`);
    for (const fs of this.fuelStops().slice(0, 2)) {
      out.push(`station ${fs.brand || ''}${fs.unitPriceEur != null ? ` ${fs.unitPriceEur.toFixed(3)} €` : ''}`.replace(/\s+/g, ' ').trim());
    }
    return out;
  });

  /** L3 — estimations (toujours « ≈ ») et fiabilité de la donnée. */
  protected readonly estimates = computed<string[]>(() => {
    const a = this.current();
    if (!a) return [];
    const out: string[] = [];
    if (a.fuelLiters != null) out.push(`≈ ${a.fuelLiters.toFixed(1).replace('.', ',')} L`);
    if (a.co2Kg != null) out.push(`≈ ${Math.round(a.co2Kg)} kg CO₂`);
    if (a.trustScore != null) out.push(`fiabilité GPS ${a.trustScore}`);
    return out;
  });

  /** Les conseils arrivent en un paragraphe ; le schéma impose des puces « • ». */
  protected readonly adviceLines = computed<string[]>(() => {
    const raw = this.current()?.advice ?? '';
    return raw.split(/\s*(?:^|\n)\s*[•\-–]\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  });

  protected readonly LeafIcon = Leaf;
  protected readonly StopIcon = OctagonX;
  protected readonly GaugeIcon = Gauge;
  protected readonly FuelIcon = Fuel;
  protected readonly PumpIcon = MapPin;
  protected readonly SparklesIcon = Sparkles;
  protected readonly LoaderIcon = Loader;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly ShieldIcon = ShieldCheck;
  protected readonly FileIcon = FileText;
  protected readonly LockIcon = Lock;
  protected readonly XIcon = X;
  protected readonly ClockIcon = Clock;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly ArrowIcon = ArrowRight;
  protected readonly InfoIcon = Info;

  protected minutes(sec: number): number { return Math.round(sec / 60); }

  /** Libellé lisible d'un carburant de l'API (gazole → « Gazole », gplc → « GPL »…). */
  protected fuelTypeLabel(t: string | null): string {
    switch (t) {
      case 'gazole': return 'Gazole';
      case 'sp95': return 'SP95';
      case 'sp98': return 'SP98';
      case 'e10': return 'E10';
      case 'e85': return 'E85 (Superéthanol)';
      case 'gplc': return 'GPL';
      default: return 'Carburant';
    }
  }
  /** Adresse + ville d'un passage (sans les vides). */
  protected fuelWhere(fs: { address: string | null; city: string | null }): string {
    return [fs.address, fs.city].filter(Boolean).join(', ');
  }
  /**
   * Libellé du moteur. MARQUE BLANCHE : tout ce qui n'est pas un moteur nommé s'affiche
   * « l'agent Tracky » ; 'local' (agent sur poste) aussi — pour le client c'est le même agent.
   * Seul le super-admin voit Claude/GPT/Mixte, et « agent local » pour reconnaître le poste.
   */
  protected providerLabel(p: AiProviderId | string): string {
    if (p === 'gpt') return 'GPT (OpenAI)';
    if (p === 'claude') return 'Claude';
    if (p === 'both') return 'Mixte (les 2 IA)';
    if (p === 'local') return this.auth.user()?.role === 'SUPER_ADMIN' ? 'l\'agent Tracky (poste local)' : 'l\'agent Tracky';
    return 'l\'agent Tracky';
  }
  protected speedingTitle(a: TripAnalysisDto): string {
    return a.limitsKnown
      ? `${excesDuTrajet(a).nombre} excès de vitesse — dépassement max +${Math.round(a.maxOverKmh)} km/h`
      : `${excesDuTrajet(a).nombre} pointe(s) de vitesse (limites légales non résolues — excès probable)`;
  }

  /**
   * Va chercher l'analyse quand un lien profond ouvre la modale sans elle.
   *
   * ⚠️ C'est une LECTURE (`get`), pas un calcul : `null` en retour signifie « jamais analysé »
   * et doit rester dicible. Déclencher l'analyse d'office ici la rendrait indiscernable d'une
   * analyse préexistante, et ferait travailler le serveur sur un simple clic de lien.
   */
  private async chargerPourLienProfond(): Promise<void> {
    this.chargementAuto.set(true);
    try {
      const a = await firstValueFrom(this.api.get(this.tripId()));
      if (a) this.fresh.set(a);
    } catch (e) {
      swallow('trip-analysis-badges:lienProfond', e);
      this.error.set(apiErrorMessage(e, 'Analyse indisponible.'));
    } finally {
      this.chargementAuto.set(false);
    }
  }

  protected openDetail(): void { this.error.set(null); this.detailOpen.set(true); }
  protected closeDetail(): void { this.detailOpen.set(false); }

  /** Échap ferme le détail (aria-modal sans piège de focus : l'overlay reste cliquable). */
  @HostListener('document:keydown.escape')
  protected onEscape(): void { if (this.detailOpen()) this.closeDetail(); }

  /** (Re)calcule l'analyse déterministe — positions + limites OSM. Le récit est conservé. */
  protected async runAnalyze(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.analyze(this.tripId()));
      this.fresh.set(res);
      this.analyzed.emit(res);
    } catch (e) {
      swallow('trip-analysis-badges:runAnalyze', e);
      this.error.set(apiErrorMessage(e, 'Analyse impossible.'));
    } finally {
      this.busy.set(false);
    }
  }
}
