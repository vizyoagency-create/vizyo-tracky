import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { ScrollLockService } from '../../core/services/scroll-lock.service';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Check,
  Layers, Truck, Plus, AlertTriangle, CalendarClock, Wrench, X, Trash2, Play, ListChecks,
  Gauge, CalendarCheck, Inbox, Sparkles, Activity, ShieldCheck, Ban, Info, Pencil,
} from 'lucide-angular';
import type {
  AgendaSummaryDto,
  CreateVehicleEventDto,
  ForecastSlotDto,
  VehicleActivitySlotDto,
  VehicleEventDto,
  VehicleEventStatus,
  VehicleEventType,
} from '@vizyo/tracky-shared';
import { effectiveBlockingEndMs, isImmobilizingEvent } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../core/services/agenda.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { AgendaCalendarComponent } from './agenda-calendar.component';
import { ReservationSheetComponent } from './sheets/reservation-sheet.component';
import { OptimizationSheetComponent } from './sheets/optimization-sheet.component';
import { VehicleLinkDirective } from '../../shared/directives/vehicle-link.directive';
import {
  addMonths,
  eventColor,
  eventStatusLabel,
  eventTypeLabel,
  eventUrgency,
  localIso,
  severityLabel,
  startOfDay,
  startOfMonth,
  urgencyColor,
} from './agenda.utils';

/** Option de groupe pour le dropdown filtre. */
interface GroupOption {
  id: string;
  name: string;
}

