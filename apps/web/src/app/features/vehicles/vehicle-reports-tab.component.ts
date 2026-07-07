import { ChangeDetectionStrategy, Component, computed, HostListener, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  BarChart3, Calendar, Clock, Download, Gauge, LucideAngularModule,
  MessageSquare, Pencil, Play, Route, UserRound,
} from 'lucide-angular';
import type { DriverDto, TripAnalysisDto, TripDailySummaryDto, TripDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DriversApiService } from '../../core/services/drivers.service';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { TripAnalysisBadgesComponent } from '../trip-analysis/trip-analysis-badges.component';
import { PermissionsService } from '../../core/services/permissions.service';
import { ReportsApiService } from '../../core/services/reports.service';
import { TripsApiService } from '../../core/services/trips.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DriverPickerComponent } from '../../shared/ui/driver-picker/driver-picker.component';
import { TripNoteModalComponent } from '../../shared/ui/trip-note-modal/trip-note-modal.component';
import { DateRangePickerComponent } from '../../shared/ui/date-range-picker/date-range-picker.component';
import { HeatmapChartComponent } from '../../shared/ui/charts/heatmap-chart.component';
import { HistogramChartComponent } from '../../shared/ui/charts/histogram-chart.component';
import { LineBarChartComponent, type LineBarChartData } from '../../shared/ui/charts/line-bar-chart.component';
import { PeriodReplayComponent } from '../reports/period-replay.component';
import { TripReplayComponent } from '../reports/trip-replay.component';
import {
  aggregateKpis,
  clampSpeed as clampSpeedFn,
  formatDuration as formatDurationFn,
  max0 as max0Fn,
} from '../reports/reports.utils';
import { relativeTime } from '../../shared/utils/relative-time';

/**
 * Onglet "Rapports" affiche dans `vehicle-detail`. Reprend visuellement la
 * page /reports (KPI + sparklines + 3 graphes) mais focalise sur UN seul
 * vehicule : pas de selecteur vehicule (deja contextualise), export PDF
 * pre-filtre sur ce vehicule, et liste des trajets en cards (plutot qu'en
 * table — la card s'adapte mieux a la largeur disponible et conserve la
 * coherence avec le reste de la page detail).
 *
 * Etat autonome : ce composant fetch ses propres trips + dailySummary
 * et gere sa propre plage temporelle (decouple de l'onglet "Historique"
 * du parent qui a sa propre logique positions).
 */
