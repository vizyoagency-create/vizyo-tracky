import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, BarChart3, Route, Clock, Gauge, Play, ChevronDown, Truck, Check, MessageSquare, Pencil, UserRound, Download, Calendar, FileText, Layers, ArrowUp, ArrowDown, ArrowUpDown, FileSpreadsheet, RotateCcw, MousePointerClick } from 'lucide-angular';
import type { DriverDto, TripDailySummaryDto, TripDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { DriversApiService } from '../../core/services/drivers.service';
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
  aggregateKpis,
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
    LucideAngularModule,
    TrackClickDirective,
    GroupBadgeComponent,
    DatePipe,
    DecimalPipe,
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
                  class="px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer"
                  [class]="periodFrom === p.from && periodTo === p.to && !isCustomRange()
                    ? 'bg-tracky/20 text-tracky-light border-tracky/30'
                    : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
            {{ p.label }}
          </button>
        }

        <!-- Pill personnalise — ouvre un panel avec presets + 2 inputs date -->
        <div class="rep-custom-wrapper">
          <button type="button"
                  (click)="customRangeOpen.set(!customRangeOpen())"
                  class="px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer inline-flex items-center gap-1.5"
                  [class]="isCustomRange()
                    ? 'bg-tracky/20 text-tracky-light border-tracky/30'
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
                  <div class="rep-custom-field">
                    <label>Du</label>
                    <input type="date" [(ngModel)]="customFrom" [max]="customTo()" />
                  </div>
                  <div class="rep-custom-field">
                    <label>Au</label>
                    <input type="date" [(ngModel)]="customTo" [min]="customFrom()" [max]="todayIso" />
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
                class="px-3 py-1.5 text-xs rounded-lg border border-tracky/30
                       bg-tracky/10 text-tracky-light hover:bg-tracky/20
                       transition-colors cursor-pointer disabled:opacity-40
                       inline-flex items-center gap-1.5">
          <lucide-icon [img]="Play" [size]="12"></lucide-icon>
          Replay période
        </button>

        @if (isAdmin()) {
          <button (click)="onRecompute()" [disabled]="!selectedVehicleId() || recomputing()"
                  class="px-3 py-1.5 text-xs rounded-lg border border-amber-500/30
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

          <section class="rep-chart-card">
            <header class="rep-chart-head">
              <h2>Vitesses max</h2>
              <p>Distribution sur la période</p>
            </header>
            <app-histogram-chart [values]="histoValues()" [height]="220" />
          </section>

          <section class="rep-chart-card">
            <header class="rep-chart-head">
              <h2>Fréquentation</h2>
              <p>24h × 7j</p>
            </header>
            <app-heatmap-chart [data]="heatmapData()" />
          </section>
        </div>
      }

      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (trips().length === 0) {
        <div class="flex items-center justify-center h-32 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary">
          Aucun trajet pour cette période
        </div>
      } @else {
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
                      <div class="text-[10px] font-bold uppercase tracking-wider text-fg-tertiary mt-0.5">
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
                  <td class="p-3 text-center">
                    <div class="flex items-center justify-center gap-1.5">
                      @if (trip.polyline) {
                        <button (click)="openReplay(trip)" class="text-tracky-light hover:underline cursor-pointer" title="Replay">
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
  protected readonly exporting = signal<null | 'pdf' | 'csv-trips' | 'csv-summary' | 'excel'>(null);

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly trips = signal<TripDto[]>([]);
  protected readonly dailySummary = signal<TripDailySummaryDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly recomputing = signal(false);
  protected readonly replayTrip = signal<TripDto | null>(null);
  protected readonly noteEditTrip = signal<TripDto | null>(null);
  protected readonly driverPickerTrip = signal<TripDto | null>(null);
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

  protected readonly kpis = computed(() => aggregateKpis(this.trips()));

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
  protected readonly histoValues = computed<number[]>(() =>
    this.trips().map((t) => this.clampSpeed(t.maxSpeed)),
  );

  /** Matrice 7×24 (lun→dim, 0h→23h) du nombre de trajets demarres a cette
   *  case horaire. */
  protected readonly heatmapData = computed<number[][]>(() => {
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
   * Resout la plaque d'un vehicule a partir de son id, via la liste deja
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
        null,
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
      await this.reportsApi.downloadCsv(kind, null, this.periodFrom, this.periodTo);
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
      if (this.periodFrom) {
        tripParams['from'] = this.periodFrom;
        summaryParams['from'] = this.periodFrom;
      }
      if (this.periodTo) {
        tripParams['to'] = this.periodTo;
        summaryParams['to'] = this.periodTo;
      }

      // Fetch trips + daily summary en parallele : meme periode, meme vehicule.
      // Si l'un fail, l'autre peut quand meme alimenter ses charts.
      const [tripsRes, summary] = await Promise.all([
        firstValueFrom(this.tripsApi.list(tripParams)).catch(
          () => ({ items: [] as TripDto[], nextCursor: null }),
        ),
        firstValueFrom(this.tripsApi.dailySummary(summaryParams)).catch(
          () => [] as TripDailySummaryDto[],
        ),
      ]);
      // #40 — une requete plus recente a ete lancee entre-temps : on ignore ce
      // resultat perime (sinon une reponse lente ecrase des donnees plus fraiches).
      if (seq !== this.loadSeq) return;
      this.trips.set(tripsRes.items);
      this.dailySummary.set(summary);
    } catch {
      if (seq === this.loadSeq) {
        this.trips.set([]);
        this.dailySummary.set([]);
      }
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
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
   * Met a jour la ligne dans la table sans re-fetch + le replay si meme trip.
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
      this.toast.error('Echec affectation', err instanceof Error ? err.message : '');
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
    } catch { this.toast.error('Échec du recalcul'); }
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
    } catch { /* silent */ }
  }
}
