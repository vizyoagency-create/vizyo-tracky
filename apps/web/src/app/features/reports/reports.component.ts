import { swallow } from '../../core/error/swallow';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VehicleLinkDirective } from '../../shared/directives/vehicle-link.directive';
import { LucideAngularModule, BarChart3, ChevronRight, Route, Clock, Gauge, Play, ChevronDown, Truck, Check, MessageSquare, Pencil, UserRound, Download, Calendar, FileText, Layers, ArrowUp, ArrowDown, ArrowUpDown, FileSpreadsheet, RotateCcw, MousePointerClick } from 'lucide-angular';
import type {
  DriverDto,
  TripAnalysisDto,
  TripDailySummaryDto,
  TripDto,
  TripPeriodChartsDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { DriversApiService } from '../../core/services/drivers.service';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { TripAnalysisBadgesComponent } from '../trip-analysis/trip-analysis-badges.component';
import { PermissionsService } from '../../core/services/permissions.service';
import { ReportsApiService } from '../../core/services/reports.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { TripsApiService } from '../../core/services/trips.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AuthService } from '../../core/services/auth.service';
import { DriverPickerComponent } from '../../shared/ui/driver-picker/driver-picker.component';
import { TripNoteModalComponent } from '../../shared/ui/trip-note-modal/trip-note-modal.component';
import { DateRangePickerComponent } from '../../shared/ui/date-range-picker/date-range-picker.component';
import { PdfExportModalComponent, type PdfExportRequest } from '../../shared/ui/pdf-export-modal/pdf-export-modal.component';
import { LineBarChartComponent, type LineBarChartData } from '../../shared/ui/charts/line-bar-chart.component';
import { TrackClickDirective } from '../../shared/directives/track-click.directive';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { HistogramChartComponent } from '../../shared/ui/charts/histogram-chart.component';
import { HeatmapChartComponent } from '../../shared/ui/charts/heatmap-chart.component';
import { TripReplayComponent } from './trip-replay.component';
import { PeriodReplayComponent } from './period-replay.component';
import {
  aggregateKpisFromDaily,
  clampSpeed as clampSpeedFn,
  formatDuration as formatDurationFn,
  kpiToSortColumn,
  max0 as max0Fn,
  normalizeCustomRange,
  sortTrips,
  todayIsoLocal,
  type SortDirection,
  type TripSortColumn,
} from './reports.utils';