@Component({
  selector: 'app-vehicle-reports-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, LucideAngularModule, DatePipe, DecimalPipe,
    TripReplayComponent, PeriodReplayComponent,
    TripNoteModalComponent, DriverPickerComponent, DateRangePickerComponent,
    LineBarChartComponent, HistogramChartComponent, HeatmapChartComponent,
    TripAnalysisBadgesComponent,
  ],
  template: `
    <div class="flex flex-col gap-4 sm:gap-5">
      <!-- Barre d'actions : presets periode + custom + export + replay -->
      <div class="vrt-actionbar">
        <div class="vrt-period-pills">
          @for (p of periods; track p.label) {
            <button (click)="setPeriod(p.from, p.to); customRangeOpen.set(false)"
                    class="vrt-pill"
                    [class.vrt-pill--active]="periodFrom === p.from && periodTo === p.to && !isCustomRange()">
              {{ p.label }}
            </button>
          }
          <div class="vrt-custom-wrapper">
            <button type="button"
                    (click)="customRangeOpen.set(!customRangeOpen())"
                    class="vrt-pill vrt-pill--custom"
                    [class.vrt-pill--active]="isCustomRange()">
              <lucide-icon [img]="CalendarIcon" [size]="12"></lucide-icon>
              @if (isCustomRange()) { {{ customRangeLabel() }} } @else { Personnalisé }
            </button>
            @if (customRangeOpen()) {
              <div class="vrt-custom-backdrop" (click)="customRangeOpen.set(false)"></div>
              <div class="vrt-custom-panel" role="dialog" aria-label="Période personnalisée">
                <div class="vrt-custom-presets">
                  <p class="vrt-custom-section">Raccourcis</p>
                  @for (pr of customPresets(); track pr.label) {
                    <button type="button" (click)="applyPreset(pr)"
                            class="vrt-custom-preset"
                            [class.vrt-custom-preset--active]="periodFrom === pr.from && periodTo === pr.to">
                      {{ pr.label }}
                    </button>
                  }
                </div>
                <div class="vrt-custom-fields">
                  <p class="vrt-custom-section">Plage personnalisée</p>
                  @if (isDesktop()) {
                    <app-date-range-picker
                      [from]="customFrom()"
                      [to]="customTo()"
                      [max]="todayIso"
                      (fromChange)="customFrom.set($event)"
                      (toChange)="customTo.set($event)"
                    />
                  } @else {
                    <div class="vrt-custom-field">
                      <label>Du</label>
                      <input type="date" [(ngModel)]="customFromModel" [max]="customTo()"
                             (ngModelChange)="customFrom.set($event)" />
                    </div>
                    <div class="vrt-custom-field">
                      <label>Au</label>
                      <input type="date" [(ngModel)]="customToModel" [min]="customFrom()" [max]="todayIso"
                             (ngModelChange)="customTo.set($event)" />
                    </div>
                  }
                  @if (customRangeError(); as err) {
                    <p class="vrt-custom-error">{{ err }}</p>
                  }
                  <div class="vrt-custom-actions">
                    <button type="button" (click)="customRangeOpen.set(false)" class="vrt-custom-cancel">Annuler</button>
                    <button type="button"
                            (click)="applyCustomRange()"
                            [disabled]="!!customRangeError() || !customFrom() || !customTo()"
                            class="vrt-custom-apply">
                      Appliquer
                    </button>
                  </div>
                </div>
              </div>
            }
          </div>
        </div>

        <div class="vrt-actions-right">
          <button type="button" (click)="onExportPdf()" [disabled]="exporting()"
                  class="vrt-export-btn"
                  title="Exporter un rapport PDF pour ce véhicule">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() ? 'Export…' : 'PDF' }}</span>
          </button>
          <button type="button" (click)="onOpenPeriodReplay()"
                  [disabled]="!canPeriodReplay()"
                  [title]="canPeriodReplay() ? 'Replay des trajets de la période'
                                              : 'Aucun trajet sur la période'"
                  class="vrt-replay-btn">
            <lucide-icon [img]="Play" [size]="12"></lucide-icon>
            <span>Replay</span>
          </button>
        </div>
      </div>

      <!-- KPI cards (4 cards, 2 cols mobile / 4 cols desktop) -->
      <div class="vrt-kpi-grid">
        <div class="vrt-kpi-card">
          <div class="vrt-kpi-head">
            <lucide-icon [img]="Route" [size]="14"></lucide-icon>
            <span>Trajets</span>
          </div>
          <div class="vrt-kpi-body">
            <p class="vrt-kpi-value">{{ kpis().tripCount }}</p>
            @if (sparkTripBars().length > 0) {
              <svg class="vrt-spark" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">
                @for (b of sparkTripBars(); track $index) {
                  <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h"
                        fill="var(--tracky-light)" rx="1.5" />
                }
              </svg>
            }
          </div>
        </div>

        <div class="vrt-kpi-card">
          <div class="vrt-kpi-head">
            <lucide-icon [img]="BarChart3" [size]="14"></lucide-icon>
            <span>Distance</span>
          </div>
          <div class="vrt-kpi-body">
            <p class="vrt-kpi-value">
              {{ (kpis().totalDistance / 1000) | number:'1.1-1' }}
              <span class="vrt-kpi-unit">km</span>
            </p>
            @if (sparkDistancePath()) {
              <svg class="vrt-spark" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">
                <path [attr.d]="sparkDistanceFillPath()" fill="rgba(16,224,160,0.14)" stroke="none" />
                <path [attr.d]="sparkDistancePath()" fill="none" stroke="var(--tracky-light)"
                      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            }
          </div>
        </div>

        <div class="vrt-kpi-card">
          <div class="vrt-kpi-head">
            <lucide-icon [img]="Clock" [size]="14"></lucide-icon>
            <span>Durée totale</span>
          </div>
          <div class="vrt-kpi-body">
            <p class="vrt-kpi-value">{{ formatDuration(kpis().totalDuration) }}</p>
            <span class="vrt-kpi-meta">~{{ avgDurationPerActiveDay() }} / jour actif</span>
          </div>
        </div>

        <div class="vrt-kpi-card">
          <div class="vrt-kpi-head">
            <lucide-icon [img]="Gauge" [size]="14"></lucide-icon>
            <span>Vitesse max</span>
          </div>
          <div class="vrt-kpi-body">
            <p class="vrt-kpi-value">
              {{ kpis().maxSpeed | number:'1.0-0' }}
              <span class="vrt-kpi-unit">km/h</span>
            </p>
            <span class="vrt-kpi-dot" [style.background]="speedDotColor()"
                  [attr.title]="speedDotLabel()" [attr.aria-label]="speedDotLabel()"></span>
          </div>
        </div>
      </div>

      <!-- Charts grid (line+bar full, histogram + heatmap) -->
      @if (!loading() && trips().length > 0) {
        <div class="vrt-charts-grid">
          <section class="vrt-chart-card vrt-chart-card--full">
            <header class="vrt-chart-head">
              <h2>Activité</h2>
              <p>Distance &amp; trajets par jour</p>
            </header>
            <app-line-bar-chart [data]="lineBarData()" [height]="220" />
          </section>

          <section class="vrt-chart-card">
            <header class="vrt-chart-head">
              <h2>Vitesses max</h2>
              <p>Distribution sur la période</p>
            </header>
            <app-histogram-chart [values]="histoValues()" [height]="200" />
          </section>

          <section class="vrt-chart-card">
            <header class="vrt-chart-head">
              <h2>Fréquentation</h2>
              <p>24h × 7j</p>
            </header>
            <app-heatmap-chart [data]="heatmapData()" />
          </section>
        </div>
      }

      <!-- Liste des trajets en cards -->
      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (trips().length === 0) {
        <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2 text-center px-4">
          <lucide-icon [img]="Route" [size]="48" class="opacity-30"></lucide-icon>
          <p>Aucun trajet sur cette période</p>
        </div>
      } @else {
        <div class="vrt-trips-list">
          @for (trip of trips(); track trip.id) {
            <article class="vrt-trip-card">
              <header class="vrt-trip-head">
                <div class="vrt-trip-period">
                  <span class="vrt-trip-date">{{ trip.startedAt | date:'dd MMM' }}</span>
                  <span class="vrt-trip-times">
                    {{ trip.startedAt | date:'HH:mm' }}
                    @if (trip.endedAt) {
                      → {{ trip.endedAt | date:'HH:mm' }}
                    } @else {
                      <span class="vrt-trip-live">· en cours</span>
                    }
                  </span>
                </div>
                <div class="vrt-trip-distance">
                  <strong>{{ (max0(trip.distanceMeters) / 1000) | number:'1.1-1' }}</strong>
                  <span class="vrt-trip-distance-unit">km</span>
                </div>
              </header>

              <div class="vrt-trip-stats">
                <div class="vrt-trip-stat">
                  <span class="vrt-trip-stat-label">Durée</span>
                  <span class="vrt-trip-stat-value">{{ formatDuration(trip.durationSeconds) }}</span>
                </div>
                <div class="vrt-trip-stat">
                  <span class="vrt-trip-stat-label">V. max</span>
                  <span class="vrt-trip-stat-value vrt-trip-stat-value--max">
                    {{ clampSpeed(trip.maxSpeed) | number:'1.0-0' }} km/h
                  </span>
                </div>
                <div class="vrt-trip-stat">
                  <span class="vrt-trip-stat-label">V. moy.</span>
                  <span class="vrt-trip-stat-value">
                    {{ clampSpeed(trip.avgSpeed) | number:'1.0-0' }} km/h
                  </span>
                </div>
              </div>

              <!-- Traçabilité fine (Palier 4) : arrêts, excès de vitesse, éco-conduite, conso. -->
              <app-trip-analysis-badges
                [tripId]="trip.id"
                [analysis]="analysisFor(trip.id)"
                (analyzed)="onAnalyzed($event)"
              />

              <footer class="vrt-trip-footer">
                <div class="vrt-trip-footer-left">
                  @if (trip.driver) {
                    <button type="button"
                            (click)="canManageDrivers() ? openDriverPickerForTrip(trip) : null"
                            [disabled]="!canManageDrivers()"
                            class="vrt-trip-driver"
                            [class.cursor-default]="!canManageDrivers()"
                            [style.--driver-color]="trip.driver.color || '#10E0A0'"
                            [title]="trip.driverSource === 'AUTO' ? 'Conducteur snape automatiquement.' : 'Conducteur assigné manuellement.'">
                      <span class="vrt-trip-driver-dot"></span>
                      <span class="vrt-trip-driver-name">
                        {{ trip.driver.firstName }} {{ trip.driver.lastName }}
                      </span>
                    </button>
                  } @else if (canManageDrivers()) {
                    <button type="button" (click)="openDriverPickerForTrip(trip)"
                            class="vrt-trip-driver vrt-trip-driver--add">
                      <lucide-icon [img]="UserRoundIcon" [size]="11"></lucide-icon>
                      Conducteur
                    </button>
                  }

                  @if (trip.notes) {
                    <button type="button"
                            (click)="canEditNotes() ? openNoteEdit(trip) : null"
                            [disabled]="!canEditNotes()"
                            [title]="trip.notes"
                            class="vrt-trip-note vrt-trip-note--filled"
                            [class.cursor-default]="!canEditNotes()">
                      <lucide-icon [img]="MessageSquareIcon" [size]="11"></lucide-icon>
                      <span class="vrt-trip-note-text">{{ trip.notes }}</span>
                      @if (canEditNotes()) {
                        <lucide-icon [img]="PencilIcon" [size]="10" class="vrt-trip-note-edit"></lucide-icon>
                      }
                    </button>
                  } @else if (canEditNotes()) {
                    <button type="button" (click)="openNoteEdit(trip)"
                            class="vrt-trip-note vrt-trip-note--add">
                      <lucide-icon [img]="MessageSquareIcon" [size]="11"></lucide-icon>
                      Note
                    </button>
                  }
                </div>

                @if (trip.polyline) {
                  <button type="button" (click)="openReplay(trip)"
                          class="vrt-trip-replay-btn"
                          title="Replay du trajet">
                    <lucide-icon [img]="Play" [size]="13"></lucide-icon>
                    <span>Replay</span>
                  </button>
                }
              </footer>
            </article>
          }
        </div>
      }
    </div>

    <!-- Modals partages -->
    <app-trip-replay
      [open]="!!replayTrip()"
      [trip]="replayTrip()"
      [analysis]="replayTrip() ? analysisFor(replayTrip()!.id) : null"
      [vehicleType]="vehicleType()"
      [canEditNote]="canEditNotes()"
      (closed)="replayTrip.set(null)"
      (editNote)="onEditNoteFromReplay($event)"
    />

    <app-period-replay
      [open]="periodReplayOpen()"
      [trips]="trips()"
      [vehicleType]="vehicleType()"
      [vehiclePlate]="vehiclePlate()"
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
      title="Réaffecter le conducteur"
      [subtitle]="driverPickerSubtitle()"
      (closed)="driverPickerTrip.set(null)"
      (selected)="onDriverPickedForTrip($event)"
    />
  `,
  styles: [`
    /* ─── Action bar (pills periode + actions droite) ─── */
    .vrt-actionbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .vrt-period-pills {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
      flex: 1;
    }
    .vrt-pill {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 10px;
      background: var(--bg-tertiary);
      color: var(--fg-tertiary);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .vrt-pill:hover { color: var(--fg-secondary); border-color: var(--border-strong); }
    .vrt-pill--active {
      background: rgba(16,224,160,.18);
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
    }
    .vrt-pill--active:hover { color: var(--tracky-light); }
    .vrt-actions-right {
      display: inline-flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .vrt-export-btn,
    .vrt-replay-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 10px;
      cursor: pointer;
      transition: all .15s;
      white-space: nowrap;
    }
    .vrt-export-btn {
      color: var(--tracky-light);
      background: rgba(16,224,160,.08);
      border: 1px solid rgba(16,224,160,.22);
    }
    .vrt-export-btn:hover:not(:disabled) {
      background: rgba(16,224,160,.14);
      border-color: rgba(16,224,160,.32);
    }
    .vrt-export-btn:disabled { opacity: .5; cursor: not-allowed; }
    .vrt-replay-btn {
      color: var(--tracky-light);
      background: rgba(16,224,160,.10);
      border: 1px solid rgba(16,224,160,.30);
    }
    .vrt-replay-btn:hover:not(:disabled) {
      background: rgba(16,224,160,.20);
    }
    .vrt-replay-btn:disabled { opacity: .4; cursor: not-allowed; }

    /* ─── Date range custom (panel) ─── */
    .vrt-custom-wrapper { position: relative; display: inline-block; }
    .vrt-custom-backdrop {
      position: fixed; inset: 0; z-index: 50;
      background: transparent;
    }
    .vrt-custom-panel {
      position: absolute; top: calc(100% + 8px); left: 0;
      z-index: 51;
      display: grid; grid-template-columns: 160px 1fr;
      width: 560px; max-width: calc(100vw - 24px);
      background: var(--bg-secondary, #0F1714);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
      overflow: hidden;
      animation: vrt-custom-pop .2s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes vrt-custom-pop {
      from { opacity: 0; transform: translateY(-6px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    @media (max-width: 767px) {
      .vrt-custom-panel {
        grid-template-columns: 150px 220px;
        width: 370px;
      }
    }
    @media (max-width: 480px) {
      .vrt-custom-panel {
        position: fixed;
        top: auto; left: 12px; right: 12px;
        bottom: calc(env(safe-area-inset-bottom) + 80px);
        grid-template-columns: 1fr;
        width: auto;
      }
      .vrt-custom-backdrop { background: rgba(0, 0, 0, .35); }
    }
    .vrt-custom-presets {
      display: flex; flex-direction: column; gap: 2px;
      padding: 12px 8px;
      background: var(--bg-tertiary);
      border-right: 1px solid var(--border-subtle);
    }
    @media (max-width: 480px) {
      .vrt-custom-presets { border-right: none; border-bottom: 1px solid var(--border-subtle); }
    }
    .vrt-custom-section {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-tertiary);
      padding: 4px 10px; margin: 0 0 4px;
    }
    .vrt-custom-preset {
      text-align: left; padding: 8px 10px;
      font-size: 12px; font-weight: 500; color: var(--fg-secondary);
      background: transparent; border: none; border-radius: 8px;
      cursor: pointer; transition: all .15s;
    }
    .vrt-custom-preset:hover { background: var(--bg-secondary); color: var(--fg-primary); }
    .vrt-custom-preset--active {
      background: rgba(16,224,160,.12); color: var(--tracky-light);
    }
    .vrt-custom-fields { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
    .vrt-custom-field { display: flex; flex-direction: column; gap: 4px; }
    .vrt-custom-field label {
      font-size: 11px; font-weight: 600; color: var(--fg-tertiary);
    }
    .vrt-custom-field input[type="date"] {
      padding: 8px 10px; border-radius: 8px;
      background: var(--bg-tertiary); color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      font-size: 13px; font-family: inherit;
    }
    .vrt-custom-field input[type="date"]:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px; border-color: var(--tracky-light, #10E0A0);
    }
    .vrt-custom-error { font-size: 11px; color: #f87171; margin: 0; }
    .vrt-custom-actions {
      display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;
    }
    .vrt-custom-cancel {
      padding: 7px 12px; border-radius: 8px;
      background: transparent; color: var(--fg-tertiary);
      border: 1px solid var(--border-subtle);
      font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .vrt-custom-cancel:hover { color: var(--fg-secondary); border-color: var(--border-strong); }
    .vrt-custom-apply {
      padding: 7px 14px; border-radius: 8px;
      background: var(--tracky, #10E0A0); color: white;
      border: none; font-size: 12px; font-weight: 700; cursor: pointer;
      transition: opacity .15s;
    }
    .vrt-custom-apply:disabled { opacity: .5; cursor: not-allowed; }
    .vrt-custom-apply:not(:disabled):hover { opacity: .92; }

    /* ─── KPI cards (sparklines) ─── */
    .vrt-kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    @media (min-width: 1024px) {
      .vrt-kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    .vrt-kpi-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .vrt-kpi-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .vrt-kpi-head lucide-icon { color: var(--tracky-light); }
    .vrt-kpi-body {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .vrt-kpi-value {
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
    .vrt-kpi-unit {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg-tertiary);
      margin-left: 2px;
    }
    .vrt-kpi-meta {
      font-size: 10px;
      font-weight: 500;
      color: var(--fg-tertiary);
      white-space: nowrap;
    }
    .vrt-kpi-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 25%, transparent);
      flex-shrink: 0;
      align-self: center;
    }
    .vrt-spark {
      width: 84px;
      height: 28px;
      flex-shrink: 0;
      overflow: visible;
    }
    @media (max-width: 380px) {
      .vrt-kpi-value { font-size: 18px; }
      .vrt-spark { width: 60px; height: 22px; }
    }

    /* ─── Charts grid ─── */
    .vrt-charts-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    @media (min-width: 1024px) {
      .vrt-charts-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .vrt-chart-card--full { grid-column: 1 / -1; }
    }
    .vrt-chart-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 16px 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .vrt-chart-head { display: flex; flex-direction: column; gap: 2px; }
    .vrt-chart-head h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--fg-primary);
      letter-spacing: -.01em;
    }
    .vrt-chart-head p {
      margin: 0;
      font-size: 11px;
      color: var(--fg-tertiary);
    }

    /* ─── Trip cards ─── */
    .vrt-trips-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .vrt-trip-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      transition: border-color .15s;
    }
    .vrt-trip-card:hover { border-color: var(--border-strong); }
    .vrt-trip-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .vrt-trip-period { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .vrt-trip-date {
      font-size: 11px;
      font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .vrt-trip-times {
      font-size: 14px;
      font-weight: 700;
      color: var(--fg-primary);
      font-family: var(--font-mono, monospace);
      margin-top: 2px;
    }
    .vrt-trip-live { color: var(--tracky-light); font-weight: 600; }
    .vrt-trip-distance {
      display: flex;
      align-items: baseline;
      gap: 3px;
      flex-shrink: 0;
    }
    .vrt-trip-distance strong {
      font-size: 22px;
      font-weight: 800;
      color: var(--tracky-light);
      font-family: var(--font-display, Poppins, sans-serif);
      letter-spacing: -.02em;
    }
    .vrt-trip-distance-unit { font-size: 11px; color: var(--fg-tertiary); font-weight: 600; }
    .vrt-trip-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--border-subtle);
    }
    .vrt-trip-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .vrt-trip-stat-label {
      font-size: 9px;
      font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .vrt-trip-stat-value {
      font-size: 13px;
      font-weight: 700;
      color: var(--fg-primary);
    }
    .vrt-trip-stat-value--max { color: #f59e0b; }

    .vrt-trip-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      padding-top: 10px;
      border-top: 1px solid var(--border-subtle);
    }
    .vrt-trip-footer-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
      flex: 1;
    }

    .vrt-trip-driver {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      max-width: 200px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--driver-color, #10E0A0) 30%, transparent);
      color: var(--fg-primary);
    }
    .vrt-trip-driver:hover:not(:disabled) {
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 20%, transparent);
      border-color: color-mix(in srgb, var(--driver-color, #10E0A0) 42%, transparent);
    }
    .vrt-trip-driver:disabled { cursor: default; }
    .vrt-trip-driver-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--driver-color, #10E0A0);
      flex-shrink: 0;
    }
    .vrt-trip-driver-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .vrt-trip-driver--add {
      background: transparent;
      border-color: var(--border-subtle);
      border-style: dashed;
      color: var(--fg-tertiary);
    }
    .vrt-trip-driver--add:hover {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.05);
    }
    .vrt-trip-driver--add lucide-icon { flex-shrink: 0; }

    .vrt-trip-note {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      max-width: 240px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all .15s;
      border: 1px solid transparent;
      background: transparent;
      text-align: left;
    }
    .vrt-trip-note--filled {
      background: rgba(16,224,160,.08);
      color: var(--fg-primary);
      border-color: rgba(16,224,160,.18);
    }
    .vrt-trip-note--filled:hover:not(:disabled) {
      background: rgba(16,224,160,.14);
      border-color: rgba(16,224,160,.30);
    }
    .vrt-trip-note--filled:disabled { cursor: default; }
    .vrt-trip-note--filled lucide-icon { color: var(--tracky-light); flex-shrink: 0; }
    .vrt-trip-note-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 160px;
    }
    .vrt-trip-note-edit { color: var(--fg-tertiary) !important; opacity: .7; }
    .vrt-trip-note--add {
      color: var(--fg-tertiary);
      border-color: var(--border-subtle);
      border-style: dashed;
    }
    .vrt-trip-note--add:hover {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.05);
    }

    .vrt-trip-replay-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      background: var(--bg-tertiary);
      color: var(--tracky-light);
      border: 1px solid rgba(16,224,160,.22);
      cursor: pointer;
      transition: all .15s;
      flex-shrink: 0;
    }
    .vrt-trip-replay-btn:hover {
      background: rgba(16,224,160,.10);
      border-color: rgba(16,224,160,.38);
    }
  `],
})
export class VehicleReportsTabComponent implements OnInit, OnDestroy {
  private readonly tripsApi = inject(TripsApiService);
  private readonly driversApi = inject(DriversApiService);
  private readonly reportsApi = inject(ReportsApiService);
  private readonly analysisApi = inject(TripAnalysisApiService);
  private readonly perms = inject(PermissionsService);
  private readonly authService = inject(AuthService);
  private readonly toast = inject(ToastService);

