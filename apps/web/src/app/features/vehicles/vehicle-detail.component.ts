import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule, ArrowLeft, Wifi, WifiOff, Gauge, MapPin, Radio,
  AlertTriangle, AlertCircle, Info, Check, Power, Route, BellOff, Map,
  History, Bell, Zap, Clock, ShieldAlert, ShieldCheck, MessageSquare, Pencil, X,
  UserRound, UserPlus,
} from 'lucide-angular';
import type { AlertEvent, DriverDto, TripDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../core/services/alerts.service';
import { AuthService } from '../../core/services/auth.service';
import { EngineControlService, type EngineControlCommandDto } from '../../core/services/engine-control.service';
import { PositionsApiService, type PositionDto } from '../../core/services/positions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { DriversApiService } from '../../core/services/drivers.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { TrackersApiService } from '../../core/services/trackers.service';
import { TripsApiService } from '../../core/services/trips.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DriverPickerComponent } from '../../shared/ui/driver-picker/driver-picker.component';
import { MiniMapComponent } from '../../shared/ui/mini-map/mini-map.component';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';
import { CommandsPanelComponent } from '../tracker-commands/commands-panel.component';
import { VehicleScheduleComponent } from './vehicle-schedule/vehicle-schedule.component';
import { relativeTime } from '../../shared/utils/relative-time';

@Component({
  selector: 'app-vehicle-detail',
  standalone: true,
  imports: [
    RouterLink, FormsModule, LucideAngularModule, DatePipe, DecimalPipe,
    MiniMapComponent, EngineControlButtonComponent, CommandsPanelComponent,
    VehicleScheduleComponent, DriverPickerComponent,
  ],
  template: `
    @if (loading()) {
      <div class="flex items-center justify-center h-64">
        <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
      </div>
    } @else if (vehicle(); as v) {
      <div class="flex flex-col gap-4 sm:gap-6">
        <!-- Header -->
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
            <a routerLink="/dashboard" class="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl
                bg-bg-secondary border border-border-subtle text-fg-tertiary
                hover:text-fg-primary transition-colors cursor-pointer shrink-0">
              <lucide-icon [img]="ArrowLeft" [size]="20"></lucide-icon>
            </a>
            <div class="min-w-0">
              <h1 class="text-2xl sm:text-3xl font-display font-bold text-fg-primary truncate">{{ v.plate }}</h1>
              <p class="text-xs sm:text-sm text-fg-tertiary truncate">
                {{ v.brand }} {{ v.model }}
                @if (v.year) { · {{ v.year }} }
                @if (v.color) { · {{ v.color }} }
              </p>
            </div>
          </div>

          @if (v.tracker && currentPosition(); as pos) {
            <app-engine-control-button
              [trackerId]="v.tracker.id"
              [vehicleId]="v.id"
              [vehiclePlate]="v.plate"
              [currentSpeedKmh]="pos.speedKmh"
              [validFix]="pos.valid"
              [positionAge]="positionAgeSeconds()"
              [ignition]="pos.ignition"
              (scheduleDisabled)="onScheduleDisabled()"
            />
          }
        </div>

        <!-- V1.7 — Reglage materiel ACC (SUPER_ADMIN only) -->
        @if (isSuperAdmin() && v.tracker) {
          <div class="vd-admin-card" [class.vd-admin-card--warning]="!v.tracker.accConnected">
            <div class="vd-admin-card-header">
              @if (v.tracker.accConnected) {
                <lucide-icon [img]="ShieldCheck" [size]="14"></lucide-icon>
              } @else {
                <lucide-icon [img]="ShieldAlert" [size]="14"></lucide-icon>
              }
              <span>Réglage matériel · super-admin</span>
            </div>
            <label class="vd-admin-toggle">
              <input
                #accCheckbox
                type="checkbox"
                [checked]="v.tracker.accConnected"
                [disabled]="accUpdating()"
                (change)="toggleAccConnected(v.tracker.id, accCheckbox)"
              />
              <span class="vd-admin-toggle-text">
                <strong>Fil ACC connecté</strong>
                <small>
                  Le fil jaune (ACC) du tracker est branché au +12V après contact.
                  Décochez si l'installation n'a pas câblé l'ACC — l'ignition sera alors
                  inférée depuis la vitesse GPS (seuil 3 km/h).
                </small>
              </span>
              @if (accUpdating()) {
                <span class="vd-admin-spinner"></span>
              }
            </label>
            @if (!v.tracker.accConnected) {
              <div class="vd-admin-warning">
                <lucide-icon [img]="AlertTriangle" [size]="12"></lucide-icon>
                <span>
                  Mode dégradé actif : ignition basée sur la vitesse, fiabilité réduite à l'arrêt.
                </span>
              </div>
            }
          </div>
        }

        <!-- Stats compactes (info-bar horizontale) -->
        <div class="vd-stats-bar">
          <div class="vd-stat" [class.vd-stat--online]="isOnline()">
            @if (isOnline()) {
              <lucide-icon [img]="Wifi" [size]="14"></lucide-icon>
            } @else {
              <lucide-icon [img]="WifiOff" [size]="14"></lucide-icon>
            }
            <div class="vd-stat-content">
              <span class="vd-stat-label">Statut</span>
              <span class="vd-stat-value">
                {{ isOnline() ? 'En ligne' : 'Hors ligne' }}
                @if (currentPosition(); as pos) {
                  · <span [class]="pos.ignition ? 'text-tracky-light' : 'text-fg-tertiary'">{{ pos.ignition ? 'ON' : 'OFF' }}</span>
                }
              </span>
            </div>
          </div>

          <div class="vd-stat">
            <lucide-icon [img]="Gauge" [size]="14"></lucide-icon>
            <div class="vd-stat-content">
              <span class="vd-stat-label">Vitesse</span>
              <span class="vd-stat-value">
                @if (currentPosition(); as pos) { {{ pos.speedKmh | number:'1.0-0' }} km/h } @else { — }
              </span>
            </div>
          </div>

          <div class="vd-stat">
            <lucide-icon [img]="MapPin" [size]="14"></lucide-icon>
            <div class="vd-stat-content">
              <span class="vd-stat-label">Position</span>
              <span class="vd-stat-value">
                @if (currentPosition(); as pos) { {{ relativeTime(pos.timestamp) }} } @else { Jamais }
              </span>
              @if (currentPosition(); as pos) {
                <span class="vd-stat-coords">{{ pos.lat | number:'1.5-5' }}, {{ pos.lng | number:'1.5-5' }}</span>
              }
            </div>
          </div>

          <div class="vd-stat vd-stat--mono">
            <lucide-icon [img]="Radio" [size]="14"></lucide-icon>
            <div class="vd-stat-content">
              <span class="vd-stat-label">Tracker</span>
              <span class="vd-stat-value">
                @if (v.tracker) { {{ v.tracker.imei.slice(0,4) }}…{{ v.tracker.imei.slice(-4) }} } @else { — }
              </span>
            </div>
          </div>
        </div>

        <!-- Phase 2 — Conducteur courant : sert de defaut snape sur les
             prochains trajets. Modifiable par admins/managers via le picker. -->
        <div class="vd-driver-card">
          <div class="vd-driver-card-icon"
               [style.background]="v.currentDriver?.color ?? 'rgba(16,224,160,.15)'">
            @if (v.currentDriver) {
              {{ driverInitials(v.currentDriver) }}
            } @else {
              <lucide-icon [img]="UserRoundIcon" [size]="16"></lucide-icon>
            }
          </div>
          <div class="vd-driver-card-body">
            <span class="vd-driver-card-label">Conducteur courant</span>
            @if (v.currentDriver) {
              <span class="vd-driver-card-name">
                {{ v.currentDriver.firstName }} {{ v.currentDriver.lastName }}
              </span>
              <span class="vd-driver-card-hint">
                Sera affecté par défaut aux prochains trajets.
              </span>
            } @else {
              <span class="vd-driver-card-name vd-driver-card-name--empty">
                Aucun conducteur assigné
              </span>
              <span class="vd-driver-card-hint">
                Les trajets ne seront pas associés à un conducteur tant que
                vous n'en avez pas affecté.
              </span>
            }
          </div>
          @if (canManageDrivers()) {
            <button type="button" class="vd-driver-card-btn"
                    (click)="openDriverPicker()"
                    [disabled]="assigningDriver()">
              @if (assigningDriver()) {
                <span class="vd-admin-spinner" style="width:12px;height:12px;border-width:1.5px"></span>
              } @else if (v.currentDriver) {
                <lucide-icon [img]="PencilIcon" [size]="12"></lucide-icon>
              } @else {
                <lucide-icon [img]="UserPlusIcon" [size]="12"></lucide-icon>
              }
              {{ v.currentDriver ? 'Changer' : 'Assigner' }}
            </button>
          }
        </div>

        <!-- Tabs avec icônes + fade scroll indicator -->
        <div class="vd-tabs-wrapper">
          <div class="vd-tabs">
            @for (tab of tabs; track tab.key) {
              <button
                (click)="activeTab.set(tab.key)"
                class="vd-tab"
                [class.vd-tab--active]="activeTab() === tab.key"
              >
                <lucide-icon [img]="tab.icon" [size]="16"></lucide-icon>
                <span class="vd-tab-label">{{ tab.label }}</span>
                @if (tab.key === 'alerts' && alerts().length > 0) {
                  <span class="vd-tab-badge">{{ alerts().length }}</span>
                }
              </button>
            }
          </div>
        </div>

        <!-- Tab content -->
        @if (activeTab() === 'map') {
          @if (currentPosition(); as pos) {
            <app-mini-map
              [center]="{ lat: pos.lat, lng: pos.lng }"
              [trail]="trail()"
              [speedKmh]="pos.speedKmh"
              [heading]="pos.heading"
              [vehicleType]="vehicle()?.type ?? 'OTHER'"
              [plate]="vehicle()?.plate ?? ''"
              [ignition]="pos.ignition"
              height="500px"
            />
          } @else {
            <div class="flex flex-col items-center justify-center h-64 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="MapPin" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucune position connue</p>
            </div>
          }
        }

        <!-- Selecteur de plage date : visible uniquement sur Historique et Trajets.
             Default = Aujourd'hui ; permet d'elargir a Hier / 7j / 30j / Tout / Personnalise. -->
        @if (activeTab() === 'history' || activeTab() === 'trips') {
          <div class="vd-date-filter">
            <label class="vd-date-filter-label" for="vd-date-range">Période</label>
            <select
              id="vd-date-range"
              class="vd-date-select"
              [value]="dateRange()"
              (change)="onDateRangeChange($any($event.target).value)"
            >
              @for (opt of dateRangeOptions; track opt.key) {
                <option [value]="opt.key">{{ opt.label }}</option>
              }
            </select>
            @if (showCustomInputs()) {
              <input
                type="date"
                class="vd-date-input"
                [value]="customFrom()"
                (change)="onCustomFromChange($any($event.target).value)"
                aria-label="Date de début"
              />
              <span class="vd-date-sep">→</span>
              <input
                type="date"
                class="vd-date-input"
                [value]="customTo()"
                (change)="onCustomToChange($any($event.target).value)"
                aria-label="Date de fin"
              />
            }
            @if (rangeLoading()) {
              <span class="vd-date-spinner" aria-label="Chargement"></span>
            }
          </div>
        }

        @if (activeTab() === 'history') {
          @if (recentPositions().length > 0) {
            <!-- Liste de cards (mobile-first) -->
            <div class="vd-history-list">
              @for (pos of recentPositions(); track pos.id) {
                <div class="vd-history-card">
                  <div class="vd-history-row">
                    <span class="vd-history-time">{{ pos.timestamp | date:'dd/MM HH:mm:ss' }}</span>
                    <span class="vd-history-speed" [class.zero]="pos.speedKmh < 1">
                      {{ pos.speedKmh | number:'1.0-1' }} <span class="vd-history-speed-unit">km/h</span>
                    </span>
                  </div>
                  <div class="vd-history-row vd-history-row--meta">
                    <span class="vd-history-coords">{{ pos.lat | number:'1.4-4' }}, {{ pos.lng | number:'1.4-4' }}</span>
                    <span class="vd-history-flags">
                      @if (pos.ignition === true) {
                        <span class="vd-history-flag vd-history-flag--on">Contact ON</span>
                      } @else if (pos.ignition === false) {
                        <span class="vd-history-flag vd-history-flag--off">Contact OFF</span>
                      }
                      @if (pos.valid) {
                        <span class="vd-history-flag vd-history-flag--ok">Fix ✓</span>
                      } @else {
                        <span class="vd-history-flag vd-history-flag--ko">Fix ✗</span>
                      }
                    </span>
                  </div>
                </div>
              }
            </div>
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2 text-center px-4">
              <lucide-icon [img]="HistoryIcon" [size]="48" class="opacity-30"></lucide-icon>
              <p>{{ dateRange() === 'all' ? 'Aucun historique' : 'Aucun historique sur cette période' }}</p>
              @if (dateRange() !== 'all') {
                <button (click)="dateRange.set('all')"
                        class="text-xs text-tracky-light hover:underline cursor-pointer">
                  Voir tout
                </button>
              }
            </div>
          }
        }

        @if (activeTab() === 'alerts') {
          @if (alerts().length > 0) {
            <div class="flex flex-col gap-2">
              @for (alert of alerts(); track alert.id) {
                <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4
                            flex items-start gap-3">
                  @if (alert.severity === 'CRITICAL') {
                    <div class="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="AlertTriangle" [size]="16" class="text-red-400"></lucide-icon>
                    </div>
                  } @else if (alert.severity === 'WARNING') {
                    <div class="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="AlertCircle" [size]="16" class="text-amber-400"></lucide-icon>
                    </div>
                  } @else {
                    <div class="w-8 h-8 rounded-full bg-sky-500/20 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="InfoIcon" [size]="16" class="text-sky-400"></lucide-icon>
                    </div>
                  }
                  <div class="flex-1">
                    <p class="text-sm font-semibold text-fg-primary">{{ alert.title }}</p>
                    <p class="text-xs text-fg-tertiary mt-0.5">{{ relativeTime(alert.createdAt) }}</p>
                  </div>
                  @if (!isAcknowledged(alert)) {
                    <button (click)="acknowledgeAlert(alert.id)"
                            class="text-xs px-2 py-1 rounded-lg bg-bg-tertiary text-fg-tertiary
                                   border border-border-subtle hover:text-tracky-light cursor-pointer">
                      <lucide-icon [img]="Check" [size]="12"></lucide-icon>
                    </button>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="BellOff" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucune alerte</p>
            </div>
          }
        }

        @if (activeTab() === 'commands') {
          @if (v.tracker) {
            <app-commands-panel [trackerId]="v.tracker.id" />
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="Power" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucun tracker associé</p>
            </div>
          }
        }

        @if (activeTab() === 'schedule') {
          <app-vehicle-schedule
            [vehicleId]="v.id"
            [hasTracker]="!!v.tracker"
            [reloadTrigger]="scheduleRevision()"
          />
        }

        @if (activeTab() === 'trips') {
          @if (vehicleTrips().length > 0) {
            <div class="vd-trips-list">
              @for (trip of vehicleTrips(); track trip.id) {
                <div class="vd-trip-card">
                  <div class="vd-trip-header">
                    <div class="vd-trip-period">
                      <span class="vd-trip-date">{{ trip.startedAt | date:'dd MMM' }}</span>
                      <span class="vd-trip-times">
                        {{ trip.startedAt | date:'HH:mm' }}
                        @if (trip.endedAt) {
                          → {{ trip.endedAt | date:'HH:mm' }}
                        } @else {
                          <span class="vd-trip-live">· en cours</span>
                        }
                      </span>
                    </div>
                    <div class="vd-trip-distance">
                      <strong>{{ (trip.distanceMeters / 1000) | number:'1.1-1' }}</strong>
                      <span class="vd-trip-distance-unit">km</span>
                    </div>
                  </div>

                  <!-- Pill conducteur (affichage discret entre header et stats). -->
                  @if (trip.driver) {
                    <div class="vd-trip-driver"
                         [style.--driver-color]="trip.driver.color || '#10E0A0'"
                         [title]="(trip.driverSource === 'AUTO' ? 'Conducteur snape automatiquement.' : 'Conducteur assigne manuellement.')">
                      <span class="vd-trip-driver-dot"></span>
                      <span class="vd-trip-driver-name">
                        {{ trip.driver.firstName }} {{ trip.driver.lastName }}
                      </span>
                      @if (trip.driverSource === 'MANUAL') {
                        <span class="vd-trip-driver-source">manuel</span>
                      }
                    </div>
                  }

                  <div class="vd-trip-stats">
                    <div class="vd-trip-stat">
                      <span class="vd-trip-stat-label">Durée</span>
                      <span class="vd-trip-stat-value">{{ formatDuration(trip.durationSeconds) }}</span>
                    </div>
                    <div class="vd-trip-stat">
                      <span class="vd-trip-stat-label">V. max</span>
                      <span class="vd-trip-stat-value vd-trip-stat-value--max">{{ trip.maxSpeed | number:'1.0-0' }} km/h</span>
                    </div>
                    <div class="vd-trip-stat">
                      <span class="vd-trip-stat-label">V. moy.</span>
                      <span class="vd-trip-stat-value">{{ trip.avgSpeed | number:'1.0-0' }} km/h</span>
                    </div>
                  </div>

                  <!-- Bloc note : edition inline pour les roles autorises,
                       lecture seule pour les autres. -->
                  @if (editingNoteTripId() === trip.id) {
                    <div class="vd-trip-note vd-trip-note--editing">
                      <textarea
                        class="vd-trip-note-input"
                        [(ngModel)]="editingNoteText"
                        [maxlength]="500"
                        placeholder="Ex : Depose Eric au sport, livraison client X..."
                        rows="2"
                        autofocus
                      ></textarea>
                      <div class="vd-trip-note-actions">
                        <span class="vd-trip-note-counter"
                              [class.vd-trip-note-counter--warn]="editingNoteText.length > 450">
                          {{ editingNoteText.length }} / 500
                        </span>
                        <div class="vd-trip-note-buttons">
                          <button type="button" class="vd-trip-note-btn"
                                  (click)="cancelEditNote()"
                                  [disabled]="savingNote()">
                            Annuler
                          </button>
                          <button type="button" class="vd-trip-note-btn vd-trip-note-btn--primary"
                                  (click)="saveTripNote(trip)"
                                  [disabled]="savingNote()">
                            @if (savingNote()) {
                              <span class="vd-admin-spinner" style="width:10px;height:10px;border-width:1.5px"></span>
                            }
                            Enregistrer
                          </button>
                        </div>
                      </div>
                    </div>
                  } @else if (trip.notes) {
                    <div class="vd-trip-note">
                      <div class="vd-trip-note-icon">
                        <lucide-icon [img]="MessageSquareIcon" [size]="14"></lucide-icon>
                      </div>
                      <div class="vd-trip-note-body">
                        <p class="vd-trip-note-text">{{ trip.notes }}</p>
                        @if (trip.notesUpdatedBy || trip.notesUpdatedAt) {
                          <p class="vd-trip-note-meta">
                            @if (trip.notesUpdatedBy) {
                              {{ noteAuthorLabel(trip.notesUpdatedBy) }}
                            }
                            @if (trip.notesUpdatedAt) {
                              · {{ relativeTime(trip.notesUpdatedAt) }}
                            }
                          </p>
                        }
                      </div>
                      @if (canEditNotes()) {
                        <button type="button" class="vd-trip-note-edit"
                                (click)="startEditNote(trip)"
                                title="Modifier la note">
                          <lucide-icon [img]="PencilIcon" [size]="13"></lucide-icon>
                        </button>
                      }
                    </div>
                  } @else if (canEditNotes()) {
                    <button type="button" class="vd-trip-note-add"
                            (click)="startEditNote(trip)">
                      <lucide-icon [img]="MessageSquareIcon" [size]="13"></lucide-icon>
                      Ajouter une note
                    </button>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2 text-center px-4">
              <lucide-icon [img]="Route" [size]="48" class="opacity-30"></lucide-icon>
              <p>{{ dateRange() === 'all' ? 'Aucun trajet enregistré' : 'Aucun trajet sur cette période' }}</p>
              @if (dateRange() !== 'all') {
                <button (click)="dateRange.set('all')"
                        class="text-xs text-tracky-light hover:underline cursor-pointer">
                  Voir tout
                </button>
              }
            </div>
          }
        }
      </div>

      <!-- Picker conducteur (modal centre, fetch les drivers a l'ouverture). -->
      @if (vehicle(); as v) {
        <app-driver-picker
          [open]="driverPickerOpen()"
          [currentDriverId]="v.currentDriver?.id ?? null"
          [title]="'Conducteur du vehicule ' + v.plate"
          subtitle="Le conducteur courant sera snape par defaut sur les prochains trajets."
          (closed)="driverPickerOpen.set(false)"
          (selected)="onDriverPicked($event)"
        />
      }
    }
  `,
  styles: [`
    /* ─── V1.7 — Carte super-admin "Reglage materiel ACC" ─── */
    .vd-admin-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 14px;
      background: color-mix(in srgb, var(--tracky-light) 6%, var(--bg-secondary));
      border: 1px solid color-mix(in srgb, var(--tracky-light) 25%, var(--border-subtle));
      border-radius: 12px;
    }
    .vd-admin-card--warning {
      background: color-mix(in srgb, #f59e0b 8%, var(--bg-secondary));
      border-color: color-mix(in srgb, #f59e0b 35%, var(--border-subtle));
    }
    .vd-admin-card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--tracky-light);
    }
    .vd-admin-card--warning .vd-admin-card-header {
      color: #f59e0b;
    }
    .vd-admin-toggle {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
    }
    .vd-admin-toggle input[type='checkbox'] {
      margin-top: 3px;
      width: 16px;
      height: 16px;
      accent-color: var(--tracky-light);
      cursor: pointer;
      flex-shrink: 0;
    }
    .vd-admin-toggle input[type='checkbox']:disabled {
      cursor: wait;
      opacity: 0.5;
    }
    .vd-admin-toggle-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .vd-admin-toggle-text strong {
      color: var(--fg-primary);
      font-size: 13px;
      font-weight: 600;
    }
    .vd-admin-toggle-text small {
      color: var(--fg-tertiary);
      font-size: 11px;
      line-height: 1.4;
    }
    .vd-admin-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--fg-tertiary);
      border-top-color: var(--tracky-light);
      border-radius: 50%;
      animation: vd-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes vd-spin {
      to { transform: rotate(360deg); }
    }
    .vd-admin-warning {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      color: #fca5a5;
      font-size: 11px;
      font-weight: 500;
    }
    .vd-admin-warning lucide-icon {
      flex-shrink: 0;
    }

    /* ─── Stats bar horizontale compacte ─── */
    .vd-stats-bar {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .vd-stat {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      min-width: 0;
    }
    .vd-stat lucide-icon {
      flex-shrink: 0;
      color: var(--fg-tertiary);
    }
    .vd-stat--online lucide-icon { color: var(--tracky-light); }
    .vd-stat-content {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    .vd-stat-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
      line-height: 1.2;
    }
    .vd-stat-value {
      font-size: 13px;
      font-weight: 700;
      color: var(--fg-primary);
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .vd-stat--mono .vd-stat-value {
      font-family: var(--font-mono, monospace);
      font-size: 12px;
    }
    .vd-stat-coords {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      color: var(--fg-tertiary);
      line-height: 1.3;
      letter-spacing: .01em;
      margin-top: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ─── Tabs avec icônes + fade scroll indicator ─── */
    .vd-tabs-wrapper {
      position: relative;
      border-bottom: 1px solid var(--border-subtle);
      margin-left: -16px;
      margin-right: -16px;
    }
    /* Fade gradient à droite indiquant qu'il y a plus de tabs */
    .vd-tabs-wrapper::after {
      content: '';
      position: absolute;
      right: 0; top: 0; bottom: 1px;
      width: 32px;
      pointer-events: none;
      background: linear-gradient(to right, transparent, var(--bg-primary) 70%);
      z-index: 1;
    }
    .vd-tabs {
      display: flex;
      gap: 2px;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 0 16px;
      scroll-snap-type: x proximity;
    }
    .vd-tabs::-webkit-scrollbar { display: none; }

    .vd-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 12px;
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      color: var(--fg-tertiary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: color .15s, border-color .15s;
      flex-shrink: 0;
      white-space: nowrap;
      scroll-snap-align: start;
    }
    .vd-tab:hover { color: var(--fg-secondary); }
    .vd-tab--active {
      color: var(--tracky-light) !important;
      border-bottom-color: var(--tracky-light);
    }
    .vd-tab-badge {
      padding: 2px 6px;
      border-radius: 9999px;
      background: rgba(245,158,11,.18);
      color: #f59e0b;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
    }

    /* Mobile : tabs plus compacts (icône + texte) */
    @media (max-width: 640px) {
      .vd-tab { padding: 10px 10px; font-size: 12px; gap: 5px; }
      .vd-tab-label { display: inline; }
    }

    /* ─── Filtre date (Historique + Trajets) ─── */
    .vd-date-filter {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
    }
    .vd-date-filter-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
      flex-shrink: 0;
    }
    .vd-date-select,
    .vd-date-input {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      color: var(--fg-primary);
      font-size: 13px;
      font-weight: 600;
      padding: 6px 10px;
      cursor: pointer;
      transition: border-color .15s, color .15s;
      font-family: inherit;
      min-width: 0;
    }
    .vd-date-select:hover,
    .vd-date-input:hover { border-color: var(--border-strong); }
    .vd-date-select:focus,
    .vd-date-input:focus {
      outline: none;
      border-color: var(--tracky-light);
      color: var(--tracky-light);
    }
    .vd-date-input { font-family: var(--font-mono, monospace); font-size: 12px; }
    .vd-date-sep { color: var(--fg-tertiary); font-size: 13px; font-weight: 600; flex-shrink: 0; }
    .vd-date-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--fg-tertiary);
      border-top-color: var(--tracky-light);
      border-radius: 50%;
      animation: vd-spin 0.7s linear infinite;
      margin-left: auto;
      flex-shrink: 0;
    }

    /* ─── Historique : cards mobile-first ─── */
    .vd-history-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .vd-history-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 12px 14px;
      transition: border-color .15s;
    }
    .vd-history-card:hover { border-color: var(--border-strong); }
    .vd-history-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .vd-history-row--meta { margin-top: 6px; }
    .vd-history-time {
      font-size: 12px;
      font-weight: 700;
      color: var(--fg-primary);
      font-family: var(--font-mono, monospace);
    }
    .vd-history-speed {
      font-size: 16px;
      font-weight: 800;
      color: var(--tracky-light);
      font-family: var(--font-display, Poppins, sans-serif);
      letter-spacing: -.02em;
    }
    .vd-history-speed.zero { color: var(--fg-tertiary); }
    .vd-history-speed-unit { font-size: 10px; font-weight: 500; opacity: .7; }
    .vd-history-coords {
      font-size: 11px;
      color: var(--fg-tertiary);
      font-family: var(--font-mono, monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .vd-history-flags {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .vd-history-flag {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: .04em;
      white-space: nowrap;
    }
    .vd-history-flag--on { background: rgba(16,224,160,.12); color: var(--tracky-light); }
    .vd-history-flag--off { background: rgba(239,68,68,.12); color: #ef4444; }
    .vd-history-flag--ok { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .vd-history-flag--ko { background: rgba(239,68,68,.08); color: #ef4444; }

    /* ─── Trajets : cards mobile-first ─── */
    .vd-trips-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .vd-trip-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      padding: 14px;
      transition: border-color .15s;
    }
    .vd-trip-card:hover { border-color: var(--border-strong); }
    .vd-trip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .vd-trip-period { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .vd-trip-date {
      font-size: 11px;
      font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .vd-trip-times {
      font-size: 14px;
      font-weight: 700;
      color: var(--fg-primary);
      font-family: var(--font-mono, monospace);
      margin-top: 2px;
    }
    .vd-trip-live { color: var(--tracky-light); font-weight: 600; }
    .vd-trip-distance {
      display: flex;
      align-items: baseline;
      gap: 3px;
      flex-shrink: 0;
    }
    .vd-trip-distance strong {
      font-size: 22px;
      font-weight: 800;
      color: var(--tracky-light);
      font-family: var(--font-display, Poppins, sans-serif);
      letter-spacing: -.02em;
    }
    .vd-trip-distance-unit { font-size: 11px; color: var(--fg-tertiary); font-weight: 600; }

    .vd-trip-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
    }
    .vd-trip-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .vd-trip-stat-label {
      font-size: 9px;
      font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .vd-trip-stat-value {
      font-size: 13px;
      font-weight: 700;
      color: var(--fg-primary);
    }
    .vd-trip-stat-value--max { color: #f59e0b; }

    /* ─── Phase 2 : carte "Conducteur courant" du vehicule ─── */
    .vd-driver-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
    }
    .vd-driver-card-icon {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: white;
      flex-shrink: 0;
    }
    .vd-driver-card-icon lucide-icon { color: var(--tracky-light); }
    .vd-driver-card-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .vd-driver-card-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .vd-driver-card-name {
      font-size: 14px;
      font-weight: 700;
      color: var(--fg-primary);
      margin-top: 1px;
    }
    .vd-driver-card-name--empty { color: var(--fg-tertiary); font-weight: 600; font-style: italic; }
    .vd-driver-card-hint {
      font-size: 10px;
      color: var(--fg-tertiary);
      margin-top: 3px;
      line-height: 1.3;
    }
    .vd-driver-card-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      cursor: pointer;
      transition: all .15s;
      flex-shrink: 0;
    }
    .vd-driver-card-btn:hover:not(:disabled) {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.05);
    }
    .vd-driver-card-btn:disabled { opacity: 0.5; cursor: wait; }

    /* ─── Pill conducteur dans une trip card ─── */
    .vd-trip-driver {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      padding: 4px 9px;
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--driver-color, #10E0A0) 30%, transparent);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-primary);
      width: fit-content;
    }
    .vd-trip-driver-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--driver-color, #10E0A0);
      flex-shrink: 0;
    }
    .vd-trip-driver-source {
      font-size: 9px;
      font-weight: 600;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    /* ─── Trajets : note libre (lecture / edition / ajout) ─── */
    .vd-trip-note {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      margin-top: 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      align-items: flex-start;
    }
    .vd-trip-note-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: rgba(16,224,160,.10);
      color: var(--tracky-light);
      flex-shrink: 0;
    }
    .vd-trip-note-body {
      flex: 1;
      min-width: 0;
    }
    .vd-trip-note-text {
      font-size: 13px;
      color: var(--fg-primary);
      line-height: 1.45;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .vd-trip-note-meta {
      font-size: 10px;
      color: var(--fg-tertiary);
      margin-top: 4px;
    }
    .vd-trip-note-edit {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 8px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--fg-tertiary);
      cursor: pointer;
      flex-shrink: 0;
      transition: all .15s;
    }
    .vd-trip-note-edit:hover {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.2);
      background: rgba(16,224,160,.05);
    }

    .vd-trip-note--editing {
      flex-direction: column;
      align-items: stretch;
      background: color-mix(in srgb, var(--tracky-light) 4%, var(--bg-tertiary));
      border-color: rgba(16,224,160,.20);
    }
    .vd-trip-note-input {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      color: var(--fg-primary);
      font-size: 13px;
      font-family: inherit;
      line-height: 1.45;
      resize: vertical;
      min-height: 56px;
      outline: none;
      transition: border-color .2s;
    }
    .vd-trip-note-input:focus { border-color: var(--tracky-light); }
    .vd-trip-note-input::placeholder { color: var(--fg-tertiary); }
    .vd-trip-note-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 8px;
    }
    .vd-trip-note-counter {
      font-size: 10px;
      color: var(--fg-tertiary);
      font-variant-numeric: tabular-nums;
    }
    .vd-trip-note-counter--warn { color: #f59e0b; }
    .vd-trip-note-buttons { display: flex; gap: 6px; }
    .vd-trip-note-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      cursor: pointer;
      transition: all .15s;
    }
    .vd-trip-note-btn:hover:not(:disabled) {
      color: var(--fg-primary);
      border-color: var(--border-strong);
    }
    .vd-trip-note-btn:disabled { opacity: 0.5; cursor: wait; }
    .vd-trip-note-btn--primary {
      background: var(--tracky);
      border-color: var(--tracky);
      color: white;
    }
    .vd-trip-note-btn--primary:hover:not(:disabled) {
      background: var(--tracky-dark, #0bb586);
      border-color: var(--tracky-dark, #0bb586);
      color: white;
    }

    .vd-trip-note-add {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      padding: 6px 10px;
      border-radius: 8px;
      background: transparent;
      border: 1px dashed var(--border-subtle);
      color: var(--fg-tertiary);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
      align-self: flex-start;
    }
    .vd-trip-note-add:hover {
      color: var(--tracky-light);
      border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.05);
    }

    /* Desktop : 4 stats en ligne, plus d'espace */
    @media (min-width: 1024px) {
      .vd-stats-bar { grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .vd-stat { padding: 12px 14px; }
      .vd-stat-value { font-size: 14px; }
      .vd-stat-label { font-size: 11px; }
      .vd-tabs-wrapper { margin-left: 0; margin-right: 0; }
      .vd-tabs { padding: 0; }
      .vd-tabs-wrapper::after { display: none; }
    }
  `],
})
export class VehicleDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly positionsApi = inject(PositionsApiService);
  private readonly alertsApi = inject(AlertsApiService);
  private readonly engineControlApi = inject(EngineControlService);
  private readonly realtime = inject(RealtimeService);
  private readonly tripsApi = inject(TripsApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly driversApi = inject(DriversApiService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly vehicle = signal<VehicleDetailDto | null>(null);
  protected readonly recentPositions = signal<PositionDto[]>([]);
  protected readonly alerts = signal<AlertEvent[]>([]);
  protected readonly commands = signal<EngineControlCommandDto[]>([]);
  protected readonly vehicleTrips = signal<TripDto[]>([]);
  protected readonly loading = signal(true);
  // Edition note (un seul trip en edition a la fois — switch reset auto).
  protected readonly editingNoteTripId = signal<string | null>(null);
  protected editingNoteText = '';
  protected readonly savingNote = signal(false);
  // Phase 2 — Picker conducteur (ouverture + spinner d'assignation).
  protected readonly driverPickerOpen = signal(false);
  protected readonly assigningDriver = signal(false);
  /** True pendant un refetch declenche par un changement de plage date (history/trips). */
  protected readonly rangeLoading = signal(false);
  protected readonly activeTab = signal<'map' | 'history' | 'alerts' | 'commands' | 'schedule' | 'trips'>('map');

  /**
   * Plage temporelle pour les onglets Historique et Trajets.
   * Default = `today` (du 00:00 du jour jusqu'a maintenant). L'utilisateur peut
   * elargir vers Hier, 7j, 30j, Tout, ou choisir une plage personnalisee.
   */
  protected readonly dateRange = signal<'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom'>('today');
  /** Bornes (YYYY-MM-DD) utilisees uniquement quand dateRange = 'custom'. */
  protected readonly customFrom = signal<string>('');
  protected readonly customTo = signal<string>('');
  /** True quand l'UI doit afficher les inputs date personnalises. */
  protected readonly showCustomInputs = computed(() => this.dateRange() === 'custom');

  protected readonly dateRangeOptions = [
    { key: 'today' as const, label: 'Aujourd\'hui' },
    { key: 'yesterday' as const, label: 'Hier' },
    { key: '7d' as const, label: '7 derniers jours' },
    { key: '30d' as const, label: '30 derniers jours' },
    { key: 'all' as const, label: 'Tout' },
    { key: 'custom' as const, label: 'Période personnalisée' },
  ];
  /** Incrémenté quand le schedule est désactivé par une action manuelle — force le re-mount du composant schedule. */
  protected readonly scheduleRevision = signal(0);
  /** V1.7 — flag de chargement pendant le PATCH /api/trackers/:id (toggle ACC). */
  protected readonly accUpdating = signal(false);
  /** V1.7 — vrai si l'utilisateur courant est SUPER_ADMIN (pour afficher la carte reglage materiel). */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Wifi = Wifi;
  protected readonly WifiOff = WifiOff;
  protected readonly Gauge = Gauge;
  protected readonly MapPin = MapPin;
  protected readonly Radio = Radio;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly AlertCircle = AlertCircle;
  protected readonly InfoIcon = Info;
  protected readonly Check = Check;
  protected readonly Power = Power;
  protected readonly BellOff = BellOff;
  protected readonly HistoryIcon = History;
  protected readonly Route = Route;
  protected readonly ZapIcon = Zap;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;
  protected readonly XIcon = X;
  protected readonly UserRoundIcon = UserRound;
  protected readonly UserPlusIcon = UserPlus;
  protected readonly relativeTime = relativeTime;

  /** Roles autorises a editer/effacer la note d'un trajet. */
  protected readonly canEditNotes = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN' || r === 'FLEET_MANAGER';
  });

  /**
   * Roles autorises a gerer les conducteurs (assigner/retirer sur un vehicule
   * ou un trajet, creer/modifier des drivers). FLEET_MANAGER passe par la
   * permission `drivers_manage` (UI-only — backend laisse FLEET_MANAGER passer).
   */
  protected readonly canManageDrivers = computed(() => {
    const r = this.auth.user()?.role;
    if (r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN') return true;
    if (r === 'FLEET_MANAGER') return this.perms.can('drivers_manage');
    return false;
  });

  protected readonly tabs = [
    { key: 'map' as const, label: 'Carte', icon: Map },
    { key: 'trips' as const, label: 'Trajets', icon: Route },
    { key: 'schedule' as const, label: 'Horaires', icon: Clock },
    { key: 'alerts' as const, label: 'Alertes', icon: Bell },
    { key: 'history' as const, label: 'Historique', icon: History },
    // Commandes en dernier : reservee plutot aux developpeurs / curieux,
    // l'usage courant passe par le bouton coupe-circuit dans le header.
    { key: 'commands' as const, label: 'Commandes', icon: Zap },
  ];

  private lastAlertCount = -1;
  private alertRefreshEffect = effect(() => {
    const wsAlerts = this.realtime.alerts();
    if (wsAlerts.length !== this.lastAlertCount) {
      this.lastAlertCount = wsAlerts.length;
      const v = this.vehicle();
      if (v) {
        firstValueFrom(this.alertsApi.list({ vehicleId: v.id, limit: '20' }))
          .then((res) => this.alerts.set((res as any).items ?? res))
          .catch(() => {});
      }
    }
  });

  // Reagir aux ENGINE_COMMAND_UPDATED WS events pour rafraichir commandes + ignition en live.
  private engineCommandRefreshEffect = effect(() => {
    const tracker = this.vehicle()?.tracker;
    if (!tracker) return;
    const updates = this.realtime.engineCommandUpdates();
    const update = updates.get(tracker.id);
    if (!update) return;
    // Recharger la liste des commandes depuis l'API
    const v = this.vehicle();
    if (v) {
      firstValueFrom(this.engineControlApi.listCommands(tracker.id, 20))
        .then((cmds) => this.commands.set(cmds))
        .catch(() => {});
    }
  });

  protected readonly livePosition = computed(() => {
    const tracker = this.vehicle()?.tracker;
    if (!tracker) return null;
    return this.realtime.positions().get(tracker.id) ?? null;
  });

  protected readonly currentPosition = computed(() => {
    const live = this.livePosition();
    // Corriger l'ignition avec l'etat des commandes moteur recentes :
    // apres un CUT ACKNOWLEDGED, si l'ACC_OFF n'est pas encore arrive,
    // la position WS montre encore ignition=true — on patche ici.
    const tracker = this.vehicle()?.tracker;
    const engineUpdate = tracker
      ? this.realtime.engineCommandUpdates().get(tracker.id)
      : undefined;
    const patchIgnition = (raw: boolean): boolean => {
      if (!engineUpdate) return raw;
      if (engineUpdate.status === 'ACKNOWLEDGED' || engineUpdate.status === 'SENT') {
        if (engineUpdate.action === 'CUT') return false;
        if (engineUpdate.action === 'RESTORE') return true;
      }
      return raw;
    };

    if (live) {
      return { lat: live.lat, lng: live.lng, speedKmh: live.speedKmh, heading: live.heading ?? 0, timestamp: live.timestamp, ignition: patchIgnition(live.ignition), valid: live.valid };
    }
    const last = this.recentPositions()[0];
    if (last) {
      return {
        lat: last.lat,
        lng: last.lng,
        speedKmh: last.speedKmh,
        // V1.4 Sprint D.1 — heading utilise par MiniMap pour l'orientation marker.
        heading: (last as { heading?: number }).heading ?? 0,
        timestamp: last.timestamp,
        // Remote — ignition fiable via last.ignition puis lastKnownIgnition tracker.
        // Fallback false (securite : on ne suppose pas moteur ON si inconnu).
        ignition: patchIgnition(last.ignition ?? this.vehicle()?.tracker?.lastKnownIgnition ?? false),
        valid: last.valid,
      };
    }
    return null;
  });

  protected readonly positionAgeSeconds = computed(() => {
    const pos = this.currentPosition();
    if (!pos) return undefined;
    return Math.floor((Date.now() - new Date(pos.timestamp).getTime()) / 1000);
  });

  protected readonly trail = computed(() =>
    this.recentPositions().slice(0, 20).reverse().map((p) => ({ lat: p.lat, lng: p.lng })),
  );

  /**
   * Calcule les bornes ISO {from, to} a envoyer aux APIs /positions et /trips
   * en fonction du `dateRange` (et `customFrom`/`customTo` quand 'custom').
   * `all` ne pose aucune borne. Plage personnalisee : la borne haute inclut
   * la fin de journee (23:59:59) pour ne pas couper les courses tardives.
   */
  protected readonly dateRangeBounds = computed<{ from?: string; to?: string }>(() => {
    const r = this.dateRange();
    if (r === 'all') return {};

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (r === 'today') {
      return { from: startOfToday.toISOString(), to: now.toISOString() };
    }
    if (r === 'yesterday') {
      const startYest = new Date(startOfToday);
      startYest.setDate(startYest.getDate() - 1);
      return { from: startYest.toISOString(), to: startOfToday.toISOString() };
    }
    if (r === '7d') {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 6);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    if (r === '30d') {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 29);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    // custom : convertit YYYY-MM-DD en ISO. Borne haute = fin de journee.
    const f = this.customFrom();
    const t = this.customTo();
    return {
      from: f ? new Date(`${f}T00:00:00`).toISOString() : undefined,
      to: t ? new Date(`${t}T23:59:59.999`).toISOString() : undefined,
    };
  });

  /**
   * Refetch des donnees Historique + Trajets quand la plage date change.
   * Skip tant que le chargement initial n'est pas fini (loading()=true) — sinon
   * on declenche un fetch concurrent inutile pendant ngOnInit/loadAll.
   * Skip aussi pour `custom` quand les deux bornes sont vides (l'UI vient de
   * basculer sur custom mais l'utilisateur n'a pas encore saisi de dates).
   */
  private dateRangeRefreshEffect = effect(() => {
    const v = this.vehicle();
    const bounds = this.dateRangeBounds();
    if (!v || this.loading()) return;
    // En mode custom sans bornes saisies, on ne fait rien (eviterait de tout
    // refetch sans filtre = equivalent a "Tout", surprenant pour l'utilisateur).
    if (this.dateRange() === 'custom' && !bounds.from && !bounds.to) return;
    void this.refetchRange(v, bounds);
  });

  private async refetchRange(
    v: VehicleDetailDto,
    bounds: { from?: string; to?: string },
  ): Promise<void> {
    const trackerId = v.tracker?.id;
    const dateParams: Record<string, string> = {};
    if (bounds.from) dateParams['from'] = bounds.from;
    if (bounds.to) dateParams['to'] = bounds.to;

    this.rangeLoading.set(true);
    try {
      const [posRes, tripsRes] = await Promise.all([
        trackerId
          ? firstValueFrom(this.positionsApi.list({ trackerId, limit: '500', ...dateParams }))
          : Promise.resolve({ items: [] as PositionDto[] }),
        firstValueFrom(this.tripsApi.list({ vehicleId: v.id, limit: '100', ...dateParams })),
      ]);
      this.recentPositions.set(posRes.items);
      this.vehicleTrips.set((tripsRes as any).items ?? []);
    } catch (err) {
      this.toast.error(
        'Erreur de chargement',
        err instanceof HttpErrorResponse ? err.error?.message : String(err),
      );
    } finally {
      this.rangeLoading.set(false);
    }
  }

  /**
   * Handler du <select> de plage date. Quand l'utilisateur passe sur 'custom'
   * sans dates pre-remplies, on remplit avec [aujourd'hui, aujourd'hui] pour
   * lui donner un point de depart sensible.
   */
  protected onDateRangeChange(value: string): void {
    const key = value as ReturnType<typeof this.dateRange>;
    if (key === 'custom' && !this.customFrom() && !this.customTo()) {
      const today = new Date();
      const iso = today.toISOString().slice(0, 10);
      this.customFrom.set(iso);
      this.customTo.set(iso);
    }
    this.dateRange.set(key);
  }

  protected onCustomFromChange(value: string): void {
    this.customFrom.set(value);
  }

  protected onCustomToChange(value: string): void {
    this.customTo.set(value);
  }

  protected readonly isOnline = computed(() => {
    const age = this.positionAgeSeconds();
    return age !== undefined && age < 180;
  });

  protected onScheduleDisabled(): void {
    this.scheduleRevision.set(this.scheduleRevision() + 1);
  }

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.params['id'];
    if (!id) { this.router.navigate(['/dashboard']); return; }
    await this.loadAll(id);
  }

  private async loadAll(vehicleId: string): Promise<void> {
    this.loading.set(true);
    try {
      const v = await firstValueFrom(this.vehiclesApi.findOne(vehicleId));
      this.vehicle.set(v);

      // Chargement initial : applique deja la plage date courante (default = today)
      // pour eviter un double fetch (one without filter + one with filter via effect).
      const bounds = this.dateRangeBounds();
      const dateParams: Record<string, string> = {};
      if (bounds.from) dateParams['from'] = bounds.from;
      if (bounds.to) dateParams['to'] = bounds.to;

      const trackerId = v.tracker?.id;
      const [posRes, alertsRes, cmdsRes, tripsRes] = await Promise.all([
        trackerId
          ? firstValueFrom(this.positionsApi.list({ trackerId, limit: '500', ...dateParams }))
          : { items: [] },
        firstValueFrom(this.alertsApi.list({ vehicleId: v.id, limit: '20' })),
        trackerId ? firstValueFrom(this.engineControlApi.listCommands(trackerId, 20)) : [],
        firstValueFrom(this.tripsApi.list({ vehicleId: v.id, limit: '100', ...dateParams })),
      ]);

      this.recentPositions.set(posRes.items);
      this.alerts.set((alertsRes as any).items ?? alertsRes);
      this.commands.set(Array.isArray(cmdsRes) ? cmdsRes : []);
      this.vehicleTrips.set((tripsRes as any).items ?? []);
    } catch (err) {
      this.toast.error('Erreur de chargement', err instanceof HttpErrorResponse ? err.error?.message : String(err));
      this.router.navigate(['/dashboard']);
    } finally {
      this.loading.set(false);
    }
  }

  protected async acknowledgeAlert(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.alerts.update((list) => list.filter((a) => a.id !== id));
      this.toast.success('Alerte acquittée');
    } catch { /* handled */ }
  }

  /**
   * V1.7 — Toggle SUPER_ADMIN du flag `accConnected` sur le tracker du vehicule.
   * Confirmation obligatoire (action a fort impact sur la fiabilite ignition).
   * Si l'utilisateur annule la confirmation, on remet la checkbox dans son etat
   * precedent. Si l'API echoue, idem + toast d'erreur explicite.
   */
  protected async toggleAccConnected(trackerId: string, checkbox: HTMLInputElement): Promise<void> {
    const desired = checkbox.checked;
    const message = desired
      ? `Confirmer que le fil ACC du tracker est connecté ?\n\n` +
        `L'ignition sera lue depuis le boîtier (mode normal, fiable).`
      : `Confirmer que le fil ACC n'est PAS connecté ?\n\n` +
        `L'ignition sera inférée depuis la vitesse GPS (mode dégradé, ` +
        `fiabilité réduite à l'arrêt).`;

    const ok = window.confirm(message);
    if (!ok) {
      // L'utilisateur annule : on remet la checkbox dans son etat precedent.
      checkbox.checked = !desired;
      return;
    }

    this.accUpdating.set(true);
    try {
      const updated = await firstValueFrom(
        this.trackersApi.update(trackerId, { accConnected: desired }),
      );

      // Mettre a jour le signal vehicle pour refleter le nouvel etat sans re-fetch.
      const v = this.vehicle();
      if (v?.tracker && v.tracker.id === trackerId) {
        this.vehicle.set({
          ...v,
          tracker: { ...v.tracker, accConnected: updated.accConnected },
        });
      }

      this.toast.success(
        desired ? 'Fil ACC marqué connecté' : 'Mode dégradé activé',
        desired
          ? 'L\'ignition sera lue depuis le boîtier.'
          : 'L\'ignition sera inférée depuis la vitesse GPS.',
      );
    } catch (err) {
      // Rollback visuel : remettre la checkbox dans son etat precedent.
      checkbox.checked = !desired;

      const message = err instanceof HttpErrorResponse
        ? (err.status === 403
            ? 'Action réservée au SUPER_ADMIN'
            : err.error?.message ?? err.message ?? 'Erreur inconnue')
        : (err instanceof Error ? err.message : 'Erreur inconnue');

      this.toast.error('Échec mise à jour ACC', message);
    } finally {
      this.accUpdating.set(false);
    }
  }

  protected isAcknowledged(alert: any): boolean {
    return !!alert.acknowledgedAt;
  }

  protected statusLabel(status: string): string {
    const labels: Record<string, string> = {
      PENDING: 'En attente', SENT: 'Envoyée', ACKNOWLEDGED: 'Confirmée',
      FAILED: 'Échouée', REJECTED_SPEED: 'Refusée',
    };
    return labels[status] ?? status;
  }

  protected statusClass(status: string): string {
    if (status === 'SENT' || status === 'ACKNOWLEDGED') return 'bg-tracky/10 text-tracky-light';
    if (status === 'REJECTED_SPEED') return 'bg-red-600/10 text-red-400';
    if (status === 'FAILED') return 'bg-amber-500/10 text-amber-400';
    return 'bg-bg-tertiary text-fg-tertiary';
  }

  protected formatDuration(seconds: number): string {
    if (!seconds || seconds < 0) return '0min';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}min`;
    return `${m}min`;
  }

  /**
   * Demarre l'edition de la note d'un trajet. Pre-remplit le textarea avec
   * la note existante (vide si nouvelle note). Un seul trip editable a la
   * fois — basculer ferme l'edition precedente sans sauvegarde.
   */
  protected startEditNote(trip: TripDto): void {
    this.editingNoteText = trip.notes ?? '';
    this.editingNoteTripId.set(trip.id);
  }

  protected cancelEditNote(): void {
    this.editingNoteTripId.set(null);
    this.editingNoteText = '';
  }

  /**
   * Sauvegarde la note du trip courant. Si vide, le backend efface la note
   * et reset l'auteur. On met a jour le signal local apres succes pour
   * eviter un re-fetch complet de la liste.
   */
  protected async saveTripNote(trip: TripDto): Promise<void> {
    if (!this.canEditNotes()) return;
    this.savingNote.set(true);
    try {
      const updated = await firstValueFrom(
        this.tripsApi.updateNote(trip.id, this.editingNoteText.trim() || null),
      );
      this.vehicleTrips.update((list) =>
        list.map((t) => (t.id === updated.id ? updated : t)),
      );
      this.editingNoteTripId.set(null);
      this.editingNoteText = '';
      this.toast.success('Note enregistree');
    } catch (err) {
      const msg = err instanceof HttpErrorResponse
        ? err.error?.message ?? 'Erreur inconnue'
        : err instanceof Error ? err.message : 'Erreur inconnue';
      this.toast.error('Echec enregistrement note', msg);
    } finally {
      this.savingNote.set(false);
    }
  }

  /**
   * Libelle court de l'auteur de la note : "Prenom N." si dispo, sinon email.
   * Utilise au-dessous de la note pour montrer qui l'a modifiee.
   */
  protected noteAuthorLabel(author: { firstName: string | null; lastName: string | null; email: string }): string {
    if (author.firstName && author.lastName) {
      return `${author.firstName} ${author.lastName.slice(0, 1).toUpperCase()}.`;
    }
    if (author.firstName) return author.firstName;
    return author.email;
  }

  // ─── Phase 2 — gestion conducteur courant du vehicule ──────────────

  protected openDriverPicker(): void {
    if (!this.canManageDrivers()) return;
    this.driverPickerOpen.set(true);
  }

  /**
   * Callback du picker. driver=null => retire l'assignation. Sinon affecte
   * et met a jour le signal vehicle local pour refleter l'etat sans re-fetch.
   */
  protected async onDriverPicked(driver: DriverDto | null): Promise<void> {
    const v = this.vehicle();
    if (!v) return;
    this.driverPickerOpen.set(false);
    this.assigningDriver.set(true);
    try {
      const updated = await firstValueFrom(
        this.driversApi.assignToVehicle(v.id, driver?.id ?? null),
      );
      this.vehicle.set({
        ...v,
        currentDriver: (updated as { currentDriver: VehicleDetailDto['currentDriver'] }).currentDriver ?? null,
      });
      this.toast.success(
        driver ? 'Conducteur assigne' : 'Conducteur retire',
        driver ? `${driver.firstName} ${driver.lastName}` : '',
      );
    } catch (err) {
      this.toast.error('Echec assignation', err instanceof HttpErrorResponse ? err.error?.message : '');
    } finally {
      this.assigningDriver.set(false);
    }
  }

  /** Initiales en majuscule pour la pastille avatar (ex: ED). */
  protected driverInitials(d: { firstName: string; lastName: string }): string {
    return ((d.firstName?.[0] ?? '') + (d.lastName?.[0] ?? '')).toUpperCase() || '?';
  }
}