@Component({
  selector: 'app-agenda',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, DatePipe, GroupBadgeComponent, AgendaCalendarComponent, ReservationSheetComponent, OptimizationSheetComponent, VehicleLinkDirective],
  template: `
    <div class="flex flex-col gap-5">
      <!-- Header + résumé -->
      <header class="flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <h1 class="text-2xl font-display font-bold text-fg-primary flex items-center gap-2">
              <lucide-icon [img]="CalendarDaysIcon" [size]="22" class="text-tracky-light"></lucide-icon>
              Agenda
            </h1>
            <p class="text-sm text-fg-tertiary mt-0.5">
              Entretiens planifiés et incidents de votre flotte
            </p>
          </div>
          <div class="ag-actions">
            @if (canReserve()) {
              <button type="button" (click)="openReserve()" class="ag-btn-soft">
                <lucide-icon [img]="CalendarCheckIcon" [size]="15"></lucide-icon><span>Réserver</span>
              </button>
            }
            @if (canValidate() && pendingCount() > 0) {
              <button type="button" (click)="openValidate()" class="ag-btn-soft">
                <lucide-icon [img]="InboxIcon" [size]="15"></lucide-icon><span>Demandes</span><span class="ag-badge">{{ pendingCount() }}</span>
              </button>
            }
            @if (canOptimize()) {
              <button type="button" (click)="openOptim()" class="ag-btn-soft">
                <lucide-icon [img]="GaugeIcon" [size]="15"></lucide-icon><span>Optimisation</span>
              </button>
            }
            @if (canManage()) {
              <button type="button" (click)="openCreate()" class="ag-btn-primary">
                <lucide-icon [img]="PlusIcon" [size]="15"></lucide-icon><span>Événement</span>
              </button>
            }
          </div>
        </div>

        <!-- Strip de 3 stats -->
        <div class="ag-summary">
          <div class="ag-stat ag-stat--danger">
            <div class="ag-stat-icon"><lucide-icon [img]="AlertTriangleIcon" [size]="16"></lucide-icon></div>
            <div class="ag-stat-body">
              <span class="ag-stat-value">{{ summary()?.overdue ?? 0 }}</span>
              <span class="ag-stat-label">En retard</span>
            </div>
          </div>
          <div class="ag-stat ag-stat--warn">
            <div class="ag-stat-icon"><lucide-icon [img]="CalendarClockIcon" [size]="16"></lucide-icon></div>
            <div class="ag-stat-body">
              <span class="ag-stat-value">{{ summary()?.upcoming ?? 0 }}</span>
              <span class="ag-stat-label">À venir (30j)</span>
            </div>
          </div>
          <div class="ag-stat ag-stat--info">
            <div class="ag-stat-icon"><lucide-icon [img]="WrenchIcon" [size]="16"></lucide-icon></div>
            <div class="ag-stat-body">
              <span class="ag-stat-value">{{ summary()?.openIncidents ?? 0 }}</span>
              <span class="ag-stat-label">Incidents ouverts</span>
            </div>
          </div>
        </div>
      </header>

      <!-- Barre de filtres -->
      <div class="ag-filters">
        @if (groupOptions().length > 0) {
          <div class="ag-dd-wrapper">
            <button type="button" (click)="groupDdOpen.set(!groupDdOpen())"
                    class="ag-dd-trigger" [class.ag-dd-trigger--open]="groupDdOpen()">
              <lucide-icon [img]="LayersIcon" [size]="14"></lucide-icon>
              <span class="ag-dd-label">{{ selectedGroupLabel() }}</span>
              <lucide-icon [img]="ChevronDownIcon" [size]="14" class="ag-dd-chevron"></lucide-icon>
            </button>
            @if (groupDdOpen()) {
              <div class="ag-dd-backdrop" (click)="groupDdOpen.set(false)"></div>
              <div class="ag-dd-menu">
                <button type="button" (click)="selectGroup('')" class="ag-dd-item"
                        [class.ag-dd-item--active]="!selectedGroupId()">
                  <span>Tous les groupes</span>
                  @if (!selectedGroupId()) { <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> }
                </button>
                <div class="ag-dd-divider"></div>
                @for (g of groupOptions(); track g.id) {
                  <button type="button" (click)="selectGroup(g.id)" class="ag-dd-item"
                          [class.ag-dd-item--active]="selectedGroupId() === g.id">
                    <app-group-badge [group]="g" />
                    @if (selectedGroupId() === g.id) { <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> }
                  </button>
                }
              </div>
            }
          </div>
        }

        <!-- Véhicule -->
        <div class="ag-dd-wrapper">
          <button type="button" (click)="vehicleDdOpen.set(!vehicleDdOpen())"
                  class="ag-dd-trigger" [class.ag-dd-trigger--open]="vehicleDdOpen()">
            <lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon>
            <span class="ag-dd-label">{{ selectedVehicleLabel() }}</span>
            <lucide-icon [img]="ChevronDownIcon" [size]="14" class="ag-dd-chevron"></lucide-icon>
          </button>
          @if (vehicleDdOpen()) {
            <div class="ag-dd-backdrop" (click)="vehicleDdOpen.set(false)"></div>
            <div class="ag-dd-menu">
              <button type="button" (click)="selectVehicle('')" class="ag-dd-item"
                      [class.ag-dd-item--active]="!selectedVehicleId()">
                <span>Tous les véhicules</span>
                @if (!selectedVehicleId()) { <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> }
              </button>
              @if (visibleVehicles().length > 0) { <div class="ag-dd-divider"></div> }
              @for (v of visibleVehicles(); track v.id) {
                <button type="button" (click)="selectVehicle(v.id)" class="ag-dd-item"
                        [class.ag-dd-item--active]="selectedVehicleId() === v.id">
                  <span class="ag-dd-item-content">
                    <span class="ag-dd-item-plate">{{ v.plate }}</span>
                    @if (v.brand || v.model) { <span class="ag-dd-item-meta">{{ v.brand }} {{ v.model }}</span> }
                  </span>
                  @if (selectedVehicleId() === v.id) { <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> }
                </button>
              }
            </div>
          }
        </div>

        <!-- Type (segmented) -->
        <div class="ag-seg">
          @for (t of typeOptions; track t.value) {
            <button type="button" (click)="selectType(t.value)"
                    class="ag-seg-btn" [class.ag-seg-btn--active]="selectedType() === t.value">
              {{ t.label }}
            </button>
          }
        </div>

        <!-- Navigation mois -->
        <div class="ag-month-nav">
          <button type="button" (click)="prevMonth()" aria-label="Mois précédent" class="ag-month-btn">
            <lucide-icon [img]="ChevronLeftIcon" [size]="16"></lucide-icon>
          </button>
          <span class="ag-month-label">{{ monthLabel() }}</span>
          <button type="button" (click)="nextMonth()" aria-label="Mois suivant" class="ag-month-btn">
            <lucide-icon [img]="ChevronRightIcon" [size]="16"></lucide-icon>
          </button>
          <button type="button" (click)="goToday()" class="ag-today-btn"
                  [disabled]="isCurrentMonth()" title="Revenir au mois courant">
            Aujourd'hui
          </button>
        </div>
      </div>

      <!-- Calendrier -->
      @if (loading()) {
        <div class="flex items-center justify-center h-64 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else {
        <app-agenda-calendar
          [events]="filteredEvents()"
          [currentMonth]="currentMonth()"
          [activityByDay]="activityByDay()"
          [forecastByDay]="forecastByDay()"
          (dayClick)="onDayClick($event)"
        />
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 px-1 pt-2.5 text-[11px] text-fg-tertiary">
          <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[3px]" style="background:#10E0A0"></span>Maintenance</span>
          <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[3px]" style="background:#F59E0B"></span>Incident</span>
          <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[3px]" style="background:#38BDF8"></span>Réservation</span>
          <span class="inline-flex items-center gap-1.5"><span style="color:#38BDF8;font-weight:800">●</span>Activité réelle</span>
          <span class="inline-flex items-center gap-1.5"><span style="color:#A78BFA;font-weight:800">~</span>Usage prévu</span>
        </div>
      }

      <!-- À venir / en retard -->
      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-display font-bold text-fg-primary flex items-center gap-2">
          <lucide-icon [img]="ListChecksIcon" [size]="16" class="text-fg-tertiary"></lucide-icon>
          À venir &amp; en retard
        </h2>
        @if (upcomingEvents().length === 0) {
          <div class="flex flex-col items-center justify-center py-8 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2 text-center px-4">
            <lucide-icon [img]="CalendarClockIcon" [size]="36" class="opacity-30"></lucide-icon>
            <p class="text-sm">Aucune échéance à venir sur ce périmètre.</p>
          </div>
        } @else {
          <div class="flex flex-col gap-2">
            @for (ev of upcomingEvents(); track ev.id) {
              <button type="button" (click)="onEventClick(ev)" class="ag-up-row"
                      [style.--u]="urgencyColor(eventUrgency(ev))">
                <span class="ag-up-bar"></span>
                <span class="ag-up-type" [style.--pill]="eventColor(ev)">
                  <lucide-icon [img]="ev.type === 'INCIDENT' ? AlertTriangleIcon : WrenchIcon" [size]="13"></lucide-icon>
                </span>
                <span class="ag-up-main">
                  <span class="ag-up-title">{{ ev.title }}</span>
                  <span class="ag-up-meta">
                    @if (ev.vehiclePlate) { <span class="ag-up-plate" [vehicleLink]="ev.vehicleId" [attr.title]="'Voir ' + ev.vehiclePlate">{{ ev.vehiclePlate }}</span> · }
                    {{ eventTypeLabel(ev.type) }}
                    @if (ev.type === 'INCIDENT' && ev.severity) { · {{ severityLabel(ev.severity) }} }
                  </span>
                </span>
                <span class="ag-up-date">
                  <span class="ag-up-date-day">{{ ev.startAt | date:'dd MMM' }}</span>
                  <span class="ag-up-badge" [style.--u]="urgencyColor(eventUrgency(ev))">
                    {{ urgencyLabel(ev) }}
                  </span>
                </span>
              </button>
            }
          </div>
        }
      </section>
    </div>

    <!-- ─── Panneau jour (bottom-sheet mobile / centre desktop) ─── -->
    @if (dayPanelOpen()) {
      <div class="ag-sheet-root" (click)="closeDayPanel()">
        <div class="ag-sheet" (click)="$event.stopPropagation()" role="dialog" aria-label="Événements du jour">
          <header class="ag-sheet-head">
            <div>
              <h3 class="ag-sheet-title">{{ dayPanelLabel() }}</h3>
              <span class="ag-ctx" [attr.data-ctx]="dayContext()">
                <lucide-icon [img]="dayContext() === 'past' ? ActivityIcon : InfoIcon" [size]="12"></lucide-icon>
                {{ dayContextLabel() }}
              </span>
            </div>
            <button type="button" (click)="closeDayPanel()" aria-label="Fermer" class="ag-icon-btn">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>
          <div class="ag-sheet-body">

            <!-- ── Disponibilité (aujourd'hui + à venir) ── -->
            @if (canSeeInsights() && dayContext() !== 'past') {
              <div class="ag-avail" [class.ag-avail--full]="dayAvailability().unavailable.length === 0">
                <div class="ag-avail-top">
                  <span class="ag-avail-count">
                    <span class="ag-avail-big">{{ dayAvailability().available }}</span>
                    <span class="ag-avail-den">/ {{ dayAvailability().total }}</span>
                  </span>
                  <span class="ag-avail-lbl">véhicule(s) disponible(s){{ dayContext() === 'today' ? " aujourd'hui" : ' ce jour' }}</span>
                </div>
                <div class="ag-avail-bar"><span [style.width.%]="dayAvailability().pct"></span></div>
                @if (dayAvailability().unavailable.length > 0) {
                  <ul class="ag-unavail">
                    @for (u of dayAvailability().unavailable; track u.vehicleId) {
                      <li class="ag-unavail-row">
                        <span class="ag-unavail-ic" [attr.data-kind]="u.kind">
                          <lucide-icon [img]="u.kind === 'immobilized' ? BanIcon : CalendarCheckIcon" [size]="12"></lucide-icon>
                        </span>
                        <span class="ag-unavail-plate" [vehicleLink]="u.vehicleId" [attr.title]="'Voir ' + u.plate">{{ u.plate }}</span>
                        <span class="ag-unavail-lbl">{{ u.kind === 'immobilized' ? 'Immobilisé' : 'Réservé' }} · {{ u.label }}</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="ag-avail-ok">
                    <lucide-icon [img]="ShieldCheckIcon" [size]="13"></lucide-icon>
                    Tous les véhicules du périmètre sont disponibles.
                  </p>
                }
              </div>
            }

            <!-- ── Usage prévu (aujourd'hui + à venir) ── -->
            @if (canSeeInsights() && dayContext() !== 'past') {
              <section class="ag-sec">
                <div class="ag-sec-head">
                  <span class="ag-sec-titr ag-sec-titr--fc"><lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon> Usage prévu</span>
                  <span class="ag-sec-badge ag-sec-badge--fc">{{ dayForecast().length }}</span>
                </div>
                <p class="ag-sec-sub">Estimé d'après l'historique récent. Indicatif — n'empêche pas de réserver.</p>
                @if (dayForecast().length === 0) {
                  <p class="ag-sec-empty">Aucun usage habituel prévu ce jour.</p>
                } @else {
                  @for (f of dayForecast(); track f.vehicleId) {
                    <div class="ag-insight">
                      <span class="ag-insight-plate" [vehicleLink]="f.vehicleId" [attr.title]="'Voir ' + f.plate">{{ f.plate }}</span>
                      <span class="ag-insight-time">{{ f.time }}</span>
                      <span class="ag-insight-conf" [title]="'Observé : ' + f.basis">
                        <span class="ag-insight-bar"><span [style.width.%]="f.confidence * 100" [style.background]="confColor(f.confidence)"></span></span>
                        <span class="ag-insight-basis">{{ f.basis }}</span>
                      </span>
                    </div>
                  }
                }
              </section>
            }

            <!-- ── Utilisation réelle (jours passés) ── -->
            @if (canSeeInsights() && dayContext() === 'past') {
              <section class="ag-sec">
                <div class="ag-sec-head">
                  <span class="ag-sec-titr ag-sec-titr--act"><lucide-icon [img]="ActivityIcon" [size]="13"></lucide-icon> Utilisation réelle</span>
                  @if (dayForecast().length > 0) {
                    <span class="ag-cmp" title="Prévision vs réalité de ce jour">prévu {{ dayForecast().length }} · réel {{ dayActivity().length }}</span>
                  } @else {
                    <span class="ag-sec-badge ag-sec-badge--act">{{ dayActivity().length }}</span>
                  }
                </div>
                @if (dayActivity().length === 0) {
                  <p class="ag-sec-empty">Aucun véhicule n'a roulé ce jour.</p>
                } @else {
                  @for (a of dayActivity(); track a.vehicleId) {
                    <div class="ag-insight">
                      <span class="ag-insight-plate" [vehicleLink]="a.vehicleId" [attr.title]="'Voir ' + a.plate">{{ a.plate }}</span>
                      <span class="ag-insight-time">{{ a.trips }} trajet{{ a.trips > 1 ? 's' : '' }}</span>
                      <span class="ag-insight-km">{{ a.distanceKm }} km</span>
                    </div>
                  }
                }
              </section>
            }

            <!-- ── Réservations & événements (tous les jours) ── -->
            <section class="ag-sec">
              <div class="ag-sec-head">
                <span class="ag-sec-titr"><lucide-icon [img]="CalendarDaysIcon" [size]="13"></lucide-icon> Réservations &amp; événements</span>
                <span class="ag-sec-badge">{{ dayPanelEvents().length }}</span>
              </div>
              @if (dayPanelEvents().length === 0) {
                <p class="ag-sec-empty">Aucun événement enregistré ce jour.</p>
              }
              @for (ev of dayPanelEvents(); track ev.id) {
                <article class="ag-day-card" [style.--pill]="eventColor(ev)">
                  <div class="ag-day-card-top">
                    <span class="ag-day-card-type">
                      <lucide-icon [img]="ev.type === 'INCIDENT' ? AlertTriangleIcon : ev.type === 'RESERVATION' ? CalendarCheckIcon : WrenchIcon" [size]="12"></lucide-icon>
                      {{ eventTypeLabel(ev.type) }}
                    </span>
                    <span class="ag-day-card-badges">
                      @if (isImmobilizing(ev)) {
                        <span class="ag-blocked" title="Véhicule exclu des réservations et suggestions IA tant que l'événement est actif">Immobilisé</span>
                      }
                      <span class="ag-status" [attr.data-status]="ev.status">{{ eventStatusLabel(ev.status) }}</span>
                    </span>
                  </div>
                  <p class="ag-day-card-title">{{ ev.title }}</p>
                  <p class="ag-day-card-meta">
                    @if (ev.vehiclePlate) { <span class="ag-day-card-plate" [vehicleLink]="ev.vehicleId" [attr.title]="'Voir ' + ev.vehiclePlate">{{ ev.vehiclePlate }}</span> }
                    @if (ev.type === 'RESERVATION' && !ev.allDay) {
                      · {{ ev.startAt | date:'HH:mm' }}@if (ev.endAt) { → {{ ev.endAt | date:'HH:mm' }} }
                    } @else if (!ev.allDay) { · {{ ev.startAt | date:'HH:mm' }} }
                    @if (ev.odometerKm != null) { · {{ ev.odometerKm }} km }
                  </p>
                  @if (ev.description) { <p class="ag-day-card-desc">{{ ev.description }}</p> }
                  @if (reservationReason(ev)) { <p class="ag-day-card-desc">{{ reservationReason(ev) }}</p> }
                  @if (canManage() && ev.type !== 'RESERVATION') {
                    <div class="ag-day-card-actions">
                      @if (ev.status !== 'IN_PROGRESS' && ev.status !== 'DONE' && ev.status !== 'CANCELLED') {
                        <button type="button" (click)="setStatus(ev, 'IN_PROGRESS')" [disabled]="busyId() === ev.id"
                                class="ag-act ag-act--start">
                          <lucide-icon [img]="PlayIcon" [size]="12"></lucide-icon> En cours
                        </button>
                      }
                      @if (ev.status !== 'DONE' && ev.status !== 'CANCELLED') {
                        <button type="button" (click)="setStatus(ev, 'DONE')" [disabled]="busyId() === ev.id"
                                class="ag-act ag-act--done">
                          <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Terminé
                        </button>
                      }
                      <button type="button" (click)="deleteEvent(ev)" [disabled]="busyId() === ev.id"
                              class="ag-act ag-act--del" aria-label="Supprimer">
                        <lucide-icon [img]="Trash2Icon" [size]="12"></lucide-icon>
                      </button>
                    </div>
                  } @else if (ev.type === 'RESERVATION' && canManage() && ev.status !== 'DONE' && ev.status !== 'CANCELLED') {
                    <div class="ag-day-card-actions">
                      <button type="button" (click)="openEditReservation(ev)" [disabled]="busyId() === ev.id"
                              class="ag-act ag-act--start">
                        <lucide-icon [img]="PencilIcon" [size]="12"></lucide-icon> Éditer
                      </button>
                      <button type="button" (click)="cancelDayReservation(ev)" [disabled]="busyId() === ev.id"
                              class="ag-act ag-act--del">
                        <lucide-icon [img]="XIcon" [size]="12"></lucide-icon> Annuler
                      </button>
                    </div>
                  } @else if (ev.type === 'RESERVATION') {
                    <p class="ag-day-card-hint">Réservation gérée par un gestionnaire.</p>
                  }
                </article>
              }
            </section>
          </div>
          @if (canReserve()) {
            <footer class="ag-sheet-foot">
              <button type="button" (click)="reserveThisDay()" class="ag-btn-primary ag-btn-full">
                <lucide-icon [img]="CalendarCheckIcon" [size]="15"></lucide-icon><span>Réserver ce jour</span>
              </button>
            </footer>
          }
        </div>
      </div>
    }

    <!-- ─── Modal de création d'événement ─── -->
    @if (createOpen()) {
      <div class="ag-modal-root" (click)="createOpen.set(false)">
        <div class="ag-modal" (click)="$event.stopPropagation()" role="dialog" aria-label="Nouvel événement">
          <header class="ag-sheet-head">
            <h3 class="ag-sheet-title">Nouvel événement</h3>
            <button type="button" (click)="createOpen.set(false)" aria-label="Fermer" class="ag-icon-btn">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>
          <div class="ag-modal-body">
            <!-- Type -->
            <div class="ag-field">
              <label>Type</label>
              <div class="ag-seg ag-seg--full">
                <button type="button" (click)="setFormType('MAINTENANCE')"
                        class="ag-seg-btn" [class.ag-seg-btn--active]="form.type === 'MAINTENANCE'">Maintenance</button>
                <button type="button" (click)="setFormType('INCIDENT')"
                        class="ag-seg-btn" [class.ag-seg-btn--active]="form.type === 'INCIDENT'">Incident</button>
              </div>
            </div>
            <!-- Véhicule -->
            <div class="ag-field">
              <label for="ag-f-veh">Véhicule</label>
              <select id="ag-f-veh" class="ag-input" [(ngModel)]="form.vehicleId" (ngModelChange)="onCreateVehicleChange($event)">
                <option value="" disabled>Sélectionner…</option>
                @for (v of vehicles(); track v.id) {
                  <option [value]="v.id">{{ v.plate }}@if (v.brand) { — {{ v.brand }} {{ v.model }} }</option>
                }
              </select>
            </div>
            <!-- Titre -->
            <div class="ag-field">
              <label for="ag-f-title">Titre</label>
              <input id="ag-f-title" type="text" class="ag-input" [(ngModel)]="form.title"
                     placeholder="{{ form.type === 'INCIDENT' ? 'Ex. Pare-brise fissuré' : 'Ex. Vidange + filtres' }}" />
            </div>
            <!-- Catégorie -->
            <div class="ag-field">
              <label for="ag-f-cat">Catégorie</label>
              <input id="ag-f-cat" type="text" class="ag-input" [(ngModel)]="form.category"
                     placeholder="{{ form.type === 'INCIDENT' ? 'Ex. Carrosserie' : 'Ex. Révision' }}" />
            </div>
            <!-- Sévérité (incident) -->
            @if (form.type === 'INCIDENT') {
              <div class="ag-field">
                <label>Sévérité</label>
                <div class="ag-seg ag-seg--full">
                  <button type="button" (click)="form.severity = 'LOW'"
                          class="ag-seg-btn" [class.ag-seg-btn--active]="form.severity === 'LOW'">Faible</button>
                  <button type="button" (click)="form.severity = 'MEDIUM'"
                          class="ag-seg-btn" [class.ag-seg-btn--active]="form.severity === 'MEDIUM'">Moyenne</button>
                  <button type="button" (click)="form.severity = 'HIGH'"
                          class="ag-seg-btn" [class.ag-seg-btn--active]="form.severity === 'HIGH'">Critique</button>
                </div>
              </div>
            }
            <!-- Date + heure -->
            <div class="ag-field-row">
              <div class="ag-field">
                <label for="ag-f-date">Date</label>
                <input id="ag-f-date" type="date" class="ag-input" [(ngModel)]="form.date" />
              </div>
              <div class="ag-field ag-field--allday">
                <label class="ag-check">
                  <input type="checkbox" [(ngModel)]="form.allDay" />
                  <span>Toute la journée</span>
                </label>
              </div>
            </div>
            @if (!form.allDay) {
              <div class="ag-field">
                <label for="ag-f-time">Heure</label>
                <input id="ag-f-time" type="time" class="ag-input" [(ngModel)]="form.time" />
              </div>
            }
            <!-- Immobilisation : rend le véhicule indisponible (réservations + IA) -->
            <div class="ag-field">
              <label class="ag-check">
                <input type="checkbox" [(ngModel)]="form.blocksVehicle" />
                <span>Immobilise le véhicule</span>
              </label>
              <p class="ag-field-note">
                Tant que l'événement n'est pas terminé, le véhicule est exclu des réservations
                et des suggestions de l'IA (ex. roue crevée, passage au garage).
              </p>
            </div>
            <!-- Odomètre (pré-rempli via estimation GPS) -->
            <div class="ag-field">
              <label for="ag-f-odo">
                Kilométrage
                @if (odometerHint()) { <span class="ag-field-hint">{{ odometerHint() }}</span> }
              </label>
              <input id="ag-f-odo" type="number" min="0" class="ag-input" [(ngModel)]="form.odometerKm"
                     placeholder="km" />
            </div>
            <!-- Description -->
            <div class="ag-field">
              <label for="ag-f-desc">Description</label>
              <textarea id="ag-f-desc" class="ag-input ag-textarea" [(ngModel)]="form.description"
                        rows="3" placeholder="Détails (optionnel)"></textarea>
            </div>
          </div>
          <footer class="ag-modal-foot">
            <button type="button" (click)="createOpen.set(false)" class="ag-btn-ghost">Annuler</button>
            <button type="button" (click)="submitCreate()" [disabled]="!canSubmitCreate() || saving()"
                    class="ag-btn-primary">
              {{ saving() ? 'Création…' : 'Créer l\\'événement' }}
            </button>
          </footer>
        </div>
      </div>
    }

    <!-- ─── Sprint 9 (consolidation) — feuilles ouvertes depuis le calendrier ─── -->
    <app-reservation-sheet
      [open]="resSheetOpen()"
      [vehicles]="scopedVehicles()"
      [defaultDate]="resDefaultDate()"
      [startMode]="resStartMode()"
      [editReservation]="resEditReservation()"
      (closed)="resSheetOpen.set(false)"
      (created)="onReservationChanged()" />
    <app-optimization-sheet
      [open]="optSheetOpen()"
      (closed)="optSheetOpen.set(false)"
      (applied)="onReservationChanged()" />
  `,
  styles: [`
    /* ─── Boutons génériques ─── */
    .ag-btn-primary {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 10px;
      background: var(--tracky, #10E0A0); color: #fff;
      border: none; font-size: 13px; font-weight: 700; cursor: pointer;
      transition: background .15s, opacity .15s;
      white-space: nowrap;
    }
    .ag-btn-primary:hover:not(:disabled) { background: var(--tracky-dark, #0bb586); }
    .ag-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .ag-btn-ghost {
      padding: 8px 14px; border-radius: 10px;
      background: transparent; color: var(--fg-secondary);
      border: 1px solid var(--border-subtle); font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all .15s;
    }
    .ag-btn-ghost:hover { color: var(--fg-primary); border-color: var(--border-strong); }
    .ag-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ag-btn-soft {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 12px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all .15s; white-space: nowrap;
    }
    .ag-btn-soft:hover { color: var(--fg-primary); border-color: var(--border-strong); }
    .ag-btn-soft lucide-icon { color: var(--tracky-light); }
    .ag-badge { font-size: 11px; font-weight: 800; padding: 0 6px; border-radius: 999px; background: rgba(56,189,248,.18); color: #38BDF8; }
    .ag-btn-full { width: 100%; justify-content: center; }
    .ag-sheet-foot {
      display: flex; gap: 8px; padding: 12px 16px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    @media (max-width: 480px) {
      .ag-actions { width: 100%; }
      .ag-actions .ag-btn-soft, .ag-actions .ag-btn-primary { flex: 1; justify-content: center; }
    }
    .ag-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 8px;
      background: transparent; border: 0; color: var(--fg-tertiary); cursor: pointer;
      transition: all .15s; flex-shrink: 0;
    }
    .ag-icon-btn:hover { color: var(--fg-primary); background: var(--bg-tertiary); }

    /* ─── Strip de résumé ─── */
    .ag-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .ag-stat {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .ag-stat-icon {
      display: flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0;
    }
    .ag-stat--danger .ag-stat-icon { background: rgba(239,68,68,.14); color: var(--danger); }
    .ag-stat--warn .ag-stat-icon { background: rgba(245,158,11,.14); color: var(--warning); }
    .ag-stat--info .ag-stat-icon { background: rgba(16,224,160,.14); color: var(--tracky-light); }
    .ag-stat-body { display: flex; flex-direction: column; min-width: 0; }
    .ag-stat-value {
      font-size: 22px; font-weight: 800; line-height: 1;
      color: var(--fg-primary); font-family: var(--font-display, Poppins, sans-serif);
      letter-spacing: -.02em;
    }
    .ag-stat--danger .ag-stat-value { color: var(--danger); }
    .ag-stat-label {
      font-size: 10px; font-weight: 600; color: var(--fg-tertiary);
      text-transform: uppercase; letter-spacing: .04em; margin-top: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    @media (max-width: 480px) {
      .ag-summary { gap: 6px; }
      .ag-stat { flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px; }
      .ag-stat-value { font-size: 18px; }
      .ag-stat-label { font-size: 9px; }
    }

    /* ─── Barre de filtres ─── */
    .ag-filters {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .ag-dd-wrapper { position: relative; min-width: 0; }
    .ag-dd-trigger {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 12px; min-width: 150px; max-width: 220px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 12px; color: var(--fg-primary);
      font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .ag-dd-trigger:hover { border-color: var(--border-strong); }
    .ag-dd-trigger--open { border-color: var(--tracky); background: var(--bg-tertiary); }
    .ag-dd-trigger lucide-icon { color: var(--tracky-light); flex-shrink: 0; }
    .ag-dd-label { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ag-dd-chevron { transition: transform .2s; color: var(--fg-tertiary) !important; }
    .ag-dd-trigger--open .ag-dd-chevron { transform: rotate(180deg); }
    .ag-dd-backdrop { position: fixed; inset: 0; z-index: 50; background: transparent; }
    .ag-dd-menu {
      position: absolute; top: calc(100% + 6px); left: 0;
      min-width: 230px; max-width: 320px; max-height: 320px; overflow-y: auto;
      z-index: 60; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.22); padding: 6px;
      animation: ag-pop 160ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes ag-pop { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: none; } }
    .ag-dd-item {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      width: 100%; padding: 9px 12px; border-radius: 10px;
      background: transparent; border: 0; color: var(--fg-secondary);
      font-size: 13px; font-weight: 500; cursor: pointer; text-align: left; transition: all .12s;
    }
    .ag-dd-item:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .ag-dd-item--active { background: rgba(16,224,160,.10); color: var(--tracky-light); font-weight: 700; }
    .ag-dd-item--active lucide-icon { color: var(--tracky-light); }
    .ag-dd-item-content { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .ag-dd-item-plate { font-family: var(--font-mono, monospace); font-weight: 700; font-size: 13px; color: inherit; }
    .ag-dd-item-meta { font-size: 11px; color: var(--fg-tertiary); font-weight: 400; margin-top: 2px; }
    .ag-dd-divider { height: 1px; background: var(--border-subtle); margin: 6px 4px; }

    /* Segmented (type) */
    .ag-seg {
      display: inline-flex; padding: 3px; gap: 2px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 12px;
    }
    .ag-seg--full { display: flex; width: 100%; }
    .ag-seg-btn {
      flex: 1; padding: 6px 12px; border-radius: 9px;
      background: transparent; border: 0; color: var(--fg-tertiary);
      font-size: 12px; font-weight: 600; cursor: pointer; transition: all .15s; white-space: nowrap;
    }
    .ag-seg-btn:hover { color: var(--fg-secondary); }
    .ag-seg-btn--active { background: var(--bg-secondary); color: var(--tracky-light); box-shadow: 0 1px 2px rgba(0,0,0,.12); }

    /* Navigation mois */
    .ag-month-nav {
      display: inline-flex; align-items: center; gap: 4px;
      margin-left: auto;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 12px; padding: 4px;
    }
    .ag-month-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 8px;
      background: transparent; border: 0; color: var(--fg-secondary); cursor: pointer; transition: all .15s;
    }
    .ag-month-btn:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .ag-month-label {
      min-width: 120px; text-align: center; font-size: 13px; font-weight: 700;
      color: var(--fg-primary); text-transform: capitalize;
    }
    .ag-today-btn {
      padding: 6px 10px; border-radius: 8px; margin-left: 2px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .ag-today-btn:hover:not(:disabled) { color: var(--tracky-light); border-color: rgba(16,224,160,.3); }
    .ag-today-btn:disabled { opacity: .4; cursor: default; }
    @media (max-width: 640px) {
      .ag-filters { gap: 6px; }
      .ag-dd-trigger { min-width: 0; flex: 1; max-width: none; }
      .ag-seg { flex: 1; }
      .ag-month-nav { margin-left: 0; width: 100%; justify-content: space-between; }
      .ag-month-label { flex: 1; }
    }

    /* ─── Liste à venir / en retard ─── */
    .ag-up-row {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 10px 12px; padding-left: 0;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 12px; cursor: pointer; text-align: left; transition: border-color .15s, background .15s;
      overflow: hidden;
    }
    .ag-up-row:hover { border-color: var(--border-strong); background: var(--bg-tertiary); }
    .ag-up-bar { width: 4px; align-self: stretch; background: var(--u, #10E0A0); flex-shrink: 0; }
    .ag-up-type {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
      color: var(--pill, #10E0A0); background: color-mix(in srgb, var(--pill, #10E0A0) 14%, transparent);
    }
    .ag-up-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .ag-up-title {
      font-size: 13px; font-weight: 700; color: var(--fg-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ag-up-meta {
      font-size: 11px; color: var(--fg-tertiary); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ag-up-plate { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--fg-secondary); }
    .ag-up-date { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
    .ag-up-date-day { font-size: 12px; font-weight: 700; color: var(--fg-secondary); white-space: nowrap; }
    .ag-up-badge {
      font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 9999px;
      color: var(--u, #10E0A0); background: color-mix(in srgb, var(--u, #10E0A0) 16%, transparent);
      white-space: nowrap;
    }

    /* ─── Statut badge (générique) ─── */
    .ag-status {
      font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 9999px;
      background: var(--bg-tertiary); color: var(--fg-tertiary); white-space: nowrap;
    }
    .ag-status[data-status="OPEN"] { background: rgba(239,68,68,.12); color: var(--danger); }
    .ag-status[data-status="IN_PROGRESS"] { background: rgba(245,158,11,.14); color: var(--warning); }
    .ag-status[data-status="DONE"] { background: rgba(16,224,160,.12); color: var(--tracky-light); }
    .ag-status[data-status="PLANNED"] { background: var(--bg-tertiary); color: var(--fg-secondary); }
    .ag-status[data-status="CANCELLED"] { background: var(--bg-tertiary); color: var(--fg-tertiary); text-decoration: line-through; }

    /* ─── Bottom-sheet / modal partagés ─── */
    .ag-sheet-root, .ag-modal-root {
      position: fixed; inset: 0; z-index: 9000;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.5); backdrop-filter: blur(2px); padding: 16px;
      animation: ag-fade .15s ease-out;
    }
    @keyframes ag-fade { from { opacity: 0; } to { opacity: 1; } }
    .ag-sheet, .ag-modal {
      width: 100%; max-width: 440px;
      max-height: 86vh; max-height: 86dvh; /* dvh = iOS-safe (tient compte de la barre Safari) */
      display: flex; flex-direction: column;
      background: var(--bg-primary); border: 1px solid var(--border-subtle);
      border-radius: 18px; box-shadow: 0 24px 60px rgba(0,0,0,.4); overflow: hidden;
      animation: ag-rise .2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes ag-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .ag-sheet-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .ag-sheet-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .ag-sheet-sub { font-size: 11px; color: var(--fg-tertiary); margin: 2px 0 0; }
    .ag-sheet-body { padding: 12px 14px; padding-bottom: max(14px, env(safe-area-inset-bottom)); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .ag-sheet-empty { text-align: center; color: var(--fg-tertiary); font-size: 13px; padding: 20px 0; }

    .ag-day-card {
      padding: 12px; border-radius: 12px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-left: 3px solid var(--pill, #10E0A0);
    }
    .ag-day-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ag-day-card-type {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
      color: var(--pill, #10E0A0);
    }
    .ag-day-card-title { font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 8px 0 0; }
    .ag-day-card-meta { font-size: 11px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .ag-day-card-plate { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--fg-secondary); }
    .ag-day-card-desc { font-size: 12px; color: var(--fg-secondary); margin: 8px 0 0; line-height: 1.45; white-space: pre-wrap; }
    .ag-day-card-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    .ag-act {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 10px; border-radius: 8px;
      font-size: 11px; font-weight: 600; cursor: pointer; transition: all .15s;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary);
    }
    .ag-act:disabled { opacity: .5; cursor: wait; }
    .ag-act--start:hover:not(:disabled) { color: var(--warning); border-color: rgba(245,158,11,.3); background: rgba(245,158,11,.06); }
    .ag-act--done:hover:not(:disabled) { color: var(--tracky-light); border-color: rgba(16,224,160,.3); background: rgba(16,224,160,.06); }
    .ag-act--del { margin-left: auto; }
    .ag-act--del:hover:not(:disabled) { color: var(--danger); border-color: rgba(239,68,68,.3); background: rgba(239,68,68,.06); }

    /* ─── Formulaire de création ─── */
    .ag-modal-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
    .ag-modal-foot {
      display: flex; gap: 8px; justify-content: flex-end;
      padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .ag-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .ag-field-row { display: flex; gap: 10px; }
    .ag-field-row .ag-field { flex: 1; }
    .ag-field--allday { justify-content: flex-end; }
    .ag-field label {
      font-size: 11px; font-weight: 600; color: var(--fg-tertiary);
      text-transform: uppercase; letter-spacing: .03em;
      display: flex; align-items: center; gap: 6px;
    }
    .ag-field-hint { text-transform: none; letter-spacing: 0; color: var(--tracky-light); font-weight: 600; font-size: 10px; }
    .ag-field-note { font-size: 11px; color: var(--fg-tertiary); margin: 0; line-height: 1.4; }
    .ag-day-card-badges { display: inline-flex; align-items: center; gap: 6px; }
    .ag-blocked {
      font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 9999px;
      background: rgba(239,68,68,.12); color: var(--danger); white-space: nowrap;
      text-transform: uppercase; letter-spacing: .03em;
    }
    .ag-day-card-hint { font-size: 11px; color: var(--fg-tertiary); margin: 8px 0 0; font-style: italic; }

    /* ─── P2 — Panneau jour enrichi (contexte + 3 sections) ─── */
    .ag-ctx {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 4px;
      font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px;
    }
    .ag-ctx[data-ctx="past"]   { color: #38BDF8; background: rgba(56,189,248,.12); }
    .ag-ctx[data-ctx="today"]  { color: var(--tracky-light); background: rgba(16,224,160,.12); }
    .ag-ctx[data-ctx="future"] { color: #A78BFA; background: rgba(167,139,250,.12); }

    .ag-sec { display: flex; flex-direction: column; gap: 6px; }
    .ag-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ag-sec-titr {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: var(--fg-secondary);
    }
    .ag-sec-titr--fc { color: #A78BFA; }
    .ag-sec-titr--act { color: #38BDF8; }
    .ag-sec-badge {
      font-size: 11px; font-weight: 800; padding: 1px 8px; border-radius: 999px;
      background: var(--bg-tertiary); color: var(--fg-tertiary);
    }
    .ag-sec-badge--fc { background: rgba(167,139,250,.14); color: #A78BFA; }
    .ag-sec-badge--act { background: rgba(56,189,248,.14); color: #38BDF8; }
    .ag-cmp { font-size: 11px; font-weight: 700; color: var(--fg-tertiary); padding: 1px 8px; border-radius: 999px; background: var(--bg-tertiary); }
    .ag-sec-sub { font-size: 11px; color: var(--fg-tertiary); margin: -2px 0 2px; line-height: 1.4; }
    .ag-sec-empty { font-size: 12px; color: var(--fg-tertiary); padding: 6px 0; text-align: center; }

    /* Disponibilité */
    .ag-avail {
      padding: 14px; border-radius: 14px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .ag-avail--full { border-color: color-mix(in srgb, var(--tracky-light) 35%, var(--border-subtle)); }
    .ag-avail-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .ag-avail-count { display: inline-flex; align-items: baseline; gap: 4px; }
    .ag-avail-big { font-size: 28px; font-weight: 800; line-height: 1; color: var(--tracky-light); letter-spacing: -.02em; }
    .ag-avail-den { font-size: 15px; font-weight: 600; color: var(--fg-tertiary); }
    .ag-avail-lbl { font-size: 12.5px; color: var(--fg-secondary); }
    .ag-avail-bar { height: 6px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; margin: 12px 0 10px; }
    .ag-avail-bar > span { display: block; height: 100%; background: var(--tracky-light); border-radius: 999px; transition: width .3s ease; }
    .ag-avail-ok { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tracky-light); margin: 0; }
    .ag-unavail { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .ag-unavail-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
    .ag-unavail-ic {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 6px; flex-shrink: 0;
    }
    .ag-unavail-ic[data-kind="immobilized"] { background: rgba(239,68,68,.14); color: var(--danger); }
    .ag-unavail-ic[data-kind="reserved"] { background: rgba(56,189,248,.14); color: #38BDF8; }
    .ag-unavail-plate { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--fg-primary); }
    .ag-unavail-lbl { font-size: 12px; color: var(--fg-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Ligne d'insight (prévision / activité réelle) */
    .ag-insight {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .ag-insight-plate { font-family: var(--font-mono, monospace); font-weight: 700; font-size: 12.5px; color: var(--fg-primary); min-width: 76px; }
    .ag-insight-time { font-size: 12px; color: var(--fg-secondary); min-width: 74px; }
    .ag-insight-km { font-size: 12px; font-weight: 600; color: var(--fg-secondary); margin-left: auto; }
    .ag-insight-conf { flex: 1; display: flex; align-items: center; gap: 7px; min-width: 0; }
    .ag-insight-bar { flex: 1; height: 5px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .ag-insight-bar > span { display: block; height: 100%; border-radius: 999px; }
    .ag-insight-basis { font-size: 10.5px; color: var(--fg-tertiary); white-space: nowrap; }
    .ag-input {
      width: 100%; padding: 9px 11px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 13px; font-family: inherit;
      transition: border-color .15s;
    }
    .ag-input:focus { outline: none; border-color: var(--tracky-light); }
    .ag-input::placeholder { color: var(--fg-tertiary); }
    .ag-textarea { resize: vertical; min-height: 56px; line-height: 1.45; }
    .ag-check {
      display: inline-flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 600; color: var(--fg-secondary);
      text-transform: none; letter-spacing: 0; cursor: pointer; padding: 9px 0;
    }
    .ag-check input { width: 16px; height: 16px; accent-color: var(--tracky-light); cursor: pointer; }

    @media (max-width: 480px) {
      .ag-sheet-root, .ag-modal-root { align-items: flex-end; padding: 0; }
      .ag-sheet, .ag-modal {
        max-width: none;
        max-height: 92vh; max-height: 92dvh; /* iOS-safe */
        border-radius: 18px 18px 0 0; border-bottom: 0;
      }
      @keyframes ag-rise { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: none; } }
    }
  `],
})
export class AgendaComponent implements OnInit {
  private readonly api = inject(AgendaApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly scrollLock = inject(ScrollLockService);
  private readonly fleetFilter = inject(FleetFilterService);

  // Verrou de scroll pour les overlays custom (modal création/incident + panneau
  // du jour) : fige la page derrière tant qu'un des deux est ouvert.
  private readonly lockEffect = effect((onCleanup) => {
    if (this.createOpen() || this.dayPanelOpen()) {
      this.scrollLock.lock();
      onCleanup(() => this.scrollLock.unlock());
    }
  });

  // Filtre société global (SUPER_ADMIN) : recharge tout l'agenda quand la société change,
  // et réinitialise les filtres groupe/véhicule (ils appartiennent à l'ancienne société).
  // Les écritures de signaux sont différées hors de l'exécution synchrone de l'effect.
  private readonly fleetFilterEffect = effect(() => {
    this.fleetFilter.selectedFleetId(); // dépendance
    if (!this.initialised) return; // ne pas re-déclencher pendant le premier chargement
    queueMicrotask(() => {
      this.selectedGroupId.set('');
      this.selectedVehicleId.set('');
      void this.loadEvents();
      void this.loadSummary();
      void this.loadActivity();
      void this.loadForecast();
    });
  });
  /** Passe à true après le premier chargement (évite un double-fetch au démarrage). */
  private initialised = false;

  // ─── Icônes ───────────────────────────────────────────────────────────────
  protected readonly CalendarDaysIcon = CalendarDays;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronLeftIcon = ChevronLeft;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly CheckIcon = Check;
  protected readonly LayersIcon = Layers;
  protected readonly TruckIcon = Truck;
  protected readonly PlusIcon = Plus;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly CalendarClockIcon = CalendarClock;
  protected readonly WrenchIcon = Wrench;
  protected readonly XIcon = X;
  protected readonly Trash2Icon = Trash2;
  protected readonly PencilIcon = Pencil;
  protected readonly PlayIcon = Play;
  protected readonly ListChecksIcon = ListChecks;
  protected readonly GaugeIcon = Gauge;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly InboxIcon = Inbox;
  protected readonly SparklesIcon = Sparkles;
  protected readonly ActivityIcon = Activity;
  protected readonly ShieldCheckIcon = ShieldCheck;
  protected readonly BanIcon = Ban;
  protected readonly InfoIcon = Info;

  // ─── Helpers exposés au template ───────────────────────────────────────────
  protected readonly eventColor = eventColor;
  protected readonly eventTypeLabel = eventTypeLabel;
  protected readonly eventStatusLabel = eventStatusLabel;
  protected readonly eventUrgency = eventUrgency;
  protected readonly urgencyColor = urgencyColor;
  protected readonly severityLabel = severityLabel;

  // ─── État ───────────────────────────────────────────────────────────────────
  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly events = signal<VehicleEventDto[]>([]);
  protected readonly summary = signal<AgendaSummaryDto | null>(null);
  protected readonly loading = signal(true);

  protected readonly currentMonth = signal(startOfMonth(new Date()));
  /**
   * Sprint 8 — créneaux BRUTS gardés en mémoire (activité réelle = trajets ; prévu = récurrence).
   * Source unique des dérivés « par jour » (badges calendrier) ET du détail riche du panneau
   * jour (P2). Gardés par `reservations_view` (sinon vidés). Un tableau vide = couche masquée.
   */
  private readonly activitySlots = signal<VehicleActivitySlotDto[]>([]);
  private readonly forecastSlots = signal<ForecastSlotDto[]>([]);
  protected readonly selectedGroupId = signal('');
  protected readonly selectedVehicleId = signal('');
  protected readonly selectedType = signal<'' | VehicleEventType>('');

  protected readonly groupDdOpen = signal(false);
  protected readonly vehicleDdOpen = signal(false);

  // Panneau jour
  protected readonly dayPanelOpen = signal(false);
  protected readonly selectedDay = signal<string>('');
  protected readonly busyId = signal<string | null>(null);

  // Modal création
  protected readonly createOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly odometerHint = signal('');
  protected form: {
    type: VehicleEventType;
    vehicleId: string;
    title: string;
    category: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    date: string;
    time: string;
    allDay: boolean;
    blocksVehicle: boolean;
    odometerKm: number | null;
    description: string;
  } = this.blankForm();

  protected readonly typeOptions: { value: '' | VehicleEventType; label: string }[] = [
    { value: '', label: 'Tous' },
    { value: 'MAINTENANCE', label: 'Maintenance' },
    { value: 'INCIDENT', label: 'Incident' },
    { value: 'RESERVATION', label: 'Réservation' },
  ];

  private readonly monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
  private readonly dayLabelFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ─── Permissions ────────────────────────────────────────────────────────────
  protected readonly canManage = computed(() => this.perms.can('agenda_manage'));
  // Sprint 9 (consolidation) — actions Réservation / Optimisation ouvertes depuis le calendrier.
  protected readonly canReserve = computed(() => this.perms.can('reservations_request'));
  protected readonly canValidate = computed(() => this.perms.can('reservations_manage'));
  protected readonly canOptimize = computed(() => this.perms.can('reservations_view'));
  /** Couches d'analyse (activité réelle, prévision, disponibilité) — même garde que la donnée. */
  protected readonly canSeeInsights = computed(() => this.perms.can('reservations_view'));
  protected readonly resSheetOpen = signal(false);
  protected readonly resStartMode = signal<'request' | 'validate'>('request');
  protected readonly resDefaultDate = signal<string | null>(null);
  /** #4 — réservation en cours d'édition (null = création / validation). */
  protected readonly resEditReservation = signal<VehicleEventDto | null>(null);
  protected readonly optSheetOpen = signal(false);
  /** Nb de demandes de réservation en attente (dérivé des événements déjà chargés). */
  protected readonly pendingCount = computed(() =>
    this.events().filter((e) => e.type === 'RESERVATION' && e.status === 'REQUESTED').length,
  );

  // ─── Dérivés filtres ─────────────────────────────────────────────────────────
  /** Véhicules restreints à la société sélectionnée (filtre global SUPER_ADMIN ; no-op sinon). */
  protected readonly scopedVehicles = computed(() =>
    this.vehicles().filter((v) => this.fleetFilter.matches(v.fleetId)),
  );

  /** Groupes uniques tirés des véhicules de la société courante (dédup par id). */
  protected readonly groupOptions = computed<GroupOption[]>(() => {
    const map = new Map<string, GroupOption>();
    for (const v of this.scopedVehicles()) {
      if (v.group?.id && !map.has(v.group.id)) map.set(v.group.id, { id: v.group.id, name: v.group.name });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Véhicules visibles dans le dropdown (société courante, restreints au groupe sélectionné). */
  protected readonly visibleVehicles = computed(() => {
    const gid = this.selectedGroupId();
    const list = this.scopedVehicles();
    return gid ? list.filter((v) => v.group?.id === gid) : list;
  });

  protected readonly selectedGroupLabel = computed(() => {
    const gid = this.selectedGroupId();
    if (!gid) return 'Tous les groupes';
    return this.groupOptions().find((g) => g.id === gid)?.name ?? 'Groupe';
  });

  protected readonly selectedVehicleLabel = computed(() => {
    const vid = this.selectedVehicleId();
    if (!vid) return 'Tous les véhicules';
    return this.vehicles().find((v) => v.id === vid)?.plate ?? 'Véhicule';
  });

  protected readonly monthLabel = computed(() => this.monthFmt.format(this.currentMonth()));

  protected readonly isCurrentMonth = computed(() => {
    const now = startOfMonth(new Date());
    const cur = this.currentMonth();
    return now.getFullYear() === cur.getFullYear() && now.getMonth() === cur.getMonth();
  });

  /** Ensemble des véhicules du groupe sélectionné (null = pas de filtre groupe). */
  private readonly groupVehicleIdSet = computed<Set<string> | null>(() => {
    const gid = this.selectedGroupId();
    if (!gid) return null;
    return new Set(this.scopedVehicles().filter((v) => v.group?.id === gid).map((v) => v.id));
  });

  /**
   * Événements restreints au périmètre groupe + véhicule (SANS le filtre de type). Base commune :
   * le calendrier y applique le type par-dessus, mais le panneau jour et la disponibilité ont
   * besoin de TOUS les types (une réservation ne doit pas disparaître parce qu'on filtre « Incident »).
   */
  private readonly scopedEvents = computed(() => {
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    return this.events().filter((ev) => {
      if (vid && ev.vehicleId !== vid) return false;
      if (gids && !gids.has(ev.vehicleId)) return false;
      return true;
    });
  });

  /** Événements filtrés pour le calendrier : scope + filtre de type (instantané, sans round-trip). */
  protected readonly filteredEvents = computed(() => {
    const type = this.selectedType();
    return type ? this.scopedEvents().filter((ev) => ev.type === type) : this.scopedEvents();
  });

  /** Véhicules du périmètre courant (société + groupe + véhicule) — dénominateur de la disponibilité. */
  private readonly availabilityVehicles = computed(() => {
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    return this.scopedVehicles().filter((v) => {
      if (vid && v.id !== vid) return false;
      if (gids && !gids.has(v.id)) return false;
      return true;
    });
  });

  // ─── Couches dérivées des créneaux bruts (calendrier : compteurs par jour) ──
  /** Nb de véhicules DISTINCTS ayant roulé par jour (badge bleu « ● N » du calendrier). */
  protected readonly activityByDay = computed<Map<string, number>>(() => {
    const perDay = new Map<string, Set<string>>();
    for (const slot of this.activitySlots()) {
      const start = new Date(slot.startAt);
      if (Number.isNaN(start.getTime())) continue;
      const end = slot.endAt ? new Date(slot.endAt) : start;
      const cursor = new Date(start);
      cursor.setHours(0, 0, 0, 0);
      let steps = 0;
      while (cursor.getTime() <= end.getTime() && steps < 45) {
        const key = localIso(cursor);
        let set = perDay.get(key);
        if (!set) { set = new Set(); perDay.set(key, set); }
        set.add(slot.vehicleId);
        cursor.setDate(cursor.getDate() + 1);
        steps++;
      }
    }
    const counts = new Map<string, number>();
    for (const [key, set] of perDay) counts.set(key, set.size);
    return counts;
  });

  /** Nb de véhicules DISTINCTS dont l'usage est PRÉVU par jour (badge violet « ~N »). */
  protected readonly forecastByDay = computed<Map<string, number>>(() => {
    const perDay = new Map<string, Set<string>>();
    for (const slot of this.forecastSlots()) {
      const start = new Date(slot.startAt);
      if (Number.isNaN(start.getTime())) continue;
      const key = localIso(start);
      let set = perDay.get(key);
      if (!set) { set = new Set(); perDay.set(key, set); }
      set.add(slot.vehicleId);
    }
    const counts = new Map<string, number>();
    for (const [key, set] of perDay) counts.set(key, set.size);
    return counts;
  });

  // ─── Détail du jour sélectionné (P2 — panneau jour enrichi) ─────────────────
  /** Bornes [start, end) du jour sélectionné, en heure locale (ms epoch). */
  private readonly selectedDayBounds = computed<{ start: number; end: number } | null>(() => {
    const day = this.selectedDay();
    if (!day) return null;
    const [y, m, d] = day.split('-').map(Number);
    const start = new Date(y, m - 1, d).getTime();
    return { start, end: start + 86400000 };
  });

  /** Contexte temporel du jour : conditionne ce qu'on montre (prévu vs réel). */
  protected readonly dayContext = computed<'past' | 'today' | 'future'>(() => {
    const b = this.selectedDayBounds();
    if (!b) return 'future';
    const today = startOfDay(new Date()).getTime();
    if (b.start < today) return 'past';
    if (b.start === today) return 'today';
    return 'future';
  });

  protected readonly dayContextLabel = computed(() => {
    switch (this.dayContext()) {
      case 'past': return 'Jour passé — utilisation réelle';
      case 'today': return "Aujourd'hui";
      default: return 'À venir';
    }
  });

  /** Événements du jour sélectionné (chevauchant, tous types du périmètre), triés. */
  protected readonly dayPanelEvents = computed(() => {
    const b = this.selectedDayBounds();
    if (!b) return [];
    return this.scopedEvents()
      .filter((ev) => {
        const st = new Date(ev.startAt).getTime();
        if (Number.isNaN(st)) return false;
        const effEnd = this.eventSpanEndMs(ev, st);
        // Chevauche le jour ; un événement immobilisant actif (ex. incident ouvert sans fin)
        // apparaît chaque jour où il rend le véhicule indisponible — cohérent avec la Disponibilité.
        return st < b.end && (effEnd >= b.start || (st >= b.start && st < b.end));
      })
      .sort((a, b2) => {
        const aDone = a.status === 'DONE' || a.status === 'CANCELLED' ? 1 : 0;
        const bDone = b2.status === 'DONE' || b2.status === 'CANCELLED' ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return new Date(a.startAt).getTime() - new Date(b2.startAt).getTime();
      });
  });

  /** Usage PRÉVU du jour (créneaux de récurrence projetés), trié par heure. */
  protected readonly dayForecast = computed(() => {
    const b = this.selectedDayBounds();
    if (!b || !this.canSeeInsights()) return [];
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    return this.forecastSlots()
      .filter((s) => {
        const t = new Date(s.startAt).getTime();
        if (Number.isNaN(t) || t < b.start || t >= b.end) return false;
        if (vid && s.vehicleId !== vid) return false;
        if (gids && !gids.has(s.vehicleId)) return false;
        return true;
      })
      .sort((a, b2) => new Date(a.startAt).getTime() - new Date(b2.startAt).getTime())
      .map((s) => ({
        vehicleId: s.vehicleId,
        plate: s.vehiclePlate ?? '—',
        time: `${this.hm(s.startAt)} → ${this.hm(s.endAt)}`,
        basis: s.basis,
        confidence: s.confidence,
      }));
  });

  /** Utilisation RÉELLE du jour (trajets agrégés par véhicule), triée par distance. */
  protected readonly dayActivity = computed(() => {
    const b = this.selectedDayBounds();
    if (!b || !this.canSeeInsights()) return [];
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    const byVeh = new Map<string, { plate: string; distanceKm: number; trips: number }>();
    for (const s of this.activitySlots()) {
      const st = new Date(s.startAt).getTime();
      const en = s.endAt ? new Date(s.endAt).getTime() : st;
      if (Number.isNaN(st) || st >= b.end || en < b.start) continue;
      if (vid && s.vehicleId !== vid) continue;
      if (gids && !gids.has(s.vehicleId)) continue;
      const cur = byVeh.get(s.vehicleId) ?? { plate: s.vehiclePlate ?? '—', distanceKm: 0, trips: 0 };
      cur.distanceKm += s.distanceKm ?? 0;
      cur.trips += 1;
      byVeh.set(s.vehicleId, cur);
    }
    return [...byVeh.entries()]
      .map(([vehicleId, v]) => ({ vehicleId, plate: v.plate, trips: v.trips, distanceKm: Math.round(v.distanceKm) }))
      .sort((a, b2) => b2.distanceKm - a.distanceKm);
  });

  /**
   * Disponibilité du jour (aujourd'hui + à venir) : combien de véhicules du périmètre sont libres,
   * et le détail des indisponibles (immobilisés / réservés). Aligné sur la logique backend
   * (findImmobilized) : incident sans fin = jusqu'à résolution, maintenance sans fin = sa journée.
   */
  protected readonly dayAvailability = computed(() => {
    const universe = this.availabilityVehicles();
    const total = universe.length;
    const b = this.selectedDayBounds();
    const unavailable: { vehicleId: string; plate: string; kind: 'immobilized' | 'reserved'; label: string }[] = [];
    if (!b || total === 0) return { total, available: total, pct: 100, unavailable };

    const ids = new Set(universe.map((v) => v.id));
    const plateOf = new Map(universe.map((v) => [v.id, v.plate ?? '—']));
    const immobilized = new Map<string, string>();
    const reserved = new Map<string, string>();
    for (const ev of this.events()) {
      if (!ids.has(ev.vehicleId)) continue;
      if (ev.status === 'DONE' || ev.status === 'CANCELLED') continue;
      const st = new Date(ev.startAt).getTime();
      if (Number.isNaN(st)) continue;
      // Fin effective = SOURCE UNIQUE partagée avec le back (findImmobilized) : la disponibilité
      // affichée correspond exactement à ce que la réservation acceptera (pas de « libre » → 409).
      const effEnd = effectiveBlockingEndMs(ev.type, st, ev.endAt ? new Date(ev.endAt).getTime() : null);
      if (!(st < b.end && effEnd > b.start)) continue; // ne chevauche pas le jour
      if (ev.type === 'RESERVATION') {
        if (ev.status === 'CONFIRMED' || ev.status === 'IN_PROGRESS') {
          reserved.set(ev.vehicleId, ev.endAt ? `${this.hm(ev.startAt)} → ${this.hm(ev.endAt)}` : this.hm(ev.startAt));
        }
      } else if (isImmobilizingEvent(ev)) {
        immobilized.set(ev.vehicleId, ev.title);
      }
    }
    for (const [vid, reason] of immobilized) {
      unavailable.push({ vehicleId: vid, plate: plateOf.get(vid) ?? '—', kind: 'immobilized', label: reason });
    }
    for (const [vid, label] of reserved) {
      if (immobilized.has(vid)) continue; // immobilisé = raison plus forte, pas de doublon
      unavailable.push({ vehicleId: vid, plate: plateOf.get(vid) ?? '—', kind: 'reserved', label });
    }
    const available = Math.max(0, total - unavailable.length);
    return { total, available, pct: Math.round((available / total) * 100), unavailable };
  });

  protected readonly dayPanelLabel = computed(() => {
    const day = this.selectedDay();
    if (!day) return '';
    const [y, m, d] = day.split('-').map(Number);
    return this.dayLabelFmt.format(new Date(y, m - 1, d));
  });

  /** Liste « à venir & en retard » : PLANNED/OPEN/IN_PROGRESS, triés par échéance. */
  protected readonly upcomingEvents = computed(() => {
    return this.filteredEvents()
      .filter((ev) => ev.status === 'PLANNED' || ev.status === 'OPEN' || ev.status === 'IN_PROGRESS')
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
      .slice(0, 25);
  });

  // Méthode (PAS un computed) : `form` est un objet simple muté par ngModel — un computed
  // ne lit aucun signal donc resterait FIGÉ à sa valeur initiale (form vide → false → bouton
  // toujours grisé). Une méthode est ré-évaluée à chaque détection de changement (les events
  // ngModel/click en déclenchent une), donc elle reflète l'état réel du formulaire.
  protected canSubmitCreate(): boolean {
    const f = this.form;
    return !!f.vehicleId && f.title.trim().length > 0 && !!f.date;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────
  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadVehicles(), this.loadSummary()]);
    await this.loadEvents();
    void this.loadActivity();
    void this.loadForecast();
    this.initialised = true; // à partir d'ici, un changement de société recharge tout
  }

  /** Société filtrée (SUPER_ADMIN) passée aux endpoints ; undefined = toutes / rôle non-SA. */
  private currentFleetId(): string | undefined {
    return this.fleetFilter.selectedFleetId() ?? undefined;
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.createOpen()) { this.createOpen.set(false); return; }
    if (this.dayPanelOpen()) { this.dayPanelOpen.set(false); return; }
    if (this.groupDdOpen()) this.groupDdOpen.set(false);
    if (this.vehicleDdOpen()) this.vehicleDdOpen.set(false);
  }

  private async loadVehicles(): Promise<void> {
    try {
      this.vehicles.set(await firstValueFrom(this.vehiclesApi.list()));
    } catch {
      this.vehicles.set([]);
    }
  }

  private async loadSummary(): Promise<void> {
    try {
      this.summary.set(await firstValueFrom(this.api.summary(this.currentFleetId())));
    } catch {
      this.summary.set(null);
    }
  }

  /** Fenêtre temporelle = grille calendrier complète (du lundi de la 1re semaine
   *  au dimanche de la dernière, soit 6 semaines) pour couvrir les jours hors-mois. */
  private monthWindow(): { from: string; to: string } {
    const monthFirst = startOfMonth(this.currentMonth());
    const start = new Date(monthFirst);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // lundi de la 1re semaine
    const end = new Date(start);
    end.setDate(end.getDate() + 42); // exclusif (6 semaines)
    return { from: start.toISOString(), to: end.toISOString() };
  }

  private async loadEvents(): Promise<void> {
    this.loading.set(true);
    try {
      const { from, to } = this.monthWindow();
      const events = await firstValueFrom(
        this.api.listEvents({
          from,
          to,
          // Société filtrée côté serveur (SUPER_ADMIN) ; groupe/véhicule/type = filtre client instantané.
          fleetId: this.currentFleetId(),
        }),
      );
      this.events.set(events);
    } catch (err) {
      this.events.set([]);
      this.toast.error(
        'Erreur de chargement',
        err instanceof HttpErrorResponse ? err.error?.message : 'Impossible de charger l\'agenda.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Sprint 8 — couche « activité réelle » : nb de véhicules ayant roulé par jour sur la
   * fenêtre du mois (dérivé des trajets). Gardée par `reservations_view` (sinon masquée).
   * Échec silencieux : l'agenda reste fonctionnel sans cette couche.
   */
  private async loadActivity(): Promise<void> {
    if (!this.canSeeInsights()) {
      this.activitySlots.set([]);
      return;
    }
    try {
      const { from, to } = this.monthWindow();
      const avail = await firstValueFrom(this.api.getAvailability({ from, to, fleetId: this.currentFleetId() }));
      this.activitySlots.set(avail.slots);
    } catch {
      this.activitySlots.set([]);
    }
  }

  /**
   * Sprint 8 (Palier C) — couche « usage prévu » : créneaux de récurrence dérivés des trajets
   * (jamais bloquants). Gardée par `reservations_view`. Les compteurs par jour (calendrier) et
   * le détail du panneau jour en sont dérivés.
   */
  private async loadForecast(): Promise<void> {
    if (!this.canSeeInsights()) {
      this.forecastSlots.set([]);
      return;
    }
    try {
      const { from, to } = this.monthWindow();
      const res = await firstValueFrom(this.api.getForecast({ from, to, fleetId: this.currentFleetId() }));
      this.forecastSlots.set(res.slots);
    } catch {
      this.forecastSlots.set([]);
    }
  }

  // ─── Filtres ─────────────────────────────────────────────────────────────────
  protected selectGroup(id: string): void {
    this.selectedGroupId.set(id);
    this.groupDdOpen.set(false);
    // Si le véhicule sélectionné n'est plus dans le groupe, on le réinitialise.
    const vid = this.selectedVehicleId();
    if (vid && id && !this.vehicles().some((v) => v.id === vid && v.group?.id === id)) {
      this.selectedVehicleId.set('');
    }
  }

  protected selectVehicle(id: string): void {
    this.selectedVehicleId.set(id);
    this.vehicleDdOpen.set(false);
  }

  protected selectType(type: '' | VehicleEventType): void {
    this.selectedType.set(type);
  }

  protected prevMonth(): void {
    this.currentMonth.set(addMonths(this.currentMonth(), -1));
    void this.loadEvents();
    void this.loadActivity();
    void this.loadForecast();
  }

  protected nextMonth(): void {
    this.currentMonth.set(addMonths(this.currentMonth(), 1));
    void this.loadEvents();
    void this.loadActivity();
    void this.loadForecast();
  }

  protected goToday(): void {
    if (this.isCurrentMonth()) return;
    this.currentMonth.set(startOfMonth(new Date()));
    void this.loadEvents();
    void this.loadActivity();
    void this.loadForecast();
  }

  // ─── Panneau jour ──────────────────────────────────────────────────────────
  protected onDayClick(iso: string): void {
    this.selectedDay.set(iso);
    this.dayPanelOpen.set(true);
  }

  protected onEventClick(ev: VehicleEventDto): void {
    this.selectedDay.set(localIso(new Date(ev.startAt)));
    this.dayPanelOpen.set(true);
  }

  protected closeDayPanel(): void {
    this.dayPanelOpen.set(false);
  }

  protected urgencyLabel(ev: VehicleEventDto): string {
    const u = eventUrgency(ev);
    if (u === 'overdue') return 'En retard';
    if (u === 'soon') return 'Bientôt';
    return 'Planifié';
  }

  /** Heure locale format FR compact : « 7h » ou « 7h30 ». */
  protected hm(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = d.getMinutes();
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
  }

  /** Couleur de la barre de confiance d'une prévision (vert fort → gris faible). */
  protected confColor(c: number): string {
    if (c >= 0.6) return '#10E0A0';
    if (c >= 0.35) return '#F59E0B';
    return '#94A3B8';
  }

  /** Motif d'une réservation (stocké en metadata) pour l'afficher dans la carte du jour. */
  protected reservationReason(ev: VehicleEventDto): string | null {
    const reason = (ev.metadata as { reason?: unknown } | null)?.reason;
    return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  }

  /** Met à jour le statut d'un événement (En cours / Terminé) — optimiste. */
  protected async setStatus(ev: VehicleEventDto, status: VehicleEventStatus): Promise<void> {
    if (!this.canManage()) return;
    this.busyId.set(ev.id);
    try {
      const updated = await firstValueFrom(this.api.updateEvent(ev.id, { status }));
      this.events.update((list) => list.map((e) => (e.id === updated.id ? updated : e)));
      this.toast.success(status === 'DONE' ? 'Marqué terminé' : 'Mis à jour');
      void this.loadSummary();
    } catch (err) {
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : 'Action impossible.');
    } finally {
      this.busyId.set(null);
    }
  }

  protected async deleteEvent(ev: VehicleEventDto): Promise<void> {
    if (!this.canManage()) return;
    if (!confirm(`Supprimer « ${ev.title} » ?`)) return;
    this.busyId.set(ev.id);
    try {
      await firstValueFrom(this.api.deleteEvent(ev.id));
      this.events.update((list) => list.filter((e) => e.id !== ev.id));
      this.toast.success('Événement supprimé');
      void this.loadSummary();
    } catch (err) {
      this.toast.error('Échec suppression', err instanceof HttpErrorResponse ? err.error?.message : '');
    } finally {
      this.busyId.set(null);
    }
  }

  // ─── Création ────────────────────────────────────────────────────────────────
  private blankForm() {
    const today = localIso(new Date());
    return {
      type: 'MAINTENANCE' as VehicleEventType,
      vehicleId: this.selectedVehicleId() || '',
      title: '',
      category: '',
      severity: 'MEDIUM' as 'LOW' | 'MEDIUM' | 'HIGH',
      date: today,
      time: '09:00',
      allDay: true,
      blocksVehicle: false, // défaut MAINTENANCE ; setFormType() le passe à true pour un incident
      odometerKm: null as number | null,
      description: '',
    };
  }

  /** Changement de type : ajuste le défaut d'immobilisation (incident = indisponible). */
  protected setFormType(type: VehicleEventType): void {
    this.form.type = type;
    this.form.blocksVehicle = type === 'INCIDENT';
  }

  /** L'événement immobilise-t-il ENCORE le véhicule (actif, non clôturé) ? Source partagée avec le back. */
  protected isImmobilizing(ev: VehicleEventDto): boolean {
    return isImmobilizingEvent(ev);
  }

  /** Fin d'un événement pour le test de chevauchement du jour : étendue si immobilisation active. */
  private eventSpanEndMs(ev: VehicleEventDto, startMs: number): number {
    if (isImmobilizingEvent(ev)) {
      return effectiveBlockingEndMs(ev.type, startMs, ev.endAt ? new Date(ev.endAt).getTime() : null);
    }
    return ev.endAt ? new Date(ev.endAt).getTime() : startMs;
  }

  protected openCreate(): void {
    this.form = this.blankForm();
    this.odometerHint.set('');
    this.createOpen.set(true);
    // Pré-remplit l'odomètre si un véhicule est déjà sélectionné via le filtre.
    if (this.form.vehicleId) void this.prefillOdometer(this.form.vehicleId);
  }

  protected onCreateVehicleChange(vehicleId: string): void {
    if (vehicleId) void this.prefillOdometer(vehicleId);
  }

  /** Récupère l'estimation kilométrique et pré-remplit le champ + un hint. */
  private async prefillOdometer(vehicleId: string): Promise<void> {
    try {
      const est = await firstValueFrom(this.api.odometer(vehicleId));
      if (est.estimatedKm != null) {
        this.form.odometerKm = Math.round(est.estimatedKm);
        this.odometerHint.set('estimation GPS');
      } else if (est.lastOdometerKm != null) {
        this.form.odometerKm = est.lastOdometerKm;
        this.odometerHint.set('dernier relevé');
      } else {
        this.odometerHint.set('');
      }
    } catch {
      this.odometerHint.set('');
    }
  }

  protected async submitCreate(): Promise<void> {
    if (!this.canSubmitCreate() || this.saving()) return;
    const f = this.form;
    // Compose le startAt : date seule (allDay) ou date + heure locale.
    const startAt = f.allDay
      ? new Date(`${f.date}T00:00:00`).toISOString()
      : new Date(`${f.date}T${f.time || '00:00'}:00`).toISOString();

    const payload: CreateVehicleEventDto = {
      vehicleId: f.vehicleId,
      type: f.type,
      title: f.title.trim(),
      startAt,
      allDay: f.allDay,
      blocksVehicle: f.blocksVehicle,
      status: f.type === 'INCIDENT' ? 'OPEN' : 'PLANNED',
    };
    if (f.category.trim()) payload.category = f.category.trim();
    if (f.description.trim()) payload.description = f.description.trim();
    if (f.type === 'INCIDENT') payload.severity = f.severity;
    if (f.odometerKm != null && !Number.isNaN(f.odometerKm)) payload.odometerKm = Number(f.odometerKm);

    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.createEvent(payload));
      // Ajoute à la liste si l'événement tombe dans la fenêtre du mois affiché.
      const { from, to } = this.monthWindow();
      const t = new Date(created.startAt).getTime();
      if (t >= new Date(from).getTime() && t < new Date(to).getTime()) {
        this.events.update((list) => [...list, created]);
      }
      this.toast.success('Événement créé', created.title);
      this.createOpen.set(false);
      void this.loadSummary();
    } catch (err) {
      this.toast.error('Échec création', err instanceof HttpErrorResponse ? err.error?.message : 'Création impossible.');
    } finally {
      this.saving.set(false);
    }
  }

  // ─── Sprint 9 (consolidation) — feuilles Réservation / Optimisation ─────────
  protected openReserve(date?: string): void {
    this.resEditReservation.set(null);
    this.resDefaultDate.set(date ?? null);
    this.resStartMode.set('request');
    this.resSheetOpen.set(true);
  }

  protected openValidate(): void {
    this.resEditReservation.set(null);
    this.resDefaultDate.set(null);
    this.resStartMode.set('validate');
    this.resSheetOpen.set(true);
  }

  /** #4 — Éditer une réservation depuis le panneau jour (ouvre la feuille en mode édition). */
  protected openEditReservation(ev: VehicleEventDto): void {
    this.closeDayPanel();
    this.resEditReservation.set(ev);
    this.resDefaultDate.set(null);
    this.resSheetOpen.set(true);
  }

  /** #4 — Annuler une réservation depuis le panneau jour (annulable même validée). */
  protected async cancelDayReservation(ev: VehicleEventDto): Promise<void> {
    if (!this.canManage()) return;
    if (!confirm(`Annuler la réservation « ${ev.title} » ?`)) return;
    this.busyId.set(ev.id);
    try {
      await firstValueFrom(this.api.cancelReservation(ev.id));
      this.toast.success('Réservation annulée');
      this.onReservationChanged();
      this.closeDayPanel();
    } catch (err) {
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : 'Annulation impossible.');
    } finally {
      this.busyId.set(null);
    }
  }

  protected openOptim(): void {
    this.optSheetOpen.set(true);
  }

  /** « Réserver ce jour » depuis le panneau jour : ferme le panneau, ouvre la demande pré-datée. */
  protected reserveThisDay(): void {
    const day = this.selectedDay();
    this.closeDayPanel();
    this.openReserve(day || undefined);
  }

  /** Une réservation a été déposée / validée / refusée → recharge l'agenda. */
  protected onReservationChanged(): void {
    void this.loadEvents();
    void this.loadSummary();
    void this.loadActivity();
  }
}