  /** ID du vehicule dont on affiche le rapport. */
  readonly vehicleId = input.required<string>();
  /** Plaque (affichee dans le HUD du period-replay). */
  readonly vehiclePlate = input.required<string>();
  /** Type vehicule (pour le marker du replay). */
  readonly vehicleType = input.required<string>();

  protected readonly trips = signal<TripDto[]>([]);
  protected readonly dailySummary = signal<TripDailySummaryDto[]>([]);
  /** Analyses de trajets pré-chargées en LOT (par tripId) — badges éco/excès/arrêts sur chaque card. */
  protected readonly analysesMap = signal<Map<string, TripAnalysisDto>>(new Map());
  protected readonly loading = signal(true);
  protected readonly exporting = signal(false);
  protected readonly replayTrip = signal<TripDto | null>(null);
  protected readonly noteEditTrip = signal<TripDto | null>(null);
  protected readonly driverPickerTrip = signal<TripDto | null>(null);
  protected readonly periodReplayOpen = signal(false);

  protected periodFrom = '';
  protected periodTo = '';
  /** Signal annexe synchronise avec periodFrom/periodTo pour les `computed`. */
  private readonly periodKey = signal('');

  /** Etat du panel date personnalise. */
  protected readonly customRangeOpen = signal(false);
  protected readonly customFrom = signal('');
  protected readonly customTo = signal('');
  /** Mirrors pour ngModel mobile (sync via (ngModelChange)). */
  protected customFromModel = '';
  protected customToModel = '';
  protected readonly todayIso = new Date().toISOString().slice(0, 10);

