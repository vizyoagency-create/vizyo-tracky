import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Check,
  Layers, Truck, Plus, AlertTriangle, CalendarClock, Wrench, X, Trash2, Play, ListChecks,
  Gauge, CalendarCheck, Inbox,
} from 'lucide-angular';
import type {
  AgendaSummaryDto,
  CreateVehicleEventDto,
  VehicleEventDto,
  VehicleEventStatus,
  VehicleEventType,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../core/services/agenda.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { AgendaCalendarComponent } from './agenda-calendar.component';
import { ReservationSheetComponent } from './sheets/reservation-sheet.component';
import { OptimizationSheetComponent } from './sheets/optimization-sheet.component';
import {
  addMonths,
  eventColor,
  eventStatusLabel,
  eventTypeLabel,
  eventUrgency,
  localIso,
  severityLabel,
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
  imports: [FormsModule, LucideAngularModule, DatePipe, GroupBadgeComponent, AgendaCalendarComponent, ReservationSheetComponent, OptimizationSheetComponent],
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
                    @if (ev.vehiclePlate) { <span class="ag-up-plate">{{ ev.vehiclePlate }}</span> · }
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
              <p class="ag-sheet-sub">{{ dayPanelEvents().length }} événement(s)</p>
            </div>
            <button type="button" (click)="closeDayPanel()" aria-label="Fermer" class="ag-icon-btn">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>
          <div class="ag-sheet-body">
            @if (dayPanelEvents().length === 0) {
              <p class="ag-sheet-empty">Aucun événement ce jour.</p>
            }
            @for (ev of dayPanelEvents(); track ev.id) {
              <article class="ag-day-card" [style.--pill]="eventColor(ev)">
                <div class="ag-day-card-top">
                  <span class="ag-day-card-type">
                    <lucide-icon [img]="ev.type === 'INCIDENT' ? AlertTriangleIcon : WrenchIcon" [size]="12"></lucide-icon>
                    {{ eventTypeLabel(ev.type) }}
                  </span>
                  <span class="ag-status" [attr.data-status]="ev.status">{{ eventStatusLabel(ev.status) }}</span>
                </div>
                <p class="ag-day-card-title">{{ ev.title }}</p>
                <p class="ag-day-card-meta">
                  @if (ev.vehiclePlate) { <span class="ag-day-card-plate">{{ ev.vehiclePlate }}</span> }
                  @if (!ev.allDay) { · {{ ev.startAt | date:'HH:mm' }} }
                  @if (ev.odometerKm != null) { · {{ ev.odometerKm }} km }
                </p>
                @if (ev.description) { <p class="ag-day-card-desc">{{ ev.description }}</p> }
                @if (canManage()) {
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
                }
              </article>
            }
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
                <button type="button" (click)="form.type = 'MAINTENANCE'"
                        class="ag-seg-btn" [class.ag-seg-btn--active]="form.type === 'MAINTENANCE'">Maintenance</button>
                <button type="button" (click)="form.type = 'INCIDENT'"
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
      [vehicles]="vehicles()"
      [defaultDate]="resDefaultDate()"
      [startMode]="resStartMode()"
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
    .ag-stat--danger .ag-stat-icon { background: rgba(239,68,68,.14); color: #ef4444; }
    .ag-stat--warn .ag-stat-icon { background: rgba(245,158,11,.14); color: #f59e0b; }
    .ag-stat--info .ag-stat-icon { background: rgba(16,224,160,.14); color: var(--tracky-light); }
    .ag-stat-body { display: flex; flex-direction: column; min-width: 0; }
    .ag-stat-value {
      font-size: 22px; font-weight: 800; line-height: 1;
      color: var(--fg-primary); font-family: var(--font-display, Poppins, sans-serif);
      letter-spacing: -.02em;
    }
    .ag-stat--danger .ag-stat-value { color: #ef4444; }
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
    .ag-status[data-status="OPEN"] { background: rgba(239,68,68,.12); color: #ef4444; }
    .ag-status[data-status="IN_PROGRESS"] { background: rgba(245,158,11,.14); color: #f59e0b; }
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
    .ag-act--start:hover:not(:disabled) { color: #f59e0b; border-color: rgba(245,158,11,.3); background: rgba(245,158,11,.06); }
    .ag-act--done:hover:not(:disabled) { color: var(--tracky-light); border-color: rgba(16,224,160,.3); background: rgba(16,224,160,.06); }
    .ag-act--del { margin-left: auto; }
    .ag-act--del:hover:not(:disabled) { color: #ef4444; border-color: rgba(239,68,68,.3); background: rgba(239,68,68,.06); }

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
  protected readonly PlayIcon = Play;
  protected readonly ListChecksIcon = ListChecks;
  protected readonly GaugeIcon = Gauge;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly InboxIcon = Inbox;

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
  /** Sprint 8 — activité réelle par jour (nb véhicules ayant roulé), couche agenda (gardée reservations_view). */
  protected readonly activityByDay = signal<Map<string, number>>(new Map());
  /** Sprint 8 (Palier C) — usage prévu par jour (nb véhicules), couche fantôme (gardée reservations_view). */
  protected readonly forecastByDay = signal<Map<string, number>>(new Map());
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
  protected readonly resSheetOpen = signal(false);
  protected readonly resStartMode = signal<'request' | 'validate'>('request');
  protected readonly resDefaultDate = signal<string | null>(null);
  protected readonly optSheetOpen = signal(false);
  /** Nb de demandes de réservation en attente (dérivé des événements déjà chargés). */
  protected readonly pendingCount = computed(() =>
    this.events().filter((e) => e.type === 'RESERVATION' && e.status === 'REQUESTED').length,
  );

  // ─── Dérivés filtres ─────────────────────────────────────────────────────────
  /** Groupes uniques tirés des véhicules (dédup par id). */
  protected readonly groupOptions = computed<GroupOption[]>(() => {
    const map = new Map<string, GroupOption>();
    for (const v of this.vehicles()) {
      if (v.group?.id && !map.has(v.group.id)) map.set(v.group.id, { id: v.group.id, name: v.group.name });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Véhicules visibles dans le dropdown (restreints au groupe sélectionné). */
  protected readonly visibleVehicles = computed(() => {
    const gid = this.selectedGroupId();
    const list = this.vehicles();
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

  /**
   * Événements filtrés CLIENT-SIDE par groupe + véhicule + type. Le mois et le
   * périmètre véhicule/groupe sont déjà appliqués côté serveur, mais on re-filtre
   * pour que les changements de filtre soient instantanés sans round-trip.
   */
  protected readonly filteredEvents = computed(() => {
    const gid = this.selectedGroupId();
    const vid = this.selectedVehicleId();
    const type = this.selectedType();
    const groupVehicleIds = gid
      ? new Set(this.vehicles().filter((v) => v.group?.id === gid).map((v) => v.id))
      : null;
    return this.events().filter((ev) => {
      if (type && ev.type !== type) return false;
      if (vid && ev.vehicleId !== vid) return false;
      if (groupVehicleIds && !groupVehicleIds.has(ev.vehicleId)) return false;
      return true;
    });
  });

  /** Événements du jour sélectionné (panneau). */
  protected readonly dayPanelEvents = computed(() => {
    const day = this.selectedDay();
    if (!day) return [];
    return this.filteredEvents()
      .filter((ev) => localIso(new Date(ev.startAt)) === day)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
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
      this.summary.set(await firstValueFrom(this.api.summary()));
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
          // Le groupe/véhicule/type sont appliqués côté client (filtre instantané) ;
          // on charge tout le périmètre autorisé sur la fenêtre du mois.
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
    if (!this.perms.can('reservations_view')) {
      this.activityByDay.set(new Map());
      return;
    }
    try {
      const { from, to } = this.monthWindow();
      const avail = await firstValueFrom(this.api.getAvailability({ from, to }));
      const perDay = new Map<string, Set<string>>();
      for (const slot of avail.slots) {
        const start = new Date(slot.startAt);
        if (Number.isNaN(start.getTime())) continue;
        const end = slot.endAt ? new Date(slot.endAt) : start;
        const cursor = new Date(start);
        cursor.setHours(0, 0, 0, 0);
        let steps = 0;
        while (cursor.getTime() <= end.getTime() && steps < 45) {
          const key = localIso(cursor);
          let set = perDay.get(key);
          if (!set) {
            set = new Set();
            perDay.set(key, set);
          }
          set.add(slot.vehicleId);
          cursor.setDate(cursor.getDate() + 1);
          steps++;
        }
      }
      const counts = new Map<string, number>();
      for (const [key, set] of perDay) counts.set(key, set.size);
      this.activityByDay.set(counts);
    } catch {
      this.activityByDay.set(new Map());
    }
  }

  /**
   * Sprint 8 (Palier C) — couche « usage prévu » : nb de véhicules dont l'usage récurrent est
   * prévu par jour (dérivé des trajets, jamais bloquant). Gardée par `reservations_view`.
   */
  private async loadForecast(): Promise<void> {
    if (!this.perms.can('reservations_view')) {
      this.forecastByDay.set(new Map());
      return;
    }
    try {
      const { from, to } = this.monthWindow();
      const res = await firstValueFrom(this.api.getForecast({ from, to }));
      const perDay = new Map<string, Set<string>>();
      for (const slot of res.slots) {
        const start = new Date(slot.startAt);
        if (Number.isNaN(start.getTime())) continue;
        const key = localIso(start);
        let set = perDay.get(key);
        if (!set) {
          set = new Set();
          perDay.set(key, set);
        }
        set.add(slot.vehicleId);
      }
      const counts = new Map<string, number>();
      for (const [key, set] of perDay) counts.set(key, set.size);
      this.forecastByDay.set(counts);
    } catch {
      this.forecastByDay.set(new Map());
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
      odometerKm: null as number | null,
      description: '',
    };
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
    this.resDefaultDate.set(date ?? null);
    this.resStartMode.set('request');
    this.resSheetOpen.set(true);
  }

  protected openValidate(): void {
    this.resDefaultDate.set(null);
    this.resStartMode.set('validate');
    this.resSheetOpen.set(true);
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
