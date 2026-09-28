import { swallow } from '../../core/error/swallow';
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
import { PlanUpsellComponent } from '../../shared/ui/plan-upsell/plan-upsell.component';
import { MissionsPanelComponent } from './missions-panel.component';
import { ScrollLockService } from '../../core/services/scroll-lock.service';
import { DatePipe, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { apiErrorMessage } from '../../core/error/api-error';
import {
  LucideAngularModule, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Check,
  Layers, Truck, Plus, AlertTriangle, CalendarClock, Wrench, X, Trash2, Play, ListChecks,
  CalendarCheck, Inbox, Sparkles, Activity, ShieldCheck, Ban, Info, Pencil, Settings, QrCode, Shuffle, Route,
  WifiOff, MoreHorizontal,
} from 'lucide-angular';
import type {
  AgendaAgentProposalDto,
  AgendaSummaryDto,
  CreateVehicleEventDto,
  ForecastSlotDto,
  UpdateVehicleEventDto,
  VehicleActivitySlotDto,
  VehicleEventDto,
  VehicleEventStatus,
  VehicleEventType,
} from '@vizyo/tracky-shared';
import {
  DORMANT_STOP_COUNTING_MS,
  effectiveBlockingEndMs,
  formatSilenceLabel,
  isImmobilizingEvent,
  isVehicleDormant,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../core/services/agenda.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { AgendaCalendarComponent, annulationSansObjet } from './agenda-calendar.component';
import { horsServiceLabel, ReservationSheetComponent, siegesLabel } from './sheets/reservation-sheet.component';
import { AgendaAgentSettingsSheetComponent } from './sheets/agenda-agent-settings-sheet.component';
import { AgendaIaViewComponent } from './ia/agenda-ia-view.component';
import { AgendaParcViewComponent } from './parc/agenda-parc-view.component';
import { ReservationQrDialogComponent } from './reservation-qr-dialog.component';
import { ReorganisationSheetComponent, type PresetReorganisation } from './sheets/reorganisation-sheet.component';
import { AiJobPillComponent } from './ai-job-pill.component';
import { AiJobService, type AiJob } from '../../core/services/ai-job.service';
import { AuthService } from '../../core/services/auth.service';
import { AgendaAgentApiService } from '../../core/services/agenda-agent.service';
import { AiStatusService } from '../../core/services/ai-status.service';
import { VehicleLinkDirective } from '../../shared/directives/vehicle-link.directive';
import {
  addMonths,
  estUneEcheance,
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

/** Id du groupe qui UTILISE le véhicule d'une réservation (`metadata.group.id`), sinon null. */
function groupeReservationId(ev: VehicleEventDto): string | null {
  if (ev.type !== 'RESERVATION') return null;
  const g = (ev.metadata as { group?: { id?: unknown } | null } | null)?.group;
  return g && typeof g.id === 'string' && g.id ? g.id : null;
}

@Component({
  selector: 'app-agenda',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, DatePipe, GroupBadgeComponent, AgendaCalendarComponent, ReservationSheetComponent, AgendaAgentSettingsSheetComponent, AgendaIaViewComponent, AgendaParcViewComponent, AiJobPillComponent, VehicleLinkDirective, PlanUpsellComponent, MissionsPanelComponent, ReservationQrDialogComponent, ReorganisationSheetComponent],
  template: `
    <div class="flex flex-col gap-5">
      <app-plan-upsell feature="agenda" />
      <!-- Header + résumé -->
      <header class="flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <h1 class="text-2xl font-display font-bold text-fg-primary flex items-center gap-2">
              <lucide-icon [img]="CalendarDaysIcon" [size]="22" class="text-tracky-light"></lucide-icon>
              Agenda
            </h1>
            <!-- Le sous-titre suit ce que le compte voit réellement : annoncer des
                 entretiens à qui n'a pas la permission agenda_view promet un écran qui
                 n'existe pas pour lui. -->
            <p class="text-sm text-fg-tertiary mt-0.5">
              @if (canSeeAgenda()) {
                Entretiens planifiés et incidents de votre flotte
              } @else {
                Les missions de votre flotte, et leurs tournées
              }
            </p>
          </div>
          <!--
            REFONTE UX DU 28/09 — QUATRE ENTRÉES, pas huit. « Éviter d'avoir énormément de boutons
            qui donnent l'impression qu'il faut tout faire en même temps. » Réserver et Demandes sont
            les gestes du jour ; + Événement pose une indisponibilité ; le menu ⋯ garde les gestes
            rares (QR à imprimer une fois, réorganisation en masse, réglages). Les gestes IA vivent
            dans la vue « Assistant IA », dans l'ordre où ils servent.
          -->
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
            @if (canManage()) {
              <button type="button" (click)="openCreate()" class="ag-btn-primary">
                <lucide-icon [img]="PlusIcon" [size]="15"></lucide-icon><span>Événement</span>
              </button>
            }
            @if (canValidate() || canConfigureAgent()) {
              <div class="ag-dd-wrapper">
                <button type="button" (click)="plusOpen.set(!plusOpen())" class="ag-icon-btn ag-icon-btn--plus" [class.ag-icon-btn--on]="plusOpen()"
                        title="Plus d'actions" aria-label="Plus d'actions" [attr.aria-expanded]="plusOpen()">
                  <lucide-icon [img]="MoreIcon" [size]="18"></lucide-icon>
                </button>
                @if (plusOpen()) {
                  <div class="ag-dd-backdrop" (click)="plusOpen.set(false)"></div>
                  <div class="ag-dd-menu ag-dd-menu--right">
                    @if (canValidate()) {
                      <!-- P0-1 : la porte d'entrée des conducteurs (le QR s'imprime une fois, puis vit sur le pare-brise). -->
                      <button type="button" class="ag-dd-item" (click)="plusOpen.set(false); qrDialogOpen.set(true)">
                        <span class="ag-dd-item-row"><lucide-icon [img]="QrCodeIcon" [size]="14"></lucide-icon><span>QR de réservation</span></span>
                      </button>
                      <button type="button" class="ag-dd-item" (click)="plusOpen.set(false); reorgSheetOpen.set(true)">
                        <span class="ag-dd-item-row"><lucide-icon [img]="ShuffleIcon" [size]="14"></lucide-icon><span>Réorganiser des réservations</span></span>
                      </button>
                    }
                    @if (canConfigureAgent()) {
                      @if (canValidate()) { <div class="ag-dd-divider"></div> }
                      <button type="button" class="ag-dd-item" (click)="plusOpen.set(false); openAgentSettings()">
                        <span class="ag-dd-item-row"><lucide-icon [img]="SettingsIcon" [size]="14"></lucide-icon><span>Paramètres de l'agenda</span></span>
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <!-- Suivi des opérations IA lancées en arrière-plan (analyse, optimisation…) -->
        <app-ai-job-pill (view)="onAiJobView($event)"></app-ai-job-pill>

        <!-- Strip de 3 stats — trois zéros seraient un mensonge pour qui n'a pas le
             droit de lire les échéances : la flotte en a peut-être trente. -->
        @if (canSeeAgenda()) {
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
        }
      </header>

      <!-- ── « Cette maintenance est-elle terminée ? » (lot du 28/09) ────────────────────────
           Une maintenance ou un incident encore ouvert dont la fin prévue est passée — ou sans fin,
           commencé avant aujourd'hui — revient ici CHAQUE jour jusqu'à ce qu'on réponde. Oui : il
           est clos à l'instant. Non : on donne la nouvelle date de retour, et il disparaît jusque-là.
           La clôture vient à l'utilisateur ; il ne va pas la chercher dans une carte de jour. -->
      @if (canManage() && aClore().length > 0) {
        <section class="ag-clore" aria-label="Maintenances et incidents à clore">
          <div class="ag-clore-head">
            <span class="ag-clore-titre"><lucide-icon [img]="ListChecksIcon" [size]="14"></lucide-icon> À clore</span>
            <span class="ag-clore-sub">{{ aClore().length }} véhicule{{ aClore().length > 1 ? 's' : '' }} dont la fin prévue est passée — terminé, ou pas encore ?</span>
          </div>
          @for (c of aClore(); track c.ev.id) {
            <div class="ag-clore-row" [style.--pill]="eventColor(c.ev)">
              <div class="ag-clore-main">
                <span class="ag-clore-plate" [vehicleLink]="c.ev.vehicleId">{{ c.ev.vehiclePlate || '—' }}</span>
                <span class="ag-clore-title">{{ c.ev.title }}</span>
                <span class="ag-clore-meta">{{ eventTypeLabel(c.ev.type) }} · {{ c.libelle }}</span>
              </div>
              @if (cloreEdit()[c.ev.id]; as d) {
                <div class="ag-clore-edit">
                  <label class="ag-clore-lbl" [attr.for]="'ag-clore-' + c.ev.id">Nouvelle fin</label>
                  <input [id]="'ag-clore-' + c.ev.id" type="date" class="ag-input ag-input--sm" [value]="d" [min]="todayIso()"
                         (input)="setCloreDate(c.ev.id, $any($event.target).value)" />
                  <button type="button" class="ag-act ag-act--done" [disabled]="busyId() === c.ev.id" (click)="repousserFin(c.ev)">
                    <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Enregistrer
                  </button>
                  <button type="button" class="ag-act" (click)="annulerCloreEdit(c.ev.id)">Annuler</button>
                </div>
              } @else {
                <div class="ag-clore-actions">
                  <button type="button" class="ag-act ag-act--done" [disabled]="busyId() === c.ev.id" (click)="cloturer(c.ev)">
                    <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Oui, {{ c.ev.type === 'INCIDENT' ? 'réglé' : 'terminée' }}
                  </button>
                  <button type="button" class="ag-act ag-act--start" [disabled]="busyId() === c.ev.id" (click)="ouvrirCloreEdit(c.ev)">
                    <lucide-icon [img]="CalendarClockIcon" [size]="12"></lucide-icon> Non — nouvelle date de fin
                  </button>
                </div>
              }
            </div>
          }
        </section>
      }

      <!-- ── Les VUES de l'agenda (refonte UX du 28/09) ─────────────────────────────────
           Calendrier · Missions · Parc · Assistant IA. « Mission » n'est plus un filtre de type :
           il remplaçait déjà la grille, c'était une vue qui ne disait pas son nom. Parc et
           Assistant IA sont nouvelles : le paramétrage des véhicules et les gestes IA, qui
           vivaient dans des feuilles et des boutons dispersés, ont chacun leur écran. -->
      @if (canSeeAgenda()) {
      <nav class="ag-vues" aria-label="Vues de l'agenda">
        <button type="button" class="ag-vue" [class.ag-vue--on]="vue() === 'calendrier'" (click)="vue.set('calendrier')">
          <lucide-icon [img]="CalendarDaysIcon" [size]="14"></lucide-icon> Calendrier
        </button>
        <button type="button" class="ag-vue" [class.ag-vue--on]="vue() === 'missions'" (click)="vue.set('missions')">
          <lucide-icon [img]="RouteIcon" [size]="14"></lucide-icon> Missions
        </button>
        @if (canSeeInsights()) {
          <button type="button" class="ag-vue" [class.ag-vue--on]="vue() === 'parc'" (click)="vue.set('parc')">
            <lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon> Parc
          </button>
        }
        @if (montrerVueIa()) {
          <button type="button" class="ag-vue" [class.ag-vue--on]="vue() === 'ia'" (click)="vue.set('ia')">
            <lucide-icon [img]="SparklesIcon" [size]="14"></lucide-icon> Assistant IA
            @if (agentProposalCount() > 0) { <span class="ag-badge ag-badge--violet">{{ agentProposalCount() }}</span> }
          </button>
        }
      </nav>
      }

      <!-- Barre de filtres — groupe, véhicule, type et mois ne pilotent QUE la grille du
           calendrier. Sans la permission agenda_view il n'y a pas de grille : le tableau
           des missions porte ses propres filtres, et cette barre ne ferait rien. -->
      @if (canSeeAgenda() && vue() === 'calendrier') {
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
      }

      <!-- Espace dépôt (2026-08) — l'onglet Missions. Le sélecteur de type fait office
           d'onglet : choisir « Mission » ouvre le tableau, ses filtres et ses cinq
           compteurs, à la place de la grille du mois. Les missions restent visibles
           dans la grille sous « Tous » — c'est l'exigence d'A2 § 3.1 : le gestionnaire
           doit les voir sur le MÊME calendrier que la maintenance et les réservations,
           sinon il double-réserve. -->
      @if (vue() === 'missions' || !canSeeAgenda()) {
        <app-missions-panel />
      } @else if (vue() === 'parc') {
        <app-agenda-parc-view [vehicles]="scopedVehicles()" (changed)="rafraichirVehicules()" />
      } @else if (vue() === 'ia') {
        <app-agenda-ia-view
          [proposals]="agentProposals()"
          (reserver)="openReserve()"
          (reglages)="openAgentSettings()"
          (parc)="vue.set('parc')"
          (changed)="onAgentProposalsChanged()"
          (capaciteAppliquee)="rafraichirVehicules()" />
      } @else {

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
          [proposalsByDay]="proposalsByDay()"
          [peutGererAgenda]="canManage()"
          [peutGererReservations]="canValidate()"
          (evenementDeplace)="deplacerEvenement($event)"
          (dayClick)="onDayClick($event)"
        />
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 px-1 pt-2.5 text-[11px] text-fg-tertiary">
          <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[3px]" style="background:var(--tracky-light)"></span>Maintenance</span>
          <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[3px]" style="background:var(--warning)"></span>Incident</span>
          <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[3px]" style="background:var(--blue)"></span>Réservation</span>
          <!-- Deux styles EN LIGNE avec la couleur en dur : #38BDF8 et #A78BFA sont
               les valeurs SOMBRES de --blue et --violet, donc les glyphes gardaient
               la teinte du theme sombre en clair (2,08:1 et 2,65:1). Les jetons
               --texte-* portent la meme signification et basculent. -->
          <span class="inline-flex items-center gap-1.5"><span class="ag-leg-glyphe ag-leg-glyphe--reel">●</span>Activité réelle</span>
          <span class="inline-flex items-center gap-1.5"><span class="ag-leg-glyphe ag-leg-glyphe--prevu">~</span>Usage prévu</span>
          <!-- Lot 3a — sans cette entrée, le pointillé violet de la grille n'a pas de nom. -->
          <span class="inline-flex items-center gap-1.5"><span class="ag-leg-fantome"></span>Proposé par l'agent (non réservé)</span>
        </div>
      }

      }

      <!-- À venir / en retard — dérivé des événements de l'agenda. Sans le droit de les
           lire, « Aucune échéance à venir » n'est pas une information, c'est une
           affirmation fausse. -->
      @if (canSeeAgenda() && vue() === 'calendrier') {
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
                  <lucide-icon [img]="iconePourType(ev.type)" [size]="13"></lucide-icon>
                </span>
                <span class="ag-up-main">
                  <span class="ag-up-title">{{ ev.title }}</span>
                  <span class="ag-up-meta">
                    @if (ev.vehiclePlate) { <span class="ag-up-plate" [vehicleLink]="ev.vehicleId" [attr.title]="'Voir ' + ev.vehiclePlate">{{ ev.vehiclePlate }}</span> · }
                    {{ eventTypeLabel(ev.type) }}
                    @if (ev.type === 'INCIDENT' && ev.severity) { · {{ severityLabel(ev.severity) }} }
                    @if (groupeReservation(ev); as gr) { · {{ gr }} }
                  </span>
                </span>
                <span class="ag-up-date">
                  <span class="ag-up-date-day">{{ ev.startAt | date:'dd MMM' }}@if (dureeEnJours(ev) > 1) { <span class="ag-up-duree">· {{ dureeEnJours(ev) }} j</span> }</span>
                  <span class="ag-up-badge" [style.--u]="urgencyColor(eventUrgency(ev))">
                    {{ urgencyLabel(ev) }}
                  </span>
                </span>
              </button>
            }
          </div>
        }
      </section>
      }
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
                          <lucide-icon [img]="u.kind === 'reserved' ? CalendarCheckIcon : u.kind === 'dormant' ? WifiOffIcon : BanIcon" [size]="12"></lucide-icon>
                        </span>
                        <span class="ag-unavail-plate" [vehicleLink]="u.vehicleId" [attr.title]="'Voir ' + u.plate">{{ u.plate }}</span>
                        <span class="ag-unavail-lbl">{{ unavailKindLabel(u.kind) }} · {{ u.label }}</span>
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

            <!-- ── Proposé par l'agent (réservations fantômes) ── -->
            @if (canOptimize() && dayProposals().length > 0) {
              <section class="ag-sec">
                <div class="ag-sec-head">
                  <span class="ag-sec-titr ag-sec-titr--fantome"><lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon> Proposé par l'agent</span>
                  <span class="ag-sec-badge ag-sec-badge--fantome">{{ dayProposals().length }}</span>
                </div>
                <p class="ag-sec-sub">Déduit des habitudes du véhicule. <strong>Aucun véhicule n'est bloqué</strong> tant que vous n'avez pas validé.</p>
                @for (p of dayProposals(); track p.id) {
                  <article class="ag-fantome">
                    <div class="ag-fantome-top">
                      <span class="ag-fantome-plate" [vehicleLink]="p.vehicleId" [attr.title]="'Voir ' + (p.vehiclePlate || '')">{{ p.vehiclePlate || '—' }}</span>
                      <span class="ag-fantome-time">{{ hm(p.startAt) }} → {{ hm(p.endAt) }}</span>
                      @if (p.destinationLabel) { <span class="ag-fantome-dest">{{ p.destinationLabel }}</span> }
                    </div>
                    <p class="ag-fantome-why">{{ p.reasoning }}</p>
                    @if (canValidate()) {
                      <div class="ag-fantome-actions">
                        <button type="button" (click)="applyProposal(p)" [disabled]="busyId() === p.id" class="ag-act ag-act--done">
                          <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Réserver
                        </button>
                        <button type="button" (click)="dismissProposal(p)" [disabled]="busyId() === p.id" class="ag-act ag-act--del">
                          <lucide-icon [img]="XIcon" [size]="12"></lucide-icon> Écarter
                        </button>
                      </div>
                    }
                  </article>
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
                      <lucide-icon [img]="iconePourType(ev.type)" [size]="12"></lucide-icon>
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
                    @if (ev.type !== 'RESERVATION' && dureeEnJours(ev) > 1) {
                      · du {{ ev.startAt | date:'d MMM' }} au {{ ev.endAt | date:'d MMM' }}
                    }
                    @if (ev.type === 'RESERVATION' && !ev.allDay) {
                      · {{ plageHoraire(ev) }}
                    } @else if (!ev.allDay) { · {{ ev.startAt | date:'HH:mm' }} }
                    @if (ev.odometerKm != null) { · {{ ev.odometerKm }} km }
                    <!-- Refonte UX du 28/09 (point 1) : la durée se lit ici, et « jour 2/3 » situe le jour ouvert. -->
                    @if (dureeEnJours(ev) > 1) {
                      <span class="ag-duree" [attr.title]="'Du ' + (ev.startAt | date:'EEEE d MMMM') + ' au ' + (ev.endAt | date:'EEEE d MMMM')">{{ dureeEnJours(ev) }} jours@if (positionJour(ev); as pj) { · {{ pj }} }</span>
                    }
                  </p>
                  @if (ev.description) { <p class="ag-day-card-desc">{{ ev.description }}</p> }
                  @if (reservationReason(ev)) { <p class="ag-day-card-desc">{{ reservationReason(ev) }}</p> }
                  <!-- Le groupe qui UTILISE le véhicule (point 9) — pas forcément celui du véhicule. -->
                  @if (groupeReservation(ev); as gr) { <p class="ag-day-card-desc"><span class="ag-groupe">Groupe : {{ gr }}</span></p> }
                  <!-- Sièges auto : ce qui est déjà à bord et ce qu'il faut sortir du stock — celui qui prépare la voiture le lit ici. -->
                  @if (siegesAuto(ev); as sa) { <p class="ag-day-card-desc">Sièges auto : {{ sa }}</p> }
                  <!-- P2-1 : une MISSION n'a pas de boutons ici. Son ombre d'agenda se met à jour
                       depuis l'onglet Missions ; « Terminé » ou « Supprimer » depuis cette carte
                       libérait le véhicule pendant une mission qui existait toujours. -->
                  @if (ev.type === 'MISSION') {
                    <p class="ag-day-card-desc">Se pilote depuis l'onglet Missions.</p>
                  } @else if (canManage() && ev.type !== 'RESERVATION') {
                    <div class="ag-day-card-actions">
                      <!-- F10 (28/09) : celui qui gère change les dates (le retour du garage a glissé). -->
                      @if (ev.status !== 'DONE' && ev.status !== 'CANCELLED') {
                        <button type="button" (click)="openEdit(ev)" [disabled]="busyId() === ev.id"
                                class="ag-act" aria-label="Modifier les dates et le détail">
                          <lucide-icon [img]="PencilIcon" [size]="12"></lucide-icon> Modifier
                        </button>
                      }
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
        <div class="ag-modal" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="editingEvent() ? 'Modifier l\\'événement' : 'Nouvel événement'">
          <header class="ag-sheet-head">
            <h3 class="ag-sheet-title">{{ editingEvent() ? 'Modifier l\\'événement' : 'Nouvel événement' }}</h3>
            <button type="button" (click)="createOpen.set(false)" aria-label="Fermer" class="ag-icon-btn">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>
          <!--
            REFONTE UX DU 28/09 (point 8) — un seul formulaire d'INDISPONIBILITÉ, deux natures.
            Maintenance et incident « se ressemblent » : même fiche, même clôture (« À clore »), même
            immobilisation. La nature dit ce qui diffère en une ligne. Deux colonnes sur grand écran :
            QUOI (nature, véhicule, titre…) | QUAND (dates, immobilisation) — et, quand l'évènement
            immobilise le véhicule, les RÉSERVATIONS prises sur la période, à décider ici même.
          -->
          <div class="ag-modal-body ag-modal-body--2col">
            <div class="ag-col">
              <!-- Nature -->
              <div class="ag-field">
                <label>Nature</label>
                <div class="ag-seg ag-seg--full">
                  <button type="button" (click)="setFormType('MAINTENANCE')" [disabled]="!!editingEvent()"
                          class="ag-seg-btn" [class.ag-seg-btn--active]="form.type === 'MAINTENANCE'">Maintenance</button>
                  <button type="button" (click)="setFormType('INCIDENT')" [disabled]="!!editingEvent()"
                          class="ag-seg-btn" [class.ag-seg-btn--active]="form.type === 'INCIDENT'">Incident</button>
                </div>
                <p class="ag-field-note">
                  @if (form.type === 'INCIDENT') {
                    Panne, accident, dégât : l'incident reste <strong>ouvert jusqu'à résolution</strong> et immobilise le véhicule par défaut.
                  } @else {
                    Entretien prévu (vidange, contrôle technique, pneus) : planifié à une date, <strong>n'immobilise pas</strong> le véhicule sauf si vous le cochez.
                  }
                </p>
              </div>
              <!-- Véhicule -->
              <div class="ag-field">
                <label for="ag-f-veh">Véhicule</label>
                <select id="ag-f-veh" class="ag-input" [(ngModel)]="form.vehicleId" (ngModelChange)="onCreateVehicleChange($event)" [disabled]="!!editingEvent()">
                  <option value="" disabled>Sélectionner…</option>
                  <!--
                    ⚠️ On itère « scopedVehicles », et NON « vehicles ». La liste brute contient le parc de
                    TOUTES les sociétés : un super-admin dont le bandeau est réglé sur « Client
                    test » se voyait proposer les plaques du cdef31 et de mh cars, et pouvait poser
                    une maintenance sur le véhicule d'un autre client sans que rien ne l'avertisse.
                    Relevé en recette le 2026-09-24. Toute la page obéit au filtre société ; ce
                    sélecteur était le seul à l'ignorer.
                  -->
                  @for (v of scopedVehicles(); track v.id) {
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
                <label for="ag-f-cat">Catégorie <span class="ag-field-hint">optionnel</span></label>
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
                <label for="ag-f-desc">Description <span class="ag-field-hint">optionnel</span></label>
                <textarea id="ag-f-desc" class="ag-input ag-textarea" [(ngModel)]="form.description"
                          rows="2" placeholder="Détails"></textarea>
              </div>
            </div>

            <div class="ag-col">
              <!-- Date + heure -->
              <div class="ag-field-row">
                <div class="ag-field">
                  <label for="ag-f-date">{{ form.type === 'INCIDENT' ? 'Depuis le' : 'Date' }}</label>
                  <input id="ag-f-date" type="date" class="ag-input" [(ngModel)]="form.date" (ngModelChange)="onPeriodeChange()" />
                </div>
                <div class="ag-field ag-field--allday">
                  <label class="ag-check">
                    <input type="checkbox" [(ngModel)]="form.allDay" (ngModelChange)="onPeriodeChange()" />
                    <span>Toute la journée</span>
                  </label>
                </div>
              </div>
              @if (!form.allDay) {
                <div class="ag-field">
                  <label for="ag-f-time">Heure</label>
                  <input id="ag-f-time" type="time" class="ag-input" [(ngModel)]="form.time" (ngModelChange)="onPeriodeChange()" />
                </div>
              }
              <!-- Lot multi-jours (28/09) — « un véhicule en garage, ça peut prendre une semaine ».
                   Une fin facultative : vide, c'est la journée (maintenance) ou jusqu'à résolution
                   (incident), comme avant. Renseignée, le véhicule est immobilisé chaque jour de
                   l'intervalle, et la grille le montre en « suite » sur chacun. -->
              <div class="ag-field-row">
                <div class="ag-field">
                  <label for="ag-f-end">Jusqu'au <span class="ag-field-hint">optionnel</span></label>
                  <input id="ag-f-end" type="date" class="ag-input" [(ngModel)]="form.endDate" [min]="form.date" (ngModelChange)="onPeriodeChange()" />
                </div>
                @if (!form.allDay && form.endDate) {
                  <div class="ag-field">
                    <label for="ag-f-end-time">Heure de fin</label>
                    <input id="ag-f-end-time" type="time" class="ag-input" [(ngModel)]="form.endTime" (ngModelChange)="onPeriodeChange()" />
                  </div>
                }
              </div>
              <p class="ag-field-note">
                @if (dureeFormulaire() > 1) {
                  <strong>{{ dureeFormulaire() }} jours</strong> — le véhicule est indisponible chaque jour de l'intervalle, et l'agenda demandera « terminée ? » quand la date de retour sera passée.
                } @else {
                  Laissez vide pour une seule journée. Un passage au garage d'une semaine : mettez la date de retour.
                }
              </p>
              <!-- Immobilisation : rend le véhicule indisponible (réservations + IA) -->
              <div class="ag-field">
                <label class="ag-check">
                  <input type="checkbox" [(ngModel)]="form.blocksVehicle" (ngModelChange)="onPeriodeChange()" />
                  <span>Immobilise le véhicule</span>
                </label>
                <p class="ag-field-note">
                  Tant que l'événement n'est pas terminé, le véhicule est exclu des réservations
                  et des suggestions de l'IA (ex. roue crevée, passage au garage).
                </p>
              </div>

              <!--
                LES RÉSERVATIONS PRISES SUR LA PÉRIODE (point 8 : « regrouper une ou plusieurs
                réservations directement dans l'événement »). Une immobilisation qui écrase des
                réservations sans le dire, c'est un véhicule promis deux fois. Ici : la liste, et
                une décision par ligne — laisser, annuler, ou réaffecter (auto : premier véhicule
                libre et conforme). Appliquées juste après la création, tracées dans l'événement.
              -->
              @if (form.blocksVehicle && form.vehicleId && !editingEvent()) {
                <div class="ag-resas">
                  <div class="ag-resas-head">
                    <span class="ag-resas-t"><lucide-icon [img]="CalendarCheckIcon" [size]="13"></lucide-icon> Réservations pendant cette période</span>
                    @if (resasPeriodeLoading()) { <span class="ag-resas-n">…</span> } @else { <span class="ag-resas-n">{{ resasPeriode().length }}</span> }
                  </div>
                  @if (resasPeriode().length === 0 && !resasPeriodeLoading()) {
                    <p class="ag-field-note">Aucune réservation sur ce véhicule pendant la période : rien à reprendre.</p>
                  } @else {
                    <p class="ag-field-note">Le véhicule sera indisponible : que faire de chacune ?</p>
                    @for (r of resasPeriode(); track r.id) {
                      <div class="ag-resa">
                        <div class="ag-resa-main">
                          <span class="ag-resa-title">{{ r.title }}</span>
                          <span class="ag-resa-when">{{ plageHoraire(r) }}@if (dureeEnJours(r) > 1) { · {{ dureeEnJours(r) }} j }@if (r.status === 'REQUESTED') { · demande en attente }@if (groupeReservation(r); as g) { · {{ g }} }</span>
                        </div>
                        <div class="ag-seg ag-seg--mini">
                          <button type="button" class="ag-seg-btn" [class.ag-seg-btn--active]="decisionDe(r.id) === 'laisser'" (click)="decider(r.id, 'laisser')" title="Ne rien changer : la réservation reste sur ce véhicule">Laisser</button>
                          <button type="button" class="ag-seg-btn" [class.ag-seg-btn--active]="decisionDe(r.id) === 'reaffecter'" (click)="decider(r.id, 'reaffecter')" title="Passer sur le premier véhicule libre et conforme">Réaffecter</button>
                          <button type="button" class="ag-seg-btn ag-seg-btn--danger" [class.ag-seg-btn--active]="decisionDe(r.id) === 'annuler'" (click)="decider(r.id, 'annuler')" title="Annuler la réservation">Annuler</button>
                        </div>
                      </div>
                    }
                  }
                </div>
              }
            </div>
          </div>
          <footer class="ag-modal-foot">
            <button type="button" (click)="createOpen.set(false)" class="ag-btn-ghost">Annuler</button>
            <button type="button" (click)="submitCreate()" [disabled]="!canSubmitCreate() || saving()"
                    class="ag-btn-primary">
              {{ saving() ? 'Enregistrement…' : (editingEvent() ? 'Enregistrer' : (nbDecisions() > 0 ? 'Créer et reprendre ' + nbDecisions() + ' réservation(s)' : 'Créer l\\'événement')) }}
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
    <app-agenda-agent-settings-sheet
      [open]="agentSheetOpen()"
      (closed)="agentSheetOpen.set(false)"
      (saved)="loadAgentProposals()"
      (parc)="vue.set('parc')" />
    @if (qrDialogOpen()) {
      <app-reservation-qr-dialog (closed)="qrDialogOpen.set(false)" />
    }
    <app-reorganisation-sheet
      [open]="reorgSheetOpen()"
      [vehicles]="scopedVehicles()"
      [preset]="reorgPreset()"
      (closed)="reorgSheetOpen.set(false); reorgPreset.set(null)"
      (applique)="onReservationChanged()" />
  `,
  styles: [`
    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : navigation de mois, « Aujourd'hui », bascules de vue et menus
       déroulants étaient tous sous le seuil. Sur un calendrier, changer de mois est le
       geste le plus répété de la page. */
    @media (max-width: 768px) {
      .ag-btn-primary, .ag-btn-soft, .ag-dd-trigger, .ag-icon-btn,
      .ag-month-btn, .ag-seg-btn, .ag-today-btn { min-width: 44px; min-height: 44px }
    }
    /* ─── Boutons génériques ─── */
    .ag-btn-primary {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 10px;
      /* Un color:#fff sur l'accent, c'est l'Ecart 2 de design/B0-SOCLE.md : sur un
         fond accent l'encre doit etre FONCEE. Mesure : 3,43:1 en clair et 1,72:1
         en sombre (le vert y est plus vif, donc c'est PIRE). Les replis #10E0A0 /
         #0bb586 sautent aussi : les deux noms de tete sont bien declares. */
      background: var(--tracky); color: var(--accent-ink);
      border: none; font-size: 13px; font-weight: 700; cursor: pointer;
      transition: background .15s, opacity .15s;
      white-space: nowrap;
    }
    .ag-btn-primary:hover:not(:disabled) { background: var(--tracky-dark); }
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

    /* ─── Vues de l'agenda (refonte UX du 28/09) ─── */
    .ag-vues { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); overflow-x: auto; }
    .ag-vue { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 9px; font-size: 13px; font-weight: 700;
              color: var(--fg-tertiary); white-space: nowrap; min-height: 40px; transition: all .12s; }
    .ag-vue lucide-icon { color: currentColor; }
    .ag-vue:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .ag-vue--on { background: var(--bg-primary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .ag-vue--on lucide-icon { color: var(--tracky-light); }
    .ag-badge--violet { background: color-mix(in srgb, var(--violet) 18%, transparent); color: var(--texte-violet); }
    .ag-dd-menu--right { left: auto; right: 0; }
    .ag-dd-item-row { display: inline-flex; align-items: center; gap: 9px; }
    .ag-dd-item-row lucide-icon { color: var(--tracky-light); }
    .ag-icon-btn--plus { border: 1px solid var(--border-subtle); background: var(--bg-secondary); width: 36px; height: 36px; border-radius: 10px; }
    .ag-icon-btn--on { color: var(--fg-primary); background: var(--bg-tertiary); }
    @media (max-width: 480px) { .ag-vue { flex: 1; justify-content: center; padding: 8px 8px; } }

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
      color: var(--fg-primary); font-family: var(--font-display);
      letter-spacing: -.02em;
    }
    /* Un CHIFFRE est du texte : il prend le jeton --texte-*, pas la couleur
       semantique pleine (--danger rendait 3,94:1 en clair). */
    .ag-stat--danger .ag-stat-value { color: var(--texte-alerte); }
    /* Glyphes de legende (● et ~) — etaient en style en ligne, cf. le gabarit. */
    .ag-leg-glyphe { font-weight: 800; }
    .ag-leg-glyphe--reel { color: var(--texte-info); }
    .ag-leg-glyphe--prevu { color: var(--texte-violet); }
    /* ── Panneau jour : la proposition. Encadré POINTILLÉ, comme sa pastille. ── */
    .ag-sec-titr--fantome { color: var(--texte-violet); }
    .ag-sec-badge--fantome { color: var(--texte-violet); background: color-mix(in srgb, var(--violet) 14%, transparent); }
    .ag-fantome {
      padding: 10px 12px; border-radius: 10px; margin-top: 6px;
      background: transparent;
      border: 1px dashed color-mix(in srgb, var(--violet) 45%, transparent);
    }
    .ag-fantome-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .ag-fantome-plate { font-size: 13px; font-weight: 800; color: var(--fg-primary); }
    .ag-fantome-time { font-size: 12px; color: var(--fg-secondary); }
    .ag-fantome-dest { font-size: 12px; font-weight: 600; color: var(--texte-violet); }
    .ag-fantome-why { font-size: 11.5px; color: var(--fg-tertiary); margin-top: 5px; line-height: 1.45; }
    .ag-fantome-actions { display: flex; gap: 8px; margin-top: 9px; }
    /* Le carré CREUX de la légende, jumeau de la pastille fantôme du calendrier. */
    .ag-leg-fantome {
      width: 10px; height: 10px; border-radius: 3px;
      border: 1.5px dashed color-mix(in srgb, var(--violet) 65%, transparent);
    }
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
    /* Convention du kit (styles.css) : l'etat actif prend --texte-succes, pas
       le vert de marque. Sur --bg-secondary clair : 3,43 -> 5,97:1. */
    .ag-seg-btn--active { background: var(--bg-secondary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.12); }

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
      /* ⚠️ LA BARRE DE SEGMENTS DÉFILE, SINON LE DERNIER EST INATTEIGNABLE.
         Ses cinq segments réclament 398 px et l'écran en offre 375 : « Mission » —
         l'onglet du lot dépôt, celui qu'un exploitant ouvre tous les jours — sortait
         du cadre sans aucun moyen d'y accéder. Le débordement ne se voyait pas : un
         parent le coupait, la page ne défilait pas, et l'écran avait l'air complet.
         Mesuré au balayage du 2026-08-17. */
      .ag-seg {
        flex: 1; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
      }
      .ag-seg::-webkit-scrollbar { display: none }
      .ag-seg-btn { flex: 0 0 auto; white-space: nowrap }
      .ag-month-nav { margin-left: 0; width: 100%; justify-content: space-between; }
      .ag-month-label { flex: 1; }
    }

    /* ══ CIBLES TACTILES — 44 px SOUS 768 px (critere 7 de B1) ══════════════════
     *
     * Mesurees a 375 px pendant la recette du 2026-08-14 : fleches de mois 30 px,
     * « Aujourd'hui » 31 px, segments de type 27 px. Toutes en dessous du seuil, et
     * toutes voisines les unes des autres — c'est la combinaison qui fait rater :
     * on vise « Mission » et on change de mois.
     *
     * La densite du BUREAU ne bouge pas : a la souris, 30 px se cliquent tres bien,
     * et elargir partout aurait grossi une barre d'outils que rien n'obligeait a
     * grossir. Le seuil est une contrainte du DOIGT, pas une regle d'esthetique. */
    @media (max-width: 767px) {
      .ag-month-btn { width: 44px; height: 44px; }
      .ag-today-btn { min-height: 44px; padding: 0 12px; }
      .ag-seg-btn { min-height: 44px; }
      /* Le selecteur de vehicule : 38 px, et il ouvre une liste deroulante — le rater
         ferme le panneau au lieu de l'ouvrir. */
      .ag-dd-trigger { min-height: 44px; }
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
      color: var(--pill, var(--texte-succes)); background: color-mix(in srgb, var(--pill, var(--texte-succes)) 14%, transparent);
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
    .ag-up-duree { font-weight: 800; color: var(--texte-info); }
    .ag-up-badge {
      font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 9999px;
      /* Lavis a 14 % et non 16 : le jeton alerte tombe sous 4,5:1 au-dela (verif:contraste). */
      color: var(--u, var(--texte-succes)); background: color-mix(in srgb, var(--u, var(--texte-succes)) 14%, transparent);
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
      border-left: 3px solid var(--pill, var(--texte-succes));
    }
    .ag-day-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ag-day-card-type {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
      color: var(--pill, var(--texte-succes));
    }
    .ag-day-card-title { font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 8px 0 0; }
    .ag-day-card-meta { font-size: 11px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .ag-groupe { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
                 color: var(--fg-secondary); background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    /* Multi-jours : une pastille bleue, la couleur des réservations, lisible sans ouvrir. */
    .ag-duree { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 800;
                color: var(--texte-info); background: color-mix(in srgb, var(--texte-info) 12%, transparent); }
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

    /* ─── « À clore » (lot du 28/09) — la question vient à l'utilisateur ─── */
    .ag-clore {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px 14px; margin-top: 12px;
      background: color-mix(in srgb, var(--warning) 7%, var(--bg-secondary));
      border: 1px solid color-mix(in srgb, var(--warning) 28%, transparent);
      border-radius: var(--radius-card);
    }
    .ag-clore-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
    .ag-clore-titre { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .ag-clore-sub { font-size: 12px; color: var(--fg-tertiary); }
    .ag-clore-row {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;
      padding: 8px 10px; border-radius: 10px;
      background: var(--bg-primary); border-left: 3px solid var(--pill, var(--warning));
    }
    .ag-clore-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
    .ag-clore-plate { font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 700; color: var(--fg-primary); cursor: pointer; }
    .ag-clore-title { font-size: 13px; font-weight: 600; color: var(--fg-primary); }
    .ag-clore-meta { font-size: 11.5px; color: var(--fg-tertiary); }
    .ag-clore-actions, .ag-clore-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .ag-clore-lbl { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); }
    .ag-input--sm { width: auto; padding: 6px 8px; font-size: 13px; }

    /* ─── Formulaire de création ─── */
    .ag-modal-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
    /* Deux colonnes sur grand écran : QUOI | QUAND. Le dialogue s'élargit pour les tenir. */
    .ag-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    @media (min-width: 760px) {
      .ag-modal:has(.ag-modal-body--2col) { max-width: 820px; }
      .ag-modal-body--2col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 22px; align-items: start; }
    }
    .ag-seg--mini .ag-seg-btn { min-height: 32px; padding: 5px 8px; font-size: 11.5px; }
    .ag-seg-btn--danger.ag-seg-btn--active { color: var(--texte-alerte); }
    .ag-resas { display: flex; flex-direction: column; gap: 8px; padding: 10px 11px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .ag-resas-head { display: flex; align-items: center; justify-content: space-between; }
    .ag-resas-t { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .ag-resas-t lucide-icon { color: var(--texte-info); }
    .ag-resas-n { font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--texte-info) 14%, transparent); color: var(--texte-info); }
    .ag-resa { display: flex; flex-direction: column; gap: 6px; padding: 8px 9px; border-radius: 10px; background: var(--bg-tertiary); }
    .ag-resa-main { display: flex; flex-direction: column; gap: 2px; }
    .ag-resa-title { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .ag-resa-when { font-size: 11px; color: var(--fg-tertiary); }
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
    .ag-ctx[data-ctx="future"] { color: var(--texte-violet); background: color-mix(in srgb, var(--violet) 10%, transparent); }

    .ag-sec { display: flex; flex-direction: column; gap: 6px; }
    .ag-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ag-sec-titr {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: var(--fg-secondary);
    }
    .ag-sec-titr--fc { color: var(--texte-violet); }
    .ag-sec-titr--act { color: #38BDF8; }
    .ag-sec-badge {
      font-size: 11px; font-weight: 800; padding: 1px 8px; border-radius: 999px;
      background: var(--bg-tertiary); color: var(--fg-tertiary);
    }
    .ag-sec-badge--fc { background: color-mix(in srgb, var(--violet) 10%, transparent); color: var(--texte-violet); }
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
    /* Hors service (déclaré) et boîtier muet (déduit) : deux raisons de plus de ne pas compter un
       véhicule comme disponible — le même vocabulaire que la feuille de réservation. */
    .ag-unavail-ic[data-kind="out_of_service"] { background: rgba(239,68,68,.14); color: var(--danger); }
    .ag-unavail-ic[data-kind="dormant"] { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--texte-attente); }
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
  private readonly auth = inject(AuthService);
  private readonly agentApi = inject(AgendaAgentApiService);
  private readonly aiStatus = inject(AiStatusService);
  protected readonly aiJob = inject(AiJobService);

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
      void this.loadAgentProposals();
      void this.loadPendingRequests();
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
  protected readonly RouteIcon = Route;

  /**
   * L'ICÔNE D'UN TYPE, AU MÊME ENDROIT POUR TOUS LES ÉCRANS.
   *
   * Les deux listes (« à venir & en retard » et le panneau du jour) portaient chacune leur propre
   * ternaire, et aucune des deux ne connaissait `MISSION` : une mission s'affichait avec la CLÉ À
   * MOLETTE de la maintenance, sous le libellé brut « MISSION » (le `default` d'`eventTypeLabel`).
   * Deux ternaires divergents, c'est déjà un de trop.
   */
  protected iconePourType(type: VehicleEventType) {
    switch (type) {
      case 'INCIDENT':
        return this.AlertTriangleIcon;
      case 'RESERVATION':
        return this.CalendarCheckIcon;
      case 'MISSION':
        return this.RouteIcon;
      default:
        return this.WrenchIcon;
    }
  }
  protected readonly XIcon = X;
  protected readonly Trash2Icon = Trash2;
  protected readonly PencilIcon = Pencil;
  protected readonly SettingsIcon = Settings;
  protected readonly QrCodeIcon = QrCode;
  protected readonly ShuffleIcon = Shuffle;
  protected readonly PlayIcon = Play;
  protected readonly ListChecksIcon = ListChecks;
  protected readonly MoreIcon = MoreHorizontal;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly InboxIcon = Inbox;
  protected readonly SparklesIcon = Sparkles;
  protected readonly ActivityIcon = Activity;
  protected readonly ShieldCheckIcon = ShieldCheck;
  protected readonly BanIcon = Ban;
  protected readonly WifiOffIcon = WifiOff;
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
  /**
   * Échéances du panneau « à venir & en retard » : fenêtre FIXE autour d'aujourd'hui, jamais le
   * mois affiché. Séparé d'`events()` exprès — voir `loadSummary`.
   */
  private readonly echeances = signal<VehicleEventDto[]>([]);
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
    /** Lot multi-jours (28/09) : fin facultative — vide = la journée (maintenance) ou jusqu'à résolution (incident). */
    endDate: string;
    endTime: string;
    blocksVehicle: boolean;
    odometerKm: number | null;
    description: string;
  } = this.blankForm();

  /** F10 (28/09) — l'évènement en cours de modification dans le même dialogue ; null = création. */
  protected readonly editingEvent = signal<VehicleEventDto | null>(null);

  protected readonly typeOptions: { value: '' | VehicleEventType; label: string }[] = [
    { value: '', label: 'Tous' },
    { value: 'MAINTENANCE', label: 'Maintenance' },
    { value: 'INCIDENT', label: 'Incident' },
    { value: 'RESERVATION', label: 'Réservation' },
    // Espace dépôt (2026-08) — les missions apparaissent dans la MÊME grille que la
    // maintenance, les incidents et les réservations sous « Tous » (A2 § 3.1). Leur tableau,
    // lui, est une VUE (sélecteur de vues, refonte du 28/09), plus un filtre de type.
  ];

  private readonly monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
  private readonly dayLabelFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ─── Permissions ────────────────────────────────────────────────────────────
  protected readonly canManage = computed(() => this.perms.can('agenda_manage'));
  // Sprint 9 (consolidation) — actions Réservation / Optimisation ouvertes depuis le calendrier.
  protected readonly canReserve = computed(() => this.perms.can('reservations_request'));
  protected readonly canValidate = computed(() => this.perms.can('reservations_manage'));
  protected readonly canOptimize = computed(() => this.perms.can('reservations_view'));
  // ⚠️ Plus d'`aiEnabled` global ici : l'interrupteur maître ignore le kill-switch par fonction,
  // et gater dessus proposait des boutons que le serveur refusait. Chaque entrée suit SA fonction.
  /** Feuille « Optimisation » → analyse de capacité. */
  protected readonly aiCapacity = computed(() => this.aiStatus.can('capacity'));
  /** Agent d'agenda : ne conditionne que la PRODUCTION de propositions, pas leur lecture. */
  protected readonly aiAgendaAgent = computed(() => this.aiStatus.can('agendaAgent'));
  /** ⚙️ Paramètres de l'agent : super-admin + fleet-admin (config par société). */
  protected readonly canConfigureAgent = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  /** Couches d'analyse (activité réelle, prévision, disponibilité) — même garde que la donnée. */
  protected readonly canSeeInsights = computed(() => this.perms.can('reservations_view'));
  /**
   * Le CALENDRIER lui-même — événements, compteurs, échéances.
   *
   * ⚠️ CE N'EST PAS LA MÊME CHOSE QUE POUVOIR OUVRIR LA PAGE. La route est gardée
   * large (`agenda_view`, `reservations_*`, `ai_optimize`, `missions_view`) pour que
   * chacun atteigne SA partie ; celle-ci n'appartient qu'à `agenda_view`. Un
   * gestionnaire qui vient pour ses missions ne voit donc ni la grille du mois, ni les
   * trois compteurs, ni les échéances — et surtout, on ne les lui demande pas au
   * serveur, qui les refuserait.
   */
  protected readonly canSeeAgenda = computed(() => this.perms.can('agenda_view'));
  protected readonly resSheetOpen = signal(false);
  protected readonly resStartMode = signal<'request' | 'validate'>('request');
  protected readonly resDefaultDate = signal<string | null>(null);
  /** #4 — réservation en cours d'édition (null = création / validation). */
  protected readonly resEditReservation = signal<VehicleEventDto | null>(null);
  /** ⚙️ Paramètres de l'agenda (agent IA). */
  protected readonly agentSheetOpen = signal(false);
  /** Propositions de l'agent nocturne (revue). */
  /** QR imprimable du lien public de réservation (P0-1). */
  protected readonly qrDialogOpen = signal(false);
  /** Reprise en masse des réservations (lot 3c). */
  protected readonly reorgSheetOpen = signal(false);
  /** Pré-réglage de la feuille Réorganiser quand elle s'ouvre depuis un geste (véhicule, fenêtre, action). */
  protected readonly reorgPreset = signal<PresetReorganisation | null>(null);
  /** Réservations du véhicule prises sur la période du formulaire d'indisponibilité, et la décision par ligne. */
  protected readonly resasPeriode = signal<VehicleEventDto[]>([]);
  protected readonly resasPeriodeLoading = signal(false);
  protected readonly resasDecisions = signal<Record<string, 'laisser' | 'annuler' | 'reaffecter'>>({});
  protected readonly nbDecisions = computed(() => Object.values(this.resasDecisions()).filter((d) => d !== 'laisser').length);
  /**
   * Propositions de l'agent EN ATTENTE — la liste, plus seulement son compte (lot 3a, 23/09).
   *
   * Elles n'étaient visibles que dans une feuille séparée : le calendrier, lui, ignorait qu'un
   * véhicule était « prévu ». D'où la tentation de les poser en réservations fermes pour qu'elles
   * se voient — au prix d'un parc bloqué à 70 %. Elles s'affichent maintenant EN FANTÔME sur la
   * grille : visibles, jamais bloquantes.
   */
  protected readonly agentProposals = signal<AgendaAgentProposalDto[]>([]);
  protected readonly agentProposalCount = computed(() => this.agentProposals().length);
  /** Vue affichée sous l'en-tête (refonte UX du 28/09) — Calendrier par défaut. */
  protected readonly vue = signal<'calendrier' | 'missions' | 'parc' | 'ia'>('calendrier');
  /** Menu « ⋯ » de l'en-tête (QR, réorganiser, paramètres). */
  protected readonly plusOpen = signal(false);
  /** La vue Assistant IA n'a de sens qu'avec une fonction IA ouverte, ou des propositions à traiter. */
  protected readonly montrerVueIa = computed(
    () => this.canOptimize() && (this.aiCapacity() || this.aiAgendaAgent() || this.aiStatus.can('placement') || this.agentProposalCount() > 0),
  );
  /** Résultat de capacité IA pré-chargé (analyse async) à réafficher quand on ouvre l'optimisation via la pastille. */
  /**
   * Nb de demandes de réservation EN ATTENTE, toutes dates confondues.
   *
   * ┌─ POURQUOI CE N'EST PLUS UN `computed` SUR `events()` ─────────────────────┐
   * │ Il l'était, et il ne comptait donc que ce qui tombait dans la fenêtre du  │
   * │ MOIS AFFICHÉ. Or le bouton « Demandes » ne s'affiche que si ce compte est │
   * │ > 0 : une demande déposée pour le mois suivant ne le faisait pas          │
   * │ apparaître. Combiné au fait que rien ne prévenait la société (corrigé     │
   * │ côté serveur le même jour), une demande publique pouvait rester invisible │
   * │ indéfiniment — alors que le lien de cdef31 est actif et ouvert 55 fois.   │
   * │                                                                           │
   * │ Le compte vient désormais du MÊME endpoint que la file elle-même, avec sa │
   * │ fenêtre par défaut (−31 j → +365 j) : ce que le badge annonce est         │
   * │ exactement ce que la feuille affichera.                                   │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  protected readonly pendingCount = signal(0);

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
    const gid = this.selectedGroupId();
    return this.events().filter((ev) => {
      if (vid && ev.vehicleId !== vid) return false;
      // Filtre « groupe » : par le véhicule (son groupe), OU par le groupe qui UTILISE le véhicule
      // (point 9) — le prêt d'un véhicule à un autre groupe se lit des deux côtés.
      if (gids && !gids.has(ev.vehicleId) && groupeReservationId(ev) !== gid) return false;
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
    // F3 (recette du 28/09) : les badges suivent le véhicule / le groupe choisis, comme la grille
    // et le panneau du jour — avant, ils parlaient de tout le parc sous un filtre qui disait le contraire.
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    for (const slot of this.activitySlots()) {
      if (vid && slot.vehicleId !== vid) continue;
      if (gids && !gids.has(slot.vehicleId)) continue;
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

  /**
   * Propositions de l'agent restreintes au périmètre courant (société, groupe, véhicule).
   *
   * Même filtrage que les événements : une proposition est un pré-remplissage pour CE parc-là.
   * Le filtre de TYPE ne s'y applique pas — une proposition n'a pas de type d'événement, elle
   * deviendra une réservation si on la valide.
   */
  private readonly scopedProposals = computed(() => {
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    return this.agentProposals().filter((p) => {
      if (vid && p.vehicleId !== vid) return false;
      if (gids && !gids.has(p.vehicleId)) return false;
      return true;
    });
  });

  /**
   * Nb de propositions par jour (clé ISO locale) — la couche FANTÔME du calendrier.
   *
   * Compte les PROPOSITIONS, pas les véhicules distincts : deux tournées prévues le même jour sur
   * le même véhicule sont deux créneaux à valider, et les fondre en « 1 » cacherait du travail.
   * (C'est l'inverse des couches activité/prévision, qui répondent à « combien de véhicules ».)
   */
  protected readonly proposalsByDay = computed<Map<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const p of this.scopedProposals()) {
      const d = new Date(p.startAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = localIso(d);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  /** Propositions du jour ouvert, triées par heure — affichées dans le panneau jour. */
  protected readonly dayProposals = computed(() => {
    const b = this.selectedDayBounds();
    if (!b) return [];
    return this.scopedProposals()
      .filter((p) => {
        const t = new Date(p.startAt).getTime();
        return !Number.isNaN(t) && t >= b.start && t < b.end;
      })
      .sort((a, b2) => new Date(a.startAt).getTime() - new Date(b2.startAt).getTime());
  });

  /** Nb de véhicules DISTINCTS dont l'usage est PRÉVU par jour (badge violet « ~N »). */
  protected readonly forecastByDay = computed<Map<string, number>>(() => {
    const perDay = new Map<string, Set<string>>();
    const vid = this.selectedVehicleId(); // F3 : même périmètre que la grille
    const gids = this.groupVehicleIdSet();
    for (const slot of this.forecastSlots()) {
      if (vid && slot.vehicleId !== vid) continue;
      if (gids && !gids.has(slot.vehicleId)) continue;
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
        // Même règle que la grille du mois, et le MÊME prédicat : le panneau du jour et la grille
        // ne doivent pas pouvoir diverger. Voir `annulationSansObjet`.
        if (annulationSansObjet(ev)) return false;
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

  /** Libellé d'une raison d'indisponibilité, dans le panneau du jour. */
  protected unavailKindLabel(kind: 'immobilized' | 'reserved' | 'out_of_service' | 'dormant'): string {
    switch (kind) {
      case 'immobilized': return 'Immobilisé';
      case 'reserved': return 'Réservé';
      case 'out_of_service': return 'Hors service';
      case 'dormant': return 'Boîtier muet';
    }
  }

  /**
   * Disponibilité du jour (aujourd'hui + à venir) : combien de véhicules du périmètre sont libres,
   * et le détail des indisponibles. Aligné sur la logique backend (`computeSuggestions` +
   * `findImmobilized`) : incident sans fin = jusqu'à résolution, maintenance sans fin = sa journée.
   *
   * « Check de tout » du 28/09 : le panneau comptait comme DISPONIBLE un véhicule déclaré hors
   * service et un véhicule dont le boîtier se tait depuis des semaines — alors que la réservation,
   * le lien public et l'IA les écartent tous les trois. Un chiffre « 30 / 30 » sur un parc où 4
   * voitures sont accidentées est un chiffre faux. Quatre raisons désormais, par force décroissante :
   * hors service (déclaré) > boîtier muet (déduit, seuil 7 j) > immobilisé > réservé.
   */
  protected readonly dayAvailability = computed(() => {
    const universe = this.availabilityVehicles();
    const total = universe.length;
    const b = this.selectedDayBounds();
    const unavailable: { vehicleId: string; plate: string; kind: 'immobilized' | 'reserved' | 'out_of_service' | 'dormant'; label: string }[] = [];
    if (!b || total === 0) return { total, available: total, pct: 100, unavailable };

    const ids = new Set(universe.map((v) => v.id));
    const plateOf = new Map(universe.map((v) => [v.id, v.plate ?? '—']));
    const now = Date.now();
    const horsService = new Map<string, string>();
    const dormant = new Map<string, string>();
    for (const v of universe) {
      const motif = horsServiceLabel(v.outOfServiceReason);
      if (motif) { horsService.set(v.id, motif); continue; }
      // Même seuil (7 j) et même prédicat que le vivier de réservation : un véhicule sans boîtier
      // n'est PAS dormant, il reste disponible.
      if (isVehicleDormant({ trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null }, now, DORMANT_STOP_COUNTING_MS)) {
        dormant.set(v.id, `depuis ${formatSilenceLabel(v.tracker?.lastSeenAt ?? null, now)}`);
      }
    }
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
    for (const [vid, motif] of horsService) {
      unavailable.push({ vehicleId: vid, plate: plateOf.get(vid) ?? '—', kind: 'out_of_service', label: motif });
    }
    for (const [vid, label] of dormant) {
      unavailable.push({ vehicleId: vid, plate: plateOf.get(vid) ?? '—', kind: 'dormant', label });
    }
    for (const [vid, reason] of immobilized) {
      if (horsService.has(vid) || dormant.has(vid)) continue; // une raison plus forte l'a déjà sorti
      unavailable.push({ vehicleId: vid, plate: plateOf.get(vid) ?? '—', kind: 'immobilized', label: reason });
    }
    for (const [vid, label] of reserved) {
      if (horsService.has(vid) || dormant.has(vid) || immobilized.has(vid)) continue; // pas de doublon
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

  /**
   * Liste « à venir & en retard », triée par échéance.
   *
   * Se sert dans `echeances()` — la fenêtre fixe autour d'aujourd'hui — et NON dans les
   * événements du mois affiché : feuilleter octobre ne doit pas changer ce qui est « à venir ».
   * Mêmes filtres de périmètre et de type que le calendrier, pour que les deux parlent du même
   * parc.
   *
   * La règle d'appartenance est `estUneEcheance` — la MÊME que celle des compteurs « En retard »
   * et « À venir » du serveur. Avant (24/09), la liste prenait aussi les IN_PROGRESS que le
   * compteur ne comptait pas : « 1 en retard » au-dessus de trois lignes rouges. Depuis le 28/09,
   * seuls les PLANNED sont des échéances : un incident OUVERT n'est pas « en retard », il est porté
   * par le compteur « Incidents ouverts », la pilule et le panneau du jour.
   */
  protected readonly upcomingEvents = computed(() => {
    const type = this.selectedType();
    const vid = this.selectedVehicleId();
    const gids = this.groupVehicleIdSet();
    const gid = this.selectedGroupId();
    return this.echeances()
      .filter((ev) => {
        if (vid && ev.vehicleId !== vid) return false;
        if (gids && !gids.has(ev.vehicleId) && groupeReservationId(ev) !== gid) return false;
        if (type && ev.type !== type) return false;
        return estUneEcheance(ev);
      })
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
    this.aiStatus.ensureLoaded(); // masque les entrées IA de l'agenda si l'IA est coupée pour la flotte
    await Promise.all([this.loadVehicles(), this.loadSummary()]);
    await this.loadEvents();
    void this.loadActivity();
    void this.loadForecast();
    void this.loadAgentProposals();
    void this.loadPendingRequests();
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
    } catch (err) {
      swallow('agenda:loadVehicles', err);
      this.vehicles.set([]);
    }
  }

  /**
   * Les TROIS COMPTEURS **et** la liste « à venir & en retard » — chargés ensemble, parce qu'ils
   * décrivent le même horizon.
   *
   * ⚠️ Ils ne le décrivaient PAS. Les compteurs viennent de `GET /agenda/summary`, dont la fenêtre
   * est « en retard » + « 30 prochains jours ». La liste, elle, se servait dans `events()`, qui ne
   * contient QUE le mois affiché. D'où un écran qui se contredit : « 1 À VENIR (30J) » au-dessus
   * d'une liste vide quand l'échéance tombe le mois prochain — et une liste qui changeait de sens
   * en feuilletant les mois, alors qu'« à venir » ne dépend pas du mois qu'on regarde.
   *
   * Deux appels plutôt qu'une fenêtre élargie : élargir `loadEvents` aurait fait grossir la
   * requête du calendrier à chaque mois feuilleté (l'union « mois affiché ∪ 30 jours » s'étire
   * sans borne dès qu'on s'éloigne de la date du jour).
   */
  private async loadSummary(): Promise<void> {
    // Même garde que `loadEvents` : `GET /agenda/summary` exige `agenda_view`.
    if (!this.canSeeAgenda()) {
      this.summary.set(null);
      this.echeances.set([]);
      return;
    }
    try {
      // P2-4 : les compteurs suivent le périmètre filtré (groupe OU véhicule), comme la liste.
      // Le véhicule prime : un véhicule choisi est déjà dans le groupe choisi, ou l'a réinitialisé.
      this.summary.set(
        await firstValueFrom(
          this.api.summary({
            fleetId: this.currentFleetId(),
            vehicleId: this.selectedVehicleId() || undefined,
            groupId: this.selectedVehicleId() ? undefined : this.selectedGroupId() || undefined,
          }),
        ),
      );
    } catch (err) {
      swallow('agenda:loadSummary', err);
      this.summary.set(null);
    }
    try {
      const now = Date.now();
      this.echeances.set(
        await firstValueFrom(
          this.api.listEvents({
            // 90 j en arrière : « en retard » n'a pas de borne basse côté serveur, mais une
            // échéance oubliée depuis plus d'un trimestre ne se règle pas depuis cette liste.
            from: new Date(now - 90 * 24 * 3600 * 1000).toISOString(),
            to: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
            fleetId: this.currentFleetId(),
          }),
        ),
      );
    } catch (err) {
      swallow('agenda:loadEcheances', err);
      this.echeances.set([]);
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
    // ⚠️ ON N'APPELLE PAS CE QU'ON N'A PAS LE DROIT D'APPELER.
    //
    // La route `/agenda` s'ouvre à `missions_view` — l'onglet Missions y vit, décision
    // A2 § intro — mais `GET /agenda/events` exige `agenda_view`, que le gestionnaire
    // n'a PAS par défaut. Le compte entrait donc, et récoltait deux notifications
    // rouges à chaque visite : celle de l'intercepteur sur le 403, puis celle du bloc
    // `catch` ci-dessous. Sur chaque capture de recette, ces deux bandeaux annonçaient
    // une panne là où le produit fonctionnait comme prévu.
    //
    // Le même patron protège déjà `loadActivity` et `loadForecast`. Il manquait ici.
    if (!this.canSeeAgenda()) {
      this.events.set([]);
      this.loading.set(false);
      return;
    }
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
      swallow('agenda:loadEvents', err);
      this.events.set([]);
      this.toast.error('Erreur de chargement', apiErrorMessage(err, 'Impossible de charger l\'agenda.'));
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
    } catch (err) {
      swallow('agenda:loadActivity', err);
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
    } catch (err) {
      swallow('agenda:loadForecast', err);
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
    // P2-4 : la grille se filtre côté client, mais les compteurs viennent du serveur — ils
    // doivent suivre le même périmètre, sinon l'écran affiche un cadre qu'il n'applique pas.
    void this.loadSummary();
  }

  protected selectVehicle(id: string): void {
    this.selectedVehicleId.set(id);
    this.vehicleDdOpen.set(false);
    void this.loadSummary(); // P2-4, même raison que `selectGroup`
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

  /**
   * ── DÉPLACER UN ÉVÉNEMENT D'UN JOUR À L'AUTRE, D'UN GESTE ──────────────────────────────
   *
   * La grille a déjà décidé que la pilule était saisissable (permission + type + statut) ;
   * ici on traduit « lâché sur le 27 » en un créneau, et on laisse le SERVEUR trancher le
   * reste. Les conflits ne se devinent pas côté navigateur : la contrainte d'exclusion en
   * base est le dernier rempart, et son refus se lit tel quel plutôt que d'être reformulé.
   *
   * ⚠️ L'HEURE NE BOUGE PAS, seul le jour. Un ramassage scolaire déplacé de mardi à jeudi
   * reste à 7 h 20 : c'est ce que le geste promet, et supposer autre chose serait une
   * décision qu'on prendrait à la place du gestionnaire.
   */
  protected async deplacerEvenement({ id, versIso }: { id: string; versIso: string }): Promise<void> {
    const ev = this.events().find((e) => e.id === id);
    if (!ev) return;

    const debut = new Date(ev.startAt);
    const [a, m, j] = versIso.split('-').map(Number);
    const nouveauDebut = new Date(debut);
    nouveauDebut.setFullYear(a, m - 1, j);

    // Garde de bon sens, avant tout aller-retour : on ne replanifie pas dans le passé.
    if (nouveauDebut.getTime() < Date.now()) {
      this.toast.error('Déplacement refusé', 'On ne peut pas replanifier dans le passé.');
      return;
    }

    // La DURÉE est conservée telle quelle — pas recalculée depuis le nouveau jour, ce qui
    // casserait un événement à cheval sur minuit.
    const dureeMs = ev.endAt ? new Date(ev.endAt).getTime() - debut.getTime() : null;
    const nouvelleFin = dureeMs != null ? new Date(nouveauDebut.getTime() + dureeMs) : null;

    const libelle = ev.title || ev.vehiclePlate || 'L’événement';
    const jourLisible = this.dayLabelFmt.format(nouveauDebut);
    try {
      const creneau = {
        startAt: nouveauDebut.toISOString(),
        ...(nouvelleFin ? { endAt: nouvelleFin.toISOString() } : {}),
      };
      await firstValueFrom(
        ev.type === 'RESERVATION'
          ? this.api.updateReservation(id, creneau)
          : this.api.updateEvent(id, creneau),
      );
      this.toast.success('Déplacé', `${libelle} — ${jourLisible}`);
      await Promise.all([this.loadEvents(), this.loadSummary()]);
      void this.loadForecast();
    } catch (err) {
      swallow('agenda:deplacerEvenement', err);
      // Le motif du serveur passe EN L'ÉTAT : « ce véhicule est déjà pris sur ce créneau » est
      // une phrase utile ; « échec du déplacement » n'en est pas une.
      this.toast.error('Déplacement refusé', apiErrorMessage(err, 'Le serveur a refusé ce créneau.'));
    }
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

  /**
   * Recharge le parc (sièges à bord, hors service, boîtiers) — après « Paramètres de l'agenda »,
   * où les sièges à bord se règlent : sans ça, la carte du jour disait « 2 bébé du stock » pour un
   * véhicule qu'on venait d'équiper (vu sur la démo le 28/09). Best-effort : la liste d'avant reste.
   */
  protected async rafraichirVehicules(): Promise<void> {
    try {
      this.vehicles.set(await firstValueFrom(this.vehiclesApi.list()));
    } catch (e) {
      swallow('agenda:rafraichirVehicules', e);
    }
  }

  /** Motif d'une réservation (stocké en metadata) pour l'afficher dans la carte du jour. */
  /**
   * Motif d'une réservation — sauf quand il EST le titre. Depuis le 24/09 le motif saisi devient
   * le titre de la réservation (`reservations.service.ts`), et la carte du jour le montrait donc
   * deux fois de suite (recette du 28/09 : « Ramassage secteur nord » en titre, puis en ligne de
   * détail). Un titre explicite différent du motif garde les deux lignes.
   */
  /** Nom du groupe qui utilise le véhicule pour cette réservation (`metadata.group`), sinon null. */
  protected groupeReservation(ev: VehicleEventDto): string | null {
    if (ev.type !== 'RESERVATION') return null;
    const g = (ev.metadata as { group?: { name?: unknown } | null } | null)?.group;
    return g && typeof g.name === 'string' && g.name.trim() ? g.name.trim() : null;
  }

  protected reservationReason(ev: VehicleEventDto): string | null {
    const reason = (ev.metadata as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || !reason.trim()) return null;
    const motif = reason.trim();
    return motif === ev.title.trim() ? null : motif;
  }

  /**
   * « 1 bébé · 2 enfant (1 bébé à bord · 2 enfant du stock) » — sièges auto qu'une réservation
   * demande, et ce que son véhicule a déjà à bord : celui qui prépare la voiture sait quoi sortir
   * du stock. Deux types, jamais interchangeables. Sans besoin : null.
   */
  protected siegesAuto(ev: VehicleEventDto): string | null {
    if (ev.type !== 'RESERVATION') return null;
    const c = (ev.metadata as { criteria?: { childSeatsBaby?: unknown; childSeatsChild?: unknown } } | null)?.criteria;
    if (!c) return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const need = { baby: n(c.childSeatsBaby), child: n(c.childSeatsChild) };
    const besoin = siegesLabel(need);
    if (!besoin) return null;
    const v = this.vehicles().find((x) => x.id === ev.vehicleId);
    const aBord = { baby: Math.min(need.baby, v?.childSeatsBaby ?? 0), child: Math.min(need.child, v?.childSeatsChild ?? 0) };
    const duStock = { baby: need.baby - aBord.baby, child: need.child - aBord.child };
    const detail = [siegesLabel(aBord) ? `${siegesLabel(aBord)} à bord` : '', siegesLabel(duStock) ? `${siegesLabel(duStock)} du stock` : ''].filter(Boolean);
    return detail.length > 0 ? `${besoin} (${detail.join(' · ')})` : besoin;
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
      swallow('agenda:trim', err);
      this.toast.error('Échec', apiErrorMessage(err, 'Action impossible.'));
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
      swallow('agenda:deleteEvent', err);
      this.toast.error('Échec suppression', apiErrorMessage(err, 'Suppression impossible.'));
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
      endDate: '',
      endTime: '18:00',
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
    this.editingEvent.set(null);
    this.form = this.blankForm();
    this.odometerHint.set('');
    this.resasPeriode.set([]); this.resasDecisions.set({});
    this.createOpen.set(true);
    // Pré-remplit l'odomètre si un véhicule est déjà sélectionné via le filtre.
    if (this.form.vehicleId) void this.prefillOdometer(this.form.vehicleId);
  }

  /**
   * F10 (28/09) — celui qui gère peut changer les dates (et le reste) d'une maintenance ou d'un
   * incident : le retour du garage a glissé, la panne s'est révélée plus longue. Même dialogue que
   * la création, pré-rempli ; le véhicule et le type ne changent pas (ce serait un autre évènement).
   */
  protected openEdit(ev: VehicleEventDto): void {
    if (!this.canManage() || (ev.type !== 'MAINTENANCE' && ev.type !== 'INCIDENT')) return;
    const start = new Date(ev.startAt);
    const end = ev.endAt ? new Date(ev.endAt) : null;
    this.form = {
      ...this.blankForm(),
      type: ev.type,
      vehicleId: ev.vehicleId,
      title: ev.title,
      category: ev.category ?? '',
      severity: ev.severity === 'LOW' || ev.severity === 'HIGH' ? ev.severity : 'MEDIUM',
      date: localIso(start),
      time: this.hhmm(start),
      allDay: ev.allDay,
      endDate: end ? localIso(end) : '',
      endTime: end ? this.hhmm(end) : '18:00',
      blocksVehicle: ev.blocksVehicle,
      odometerKm: ev.odometerKm ?? null,
      description: ev.description ?? '',
    };
    this.editingEvent.set(ev);
    this.odometerHint.set('');
    this.createOpen.set(true);
  }

  /** « HH:mm » local, le format qu'attend un `<input type="time">` (hm() rend « 7h30 », pour l'affichage). */
  private hhmm(d: Date): string {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** Nombre de jours civils couverts (1 = une journée) — la carte du jour dit « du 5 au 12 » au-delà. */
  protected dureeEnJours(ev: VehicleEventDto): number {
    if (!ev.endAt) return 1;
    const a = startOfDay(new Date(ev.startAt)).getTime();
    const b = startOfDay(new Date(ev.endAt)).getTime();
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1;
    return Math.round((b - a) / 86400000) + 1;
  }

  /**
   * « jour 2/3 » : où le jour ouvert dans le panneau se situe dans un évènement de plusieurs jours.
   * Null si l'évènement tient sur un jour, ou si le jour ouvert n'est pas dedans (évènement
   * immobilisant qui déborde sa fin prévue : la position n'aurait pas de sens).
   */
  protected positionJour(ev: VehicleEventDto): string | null {
    const total = this.dureeEnJours(ev);
    if (total <= 1) return null;
    const jour = this.selectedDay();
    if (!jour) return null;
    const debut = startOfDay(new Date(ev.startAt)).getTime();
    const cible = new Date(`${jour}T00:00:00`).getTime();
    if (Number.isNaN(debut) || Number.isNaN(cible)) return null;
    const idx = Math.round((cible - debut) / 86400000) + 1;
    if (idx < 1 || idx > total) return null;
    return `jour ${idx}/${total}`;
  }

  /** « 09:00 → 12:00 », ou « lun. 5 oct. 09:00 → jeu. 8 oct. 12:00 » quand la réservation change de jour. */
  protected plageHoraire(ev: VehicleEventDto): string {
    const s = new Date(ev.startAt);
    if (Number.isNaN(s.getTime())) return '';
    if (!ev.endAt) return formatDate(s, 'HH:mm', 'fr');
    const e = new Date(ev.endAt);
    if (Number.isNaN(e.getTime())) return formatDate(s, 'HH:mm', 'fr');
    return this.dureeEnJours(ev) > 1
      ? `${formatDate(s, 'EEE d MMM HH:mm', 'fr')} → ${formatDate(e, 'EEE d MMM HH:mm', 'fr')}`
      : `${formatDate(s, 'HH:mm', 'fr')} → ${formatDate(e, 'HH:mm', 'fr')}`;
  }

  protected todayIso(): string {
    return localIso(new Date());
  }

  /** Remplace un évènement dans la grille ET dans la fenêtre des échéances (même objet, deux listes). */
  private remplacerEvenement(updated: VehicleEventDto): void {
    this.events.update((list) => list.map((e) => (e.id === updated.id ? updated : e)));
    this.echeances.update((list) => list.map((e) => (e.id === updated.id ? updated : e)));
  }

  // ─── « Cette maintenance est-elle terminée ? » (lot du 28/09) ───────────────
  /**
   * Maintenances et incidents encore ouverts dont la fin prévue est passée — ou, sans fin, commencés
   * avant aujourd'hui. La liste revient chaque jour jusqu'à la réponse. Périmètre : la société du
   * bandeau (les échéances comme le mois), sans le filtre véhicule / groupe : c'est une liste de
   * choses à faire, pas une vue.
   */
  protected readonly aClore = computed(() => {
    if (!this.canManage()) return [];
    const now = Date.now();
    const debutJour = startOfDay(new Date()).getTime();
    const vus = new Set<string>();
    const out: { ev: VehicleEventDto; libelle: string }[] = [];
    for (const ev of [...this.echeances(), ...this.events()]) {
      if (vus.has(ev.id)) continue;
      vus.add(ev.id);
      if (ev.type !== 'MAINTENANCE' && ev.type !== 'INCIDENT') continue;
      if (ev.status !== 'OPEN' && ev.status !== 'IN_PROGRESS') continue;
      const debut = new Date(ev.startAt).getTime();
      if (Number.isNaN(debut)) continue;
      const fin = ev.endAt ? new Date(ev.endAt).getTime() : null;
      const echu = fin != null && !Number.isNaN(fin) ? fin < now : debut < debutJour;
      if (!echu) continue;
      const libelle = fin != null && !Number.isNaN(fin)
        ? `fin prévue le ${formatDate(fin, 'EEE d MMM', 'fr')}, dépassée`
        : `en cours depuis le ${formatDate(debut, 'EEE d MMM', 'fr')}, sans date de fin`;
      out.push({ ev, libelle });
    }
    return out.sort((a, b) => new Date(a.ev.startAt).getTime() - new Date(b.ev.startAt).getTime());
  });

  /** id → date saisie (YYYY-MM-DD) pendant qu'on répond « non, jusqu'au… ». */
  protected readonly cloreEdit = signal<Record<string, string>>({});

  protected ouvrirCloreEdit(ev: VehicleEventDto): void {
    const demain = new Date();
    demain.setDate(demain.getDate() + 1);
    this.cloreEdit.update((m) => ({ ...m, [ev.id]: localIso(demain) }));
  }

  protected setCloreDate(id: string, value: string): void {
    this.cloreEdit.update((m) => ({ ...m, [id]: value }));
  }

  protected annulerCloreEdit(id: string): void {
    this.cloreEdit.update((m) => {
      const { [id]: _retire, ...reste } = m;
      return reste;
    });
  }

  /** « Oui, terminée » : clos à l'instant — la fin réelle est maintenant, pas la fin prévue. */
  protected async cloturer(ev: VehicleEventDto): Promise<void> {
    if (!this.canManage()) return;
    this.busyId.set(ev.id);
    try {
      const updated = await firstValueFrom(this.api.updateEvent(ev.id, { status: 'DONE', endAt: new Date().toISOString() }));
      this.remplacerEvenement(updated);
      this.toast.success(ev.type === 'INCIDENT' ? 'Incident réglé' : 'Maintenance terminée', ev.vehiclePlate ?? '');
      void this.loadSummary();
    } catch (err) {
      swallow('agenda:cloturer', err);
      this.toast.error('Échec', apiErrorMessage(err, 'Clôture impossible.'));
    } finally {
      this.busyId.set(null);
    }
  }

  /** « Non, jusqu'au … » : la fin prévue est repoussée ; l'évènement sort de la liste jusque-là. */
  protected async repousserFin(ev: VehicleEventDto): Promise<void> {
    if (!this.canManage()) return;
    const jour = this.cloreEdit()[ev.id];
    if (!jour) return;
    // Toute la journée : jusqu'au soir de ce jour ; sinon la même heure de fin que celle qu'on avait.
    const heure = ev.allDay ? '23:59:59' : `${ev.endAt ? this.hhmm(new Date(ev.endAt)) : '18:00'}:00`;
    const endAt = new Date(`${jour}T${heure}`);
    if (Number.isNaN(endAt.getTime()) || endAt.getTime() <= new Date(ev.startAt).getTime()) {
      this.toast.error('Date', 'La nouvelle fin doit être après le début.');
      return;
    }
    this.busyId.set(ev.id);
    try {
      const updated = await firstValueFrom(this.api.updateEvent(ev.id, { endAt: endAt.toISOString() }));
      this.remplacerEvenement(updated);
      this.annulerCloreEdit(ev.id);
      this.toast.success('Fin repoussée', `jusqu'au ${formatDate(endAt, 'EEE d MMM', 'fr')}`);
      void this.loadSummary();
    } catch (err) {
      swallow('agenda:repousserFin', err);
      this.toast.error('Échec', apiErrorMessage(err, 'Modification impossible.'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected onCreateVehicleChange(vehicleId: string): void {
    if (vehicleId) void this.prefillOdometer(vehicleId);
    this.onPeriodeChange();
  }

  /** Jours civils couverts par le formulaire (1 = une journée). */
  protected dureeFormulaire(): number {
    const f = this.form;
    if (!f.date || !f.endDate || f.endDate < f.date) return 1;
    const a = new Date(`${f.date}T00:00:00`).getTime();
    const b = new Date(`${f.endDate}T00:00:00`).getTime();
    return Math.round((b - a) / 86400000) + 1;
  }

  /** Fenêtre d'indisponibilité du formulaire, en ISO — la même que celle qui partira au serveur. */
  private fenetreFormulaire(): { startAt: string; endAt: string | null } | null {
    const f = this.form;
    if (!f.date) return null;
    const startAt = f.allDay ? new Date(`${f.date}T00:00:00`).toISOString() : new Date(`${f.date}T${f.time || '00:00'}:00`).toISOString();
    const endAt = f.endDate
      ? (f.allDay ? new Date(`${f.endDate}T23:59:59`).toISOString() : new Date(`${f.endDate}T${f.endTime || '18:00'}:00`).toISOString())
      : null;
    return { startAt, endAt };
  }

  /** Numéro de la dernière lecture partie : une réponse en retard ne doit pas écraser la dernière. */
  private resasLecture = 0;

  /**
   * Relit les réservations du véhicule sur la période dès qu'un champ qui la définit change. Sans
   * fin explicite, la fenêtre est celle de l'immobilisation EFFECTIVE (la journée pour une
   * maintenance ; un incident bloque jusqu'à résolution → on regarde 30 jours devant).
   */
  protected onPeriodeChange(): void {
    const f = this.form;
    if (!f.blocksVehicle || !f.vehicleId || !f.date || this.editingEvent()) {
      this.resasPeriode.set([]); this.resasDecisions.set({}); return;
    }
    const fen = this.fenetreFormulaire();
    if (!fen) return;
    const startMs = new Date(fen.startAt).getTime();
    const effEnd = effectiveBlockingEndMs(f.type, startMs, fen.endAt ? new Date(fen.endAt).getTime() : null);
    const endMs = Number.isFinite(effEnd) ? effEnd : startMs + 30 * 86400000;
    const n = ++this.resasLecture;
    this.resasPeriodeLoading.set(true);
    void firstValueFrom(this.api.listReservations({
      vehicleId: f.vehicleId,
      from: new Date(Math.max(startMs, Date.now())).toISOString(),
      to: new Date(endMs).toISOString(),
      fleetId: this.currentFleetId(),
    })).then((liste) => {
      if (n !== this.resasLecture) return;
      const now = Date.now();
      const vivantes = liste.filter((r) =>
        (r.status === 'CONFIRMED' || r.status === 'REQUESTED' || r.status === 'IN_PROGRESS') &&
        new Date(r.startAt).getTime() < endMs && (r.endAt ? new Date(r.endAt).getTime() : new Date(r.startAt).getTime()) > Math.max(startMs, now),
      ).sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
      this.resasPeriode.set(vivantes);
      // Défaut : réaffecter — c'est le cas du garage ; « laisser » reste à un clic.
      this.resasDecisions.set(Object.fromEntries(vivantes.map((r) => [r.id, 'reaffecter' as const])));
    }).catch((err) => {
      swallow('agenda:resasPeriode', err);
      if (n === this.resasLecture) { this.resasPeriode.set([]); this.resasDecisions.set({}); }
    }).finally(() => { if (n === this.resasLecture) this.resasPeriodeLoading.set(false); });
  }

  protected decisionDe(id: string): 'laisser' | 'annuler' | 'reaffecter' { return this.resasDecisions()[id] ?? 'laisser'; }
  protected decider(id: string, d: 'laisser' | 'annuler' | 'reaffecter'): void {
    this.resasDecisions.update((m) => ({ ...m, [id]: d }));
  }

  /**
   * Applique les décisions prises sur les réservations de la période, APRÈS la création de
   * l'événement : une par une (un refus n'arrête pas les autres), un bilan, et un renvoi vers
   * Réorganiser pour ce qui a été refusé (véhicule et fenêtre déjà réglés).
   */
  private async appliquerDecisions(created: VehicleEventDto): Promise<void> {
    const decisions = Object.entries(this.resasDecisions()).filter(([, d]) => d !== 'laisser');
    if (decisions.length === 0) return;
    let faits = 0;
    const refus: string[] = [];
    for (const [id, d] of decisions) {
      const r = this.resasPeriode().find((x) => x.id === id);
      try {
        await firstValueFrom(d === 'annuler' ? this.api.cancelReservation(id) : this.api.reaffecterReservation(id));
        faits++;
      } catch (err) {
        swallow('agenda:appliquerDecisions', err);
        refus.push(`${r ? formatDate(new Date(r.startAt), 'dd/MM HH:mm', 'fr') : id} — ${apiErrorMessage(err, 'refusé')}`);
      }
    }
    if (refus.length === 0) {
      this.toast.success(`${faits} réservation(s) reprise(s)`, 'Réaffectées ou annulées comme décidé.');
    } else {
      this.toast.error(`${faits} reprise(s), ${refus.length} refusée(s)`, refus.slice(0, 3).join(' · '));
      // Ce qui reste se reprend dans Réorganiser, déjà réglé sur ce véhicule et cette période.
      const fen = this.fenetreFormulaire();
      this.reorgPreset.set({ vehicleId: created.vehicleId, from: fen?.startAt ?? null, to: fen?.endAt ?? null, action: 'reaffecter' });
      this.reorgSheetOpen.set(true);
    }
    this.onReservationChanged();
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
    } catch (err) {
      swallow('agenda:prefillOdometer', err);
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
    // Lot multi-jours (28/09) : la fin, si elle est donnée — toute la journée = jusqu'au soir de
    // ce jour, sinon la date et l'heure de fin saisies. Le serveur revérifie « fin après début ».
    const endAt = f.endDate
      ? (f.allDay
          ? new Date(`${f.endDate}T23:59:59`).toISOString()
          : new Date(`${f.endDate}T${f.endTime || '18:00'}:00`).toISOString())
      : null;
    if (endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      this.toast.error('Dates', 'La fin doit être après le début.');
      return;
    }

    // F10 : le même dialogue modifie un évènement existant — dates, titre, détail.
    const editing = this.editingEvent();
    if (editing) {
      const patch: UpdateVehicleEventDto = {
        title: f.title.trim(),
        category: f.category.trim(),
        description: f.description.trim(),
        startAt,
        endAt,
        allDay: f.allDay,
        blocksVehicle: f.blocksVehicle,
      };
      if (f.type === 'INCIDENT') patch.severity = f.severity;
      if (f.odometerKm != null && !Number.isNaN(f.odometerKm)) patch.odometerKm = Number(f.odometerKm);
      this.saving.set(true);
      try {
        const updated = await firstValueFrom(this.api.updateEvent(editing.id, patch));
        this.remplacerEvenement(updated);
        this.toast.success('Événement modifié', updated.title);
        this.createOpen.set(false);
        this.editingEvent.set(null);
        void this.loadSummary();
      } catch (err) {
        swallow('agenda:submitEdit', err);
        this.toast.error('Échec', apiErrorMessage(err, 'Modification impossible.'));
      } finally {
        this.saving.set(false);
      }
      return;
    }

    const payload: CreateVehicleEventDto = {
      vehicleId: f.vehicleId,
      type: f.type,
      title: f.title.trim(),
      startAt,
      allDay: f.allDay,
      blocksVehicle: f.blocksVehicle,
      status: f.type === 'INCIDENT' ? 'OPEN' : 'PLANNED',
    };
    if (endAt) payload.endAt = endAt;
    if (f.category.trim()) payload.category = f.category.trim();
    if (f.description.trim()) payload.description = f.description.trim();
    if (f.type === 'INCIDENT') payload.severity = f.severity;
    if (f.odometerKm != null && !Number.isNaN(f.odometerKm)) payload.odometerKm = Number(f.odometerKm);
    // Les décisions prises sur les réservations de la période sont tracées dans l'événement.
    const decisions = Object.entries(this.resasDecisions()).filter(([, d]) => d !== 'laisser');
    if (decisions.length > 0) payload.metadata = { reservations: decisions.map(([id, decision]) => ({ id, decision })) };

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
      await this.appliquerDecisions(created);
      this.resasPeriode.set([]); this.resasDecisions.set({});
    } catch (err) {
      swallow('agenda:toISOString', err);
      this.toast.error('Échec création', apiErrorMessage(err, 'Création impossible.'));
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
      swallow('agenda:cancelDayReservation', err);
      this.toast.error('Échec', apiErrorMessage(err, 'Annulation impossible.'));
    } finally {
      this.busyId.set(null);
    }
  }

  /** ⚙️ Ouvre les paramètres de l'agent (config par société via le sélecteur global). */
  protected openAgentSettings(): void {
    this.agentSheetOpen.set(true);
  }

  /** Une proposition a été validée/refusée : recharge l'agenda + le compteur. */
  protected onAgentProposalsChanged(): void {
    this.onReservationChanged();
    void this.loadAgentProposals();
  }

  /** Clic « Voir » sur une pastille IA PRÊTE : la vue Assistant IA porte les résultats (elle relit l'analyse conservée). */
  protected onAiJobView(job: AiJob): void {
    this.aiJob.dismiss(job.id);
    if (job.kind === 'agent-run') void this.loadAgentProposals();
    this.vue.set('ia');
  }

  /**
   * Compteur de demandes de réservation en attente — appel DÉDIÉ, pas un filtre sur le mois.
   *
   * Gardé par `reservations_manage` : c'est la permission qu'exige l'endpoint, et c'est aussi
   * celle qui commande le bouton. Demander ce compte sans le droit ne produirait qu'un 403 et
   * une notification rouge sur un écran qui, lui, fonctionne.
   */
  protected async loadPendingRequests(): Promise<void> {
    if (!this.canValidate()) { this.pendingCount.set(0); return; }
    try {
      const list = await firstValueFrom(
        this.api.listReservations({ status: 'REQUESTED', fleetId: this.currentFleetId() }),
      );
      this.pendingCount.set(list.length);
    } catch (err) {
      swallow('agenda:loadPendingRequests', err);
      this.pendingCount.set(0);
    }
  }

  /** Compteur de propositions en attente (pour la société active). Silencieux si non éligible. */
  protected async loadAgentProposals(): Promise<void> {
    if (!this.canOptimize()) { this.agentProposals.set([]); return; }
    try {
      this.agentProposals.set(await firstValueFrom(this.agentApi.listProposals(this.currentFleetId())));
    } catch (err) {
      swallow('agenda:loadAgentProposals', err);
      this.agentProposals.set([]);
    }
  }

  /**
   * Valider une proposition DEPUIS LE PANNEAU JOUR — elle devient une vraie réservation.
   *
   * Le même geste existe dans la feuille « Propositions de l'agent ». L'avoir ici aussi est le
   * point du lot 3a : la décision se prend là où l'on regarde la journée, pas dans un écran à
   * part qu'il faut penser à ouvrir.
   */
  protected async applyProposal(p: AgendaAgentProposalDto): Promise<void> {
    this.busyId.set(p.id);
    try {
      await firstValueFrom(this.agentApi.applyProposal(p.id));
      this.toast.success('Réservation créée', `${p.vehiclePlate ?? ''} · ${this.hm(p.startAt)}`);
      // La proposition devient un ÉVÉNEMENT : les deux couches doivent bouger ensemble, sinon la
      // pastille fantôme et la pilule pleine coexistent le temps d'un rechargement.
      void this.loadAgentProposals();
      this.onReservationChanged();
    } catch (err) {
      swallow('agenda:applyProposal', err);
      this.toast.error('Échec', apiErrorMessage(err, 'La proposition n’a pas pu être réservée.'));
    } finally {
      this.busyId.set(null);
    }
  }

  /** Écarter une proposition : elle disparaît de la grille et ne sera pas re-proposée. */
  protected async dismissProposal(p: AgendaAgentProposalDto): Promise<void> {
    this.busyId.set(p.id);
    try {
      await firstValueFrom(this.agentApi.dismissProposal(p.id));
      this.agentProposals.update((l) => l.filter((x) => x.id !== p.id));
    } catch (err) {
      swallow('agenda:dismissProposal', err);
      this.toast.error('Échec', apiErrorMessage(err, 'La proposition n’a pas pu être écartée.'));
    } finally {
      this.busyId.set(null);
    }
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
    // Le badge suit la file : valider ou refuser une demande doit le faire tomber tout de suite.
    void this.loadPendingRequests();
  }
}