  /** Switch desktop / mobile pour le date range picker. */
  protected readonly isDesktop = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  private readonly desktopMql =
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)') : null;
  private readonly desktopMqlListener = (e: MediaQueryListEvent) => this.isDesktop.set(e.matches);

  protected readonly BarChart3 = BarChart3;
  protected readonly CalendarIcon = Calendar;
  protected readonly Clock = Clock;
  protected readonly DownloadIcon = Download;
  protected readonly Gauge = Gauge;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;
  protected readonly Play = Play;
  protected readonly Route = Route;
  protected readonly UserRoundIcon = UserRound;
  protected readonly relativeTime = relativeTime;

  // ─── Permissions ─────────────────────────────────────────────────────────
  protected readonly canEditNotes = computed(() => {
    const r = this.authService.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN' || r === 'FLEET_MANAGER';
  });

  protected readonly canManageDrivers = computed(() => {
    const r = this.authService.user()?.role;
    if (r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN') return true;
    if (r === 'FLEET_MANAGER') return this.perms.can('drivers_manage');
    return false;
  });

  // ─── Periodes presets ───────────────────────────────────────────────────
  /** Construit a la volee pour rester relatif a aujourd'hui (PWA peut rester
   *  ouverte des heures, un periods statique pointerait sur hier apres minuit). */
  private buildPeriods(): { label: string; from: string; to: string }[] {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 86400000);
    const minus7 = new Date(today.getTime() - 7 * 86400000);
    const minus30 = new Date(today.getTime() - 30 * 86400000);
    return [
      { label: "Aujourd'hui", from: this.localIso(today), to: this.localIso(tomorrow) },
      { label: '7 jours', from: this.localIso(minus7), to: this.localIso(tomorrow) },
      { label: '30 jours', from: this.localIso(minus30), to: this.localIso(tomorrow) },
    ];
  }

  protected periods = this.buildPeriods();

  /** Plage active = preset ? */
  protected readonly isCustomRange = computed(() => {
    this.periodKey();
    if (!this.periodFrom || !this.periodTo) return false;
    return !this.periods.some((p) => p.from === this.periodFrom && p.to === this.periodTo);
  });

  protected readonly customRangeLabel = computed(() => {
    this.periodKey();
    if (!this.isCustomRange()) return '';
    try {
      const f = new Date(this.periodFrom);
      const t = new Date(this.periodTo);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      const tDisplay = new Date(t.getTime() - 86400000);
      return `${fmt(f)} → ${fmt(tDisplay)}`;
    } catch { return 'Personnalisée'; }
  });

  protected readonly customRangeError = computed(() => {
    const f = this.customFrom();
    const t = this.customTo();
    if (!f || !t) return '';
    if (f > t) return 'La date de début doit être antérieure à la date de fin.';
    if (t > this.todayIso) return 'La date de fin ne peut pas être dans le futur.';
    const days = Math.round((new Date(t).getTime() - new Date(f).getTime()) / 86400000);
    if (days > 365) return 'La plage ne peut pas dépasser 365 jours.';
    return '';
  });

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
      { label: 'Hier', from: iso(yesterday), to: iso(today) },
      { label: 'Cette semaine', from: iso(startOfWeek), to: iso(tomorrow) },
      { label: '7 derniers jours', from: iso(days7), to: iso(tomorrow) },
      { label: '30 derniers jours', from: iso(days30), to: iso(tomorrow) },
      { label: 'Ce mois-ci', from: iso(startOfMonth), to: iso(tomorrow) },
      { label: 'Mois dernier', from: iso(startOfLastMonth), to: iso(endOfLastMonth) },
    ];
  });

  // ─── KPIs ────────────────────────────────────────────────────────────────
  protected readonly kpis = computed(() => aggregateKpis(this.trips()));

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

  protected readonly avgDurationPerActiveDay = computed(() => {
    const ds = this.dailySummary();
    if (ds.length === 0) return '0min';
    const total = ds.reduce((a, b) => a + b.totalDurationSeconds, 0);
    return this.formatDuration(Math.round(total / ds.length));
  });

  // ─── Charts datasets ────────────────────────────────────────────────────
  protected readonly lineBarData = computed<LineBarChartData>(() => {
    this.periodKey();
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

  protected readonly histoValues = computed<number[]>(() =>
    this.trips().map((t) => this.clampSpeed(t.maxSpeed)),
  );

  protected readonly heatmapData = computed<number[][]>(() => {
    const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const t of this.trips()) {
      if (!t.startedAt) continue;
      const d = new Date(t.startedAt);
      const day = (d.getDay() + 6) % 7;
      const hour = d.getHours();
      if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
        matrix[day]![hour]! += 1;
      }
    }
    return matrix;
  });

  // ─── Sparklines KPI ─────────────────────────────────────────────────────
  protected readonly sparkTripBars = computed(() => {
    const ds = this.dailySummary().slice(-7);
    if (ds.length === 0) return [];
    const max = Math.max(1, ...ds.map((s) => s.tripCount));
    const w = 84, h = 28, gap = 2;
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

  protected readonly sparkDistancePath = computed(() => {
    const ds = this.dailySummary();
    if (ds.length === 0) return '';
    const w = 84, h = 28;
    let cumul = 0;
    const points = ds.map((s) => { cumul += s.totalDistanceMeters / 1000; return cumul; });
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

  protected readonly sparkDistanceFillPath = computed(() => {
    const linePath = this.sparkDistancePath();
    if (!linePath) return '';
    return `${linePath} L84,28 L0,28 Z`;
  });

  // ─── Period replay ──────────────────────────────────────────────────────
  protected readonly canPeriodReplay = computed(() => this.trips().length > 0);

  protected readonly driverPickerSubtitle = computed(() => {
    const t = this.driverPickerTrip();
    if (!t) return undefined;
    try {
      return `Trajet du ${new Date(t.startedAt).toLocaleString('fr-FR', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })}`;
    } catch { return undefined; }
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.setPeriod(this.periods[0]!.from, this.periods[0]!.to);
    this.desktopMql?.addEventListener('change', this.desktopMqlListener);
  }

  ngOnDestroy(): void {
    this.desktopMql?.removeEventListener('change', this.desktopMqlListener);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.customRangeOpen()) this.customRangeOpen.set(false);
  }

  // ─── Periode ─────────────────────────────────────────────────────────────
  protected setPeriod(from: string, to: string): void {
    this.periodFrom = from;
    this.periodTo = to;
    this.periodKey.set(`${from}|${to}`);
    this.loadData();
  }

  protected applyPreset(preset: { from: string; to: string }): void {
    this.setPeriod(preset.from, preset.to);
    this.customRangeOpen.set(false);
  }

  /** Applique la plage saisie. Le `to` est exclusif cote API (convention
   *  +1 jour comme dans reports) → on incremente le jour saisi par le user. */
  protected applyCustomRange(): void {
    if (this.customRangeError()) return;
    const f = this.customFrom();
    const t = this.customTo();
    if (!f || !t) return;
    const tDate = new Date(t);
    tDate.setDate(tDate.getDate() + 1);
    const tExclusive = tDate.toISOString().slice(0, 10);
    this.setPeriod(f, tExclusive);
    this.customRangeOpen.set(false);
  }

  /** Helper : format date en YYYY-MM-DD en heure LOCALE (pas UTC) pour eviter
   *  les decalages d'1 jour au changement de fuseau. */
  private localIso(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Genere les dates [from, to[ au format YYYY-MM-DD, cape a 90 jours. */
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

  // ─── Data loading ───────────────────────────────────────────────────────
  private async loadData(): Promise<void> {
    this.loading.set(true);
    try {
      const tripParams: Record<string, string> = {
        vehicleId: this.vehicleId(),
        limit: '100',
      };
      const summaryParams: Record<string, string> = {
        vehicleId: this.vehicleId(),
      };
      if (this.periodFrom) {
        tripParams['from'] = this.periodFrom;
        summaryParams['from'] = this.periodFrom;
      }
      if (this.periodTo) {
        tripParams['to'] = this.periodTo;
        summaryParams['to'] = this.periodTo;
      }
      const [tripsRes, summary] = await Promise.all([
        firstValueFrom(this.tripsApi.list(tripParams)).catch(
          () => ({ items: [] as TripDto[], nextCursor: null }),
        ),
        firstValueFrom(this.tripsApi.dailySummary(summaryParams)).catch(
          () => [] as TripDailySummaryDto[],
        ),
      ]);
      this.trips.set(tripsRes.items);
      this.dailySummary.set(summary);
      // Analyses de trajets pré-chargées en LOT (best-effort, non bloquant) → badges sur les cards.
      void this.loadAnalyses();
    } catch {
      this.trips.set([]);
      this.dailySummary.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /** Charge en une fois les analyses persistées du véhicule (les cards non analysées gardent leur bouton). */
  private async loadAnalyses(): Promise<void> {
    try {
      const list = await firstValueFrom(this.analysisApi.listForVehicle(this.vehicleId(), 200));
      this.analysesMap.set(new Map(list.map((a) => [a.tripId, a])));
    } catch {
      this.analysesMap.set(new Map());
    }
  }

  protected analysisFor(tripId: string): TripAnalysisDto | null {
    return this.analysesMap().get(tripId) ?? null;
  }

  protected onAnalyzed(a: TripAnalysisDto): void {
    this.analysesMap.update((m) => { const n = new Map(m); n.set(a.tripId, a); return n; });
  }

  // ─── Export PDF (pre-filtre sur ce vehicule) ─────────────────────────────
  protected async onExportPdf(): Promise<void> {
    if (this.exporting()) return;
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export PDF', 'Période invalide.');
      return;
    }
    this.exporting.set(true);
    try {
      await this.reportsApi.downloadConfiguredPdf(
        null,
        this.periodFrom,
        this.periodTo,
        {
          vehicleIds: [this.vehicleId()],
          sections: ['kpi', 'alerts', 'trips'],
          maxTrips: 100,
        },
      );
      this.toast.success('PDF généré');
    } catch (err) {
      this.toast.error('Échec export PDF', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(false);
    }
  }

  // ─── Trip actions ───────────────────────────────────────────────────────
  protected onOpenPeriodReplay(): void {
    if (!this.canPeriodReplay()) return;
    this.periodReplayOpen.set(true);
  }

  protected openReplay(trip: TripDto): void {
    this.replayTrip.set(trip);
  }

  protected openNoteEdit(trip: TripDto): void {
    this.noteEditTrip.set(trip);
  }

  protected onNoteSaved(updated: TripDto): void {
    this.trips.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
    const replay = this.replayTrip();
    if (replay && replay.id === updated.id) {
      this.replayTrip.set(updated);
    }
  }

  protected onEditNoteFromReplay(trip: TripDto): void {
    this.noteEditTrip.set(trip);
  }

  protected openDriverPickerForTrip(trip: TripDto): void {
    if (!this.canManageDrivers()) return;
    this.driverPickerTrip.set(trip);
  }

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
        driver ? 'Conducteur affecté' : 'Conducteur retiré',
        driver ? `${driver.firstName} ${driver.lastName}` : '',
      );
    } catch (err) {
      this.toast.error('Échec affectation', err instanceof Error ? err.message : '');
    }
  }

  // ─── Helpers delegues a reports.utils (verrouilles par tests) ───────────
  protected max0(n: number): number { return max0Fn(n); }
  protected clampSpeed(n: number): number { return clampSpeedFn(n); }
  protected formatDuration(seconds: number): string { return formatDurationFn(seconds); }
}