@Component({
  selector: 'app-reports',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    VehicleLinkDirective,
    LucideAngularModule,
    TrackClickDirective,
    GroupBadgeComponent,
    DatePipe,
    DecimalPipe,
    TripAnalysisBadgesComponent,
    TripReplayComponent,
    TripNoteModalComponent,
    DriverPickerComponent,
    DateRangePickerComponent,
    LineBarChartComponent,
    HistogramChartComponent,
    HeatmapChartComponent,
    PeriodReplayComponent,
    PdfExportModalComponent,
  ],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <span class="vt-eyebrow">Analyse</span>
          <h1 class="text-2xl font-display font-bold text-fg-primary mt-2">Rapports d'activité</h1>
        </div>
        <div class="rep-export-group" role="group" aria-label="Exporter le rapport">
          <button type="button" (click)="onExportPdf()" trackClick="rapport-export-pdf" [disabled]="!!exporting()" class="rep-export-btn rep-export-btn--pdf">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() === 'pdf' ? 'Export…' : 'PDF' }}</span>
          </button>
          <button type="button" (click)="onExportCsv('trips')" trackClick="rapport-export-trips" [disabled]="!!exporting()" class="rep-export-btn">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() === 'csv-trips' ? 'Export…' : 'CSV trajets' }}</span>
          </button>
          <button type="button" (click)="onExportCsv('alerts')" trackClick="rapport-export-alerts" [disabled]="!!exporting()" class="rep-export-btn">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() === 'csv-summary' ? 'Export…' : 'CSV alertes' }}</span>
          </button>
          <!-- Sprint 5 — Export Excel « soigné » PAR VÉHICULE : nécessite un
               véhicule précis (sinon désactivé + hint). -->
          <button type="button" (click)="onExportExcel()" trackClick="rapport-export-excel"
                  [disabled]="!!exporting() || !canExportExcel()"
                  [title]="canExportExcel() ? 'Export Excel détaillé du véhicule' : 'Sélectionnez un véhicule'"
                  class="rep-export-btn rep-export-btn--excel">
            @if (exporting() === 'excel') {
              <span class="rep-export-spin"></span>
            } @else {
              <lucide-icon [img]="FileSpreadsheetIcon" [size]="13"></lucide-icon>
            }
            <span>{{ exporting() === 'excel' ? 'Export…' : 'Excel' }}</span>
          </button>
        </div>
      </div>

      <div class="flex items-center gap-2 flex-wrap">
        <!-- Filtre groupe : restreint la liste de véhicules du sélecteur à un groupe. -->
        @if (groupOptions().length > 0) {
          <div class="rep-dropdown-wrapper">
            <button type="button"
                    (click)="groupDropdownOpen.set(!groupDropdownOpen())"
                    class="rep-dropdown-trigger"
                    [class.rep-dropdown-trigger--open]="groupDropdownOpen()">
              <lucide-icon [img]="LayersIcon" [size]="14"></lucide-icon>
              <span class="rep-dropdown-label">{{ selectedGroupLabel() }}</span>
              <lucide-icon [img]="ChevronDown" [size]="14" class="rep-dropdown-chevron"></lucide-icon>
            </button>
            @if (groupDropdownOpen()) {
              <div class="rep-dropdown-backdrop" (click)="groupDropdownOpen.set(false)"></div>
              <div class="rep-dropdown-menu">
                <button type="button"
                        (click)="onSelectGroup('')"
                        class="rep-dropdown-item"
                        [class.rep-dropdown-item--active]="!selectedGroupId()">
                  <span>Tous les groupes</span>
                  @if (!selectedGroupId()) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
                <div class="rep-dropdown-divider"></div>
                @for (g of groupOptions(); track g.id) {
                  <button type="button"
                          (click)="onSelectGroup(g.id)"
                          class="rep-dropdown-item"
                          [class.rep-dropdown-item--active]="selectedGroupId() === g.id">
                    <span class="rep-dropdown-item-content">
                      <app-group-badge [group]="g" />
                    </span>
                    @if (selectedGroupId() === g.id) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                  </button>
                }
              </div>
            }
          </div>
        }
        <!-- Dropdown véhicule custom -->
        <div class="rep-dropdown-wrapper">
          <button type="button"
                  (click)="vehicleDropdownOpen.set(!vehicleDropdownOpen())"
                  class="rep-dropdown-trigger"
                  [class.rep-dropdown-trigger--open]="vehicleDropdownOpen()">
            <lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon>
            <span class="rep-dropdown-label">{{ selectedVehicleLabel() }}</span>
            <lucide-icon [img]="ChevronDown" [size]="14" class="rep-dropdown-chevron"></lucide-icon>
          </button>
          @if (vehicleDropdownOpen()) {
            <div class="rep-dropdown-backdrop" (click)="vehicleDropdownOpen.set(false)"></div>
            <div class="rep-dropdown-menu">
              <button type="button"
                      (click)="onSelectVehicle('')"
                      class="rep-dropdown-item"
                      [class.rep-dropdown-item--active]="!selectedVehicleId()">
                <span>Tous les véhicules</span>
                @if (!selectedVehicleId()) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
              </button>
              @if (visibleVehicles().length > 0) {
                <div class="rep-dropdown-divider"></div>
              }
              @for (v of visibleVehicles(); track v.id) {
                <button type="button"
                        (click)="onSelectVehicle(v.id)"
                        class="rep-dropdown-item"
                        [class.rep-dropdown-item--active]="selectedVehicleId() === v.id">
                  <span class="rep-dropdown-item-content">
                    <span class="rep-dropdown-item-plate">{{ v.plate }}</span>
                    @if (v.brand || v.model) {
                      <span class="rep-dropdown-item-meta">{{ v.brand }} {{ v.model }}</span>
                    }
                    @if (v.group) { <app-group-badge [group]="v.group" /> }
                  </span>
                  @if (selectedVehicleId() === v.id) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
              }
            </div>
          }
        </div>

        @for (p of periods; track p.label) {
          <button (click)="setPeriod(p.from, p.to); customRangeOpen.set(false)"
                  class="rep-periode px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer"
                  [class]="periodFrom === p.from && periodTo === p.to && !isCustomRange()
                    ? 'bg-tracky/20 text-texte-succes border-tracky/30'
                    : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
            {{ p.label }}
          </button>
        }

        <!-- Pill personnalise — ouvre un panel avec presets + 2 inputs date -->
        <div class="rep-custom-wrapper">
          <button type="button"
                  (click)="customRangeOpen.set(!customRangeOpen())"
                  class="rep-periode px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer inline-flex items-center gap-1.5"
                  [class]="isCustomRange()
                    ? 'bg-tracky/20 text-texte-succes border-tracky/30'
                    : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
            <lucide-icon [img]="CalendarIcon" [size]="12"></lucide-icon>
            @if (isCustomRange()) { {{ customRangeLabel() }} } @else { Personnalisé }
          </button>
          @if (customRangeOpen()) {
            <div class="rep-custom-backdrop" (click)="customRangeOpen.set(false)"></div>
            <div class="rep-custom-panel" role="dialog" aria-label="Période personnalisée">
              <div class="rep-custom-presets">
                <p class="rep-custom-section">Raccourcis</p>
                @for (pr of customPresets(); track pr.label) {
                  <button type="button" (click)="applyPreset(pr)"
                          class="rep-custom-preset"
                          [class.rep-custom-preset--active]="periodFrom === pr.from && periodTo === pr.to">
                    {{ pr.label }}
                  </button>
                }
              </div>
              <div class="rep-custom-fields">
                <p class="rep-custom-section">Plage personnalisée</p>
                @if (isDesktop()) {
                  <app-date-range-picker
                    [from]="customFrom()"
                    [to]="customTo()"
                    [max]="todayIso"
                    (fromChange)="customFrom.set($event)"
                    (toChange)="customTo.set($event)"
                  />
                } @else {
                  <!-- ⚠️ PAS de liaison deux-sens ngModel ICI : « customFrom » et « customTo »
                       sont des SIGNALS. Le raccourci se compile en une AFFECTATION a la
                       propriete — il remplace le signal au lieu d'ecrire dedans, et cote
                       lecture il passe la FONCTION au champ au lieu de la chaine. Les deux
                       champs de date etaient donc inertes : on saisissait une plage,
                       applyCustomRange relisait une valeur vide et sortait sans rien faire.
                       La branche du dessus, elle, utilisait deja le bon motif. -->
                  <div class="rep-custom-field">
                    <label>Du</label>
                    <input type="date" [ngModel]="customFrom()" (ngModelChange)="customFrom.set($event)" [max]="customTo()" />
                  </div>
                  <div class="rep-custom-field">
                    <label>Au</label>
                    <input type="date" [ngModel]="customTo()" (ngModelChange)="customTo.set($event)" [min]="customFrom()" [max]="todayIso" />
                  </div>
                }
                @if (customRangeError(); as err) {
                  <p class="rep-custom-error">{{ err }}</p>
                }
                @if (customFrom() && !customTo() && !customRangeError()) {
                  <p class="rep-custom-hint">« Jusqu'à » sera fixé à aujourd'hui.</p>
                }
                <div class="rep-custom-actions">
                  <button type="button" (click)="customRangeOpen.set(false)" class="rep-custom-cancel">Annuler</button>
                  <button type="button"
                          (click)="applyCustomRange()"
                          [disabled]="!customRangeValid()"
                          class="rep-custom-apply">
                    Appliquer
                  </button>
                </div>
              </div>
            </div>
          }
        </div>

        <!-- Replay periode : actif uniquement si un vehicule est selectionne
             ET qu'au moins 1 trip existe sur la periode. Sinon tooltip explicatif. -->
        <button (click)="onOpenPeriodReplay()"
                [disabled]="!canPeriodReplay()"
                [title]="canPeriodReplay() ? 'Replay de tous les trajets de la période'
                                            : 'Sélectionne un véhicule avec des trajets sur la période'"
                class="rep-periode px-3 py-1.5 text-xs rounded-lg border border-tracky/30
                       bg-tracky/10 text-texte-succes hover:bg-tracky/20
                       transition-colors cursor-pointer disabled:opacity-40
                       inline-flex items-center gap-1.5">
          <lucide-icon [img]="Play" [size]="12"></lucide-icon>
          Replay période
        </button>

        @if (isAdmin()) {
          <button (click)="onRecompute()" [disabled]="!selectedVehicleId() || recomputing()"
                  class="rep-periode px-3 py-1.5 text-xs rounded-lg border border-amber-500/30
                         bg-amber-500/10 text-amber-400 hover:bg-amber-500/20
                         transition-colors cursor-pointer disabled:opacity-40">
            @if (recomputing()) { Recalcul... } @else { Recalculer }
          </button>
        }

        <!-- Sprint 5 — Réinitialiser : tous groupes / tous véhicules / 7 jours.
             Désactivé quand les filtres sont déjà sur leurs valeurs par défaut. -->
        <button type="button" (click)="resetFilters()" [disabled]="!filtersDirty()"
                trackClick="rapport-reset-filtres"
                title="Réinitialiser les filtres (tous véhicules · 7 jours)"
                class="rep-reset-btn">
          <lucide-icon [img]="RotateCcwIcon" [size]="13"></lucide-icon>
          <span>Réinitialiser</span>
        </button>
      </div>

      <!-- Sparkline KPI cards : compactes, lecture rapide -->
      <div class="rep-kpi-grid">
        <div class="rep-kpi-card">
          <div class="rep-kpi-head">
            <lucide-icon [img]="Route" [size]="14"></lucide-icon>
            <span>Trajets</span>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">{{ kpis().tripCount }}</p>
            @if (sparkTripBars().length > 0) {
              <svg class="rep-spark" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">
                @for (b of sparkTripBars(); track $index) {
                  <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h"
                        fill="var(--tracky-light)" rx="1.5" />
                }
              </svg>
            }
          </div>
        </div>

        <div class="rep-kpi-card">
          <div class="rep-kpi-head">
            <lucide-icon [img]="BarChart3" [size]="14"></lucide-icon>
            <span>Distance</span>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">
              {{ (kpis().totalDistance / 1000) | number:'1.1-1' }}
              <span class="rep-kpi-unit">km</span>
            </p>
            @if (sparkDistancePath()) {
              <svg class="rep-spark" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">
                <path [attr.d]="sparkDistanceFillPath()" fill="rgba(16,224,160,0.14)" stroke="none" />
                <path [attr.d]="sparkDistancePath()" fill="none" stroke="var(--tracky-light)"
                      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            }
          </div>
        </div>

        <div class="rep-kpi-card">
          <div class="rep-kpi-head">
            <lucide-icon [img]="Clock" [size]="14"></lucide-icon>
            <span>Durée totale</span>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">{{ formatDuration(kpis().totalDuration) }}</p>
            <span class="rep-kpi-meta">~{{ avgDurationPerActiveDay() }} / jour actif</span>
          </div>
        </div>

        <!-- Sprint 5 — KPI « Vitesse max » CLIQUABLE : trie le tableau par
             vitesse max desc + scrolle + surligne la 1ʳᵉ ligne (le trajet le
             plus rapide). Affordance : curseur, hover, icône de clic. -->
        <button type="button" class="rep-kpi-card rep-kpi-card--clickable"
                (click)="onMaxSpeedKpiClick()"
                [disabled]="trips().length === 0"
                trackClick="rapport-kpi-vitesse-max"
                title="Voir le trajet le plus rapide (trie le tableau)">
          <div class="rep-kpi-head">
            <lucide-icon [img]="Gauge" [size]="14"></lucide-icon>
            <span>Vitesse max</span>
            <lucide-icon [img]="MousePointerClickIcon" [size]="12" class="rep-kpi-click-hint"></lucide-icon>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">
              {{ kpis().maxSpeed | number:'1.0-0' }}
              <span class="rep-kpi-unit">km/h</span>
            </p>
            <span class="rep-kpi-dot" [style.background]="speedDotColor()"
                  [attr.title]="speedDotLabel()" [attr.aria-label]="speedDotLabel()"></span>
          </div>
        </button>
      </div>

      <!-- Charts : full-width line+bar puis 2 demi-largeur en grid -->
      @if (!loading() && trips().length > 0) {
        <div class="rep-charts-grid">
          <section class="rep-chart-card rep-chart-card--full">
            <header class="rep-chart-head">
              <h2>Activité</h2>
              <p>Distance &amp; trajets par jour</p>
            </header>
            <app-line-bar-chart [data]="lineBarData()" [height]="260" />
          </section>

          <!--
            ⚠️ CES DEUX GRAPHIQUES PORTENT SUR UN ECHANTILLON, PAS SUR LA PERIODE.
            Ils se calculent depuis les trajets CHARGES, bornes a 100 par la requete —
            là où les KPI et le graphique d'activité viennent de l'agrégat serveur, complet.

            Ils annonçaient pourtant « Distribution sur la période » et « 24h × 7j ». Sur
            30 jours et 2 738 trajets, la fréquentation ne couvrait en réalité qu'environ
            une journée : elle affichait ZERO trajet le mardi alors que le tableau juste
            au-dessus en comptait 132 le mardi 15 juillet. Deux chiffres contradictoires
            dans la même page, et c'est le plus faux des deux qui avait l'air d'un fait.

            Un graphique incomplet qui le DIT reste utile ; un graphique incomplet qui se
            présente comme exhaustif est pire que pas de graphique du tout.

            ⚠️ Correction de fond à faire : des agrégats serveur dédiés (répartition par
            tranche de vitesse, et par créneau jour × heure), sur le modèle du résumé
            journalier. En attendant, l'échantillon est nommé.
          -->
          <section class="rep-chart-card">
            <header class="rep-chart-head">
              <h2>Vitesses max</h2>
              @if (periodCharts()) {
                <p>Distribution sur la période</p>
              } @else if (tripsTruncated()) {
                <p>Sur les {{ listedTripCount() }} trajets les plus récents — pas toute la période</p>
              } @else {
                <p>Distribution sur la période</p>
              }
            </header>
            <app-histogram-chart [values]="histoValues()" [height]="220" />
          </section>

          <section class="rep-chart-card">
            <header class="rep-chart-head">
              <h2>Fréquentation</h2>
              @if (periodCharts()) {
                <p>24h × 7j — sur toute la période</p>
              } @else if (tripsTruncated()) {
                <p>Sur les {{ listedTripCount() }} trajets les plus récents — pas toute la période</p>
              } @else {
                <p>24h × 7j</p>
              }
            </header>
            <app-heatmap-chart [data]="heatmapData()" />
          </section>
        </div>
      }

      <!-- Synthèse par véhicule (réf. maquette Rapports) — rollup de la période,
           complémentaire du tableau détaillé par trajet ci-dessous. -->
      @if (!loading() && vehicleSummary().length > 0) {
        <section class="rep-vsum">
          <header class="rep-chart-head rep-vsum-head">
            <h2>Par véhicule</h2>
            <p>Synthèse de la période — cliquez « Voir » pour le détail</p>
          </header>
          <div class="rep-vtable">
            <div class="rep-vt-head">
              <span>Véhicule</span>
              <span>Distance</span>
              <span>Conduite</span>
              <span class="rep-vt-hide">Trajets</span>
              <span class="rep-vt-hide">V. moy</span>
              <span></span>
            </div>
            @for (v of vehicleSummary(); track v.vehicleId) {
              <div class="rep-vrow" [vehicleLink]="v.vehicleId" [attr.title]="'Voir ' + vehiclePlate(v.vehicleId)">
                <div class="rep-vveh">
                  <div class="rep-vplate">{{ vehiclePlate(v.vehicleId) || '—' }}</div>
                  <div class="rep-vmodel">{{ vehicleModelLabel(v.vehicleId) }}</div>
                </div>
                <span class="rep-vdist">{{ (v.distance / 1000) | number:'1.0-0' }} <span class="rep-vunit">km</span></span>
                <span class="rep-vmeta">{{ formatDuration(v.duration) }}</span>
                <span class="rep-vmeta rep-vt-hide">{{ v.trips }}</span>
                <span class="rep-vmeta rep-vt-hide" [class.rep-vspeed-warn]="v.avgSpeed >= 50">{{ v.avgSpeed }} km/h</span>
                <lucide-icon [img]="ChevronRightIcon" [size]="16" class="rep-vchev" aria-hidden="true"></lucide-icon>
              </div>
            }
          </div>
        </section>
      }

      @if (loadError() && trips().length > 0) {
        <!--
          Panne PARTIELLE : une des deux requetes a echoue, l'autre a repondu. On montre ce
          qu'on a, en disant clairement que la vue est incomplete — plutot que de laisser
          croire a des chiffres complets, ou de tout cacher.
        -->
        <div class="flex items-center justify-between gap-3 mb-3 px-4 py-2 rounded-[--radius-card]
                    bg-bg-secondary border border-amber-500/40 text-fg-secondary text-sm">
          <span>{{ loadError() }} Les données affichées sont incomplètes.</span>
          <button type="button" class="btn-secondary text-xs shrink-0" (click)="loadData()">Réessayer</button>
        </div>
      }

      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (loadError() && trips().length === 0) {
        <!--
          ⚠️ AVANT l'etat vide, sinon invisible : en panne la liste est vide, donc la
          branche du dessous l'avalerait et l'ecran rejouerait « Aucun trajet ».

          ⚠️ ET conditionne a une liste VIDE : les deux appels (trajets / resume journalier)
          echouent independamment. Si seul le resume tombe, les trajets sont bien la — les
          masquer derriere un ecran de panne serait une seconde perte de donnees. Ce cas-la
          est signale par le bandeau ci-dessus, au-dessus du tableau.
        -->
        <div class="flex flex-col items-center justify-center gap-3 h-32 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-secondary">
          <span>{{ loadError() }}</span>
          <button type="button" class="btn-secondary text-xs" (click)="loadData()">Réessayer</button>
        </div>
      } @else if (trips().length === 0) {
        <div class="flex items-center justify-center h-32 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary">
          Aucun trajet pour cette période
        </div>
      } @else {
        @if (tripsTruncated()) {
          <!--
            Le tableau est borne a 100 lignes (voir loadData) alors que les
            KPI couvrent toute la periode. Le dire est le minimum : un utilisateur qui
            compte les lignes et tombe sur un autre chiffre que le compteur cesse de
            croire la page entiere.
          -->
          <p class="text-xs text-fg-tertiary mb-2">
            {{ listedTripCount() }} trajets affichés sur {{ kpis().tripCount }} —
            affinez la période ou le véhicule pour voir les autres.
            Les indicateurs ci-dessus portent bien sur la période complète.
          </p>
        }
        <div #tripsTable class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
          <table class="w-full text-sm" style="min-width:880px">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-0 text-left">
                  <button type="button" class="rep-th rep-th--left" (click)="onSort('startedAt')">
                    <span>Départ</span>
                    <lucide-icon [img]="sortIcon('startedAt')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('startedAt')"></lucide-icon>
                  </button>
                </th>
                <th class="p-3 text-left">Arrivée</th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('durationSeconds')">
                    <span>Durée</span>
                    <lucide-icon [img]="sortIcon('durationSeconds')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('durationSeconds')"></lucide-icon>
                  </button>
                </th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('distanceMeters')">
                    <span>Distance</span>
                    <lucide-icon [img]="sortIcon('distanceMeters')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('distanceMeters')"></lucide-icon>
                  </button>
                </th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('avgSpeed')">
                    <span>V. moy</span>
                    <lucide-icon [img]="sortIcon('avgSpeed')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('avgSpeed')"></lucide-icon>
                  </button>
                </th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('maxSpeed')">
                    <span>V. max</span>
                    <lucide-icon [img]="sortIcon('maxSpeed')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('maxSpeed')"></lucide-icon>
                  </button>
                </th>
                <th class="p-3 text-left">Conducteur</th>
                <th class="p-3 text-left">Note</th>
                @if (selectedVehicleId()) { <th class="p-3 text-left">Analyse</th> }
                <th class="p-3 text-center">Replay</th>
              </tr>
            </thead>
            <tbody>
              @for (trip of sortedTrips(); track trip.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors"
                    [class.rep-row--highlight]="highlightTripId() === trip.id">
                  <td class="p-3 text-fg-primary">
                    <div>{{ trip.startedAt | date:'dd/MM HH:mm' }}</div>
                    @if (vehiclePlate(trip.vehicleId); as plate) {
                      <div class="text-[10px] font-bold uppercase tracking-wider text-fg-tertiary mt-0.5"
                           [vehicleLink]="trip.vehicleId" [attr.title]="'Voir ' + plate">
                        {{ plate }}
                      </div>
                    }
                    @if (vehicleGroup(trip.vehicleId); as g) {
                      <div class="mt-0.5"><app-group-badge [group]="g" /></div>
                    }
                  </td>
                  <td class="p-3 text-fg-primary">{{ trip.endedAt | date:'dd/MM HH:mm' }}</td>
                  <td class="p-3 text-right font-mono text-fg-secondary">{{ formatDuration(trip.durationSeconds) }}</td>
                  <td class="p-3 text-right font-mono text-fg-secondary">{{ (max0(trip.distanceMeters) / 1000) | number:'1.1-1' }} km</td>
                  <td class="p-3 text-right text-fg-secondary">{{ clampSpeed(trip.avgSpeed) | number:'1.0-0' }}</td>
                  <td class="p-3 text-right text-fg-secondary">{{ clampSpeed(trip.maxSpeed) | number:'1.0-0' }}</td>
                  <td class="p-3 max-w-[180px]">
                    @if (trip.driver) {
                      <button type="button"
                              (click)="canManageDrivers() ? openDriverPickerForTrip(trip) : null"
                              [disabled]="!canManageDrivers()"
                              class="rep-driver"
                              [class.cursor-default]="!canManageDrivers()"
                              [style.--driver-color]="trip.driver.color || '#10E0A0'">
                        <span class="rep-driver-dot"></span>
                        <span class="rep-driver-name">
                          {{ trip.driver.firstName }} {{ trip.driver.lastName }}
                        </span>
                      </button>
                    } @else if (canManageDrivers()) {
                      <button type="button" (click)="openDriverPickerForTrip(trip)"
                              class="rep-driver rep-driver--add">
                        <lucide-icon [img]="UserRoundIcon" [size]="11"></lucide-icon>
                        Assigner
                      </button>
                    } @else {
                      <span class="text-fg-tertiary text-xs">—</span>
                    }
                  </td>
                  <td class="p-3 max-w-[260px]">
                    @if (trip.notes) {
                      <button type="button"
                              (click)="canEditNotes() ? openNoteEdit(trip) : null"
                              [disabled]="!canEditNotes()"
                              [title]="trip.notes"
                              class="rep-note rep-note--filled"
                              [class.cursor-default]="!canEditNotes()">
                        <lucide-icon [img]="MessageSquareIcon" [size]="12"></lucide-icon>
                        <span class="rep-note-text">{{ trip.notes }}</span>
                        @if (canEditNotes()) {
                          <lucide-icon [img]="PencilIcon" [size]="11" class="rep-note-edit-icon"></lucide-icon>
                        }
                      </button>
                    } @else if (canEditNotes()) {
                      <button type="button" (click)="openNoteEdit(trip)" class="rep-note rep-note--add">
                        <lucide-icon [img]="MessageSquareIcon" [size]="12"></lucide-icon>
                        Ajouter
                      </button>
                    } @else {
                      <span class="text-fg-tertiary text-xs">—</span>
                    }
                  </td>
                  @if (selectedVehicleId()) {
                    <td class="p-3 max-w-[280px]">
                      <app-trip-analysis-badges
                        [tripId]="trip.id"
                        [analysis]="analysisFor(trip.id)"
                        (analyzed)="onAnalyzed($event)"
                      />
                    </td>
                  }
                  <td class="p-3 text-center">
                    <div class="flex items-center justify-center gap-1.5">
                      @if (trip.polyline) {
                        <button (click)="openReplay(trip)" class="rep-ligne-action text-tracky-light hover:underline cursor-pointer" title="Replay">
                          <lucide-icon [img]="Play" [size]="16"></lucide-icon>
                        </button>
                      }
                      @if (isAdmin() && trip.maxSpeed > 90) {
                        <button (click)="downloadSpeedReport(trip)"
                                class="text-fg-tertiary hover:text-tracky-light cursor-pointer transition-colors"
                                title="Rapport vitesse">
                          <lucide-icon [img]="FileTextIcon" [size]="14"></lucide-icon>
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <app-trip-replay
      [open]="!!replayTrip()"
      [trip]="replayTrip()"
      [analysis]="replayTrip() ? analysisFor(replayTrip()!.id) : null"
      [vehicleType]="replayVehicleType()"
      [canEditNote]="canEditNotes()"
      (closed)="replayTrip.set(null)"
      (editNote)="onEditNoteFromReplay($event)"
    />

    <app-period-replay
      [open]="periodReplayOpen()"
      [trips]="trips()"
      [vehicleType]="periodReplayVehicleType()"
      [vehiclePlate]="periodReplayPlate()"
      (closed)="periodReplayOpen.set(false)"
    />

    <app-trip-note-modal
      [open]="!!noteEditTrip()"
      [trip]="noteEditTrip()"
      (closed)="noteEditTrip.set(null)"
      (saved)="onNoteSaved($event)"
    />

    <app-driver-picker
      [open]="!!driverPickerTrip()"
      [currentDriverId]="driverPickerTrip()?.driver?.id ?? null"
      title="Reaffecter le conducteur"
      [subtitle]="driverPickerSubtitle()"
      (closed)="driverPickerTrip.set(null)"
      (selected)="onDriverPickedForTrip($event)"
    />

    <app-pdf-export-modal
      [open]="pdfModalOpen()"
      [vehicles]="vehicles()"
      [periodLabel]="pdfPeriodLabel()"
      [loading]="exporting() === 'pdf'"
      (closed)="pdfModalOpen.set(false)"
      (exportRequested)="onPdfExportRequested($event)"
    />
  `,
  styles: [`
    /* ─── Cibles tactiles — ce que la mesure a corrigé dans mon diagnostic ──────
     *
     * La sonde comptait 232 cibles sous 44 px sur cette page, et j'en avais conclu
     * qu'elle appelait la refonte mobile de B1 § D. La mesure dit autre chose :
     *
     *   · 168 de ces 232 sont les CELLULES DE LA CARTE DE CHALEUR (24 h × 7 j, 10 × 11
     *     px chacune). Ce ne sont pas des commandes, ce sont des données. Les porter à
     *     44 px ferait 7 392 px de large sur un écran de 375 : la carte de chaleur
     *     cesserait d'exister. Le critère vise ce qu'on actionne, pas ce qu'on lit.
     *   · le scroll horizontal, lui, est DÉJÀ à zéro — le critère « jamais de scroll
     *     horizontal » est tenu.
     *
     * Restent 64 vraies commandes, corrigées ici. Le vrai sujet de la refonte n'est
     * donc pas le tableau, c'est la carte de chaleur : au doigt, elle demande un
     * drill-down (toucher un jour, puis lire ses heures) plutôt que des cellules
     * qu'aucun pouce ne peut viser. Cela reste à faire, et c'est écrit comme tel. */
    @media (max-width: 768px) {
      .rep-driver, .rep-note, .rep-export-btn, .rep-reset-btn,
      .rep-dropdown-trigger, .rep-th, .rep-periode { min-height: 44px }
      /* L'action de fin de ligne est un pictogramme de 16 px : c'est la SURFACE qui
         doit grandir, pas le dessin. */
      .rep-ligne-action { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center }
      /* Les actions en fin de ligne sont des pictogrammes de 16 px : c'est la surface
         qui doit grandir, pas le dessin. */
      /* Les raccourcis de période portent une classe stable — les utilitaires
         Tailwind ne s'attrapent pas depuis une feuille de styles. */
    }
    /* ─── Sparkline KPI cards ─── */
    .rep-kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    @media (min-width: 1024px) {
      .rep-kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    .rep-kpi-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .rep-kpi-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .rep-kpi-head lucide-icon { color: var(--tracky-light); }
    .rep-kpi-body {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .rep-kpi-value {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: var(--fg-primary);
      line-height: 1;
      letter-spacing: -.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 0 1 auto;
    }
    .rep-kpi-unit {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg-tertiary);
      margin-left: 2px;
    }
    .rep-kpi-meta {
      font-size: 10px;
      font-weight: 500;
      color: var(--fg-tertiary);
      white-space: nowrap;
    }
    .rep-kpi-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 25%, transparent);
      flex-shrink: 0;
      align-self: center;
    }
    .rep-spark {
      width: 84px;
      height: 28px;
      flex-shrink: 0;
      overflow: visible;
    }
    @media (max-width: 380px) {
      .rep-kpi-value { font-size: 18px; }
      .rep-spark { width: 60px; height: 22px; }
    }
    /* KPI cliquable (Vitesse max → drilldown tableau). Reset des defauts <button>
     * + affordance hover/curseur + petite icône de clic. */
    .rep-kpi-card--clickable {
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
      transition: border-color .15s, background .15s, transform .05s;
    }
    .rep-kpi-card--clickable:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--tracky, #10E0A0) 45%, var(--border-subtle));
      background: color-mix(in srgb, var(--tracky, #10E0A0) 6%, var(--bg-secondary));
    }
    .rep-kpi-card--clickable:active:not(:disabled) { transform: translateY(1px); }
    .rep-kpi-card--clickable:disabled { cursor: default; opacity: .75; }
    .rep-kpi-click-hint {
      color: var(--fg-tertiary) !important;
      margin-left: auto;
      opacity: .5;
      transition: opacity .15s, color .15s;
    }
    .rep-kpi-card--clickable:hover:not(:disabled) .rep-kpi-click-hint {
      opacity: 1;
      color: var(--tracky-light) !important;
    }

    /* ─── Charts grid ─── */
    .rep-charts-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }
    @media (min-width: 1024px) {
      .rep-charts-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .rep-chart-card--full { grid-column: 1 / -1; }
    }
    .rep-chart-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px 18px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .rep-chart-head { display: flex; flex-direction: column; gap: 2px; }
    .rep-chart-head h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--fg-primary);
      letter-spacing: -.01em;
    }
    .rep-chart-head p {
      margin: 0;
      font-size: 11px;
      color: var(--fg-tertiary);
    }

    /* ─── Date range personnalisé ─── */
    .rep-custom-wrapper { position: relative; display: inline-block }
    .rep-custom-backdrop {
      position: fixed; inset: 0; z-index: 50;
      background: transparent;
    }
    .rep-custom-panel {
      /* right:0 ancre le panel au bord droit du wrapper "Personnalisé"
       * (qui est en bout de barre filtres) et le fait s'étirer vers la gauche.
       * Évite le débord à droite de la viewport en desktop. Le max-width
       * sécurise le cas où le wrapper serait trop à gauche. */
      position: absolute; top: calc(100% + 8px); right: 0;
      z-index: 51;
      display: grid; grid-template-columns: 160px 1fr;
      width: 600px; max-width: calc(100vw - 24px);
      background: var(--bg-secondary, #0F1714);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
      overflow: hidden;
      animation: rep-custom-pop .2s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes rep-custom-pop {
      from { opacity: 0; transform: translateY(-6px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    /* Tablette (< 768px) : pas de calendrier inline, on garde les inputs
     * natifs → on n'a plus besoin des 600px de large. */
    @media (max-width: 767px) {
      .rep-custom-panel {
        grid-template-columns: 160px 220px;
        width: 380px;
      }
    }
    /* Mobile : repli en colonne unique, ancre en fixed bottom pour eviter
     * tout debordement (le wrapper .rep-custom-wrapper peut etre place
     * n'importe ou dans la barre de filtres horizontale). */
    @media (max-width: 480px) {
      .rep-custom-panel {
        position: fixed;
        top: auto;
        left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom) + 80px);
        grid-template-columns: 1fr;
        width: auto;
      }
      .rep-custom-backdrop {
        background: rgba(0, 0, 0, .35);
      }
    }
    .rep-custom-presets {
      display: flex; flex-direction: column; gap: 2px;
      padding: 12px 8px;
      background: var(--bg-tertiary);
      border-right: 1px solid var(--border-subtle);
    }
    @media (max-width: 480px) {
      .rep-custom-presets { border-right: none; border-bottom: 1px solid var(--border-subtle) }
    }
    .rep-custom-section {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-tertiary);
      padding: 4px 10px; margin: 0 0 4px;
    }
    .rep-custom-preset {
      text-align: left; padding: 8px 10px;
      font-size: 12px; font-weight: 500; color: var(--fg-secondary);
      background: transparent; border: none; border-radius: 8px;
      cursor: pointer; transition: all .15s;
    }
    .rep-custom-preset:hover { background: var(--bg-secondary); color: var(--fg-primary) }
    .rep-custom-preset--active {
      background: rgba(16,224,160,.12); color: var(--tracky-light);
    }
    .rep-custom-fields { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px }
    .rep-custom-field { display: flex; flex-direction: column; gap: 4px }
    .rep-custom-field label {
      font-size: 11px; font-weight: 600; color: var(--fg-tertiary);
    }
    .rep-custom-field input[type="date"] {
      padding: 8px 10px; border-radius: 8px;
      background: var(--bg-tertiary); color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      font-size: 13px; font-family: inherit;
    }
    .rep-custom-field input[type="date"]:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px; border-color: var(--tracky-light, #10E0A0);
    }
    .rep-custom-error {
      font-size: 11px; color: var(--danger); margin: 0;
    }
    .rep-custom-hint {
      font-size: 11px; color: var(--fg-tertiary); margin: 0;
    }
    .rep-custom-actions {
      display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;
    }
    .rep-custom-cancel {
      padding: 7px 12px; border-radius: 8px;
      background: transparent; color: var(--fg-tertiary);
      border: 1px solid var(--border-subtle);
      font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .rep-custom-cancel:hover { color: var(--fg-secondary); border-color: var(--border-strong) }
    .rep-custom-apply {
      padding: 7px 14px; border-radius: 8px;
      background: var(--tracky, #10E0A0); color: var(--accent-ink);
      border: none; font-size: 12px; font-weight: 700; cursor: pointer;
      transition: opacity .15s;
    }
    .rep-custom-apply:disabled { opacity: .5; cursor: not-allowed }
    .rep-custom-apply:not(:disabled):hover { opacity: .92 }

    /* ─── Boutons d'export PDF / CSV ─── */
    .rep-export-group {
      display: inline-flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .rep-export-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-secondary);
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
    }
    .rep-export-btn:hover:not(:disabled) {
      color: var(--fg-primary);
      border-color: var(--border-strong);
      background: var(--bg-tertiary);
    }
    .rep-export-btn:disabled { opacity: .5; cursor: not-allowed }
    .rep-export-btn--pdf {
      color: var(--tracky-light);
      background: rgba(16,224,160,.08);
      border-color: rgba(16,224,160,.22);
    }
    .rep-export-btn--pdf:hover:not(:disabled) {
      background: rgba(16,224,160,.14);
      border-color: rgba(16,224,160,.32);
    }
    /* Excel — teinte verte « tableur » (217954) distincte du tracky. */
    .rep-export-btn--excel {
      color: #34d399;
      background: rgba(33,121,84,.10);
      border-color: rgba(33,121,84,.28);
    }
    .rep-export-btn--excel:hover:not(:disabled) {
      background: rgba(33,121,84,.18);
      border-color: rgba(33,121,84,.40);
    }
    .rep-export-btn--excel lucide-icon { color: #34d399; }
    .rep-export-spin {
      width: 13px; height: 13px;
      border: 2px solid color-mix(in srgb, #34d399 35%, transparent);
      border-top-color: #34d399;
      border-radius: 50%;
      animation: rep-export-spin .7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes rep-export-spin { to { transform: rotate(360deg); } }

    /* ─── Bouton Réinitialiser (filtres) ─── */
    .rep-reset-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-tertiary);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
    }
    .rep-reset-btn lucide-icon { color: var(--fg-tertiary); }
    .rep-reset-btn:hover:not(:disabled) {
      color: var(--fg-primary);
      border-color: var(--border-strong);
      background: var(--bg-secondary);
    }
    .rep-reset-btn:disabled { opacity: .4; cursor: not-allowed; }

    /* ─── Dropdown véhicule custom ─── */
    .rep-dropdown-wrapper {
      position: relative;
      min-width: 0;
    }
    .rep-dropdown-trigger {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      min-width: 180px;
      max-width: 240px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      color: var(--fg-primary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
    }
    .rep-dropdown-trigger:hover { border-color: var(--border-strong) }
    .rep-dropdown-trigger--open {
      border-color: var(--tracky);
      background: var(--bg-tertiary);
    }
    .rep-dropdown-trigger lucide-icon { color: var(--tracky-light); flex-shrink: 0 }
    .rep-dropdown-label {
      flex: 1;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rep-dropdown-chevron {
      transition: transform .2s;
      color: var(--fg-tertiary) !important;
    }
    .rep-dropdown-trigger--open .rep-dropdown-chevron { transform: rotate(180deg) }

    .rep-dropdown-backdrop {
      position: fixed; inset: 0; z-index: 50;
      background: transparent;
    }
    .rep-dropdown-menu {
      position: absolute; top: calc(100% + 6px); left: 0;
      min-width: 240px; max-width: 320px;
      max-height: 320px; overflow-y: auto;
      z-index: 60;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 4px 12px rgba(0,0,0,.08);
      padding: 6px;
      animation: rep-dropdown-pop 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes rep-dropdown-pop {
      from { opacity: 0; transform: translateY(-6px) scale(.98) }
      to   { opacity: 1; transform: translateY(0) scale(1) }
    }
    .rep-dropdown-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      padding: 9px 12px;
      border-radius: 10px;
      background: transparent;
      border: 0;
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: all .12s;
    }
    .rep-dropdown-item:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .rep-dropdown-item--active {
      background: rgba(16,224,160,.10);
      color: var(--tracky-light);
      font-weight: 700;
    }
    .rep-dropdown-item--active lucide-icon { color: var(--tracky-light) }
    .rep-dropdown-item-content {
      display: flex; flex-direction: column;
      min-width: 0; flex: 1;
    }
    .rep-dropdown-item-plate {
      font-family: var(--font-mono, monospace);
      font-weight: 700;
      font-size: 13px;
      color: inherit;
    }
    .rep-dropdown-item-meta {
      font-size: 11px;
      color: var(--fg-tertiary);
      font-weight: 400;
      margin-top: 2px;
    }
    .rep-dropdown-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 6px 4px;
    }

    @media (max-width: 640px) {
      .rep-dropdown-trigger { min-width: 0; max-width: none; flex: 1 }
      .rep-dropdown-menu { left: 0; right: 0; max-width: none }
    }

    /* ─── Cellule note dans la table ─── */
    .rep-note {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      max-width: 100%;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all .15s;
      border: 1px solid transparent;
      background: transparent;
      text-align: left;
    }
    .rep-note--filled {
      background: rgba(16,224,160,.08);
      color: var(--fg-primary);
      border-color: rgba(16,224,160,.18);
    }
    .rep-note--filled:hover:not(:disabled) {
      background: rgba(16,224,160,.14);
      border-color: rgba(16,224,160,.30);
    }
    .rep-note--filled:disabled { cursor: default }
    .rep-note--filled lucide-icon { color: var(--tracky-light); flex-shrink: 0 }
    .rep-note-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 180px;
    }
    .rep-note-edit-icon { color: var(--fg-tertiary) !important; opacity: .7 }

    .rep-note--add {
      color: var(--fg-tertiary);
      border-color: var(--border-subtle);
      border-style: dashed;
    }
    .rep-note--add:hover {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.05);
    }

    /* ─── Cellule conducteur dans la table ─── */
    .rep-driver {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      max-width: 100%;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--driver-color, #10E0A0) 25%, transparent);
      color: var(--fg-primary);
      text-align: left;
    }
    .rep-driver:hover:not(:disabled) {
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 18%, transparent);
      border-color: color-mix(in srgb, var(--driver-color, #10E0A0) 38%, transparent);
    }
    .rep-driver:disabled { cursor: default }
    .rep-driver-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--driver-color, #10E0A0);
      flex-shrink: 0;
    }
    .rep-driver-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 130px;
    }
    .rep-driver--add {
      background: transparent;
      border-color: var(--border-subtle);
      border-style: dashed;
      color: var(--fg-tertiary);
    }
    .rep-driver--add:hover {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.05);
    }
    .rep-driver--add lucide-icon { color: inherit; flex-shrink: 0 }

    /* ─── En-têtes de colonne triables (Sprint 5) ─── */
    .rep-th {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      width: 100%;
      padding: 12px;
      background: transparent;
      border: 0;
      color: inherit;
      font: inherit;
      text-transform: inherit;
      letter-spacing: inherit;
      cursor: pointer;
      transition: color .12s;
    }
    .rep-th--right { justify-content: flex-end; }
    .rep-th--left { justify-content: flex-start; }
    .rep-th:hover { color: var(--fg-secondary); }
    /* Flèche neutre discrète, accentuée quand la colonne est active. */
    .rep-th lucide-icon { opacity: .35; transition: opacity .12s, color .12s; }
    .rep-th:hover lucide-icon { opacity: .6; }
    .rep-th .rep-th-arrow--active { opacity: 1; color: var(--tracky-light); }

    /* ─── Highlight de la ligne ciblée par le clic KPI « Vitesse max » ─── */
    .rep-row--highlight {
      background: color-mix(in srgb, var(--tracky, #10E0A0) 16%, transparent) !important;
      box-shadow: inset 3px 0 0 var(--tracky-light, #10E0A0);
      animation: rep-row-flash 2.4s ease-out;
    }
    @keyframes rep-row-flash {
      0%   { background: color-mix(in srgb, var(--tracky, #10E0A0) 34%, transparent); }
      100% { background: color-mix(in srgb, var(--tracky, #10E0A0) 16%, transparent); }
    }

    /* ─── Synthèse par véhicule (réf. maquette Rapports) ─── */
    .rep-vsum { margin-bottom: 16px; }
    .rep-vsum-head { margin-bottom: 12px; }
    .rep-vtable { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 16px); overflow: hidden; }
    .rep-vt-head, .rep-vrow { display: grid; grid-template-columns: minmax(160px,1.8fr) 1fr 1fr .9fr 1fr 70px; align-items: center; gap: 14px; padding: 12px 18px; }
    .rep-vt-head { background: var(--surface-rail); border-bottom: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-tertiary); }
    .rep-vrow { border-top: 1px solid var(--border-subtle); transition: background .15s; }
    .rep-vrow:hover { background: var(--bg-tertiary); }
    .rep-vveh { min-width: 0; }
    .rep-vplate { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .rep-vmodel { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px; }
    .rep-vdist { font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .rep-vunit { font-size: 10px; font-weight: 600; color: var(--fg-tertiary); }
    .rep-vmeta { font-size: 13px; color: var(--fg-secondary); }
    .rep-vspeed-warn { color: var(--warning); font-weight: 600; }
    .rep-vchev { color: var(--fg-tertiary); justify-self: end; transition: color .15s ease, transform .15s ease; }
    .rep-vrow:hover .rep-vchev { color: var(--tracky-light); transform: translateX(2px); }
    @media (max-width: 1000px) {
      .rep-vt-head, .rep-vrow { grid-template-columns: minmax(140px,1.6fr) 1fr 1fr 70px; }
      .rep-vt-hide { display: none !important; }
    }
  `],
})
export class ReportsComponent implements OnInit, OnDestroy {
  private readonly tripsApi = inject(TripsApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly driversApi = inject(DriversApiService);
  private readonly perms = inject(PermissionsService);
  private readonly authService = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly reportsApi = inject(ReportsApiService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly analysisApi = inject(TripAnalysisApiService);
  protected readonly exporting = signal<null | 'pdf' | 'csv-trips' | 'csv-summary' | 'excel'>(null);

  // Recharge le rapport (KPI/trajets/charts scopés serveur) quand la société change dans
  // le sélecteur global. On saute le 1er run (le chargement initial se fait via ngOnInit).
  private prevFleet: string | null | undefined = undefined;
  private readonly fleetReloadEffect = effect(() => {
    const sel = this.fleetFilter.selectedFleetId();
    if (this.prevFleet === undefined) { this.prevFleet = sel; return; }
    if (sel !== this.prevFleet) {
      this.prevFleet = sel;
      // Un véhicule/groupe choisi peut appartenir à l'ancienne société → on repart sur le
      // rapport « toute la flotte » de la nouvelle société.
      this.selectedVehicleId.set('');
      this.selectedGroupId.set('');
      void this.loadData();
    }
  });

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly trips = signal<TripDto[]>([]);
  protected readonly dailySummary = signal<TripDailySummaryDto[]>([]);
  protected readonly loading = signal(true);
  /**
   * Message de PANNE du chargement, distinct de l'etat « aucun trajet ».
   *
   * ⚠️ Les deux « catch » de loadData() renvoyaient une liste VIDE : une panne serveur, un
   * 403 ou une session expiree s'affichaient donc « Aucun trajet pour cette periode » —
   * la reponse metier d'une periode reellement sans trajet. Le gestionnaire en concluait
   * que ses vehicules n'avaient pas roule.
   */
  protected readonly loadError = signal<string | null>(null);
  protected readonly recomputing = signal(false);
  protected readonly replayTrip = signal<TripDto | null>(null);
  protected readonly noteEditTrip = signal<TripDto | null>(null);
  protected readonly driverPickerTrip = signal<TripDto | null>(null);
  /** Traçabilité fine (Palier 4c) — analyses des trajets du VÉHICULE sélectionné (par tripId). */
  protected readonly analysesMap = signal<Map<string, TripAnalysisDto>>(new Map());
  /** Phase 3 — Modal d'export PDF configurable (perimetre + sections + caps). */
  protected readonly pdfModalOpen = signal(false);

  protected readonly selectedVehicleId = signal('');
  protected periodFrom = '';
  protected periodTo = '';
  /** Signal annexe synchronise avec periodFrom/periodTo (qui ne sont pas des
   * signals pour eviter de casser tous les bindings du template). Sert
   * uniquement aux `computed()` qui ont besoin de reagir aux changements de
   * periode (ex: isCustomRange, customRangeLabel). */
  private readonly periodKey = signal('');

  protected readonly Route = Route;
  protected readonly BarChart3 = BarChart3;
  protected readonly Clock = Clock;
  protected readonly Gauge = Gauge;
  protected readonly Play = Play;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly TruckIcon = Truck;
  protected readonly Check = Check;
  protected readonly LayersIcon = Layers;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;
  protected readonly UserRoundIcon = UserRound;
  protected readonly DownloadIcon = Download;
  protected readonly CalendarIcon = Calendar;
  protected readonly FileTextIcon = FileText;
  protected readonly ArrowUpIcon = ArrowUp;
  protected readonly ArrowDownIcon = ArrowDown;
  protected readonly ArrowUpDownIcon = ArrowUpDown;
  protected readonly FileSpreadsheetIcon = FileSpreadsheet;
  protected readonly RotateCcwIcon = RotateCcw;
  protected readonly MousePointerClickIcon = MousePointerClick;

  // ─── Date range custom ────────────────────────────────────────────────
  protected readonly customRangeOpen = signal(false);
  protected readonly customFrom = signal('');
  protected readonly customTo = signal('');
  /** Aujourd'hui au format YYYY-MM-DD heure LOCALE (limite haute du date picker
   *  + borne no-future). Local pour rester cohérent avec localIso/buildPeriods. */
  protected readonly todayIso = todayIsoLocal();

  /** True quand viewport >= 768px : calendrier inline. Sinon : inputs natifs.
   *  Mis a jour live via matchMedia. */
  protected readonly isDesktop = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  private readonly desktopMql =
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)') : null;
  private readonly desktopMqlListener = (e: MediaQueryListEvent) => this.isDesktop.set(e.matches);

  /** True si periodFrom/periodTo correspondent a une plage custom (et non un preset). */
  protected readonly isCustomRange = computed(() => {
    this.periodKey(); // dependance explicite pour declencher le re-calcul
    if (!this.periodFrom || !this.periodTo) return false;
    return !this.periods.some((p) => p.from === this.periodFrom && p.to === this.periodTo);
  });

  /** Label compact de la plage active (ex: "12 mars → 18 mars"). */
  protected readonly customRangeLabel = computed(() => {
    this.periodKey(); // dependance explicite pour declencher le re-calcul
    if (!this.isCustomRange()) return '';
    try {
      const f = new Date(this.periodFrom);
      const t = new Date(this.periodTo);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      // Le `to` est toujours +1 jour (exclusif) cote periods → on retire 1 jour pour l'affichage.
      const tDisplay = new Date(t.getTime() - 86400000);
      return `${fmt(f)} → ${fmt(tDisplay)}`;
    } catch { return 'Personnalisée'; }
  });

  /**
   * Sprint 5 — Normalisation centralisée de la plage perso (auto-fill +
   * cohérence + no-future + max 365j), déléguée au helper pur testable
   * `normalizeCustomRange` (cf. reports.utils). Réagit à customFrom/customTo.
   */
  protected readonly normalizedCustomRange = computed(() =>
    normalizeCustomRange({ from: this.customFrom(), to: this.customTo() }, this.todayIso),
  );

  /** Validation : retourne le message d'erreur du helper ('' si OK). */
  protected readonly customRangeError = computed(() => this.normalizedCustomRange().error);

  /** True si la plage saisie est applicable (helper). Pilote le bouton Appliquer. */
  protected readonly customRangeValid = computed(() => this.normalizedCustomRange().valid);

  /** Presets dynamiques (calculés au render pour rester relatifs à aujourd'hui). */
  protected readonly customPresets = computed(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 86400000);
    const yesterday = new Date(today.getTime() - 86400000);
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // lundi
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const days7 = new Date(today.getTime() - 7 * 86400000);
    const days30 = new Date(today.getTime() - 30 * 86400000);
    return [
      { label: "Hier", from: iso(yesterday), to: iso(today) },
      { label: "Cette semaine", from: iso(startOfWeek), to: iso(tomorrow) },
      { label: "7 derniers jours", from: iso(days7), to: iso(tomorrow) },
      { label: "30 derniers jours", from: iso(days30), to: iso(tomorrow) },
      { label: "Ce mois-ci", from: iso(startOfMonth), to: iso(tomorrow) },
      { label: "Mois dernier", from: iso(startOfLastMonth), to: iso(endOfLastMonth) },
    ];
  });

  protected applyPreset(preset: { from: string; to: string }): void {
    this.setPeriod(preset.from, preset.to);
    this.customRangeOpen.set(false);
  }

  /**
   * Applique la plage saisie dans les 2 inputs date.
   * Sprint 5 — passe par `normalizeCustomRange` (auto-fill « jusqu'à » =
   * aujourd'hui si vide, clamp no-future, coherence from<=to, max 365j). La
   * plage normalisée est INCLUSIVE → on convertit le `to` en exclusif (+1 jour,
   * convention `periods` existante) avant `setPeriod`. On réinjecte aussi le
   * `to` auto-rempli dans le signal pour que l'UI reflète ce qui a été appliqué.
   */
  protected applyCustomRange(): void {
    const norm = this.normalizedCustomRange();
    if (!norm.valid) return;
    // Si le `to` a été auto-rempli (saisie « from » seule), on le reflète dans
    // l'input pour cohérence visuelle.
    if (norm.to !== this.customTo()) this.customTo.set(norm.to);
    if (norm.from !== this.customFrom()) this.customFrom.set(norm.from);
    const tDate = new Date(`${norm.to}T00:00:00`);
    tDate.setDate(tDate.getDate() + 1);
    const tExclusive = this.localIso(tDate);
    this.setPeriod(norm.from, tExclusive);
    this.customRangeOpen.set(false);
  }

  /** Roles autorises a editer/effacer la note d'un trajet. */
  protected readonly canEditNotes = computed(() => {
    const r = this.authService.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN' || r === 'FLEET_MANAGER';
  });

  /** Roles autorises a (re)affecter un conducteur sur un trajet. */
  protected readonly canManageDrivers = computed(() => {
    const r = this.authService.user()?.role;
    if (r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN') return true;
    if (r === 'FLEET_MANAGER') return this.perms.can('drivers_manage');
    return false;
  });

  /** Sous-titre du picker driver (montre date du trajet pour clarte). */
  protected readonly driverPickerSubtitle = computed(() => {
    const t = this.driverPickerTrip();
    if (!t) return undefined;
    try {
      return `Trajet du ${new Date(t.startedAt).toLocaleString('fr-FR', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })}`;
    } catch { return undefined; }
  });

  protected readonly vehicleDropdownOpen = signal(false);

  /** Label affiché dans le bouton du dropdown selon la sélection courante. */
  protected readonly selectedVehicleLabel = computed(() => {
    const id = this.selectedVehicleId();
    if (!id) return 'Tous les véhicules';
    const v = this.vehicles().find((x) => x.id === id);
    return v?.plate ?? 'Tous les véhicules';
  });

  protected onSelectVehicle(id: string): void {
    this.selectedVehicleId.set(id);
    this.vehicleDropdownOpen.set(false);
    this.loadData();
  }

  /* ─── Filtre groupe (Sprint Groupes) ─── */
  protected readonly selectedGroupId = signal('');
  protected readonly groupDropdownOpen = signal(false);

  /** Groupes distincts présents dans la flotte, dérivés des véhicules chargés. */
  protected readonly groupOptions = computed(() => {
    const map = new Map<string, string>();
    for (const v of this.vehicles()) {
      if (this.fleetFilter.matches(v.fleetId) && v.group) map.set(v.group.id, v.group.name);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Véhicules visibles dans le sélecteur, restreints à la société (SA) puis au groupe filtré. */
  protected readonly visibleVehicles = computed(() => {
    const gid = this.selectedGroupId();
    const all = this.vehicles().filter((v) => this.fleetFilter.matches(v.fleetId));
    return gid ? all.filter((v) => v.group?.id === gid) : all;
  });

  protected readonly selectedGroupLabel = computed(() => {
    const gid = this.selectedGroupId();
    if (!gid) return 'Tous les groupes';
    return this.groupOptions().find((g) => g.id === gid)?.name ?? 'Tous les groupes';
  });

  protected onSelectGroup(id: string): void {
    this.selectedGroupId.set(id);
    this.groupDropdownOpen.set(false);
    // Si le véhicule sélectionné ne fait pas partie du groupe filtré, on revient
    // à « tous les véhicules » (sinon le rapport montrerait un véhicule hors filtre).
    const selV = this.selectedVehicleId();
    if (selV && id && !this.vehicles().some((v) => v.id === selV && v.group?.id === id)) {
      this.selectedVehicleId.set('');
    }
    // Recharge KPI + trajets scopés sur le groupe (ou toute la flotte si « tous »).
    this.loadData();
  }

  /**
   * Sprint 5 — Réinitialise les filtres aux valeurs par défaut : tous groupes,
   * tous véhicules, période « 7 jours ». Ferme les dropdowns / panneaux ouverts
   * et relance le chargement via setPeriod (qui appelle loadData une seule fois).
   */
  protected resetFilters(): void {
    this.selectedGroupId.set('');
    this.selectedVehicleId.set('');
    this.groupDropdownOpen.set(false);
    this.vehicleDropdownOpen.set(false);
    this.customRangeOpen.set(false);
    this.customFrom.set('');
    this.customTo.set('');
    // Realigne les presets (anti-stale) puis applique « 7 jours » (index 1).
    this.periods = this.buildPeriods();
    const sevenDays = this.periods[1]!;
    this.setPeriod(sevenDays.from, sevenDays.to);
  }

  /**
   * Sprint 5 — true si les filtres ne sont PAS sur leurs valeurs par défaut
   * (un groupe ou un véhicule est sélectionné, ou la période n'est pas « 7j »).
   * Pilote l'état visuel/disabled du bouton « Réinitialiser ».
   */
  protected readonly filtersDirty = computed(() => {
    this.periodKey();
    if (this.selectedGroupId() || this.selectedVehicleId()) return true;
    const sevenDays = this.periods[1];
    return !sevenDays || this.periodFrom !== sevenDays.from || this.periodTo !== sevenDays.to;
  });

  /**
   * Sprint 5 — l'export Excel est PAR VÉHICULE : il faut un véhicule précis
   * sélectionné. Sinon le bouton est désactivé avec un hint.
   */
  protected readonly canExportExcel = computed(() => !!this.selectedVehicleId());

  /** Format une Date en YYYY-MM-DD en HEURE LOCALE (pas UTC).
   *  Important : `toISOString()` decale d'1 jour si le user est a UTC+X et qu'on est
   *  proche de minuit. Cela peut envoyer un from/to errone au backend. */
  private localIso(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Recalcule les presets a chaque appel — evite les dates stales en PWA mobile
   *  (le composant peut survivre des heures en arriere-plan ; un periods statique
   *  pointerait alors sur hier apres minuit). */
  private buildPeriods(): { label: string; from: string; to: string }[] {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 86400000);
    const minus7 = new Date(today.getTime() - 7 * 86400000);
    const minus30 = new Date(today.getTime() - 30 * 86400000);
    return [
      { label: 'Aujourd\'hui', from: this.localIso(today), to: this.localIso(tomorrow) },
      { label: '7 jours', from: this.localIso(minus7), to: this.localIso(tomorrow) },
      { label: '30 jours', from: this.localIso(minus30), to: this.localIso(tomorrow) },
    ];
  }

  protected periods = this.buildPeriods();

  /**
   * KPI de la periode — calcules depuis l'AGREGAT SERVEUR.
   *
   * ⚠️ AVANT : `aggregateKpis(this.trips())`, c'est-a-dire la liste AFFICHEE, demandee
   * avec `limit: '100'`. Les trois flottes de production depassent 100 trajets meme sur
   * SEPT jours (622 / 729 / 425), donc les KPI etaient faux en permanence — et surtout
   * IDENTIQUES d'une periode a l'autre, puisqu'on retombait toujours sur les cent
   * derniers trajets. Le filtre de date paraissait casse alors qu'il fonctionnait : le
   * plafond masquait son effet.
   *
   * `dailySummary` est agrege cote serveur sur exactement les memes filtres, sans limite.
   */
  protected readonly kpis = computed(() => aggregateKpisFromDaily(this.dailySummary()));

  /** Nombre de trajets REELLEMENT listes dans le tableau (borne par le plafond). */
  protected readonly listedTripCount = computed(() => this.trips().length);

  /**
   * Vrai quand le tableau ne montre qu'une PARTIE des trajets de la periode.
   *
   * ⚠️ Indispensable depuis que les KPI disent la verite : le compteur annonce 622 et le
   * tableau en affiche 100. Sans cette mention, l'ecart est incomprehensible — et c'est
   * le genre d'incoherence qui fait douter de TOUS les chiffres de la page.
   */
  protected readonly tripsTruncated = computed(
    () => this.kpis().tripCount > this.trips().length,
  );

  // ─── Tri du tableau (Sprint 5, client-side) ─────────────────────────────
  /** Colonne de tri active. Defaut : depart (ordre chronologique inverse). */
  protected readonly sortBy = signal<TripSortColumn>('startedAt');
  /** Direction de tri active. */
  protected readonly sortDir = signal<SortDirection>('desc');
  /** Id du trajet a surligner brievement (clic KPI « Vitesse max »). */
  protected readonly highlightTripId = signal<string | null>(null);
  /** Handle du timer de highlight, nettoye en ngOnDestroy / re-clic. */
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Référence au conteneur du tableau (scroll au clic KPI « Vitesse max »). */
  private readonly tableEl = viewChild<ElementRef<HTMLElement>>('tripsTable');

  /**
   * Trajets affichés dans le tableau, triés en mémoire (~100 lignes déjà
   * chargées → zéro serveur). `trips()` reste la source non triée pour les
   * KPIs / charts / replay (qui n'ont pas besoin d'ordre). Nouvelle référence
   * à chaque tri → re-render Angular.
   */
  protected readonly sortedTrips = computed(() =>
    sortTrips(this.trips(), this.sortBy(), this.sortDir()),
  );

  /**
   * Clic sur un en-tête de colonne : si déjà active → inverse la direction ;
   * sinon active la colonne avec une direction par défaut sensée (date/vitesses/
   * distance/durée = desc d'abord, plus parlant).
   */
  protected onSort(col: TripSortColumn): void {
    if (this.sortBy() === col) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(col);
      this.sortDir.set('desc');
    }
  }

  /** Direction affichée pour la flèche d'un en-tête (null si colonne inactive). */
  protected sortIndicator(col: TripSortColumn): SortDirection | null {
    return this.sortBy() === col ? this.sortDir() : null;
  }

  /** Icône de tri pour un en-tête : flèche directionnelle si actif, sinon
   *  l'icône neutre « triable » (affordance discrète). */
  protected sortIcon(col: TripSortColumn) {
    const dir = this.sortIndicator(col);
    if (dir === 'asc') return this.ArrowUpIcon;
    if (dir === 'desc') return this.ArrowDownIcon;
    return this.ArrowUpDownIcon;
  }

  /**
   * Clic sur la carte KPI « Vitesse max » → trie le tableau par maxSpeed desc,
   * scrolle vers le tableau et surligne brièvement la 1ʳᵉ ligne (le trajet le
   * plus rapide) ~2,5 s. Drilldown KPI→trajet (objectif #4).
   */
  protected onMaxSpeedKpiClick(): void {
    const col = kpiToSortColumn('maxSpeed');
    if (!col) return;
    this.sortBy.set(col);
    this.sortDir.set('desc');
    // La 1ʳᵉ ligne du tri desc = le trajet à la vitesse max.
    const top = this.sortedTrips()[0];
    if (top) this.flashHighlight(top.id);
    // Scroll vers le tableau (après le re-render du tri).
    queueMicrotask(() => {
      this.tableEl()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /** Surligne un trajet ~2,5 s puis retire le highlight. Idempotent. */
  private flashHighlight(tripId: string): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTripId.set(tripId);
    this.highlightTimer = setTimeout(() => {
      this.highlightTripId.set(null);
      this.highlightTimer = null;
    }, 2500);
  }

  // ─── Charts datasets ────────────────────────────────────────────────────
  /** Series journaliere remplie (jours sans trajet a 0) entre periodFrom et
   *  periodTo. Format compact "12 mai" pour l'axe X. */
  protected readonly lineBarData = computed<LineBarChartData>(() => {
    this.periodKey(); // déclenche reactif sur changement de période
    const summary = this.dailySummary();
    const map = new Map(summary.map((s) => [s.date, s]));
    const dates = this.dateRange(this.periodFrom, this.periodTo);
    const fmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' });
    const labels: string[] = [];
    const tripCounts: number[] = [];
    const distancesKm: number[] = [];
    const durationsHours: number[] = [];
    for (const d of dates) {
      const entry = map.get(d);
      labels.push(fmt.format(new Date(d)));
      tripCounts.push(entry?.tripCount ?? 0);
      distancesKm.push(entry ? Math.round(entry.totalDistanceMeters / 100) / 10 : 0);
      durationsHours.push(entry ? Math.round((entry.totalDurationSeconds / 3600) * 100) / 100 : 0);
    }
    return { labels, tripCounts, distancesKm, durationsHours };
  });

  /** Maxspeeds clampes pour l'histogramme (0..250 km/h). Recalcule a chaque
   *  changement de trips() (filtre vehicule, periode). */
  /**
   * Agrégat SERVEUR des deux graphiques de période (vitesses + fréquentation).
   *
   * ⚠️ Ils se calculaient depuis `trips()`, borné à 100 par la requête, tout en
   * s'annonçant « sur la période ». Sur 30 jours et 2 738 trajets, la fréquentation ne
   * couvrait qu'une journée et affichait zéro trajet le mardi, quand le tableau de la
   * même page en comptait 132. Un graphique faux mais dessiné a plus d'autorité qu'un
   * tableau juste — c'est ce qui rendait l'écart si trompeur.
   */
  protected readonly periodCharts = signal<TripPeriodChartsDto | null>(null);

  protected readonly histoValues = computed<number[]>(() => {
    const agg = this.periodCharts();
    // Repli sur l'échantillon tant que l'agrégat n'est pas arrivé (ou s'il a échoué) :
    // un graphique partiel vaut mieux qu'une zone vide, et le titre dit lequel des deux
    // est affiché.
    return agg ? agg.speeds : this.trips().map((t) => this.clampSpeed(t.maxSpeed));
  });

  /** Matrice 7×24 (lun→dim, 0h→23h) du nombre de trajets demarres à cette case horaire. */
  protected readonly heatmapData = computed<number[][]>(() => {
    const agg = this.periodCharts();
    if (agg) return agg.heatmap;
    const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const t of this.trips()) {
      if (!t.startedAt) continue;
      const d = new Date(t.startedAt);
      // Convention FR/ISO : lundi = 0, dimanche = 6
      const day = (d.getDay() + 6) % 7;
      const hour = d.getHours();
      if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
        matrix[day]![hour]! += 1;
      }
    }
    return matrix;
  });

  // ─── Sparkline KPI cards ────────────────────────────────────────────────
  /** Bars sparkline pour le KPI Trajets. Prend les 7 derniers jours du
   *  dailySummary (pas les 7 derniers de la periode, juste les 7 dernieres
   *  entrees ayant des donnees). */
  protected readonly sparkTripBars = computed(() => {
    const ds = this.dailySummary().slice(-7);
    if (ds.length === 0) return [];
    const max = Math.max(1, ...ds.map((s) => s.tripCount));
    const w = 84;
    const h = 28;
    const gap = 2;
    const barW = (w - gap * (ds.length - 1)) / ds.length;
    return ds.map((s, i) => {
      const ratio = s.tripCount / max;
      const barH = ratio * (h - 2);
      return {
        x: i * (barW + gap),
        y: h - Math.max(2, barH),
        w: barW,
        h: Math.max(2, barH),
      };
    });
  });

  /** Path SVG de la sparkline distance cumulee (toute la periode). */
  protected readonly sparkDistancePath = computed(() => {
    const ds = this.dailySummary();
    if (ds.length === 0) return '';
    const w = 84;
    const h = 28;
    let cumul = 0;
    const points = ds.map((s) => {
      cumul += s.totalDistanceMeters / 1000;
      return cumul;
    });
    const min = points[0]!;
    const max = points[points.length - 1]!;
    const range = max - min || 1;
    const stepX = ds.length > 1 ? w / (ds.length - 1) : w;
    let path = '';
    for (let i = 0; i < points.length; i++) {
      const x = i * stepX;
      const y = h - ((points[i]! - min) / range) * (h - 2) - 1;
      path += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return path;
  });

  /** Path SVG du fill sous la ligne (zone). */
  protected readonly sparkDistanceFillPath = computed(() => {
    const linePath = this.sparkDistancePath();
    if (!linePath) return '';
    return `${linePath} L84,28 L0,28 Z`;
  });

  /** Duree moyenne par jour AYANT eu au moins un trajet. Plus parlant que
   *  une moyenne sur toute la periode (qui serait diluee par les jours off). */
  protected readonly avgDurationPerActiveDay = computed(() => {
    const ds = this.dailySummary();
    if (ds.length === 0) return '0min';
    const total = ds.reduce((a, b) => a + b.totalDurationSeconds, 0);
    return this.formatDuration(Math.round(total / ds.length));
  });

  /** Couleur du dot vitesse selon les seuils du marker live (cf
   *  shared/utils/maplibre-markers.ts speedColor). */
  protected readonly speedDotColor = computed(() => {
    const max = this.kpis().maxSpeed;
    if (max < 90) return '#10E0A0';
    if (max < 110) return '#F59E0B';
    return '#EF4444';
  });

  protected readonly speedDotLabel = computed(() => {
    const max = this.kpis().maxSpeed;
    if (max < 90) return 'Allure modérée';
    if (max < 110) return 'Vitesse soutenue';
    return 'Survitesse détectée';
  });

  /** Genere la liste des dates [from, to) au format YYYY-MM-DD. Cap a 90
   *  jours pour que le chart reste lisible. */
  private dateRange(from: string, to: string): string[] {
    if (!from || !to) return [];
    const out: string[] = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    const cur = new Date(start);
    while (cur < end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    if (out.length > 90) return out.slice(-90);
    return out;
  }

  /** Delegue a `reports.utils#max0` (verrouille par tests). */
  protected max0(n: number): number {
    return max0Fn(n);
  }

  /** Delegue a `reports.utils#clampSpeed` (verrouille par tests). */
  protected clampSpeed(n: number): number {
    return clampSpeedFn(n);
  }

  /**
   * Resout la plaque d'un vehicule à partir de son id, via la liste deja
   * chargee `vehicles()`. Retourne `null` si non trouve (vehicule pas encore
   * charge ou supprime). Affiche dans le tableau sous la date de depart.
   */
  protected vehiclePlate(vehicleId: string | null | undefined): string | null {
    if (!vehicleId) return null;
    const v = this.vehicles().find((x) => x.id === vehicleId);
    return v?.plate ?? null;
  }

  /** Groupe du véhicule d'un trajet, résolu depuis la liste déjà chargée. */
  protected vehicleGroup(vehicleId: string | null | undefined): { id: string; name: string } | null {
    if (!vehicleId) return null;
    return this.vehicles().find((x) => x.id === vehicleId)?.group ?? null;
  }

  /** Marque + modèle d'un véhicule (ligne secondaire du tableau par véhicule). */
  protected vehicleModelLabel(vehicleId: string): string {
    const v = this.vehicles().find((x) => x.id === vehicleId);
    if (!v) return '—';
    return [v.brand, v.model].filter(Boolean).join(' ') || '—';
  }

  /**
   * Synthèse PAR VÉHICULE de la période (réf. maquette Rapports) : agrège les
   * trajets déjà chargés (distance / conduite / nb trajets / vitesse moy). Vue
   * complémentaire du tableau détaillé par trajet — n'enlève rien, ajoute un
   * rollup lisible. Triée par distance décroissante.
   */
  protected readonly vehicleSummary = computed(() => {
    const by = new Map<string, { vehicleId: string; distance: number; duration: number; trips: number; speedSum: number }>();
    for (const t of this.trips()) {
      if (!t.vehicleId) continue;
      const e = by.get(t.vehicleId) ?? { vehicleId: t.vehicleId, distance: 0, duration: 0, trips: 0, speedSum: 0 };
      e.distance += this.max0(t.distanceMeters);
      e.duration += t.durationSeconds || 0;
      e.trips += 1;
      e.speedSum += this.clampSpeed(t.avgSpeed);
      by.set(t.vehicleId, e);
    }
    return [...by.values()]
      .map((e) => ({
        vehicleId: e.vehicleId,
        distance: e.distance,
        duration: e.duration,
        trips: e.trips,
        avgSpeed: e.trips ? Math.round(e.speedSum / e.trips) : 0,
      }))
      .sort((a, b) => b.distance - a.distance);
  });

  // ─── Period replay ────────────────────────────────────────────────────
  /** Modal replay-periode ouverte ? Toggled par `onOpenPeriodReplay`. */
  protected readonly periodReplayOpen = signal(false);

  /** Vrai si on peut lancer un replay periode (vehicule selectionne + au
   *  moins 1 trip dans la periode). */
  protected readonly canPeriodReplay = computed(() => {
    if (!this.selectedVehicleId()) return false;
    return this.trips().length > 0;
  });

  /** Type vehicule pour le marker du period-replay. */
  protected readonly periodReplayVehicleType = computed(() => {
    const id = this.selectedVehicleId();
    if (!id) return 'OTHER';
    const v = this.vehicles().find((x) => x.id === id);
    return v?.type ?? 'OTHER';
  });

  /** Plaque du vehicule selectionne, pour le badge dans le HUD du replay. */
  protected readonly periodReplayPlate = computed<string | null>(() => {
    const id = this.selectedVehicleId();
    if (!id) return null;
    const v = this.vehicles().find((x) => x.id === id);
    return v?.plate ?? null;
  });

  protected onOpenPeriodReplay(): void {
    if (!this.canPeriodReplay()) return;
    this.periodReplayOpen.set(true);
  }

  protected readonly replayVehicleType = computed(() => {
    const trip = this.replayTrip();
    if (!trip) return 'OTHER';
    const v = this.vehicles().find((v) => v.id === trip.vehicleId);
    return v?.type ?? 'OTHER';
  });

  protected readonly isAdmin = computed(() => {
    const role = this.authService.user()?.role;
    return role === 'SUPER_ADMIN' || role === 'FLEET_ADMIN';
  });

  ngOnInit(): void {
    // V1.12 — Default = "7 jours" (periods[1]) au lieu de "Aujourd'hui"
    // (periods[0]) : la majorite des flottes n'ont pas encore de trajets en
    // debut de journee, ce qui rendait la page Reports vide a l'ouverture
    // (impression d'UI cassee). 7j montre du contenu immediatement.
    this.setPeriod(this.periods[1]!.from, this.periods[1]!.to);
    this.loadVehicles();
    this.desktopMql?.addEventListener('change', this.desktopMqlListener);
  }

  ngOnDestroy(): void {
    this.desktopMql?.removeEventListener('change', this.desktopMqlListener);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
  }

  /** Ferme le panel custom à Escape (cf. a11y picker calendrier). */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.customRangeOpen()) this.customRangeOpen.set(false);
  }

  protected setPeriod(from: string, to: string): void {
    this.periodFrom = from;
    this.periodTo = to;
    this.periodKey.set(`${from}|${to}`);
    this.loadData();
  }

  /** Si la periode active est un preset stale (ex: PWA restee ouverte apres minuit),
   *  on la realigne sur le preset frais correspondant avant export. */
  private refreshPeriodIfStalePreset(): void {
    const fresh = this.buildPeriods();
    const matchedStale = this.periods.findIndex(
      (p) => p.from === this.periodFrom && p.to === this.periodTo,
    );
    this.periods = fresh;
    if (matchedStale >= 0) {
      const refreshed = fresh[matchedStale]!;
      this.periodFrom = refreshed.from;
      this.periodTo = refreshed.to;
      this.periodKey.set(`${refreshed.from}|${refreshed.to}`);
    }
  }

  /** Label "01 mai → 20 mai · 20 jours" affiche en sous-titre de la modal PDF. */
  protected readonly pdfPeriodLabel = computed(() => {
    this.periodKey();
    if (!this.periodFrom || !this.periodTo) return '';
    try {
      const fDate = new Date(this.periodFrom);
      // 'to' est exclusif (+1 jour cote periods) — on retire 1 jour pour l'affichage.
      const tDate = new Date(new Date(this.periodTo).getTime() - 86400000);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      const days = Math.max(1, Math.round((tDate.getTime() - fDate.getTime()) / 86400000) + 1);
      return `${fmt(fDate)} → ${fmt(tDate)} · ${days} jour${days > 1 ? 's' : ''}`;
    } catch {
      return '';
    }
  });

  /** Ouvre la modal de configuration PDF. Le download lui-meme est declenche
   *  par `onPdfExportRequested` quand l'utilisateur valide ses choix. */
  protected onExportPdf(): void {
    if (this.exporting()) return;
    this.refreshPeriodIfStalePreset();
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export PDF', 'Période invalide — recharge la page.');
      return;
    }
    this.pdfModalOpen.set(true);
  }

  /** Recoit la config emise par la modal et declenche le download POST. */
  protected async onPdfExportRequested(req: PdfExportRequest): Promise<void> {
    if (this.exporting()) return;
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export PDF', 'Période invalide — recharge la page.');
      return;
    }
    this.exporting.set('pdf');
    try {
      await this.reportsApi.downloadConfiguredPdf(
        this.fleetFilter.selectedFleetId(),
        this.periodFrom,
        this.periodTo,
        {
          vehicleIds: req.vehicleIds,
          sections: req.sections,
          maxTrips: req.maxTrips,
          topN: req.topN,
        },
      );
      this.toast.success('PDF généré');
      this.pdfModalOpen.set(false);
    } catch (err) {
      this.toast.error('Échec export PDF', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(null);
    }
  }

  /** Export CSV — `kind` détermine le contenu (trips: liste de trajets, alerts: liste d'alertes). */
  protected async onExportCsv(kind: 'trips' | 'alerts'): Promise<void> {
    if (this.exporting()) return;
    this.refreshPeriodIfStalePreset();
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export CSV', 'Période invalide — recharge la page.');
      return;
    }
    this.exporting.set(kind === 'trips' ? 'csv-trips' : 'csv-summary');
    try {
      await this.reportsApi.downloadCsv(kind, this.fleetFilter.selectedFleetId(), this.periodFrom, this.periodTo);
      this.toast.success(kind === 'trips' ? 'CSV trajets téléchargé' : 'CSV alertes téléchargé');
    } catch (err) {
      this.toast.error('Échec export CSV', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(null);
    }
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE. Désactivé (gardé) si aucun
   * véhicule précis n'est sélectionné. Réutilise le pattern `exporting` (spinner)
   * + `downloadExcel` côté service. La période courante (to déjà exclusif) borne
   * l'export.
   */
  protected async onExportExcel(): Promise<void> {
    if (this.exporting()) return;
    const vehicleId = this.selectedVehicleId();
    if (!vehicleId) {
      this.toast.error('Export Excel', 'Sélectionnez un véhicule pour exporter.');
      return;
    }
    this.refreshPeriodIfStalePreset();
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export Excel', 'Période invalide — recharge la page.');
      return;
    }
    this.exporting.set('excel');
    try {
      await this.reportsApi.downloadExcel(vehicleId, this.periodFrom, this.periodTo);
      this.toast.success('Excel généré');
    } catch (err) {
      this.toast.error('Échec export Excel', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(null);
    }
  }

  /**
   * Charge l'agrégat des graphiques de période.
   *
   * ⚠️ Le garde anti-course (`seq`) est le MÊME que celui de `loadData` : sans lui, la
   * réponse d'une période abandonnée pourrait repeindre les graphiques d'une période
   * plus récente — et l'écran afficherait des chiffres justes à côté de courbes fausses,
   * ce qui est plus difficile à repérer que deux écrans faux.
   *
   * ⚠️ La liste est VIDÉE avant l'appel : garder l'ancienne pendant le chargement
   * afficherait les vitesses de la période précédente sous le nouveau titre.
   */
  private async loadPeriodCharts(seq: number, params: Record<string, string>): Promise<void> {
    this.periodCharts.set(null);
    try {
      const agg = await firstValueFrom(this.tripsApi.periodCharts(params));
      if (seq !== this.loadSeq) return;
      this.periodCharts.set(agg);
    } catch (err) {
      // Non bloquant : le repli sur l'échantillon prend le relais, et le titre le dit.
      // La panne part quand même au centre d'alerte — un graphique qui se dégrade en
      // silence redeviendrait invisible, ce que tout ce lot corrige.
      swallow('reports:loadPeriodCharts', err);
    }
  }

  /** #40 — sequence anti-race : une reponse perimee ne doit pas ecraser une fraiche. */
  private loadSeq = 0;

  protected async loadData(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    try {
      const id = this.selectedVehicleId();
      const gid = this.selectedGroupId();
      const tripParams: Record<string, string> = { limit: '100' };
      const summaryParams: Record<string, string> = {};
      if (id) {
        tripParams['vehicleId'] = id;
        summaryParams['vehicleId'] = id;
      } else if (gid) {
        // Filtre groupe sans véhicule unique → scope les KPI/trajets sur les véhicules du groupe.
        const ids = this.visibleVehicles().map((v) => v.id).join(',');
        if (ids) {
          tripParams['vehicleIds'] = ids;
          summaryParams['vehicleIds'] = ids;
        }
      }
      // Filtre société GLOBAL (sélecteur super-admin) : scope le rapport entier (KPI + trajets
      // + charts) à la flotte choisie, côté serveur (les agrégats ne sont pas filtrables client).
      const fleet = this.fleetFilter.selectedFleetId();
      if (fleet) {
        tripParams['fleetId'] = fleet;
        summaryParams['fleetId'] = fleet;
      }
      if (this.periodFrom) {
        tripParams['from'] = this.periodFrom;
        summaryParams['from'] = this.periodFrom;
      }
      if (this.periodTo) {
        tripParams['to'] = this.periodTo;
        summaryParams['to'] = this.periodTo;
      }

      // Fetch trips + daily summary en parallele : meme periode, meme vehicule.
      // Si l'un fail, l'autre peut quand meme alimenter ses charts — mais on RETIENT
      // l'echec au lieu de le deguiser en liste vide.
      //
      // ⚠️ Ces deux `.catch()` renvoyaient un resultat vide SANS trace : l'ecran affichait
      // « Aucun trajet pour cette periode », c'est-a-dire une reponse metier plausible,
      // pour une panne serveur ou une session expiree. Une panne muette qui ressemble a
      // une reponse valide est pire qu'une erreur affichee : personne ne la signale.
      let failure: unknown = null;
      const [tripsRes, summary] = await Promise.all([
        firstValueFrom(this.tripsApi.list(tripParams)).catch(
          (err: unknown) => { failure ??= err; return { items: [] as TripDto[], nextCursor: null }; },
        ),
        firstValueFrom(this.tripsApi.dailySummary(summaryParams)).catch(
          (err: unknown) => { failure ??= err; return [] as TripDailySummaryDto[]; },
        ),
      ]);
      // #40 — une requete plus recente a ete lancee entre-temps : on ignore ce
      // resultat perime (sinon une reponse lente ecrase des donnees plus fraiches).
      if (seq !== this.loadSeq) return;
      this.loadError.set(failure ? httpFailureMessage(failure, 'les trajets') : null);
      this.trips.set(tripsRes.items);
      this.dailySummary.set(summary);
      // Agrégat des deux graphiques de période. Chargé À PART et sans bloquer : il porte
      // le confort (deux graphiques), pas les chiffres — les KPI viennent du résumé
      // journalier. Un échec ici laisse l'écran utilisable, avec le repli sur
      // l'échantillon, annoncé comme tel par le titre.
      void this.loadPeriodCharts(seq, summaryParams);
      // Traçabilité fine (P4c) : les badges d'analyse ne s'affichent QUE pour un véhicule choisi
      // (sinon les trajets couvrent plusieurs véhicules, pas de chargement en lot possible).
      void this.loadAnalyses(seq);
    } catch (err) {
      swallow('reports:loadData', err);
      if (seq === this.loadSeq) {
        this.trips.set([]);
        this.dailySummary.set([]);
        this.loadError.set(httpFailureMessage(err, 'les trajets'));
      }
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /** Charge en lot les analyses du véhicule sélectionné (vide sinon). Best-effort, non bloquant. */
  private async loadAnalyses(seq: number): Promise<void> {
    const vId = this.selectedVehicleId();
    if (!vId) { this.analysesMap.set(new Map()); return; }
    try {
      const list = await firstValueFrom(this.analysisApi.listForVehicle(vId, 200));
      if (seq === this.loadSeq) this.analysesMap.set(new Map(list.map((a) => [a.tripId, a])));
    } catch (err) {
      swallow('reports:loadAnalyses', err);
      if (seq === this.loadSeq) this.analysesMap.set(new Map());
    }
  }

  protected analysisFor(tripId: string): TripAnalysisDto | null {
    return this.analysesMap().get(tripId) ?? null;
  }

  protected onAnalyzed(a: TripAnalysisDto): void {
    this.analysesMap.update((m) => { const n = new Map(m); n.set(a.tripId, a); return n; });
  }

  protected openReplay(trip: TripDto): void {
    this.replayTrip.set(trip);
  }

  protected async downloadSpeedReport(trip: TripDto): Promise<void> {
    try {
      await this.reportsApi.downloadSpeedAnalysis(trip.id);
    } catch {
      // Silently fail — the user will see no file downloaded.
    }
  }

  protected openNoteEdit(trip: TripDto): void {
    this.noteEditTrip.set(trip);
  }

  /**
   * Met a jour la ligne dans la table apres save reussi (sans re-fetch).
   * Le modal s'occupe de fermer lui-meme via `(closed)`.
   * Si on edite la note du trip en train d'etre rejoue, on rafraichit aussi
   * le trip courant du replay pour que le bandeau se mette a jour.
   */
  protected onNoteSaved(updated: TripDto): void {
    this.trips.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
    const replay = this.replayTrip();
    if (replay && replay.id === updated.id) {
      this.replayTrip.set(updated);
    }
  }

  /**
   * Quand le user clique sur "modifier la note" depuis le replay, on ouvre
   * le modal de note. On laisse le replay ouvert en arriere-plan : c'est
   * intentionnel — on a un overlay au-dessus de l'autre.
   */
  protected onEditNoteFromReplay(trip: TripDto): void {
    this.noteEditTrip.set(trip);
  }

  protected openDriverPickerForTrip(trip: TripDto): void {
    if (!this.canManageDrivers()) return;
    this.driverPickerTrip.set(trip);
  }

  /**
   * Reaffectation du conducteur sur un trip. driver=null => retire.
   * Met a jour la ligne dans la table sans re-fetch + le replay si même trip.
   */
  protected async onDriverPickedForTrip(driver: DriverDto | null): Promise<void> {
    const trip = this.driverPickerTrip();
    if (!trip) return;
    this.driverPickerTrip.set(null);
    try {
      const updated = await firstValueFrom(
        this.driversApi.assignToTrip(trip.id, driver?.id ?? null),
      );
      this.trips.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
      const replay = this.replayTrip();
      if (replay && replay.id === updated.id) this.replayTrip.set(updated);
      this.toast.success(
        driver ? 'Conducteur affecte' : 'Conducteur retire',
        driver ? `${driver.firstName} ${driver.lastName}` : '',
      );
    } catch (err) {
      swallow('reports:onDriverPickedForTrip', err);
      this.toast.error('Échec affectation', err instanceof Error ? err.message : '');
    }
  }

  protected async onRecompute(): Promise<void> {
    const id = this.selectedVehicleId();
    if (!id || !this.periodFrom || !this.periodTo) return;
    this.recomputing.set(true);
    try {
      const res = await firstValueFrom(this.tripsApi.recompute({
        vehicleId: id,
        from: this.periodFrom,
        to: this.periodTo,
      }));
      this.toast.success(`Recalcul terminé`, `${res.deleted} supprimés, ${res.created} créés`);
      await this.loadData();
    } catch (err) {
      swallow('reports:onRecompute', err); this.toast.error('Échec du recalcul'); }
    finally { this.recomputing.set(false); }
  }

  /** Delegue a `reports.utils#formatDuration` (verrouille par tests). */
  protected formatDuration(seconds: number): string {
    return formatDurationFn(seconds);
  }

  private async loadVehicles(): Promise<void> {
    try {
      const list = await firstValueFrom(this.vehiclesApi.list());
      this.vehicles.set(list);
    } catch (err) {
      // silent
      swallow('reports:loadVehicles', err);
    }
  }
}
