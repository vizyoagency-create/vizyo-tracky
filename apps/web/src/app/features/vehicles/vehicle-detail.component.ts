import { swallow } from '../../core/error/swallow';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule, ArrowLeft, Wifi, WifiOff, Gauge, MapPin, Radio,
  AlertTriangle, AlertCircle, Info, Check, Power, Route, BarChart3, BellOff, Map,
  History, Bell, Zap, Clock, ShieldAlert, ShieldCheck, MessageSquare, Pencil, X,
  UserRound, UserPlus, Copy, Play, Layers, Wrench, QrCode, SatelliteDish, ParkingSquare,
  // Espace dépôt (2026-08) — « un tiers regarde ce camion » sur le bandeau de mission.
  Eye,
} from 'lucide-angular';

/** Espace dépôt (2026-08) — la mission en cours affichée en bandeau (A2 § 9). */
interface MissionEnCours {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  status: 'IN_PROGRESS' | 'LATE';
  depotName: string | null;
  depotWatching: boolean;
}
import type { AlertEvent, DriverDto, TripDto } from '@vizyo/tracky-shared';
import { isAcceptableLiveFix } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AlertsApiService } from '../../core/services/alerts.service';
import { AuthService } from '../../core/services/auth.service';
import { EngineControlService, type EngineControlCommandDto } from '../../core/services/engine-control.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PositionsApiService, type PositionDto } from '../../core/services/positions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { DriversApiService } from '../../core/services/drivers.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { TrackersApiService } from '../../core/services/trackers.service';
import { TripsApiService } from '../../core/services/trips.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { VehicleGroupsService, type VehicleGroup } from '../../core/services/vehicle-groups.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { DriverPickerComponent } from '../../shared/ui/driver-picker/driver-picker.component';
import { DriverDrawerComponent, type DriverDrawerData, type DriverDrawerResult } from '../drivers/driver-drawer.component';
import { MiniMapComponent } from '../../shared/ui/mini-map/mini-map.component';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';
import { AudioListenButtonComponent } from '../audio-monitoring/audio-listen-button.component';
import { SurveillancePanelComponent } from '../surveillance/surveillance-panel.component';
import { TripReplayComponent } from '../reports/trip-replay.component';
import { VehicleScheduleComponent } from './vehicle-schedule/vehicle-schedule.component';
import { VehicleReportsTabComponent } from './vehicle-reports-tab.component';
import { VehicleMaintenanceTabComponent } from './vehicle-maintenance-tab.component';
import { AgendaApiService } from '../../core/services/agenda.service';
import type { VehicleEventSeverity } from '@vizyo/tracky-shared';
import { relativeTime } from '../../shared/utils/relative-time';
import {
  formatSilenceLabel,
  getVehicleConnectivityState,
  getVehiclePresenceState,
  overlayPresumedParked,
  isInstallationToReview,
  isVehicleDormant,
  type VehicleConnectivityState,
  type VehiclePresenceState,
  type GeofenceDto,
} from '@vizyo/tracky-shared';
import { GeofencesApiService } from '../../core/services/geofences.service';
import {
  GpsDeadZonesApiService,
  type GpsDeadZoneDto,
  type GpsDeadZoneStatus,
  type GpsDeadZoneLabel,
} from '../../core/services/gps-dead-zones.service';
import {
  matchDeadZone,
  deadZoneDureeTypiqueLabel,
  deadZoneEstSilencieuse,
  deadZoneNatureLabel,
  deadZonePeriodeLabel,
  deadZoneStatusLabel,
} from '../../shared/utils/gps-dead-zone';
import { connectivityMeta } from '../../shared/ui/connectivity-badge/connectivity-badge.component';
import { InstallReviewBadgeComponent } from '../../shared/ui/install-review-badge/install-review-badge.component';
import { BrandLogoComponent } from '../../shared/ui/brand-logo/brand-logo.component';
import { SpinnerComponent } from '../../shared/ui/spinner/spinner.component';
import { rangerEnFamilles } from './onglets-familles';
import { VehicleQrDialogComponent } from './vehicle-qr-dialog.component';

@Component({
  selector: 'app-vehicle-detail',
  standalone: true,
  imports: [
    FormsModule, RouterLink, LucideAngularModule, DatePipe, DecimalPipe, GroupBadgeComponent,
    MiniMapComponent, EngineControlButtonComponent, AudioListenButtonComponent,
    VehicleScheduleComponent, VehicleReportsTabComponent, VehicleMaintenanceTabComponent, DriverPickerComponent, DriverDrawerComponent, SurveillancePanelComponent, TripReplayComponent,
    InstallReviewBadgeComponent, BrandLogoComponent, SpinnerComponent, VehicleQrDialogComponent,
  ],
  template: `
    @if (loading()) {
      <div class="flex items-center justify-center h-64">
        <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
      </div>
    } @else if (vehicle(); as v) {
      <div class="vdx-wrap">
        @if (missionEnCours(); as m) {
          <!-- Espace dépôt (2026-08) — bandeau « en mission » (A2 § 9).
               Placé TOUT EN HAUT, avant le hero : un gestionnaire qui ouvre cette
               fiche pour couper le moteur ou changer un horaire doit savoir qu'un
               tiers regarde ce camion EN CE MOMENT. Le mettre plus bas reviendrait
               à le lui apprendre après coup. -->
          <div class="vdx-mission" [class.vdx-mission--retard]="m.status === 'LATE'">
            <span class="vdx-mission-ico"><lucide-icon [img]="Route" [size]="17" /></span>
            <div class="vdx-mission-txt">
              <p class="vdx-mission-l1">
                <strong>{{ m.status === 'LATE' ? 'En mission — en retard' : 'En mission' }}</strong>
                <span class="vdx-mission-ref">{{ m.ref }}</span>
              </p>
              <p class="vdx-mission-l2">
                {{ m.origin }} → {{ m.destination }} · {{ heureMission(m.startAt) }} → {{ heureMission(m.endAt) }}
              </p>
              @if (m.depotWatching) {
                <p class="vdx-mission-depot">
                  <lucide-icon [img]="Eye" [size]="13" />
                  {{ m.depotName }} suit la position de ce véhicule jusqu'à {{ heureMission(m.endAt) }}.
                </p>
              }
            </div>
          </div>
        }
        <!-- Hero (maquette 06) : nom du véhicule + pastille de statut, plaque/couleur/groupe en sous-ligne -->
        <div class="vdx-hero">
          <div class="vdx-hero-main">
            <button type="button" (click)="goBack()" aria-label="Retour" class="vdx-back">
              <lucide-icon [img]="ArrowLeft" [size]="18"></lucide-icon>
            </button>
            <app-brand-logo [brand]="v.brand" [size]="48" [chip]="true" />
            <div class="vdx-hero-txt">
              <div class="vdx-hero-titlerow">
                <h1 class="vdx-hero-name">@if (v.brand || v.model) { {{ v.brand }} {{ v.model }} } @else { {{ v.plate }} }</h1>
                <span class="vt-status" [class.vt-status--on]="connectivity() === 'ONLINE'" [class.vt-status--offline]="connectivity() !== 'ONLINE'">
                  <span class="vt-status__dot"></span>{{ heroStatusLabel() }}
                </span>
              </div>
              <div class="vdx-hero-sub">
                <span class="vdx-hero-plate font-mono">{{ v.plate }}</span>
                @if (v.year) { <span class="vdx-dot">·</span><span>{{ v.year }}</span> }
                @if (v.color) { <span class="vdx-dot">·</span><span>{{ v.color }}</span> }
                <span class="vdx-dot">·</span>
                <span class="vdx-hero-group">
                  <app-group-badge [group]="v.group" [showEmpty]="true" />
                  @if (canManageGroups()) {
                    <button type="button" (click)="openGroupPicker()" class="vdx-link">{{ v.group ? 'Changer' : 'Assigner' }}</button>
                  }
                </span>
                @if (installToReview()) { <app-install-review-badge /> }
              </div>
            </div>
          </div>

          <div class="vdx-hero-actions">
            @if (v.tracker) {
              @if (currentPosition(); as pos) {
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
              <!-- Sprint 4 — Écoute audio (micro embarqué) : gaté audio_monitoring + activation flotte.
                   Scénario A : arme le micro et renvoie le n° SIM à appeler (aucun audio joué dans l'app). -->
              <app-audio-listen-button
                [trackerId]="v.tracker.id"
                [vehicleId]="v.id"
                [vehiclePlate]="v.plate"
                [fleetId]="v.fleetId"
              />
            }
            <!-- Sprint 7 — Signaler un incident (gaté agenda_view) : POST /api/agenda/incidents. -->
            @if (canReportIncident()) {
              <button type="button" (click)="openIncident()" class="vd-incident-btn" title="Signaler un incident sur ce véhicule">
                <lucide-icon [img]="AlertTriangle" [size]="14"></lucide-icon>
                <span>Incident</span>
              </button>
            }
            @if (canManageQr()) {
              <button type="button" (click)="qrOpen.set(true)" class="vd-incident-btn" title="QR de déverrouillage du véhicule">
                <lucide-icon [img]="QrCode" [size]="14"></lucide-icon>
                <span>QR</span>
              </button>
            }
          </div>
        </div>

        @if (qrOpen()) {
          <app-vehicle-qr-dialog [vehicleId]="v.id" [plate]="v.plate" (closed)="qrOpen.set(false)" />
        }

        <!-- Sprint 1 — Sélecteur de groupe (assignation depuis le détail) -->
        @if (groupPickerOpen()) {
          <div class="fixed inset-0 z-[9000] flex items-center justify-center p-4">
            <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="groupPickerOpen.set(false)"></div>
            <div class="relative w-full max-w-sm bg-bg-primary border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80dvh]">
              <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
                <div class="flex items-center gap-2">
                  <lucide-icon [img]="LayersIcon" [size]="16" class="text-fg-tertiary"></lucide-icon>
                  <h3 class="text-sm font-bold text-fg-primary">Groupe du véhicule</h3>
                </div>
                <button (click)="groupPickerOpen.set(false)" aria-label="Fermer"
                        class="p-1 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary cursor-pointer">
                  <lucide-icon [img]="XIcon" [size]="16"></lucide-icon>
                </button>
              </div>
              @if (groups().length > 6) {
                <div class="px-3 pt-3">
                  <input type="text" [ngModel]="groupSearch()" (ngModelChange)="groupSearch.set($event)"
                         placeholder="Rechercher un groupe..."
                         class="w-full px-3 py-2 rounded-xl bg-bg-secondary border border-border-subtle text-fg-primary text-sm placeholder:text-fg-tertiary focus:outline-none focus:border-[var(--tracky)]" />
                </div>
              }
              <div class="flex-1 overflow-y-auto p-2">
                <button type="button" (click)="setGroup(null)" [disabled]="groupSaving()"
                        class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left text-sm hover:bg-bg-tertiary cursor-pointer disabled:opacity-50"
                        [class.bg-bg-tertiary]="!vehicle()?.group">
                  <span class="flex-1 text-fg-tertiary italic">Aucun (retirer du groupe)</span>
                  @if (!vehicle()?.group) { <lucide-icon [img]="Check" [size]="15" class="text-tracky-light"></lucide-icon> }
                </button>
                @for (g of filteredGroups(); track g.id) {
                  <button type="button" (click)="setGroup(g.id)" [disabled]="groupSaving()"
                          class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left text-sm hover:bg-bg-tertiary cursor-pointer disabled:opacity-50"
                          [class.bg-bg-tertiary]="vehicle()?.group?.id === g.id">
                    <lucide-icon [img]="LayersIcon" [size]="14" class="text-fg-tertiary shrink-0"></lucide-icon>
                    <span class="flex-1 text-fg-primary truncate">{{ g.name }}</span>
                    <span class="text-[10px] text-fg-tertiary tabular-nums">{{ g._count.vehicles }}</span>
                    @if (vehicle()?.group?.id === g.id) { <lucide-icon [img]="Check" [size]="15" class="text-tracky-light"></lucide-icon> }
                  </button>
                }
                @if (groupsLoading()) {
                  <div class="flex justify-center py-6"><span class="w-5 h-5 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span></div>
                } @else if (groups().length === 0) {
                  <p class="px-3 py-6 text-center text-xs text-fg-tertiary">Aucun groupe dans cette flotte.<br/>Crée-en depuis Véhicules › Groupes.</p>
                } @else if (filteredGroups().length === 0) {
                  <p class="px-3 py-6 text-center text-xs text-fg-tertiary">Aucun groupe ne correspond.</p>
                }
              </div>
            </div>
          </div>
        }

        <!-- Cartes stat (maquette 06) : Vitesse · Position · Dernière comm. · Boîtier/SIM
             DORMANCE — ces trois cartes lisent la DERNIÈRE trame reçue. Pour un véhicule muet
             depuis 89 jours (prod : FV-941-LZ), elles affichaient « 0 km/h » et une adresse
             comme si c'était l'instant présent. On ne retire RIEN (la dernière position connue
             est justement ce qu'on cherche quand un boîtier a disparu) : on DATE. -->
        <div class="vdx-stats">
          <div class="vdx-stat" [class.vdx-stat--stale]="isDormant()">
            <div class="vdx-stat-k">Vitesse</div>
            <div class="vdx-stat-v">
              @if (isDormant()) {
                <!-- La vitesse d'un dormant est un souvenir de plusieurs semaines : affichée en
                     petit et déclassée, jamais en gros chiffre « live ». -->
                @if (currentPosition(); as pos) {
                  <span class="vdx-stat-v--sm vdx-stale-v">{{ pos.speedKmh | number:'1.0-0' }} <span class="vdx-stat-u">km/h</span></span>
                } @else { — }
              } @else if (presence() === 'PRESUMED_PARKED') {
                <!-- TRK-046 — considéré stationné (parking validé) : la vitesse d'entrée est un
                     vestige (27 km/h figés sur FZ-862-VY), on affiche l'état réel, calmement. -->
                <span class="vdx-stat-v--sm" style="color:var(--texte-inactif);font-weight:700">À l'arrêt</span>
              } @else if (connectivity() === 'GPS_LOST') {
                <!-- Incident FS-253 — GPS perdu : la vitesse est FIGÉE, on ne l'affiche PAS comme du live. -->
                <span class="vdx-stat-v--sm" style="color:var(--texte-alerte);font-weight:700">GPS perdu</span>
              } @else if (currentPosition(); as pos) {
                {{ pos.speedKmh | number:'1.0-0' }} <span class="vdx-stat-u">km/h</span>
              } @else { — }
            </div>
            @if (isDormant()) { <div class="vdx-stat-stale">{{ staleValueNote() }}</div> }
          </div>

          <div class="vdx-stat vdx-stat--link" [class.vdx-stat--stale]="isDormant()" role="button" tabindex="0" (click)="activeTab.set('map')" (keydown.enter)="activeTab.set('map')">
            <div class="vdx-stat-k">Position</div>
            @if (currentPosition(); as pos) {
              <!-- Le lien vers la carte reste actif même dormant : savoir OÙ il a été vu la
                   dernière fois est l'information la plus utile pour aller le récupérer. -->
              <div class="vdx-stat-v vdx-stat-v--sm">{{ isDormant() ? 'Dernière position connue' : 'Voir sur la carte' }}</div>
              <div class="vdx-stat-coord">{{ pos.lat | number:'1.4-4' }}, {{ pos.lng | number:'1.4-4' }}</div>
              @if (isDormant()) { <div class="vdx-stat-stale">{{ staleValueNote() }}</div> }
            } @else {
              <div class="vdx-stat-v vdx-stat-v--sm">Inconnue</div>
            }
          </div>

          <div class="vdx-stat" [class.vdx-stat--stale]="isDormant()">
            <div class="vdx-stat-k">Dernière comm.</div>
            <!-- Incident FS-253 — « Dernière comm. » = dernier SIGNAL du boîtier (lastSeenAt), pas le
                 dernier fix GPS : un boîtier GPS-perdu communique toujours (réseau OK). -->
            <div class="vdx-stat-v vdx-stat-v--sm">@if (v.tracker?.lastSeenAt; as ls) { {{ relativeTime(ls) }} } @else { Jamais }</div>
            <div class="vdx-stat-live" [class.vdx-stat-live--on]="connectivity() === 'ONLINE'"
                 [class.vdx-stat-live--dormant]="isDormant()">
              <span class="vdx-live-dot"></span>{{ connectivity() === 'ONLINE' ? 'temps réel' : connMeta().label }}
            </div>
            @if (isDormant()) {
              <!-- Coupe court à « comment je le réactive ? » : il n'y a rien à réactiver. -->
              <div class="vdx-stat-stale">Redevient normal seul dès la première trame reçue</div>
            }
          </div>

          <div class="vdx-stat">
            <div class="vdx-stat-k">Boîtier · SIM</div>
            @if (v.tracker; as tr) {
              <button type="button" class="vdx-imei" (click)="copyImei(tr.imei)"
                      [attr.aria-label]="'Copier l\\'IMEI ' + tr.imei" title="Cliquer pour copier l'IMEI complet">
                {{ tr.imei.slice(0,4) }}…{{ tr.imei.slice(-4) }}
                @if (imeiCopied()) {
                  <lucide-icon [img]="CheckIcon" [size]="12" class="vd-stat-copy-ok"></lucide-icon>
                } @else {
                  <lucide-icon [img]="CopyIcon" [size]="12" class="vd-stat-copy-icon"></lucide-icon>
                }
              </button>
              <div class="vdx-stat-tags">
                @if (instBadge(); as b) { <span class="vd-inst" [class]="'vd-inst--' + b.cls">{{ b.label }}</span> }
                @if (tr.simPhoneNumber) { <span class="vd-sim">SIM {{ tr.simPhoneNumber }}</span> }
                @if (canEditVehicle()) {
                  <button type="button" class="vd-tracker-detach" (click)="detachTracker(tr.id)" title="Detacher le tracker">
                    <lucide-icon [img]="XIcon" [size]="12"></lucide-icon>
                  </button>
                }
              </div>
            } @else {
              @if (canEditVehicle()) {
                <button type="button" class="vd-tracker-assign-btn" (click)="showTrackerPicker.set(true)" style="margin-top:8px">Assigner un tracker</button>
              } @else {
                <div class="vdx-stat-v vdx-stat-v--sm">—</div>
              }
            }
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
                <app-spinner [size]="12" />
              } @else if (v.currentDriver) {
                <lucide-icon [img]="PencilIcon" [size]="12"></lucide-icon>
              } @else {
                <lucide-icon [img]="UserPlusIcon" [size]="12"></lucide-icon>
              }
              {{ v.currentDriver ? 'Changer' : 'Assigner' }}
            </button>
          }
        </div>

        <!-- Réglage matériel ACC (SUPER_ADMIN) — carte matériel, placée sous le conducteur (maquette) -->
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
                <app-spinner [size]="14" />
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

        <!--
          Cas special (SUPER_ADMIN) : vehicule accidente, boitier debranche, immobilise.
          Tant que l'etat est pose, les traitements de fond et les detecteurs d'alerte
          cessent de travailler sur ce vehicule. Aucune donnee n'est touchee.
        -->
        @if (isSuperAdmin()) {
          <div class="vd-admin-card" [class.vd-admin-card--warning]="!!v.outOfServiceReason">
            <div class="vd-admin-card-header">
              @if (v.outOfServiceReason) {
                <lucide-icon [img]="ShieldAlert" [size]="14"></lucide-icon>
              } @else {
                <lucide-icon [img]="ShieldCheck" [size]="14"></lucide-icon>
              }
              <span>Cas spécial &middot; super-admin</span>
            </div>

            <label class="vd-hs-field">
              <span class="vd-hs-label">État d'exploitation</span>
              <select
                class="vd-hs-select"
                [disabled]="hsUpdating()"
                [value]="v.outOfServiceReason ?? ''"
                (change)="changerEtatExploitation(v.id, $event)"
                aria-label="État d'exploitation du véhicule"
              >
                <option value="">En service</option>
                <option value="ACCIDENT">Accidenté</option>
                <option value="TRACKER_UNPLUGGED">Boîtier débranché</option>
                <option value="IMMOBILIZED">Immobilisé</option>
              </select>
              @if (hsUpdating()) {
                <app-spinner [size]="14" />
              }
            </label>

            @if (v.outOfServiceReason) {
              <div class="vd-admin-warning">
                <lucide-icon [img]="AlertTriangle" [size]="12"></lucide-icon>
                <span>
                  Hors service depuis {{ dateHorsService(v.outOfServiceSince) }} &mdash; analyse
                  des trajets et alertes suspendues pour ce véhicule. Aucune donnée supprimée.
                </span>
              </div>
              @if (v.outOfServiceNote) {
                <p class="vd-hs-note">{{ v.outOfServiceNote }}</p>
              }
            } @else {
              <p class="vd-hs-aide">
                À cocher quand un véhicule ne roule plus : il sort du périmètre des traitements
                et cesse de produire des alertes qui n'appellent aucune action.
              </p>
            }
          </div>
        }

        <!-- Zones mortes GPS (suivi FS-253) — endroits où ce véhicule perd récurremment le GPS. -->
        @if (deadZones().length) {
          <div class="vd-dz-card">
            <div class="vd-admin-card-header vd-dz-header">
              <lucide-icon [img]="SatelliteDish" [size]="14"></lucide-icon>
              <span>Zones mortes GPS</span>
              <span class="vd-dz-count">{{ deadZones().length }}</span>
            </div>

            @if (currentDeadZone(); as cz) {
              <div class="vd-dz-now">
                <lucide-icon [img]="ParkingSquare" [size]="16"></lucide-icon>
                @if (cz.status === 'CONFIRMED_BENIGN') {
                  <!-- ⚠️ DIRE QUE LE SIGNAL REVIENT, pas seulement que ce n'est pas une
                       panne. « Ce n'est pas une panne » rassure sur la cause ; il reste
                       à dire ce qui va se passer. Sans cette phrase, l'exploitant voit
                       un véhicule figé sur la carte et rappelle le conducteur — le coup
                       de fil que cet écran existe pour éviter. -->
                  <span>
                    Actuellement <strong>à l'arrêt en parking souterrain</strong>@if (cz.placeLabel) { ({{ cz.placeLabel }})}.
                    Perte de GPS normale ici — ce n'est pas une panne : le boîtier est joignable,
                    c'est le ciel qui manque. <strong>La position réapparaîtra d'elle-même à la sortie</strong>,
                    sans aucune manipulation.
                  </span>
                } @else {
                  <div class="vd-dz-now-ask">
                    <span>
                      Ce véhicule perd le GPS <strong>ici même</strong>@if (cz.placeLabel) { ({{ cz.placeLabel }})}, déjà {{ cz.occurrences }} fois.
                      Si c'est un <strong>parking souterrain ou couvert</strong>, la position
                      reviendra à la sortie et il n'y a rien à faire.
                    </span>
                    @if (canEditVehicle()) {
                      <div class="vd-dz-actions">
                        <button type="button" class="vd-dz-btn vd-dz-btn--ok" [disabled]="deadZoneSaving() === cz.id" (click)="confirmDeadZone(cz)">Oui, c'est un parking</button>
                        <button type="button" class="vd-dz-btn vd-dz-btn--warn" [disabled]="deadZoneSaving() === cz.id" (click)="markDeadZoneSuspect(cz)">Non, à surveiller</button>
                      </div>
                    }
                  </div>
                }
              </div>
            }

            <!-- ⚠️ CE TEXTE PROMETTAIT UNE CONFIRMATION MANUELLE QUI N'EST PLUS REQUISE.
                 TRK-026 (2026-08-17) qualifie la zone en parking dès la DEUXIÈME perte au
                 même endroit et la rend silencieuse. L'ancienne phrase — « confirmez pour
                 ne plus recevoir d'alerte » — décrivait donc un geste devenu inutile, et
                 laissait croire que les alertes continuaient tant qu'on n'avait rien fait.
                 Un écran qui décrit une règle périmée est pire qu'un écran muet : on agit
                 dessus. -->
            <p class="vd-dz-intro">
              Endroits où ce véhicule reperd régulièrement le GPS : parking souterrain, tunnel,
              rue couverte… ou brouilleur. <strong>Dès la deuxième perte au même endroit</strong>,
              le lieu est reconnu comme parking et les alertes « GPS perdu » s'y arrêtent —
              le véhicule réapparaît de lui-même en sortant. Marquez « suspect » si vous
              pensez qu'il ne s'agit pas d'un parking.
            </p>

            <ul class="vd-dz-list">
              @for (z of deadZones(); track z.id) {
                <li
                  class="vd-dz-item"
                  [class.vd-dz-item--benign]="z.status === 'CONFIRMED_BENIGN'"
                  [class.vd-dz-item--suspect]="z.status === 'SUSPECT'"
                >
                  <div class="vd-dz-item-main">
                    <div class="vd-dz-item-title">
                      <strong>{{ z.placeLabel || ((z.centroidLat | number: '1.4-4') + ', ' + (z.centroidLng | number: '1.4-4')) }}</strong>
                      <span class="vd-dz-badge" [attr.data-s]="z.status">{{ dzStatusLabel(z.status) }}</span>
                    </div>
                    <!-- ⚠️ « 9 fois » NE VEUT RIEN DIRE SANS SA PÉRIODE. Neuf pertes en un
                         mois décrivent une habitude ; neuf en un an décrivent un hasard. Le
                         compteur seul laissait l'exploitant sans échelle, et c'est de cette
                         échelle qu'il a besoin pour juger si le lieu est vraiment un
                         passage régulier. -->
                    <div class="vd-dz-item-meta">
                      <span>{{ z.occurrences }} passage{{ z.occurrences > 1 ? 's' : '' }} sans GPS</span>
                      <span aria-hidden="true">·</span>
                      <span>{{ dzNatureLabel(z) }}</span>
                      <span aria-hidden="true">·</span>
                      <span>{{ dzPeriode(z) }}</span>
                    </div>
                    <!-- ⚠️ ON NE PROMET LE SILENCE QUE LÀ OÙ IL EST INCONDITIONNEL.
                         Une zone « normale » qui n'est pas un parking reste soumise au
                         plafond de silence côté serveur : l'alerte y revient au-delà.
                         Promettre « aucune alerte » sur celles-là se retournerait le jour
                         où l'alerte tombe — au pire moment. -->
                    @if (dzSilencieuse(z)) {
                      <!-- TRK-028 — la preuve derrière la promesse. Tant qu'aucun épisode
                           n'a été vu se refermer, on n'annonce aucune durée : la phrase
                           reste vraie, elle est seulement moins précise. -->
                      <div class="vd-dz-rassure">
                        Aucune alerte ici : le véhicule réapparaît en sortant@if (dzDuree(z); as d) {,
                        <strong>{{ d }}</strong> d'après les passages précédents}.
                      </div>
                    } @else if (z.status === 'CONFIRMED_BENIGN') {
                      <div class="vd-dz-rassure">
                        Marquée normale. Une absence anormalement longue restera signalée.
                      </div>
                    }
                    @if (z.note) { <div class="vd-dz-note">{{ z.note }}</div> }
                  </div>
                  @if (canEditVehicle()) {
                    <div class="vd-dz-actions">
                      @if (z.status !== 'CONFIRMED_BENIGN') {
                        <button
                          type="button"
                          class="vd-dz-btn vd-dz-btn--ok"
                          [disabled]="deadZoneSaving() === z.id"
                          (click)="confirmDeadZone(z)"
                        >C'est normal (parking)</button>
                      } @else {
                        <button
                          type="button"
                          class="vd-dz-btn"
                          [disabled]="deadZoneSaving() === z.id"
                          (click)="reactivateDeadZone(z)"
                        >Réactiver les alertes</button>
                      }
                      @if (z.status !== 'SUSPECT') {
                        <button
                          type="button"
                          class="vd-dz-btn vd-dz-btn--warn"
                          [disabled]="deadZoneSaving() === z.id"
                          (click)="markDeadZoneSuspect(z)"
                        >Suspect</button>
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          </div>
        }

        <!-- ONGLETS EN DEUX NIVEAUX (B1 § C) — dix onglets alignés dans une rangée qui
             défile obligent à chercher : on ne voit jamais l'ensemble, et « Géofences »
             se trouve après « Maintenance » sans qu'aucune logique ne le dise. Quatre
             familles rendent la carte lisible d'un coup d'œil. RIEN N'EST SUPPRIMÉ :
             chaque onglet reste accessible, il est seulement rangé.

             Sous trois onglets visibles — le veilleur de nuit n'en voit que deux — le
             niveau des familles disparaît : deux boîtes pour deux onglets sont un
             classement qui ne classe rien. -->
        @if (famillesVisibles().length > 1) {
          <div class="vdx-familles" role="tablist" aria-label="Familles d'onglets">
            @for (f of famillesVisibles(); track f.cle) {
              <button
                type="button"
                role="tab"
                class="vdx-famille"
                [class.vdx-famille--active]="familleActive() === f.cle"
                [attr.aria-selected]="familleActive() === f.cle"
                (click)="ouvrirFamille(f)">
                {{ f.libelle }}
                @if (f.badge > 0) { <span class="vdx-tab-badge">{{ f.badge }}</span> }
              </button>
            }
          </div>
        }

        <div class="vdx-tabs">
          @for (tab of ongletsDeLaFamille(); track tab.key) {
            <button (click)="activeTab.set(tab.key)" class="vdx-tab" [class.vdx-tab--active]="activeTab() === tab.key">
              <lucide-icon [img]="tab.icon" [size]="15"></lucide-icon>
              <span class="vdx-tab-label">{{ tab.label }}</span>
              @if (tab.key === 'alerts' && alerts().length > 0) { <span class="vdx-tab-badge">{{ alerts().length }}</span> }
            </button>
          }
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
              [interactive]="!isWatchman()"
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
        @if (activeTab() === 'history') {
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
              <app-spinner [size]="14" label="Chargement" style="margin-left:auto" />
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
                    <div class="w-8 h-8 rounded-full bg-fg-tertiary/15 flex items-center justify-center shrink-0">
                      <lucide-icon [img]="InfoIcon" [size]="16" class="text-fg-secondary"></lucide-icon>
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

        <!-- 2026-08-24 — le bloc « Commandes » a été retiré avec son onglet : la console
             d'envoi vit uniquement sur /admin/trackers/:id. Voir le commentaire de tabs()
             dans la classe. (Aucun backtick ici : on est dans un template literal.) -->


        @if (activeTab() === 'surveillance') {
          @if (v.tracker) {
            <app-surveillance-panel [vehicleId]="v.id" />
          } @else {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="ShieldAlert" [size]="48" class="opacity-30"></lucide-icon>
              <p>Aucun tracker associé — la surveillance nécessite un Coban actif.</p>
            </div>
          }
        }

        @if (activeTab() === 'schedule') {
          <a routerLink="/fleet-schedules"
             class="inline-flex items-center gap-1.5 text-sm font-semibold text-tracky hover:underline mb-3">
            <lucide-icon [img]="ArrowLeft" [size]="15" />
            Voir &amp; gérer les horaires de toute la flotte
          </a>
          <app-vehicle-schedule
            [vehicleId]="v.id"
            [hasTracker]="!!v.tracker"
            [reloadTrigger]="scheduleRevision()"
          />
        }

        @if (activeTab() === 'reports') {
          <app-vehicle-reports-tab
            [vehicleId]="v.id"
            [vehiclePlate]="v.plate"
            [vehicleType]="v.type"
            [fleetId]="v.fleetId"
            [openTripId]="openTripId()"
            [openTripDate]="openTripDate()"
            [openAlertId]="openAlertId()"
          />
        }

        @if (activeTab() === 'maintenance') {
          <app-vehicle-maintenance-tab [vehicleId]="v.id" />
        }

        @if (activeTab() === 'geofences') {
          @if (vehicleGeofences().length === 0) {
            <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                        bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
              <lucide-icon [img]="MapPin" [size]="48" class="opacity-30"></lucide-icon>
              <p>Ce véhicule n'est ciblé par aucune géofence.</p>
            </div>
          } @else {
            <div class="flex flex-col gap-2">
              @for (gf of vehicleGeofences(); track gf.id) {
                <div class="flex items-center gap-3 px-4 py-3 rounded-[--radius-card]
                            bg-bg-secondary border border-border-subtle">
                  <span class="w-3 h-3 rounded-full shrink-0" [style.background]="gf.color || '#10E0A0'"></span>
                  <span class="text-sm font-semibold text-fg-primary flex-1 min-w-0 truncate">{{ gf.name }}</span>
                  <span class="text-[11px] text-fg-tertiary">{{ gf.rule === 'ENTER' ? 'Entrée' : gf.rule === 'EXIT' ? 'Sortie' : 'Entrée/Sortie' }}</span>
                  @if (!gf.targetVehicles?.length) {
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-bg-tertiary text-fg-secondary">Globale</span>
                  }
                </div>
              }
            </div>
          }
        }
      </div>

      <!-- Tracker picker modal -->
      @if (showTrackerPicker()) {
        <div class="fixed inset-0 z-[8000] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/50" (click)="showTrackerPicker.set(false)"></div>
          <div class="relative bg-bg-secondary border border-border-subtle rounded-2xl w-full max-w-md p-5 shadow-xl">
            <h3 class="text-base font-bold text-fg-primary mb-1">Assigner un tracker</h3>
            <p class="text-xs text-fg-tertiary mb-4">Trackers orphelins disponibles :</p>
            <!-- Ajouter un nouveau tracker manuellement -->
            <div class="flex gap-2 mb-3">
              <input type="text" [(ngModel)]="newTrackerImei" placeholder="IMEI (15 chiffres)"
                class="flex-1 px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm font-mono
                       placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
              <button (click)="createAndAssignTracker()" [disabled]="!newTrackerImei || newTrackerImei.length < 15"
                class="px-4 py-2 rounded-xl bg-tracky text-bg-primary text-sm font-semibold
                       hover:bg-tracky-dark disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors">
                Ajouter
              </button>
            </div>

            @if (orphanTrackers().length === 0) {
              <p class="text-xs text-fg-tertiary text-center py-3">Aucun tracker orphelin — saisissez l'IMEI ci-dessus pour en créer un.</p>
            } @else {
              <p class="text-xs text-fg-tertiary mb-2">Ou assigner un tracker existant :</p>
              <div class="flex flex-col gap-2 max-h-60 overflow-y-auto">
                @for (t of orphanTrackers(); track t.id) {
                  <button (click)="assignTracker(t.id)"
                    class="flex items-center justify-between px-3 py-2.5 rounded-xl bg-bg-tertiary border border-border-subtle
                           text-sm hover:border-tracky hover:bg-tracky/5 cursor-pointer transition-all">
                    <div>
                      <span class="font-mono text-fg-primary">{{ t.imei }}</span>
                      <span class="text-xs text-fg-tertiary ml-2">{{ t.model || 'GPS403D' }}</span>
                    </div>
                    <span class="text-xs text-fg-tertiary">{{ t.status }}</span>
                  </button>
                }
              </div>
            }
            <button (click)="showTrackerPicker.set(false)"
              class="mt-4 w-full py-2 text-sm text-fg-secondary bg-bg-tertiary border border-border-subtle rounded-xl hover:text-fg-primary cursor-pointer">
              Fermer
            </button>
          </div>
        </div>
      }

      <!-- Trip Replay modal -->
      <app-trip-replay
        [open]="tripReplayOpen()"
        [trip]="tripReplayTrip()"
        [canEditNote]="canEditNotes()"
        (closed)="tripReplayOpen.set(false)"
        (editNote)="startEditNote($event)"
      />

      <!-- Picker conducteur pour un trajet -->
      <app-driver-picker
        [open]="tripDriverPickerOpen()"
        [currentDriverId]="tripDriverPickerTrip()?.driver?.id ?? null"
        [title]="'Conducteur du trajet'"
        subtitle="Assigner manuellement un conducteur a ce trajet."
        (closed)="tripDriverPickerOpen.set(false)"
        (selected)="onTripDriverPicked($event)"
      />

      <!-- Picker conducteur du vehicule (modal centre, fetch les drivers a l'ouverture). -->
      @if (vehicle(); as v) {
        <app-driver-picker
          [open]="driverPickerOpen()"
          [currentDriverId]="v.currentDriver?.id ?? null"
          [title]="'Conducteur du vehicule ' + v.plate"
          subtitle="Le conducteur courant sera snape par defaut sur les prochains trajets."
          [showCreate]="canManageDrivers()"
          (closed)="driverPickerOpen.set(false)"
          (selected)="onDriverPicked($event)"
          (createRequested)="openDriverDrawerFromPicker()"
        />
      }

      <!-- Drawer creation conducteur (depuis le picker) -->
      <app-driver-drawer
        [open]="driverDrawerOpen()"
        [data]="driverDrawerData()"
        [loading]="driverDrawerLoading()"
        (closed)="driverDrawerOpen.set(false)"
        (saved)="onDriverDrawerSave($event)"
      />

      <!-- Sprint 7 — Modal « Signaler un incident » → POST /api/agenda/incidents -->
      @if (incidentOpen()) {
        <div class="vd-inc-root" (click)="incidentOpen.set(false)">
          <div class="vd-inc-modal" (click)="$event.stopPropagation()" role="dialog" aria-label="Signaler un incident">
            <header class="vd-inc-head">
              <div class="flex items-center gap-2">
                <lucide-icon [img]="AlertTriangle" [size]="16" class="text-amber-400"></lucide-icon>
                <h3 class="vd-inc-title">Signaler un incident</h3>
              </div>
              <button type="button" (click)="incidentOpen.set(false)" aria-label="Fermer" class="vd-inc-close">
                <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
              </button>
            </header>
            <div class="vd-inc-body">
              <p class="vd-inc-veh">{{ v.plate }} @if (v.brand) { · {{ v.brand }} {{ v.model }} }</p>
              <div class="vd-inc-field">
                <label for="vd-inc-title">Titre</label>
                <input id="vd-inc-title" type="text" class="vd-inc-input" [(ngModel)]="incidentForm.title"
                       placeholder="Ex. Crevaison pneu avant droit" />
              </div>
              <div class="vd-inc-field">
                <label>Sévérité</label>
                <div class="vd-inc-seg">
                  <button type="button" (click)="incidentForm.severity = 'LOW'"
                          class="vd-inc-seg-btn" [class.vd-inc-seg-btn--active]="incidentForm.severity === 'LOW'">Faible</button>
                  <button type="button" (click)="incidentForm.severity = 'MEDIUM'"
                          class="vd-inc-seg-btn" [class.vd-inc-seg-btn--active]="incidentForm.severity === 'MEDIUM'">Moyenne</button>
                  <button type="button" (click)="incidentForm.severity = 'HIGH'"
                          class="vd-inc-seg-btn" [class.vd-inc-seg-btn--active]="incidentForm.severity === 'HIGH'">Critique</button>
                </div>
              </div>
              <div class="vd-inc-field">
                <label for="vd-inc-desc">Description</label>
                <textarea id="vd-inc-desc" class="vd-inc-input vd-inc-textarea" rows="3"
                          [(ngModel)]="incidentForm.description" placeholder="Détails (optionnel)"></textarea>
              </div>
            </div>
            <footer class="vd-inc-foot">
              <button type="button" (click)="incidentOpen.set(false)" class="vd-inc-cancel">Annuler</button>
              <button type="button" (click)="submitIncident()"
                      [disabled]="!incidentForm.title.trim() || savingIncident()" class="vd-inc-submit">
                {{ savingIncident() ? 'Envoi…' : 'Signaler' }}
              </button>
            </footer>
          </div>
        </div>
      }
    }
  `,
  styles: [`
    /* ─── Cibles tactiles au doigt ───────────────────────────────────────────
     *
     * Critere de recette « iPhone 390 px : cibles >= 44 px ». Mesure a 375 px le
     * 2026-08-14 : SEPT commandes sortaient sous le seuil — retour 38x38, IMEI
     * 92x36, « Changer » 51x36, « Incident » et « QR » 94x36 et 63x36, detacher
     * le boitier 18x36, assigner un conducteur 84x36.
     *
     * ⚠️ La regle des 44 px de styles.css ne les rattrapait pas : c'est une LISTE
     * de noms de classes (.tab-btn, .main-tab, .bn-tab, .vdx-tab…) et aucune de
     * celles-ci n'y figure. Une liste ne rattrape que ce qu'on y inscrit — d'ou
     * cette regle, ecrite dans le composant qui porte les commandes.
     *
     * La HAUTEUR suffit pour les commandes a libelle : les elargir casserait la
     * ligne. Les boutons a icone seule prennent les deux dimensions.
     */
    @media (max-width: 768px) {
      .vdx-link,
      .vdx-imei,
      .vd-incident-btn,
      .vd-driver-card-btn { min-height: 44px }
      .vdx-back,
      .vd-tracker-detach { min-width: 44px; min-height: 44px }
    }

    /* ─── Bandeau « en mission » (espace dépôt, A2 § 9) ──────────────────────
       Violet : c'est la couleur du DÉPÔT dans tout le système (design/TOKENS.md).
       Ambre quand la mission est en retard — une attente à lever, pas un échec. */
    .vdx-mission {
      display: flex; align-items: flex-start; gap: 11px;
      padding: 12px 14px; margin-bottom: 14px; border-radius: 14px;
      background: color-mix(in srgb, var(--violet) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--violet) 26%, transparent);
    }
    .vdx-mission--retard {
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border-color: color-mix(in srgb, var(--warning) 28%, transparent);
    }
    .vdx-mission-ico { color: var(--violet); flex-shrink: 0; margin-top: 1px; }
    .vdx-mission--retard .vdx-mission-ico { color: var(--warning); }
    .vdx-mission-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .vdx-mission-l1 { margin: 0; display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap;
                      font-size: 13.5px; color: var(--violet); }
    .vdx-mission--retard .vdx-mission-l1 { color: var(--warning); }
    .vdx-mission-ref { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tertiary); }
    .vdx-mission-l2 { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); }
    .vdx-mission-depot { margin: 2px 0 0; display: flex; align-items: center; gap: 6px;
                         font-size: 12px; line-height: 1.5; color: var(--text-tertiary); }

    /* ═══════════════════════════════════════════════════════════════════
       Maquette 06 — Détail véhicule. Intégration DS (mêmes tokens que l'app).
       Préfixe .vdx-* pour la refonte, réutilise les tokens --tracky-light /
       --bg-secondary / --border-* / --accent-ink.
       ═══════════════════════════════════════════════════════════════════ */
    .vdx-wrap { display: flex; flex-direction: column; gap: 20px; }
    .vdx-card {
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 16px;
    }

    /* ── Hero ── */
    .vdx-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .vdx-hero-main { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
    .vdx-back {
      display: inline-flex; align-items: center; justify-content: center;
      width: 38px; height: 38px; border-radius: 11px; flex-shrink: 0;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); cursor: pointer; transition: color .15s, border-color .15s;
    }
    .vdx-back:hover { color: var(--fg-primary); border-color: var(--border-strong); }
    .vdx-hero-txt { min-width: 0; }
    .vdx-hero-titlerow { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; }
    .vdx-hero-name { margin: 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .vdx-hero-sub { display: flex; align-items: center; gap: 9px; margin-top: 6px; font-size: .82rem; color: var(--fg-secondary); flex-wrap: wrap; }
    .vdx-hero-plate { font-weight: 700; color: var(--fg-primary); letter-spacing: .02em; }
    .vdx-dot { color: var(--fg-tertiary); }
    .vdx-hero-group { display: inline-flex; align-items: center; gap: 7px; }
    /* Convention du kit : un libelle prend --texte-succes, jamais le vert de
       marque (3,34:1 en clair). */
    .vdx-link { font-size: .76rem; font-weight: 700; color: var(--texte-succes); cursor: pointer; }
    .vdx-link:hover { text-decoration: underline; }
    .vdx-hero-actions { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; flex-shrink: 0; }

    /* ── Cartes stat (4) ── */
    .vdx-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px; }
    .vdx-stat { padding: 14px 15px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; min-width: 0; }
    .vdx-stat--link { cursor: pointer; transition: border-color .15s; }
    .vdx-stat--link:hover { border-color: var(--border-strong); }
    .vdx-stat-k { font-family: var(--font-mono, monospace); font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-tertiary); }
    .vdx-stat-v { font-size: 1.4rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); margin-top: 6px; }
    .vdx-stat-v--sm { font-size: .9rem; font-weight: 700; }
    .vdx-stat-u { font-size: .72rem; font-weight: 600; color: var(--fg-tertiary); }
    .vdx-stat-coord { font-family: var(--font-mono, monospace); font-size: .66rem; color: var(--fg-tertiary); margin-top: 2px; }
    .vdx-stat-live { display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; font-size: .68rem; font-weight: 700; color: var(--fg-tertiary); }
    .vdx-stat-live--on { color: var(--texte-succes); }
    /* DORMANCE — violet, identique au badge « Dormant » (source unique : connectivityMeta).
       Le liseré sur la carte dit d'un coup d'œil « ces chiffres ne sont pas d'aujourd'hui ».
       La valeur SUIT le badge : les deux se lisent côte à côte sur la même fiche, une
       divergence de teinte s'y verrait comme deux états différents. */
    .vdx-stat-live--dormant { color: var(--texte-violet); }
    .vdx-stat--stale { border-color: color-mix(in srgb, var(--texte-violet) 35%, transparent); }
    .vdx-stale-v { color: var(--fg-tertiary); font-weight: 700; }
    .vdx-stat-stale { margin-top: 4px; font-size: .64rem; line-height: 1.35; color: var(--fg-tertiary); font-style: italic; }
    .vdx-live-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .vdx-stat-live--on .vdx-live-dot { animation: vt-blink 2s ease-in-out infinite; }
    .vdx-stat-tags { display: flex; align-items: center; gap: 7px; margin-top: 6px; flex-wrap: wrap; }
    .vdx-imei {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 6px;
      font-family: var(--font-mono, monospace); font-size: .86rem; font-weight: 600;
      color: var(--fg-primary); background: none; border: 0; padding: 0; cursor: pointer;
    }
    .vdx-imei:hover .vd-stat-copy-icon { opacity: 1; color: var(--tracky-light); }
    @keyframes vt-blink { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

    /* ── Onglets, niveau 1 : les familles ── */
    .vdx-familles { display: flex; align-items: center; gap: 4px; margin-bottom: 10px; overflow-x: auto; scrollbar-width: none; }
    .vdx-familles::-webkit-scrollbar { display: none; }
    .vdx-famille {
      display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
      padding: 7px 13px; border-radius: 9999px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-quaternary);
      font: inherit; font-size: .78rem; font-weight: 700; letter-spacing: .01em;
      color: var(--fg-tertiary); cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
    }
    .vdx-famille:hover { color: var(--fg-secondary); }
    .vdx-famille--active {
      background: color-mix(in srgb, var(--texte-succes) 13%, transparent);
      color: var(--texte-succes);
      border-color: color-mix(in srgb, var(--texte-succes) 30%, transparent);
    }

    /* ── Onglets, niveau 2 (dtab) ── */
    .vdx-tabs { display: flex; align-items: center; gap: 5px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 13px; overflow-x: auto; scrollbar-width: none; }
    .vdx-tabs::-webkit-scrollbar { display: none; }
    .vdx-tab {
      display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
      padding: 9px 14px; border-radius: 10px; border: 1px solid transparent;
      font-size: .83rem; font-weight: 700; color: var(--fg-tertiary); cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
    }
    .vdx-tab:hover { color: var(--fg-secondary); }
    .vdx-tab--active { background: var(--bg-secondary); color: var(--fg-primary); border-color: var(--border-strong); }
    /* Compteur sur pastille teintee : le chiffre est du TEXTE (2,88:1 avec --danger). */
    .vdx-tab-badge { min-width: 18px; height: 18px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; border-radius: 9px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); font-size: .66rem; font-weight: 800; }


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
      color: var(--warning);
    }
    .vd-admin-toggle {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
    }
    .vd-hs-field {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .vd-hs-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .vd-hs-select {
      flex: 1 1 160px;
      min-height: 44px;
      padding: 8px 10px;
      font-size: 14px;
      color: var(--text-primary);
      background: var(--bg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
    }
    .vd-hs-select:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .vd-hs-note {
      margin: 0;
      font-size: 12px;
      font-style: italic;
      color: var(--text-secondary);
    }
    .vd-hs-aide {
      margin: 0;
      font-size: 12px;
      line-height: 1.45;
      color: var(--text-secondary);
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
    .vd-admin-warning {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      color: var(--danger);
      font-size: 11px;
      font-weight: 500;
    }
    .vd-admin-warning lucide-icon {
      flex-shrink: 0;
    }

    /* Zones mortes GPS (suivi FS-253) */
    .vd-dz-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: color-mix(in srgb, #0ea5e9 6%, var(--bg-secondary)); border: 1px solid color-mix(in srgb, #0ea5e9 22%, var(--border-subtle)); border-radius: 12px; }
    .vd-dz-header { color: #0ea5e9; }
    .vd-dz-count { margin-left: auto; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, #0ea5e9 18%, transparent); color: #0ea5e9; font-size: 11px; font-weight: 700; }
    .vd-dz-now { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; background: color-mix(in srgb, #0ea5e9 10%, var(--bg-secondary)); border: 1px solid color-mix(in srgb, #0ea5e9 28%, var(--border-subtle)); border-radius: 8px; color: var(--fg-secondary); font-size: 12px; line-height: 1.4; }
    .vd-dz-now lucide-icon { color: #0ea5e9; flex-shrink: 0; margin-top: 1px; }
    .vd-dz-now-ask { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .vd-dz-intro { margin: 0; color: var(--fg-tertiary); font-size: 11px; line-height: 1.4; }
    .vd-dz-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .vd-dz-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; }
    .vd-dz-item--benign { border-color: color-mix(in srgb, var(--tracky-light) 40%, var(--border-subtle)); }
    .vd-dz-item--suspect { border-color: color-mix(in srgb, #ef4444 40%, var(--border-subtle)); }
    .vd-dz-item-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
    .vd-dz-item-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .vd-dz-now strong, .vd-dz-item-title strong { color: var(--fg-primary); }
    .vd-dz-item-title strong { font-size: 13px; font-weight: 600; }
    .vd-dz-badge { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; background: color-mix(in srgb, var(--fg-tertiary) 18%, transparent); color: var(--fg-secondary); }
    /* Texte sur lavis accent : --texte-succes, le vert de marque rend ~2,8:1 en clair. */
    .vd-dz-badge[data-s='CONFIRMED_BENIGN'] { background: color-mix(in srgb, var(--tracky-light) 20%, transparent); color: var(--texte-succes); }
    .vd-dz-badge[data-s='SUSPECT'] { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--texte-alerte); }
    .vd-dz-item-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--fg-tertiary); font-size: 11px; }
    .vd-dz-note { color: var(--fg-secondary); font-size: 11px; font-style: italic; }
    /* La ligne qui dit que tout va bien : verte, discrete, jamais alarmante. Elle
       n'apparait que sur une zone reconnue — ailleurs, elle serait une promesse. */
    .vd-dz-rassure {
      margin-top: 3px; font-size: 11px; color: var(--texte-succes);
    }
    .vd-dz-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .vd-dz-btn { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary); font-size: 11px; font-weight: 600; cursor: pointer; }
    .vd-dz-btn:disabled { opacity: .5; cursor: wait; }
    .vd-dz-btn--ok { border-color: color-mix(in srgb, var(--tracky-light) 45%, var(--border-strong)); color: var(--texte-succes); }
    .vd-dz-btn--warn { border-color: color-mix(in srgb, var(--danger) 40%, var(--border-strong)); color: var(--texte-alerte); }

    /* Ancienne stats-bar → remplacée par .vdx-stats (haut du fichier). Styles copie IMEI conservés : */
    .vd-stat-copy-icon { opacity: .5; color: var(--fg-tertiary); transition: opacity .15s, color .15s }
    .vd-stat-copy-ok { color: var(--tracky-light, #10E0A0); animation: vd-copy-pop .25s ease-out }
    @keyframes vd-copy-pop { 0% { transform: scale(.6); opacity: 0 } 100% { transform: scale(1); opacity: 1 } }

    /* Anciens onglets → remplacés par .vdx-tabs (haut du fichier). */

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
      font-family: var(--font-display);
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
    .vd-history-flag--off { background: rgba(239,68,68,.12); color: var(--danger); }
    .vd-history-flag--ok { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .vd-history-flag--ko { background: rgba(239,68,68,.08); color: var(--danger); }

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
      font-family: var(--font-display);
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
    .vd-trip-stat-value--max { color: var(--warning); }

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

    /* La pastille conducteur (.vd-trip-driver) vivait ici sans qu'aucun element du
       gabarit ne porte la classe : regles mortes, supprimees. Le rendu reel est
       dans vehicle-reports-tab, qui pose bien --driver-color via [style]. */

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
    .vd-trip-note-counter--warn { color: var(--warning); }
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
      color: var(--accent-ink);
    }
    .vd-trip-note-btn--primary:hover:not(:disabled) {
      filter: brightness(1.06);
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

    .vd-tracker-row { display: flex; align-items: center; gap: 4px }
    .vd-tracker-extra { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap }
    .vd-inst { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 9999px }
    .vd-inst--installed { color: var(--tracky-light); background: rgba(16,224,160,.12); border: 1px solid rgba(16,224,160,.22) }
    .vd-inst--no-sim { color: var(--texte-attente); background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.22) }
    .vd-sim { font-size: 10px; color: var(--fg-tertiary); font-family: var(--font-mono, monospace) }
    .vd-tracker-detach {
      background: transparent; border: 0; padding: 3px; border-radius: 4px;
      color: var(--fg-tertiary); cursor: pointer; transition: all .15s;
    }
    .vd-tracker-detach:hover { color: var(--danger); background: rgba(239,68,68,.1) }
    .vd-tracker-assign-btn {
      background: rgba(16,224,160,.08); border: 1px dashed rgba(16,224,160,.3);
      color: var(--tracky-light); padding: 4px 10px; border-radius: 6px;
      font-size: 11px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .vd-tracker-assign-btn:hover { background: rgba(16,224,160,.15); border-style: solid }

    .vd-trip-actions {
      display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;
    }
    .vd-trip-action-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; font-weight: 600;
      cursor: pointer; transition: all .15s;
    }
    .vd-trip-action-btn:hover {
      color: var(--tracky-light); border-color: rgba(16,224,160,.30);
      background: rgba(16,224,160,.06);
    }

    /* Cartes stat (maquette) : 2 colonnes sur mobile, 4 en desktop. */
    @media (max-width: 720px) {
      .vdx-stats { grid-template-columns: repeat(2, 1fr); }
      .vdx-hero-name { font-size: 1.3rem; }
    }

    /* Mobile étroit : la barre d'actions (Couper / Écoute / Incident) passe SOUS le
       titre (pleine largeur) au lieu d'écraser le nom du véhicule sur plusieurs lignes.
       Cause : .vdx-hero-main flex:1+min-width:0 se comprime au lieu que les actions
       (flex-shrink:0) retombent à la ligne. */
    @media (max-width: 600px) {
      .vdx-hero { flex-direction: column; align-items: stretch; }
      .vdx-hero-actions { width: 100%; }
    }

    /* ─── Sprint 7 — Bouton « Signaler un incident » (header) ─── */
    .vd-incident-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 12px; border-radius: 10px;
      background: rgba(245,158,11,.10); border: 1px solid rgba(245,158,11,.28);
      color: var(--texte-attente); font-size: 12px; font-weight: 700; cursor: pointer; transition: all .15s;
      white-space: nowrap;
    }
    .vd-incident-btn:hover { background: rgba(245,158,11,.18); border-color: rgba(245,158,11,.42); }

    /* ─── Sprint 7 — Modal incident ─── */
    .vd-inc-root {
      position: fixed; inset: 0; z-index: 9000;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.5); backdrop-filter: blur(2px); padding: 16px;
      animation: vd-inc-fade .15s ease-out;
    }
    @keyframes vd-inc-fade { from { opacity: 0; } to { opacity: 1; } }
    .vd-inc-modal {
      width: 100%; max-width: 420px; max-height: 88vh; max-height: 88dvh; display: flex; flex-direction: column;
      background: var(--bg-primary); border: 1px solid var(--border-subtle);
      border-radius: 18px; box-shadow: 0 24px 60px rgba(0,0,0,.4); overflow: hidden;
      animation: vd-inc-rise .2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes vd-inc-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .vd-inc-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .vd-inc-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .vd-inc-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 8px;
      background: transparent; border: 0; color: var(--fg-tertiary); cursor: pointer; transition: all .15s;
    }
    .vd-inc-close:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .vd-inc-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
    .vd-inc-veh { font-size: 12px; font-weight: 700; color: var(--fg-secondary); font-family: var(--font-mono, monospace); margin: 0; }
    .vd-inc-field { display: flex; flex-direction: column; gap: 5px; }
    .vd-inc-field label {
      font-size: 11px; font-weight: 600; color: var(--fg-tertiary);
      text-transform: uppercase; letter-spacing: .03em;
    }
    .vd-inc-input {
      width: 100%; padding: 9px 11px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 13px; font-family: inherit; transition: border-color .15s;
    }
    .vd-inc-input:focus { outline: none; border-color: var(--tracky-light); }
    .vd-inc-input::placeholder { color: var(--fg-tertiary); }
    .vd-inc-textarea { resize: vertical; min-height: 56px; line-height: 1.45; }
    .vd-inc-seg {
      display: flex; padding: 3px; gap: 2px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 12px;
    }
    .vd-inc-seg-btn {
      flex: 1; padding: 7px 10px; border-radius: 9px;
      background: transparent; border: 0; color: var(--fg-tertiary);
      font-size: 12px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .vd-inc-seg-btn:hover { color: var(--fg-secondary); }
    .vd-inc-seg-btn--active { background: var(--bg-secondary); color: var(--warning); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .vd-inc-foot {
      display: flex; gap: 8px; justify-content: flex-end;
      padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .vd-inc-cancel {
      padding: 8px 14px; border-radius: 10px;
      background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle);
      font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .vd-inc-cancel:hover { color: var(--fg-primary); border-color: var(--border-strong); }
    .vd-inc-submit {
      padding: 8px 14px; border-radius: 10px;
      background: var(--warning); color: var(--accent-ink); border: none;
      font-size: 13px; font-weight: 700; cursor: pointer; transition: filter .15s, opacity .15s;
    }
    .vd-inc-submit:hover:not(:disabled) { filter: brightness(.95); }
    .vd-inc-submit:disabled { opacity: .5; cursor: not-allowed; }

    @media (max-width: 480px) {
      .vd-inc-root { align-items: flex-end; padding: 0; }
      .vd-inc-modal { max-width: none; max-height: 92vh; max-height: 92dvh; border-radius: 18px 18px 0 0; border-bottom: 0; }
      @keyframes vd-inc-rise { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: none; } }
    }
  `],
})
export class VehicleDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly http = inject(HttpClient);
  /** Un SUPER_ADMIN n'a pas de flotte : le bandeau « en mission » a besoin de la sienne. */
  private readonly fleetFilter = inject(FleetFilterService);
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
  private readonly vehicleGroups = inject(VehicleGroupsService);
  private readonly agendaApi = inject(AgendaApiService);
  private readonly deadZonesApi = inject(GpsDeadZonesApiService);

  // Zones mortes GPS (suivi FS-253) : endroits où ce véhicule perd récurremment le GPS.
  protected readonly deadZones = signal<GpsDeadZoneDto[]>([]);
  /** Id de la zone en cours de mise à jour (spinner/disable des boutons). */
  protected readonly deadZoneSaving = signal<string | null>(null);

  protected readonly vehicle = signal<VehicleDetailDto | null>(null);
  // Sprint 1 (Fondation Groupes) — assignation de groupe depuis le détail.
  protected readonly groups = signal<VehicleGroup[]>([]);
  protected readonly groupsLoading = signal(false);
  protected readonly groupPickerOpen = signal(false);
  protected readonly groupSaving = signal(false);
  protected readonly groupSearch = signal('');
  protected readonly filteredGroups = computed(() => {
    const q = this.groupSearch().trim().toLowerCase();
    const list = this.groups();
    return q ? list.filter((g) => g.name.toLowerCase().includes(q)) : list;
  });
  // Sprint 1 — contexte de retour rapide (d'où vient l'utilisateur).
  private readonly backFrom = signal<string | null>(null);
  private readonly backGroup = signal<string | null>(null);
  protected readonly recentPositions = signal<PositionDto[]>([]);
  protected readonly alerts = signal<AlertEvent[]>([]);
  protected readonly commands = signal<EngineControlCommandDto[]>([]);
  protected readonly vehicleTrips = signal<TripDto[]>([]);
  protected readonly loading = signal(true);
  /** Espace dépôt (2026-08) — la mission en cours de ce véhicule, ou null. */
  protected readonly missionEnCours = signal<MissionEnCours | null>(null);
  // Edition note (un seul trip en edition a la fois — switch reset auto).
  protected readonly editingNoteTripId = signal<string | null>(null);
  protected editingNoteText = '';
  protected readonly savingNote = signal(false);
  // Phase 2 — Picker conducteur (ouverture + spinner d'assignation).
  protected readonly driverPickerOpen = signal(false);
  protected readonly assigningDriver = signal(false);
  // Drawer creation conducteur depuis le picker.
  protected readonly driverDrawerOpen = signal(false);
  protected readonly driverDrawerData = signal<DriverDrawerData | null>(null);
  protected readonly driverDrawerLoading = signal(false);
  /** True pendant un refetch declenche par un changement de plage date (history/trips). */
  protected readonly rangeLoading = signal(false);
  protected readonly activeTab = signal<string>('map');
  /** Deep-link `?trip=<id>` (depuis les scores « N avec excès ») → onglet Rapports scrolle vers ce trajet + ouvre son récit IA. */
  protected readonly openTripId = signal<string | null>(null);
  /** Lot V5 — alerte d'où l'on vient (`?alert=`), pour la marquer « vue » depuis le trajet. */
  protected readonly openAlertId = signal<string | null>(null);
  /** ISO du trajet ciblé (`?tripDate=`) → cadre la période de l'onglet Rapports sur son jour. */
  protected readonly openTripDate = signal<string | null>(null);

  /**
   * Plage temporelle pour les onglets Historique et Trajets.
   * Default = `7d` (les 7 derniers jours). Le defaut `today` etait trop
   * restrictif : sur la plupart des vehicules, l'onglet Trajets s'ouvrait
   * vide ("Aucun trajet") ce qui donnait l'impression d'une UI cassee
   * alors qu'il y avait des trajets recents. L'user peut toujours filtrer
   * sur Aujourd'hui, Hier, 30j, Tout, ou plage personnalisee.
   */
  protected readonly dateRange = signal<'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom'>('7d');
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
  protected readonly hsUpdating = signal(false);
  /** V1.7 — vrai si l'utilisateur courant est SUPER_ADMIN (pour afficher la carte reglage materiel). */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly LayersIcon = Layers;
  protected readonly Wifi = Wifi;
  protected readonly WifiOff = WifiOff;
  protected readonly Gauge = Gauge;
  protected readonly MapPin = MapPin;
  protected readonly Radio = Radio;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly QrCode = QrCode;
  protected readonly AlertCircle = AlertCircle;
  protected readonly InfoIcon = Info;
  protected readonly Check = Check;
  protected readonly Power = Power;
  protected readonly BellOff = BellOff;
  protected readonly HistoryIcon = History;
  protected readonly Route = Route;
  protected readonly Eye = Eye;
  protected readonly ZapIcon = Zap;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly SatelliteDish = SatelliteDish;
  protected readonly ParkingSquare = ParkingSquare;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;
  protected readonly XIcon = X;
  protected readonly UserRoundIcon = UserRound;
  protected readonly UserPlusIcon = UserPlus;
  protected readonly PlayIcon = Play;
  protected readonly CheckIcon = Check;
  protected readonly CopyIcon = Copy;
  protected readonly relativeTime = relativeTime;

  protected readonly imeiCopied = signal(false);
  /**
   * Copie l'IMEI complet dans le presse-papier et affiche un check pendant 1.5s.
   * `navigator.clipboard.writeText` échoué parfois (NotAllowedError sans interaction
   * utilisateur consideree "trustworthy", contextes HTTP non secure, focus perdu) :
   * fallback sur la technique `document.execCommand('copy')` via textarea cache.
   */
  protected async copyImei(imei: string): Promise<void> {
    const ok = await this.writeClipboardWithFallback(imei);
    if (ok) {
      this.imeiCopied.set(true);
      this.toast.success('IMEI copié');
      setTimeout(() => this.imeiCopied.set(false), 1500);
    } else {
      this.toast.error('Impossible de copier', 'Sélectionne et copie manuellement.');
    }
  }

  private async writeClipboardWithFallback(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fallback ci-dessous */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

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

  protected readonly tabs = computed(() => {
    // V1.12 — Ordre revu pour grouper logiquement :
    //   Vue temps reel : Carte
    //   Donnees passe   : Trajets + Historique (cote a cote)
    //   Securite        : Alertes + Surveillance (cote a cote)
    //   Configuration   : Horaires + Commandes (a la fin)
    //
    // Perm surveillance passee de `alerts_view` (lecture) a `alerts_acknowledge`
    // (action) car armer/desarmer la surveillance est une action sensible
    // (equivalent alarme anti-vol) — un viewer pur ne doit pas pouvoir le faire.
    //
    // Onglet Surveillance filtre si pas de tracker : sinon l'onglet apparait
    // pour ne montrer que "Aucun tracker associé", ce qui est de la noise.
    const hasTracker = !!this.vehicle()?.tracker;
    //
    // ⚠️ 2026-08-24 — L'ONGLET « COMMANDES » A ÉTÉ RETIRÉ DE CETTE FICHE (décision du
    // propriétaire). Le pilotage d'un boîtier est un geste d'administration : la console
    // d'envoi vit désormais UNIQUEMENT sur `/admin/trackers/:id`, où le même
    // `CommandsPanelComponent` était déjà monté — les deux écrans étaient strictement
    // identiques, vérifié en production le jour de la décision. Rien n'est perdu.
    //
    // Le gate `adminOnly` qui existait ici (rôle SUPER_ADMIN/FLEET_ADMIN, aligné sur
    // `tracker-commands.controller @Roles` et NON sur la permission `engine_control`)
    // devient sans objet : la route d'administration porte déjà sa propre garde.
    // ⚠️ Ne pas remettre cet onglet sans raison neuve — deux chemins vers la même
    // commande dangereuse, c'est deux endroits où vérifier une garde.
    const all: { key: string; label: string; icon: any; perm?: string; show?: boolean }[] = [
      { key: 'map', label: 'Carte', icon: Map },
      { key: 'reports', label: 'Rapports', icon: BarChart3 },
      { key: 'history', label: 'Historique', icon: History },
      { key: 'alerts', label: 'Alertes', icon: Bell, perm: 'alerts_view' },
      { key: 'surveillance', label: 'Surveillance', icon: ShieldCheck, perm: 'alerts_acknowledge', show: hasTracker },
      // Sprint 7 — Agenda : onglet Maintenance (entretiens + plans + estimation km), gaté agenda_view.
      { key: 'maintenance', label: 'Maintenance', icon: Wrench, perm: 'agenda_view' },
      { key: 'geofences', label: 'Géofences', icon: MapPin },
      // Sprint 3 — l'onglet Horaires suit la permission backend `schedules_manage`
      // (et non plus `engine_control`) : sinon le veilleur (engine_control=true,
      // schedules_manage=false) voyait l'onglet mais le GET /schedule renvoyait 403.
      { key: 'schedule', label: 'Horaires', icon: Clock, perm: 'schedules_manage' },
    ];
    return all
      .filter((t) => t.show !== false)
      // Sprint 3 — veilleur de nuit : page détail réduite à la Carte (position) + Horaires
      // (si toggle). Le bloquer/débloquer reste dans l'en-tête. Tout le reste est hors périmètre.
      .filter((t) => !this.isWatchman() || t.key === 'map' || t.key === 'schedule')
      // Le filtre `adminOnly` est retiré avec l'onglet « Commandes » : plus aucun onglet de
      // cette fiche n'est réservé à un rôle. Les permissions suffisent (ligne suivante).
      .filter((t) => !t.perm || this.perms.can(t.perm as any));
  });

  /**
   * Les familles qui ont au moins un onglet visible pour cet utilisateur. Une famille
   * vide disparaît : proposer « Sécurité » à quelqu'un qui n'a aucune de ses trois
   * permissions ouvre une boîte vide, ce qui se lit comme une panne.
   */
  protected readonly famillesVisibles = computed(() =>
    rangerEnFamilles(this.tabs(), this.alerts().length),
  );

  /** La famille qui contient l'onglet ouvert. */
  protected readonly familleActive = computed(() => {
    const courant = this.activeTab();
    return this.famillesVisibles().find((f) => f.onglets.some((t) => t.key === courant))?.cle
      ?? this.famillesVisibles()[0]?.cle
      ?? 'suivi';
  });

  /**
   * Les onglets du second niveau. Sous deux familles, on retombe sur la rangée plate :
   * le veilleur de nuit ne voit que Carte et Horaires, et deux boîtes pour deux onglets
   * sont un classement qui ne classe rien.
   */
  protected readonly ongletsDeLaFamille = computed(() => {
    const familles = this.famillesVisibles();
    if (familles.length <= 1) return this.tabs();
    return familles.find((f) => f.cle === this.familleActive())?.onglets ?? this.tabs();
  });

  /** Ouvrir une famille ouvre son PREMIER onglet — une famille n'a pas de contenu propre. */
  protected ouvrirFamille(f: { onglets: { key: string }[] }): void {
    const premier = f.onglets[0];
    if (premier) this.activeTab.set(premier.key);
  }

  private lastAlertCount = -1;
  private alertRefreshEffect = effect(() => {
    if (this.isWatchman()) return; // Sprint 3 — veilleur : pas d'accès aux alertes (403)
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
    if (this.isWatchman()) return; // Sprint 3 — veilleur : pas d'historique commandes (403) ; l'état coupe vient du WS
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

  /** Sprint 3 — veilleur de nuit : ni live, ni interaction carte (page détail uniquement). */
  protected readonly isWatchman = this.auth.isWatchman;

  protected readonly livePosition = computed(() => {
    // Sprint 3 — le veilleur n'a pas de flux live (room WS `pos:fleet` non rejointe côté serveur).
    // Défense en profondeur côté front : la mini-carte reste sur la dernière position connue
    // (historique HTTP), jamais le live. La confirmation moteur S2 reste active (currentPosition).
    if (this.isWatchman()) return null;
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

    // GPS sanity (live) : si la trame WS est `valid:false` (backend la broadcast
    // pour propager l'ignition mais lat/lng sont degradees), on utilise les
    // coords de la derniere position historique sanitizee. Conserve l'ignition
    // fraiche du live event — c'est tout l'interet de ce broadcast.
    const last = this.recentPositions()[0];
    if (live && isAcceptableLiveFix(live)) {
      return { lat: live.lat, lng: live.lng, speedKmh: live.speedKmh, heading: live.heading ?? 0, timestamp: live.timestamp, ignition: patchIgnition(live.ignition), valid: live.valid };
    }
    if (live && last) {
      // Hybride : coords/vitesse/heading depuis l'historique fiable,
      // ignition/timestamp depuis le live (frais).
      return {
        lat: last.lat,
        lng: last.lng,
        speedKmh: last.speedKmh,
        heading: (last as { heading?: number }).heading ?? 0,
        timestamp: live.timestamp,
        ignition: patchIgnition(live.ignition),
        valid: false,
      };
    }
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
    // Sprint 3 — veilleur (ou avant chargement de l'historique) : dernière position connue
    // via le snapshot (endpoint autorisé) → la mini-carte + le bouton moteur s'affichent.
    const snap = tracker ? this.realtime.snapshot().find((s) => s.trackerId === tracker.id) : undefined;
    if (snap && typeof snap.lastLat === 'number' && typeof snap.lastLng === 'number') {
      return {
        lat: snap.lastLat,
        lng: snap.lastLng,
        speedKmh: snap.lastSpeedKmh ?? 0,
        heading: snap.lastHeading ?? 0,
        timestamp: snap.lastPositionAt ?? new Date().toISOString(),
        ignition: patchIgnition(snap.lastIgnition ?? false),
        valid: snap.lastValid ?? false,
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
    if (this.isWatchman()) return; // Sprint 3 — veilleur : pas d'accès positions/trajets (403)
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
      swallow('vehicle-detail:refetchRange', err);
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

  /**
   * Connectivité tri-état (partagée) du véhicule : ONLINE / OFFLINE /
   * NOT_CONFIGURED. On prend le signal le plus frais entre la position live (WS)
   * et le `lastSeenAt` du tracker (REST), puis on délègue au helper partagé —
   * même définition d'« online » (15 min) que la carte, le dashboard et la liste.
   */
  protected readonly connectivity = computed<VehicleConnectivityState>(() => {
    const v = this.vehicle();
    const pos = this.currentPosition();
    const lastSeen = v?.tracker?.lastSeenAt ?? null;
    const freshest =
      pos?.timestamp && (!lastSeen || new Date(pos.timestamp).getTime() > new Date(lastSeen).getTime())
        ? pos.timestamp
        : lastSeen;
    return getVehicleConnectivityState({
      trackerId: v?.tracker?.id ?? null,
      lastSeenAt: freshest,
      // Incident FS-253 — pour détecter GPS_LOST on se base sur le DERNIER FIX RÉEL
      // (tracker.lastPositionAt), PAS sur pos.timestamp : une trame no_fix garde un
      // timestamp FRAIS (sans coordonnées) et masquerait la perte de GPS.
      lastPositionAt: v?.tracker?.lastPositionAt ?? null,
      // no_fix frais + fix périmé → GPS_LOST (« GPS perdu »).
      lastNoFixAt: v?.tracker?.lastNoFixAt ?? null,
      lastIgnition: pos?.ignition ?? v?.tracker?.lastKnownIgnition ?? null,
    });
  });

  /**
   * Le signal le plus FRAIS connu du boîtier : le `lastSeenAt` REST (chargé au montage de la
   * fiche) contre celui du snapshot temps réel, que le WS réécrit à chaque trame. C'est ce qui
   * fait qu'un dormant qui se réveille redevient normal SANS recharger la page.
   *
   * ⚠️ On lit `snapshot.lastSeenAt`, JAMAIS `currentPosition().timestamp` — deux horloges
   * différentes qu'il ne faut pas mélanger dans le même champ :
   *  - `lastSeenAt` = horloge de RÉCEPTION, la seule alignée sur le serveur
   *    (`Tracker.lastSeenAt = new Date()` à l'ingest, et `RealtimeService` la ré-horodate
   *    à l'arrivée de l'event WS).
   *  - `currentPosition().timestamp` = `deviceTime` du Coban, une horloge qui dérive (skew
   *    GPRS, RTC sans pile) et qui peut être DANS LE FUTUR. Un boîtier en avance de six mois
   *    rendait alors sa propre dormance STRUCTURELLEMENT indétectable sur cette fiche : le
   *    `max()` retenait toujours sa date bidon, `isDormant()` restait faux à vie, et la fiche
   *    de FV-941-LZ continuait d'afficher « Hors ligne » + une vitesse comme si c'était du
   *    direct. Ce même piège est déjà écarté côté `RealtimeService` et côté liste véhicules ;
   *    cette fiche était le dernier endroit qui rouvrait le trou.
   *  - Ce timestamp a aussi un repli `new Date()` (branche snapshot de `currentPosition`) :
   *    l'utiliser ici revenait à dater « maintenant » un boîtier muet depuis 89 jours.
   */
  private readonly freshestLastSeen = computed<string | null>(() => {
    const trackerId = this.vehicle()?.tracker?.id ?? null;
    const rest = this.vehicle()?.tracker?.lastSeenAt ?? null;
    // Absent du snapshot (hors périmètre flotte, pas encore hydraté) → on reste sur le REST,
    // jamais sur une valeur inventée.
    const live = trackerId
      ? (this.realtime.snapshot().find((s) => s.trackerId === trackerId)?.lastSeenAt ?? null)
      : null;
    if (!rest) return live;
    if (!live) return rest;
    return new Date(live).getTime() > new Date(rest).getTime() ? live : rest;
  });

  /**
   * État de PRÉSENCE : `connectivity()` élargi d'un cran `DORMANT` (boîtier muet > 7 j).
   *
   * Seuil COUNTING (7 j), pas ACTING (72 h) : cette valeur ne sert QU'À AFFICHER. Les gardes
   * des boutons de commande (couper, armer, écouter) restent sur 72 h, exactement comme le
   * serveur — sinon un bouton resterait actif 4 jours pour une commande déjà refusée.
   */
  protected readonly presence = computed<VehiclePresenceState>(() => {
    const v = this.vehicle();
    // TRK-046 — le serveur a qualifié le lieu : « considéré stationné » remplace le
    // tri-état calculé (fiche et liste ne doivent jamais se contredire).
    return overlayPresumedParked(
      getVehiclePresenceState({
        trackerId: v?.tracker?.id ?? null,
        lastSeenAt: this.freshestLastSeen(),
        lastPositionAt: v?.tracker?.lastPositionAt ?? null,
        lastNoFixAt: v?.tracker?.lastNoFixAt ?? null,
        lastIgnition: this.currentPosition()?.ignition ?? v?.tracker?.lastKnownIgnition ?? null,
      }),
      v?.presumedParkedZone,
    );
  });

  /** Le boîtier parlait puis s'est tu depuis plus d'une semaine. */
  protected readonly isDormant = computed(() =>
    isVehicleDormant({ trackerId: this.vehicle()?.tracker?.id ?? null, lastSeenAt: this.freshestLastSeen() }),
  );

  /** « 89 j » — ancienneté du silence, affichée telle quelle dans les cartes. */
  protected readonly silenceLabel = computed(() => formatSilenceLabel(this.freshestLastSeen()));

  /**
   * Phrase qui DATE une valeur figée. On n'efface jamais la vitesse ni la position d'un
   * dormant (l'exploitant a besoin de savoir où il a été vu la dernière fois) : on retire
   * seulement le mensonge « c'est maintenant ».
   */
  protected readonly staleValueNote = computed(() => {
    const age = this.silenceLabel();
    return age ? `dernière valeur connue il y a ${age}` : 'dernière valeur connue';
  });

  /**
   * Métadonnées du badge : basées sur la PRÉSENCE (donc « Dormant · 89 j » plutôt que
   * « Hors ligne », qui laisserait croire à une coupure de la nuit dernière).
   */
  protected readonly connMeta = computed(() => connectivityMeta(this.presence(), this.silenceLabel()));

  /**
   * Zone morte GPS dans laquelle se trouve ACTUELLEMENT le véhicule (uniquement s'il est
   * GPS_LOST) : sa dernière position figée tombe dans un cluster connu. Sert à afficher un
   * message calme (« parking souterrain probable ») au lieu d'un « GPS perdu » alarmant.
   */
  protected readonly currentDeadZone = computed<GpsDeadZoneDto | null>(() => {
    if (this.connectivity() !== 'GPS_LOST') return null;
    const pos = this.currentPosition();
    if (!pos || pos.lat == null || pos.lng == null) return null;
    return matchDeadZone(this.deadZones(), pos.lat, pos.lng);
  });

  /** Libellé court du statut d'une zone morte (délègue à l'util partagé). */
  protected dzStatusLabel(s: GpsDeadZoneStatus): string {
    return deadZoneStatusLabel(s);
  }

  /** Nature (confirmée ou suggérée) d'une zone morte, en clair (délègue à l'util partagé). */
  protected dzNatureLabel(z: GpsDeadZoneDto): string {
    return deadZoneNatureLabel(z);
  }

  /** Période d'observation d'une zone (délègue à l'util partagé, comme les libellés). */
  protected dzPeriode(z: GpsDeadZoneDto): string {
    return deadZonePeriodeLabel(z, (iso) => this.relativeTime(iso));
  }

  /** Zone définitivement silencieuse (parking reconnu) — cf. la règle serveur. */
  protected dzSilencieuse(z: GpsDeadZoneDto): boolean {
    return deadZoneEstSilencieuse(z);
  }

  /** Durée typique d'absence, en clair — `null` tant qu'aucun épisode n'est refermé. */
  protected dzDuree(z: GpsDeadZoneDto): string | null {
    return deadZoneDureeTypiqueLabel(z.typicalOutageMinutes);
  }

  /** Confirme une zone comme « normale » (parking) → l'app cesse d'alerter sur les pertes ici. */
  protected confirmDeadZone(z: GpsDeadZoneDto): void {
    void this.reviewDeadZone(z, {
      status: 'CONFIRMED_BENIGN',
      // Qualifie en « parking souterrain » si la nature n'a pas encore été posée.
      ...(z.label === 'UNKNOWN' ? { label: 'UNDERGROUND_PARKING' as GpsDeadZoneLabel } : {}),
    });
  }

  /** Marque une zone suspecte (brouilleur ?) → on continue d'alerter. */
  protected markDeadZoneSuspect(z: GpsDeadZoneDto): void {
    void this.reviewDeadZone(z, { status: 'SUSPECT', label: 'JAMMER_SUSPECTED' });
  }

  /** Réactive les alertes sur une zone précédemment confirmée « normale ». */
  protected reactivateDeadZone(z: GpsDeadZoneDto): void {
    void this.reviewDeadZone(z, { status: 'RECURRING' });
  }

  private async reviewDeadZone(
    z: GpsDeadZoneDto,
    data: { status?: GpsDeadZoneStatus; label?: GpsDeadZoneLabel; note?: string | null },
  ): Promise<void> {
    if (this.deadZoneSaving()) return;
    this.deadZoneSaving.set(z.id);
    try {
      const updated = await firstValueFrom(this.deadZonesApi.review(z.id, data));
      this.deadZones.update((list) => list.map((x) => (x.id === z.id ? updated : x)));
      this.toast.success('Zone morte GPS mise à jour');
    } catch (err) {
      swallow('vehicle-detail:reviewDeadZone', err);
      this.toast.error('Échec de la mise à jour de la zone');
    } finally {
      this.deadZoneSaving.set(null);
    }
  }

  /** Libellé de la pastille de statut du hero (réf. maquette : « En ligne · Contact ON »). */
  protected heroStatusLabel(): string {
    if (this.connectivity() !== 'ONLINE') return this.connMeta().label;
    return this.currentPosition()?.ignition ? 'En ligne · Contact ON' : 'En ligne';
  }

  /** « Installation à revoir » : pose < 1 mois + hors-ligne (a déjà communiqué). */
  protected readonly installToReview = computed(() =>
    isInstallationToReview(this.connectivity(), this.vehicle()?.tracker?.createdAt ?? null),
  );

  private readonly geofencesApi = inject(GeofencesApiService);
  protected readonly allGeofences = signal<GeofenceDto[]>([]);
  /** Zones qui surveillent CE véhicule : ciblage explicite OU zone globale (sans cible). */
  protected readonly vehicleGeofences = computed<GeofenceDto[]>(() => {
    const vid = this.vehicle()?.id;
    if (!vid) return [];
    return this.allGeofences().filter(
      (g) => !g.targetVehicles?.length || g.targetVehicles.some((t) => t.id === vid),
    );
  });

  protected onScheduleDisabled(): void {
    this.scheduleRevision.set(this.scheduleRevision() + 1);
  }

  // ─── Sprint 7 — Signalement d'incident ────────────────────────────────────
  /** Le bouton « Incident » suit la permission de lecture agenda (agenda_view). */
  protected readonly canReportIncident = computed(() => this.perms.can('agenda_view', this.vehicle()?.id));
  // feat/comptes-conducteurs (4a) — QR de déverrouillage (gate `qr_manage`, per-vehicle).
  protected readonly canManageQr = computed(() => this.perms.can('qr_manage', this.vehicle()?.id));
  protected readonly qrOpen = signal(false);
  protected readonly incidentOpen = signal(false);
  protected readonly savingIncident = signal(false);
  protected incidentForm: { title: string; severity: VehicleEventSeverity; description: string } = {
    title: '', severity: 'MEDIUM', description: '',
  };

  protected openIncident(): void {
    this.incidentForm = { title: '', severity: 'MEDIUM', description: '' };
    this.incidentOpen.set(true);
  }

  protected async submitIncident(): Promise<void> {
    const v = this.vehicle();
    if (!v || !this.incidentForm.title.trim() || this.savingIncident()) return;
    this.savingIncident.set(true);
    try {
      await firstValueFrom(this.agendaApi.reportIncident({
        vehicleId: v.id,
        title: this.incidentForm.title.trim(),
        severity: this.incidentForm.severity,
        description: this.incidentForm.description.trim() || undefined,
      }));
      this.toast.success('Incident signalé', this.incidentForm.title.trim());
      this.incidentOpen.set(false);
    } catch (err) {
      swallow('vehicle-detail:submitIncident', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : 'Signalement impossible.');
    } finally {
      this.savingIncident.set(false);
    }
  }

  async ngOnInit(): Promise<void> {
    // Sprint 1 — contexte de retour rapide (depuis la vue groupée notamment).
    const qp = this.route.snapshot.queryParams;
    this.backFrom.set(qp['from'] ?? null);
    this.backGroup.set(qp['group'] ?? null);
    // Deep-link vers un onglet précis (ex. lien « récit » de l'automatisation → ?tab=reports).
    if (typeof qp['tab'] === 'string' && qp['tab']) this.activeTab.set(qp['tab']);
    // Deep-link vers un trajet précis (lien « N avec excès » des scores) → scroll + récit IA.
    if (typeof qp['trip'] === 'string' && qp['trip']) this.openTripId.set(qp['trip']);
    if (typeof qp['tripDate'] === 'string' && qp['tripDate']) this.openTripDate.set(qp['tripDate']);
    if (typeof qp['alert'] === 'string' && qp['alert']) this.openAlertId.set(qp['alert']);

    const id = this.route.snapshot.params['id'];
    if (!id) { this.router.navigate(['/vehicles']); return; }
    await this.loadAll(id);
  }

  /**
   * Espace dépôt (2026-08) — la mission en cours, pour le bandeau (A2 § 9).
   *
   * Chargée à part et sans bloquer : un échec laisse le bandeau absent et la fiche
   * intacte. Elle ne doit jamais empêcher d'ouvrir un véhicule.
   */
  private async chargerMissionEnCours(vehicleId: string): Promise<void> {
    try {
      const m = await firstValueFrom(
        this.http.get<MissionEnCours | null>(`/api/missions/vehicle/${vehicleId}/current${this.fleetFilter.selectedFleetId() ? '?fleetId=' + encodeURIComponent(this.fleetFilter.selectedFleetId()!) : ''}`),
      );
      this.missionEnCours.set(m ?? null);
    } catch (err) {
      swallow('vehicle-detail:missionEnCours', err);
      this.missionEnCours.set(null);
    }
  }

  protected heureMission(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  private async loadAll(vehicleId: string): Promise<void> {
    this.loading.set(true);
    void this.chargerMissionEnCours(vehicleId);
    try {
      const v = await firstValueFrom(this.vehiclesApi.findOne(vehicleId));
      this.vehicle.set(v);

      // Sprint 3 — le veilleur de nuit n'a accès qu'au véhicule + sa position (snapshot).
      // Positions/alertes/trajets/commandes/géofences lui sont INTERDITES (403) : on NE les
      // charge pas — sinon l'appel positions (sans catch) fait rejeter Promise.all → faux
      // « Erreur de chargement » + redirection vers /vehicles. La mini-carte + le bouton
      // moteur s'appuient sur la dernière position connue du snapshot (cf. currentPosition).
      if (this.isWatchman()) return;

      // Géofences qui surveillent ce véhicule (onglet Géofences) — non bloquant.
      void firstValueFrom(this.geofencesApi.list())
        .then((gs) => this.allGeofences.set(gs))
        .catch(() => { /* silencieux */ });

      // Zones mortes GPS apprises pour ce véhicule (suivi FS-253) — non bloquant.
      void firstValueFrom(this.deadZonesApi.listForVehicle(vehicleId))
        .then((zones) => this.deadZones.set(zones))
        .catch(() => { /* silencieux */ });

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
        firstValueFrom(this.alertsApi.list({ vehicleId: v.id, limit: '20' })).catch(() => ({ items: [] })),
        trackerId ? firstValueFrom(this.engineControlApi.listCommands(trackerId, 20)).catch(() => []) : [],
        firstValueFrom(this.tripsApi.list({ vehicleId: v.id, limit: '100', ...dateParams })).catch(() => ({ items: [] })),
      ]);

      this.recentPositions.set(posRes.items);
      this.alerts.set((alertsRes as any).items ?? alertsRes);
      this.commands.set(Array.isArray(cmdsRes) ? cmdsRes : []);
      this.vehicleTrips.set((tripsRes as any).items ?? []);
    } catch (err) {
      swallow('vehicle-detail:loadAll', err);
      this.toast.error('Erreur de chargement', err instanceof HttpErrorResponse ? err.error?.message : String(err));
      this.router.navigate(['/vehicles']);
    } finally {
      this.loading.set(false);
    }
  }

  // --- Sprint 1 (Fondation Groupes) — groupe & retour rapide ---

  protected canManageGroups(): boolean {
    return this.perms.can('groups_manage');
  }

  protected async openGroupPicker(): Promise<void> {
    this.groupSearch.set('');
    this.groupPickerOpen.set(true);
    if (this.groups().length === 0) {
      this.groupsLoading.set(true);
      try {
        this.groups.set(await this.vehicleGroups.list());
      } catch {
        this.toast.error('Erreur', 'Impossible de charger les groupes.');
      } finally {
        this.groupsLoading.set(false);
      }
    }
  }

  /** Assigne (ou retire si null) le groupe du véhicule. Optimiste + rollback. */
  protected async setGroup(groupId: string | null): Promise<void> {
    const v = this.vehicle();
    if (!v) return;
    const previous = v.group ?? null;
    const target = groupId ? this.groups().find((g) => g.id === groupId) ?? null : null;
    if ((previous?.id ?? null) === (target?.id ?? null)) { this.groupPickerOpen.set(false); return; }

    // Maj optimiste immédiate de l'affichage.
    this.vehicle.set({ ...v, group: target ? { id: target.id, name: target.name } : null });
    this.groupSaving.set(true);
    try {
      const updated = await firstValueFrom(this.vehiclesApi.setGroup(v.id, groupId));
      this.vehicle.set(updated);
      this.groupPickerOpen.set(false);
      this.toast.success(groupId ? 'Groupe mis à jour' : 'Retiré du groupe', target?.name);
    } catch (err) {
      swallow('vehicle-detail:setGroup', err);
      this.vehicle.set({ ...v, group: previous }); // rollback
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : 'Impossible de changer le groupe.');
    } finally {
      this.groupSaving.set(false);
    }
  }

  /** Retour rapide contextuel : vers la liste (mode groupé conservé via préférences). */
  protected goBack(): void {
    if (this.backFrom() === 'grouped') {
      this.router.navigate(['/vehicles'], { queryParams: { group: this.backGroup() || null } });
    } else {
      this.router.navigate(['/vehicles']);
    }
  }

  protected async acknowledgeAlert(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.alerts.update((list) => list.filter((a) => a.id !== id));
      this.toast.success('Alerte acquittée');
    } catch (err) {
      // handled
      swallow('vehicle-detail:acknowledgeAlert', err);
    }
  }

  /** Date de mise hors service, en clair. Jamais d'affichage vide : on dit « inconnue ». */
  protected dateHorsService(iso: string | null | undefined): string {
    if (!iso) return 'une date inconnue';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? 'une date inconnue'
      : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  /**
   * Bascule SUPER_ADMIN de l'etat d'exploitation (cas speciaux).
   *
   * Meme discipline que le reglage ACC : confirmation, remise en place du controle si
   * l'utilisateur annule ou si l'API refuse, message d'erreur explicite. Un selecteur qui
   * resterait sur la valeur choisie apres un echec ferait croire que l'etat est enregistre.
   */
  protected async changerEtatExploitation(vehicleId: string, ev: Event): Promise<void> {
    const select = ev.target as HTMLSelectElement;
    const precedent = this.vehicle()?.outOfServiceReason ?? '';
    const choisi = select.value as '' | 'ACCIDENT' | 'TRACKER_UNPLUGGED' | 'IMMOBILIZED';
    if (choisi === precedent) return;

    const libelles: Record<string, string> = {
      ACCIDENT: 'accidenté',
      TRACKER_UNPLUGGED: 'boîtier débranché',
      IMMOBILIZED: 'immobilisé',
    };
    const message = choisi
      ? 'Déclarer ce véhicule hors service (' + libelles[choisi] + ') ?\n\n' +
        "L'analyse de ses trajets et ses alertes seront suspendues. " +
        'Aucune donnée existante ne sera supprimée, et la remise en service est immédiate.'
      : 'Remettre ce véhicule en service ?\n\n' +
        'Les traitements et les alertes reprendront normalement.';
    if (!window.confirm(message)) {
      select.value = precedent;
      return;
    }

    // Note facultative. Annuler la saisie ne doit PAS annuler la bascule deja confirmee,
    // d'ou le repli sur une chaine vide plutot qu'un retour anticipe.
    const note = choisi
      ? (window.prompt('Précision (facultatif) : date, n° de dossier, contexte…') ?? '')
      : '';

    this.hsUpdating.set(true);
    try {
      const maj = await firstValueFrom(
        this.vehiclesApi.setOutOfService(vehicleId, { reason: choisi || null, note }),
      );
      this.vehicle.set(maj);
      this.toast.success(
        choisi ? 'Véhicule déclaré hors service' : 'Véhicule remis en service',
        choisi
          ? 'Ses traitements et alertes sont suspendus.'
          : 'Ses traitements et alertes reprennent.',
      );
    } catch (err) {
      swallow('vehicle-detail:changerEtatExploitation', err);
      select.value = precedent; // l'ecran ne doit jamais montrer un etat non enregistre
      const detail =
        err instanceof HttpErrorResponse
          ? err.status === 403
            ? 'Action réservée au super-admin.'
            : err.status === 404
              ? 'Véhicule introuvable.'
              : (err.error?.message ?? err.message ?? 'Erreur inconnue')
          : err instanceof Error
            ? err.message
            : 'Erreur inconnue';
      this.toast.error('Échec de la mise à jour', detail);
    } finally {
      this.hsUpdating.set(false);
    }
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
      swallow('vehicle-detail:toggleAccConnected', err);
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
      this.toast.success('Note enregistrée');
    } catch (err) {
      swallow('vehicle-detail:saveTripNote', err);
      const msg = err instanceof HttpErrorResponse
        ? err.error?.message ?? 'Erreur inconnue'
        : err instanceof Error ? err.message : 'Erreur inconnue';
      this.toast.error('Échec enregistrement note', msg);
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

  // ─── Tracker management ──────────────────────────────────────────

  protected readonly showTrackerPicker = signal(false);
  protected readonly orphanTrackers = signal<Array<{ id: string; imei: string; model: string; status: string }>>([]);
  protected newTrackerImei = '';

  protected canEditVehicle(): boolean {
    return this.perms.can('vehicles_edit');
  }

  /** V1.15 — badge installation derive : tracker + IMEI + SIM => Installé. */
  protected instBadge(): { cls: string; label: string } | null {
    const tr = this.vehicle()?.tracker;
    if (!tr?.imei) return null;
    if (tr.simPhoneNumber) return { cls: 'installed', label: 'Installé' };
    return { cls: 'no-sim', label: 'SIM manquante' };
  }

  protected async detachTracker(trackerId: string): Promise<void> {
    if (!confirm('Détacher ce tracker du véhicule ?')) return;
    try {
      await firstValueFrom(this.trackersApi.unassign(trackerId));
      this.vehicle.update((v) => v ? { ...v, tracker: null } : v);
      this.toast.success('Tracker détaché');
    } catch (err) {
      swallow('vehicle-detail:detachTracker', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : '');
    }
  }

  protected async createAndAssignTracker(): Promise<void> {
    const v = this.vehicle();
    if (!v || !this.newTrackerImei.trim()) return;
    try {
      const tracker = await firstValueFrom(this.trackersApi.create({ imei: this.newTrackerImei.trim() }));
      await firstValueFrom(this.trackersApi.assign(tracker.id, v.id));
      this.showTrackerPicker.set(false);
      this.newTrackerImei = '';
      this.toast.success('Tracker cree et assigne');
      const updated = await firstValueFrom(this.vehiclesApi.findOne(v.id));
      this.vehicle.set(updated);
    } catch (err) {
      swallow('vehicle-detail:createAndAssignTracker', err);
      this.toast.error('Echec', err instanceof HttpErrorResponse ? err.error?.message : '');
    }
  }

  protected async assignTracker(trackerId: string): Promise<void> {
    const v = this.vehicle();
    if (!v) return;
    try {
      await firstValueFrom(this.trackersApi.assign(trackerId, v.id));
      this.showTrackerPicker.set(false);
      this.toast.success('Tracker assigné');
      // Reload vehicle to get updated tracker
      const updated = await firstValueFrom(this.vehiclesApi.findOne(v.id));
      this.vehicle.set(updated);
    } catch (err) {
      swallow('vehicle-detail:assignTracker', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : '');
    }
  }

  // Load orphan trackers when picker opens
  private trackerPickerEffect = effect(() => {
    if (this.showTrackerPicker()) {
      firstValueFrom(this.trackersApi.list({ unassigned: 'true' }))
        .then((list) => this.orphanTrackers.set(list))
        .catch(() => this.orphanTrackers.set([]));
    }
  });

  // ─── Trip replay ──────────────────────────────────────────────────

  protected readonly tripReplayOpen = signal(false);
  protected readonly tripReplayTrip = signal<TripDto | null>(null);

  protected openTripReplay(trip: TripDto): void {
    this.tripReplayTrip.set(trip);
    this.tripReplayOpen.set(true);
  }

  // ─── Trip driver assignment ──────────────────────────────────────

  protected readonly tripDriverPickerOpen = signal(false);
  protected readonly tripDriverPickerTrip = signal<TripDto | null>(null);

  protected openTripDriverPicker(trip: TripDto): void {
    this.tripDriverPickerTrip.set(trip);
    this.tripDriverPickerOpen.set(true);
  }

  protected async onTripDriverPicked(driver: DriverDto | null): Promise<void> {
    const trip = this.tripDriverPickerTrip();
    if (!trip) return;
    this.tripDriverPickerOpen.set(false);
    try {
      const updated = await firstValueFrom(
        this.driversApi.assignToTrip(trip.id, driver?.id ?? null),
      );
      // Met à jour le trip dans la liste locale
      this.vehicleTrips.update((trips) =>
        trips.map((t) => t.id === trip.id ? updated : t),
      );
      this.toast.success(
        driver ? 'Conducteur assigné au trajet' : 'Conducteur retiré du trajet',
        driver ? `${driver.firstName} ${driver.lastName}` : '',
      );
    } catch (err) {
      swallow('vehicle-detail:onTripDriverPicked', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : '');
    }
  }

  // ─── Phase 2 — gestion conducteur courant du vehicule ──────────────

  protected openDriverPicker(): void {
    if (!this.canManageDrivers()) return;
    this.driverPickerOpen.set(true);
  }

  /**
   * Callback du picker. driver=null => retire l'assignation. Sinon affecte
   * et met a jour le signal vehicle local pour refleter l'état sans re-fetch.
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
      swallow('vehicle-detail:onDriverPicked', err);
      this.toast.error('Échec assignation', err instanceof HttpErrorResponse ? err.error?.message : '');
    } finally {
      this.assigningDriver.set(false);
    }
  }

  /** Initiales en majuscule pour la pastille avatar (ex: ED). */
  protected driverInitials(d: { firstName: string; lastName: string }): string {
    return ((d.firstName?.[0] ?? '') + (d.lastName?.[0] ?? '')).toUpperCase() || '?';
  }

  // ─── Drawer creation conducteur depuis le picker ──────────────────

  protected openDriverDrawerFromPicker(): void {
    this.driverPickerOpen.set(false);
    this.driverDrawerData.set({ mode: 'create' });
    this.driverDrawerOpen.set(true);
  }

  protected async onDriverDrawerSave(result: DriverDrawerResult): Promise<void> {
    const v = this.vehicle();
    if (!v) return;
    this.driverDrawerLoading.set(true);
    try {
      const created = await firstValueFrom(this.driversApi.create({
        firstName: result.firstName,
        lastName: result.lastName,
        phone: result.phone,
        email: result.email,
        licenseNumber: result.licenseNumber,
        color: result.color,
        notes: result.notes,
      }));
      this.driverDrawerOpen.set(false);
      // Auto-assigner le conducteur cree au vehicule.
      this.assigningDriver.set(true);
      const updated = await firstValueFrom(
        this.driversApi.assignToVehicle(v.id, created.id),
      );
      this.vehicle.set({
        ...v,
        currentDriver: (updated as { currentDriver: VehicleDetailDto['currentDriver'] }).currentDriver ?? null,
      });
      this.toast.success('Conducteur cree et assigne', `${created.firstName} ${created.lastName}`);
    } catch (err) {
      swallow('vehicle-detail:onDriverDrawerSave', err);
      this.toast.error('Echec', err instanceof HttpErrorResponse ? err.error?.message : 'Erreur inconnue');
    } finally {
      this.driverDrawerLoading.set(false);
      this.assigningDriver.set(false);
    }
  }
}
