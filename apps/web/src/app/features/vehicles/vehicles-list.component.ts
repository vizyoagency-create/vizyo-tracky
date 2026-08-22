import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { VehicleLinkDirective } from '../../shared/directives/vehicle-link.directive';
import { LucideAngularModule, Plus, Truck, ExternalLink, FolderOpen, Radio, X, Save, Wifi, Pencil, Trash2, Eye, Search, LayoutGrid, Table, Layers, ChevronRight, ChevronDown, Gauge, Wrench, ShieldOff, QrCode } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PermissionsService } from '../../core/services/permissions.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { GeocodeService } from '../../core/services/geocode.service';
import { TrackersApiService } from '../../core/services/trackers.service';
import { getVehicleSvg, getVehicleTypeLabel } from '../../shared/utils/vehicle-icons';
import { buildQrSheetHtml, buildTrackyQrSvg } from '../../shared/utils/tracky-qr.util';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { VehicleDialogComponent } from './vehicle-dialog/vehicle-dialog.component';
import { VehicleQrDialogComponent } from './vehicle-qr-dialog.component';
import { VehicleGroupsTabComponent } from './vehicle-groups-tab.component';
import { VehicleCapacityTableComponent } from './vehicle-capacity-table.component';
import { PrivacyModeTabComponent } from './privacy-mode-tab.component';
import { EngineControlButtonComponent } from '../engine-control/engine-control-button.component';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { ConnectivityBadgeComponent } from '../../shared/ui/connectivity-badge/connectivity-badge.component';
import { BrandLogoComponent } from '../../shared/ui/brand-logo/brand-logo.component';
import { InstallReviewBadgeComponent } from '../../shared/ui/install-review-badge/install-review-badge.component';
import { TrackClickDirective } from '../../shared/directives/track-click.directive';
import { BottomSheetComponent } from '../../shared/ui/bottom-sheet/bottom-sheet.component';
import { ZoneComponent, type EtatZone } from '../../shared/ui/zone/zone.component';
import {
  formatSilenceLabel,
  getVehicleConnectivityState,
  getVehiclePresenceState,
  isInstallationToReview,
  isVehicleDormant,
  type VehicleConnectivityState,
  type VehiclePresenceState,
} from '@vizyo/tracky-shared';

/** Les puces de statut de la planche Véhicules. */
type FiltreStatut = 'tous' | 'roulage' | 'arret' | 'hors-ligne' | 'sans-boitier';

@Component({
  selector: 'app-vehicles-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, LucideAngularModule, VehicleDialogComponent, VehicleGroupsTabComponent, VehicleCapacityTableComponent, ConfirmModalComponent, SaFleetBadgeComponent, GroupBadgeComponent, ConnectivityBadgeComponent, BrandLogoComponent, InstallReviewBadgeComponent, TrackClickDirective, EngineControlButtonComponent, VehicleLinkDirective, PrivacyModeTabComponent, VehicleQrDialogComponent, BottomSheetComponent, ZoneComponent],
  template: `
    @if (auth.isWatchman()) {
      <!-- ───────────────────────────────────────────────────────────────────
           Sprint 3 — VUE VEILLEUR « zéro donnée ». Le client ne veut donner
           AUCUNE donnée à ce rôle : pas de statut, vitesse, position, IMEI,
           connectivité, carte, badges, recherche, ni navigation vers le détail.
           Uniquement : plaque + nom du véhicule + bouton Couper/Rallumer (le
           « start/stop » demandé). La règle d'immobilité reste enforce serveur.
           ──────────────────────────────────────────────────────────────────── -->
      <div class="wn-page">
        <div class="wn-header">
          <h1 class="wn-title">Véhicules</h1>
          <p class="wn-sub">
            {{ search().trim() ? filteredVehicles().length + ' résultat(s)' : vehicles().length + ' véhicule(s)' }}
          </p>
        </div>

        @if (loading()) {
          <div class="wn-loading">
            <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="wn-empty">
            <div class="wn-empty-icon"><lucide-icon [img]="Truck" [size]="36"></lucide-icon></div>
            <p class="wn-empty-text">Aucun véhicule accessible</p>
          </div>
        } @else {
          <!-- Recherche rapide (plaque / marque) -->
          <div class="wn-search">
            <lucide-icon [img]="SearchIcon" [size]="16" class="wn-search-ico"></lucide-icon>
            <input type="text" [ngModel]="search()" (ngModelChange)="search.set($event)"
                   data-track="Veilleur — recherche véhicule"
                   placeholder="Rechercher une plaque, une marque…" aria-label="Rechercher un véhicule" />
            @if (search()) {
              <button (click)="search.set('')" class="wn-search-clear" aria-label="Effacer la recherche"
                      data-track="Veilleur — effacer recherche">
                <lucide-icon [img]="XIcon" [size]="15"></lucide-icon>
              </button>
            }
          </div>

          @if (groupedVehicles().length === 0) {
            <div class="wn-empty">
              <p class="wn-empty-text">Aucun véhicule ne correspond à la recherche</p>
              <button (click)="search.set('')" class="wn-reset" data-track="Veilleur — réinitialiser recherche">
                Réinitialiser
              </button>
            </div>
          } @else {
            <!-- Groupes en accordéon (repli ignoré pendant une recherche : tout s'affiche) -->
            <div class="wn-groups">
              @for (section of groupedVehicles(); track section.id ?? '__none__') {
                <div class="wn-group">
                  <button class="wn-group-head" (click)="toggleGroup(section.id ?? '__none__')"
                          [attr.data-track]="'Veilleur — groupe ' + section.name"
                          [attr.aria-expanded]="!wnCollapsed(section.id ?? '__none__')">
                    <lucide-icon [img]="wnCollapsed(section.id ?? '__none__') ? ChevronRightIcon : ChevronDownIcon" [size]="18"></lucide-icon>
                    <lucide-icon [img]="LayersIcon" [size]="14" class="wn-group-ico"></lucide-icon>
                    <span class="wn-group-name">{{ section.name }}</span>
                    <span class="wn-group-count">{{ section.vehicles.length }}</span>
                  </button>
                  @if (!wnCollapsed(section.id ?? '__none__')) {
                    <div class="wn-group-items">
                      @for (v of section.vehicles; track v.id) {
                        <div class="wn-row">
                          <div class="wn-veh">
                            <app-brand-logo [brand]="v.brand" [size]="26" [chip]="true" />
                            <div class="wn-icon" [innerHTML]="getTypeIconHtml(v.type)"></div>
                            <div class="wn-veh-text">
                              <span class="wn-plate" [vehicleLink]="v.id" [attr.title]="'Voir ' + v.plate">{{ v.plate }}</span>
                              @if (v.brand) {
                                <span class="wn-brand">{{ v.brand }} {{ v.model ?? '' }}</span>
                              }
                            </div>
                          </div>
                          @if (v.tracker) {
                            <app-engine-control-button
                              [trackLabel]="'Veilleur ' + v.plate"
                              [trackerId]="v.tracker.id"
                              [vehicleId]="v.id"
                              [vehiclePlate]="v.plate"
                            />
                          } @else {
                            <span class="wn-no-tracker">Pas de boîtier</span>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    } @else {
    <div class="vlist-page">
      <div class="vlist-grid-bg"></div>
      <div class="vlist-glow"></div>

      <!-- Header -->
      <div class="vlist-header">
        <div>
          <span class="vt-eyebrow">Flotte</span>
          <h1 class="vlist-title">{{ vehicles().length }} véhicule{{ vehicles().length > 1 ? 's' : '' }}</h1>
          <p class="vlist-sub">Suivi temps réel de votre flotte</p>
        </div>
        <div class="vlist-actions">
          <div class="tab-switch">
            <button (click)="selectTab('vehicles')" data-track="Onglet Véhicules" class="tab-btn" [class.active]="activeTab() === 'vehicles'">
              <lucide-icon [img]="TruckIcon" [size]="15"></lucide-icon> Véhicules
            </button>
            @if (perms.can('groups_view')) {
              <button (click)="selectTab('groups')" data-track="Onglet Groupes" class="tab-btn" [class.active]="activeTab() === 'groups'">
                <lucide-icon [img]="FolderOpenIcon" [size]="15"></lucide-icon> Groupes
              </button>
            }
            <!-- Maintenance = raccourci vers l'Agenda (consolidé). Conducteurs retiré ici :
                 déjà accessible depuis Utilisateurs, on évite le doublon. -->
            @if (perms.can('agenda_view')) {
              <a routerLink="/agenda" data-track="Onglet Maintenance" class="tab-btn">
                <lucide-icon [img]="WrenchIcon" [size]="15"></lucide-icon> Maintenance
              </a>
            }
            <button (click)="selectTab('capacity')" data-track="Onglet Capacités" class="tab-btn" [class.active]="activeTab() === 'capacity'">
              <lucide-icon [img]="GaugeIcon" [size]="15"></lucide-icon> Capacités
            </button>
            @if (perms.can('privacy_manage')) {
              <button (click)="selectTab('privacy')" data-track="Onglet Mode privé" class="tab-btn" [class.active]="activeTab() === 'privacy'">
                <lucide-icon [img]="ShieldOffIcon" [size]="15"></lucide-icon> Mode privé
              </button>
            }
          </div>
          @if (perms.can('vehicles_create') && activeTab() === 'vehicles') {
            <button (click)="showAddDialog.set(true)" trackClick="vehicule-ajouter" class="add-btn add-btn--inline">
              <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Ajouter
            </button>
          }
          @if (perms.can('qr_manage') && activeTab() === 'vehicles') {
            <button (click)="printAllQr()" trackClick="qr-imprimer-tous" class="add-btn add-btn--inline" title="Imprimer tous les QR de déverrouillage">
              <lucide-icon [img]="QrCodeIcon" [size]="15"></lucide-icon> Imprimer les QR
            </button>
          }
          @if (perms.can('users_view')) {
            <a routerLink="/users/overview" class="overview-link" title="Vue d'ensemble permissions">
              <lucide-icon [img]="EyeIcon" [size]="15"></lucide-icon>
            </a>
          }
        </div>
      </div>

      <!-- FAB mobile : bouton flottant Ajouter (cohérent avec la page Map) -->
      @if (perms.can('vehicles_create') && activeTab() === 'vehicles') {
        <button (click)="showAddDialog.set(true)" trackClick="vehicule-ajouter" class="vlist-fab" aria-label="Ajouter un véhicule">
          <lucide-icon [img]="Plus" [size]="22"></lucide-icon>
        </button>
      }

      @if (activeTab() === 'groups') {
        <app-vehicle-groups-tab />
      } @else if (activeTab() === 'capacity') {
        <app-vehicle-capacity-table />
      } @else if (activeTab() === 'privacy') {
        <app-privacy-mode-tab [vehicles]="filteredVehicles()" (changed)="loadVehicles()" />
      } @else {
        @if (!loading() && vehicles().length > 0) {
          <div class="vlist-toolbar">
            <div class="vlist-search">
              <lucide-icon [img]="SearchIcon" [size]="15" class="vlist-search-icon"></lucide-icon>
              <input type="text" [ngModel]="search()" (ngModelChange)="search.set($event)"
                     placeholder="Rechercher : plaque, marque, modèle, IMEI..."
                     aria-label="Rechercher un véhicule" />
              @if (search()) {
                <button (click)="search.set('')" class="vlist-search-clear" aria-label="Effacer la recherche">
                  <lucide-icon [img]="XIcon" [size]="14"></lucide-icon>
                </button>
              }
            </div>
            @if (groupOptions().length > 0) {
              <div class="vlist-group-filter">
                <lucide-icon [img]="LayersIcon" [size]="14" class="vlist-group-filter-ico"></lucide-icon>
                <select [ngModel]="groupFilter()" (ngModelChange)="groupFilter.set($event)"
                        aria-label="Filtrer par groupe">
                  <option value="">Tous les groupes</option>
                  @for (g of groupOptions(); track g.id) {
                    <option [value]="g.id">{{ g.name }}</option>
                  }
                </select>
              </div>
            }
            <span class="vlist-count">{{ filteredVehicles().length }} / {{ vehicles().length }}</span>
            <!-- Entrée MOBILE des filtres : sur téléphone la barre d'outils ci-dessus
                 est masquée (ses commandes tombaient à 20 px de haut). -->
            <button type="button" class="vf-declencheur" (click)="filtresOuverts.set(true)"
                    [attr.aria-label]="'Filtrer — ' + filteredVehicles().length + ' véhicules affichés'">
              <lucide-icon [img]="LayersIcon" [size]="15"></lucide-icon>
              Filtrer
              @if (filtresActifs()) { <span class="vf-pastille" aria-hidden="true"></span> }
            </button>
            <div class="view-switch">
              <button (click)="setViewMode('cards')" class="view-btn" [class.active]="viewMode() === 'cards'"
                      title="Vue cartes" aria-label="Vue cartes">
                <lucide-icon [img]="LayoutGridIcon" [size]="15"></lucide-icon>
              </button>
              <button (click)="setViewMode('table')" class="view-btn" [class.active]="viewMode() === 'table'"
                      title="Vue tableau" aria-label="Vue tableau">
                <lucide-icon [img]="TableIcon" [size]="15"></lucide-icon>
              </button>
              <button (click)="setViewMode('grouped')" class="view-btn" [class.active]="viewMode() === 'grouped'"
                      title="Vue groupée" aria-label="Vue groupée par groupe">
                <lucide-icon [img]="LayersIcon" [size]="15"></lucide-icon>
              </button>
            </div>
          </div>
        }
        <!-- Les six états du kit, rendus une fois. Le rond de chargement devient un
             squelette (règle 2 du kit), et « vide » cesse d'absorber « erreur » :
             une API tombée annonçait « Aucun véhicule dans votre flotte ». -->
        @if (etatZone() !== 'rempli' && etatZone() !== 'partiel') {
          <app-zone [etat]="etatZone()" quoi="Vos véhicules"
                    vide="Aucun véhicule dans votre flotte"
                    videDetail="Ajoutez un véhicule pour commencer à le suivre."
                    erreur="Impossible de charger vos véhicules"
                    erreurDetail="Votre flotte n'est pas vide : c'est la liste qui n'a pas pu être récupérée."
                    (reessayer)="loadVehicles()" />
        } @else {
          @if (etatZone() === 'partiel') {
            <app-zone [etat]="'partiel'"
                      partiel="Liste peut-être incomplète — le dernier rafraîchissement a échoué."
                      (reessayer)="loadVehicles()" />
          }
          @if (filteredVehicles().length === 0) {
            <!-- Un filtre qui ne renvoie rien n'est PAS une flotte vide : on le dit,
                 et on offre la sortie. Encore faut-il offrir LA BONNE : le vide a
                 deux causes distinctes ici, et une seule des deux se répare avec le
                 bouton « Réinitialiser ». Voir societeSansVehicule plus bas. -->
            <div class="vlist-empty">
              <div class="empty-icon"><lucide-icon [img]="Truck" [size]="36"></lucide-icon></div>
              @if (societeSansVehicule()) {
                <p class="empty-text">Cette société n'a aucun véhicule</p>
                <p class="empty-detail">Les autres véhicules appartiennent à d'autres sociétés.</p>
                <button (click)="voirToutesLesSocietes()" class="empty-cta">
                  Voir toutes les sociétés
                </button>
              } @else {
                <p class="empty-text">Aucun véhicule ne correspond à vos filtres</p>
                <button (click)="reinitialiserFiltres()" class="empty-cta">
                  Voir les {{ vehiculesDuPerimetre().length }} véhicules
                </button>
              }
            </div>
          } @else if (viewMode() === 'table') {
          <div class="v-table-wrap">
            <table class="v-table">
              <thead>
                <tr>
                  <th>Plaque</th>
                  <th>Véhicule</th>
                  <th>Statut</th>
                  <th>Tracker</th>
                  <th class="v-th-actions"></th>
                </tr>
              </thead>
              <tbody>
                @for (v of filteredVehicles(); track v.id) {
                  <tr class="v-row">
                    <td class="v-td-plate"><a [routerLink]="['/vehicles', v.id]">{{ v.plate }}</a></td>
                    <td>
                      <span class="v-td-veh">
                        <app-brand-logo [brand]="v.brand" [size]="20" [chip]="true" />
                        @if (v.brand) {
                          <span>{{ v.brand }} {{ v.model ?? '' }}</span>
                        } @else {
                          <span class="muted">Non renseigné</span>
                        }
                        @if (v.year) { <span class="v-td-year">· {{ v.year }}</span> }
                        @if (v.group) { <app-group-badge [group]="v.group" /> }
                      </span>
                    </td>
                    <td>
                      @if (liveStatus(v.id); as ls) {
                        <span class="v-live-pill" [class]="ls.cssClass">
                          <span class="v-live-dot"></span>
                          @if (ls.kind === 'moving') { {{ ls.speedKmh }} km/h }
                          @else if (ls.kind === 'idle') { À l'arrêt }
                          @else { Stationné }
                        </span>
                      } @else {
                        <app-connectivity-badge [state]="presence(v)" [lastSeenAt]="lastSeenOf(v)" />
                      }
                      @if (installToReview(v)) { <app-install-review-badge /> }
                    </td>
                    <td>
                      @if (v.tracker) {
                        <span class="v-td-imei">{{ v.tracker.imei }}</span>
                      } @else {
                        <span class="muted">Pas de tracker</span>
                      }
                    </td>
                    <td class="v-td-actions">
                      <a [routerLink]="['/vehicles', v.id]" class="v-action-btn view" title="Voir"
                         [attr.aria-label]="'Voir ' + v.plate">
                        <lucide-icon [img]="EyeIcon" [size]="15"></lucide-icon>
                      </a>
                      @if (perms.can('vehicles_edit')) {
                        <button class="v-action-btn edit" (click)="openEditVehicle(v)" title="Modifier"
                                [attr.aria-label]="'Modifier ' + v.plate">
                          <lucide-icon [img]="PencilIcon" [size]="15"></lucide-icon>
                        </button>
                      }
                      @if (perms.can('vehicles_delete')) {
                        <button class="v-action-btn delete" (click)="confirmDeleteVehicle(v)" title="Supprimer"
                                [attr.aria-label]="'Supprimer ' + v.plate">
                          <lucide-icon [img]="Trash2Icon" [size]="15"></lucide-icon>
                        </button>
                      }
                      @if (perms.can('qr_manage', v.id)) {
                        <button class="v-action-btn" (click)="openQr(v)" title="QR de déverrouillage"
                                [attr.aria-label]="'QR ' + v.plate">
                          <lucide-icon [img]="QrCodeIcon" [size]="15"></lucide-icon>
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (viewMode() === 'grouped') {
          <!-- Tableau groupé (réf. maquette Vehicules.dc.html) : colonnes
               Véhicule / Statut / Vitesse / Conducteur / Dernière position. -->
          <div class="v-gtable">
            <div class="v-gt-head">
              <span class="v-gt-h">Véhicule</span>
              <span class="v-gt-h">Statut</span>
              <span class="v-gt-h">Vitesse</span>
              <span class="v-gt-h v-col-drv">Conducteur</span>
              <span class="v-gt-h v-col-pos">Dernière position</span>
              <span></span>
            </div>
            @for (section of groupedVehicles(); track section.id ?? '__none__') {
              <button class="v-gt-group" [id]="'vg-' + (section.id ?? 'none')"
                      (click)="toggleGroup(section.id ?? '__none__')"
                      [attr.aria-expanded]="!isCollapsed(section.id ?? '__none__')">
                <lucide-icon [img]="isCollapsed(section.id ?? '__none__') ? ChevronRightIcon : ChevronDownIcon" [size]="14"></lucide-icon>
                <lucide-icon [img]="LayersIcon" [size]="14" class="v-gt-group-ico" [class.none]="!section.id"></lucide-icon>
                <span class="v-gt-group-name" [class.none]="!section.id">{{ section.id ? section.name : 'Sans groupe' }}</span>
                <span class="v-gt-group-count mono">{{ section.vehicles.length }} véhicule{{ section.vehicles.length > 1 ? 's' : '' }}</span>
              </button>
              @if (!isCollapsed(section.id ?? '__none__')) {
                @for (v of section.vehicles; track v.id) {
                  <a [routerLink]="['/vehicles', v.id]" [queryParams]="groupedLinkParams(section.id)" class="v-trow">
                    <div class="v-trow-veh">
                      <span class="v-trow-ico" [innerHTML]="getTypeIconHtml(v.type)"></span>
                      <div class="v-trow-veh-txt">
                        <div class="v-trow-plate mono">{{ v.plate }}</div>
                        <div class="v-trow-model">{{ v.brand ? (v.brand + ' ' + (v.model ?? '')) : 'Non renseigné' }}</div>
                      </div>
                    </div>
                    <span class="v-trow-status">
                      @if (liveStatus(v.id); as ls) {
                        <span class="v-live-pill" [class]="ls.cssClass">
                          <span class="v-live-dot"></span>
                          @if (ls.kind === 'moving') { Roule } @else if (ls.kind === 'idle') { Au ralenti } @else { À l'arrêt }
                        </span>
                      } @else {
                        <app-connectivity-badge [state]="presence(v)" [lastSeenAt]="lastSeenOf(v)" [compact]="true" />
                        @if (isDormant(v)) {
                          <!-- Le badge compact n'affiche que l'icône : sans ce texte, l'ancienneté
                               (le seul chiffre qui distingue un congé d'un boîtier arraché) serait
                               enfermée dans l'infobulle, donc invisible au tactile. -->
                          <span class="v-dormant-age">Dormant · {{ silenceLabel(v) }}</span>
                        }
                      }
                      @if (installToReview(v)) { <app-install-review-badge [compact]="true" /> }
                    </span>
                    <span class="v-trow-speed"
                          [class.spd-move]="liveStatus(v.id)?.kind === 'moving'"
                          [class.spd-idle]="liveStatus(v.id)?.kind === 'idle'">
                      @if (liveStatus(v.id); as ls) { {{ ls.speedKmh }}<span class="v-trow-speed-u"> km/h</span> } @else { <span class="v-trow-dash">—</span> }
                    </span>
                    <span class="v-trow-drv v-col-drv" [class.v-trow-dash]="!v.currentDriver">{{ driverLabel(v) }}</span>
                    <div class="v-trow-pos v-col-pos">
                      @if (positionFor(v.id)) {
                        <!-- DORMANCE — l'adresse d'un dormant est un souvenir, pas une position :
                             « Position en cours… » y serait un mensonge pur. On garde la valeur
                             (on ne masque rien) mais on la DATE explicitement en dessous. -->
                        <div class="v-trow-addr" [class.v-trow-stale]="isDormant(v)">
                          {{ addressFor(v.id) || (isDormant(v) ? 'Dernière position connue' : 'Position en cours…') }}
                        </div>
                        <div class="v-trow-ago mono">{{ posAgeLabel(v) }}</div>
                      } @else {
                        <div class="v-trow-addr v-trow-dash">Hors ligne</div>
                        @if (v.tracker?.lastSeenAt) { <div class="v-trow-ago mono">{{ lastContactLabel(v) }}</div> }
                      }
                    </div>
                    <lucide-icon [img]="ChevronRightIcon" [size]="15" class="v-trow-chev"></lucide-icon>
                  </a>
                }
              }
            }
          </div>
        } @else {
          <div class="v-grid">
            @for (v of filteredVehicles(); track v.id) {
              <a [routerLink]="['/vehicles', v.id]" class="v-card">
                <div class="v-card-glow" [class]="connectivity(v) === 'ONLINE' ? 'online' : 'offline'"></div>
                <div class="v-card-top">
                  <div class="v-plate-wrap">
                    <div class="v-type-icon" [class]="connectivity(v) === 'ONLINE' ? 'online' : 'offline'"
                      [innerHTML]="getTypeIconHtml(v.type)"></div>
                    <span class="v-plate">{{ v.plate }}</span>
                    <app-brand-logo [brand]="v.brand" [size]="24" [chip]="true" />
                  </div>
                  @if (v.year) {
                    <span class="v-year">{{ v.year }}</span>
                  }
                </div>
                <!-- V1.15 — Badge contextuel SUPER_ADMIN : nom de flotte. -->
                <app-sa-fleet-badge [fleetId]="v.fleetId" />
                @if (v.currentDriver; as d) {
                  <!-- V1.15 — Driver actuel : visible pour tous (info utile, pas
                       reservee SA). Petit chip discret avec pastille couleur. -->
                  <span class="v-driver-chip" [title]="'Conducteur : ' + d.firstName + ' ' + d.lastName">
                    <span class="v-driver-dot" [style.background]="d.color ?? '#10b981'"></span>
                    {{ d.firstName }} {{ d.lastName.charAt(0) }}.
                  </span>
                }
                <div class="v-card-mid">
                  @if (v.brand) {
                    <span class="v-brand">{{ v.brand }} {{ v.model ?? '' }}</span>
                  } @else {
                    <span class="v-brand muted">Non renseigné</span>
                  }
                  @if (liveStatus(v.id); as ls) {
                    <span class="v-live-pill" [class]="ls.cssClass">
                      <span class="v-live-dot"></span>
                      @if (ls.kind === 'moving') {
                        {{ ls.speedKmh }} km/h
                      } @else if (ls.kind === 'idle') {
                        À l'arrêt · moteur ON
                      } @else {
                        Stationné
                      }
                    </span>
                  }
                  <app-connectivity-badge [state]="presence(v)" [lastSeenAt]="lastSeenOf(v)" [hideWhenOnline]="true" />
                  @if (installToReview(v)) { <app-install-review-badge /> }
                  @if (instBadge(v); as b) {
                    <span class="v-inst" [class]="'v-inst--' + b.cls">{{ b.label }}</span>
                  }
                  @if (v.group) { <app-group-badge [group]="v.group" /> }
                </div>
                <div class="v-card-bottom">
                  <div class="v-tracker-info">
                    @if (v.tracker) {
                      <div class="v-tracker">
                        <lucide-icon [img]="RadioIcon" [size]="11"></lucide-icon>
                        <span>{{ v.tracker.imei }}</span>
                      </div>
                    } @else if (perms.can('vehicles_edit')) {
                      <button (click)="$event.preventDefault(); $event.stopPropagation(); openAssignTracker(v.id)" class="v-assign-btn">
                        + Assigner tracker
                      </button>
                    } @else {
                      <span class="v-no-tracker">Pas de tracker</span>
                    }
                  </div>
                  <div class="v-actions">
                    <a [routerLink]="['/vehicles', v.id]" class="v-action-btn view"
                       [attr.aria-label]="'Voir le véhicule ' + v.plate"
                       title="Voir" (click)="$event.stopPropagation()">
                      <lucide-icon [img]="EyeIcon" [size]="15" aria-hidden="true"></lucide-icon>
                    </a>
                    @if (perms.can('vehicles_edit')) {
                      <button class="v-action-btn edit"
                              [attr.aria-label]="'Modifier le véhicule ' + v.plate"
                              title="Modifier"
                              (click)="$event.preventDefault(); $event.stopPropagation(); openEditVehicle(v)">
                        <lucide-icon [img]="PencilIcon" [size]="15" aria-hidden="true"></lucide-icon>
                      </button>
                    }
                    @if (perms.can('vehicles_delete')) {
                      <button class="v-action-btn delete"
                              [attr.aria-label]="'Supprimer le véhicule ' + v.plate"
                              title="Supprimer"
                              (click)="$event.preventDefault(); $event.stopPropagation(); confirmDeleteVehicle(v)">
                        <lucide-icon [img]="Trash2Icon" [size]="15" aria-hidden="true"></lucide-icon>
                      </button>
                    }
                    @if (perms.can('qr_manage', v.id)) {
                      <button class="v-action-btn"
                              [attr.aria-label]="'QR ' + v.plate"
                              title="QR de déverrouillage"
                              (click)="$event.preventDefault(); $event.stopPropagation(); openQr(v)">
                        <lucide-icon [img]="QrCodeIcon" [size]="15" aria-hidden="true"></lucide-icon>
                      </button>
                    }
                  </div>
                </div>
              </a>
            }
          </div>
          }
        }

        <!-- ═══ FILTRES EN FEUILLE (planche Véhicules) ═══════════════════════
             Le pied annonce le résultat AVANT de fermer : on sait ce qu'on
             obtient sans avoir à refermer pour aller voir. -->
        <app-bottom-sheet [open]="filtresOuverts()" (closed)="filtresOuverts.set(false)" ariaLabel="Filtrer les véhicules">
          <div class="vf-bloc">
            <p class="vf-titre">Statut</p>
            <div class="vf-puces">
              @for (f of FILTRES_STATUT; track f.id) {
                <button type="button" class="vf-puce"
                        [class.vf-puce--active]="statutFiltre() === f.id"
                        [attr.aria-pressed]="statutFiltre() === f.id"
                        (click)="statutFiltre.set(f.id)">
                  {{ f.label }} <span class="vf-puce-n">{{ compteursStatut()[f.id] }}</span>
                </button>
              }
            </div>
          </div>

          @if (groupOptions().length > 0) {
            <div class="vf-bloc">
              <p class="vf-titre">Groupe</p>
              <div class="vf-puces">
                <button type="button" class="vf-puce" [class.vf-puce--active]="groupFilter() === ''"
                        [attr.aria-pressed]="groupFilter() === ''" (click)="groupFilter.set('')">Tous</button>
                @for (g of groupOptions(); track g.id) {
                  <button type="button" class="vf-puce" [class.vf-puce--active]="groupFilter() === g.id"
                          [attr.aria-pressed]="groupFilter() === g.id" (click)="groupFilter.set(g.id)">{{ g.name }}</button>
                }
              </div>
            </div>
          }

          <div class="vf-bloc">
            <p class="vf-titre">Rechercher</p>
            <input type="text" class="vf-recherche" [ngModel]="search()" (ngModelChange)="search.set($event)"
                   placeholder="Plaque, marque, modèle, IMEI…" aria-label="Rechercher un véhicule" />
          </div>

          <div class="vf-pied">
            <button type="button" class="vf-reinit" (click)="reinitialiserFiltres()">Réinitialiser</button>
            <button type="button" class="vf-voir" (click)="filtresOuverts.set(false)">
              Voir {{ filteredVehicles().length }} véhicule{{ filteredVehicles().length > 1 ? 's' : '' }}
            </button>
          </div>
        </app-bottom-sheet>

        <app-vehicle-dialog
          [open]="showAddDialog() || showEditDialog()"
          [mode]="showEditDialog() ? 'edit' : 'create'"
          [vehicleId]="editVehicleId()"
          (done)="onDialogClosed()"
        />
      }

      @if (qrVehicle(); as qv) {
        <app-vehicle-qr-dialog [vehicleId]="qv.id" [plate]="qv.plate" (closed)="qrVehicle.set(null)" />
      }

      <!-- Assign Tracker Drawer -->
      @if (showAssignTracker()) {
        <div class="fixed inset-0 z-[9000] flex justify-end">
          <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="showAssignTracker.set(false)"></div>
          <div class="relative w-full max-w-md max-h-full bg-bg-primary border-l border-border-subtle shadow-2xl
                      flex flex-col animate-slide-in overflow-hidden drawer-overlay-safe">
            <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="RadioIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Assigner un tracker</h2>
                  <p class="text-[10px] text-fg-tertiary">Véhicule {{ assignPlate() }}</p>
                </div>
              </div>
              <button (click)="showAssignTracker.set(false)"
                class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
                <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
              </button>
            </div>
            <div class="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              @if (assignError()) {
                <div class="p-3 rounded-xl text-sm" style="background:color-mix(in srgb, var(--danger) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger) 28%, transparent); color:var(--danger)">{{ assignError() }}</div>
              }
              <div>
                <label class="block text-[11px] font-semibold text-fg-tertiary mb-1">IMEI DU TRACKER *</label>
                <input type="text" [(ngModel)]="assignImei" placeholder="123456789012345" maxlength="15"
                  class="w-full px-3.5 py-2.5 rounded-xl bg-bg-secondary border-[1.5px] border-border-subtle text-fg-primary text-sm font-mono tracking-wider
                         placeholder:text-fg-tertiary focus:outline-none focus:border-[var(--tracky)]" />
                <p class="text-[10px] text-fg-tertiary mt-1">15 chiffres, visible sur l'étiquette du boîtier</p>
              </div>
              <div>
                <label class="block text-[11px] font-semibold text-fg-tertiary mb-1">MODÈLE (OPTIONNEL)</label>
                <input type="text" [(ngModel)]="assignModel" placeholder="Coban GPS403D"
                  class="w-full px-3.5 py-2.5 rounded-xl bg-bg-secondary border-[1.5px] border-border-subtle text-fg-primary text-sm
                         placeholder:text-fg-tertiary focus:outline-none focus:border-[var(--tracky)]" />
              </div>
            </div>
            <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
              <button (click)="showAssignTracker.set(false)"
                class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle
                       hover:text-fg-primary transition-colors cursor-pointer">
                Annuler
              </button>
              <button (click)="onAssignTracker()" [disabled]="assignLoading() || assignImei.length !== 15"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                @if (assignLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                } @else {
                  <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
                }
                Assigner
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Delete Vehicle Modal -->
      <app-confirm-modal
        [open]="showDeleteVehicle()"
        title="Supprimer le véhicule"
        [description]="'Supprimer <strong>' + (vehicleToDelete()?.plate ?? '') + '</strong> ? Les trajets et alertes associés seront aussi supprimés.'"
        confirmLabel="Supprimer"
        [danger]="true"
        [loading]="deleting()"
        (confirmed)="onDeleteVehicle()"
        (cancelled)="showDeleteVehicle.set(false)"
      />
    </div>
    }
  `,
  styles: [`
    /* ─── Sprint 3 — Vue veilleur « zéro donnée » : liste épurée plaque + bouton ─── */
    .wn-page { position: relative; max-width: 720px; margin: 0 auto }
    .wn-header { margin-bottom: 18px }
    .wn-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .wn-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .wn-loading { display: flex; justify-content: center; padding: 60px 0 }
    .wn-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 50px 20px }
    .wn-empty-icon { width: 60px; height: 60px; border-radius: 16px; background: var(--bg-tertiary);
      display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }
    .wn-empty-text { font-size: 14px; color: var(--fg-tertiary) }
    .wn-list { display: flex; flex-direction: column; gap: 10px }
    .wn-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 16px; border-radius: 14px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .wn-veh { display: flex; align-items: center; gap: 12px; min-width: 0 }
    .wn-icon {
      width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: var(--bg-tertiary); color: var(--fg-secondary);
    }
    .wn-icon :deep(svg) { width: 20px; height: 20px }
    .wn-veh-text { display: flex; flex-direction: column; min-width: 0 }
    .wn-plate { font-size: 16px; font-weight: 800; color: var(--fg-primary);
      font-family: var(--font-mono, monospace); letter-spacing: .03em }
    .wn-brand { font-size: 12px; color: var(--fg-tertiary); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis }
    .wn-no-tracker { font-size: 12px; color: var(--fg-tertiary); font-style: italic; flex-shrink: 0 }
    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : les quatre actions par ligne (voir, modifier, supprimer, QR)
       faisaient 36 × 36, et « Supprimer » est justement celle qu'on ne veut pas rater
       en visant « Voir ». Les trois bascules de vue et « Assigner un boîtier » aussi. */
    @media (max-width: 768px) {
      .v-action-btn,
      .v-assign-btn,
      .view-btn,
      .overview-link { min-width: 44px; min-height: 44px }
    }

    @media (max-width: 480px) {
      .wn-row { flex-wrap: wrap }
    }
    /* Veilleur — recherche rapide */
    .wn-search {
      display: flex; align-items: center; gap: 9px; margin-bottom: 16px;
      padding: 11px 14px; border-radius: 13px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .wn-search:focus-within { border-color: rgba(16,224,160,.4) }
    .wn-search-ico { color: var(--fg-tertiary); flex-shrink: 0 }
    .wn-search input { flex: 1; min-width: 0; background: none; border: none; outline: none;
      color: var(--fg-primary); font-size: 15px }
    .wn-search input::placeholder { color: var(--fg-tertiary) }
    .wn-search-clear { display: flex; align-items: center; background: none; border: none;
      color: var(--fg-tertiary); cursor: pointer; padding: 0 }
    .wn-search-clear:hover { color: var(--fg-primary) }
    .wn-reset { margin-top: 4px; padding: 8px 16px; border-radius: 10px; border: 1px solid var(--border-subtle);
      background: var(--bg-secondary); color: var(--fg-secondary); font-size: 13px; font-weight: 600; cursor: pointer }
    .wn-reset:hover { color: var(--fg-primary); border-color: var(--border-strong) }
    /* Veilleur — accordéon par groupe */
    .wn-groups { display: flex; flex-direction: column; gap: 12px }
    .wn-group { border-radius: 14px; overflow: hidden }
    .wn-group-head {
      display: flex; align-items: center; gap: 9px; width: 100%;
      padding: 12px 14px; border-radius: 12px; cursor: pointer;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); text-align: left; transition: border-color .15s, background .15s;
    }
    .wn-group-head:hover { border-color: var(--border-strong) }
    .wn-group-head lucide-icon { color: var(--fg-tertiary); flex-shrink: 0 }
    .wn-group-ico { color: var(--tracky-light) !important }
    .wn-group-name { flex: 1; font-size: 14px; font-weight: 700; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .wn-group-count { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px;
      background: var(--bg-secondary); color: var(--fg-tertiary); flex-shrink: 0 }
    .wn-group-items { display: flex; flex-direction: column; gap: 8px; padding: 8px 0 2px }

    .vlist-page { position: relative; min-height: 100% }
    .vlist-grid-bg {
      position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden;
    }
    .vlist-grid-bg::before {
      content: ''; position: absolute; top: -10%; left: -15%; width: 55%; height: 60%;
      background: radial-gradient(ellipse, rgba(16,224,160,.08) 0%, transparent 70%);
      border-radius: 50% 40% 60% 30%;
      animation: morph1 12s ease-in-out infinite alternate;
    }
    .vlist-grid-bg::after {
      content: ''; position: absolute; bottom: -20%; right: -10%; width: 50%; height: 55%;
      background: radial-gradient(ellipse, rgba(16,224,160,.055) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%;
      animation: morph2 10s ease-in-out infinite alternate;
    }
    .vlist-glow {
      position: fixed; top: 30%; left: 50%; transform: translate(-50%, -50%); width: 35%; height: 40%;
      background: radial-gradient(ellipse, rgba(16,224,160,.035) 0%, transparent 70%);
      border-radius: 60% 40% 50% 30%;
      pointer-events: none; z-index: 0;
      animation: morph3 14s ease-in-out infinite alternate;
    }
    @keyframes morph1 { 0%{border-radius:50% 40% 60% 30%; transform:translate(0,0)} 100%{border-radius:30% 60% 40% 50%; transform:translate(5%,8%)} }
    @keyframes morph2 { 0%{border-radius:40% 60% 30% 50%; transform:translate(0,0)} 100%{border-radius:60% 30% 50% 40%; transform:translate(-5%,-5%)} }
    @keyframes morph3 { 0%{border-radius:60% 40% 50% 30%; transform:translate(-50%,-50%) scale(1)} 100%{border-radius:40% 50% 30% 60%; transform:translate(-50%,-50%) scale(1.15)} }

    .vlist-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; gap: 12px; flex-wrap: wrap }
    .vlist-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .vlist-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .vlist-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap }
    @media (max-width: 640px) {
      .vlist-header { flex-direction: column }
      .vlist-actions { width: 100%; justify-content: flex-start; gap: 8px; flex-wrap: nowrap }
      /* Le pill occupe la largeur restante et défile ; l'œil (vue d'ensemble) reste à droite. */
      .tab-switch { flex: 1 1 auto; min-width: 0 }
    }

    /* Segmented pill défilable horizontalement : sur mobile les onglets dépassent la
       largeur → défilement tactile (scrollbar masquée) plutôt qu'une troncature. */
    .tab-switch {
      display: flex; border-radius: 10px; border: 1px solid var(--border-subtle);
      overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;
      scrollbar-width: none; -ms-overflow-style: none; min-width: 0; max-width: 100%;
    }
    .tab-switch::-webkit-scrollbar { display: none; }
    .tab-btn {
      flex: 0 0 auto; white-space: nowrap;
      display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: 12px; font-weight: 600;
      background: var(--bg-secondary); color: var(--fg-tertiary); cursor: pointer; transition: all .2s; border: none;
    }
    .tab-btn:hover { color: var(--fg-secondary) }
    .tab-btn.active { background: var(--tracky-light); color: var(--accent-ink) }

    .add-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px; font-size: 12px; font-weight: 700;
      background: var(--tracky-light); color: var(--accent-ink); border: none; cursor: pointer; box-shadow: var(--shadow-tracky-glow); transition: filter .15s;
    }
    .add-btn:hover { filter: brightness(1.05) }

    /* ═══ FILTRES EN FEUILLE ══════════════════════════════════════════════════
       Toutes les commandes à 44 px : la barre d'outils du haut mettait un champ de
       recherche de 20 px de haut et un select de 20 px — mesuré à 375 px le
       2026-08-12, soit moins de la moitié du plancher tactile. */
    .vf-declencheur {
      display: none;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-tertiary);
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .vf-pastille {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--tracky);
      flex-shrink: 0;
    }
    .vf-bloc { margin-bottom: 18px; }
    .vf-titre {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--fg-secondary);
      margin: 0 0 8px;
    }
    .vf-puces { display: flex; flex-wrap: wrap; gap: 8px; }
    .vf-puce {
      min-height: 44px;
      padding: 8px 14px;
      border-radius: 9999px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-tertiary);
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .vf-puce--active {
      background: color-mix(in srgb, var(--tracky) 15%, transparent);
      border-color: color-mix(in srgb, var(--tracky) 40%, transparent);
      color: var(--texte-succes);
    }
    .vf-puce-n { font-variant-numeric: tabular-nums; margin-left: 4px; opacity: .8; }
    .vf-recherche {
      width: 100%;
      min-height: 44px;
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-tertiary);
      color: var(--fg-primary);
      font-size: 14px;
      /* Sans min-width:0 un champ en boîte flexible refuse de descendre sous la
         largeur de son placeholder et fait déborder la feuille. */
      min-width: 0;
    }
    .vf-pied {
      display: flex;
      gap: 10px;
      padding-top: 14px;
      border-top: 1px solid var(--border-subtle);
    }
    .vf-reinit, .vf-voir {
      flex: 1;
      min-height: 48px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      border: 1px solid var(--border-subtle);
    }
    .vf-reinit { background: transparent; color: var(--fg-secondary); }
    .vf-voir {
      background: var(--tracky);
      border-color: var(--tracky);
      color: var(--accent-ink);
    }
    /* Sous 768 px la barre d'outils cède la place à la feuille : ses commandes y
       tombaient à 20 px, et la planche les sort dans une feuille. */
    @media (max-width: 768px) {
      .vf-declencheur { display: inline-flex; }
      .vlist-search, .vlist-group-filter { display: none; }
    }

    /* FAB mobile : visible uniquement < 768px (cohérent avec Map FAB).
       Doit se poser AU-DESSUS de la bottom-bar (60-72px selon iOS PWA bump
       + safe-area + 6). On garde 20px de marge au-dessus de la barre, en
       prenant en compte le bump iOS (min-height 52px sur .bottom-item). */
    .vlist-fab {
      display: none;
      position: fixed;
      bottom: calc(env(safe-area-inset-bottom) + 88px);
      right: 16px;
      z-index: 1500;
      width: 52px; height: 52px;
      border-radius: 50%;
      border: 0;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      isolation: isolate;
      overflow: hidden;
      color: var(--accent-ink);
      background: var(--color-tracky-light);
      box-shadow:
        0 10px 26px -8px color-mix(in srgb, var(--color-tracky-light) 55%, transparent),
        0 2px 8px rgba(0,0,0,.14);
      opacity: 1;
      transition: transform .25s cubic-bezier(0.34, 1.56, 0.64, 1), filter .2s, opacity .2s;
    }
    .vlist-fab:hover { opacity: 1; filter: brightness(1.05); }
    .vlist-fab:active { transform: scale(.92); opacity: 1; filter: brightness(1.08); }
    @keyframes vlist-fab-gradient {
      0%, 100% { background-position: 0% 50% }
      50%      { background-position: 100% 50% }
    }
    @media (prefers-reduced-motion: reduce) {
      .vlist-fab { animation: none; }
    }
    @media (max-width: 640px) {
      .vlist-fab { display: flex; }
      .add-btn--inline { display: none; }
    }

    .overview-link {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); text-decoration: none; transition: all .15s;
    }
    .overview-link:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.3) }

    .vlist-loading { position: relative; z-index: 1; display: flex; justify-content: center; padding: 60px 0 }

    /* #2 — barre de recherche véhicules */
    .vlist-toolbar { position: relative; z-index: 1; display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap }
    .vlist-search { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px; max-width: 440px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 8px 12px }
    .vlist-search:focus-within { border-color: rgba(16,224,160,.4) }
    .vlist-search-icon { color: var(--fg-tertiary); flex-shrink: 0 }
    .vlist-search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--fg-primary); font-size: 13px }
    .vlist-search input::placeholder { color: var(--fg-tertiary) }
    .vlist-search-clear { display: flex; align-items: center; background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 0 }
    .vlist-search-clear:hover { color: var(--fg-primary) }
    .vlist-group-filter { display: flex; align-items: center; gap: 6px; padding: 0 10px; height: 38px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px }
    .vlist-group-filter:focus-within { border-color: rgba(16,224,160,.4) }
    .vlist-group-filter-ico { color: var(--fg-tertiary); flex-shrink: 0 }
    .vlist-group-filter select { background: none; border: none; outline: none; color: var(--fg-primary);
      font-size: 13px; cursor: pointer; max-width: 180px }
    .vlist-group-filter select option { background: var(--bg-secondary); color: var(--fg-primary) }
    .vlist-count { font-size: 12px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap }

    /* #3 — toggle cartes / tableau */
    .view-switch { display: flex; margin-left: auto; border-radius: 9px; border: 1px solid var(--border-subtle); overflow: hidden }
    .view-btn { display: flex; align-items: center; padding: 7px 11px; background: var(--bg-secondary); color: var(--fg-tertiary); border: none; cursor: pointer; transition: all .2s }
    .view-btn:hover { color: var(--fg-secondary) }
    .view-btn.active { background: var(--tracky-light); color: var(--accent-ink) }

    /* #3 — vue tableau véhicules */
    /* ─── Tableau groupé (réf. maquette Vehicules.dc.html) ─── */
    .v-gtable { position: relative; z-index: 1; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 18px; overflow: hidden }
    .v-gt-head, .v-trow { display: grid; grid-template-columns: minmax(170px,2fr) 132px 92px 1.2fr 1.7fr 40px; align-items: center; gap: 14px; padding: 11px 18px }
    .v-gt-head { background: var(--surface-rail) }
    .v-gt-h { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-tertiary) }
    .v-gt-group { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 10px 18px; border: none; border-top: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--tracky-light) 5%, var(--bg-secondary)); color: var(--fg-primary); cursor: pointer }
    .v-gt-group:hover { background: color-mix(in srgb, var(--tracky-light) 9%, var(--bg-secondary)) }
    .v-gt-group > lucide-icon:first-child { color: var(--fg-tertiary); display: inline-flex }
    .v-gt-group-ico { color: var(--tracky-light); display: inline-flex }
    .v-gt-group-ico.none { color: var(--fg-tertiary) }
    .v-gt-group-name { font-size: 13px; font-weight: 700 }
    .v-gt-group-name.none { color: var(--fg-tertiary); font-style: italic; font-weight: 600 }
    .v-gt-group-count { font-size: 11px; color: var(--fg-tertiary); margin-left: 2px }
    .v-trow { border-top: 1px solid var(--border-subtle); text-decoration: none; color: inherit; transition: background .15s; cursor: pointer }
    .v-trow:hover { background: var(--bg-tertiary) }
    .v-trow-veh { display: flex; align-items: center; gap: 11px; min-width: 0 }
    .v-trow-ico { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: var(--bg-tertiary); color: var(--fg-secondary); flex-shrink: 0 }
    .v-trow-veh-txt { min-width: 0 }
    .v-trow-plate { font-size: 13.5px; font-weight: 700; color: var(--fg-primary); letter-spacing: .02em }
    .v-trow-model { font-size: 11.5px; color: var(--fg-tertiary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .v-trow-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap }
    .v-trow-speed { font-size: 14px; font-weight: 800; font-family: var(--font-display); color: var(--fg-secondary); white-space: nowrap }
    /* Vitesse en mouvement : --texte-succes, la marque mesurait 3,43:1 en clair
       (releve navigateur du 2026-08-22, vue tableau a 375 px). */
    .v-trow-speed.spd-move { color: var(--texte-succes) }
    .v-trow-speed.spd-idle { color: var(--texte-attente) }
    .v-trow-speed-u { font-size: 9px; font-weight: 600; color: var(--fg-tertiary) }
    .v-trow-drv { font-size: 13px; color: var(--fg-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .v-trow-drv.v-trow-dash { color: var(--fg-tertiary) }
    .v-trow-pos { min-width: 0 }
    .v-trow-addr { font-size: 13px; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .v-trow-addr.v-trow-dash { color: var(--fg-tertiary) }
    .v-trow-ago { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px }
    .v-trow-dash { color: var(--fg-tertiary) }
    /* DORMANCE — la valeur reste lisible (on ne masque jamais un véhicule) mais elle est
       visiblement DÉCLASSÉE : ce n'est plus du direct, c'est un dernier souvenir. */
    .v-trow-stale { color: var(--fg-tertiary); font-style: italic }
    /* ⚠️ Ces libellés font 10-11 px : ils prennent la famille --texte-*, pas la
       couleur sémantique. Mesuré à 375 px le 2026-08-12 en thème CLAIR :
       #10E0A0 en texte donne 1,57:1 et --warning (#C98708) 2,65:1 sur son propre
       lavis. C'est exactement ce pour quoi --texte-succes / --texte-attente
       existent (cf. styles.css § « Jetons de PETIT TEXTE »). */
    .v-dormant-age {
      font-size: 10px; font-weight: 700; white-space: nowrap;
      color: var(--texte-attente); /* même ambre que le badge « Dormant » */
    }
    .v-trow-chev { color: var(--fg-tertiary); justify-self: end; flex-shrink: 0 }
    @media (max-width: 960px) {
      .v-gt-head, .v-trow { grid-template-columns: minmax(0,2fr) 118px 74px 40px; gap: 10px }
      .v-col-drv, .v-col-pos { display: none }
    }

    .v-table-wrap { position: relative; z-index: 1; overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary) }
    .v-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px }
    .v-table thead th { text-align: left; padding: 11px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); border-bottom: 1px solid var(--border-subtle); font-weight: 700 }
    .v-table tbody tr { border-bottom: 1px solid var(--border-subtle); transition: background .15s }
    .v-table tbody tr:last-child { border-bottom: none }
    .v-table tbody tr:hover { background: var(--bg-tertiary) }
    .v-table td { padding: 10px 14px; color: var(--fg-secondary); vertical-align: middle }
    .v-td-plate a { font-family: var(--font-mono, monospace); font-weight: 800; color: var(--fg-primary); text-decoration: none; letter-spacing: .03em }
    .v-td-plate a:hover { color: var(--tracky-light) }
    .v-td-veh { display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap }
    .v-td-year { color: var(--fg-tertiary); font-size: 12px }
    .v-td-imei { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--fg-tertiary) }
    .v-table .muted { color: var(--fg-tertiary); font-style: italic }
    .v-td-actions { text-align: right; white-space: nowrap }
    .v-td-actions .v-action-btn { display: inline-flex; width: 32px; height: 32px; margin-left: 5px }

    .vlist-empty {
      position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 50px 20px; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb, 15,23,20), .55);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.1);
    }
    .empty-icon { width: 60px; height: 60px; border-radius: 16px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }
    .empty-text { font-size: 14px; color: var(--fg-tertiary) }
    /* La cause du vide, en une ligne : « les 15 autres ne sont pas à vous de les
       montrer ». Sans elle, « Cette société n'a aucun véhicule » laisse croire à
       une panne alors que c'est le périmètre choisi qui répond. */
    .empty-detail { font-size: 13px; color: var(--fg-tertiary); max-width: 34ch; text-align: center }
    /* Mesurée à 139 × 36 : sous le plancher de 44 px. C'est pourtant la SEULE
       sortie de cet écran — le sélecteur de société est en haut, hors de vue.
       Une sortie unique qu'on rate au doigt n'est pas une sortie.
       Couleur : --tracky-light donnait 3,39:1 sur fond clair. Le lien reste vert
       (la décision), c'est la valeur qui suit le thème — --texte-succes assombrit
       le même vert en clair et le laisse tel quel en sombre. */
    .empty-cta { font-size: 13px; color: var(--texte-succes); background: none; border: none; cursor: pointer; text-decoration: underline;
                 min-height: 44px; padding: 0 12px }

    /* Vehicle grid */
    .v-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px }

    .v-card {
      position: relative; display: flex; flex-direction: column; padding: 18px; border-radius: 14px; overflow: hidden;
      background: rgba(var(--bg-secondary-rgb, 15,23,20), .55);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.1); text-decoration: none; color: inherit;
      transition: all .3s; cursor: pointer;
    }
    .v-card:hover { border-color: rgba(16,224,160,.25); box-shadow: 0 0 30px rgba(16,224,160,.08), 0 8px 32px rgba(0,0,0,.2); transform: translateY(-2px) }

    :host-context([data-theme="light"]) .v-card {
      background: rgba(255,255,255,.6); border-color: rgba(16,224,160,.12);
    }
    :host-context([data-theme="light"]) .v-card:hover {
      border-color: rgba(16,224,160,.3); box-shadow: 0 0 30px rgba(16,224,160,.06), 0 8px 32px rgba(0,0,0,.06);
    }

    .v-card-glow {
      position: absolute; top: 0; right: 0; width: 70px; height: 70px; border-radius: 0 0 0 70px; opacity: .06; pointer-events: none;
    }
    .v-card-glow.online { background: var(--tracky-light) }
    .v-card-glow.offline { background: var(--fg-tertiary) }

    .v-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px }
    .v-plate-wrap { display: flex; align-items: center; gap: 8px }
    .v-type-icon { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center }
    /* Pictogramme sur lavis accent : --texte-succes, la marque tombe a ~2,9:1 en clair. */
    .v-type-icon.online { background: rgba(16,224,160,.15); color: var(--texte-succes) }
    .v-type-icon.offline { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .v-type-icon :deep(svg) { width: 16px; height: 16px }
    .v-plate { font-size: 16px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-mono, monospace); letter-spacing: .03em }
    .v-year { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); padding: 2px 8px; border-radius: 6px; background: var(--bg-tertiary) }

    /* V1.15 — Driver chip discret sous le header (visible pour tous roles). */
    .v-driver-chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; font-weight: 500;
      color: var(--fg-secondary);
      padding: 2px 6px;
      border-radius: 9999px;
      background: var(--bg-tertiary);
      margin-top: 6px;
    }
    .v-driver-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--color-tracky-light);
      flex-shrink: 0;
    }


    .v-card-mid { margin-bottom: 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px }
    .v-brand { font-size: 13px; font-weight: 500; color: var(--fg-secondary) }
    .v-brand.muted { color: var(--fg-tertiary); font-style: italic }
    .v-live-pill {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; font-weight: 600;
      padding: 3px 9px 3px 7px; border-radius: 9999px;
      border: 1px solid transparent; line-height: 1.4;
    }
    .v-live-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0 }
    .v-live-pill--moving {
      color: var(--texte-succes); background: color-mix(in srgb, var(--tracky) 12%, transparent); border-color: color-mix(in srgb, var(--tracky) 25%, transparent);
    }
    /* La pastille garde le vert de MARQUE — c'est une forme, pas du texte. */
    .v-live-pill--moving .v-live-dot { background: var(--tracky); box-shadow: 0 0 6px color-mix(in srgb, var(--tracky) 60%, transparent) }
    .v-live-pill--idle {
      color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 12%, transparent); border-color: color-mix(in srgb, var(--warning) 24%, transparent);
    }
    .v-live-pill--idle .v-live-dot { background: var(--warning) }
    .v-live-pill--stopped {
      color: var(--fg-tertiary); background: var(--bg-tertiary); border-color: var(--border-subtle);
    }
    .v-live-pill--stopped .v-live-dot { background: var(--fg-tertiary) }

    /* V1.15 — badge installation (derive IMEI + SIM) */
    .v-inst { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 9999px; line-height: 1.4 }
    .v-inst--installed { color: var(--texte-succes); background: color-mix(in srgb, var(--tracky) 12%, transparent); border: 1px solid color-mix(in srgb, var(--tracky) 22%, transparent) }
    .v-inst--no-sim { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warning) 24%, transparent) }

    .v-card-bottom { padding-top: 10px; border-top: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between }
    .v-tracker-info { flex: 1; min-width: 0 }
    .v-actions { display: flex; gap: 6px; flex-shrink: 0 }
    .v-action-btn {
      width: 36px; height: 36px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid var(--border-subtle); color: var(--fg-tertiary);
      cursor: pointer; transition: all .2s; text-decoration: none;
    }
    .v-action-btn lucide-icon { width: 16px; height: 16px; }
    .v-action-btn.view:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.2); background: rgba(16,224,160,.06) }
    .v-action-btn.edit:hover { color: var(--color-tracky-light); border-color: color-mix(in srgb, var(--color-tracky-light) 25%, transparent); background: color-mix(in srgb, var(--color-tracky-light) 8%, transparent) }
    .v-action-btn.delete:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 25%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent) }
    .v-tracker { display: flex; align-items: center; gap: 5px; font-size: 11px; font-family: var(--font-mono, monospace); color: var(--fg-tertiary) }
    .v-assign-btn {
      font-size: 11px; color: var(--tracky-light); background: none; border: none; cursor: pointer; font-weight: 600;
    }
    .v-assign-btn:hover { text-decoration: underline }
    .v-no-tracker { font-size: 11px; color: var(--fg-tertiary); font-style: italic }

    /* Ancienne vue groupée (.v-group-*) retirée : remplacée par le tableau
       groupé .v-gtable (rebuild maquette). */

    /* iOS PWA standalone : insette l'overlay drawer (assign tracker) par les
       safe-areas pour que le header ne passe pas sous le notch ni le footer sous
       le home indicator. Combine au max-h-full du panneau. env()=0 hors iOS. */
    .drawer-overlay-safe {
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
    .animate-slide-in { animation: slideIn .25s ease-out }
    @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
  `],
})
export class VehiclesListComponent implements OnInit {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly geocode = inject(GeocodeService);
  protected readonly perms = inject(PermissionsService);
  private readonly preferences = inject(PreferencesService);
  protected readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fleetFilter = inject(FleetFilterService);
  // Sprint 1 — section de groupe vers laquelle scroller au retour depuis le détail.
  private readonly pendingScrollGroup = signal<string | null>(null);

  // #3 — vue liste : cartes (défaut), tableau, ou groupée, persistée dans PreferencesService.
  // Sprint 3 — le veilleur de nuit démarre toujours en vue groupée (son périmètre = ses groupes).
  protected readonly viewMode = signal<'cards' | 'table' | 'grouped'>(
    this.auth.isWatchman() ? 'grouped' : this.preferences.prefs().vehiclesView,
  );

  // Sprint 1 (Fondation Groupes) — sections de groupes repliées (clé = groupId ou '__none__').
  protected readonly collapsedGroups = signal<Set<string>>(new Set());

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  // #2 — recherche client-side (plaque / marque / modèle / IMEI).
  protected readonly search = signal('');
  /** Filtre groupe (vide = tous). Appliqué avant la recherche texte. */
  protected readonly groupFilter = signal('');
  /** Groupes distincts présents dans la flotte, pour le menu de filtre. */
  protected readonly groupOptions = computed(() => {
    const map = new Map<string, string>();
    for (const v of this.vehicles()) {
      if (v.group) map.set(v.group.id, v.group.name);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  /**
   * Les véhicules du PÉRIMÈTRE courant : la liste complète réduite à la société
   * choisie dans le sélecteur global. C'est le seul total qu'on ait le droit
   * d'annoncer à l'écran — `vehicles()` compte aussi ceux des autres sociétés,
   * que l'utilisateur ne peut pas faire apparaître en touchant à ses filtres.
   */
  protected readonly vehiculesDuPerimetre = computed(() =>
    this.vehicles().filter((v) => this.fleetFilter.matches(v.fleetId)),
  );

  /**
   * La société sélectionnée n'a aucun véhicule — vide par PÉRIMÈTRE, pas par
   * filtre. Les deux causes demandent une sortie différente : réinitialiser les
   * filtres ne ramènera jamais un véhicule d'une autre société.
   */
  protected readonly societeSansVehicule = computed(
    () => this.fleetFilter.isActive() && this.vehiculesDuPerimetre().length === 0,
  );

  protected readonly filteredVehicles = computed(() => {
    const gid = this.groupFilter();
    const q = this.search().trim().toLowerCase();
    // Filtre société global (SUPER_ADMIN) — no-op pour les autres rôles.
    let list = this.vehiculesDuPerimetre();
    if (gid) list = list.filter((v) => v.group?.id === gid);
    if (q) {
      list = list.filter((v) =>
        v.plate.toLowerCase().includes(q) ||
        (v.brand ?? '').toLowerCase().includes(q) ||
        (v.model ?? '').toLowerCase().includes(q) ||
        (v.tracker?.imei ?? '').toLowerCase().includes(q),
      );
    }
    const st = this.statutFiltre();
    if (st !== 'tous') list = list.filter((v) => this.statutDe(v) === st);
    return list;
  });

  /** Y a-t-il au moins un filtre posé ? Sert à distinguer « rien ne correspond » de « flotte vide ». */
  protected readonly filtresActifs = computed(
    () => !!this.search().trim() || !!this.groupFilter() || this.statutFiltre() !== 'tous',
  );

  /**
   * Sprint 1 (Fondation Groupes) — véhicules (filtrés) regroupés par groupe pour
   * la vue groupée. « Sans groupe » en premier (cas majoritaire en prod), puis
   * tri alpha. Regroupement 100% client-side : aucun endpoint dédié, le scoping
   * tenant est hérité de la liste déjà filtrée par accès.
   */
  protected readonly groupedVehicles = computed(() => {
    const sections = new Map<string, { id: string | null; name: string; vehicles: VehicleDetailDto[] }>();
    for (const v of this.filteredVehicles()) {
      const key = v.group?.id ?? '__none__';
      let section = sections.get(key);
      if (!section) {
        section = { id: v.group?.id ?? null, name: v.group?.name ?? 'Sans groupe', vehicles: [] };
        sections.set(key, section);
      }
      section.vehicles.push(v);
    }
    return [...sections.values()].sort((a, b) => {
      if (a.id === null) return -1;
      if (b.id === null) return 1;
      return a.name.localeCompare(b.name);
    });
  });

  protected readonly loading = signal(true);
  protected readonly showAddDialog = signal(false);
  protected readonly showEditDialog = signal(false);
  protected readonly editVehicleId = signal('');
  protected readonly activeTab = signal<'vehicles' | 'groups' | 'capacity' | 'privacy'>('vehicles');

  /** Le dernier chargement a-t-il échoué ? Distinct de « la flotte est vide ». */
  protected readonly chargementEnErreur = signal(false);

  /**
   * L'état de la zone — les six états du kit rendus une fois, au lieu d'un rond de
   * chargement et de deux blocs « vide » écrits à la main (dont un mentait).
   *
   * L'ORDRE compte : une erreur prime sur un vide. Sans quoi une API tombée
   * s'afficherait comme une flotte vide, ce qui était exactement le défaut.
   */
  protected readonly etatZone = computed<EtatZone>(() => {
    if (this.loading()) return 'chargement';
    if (this.chargementEnErreur()) return this.vehicles().length > 0 ? 'partiel' : 'erreur';
    return this.vehicles().length === 0 ? 'vide' : 'rempli';
  });

  /* ═══ FILTRES EN FEUILLE (planche Véhicules, écran « Filtres · feuille ») ═══
     Sur téléphone, les filtres tenaient dans une barre d'outils : un champ de
     recherche de 20 px de haut et un `select` de 20 px — moitié du plancher tactile.
     La planche les sort dans une feuille, avec un pied qui annonce le résultat
     (« Voir 14 véhicules ») pour qu'on sache ce qu'on obtient AVANT de fermer. */
  protected readonly filtresOuverts = signal(false);
  protected readonly statutFiltre = signal<FiltreStatut>('tous');
  protected readonly FILTRES_STATUT: ReadonlyArray<{ id: FiltreStatut; label: string }> = [
    { id: 'tous', label: 'Tous' },
    { id: 'roulage', label: 'Roule' },
    { id: 'arret', label: 'À l’arrêt' },
    { id: 'hors-ligne', label: 'Hors ligne' },
    { id: 'sans-boitier', label: 'Pas de boîtier' },
  ];

  /**
   * Le statut d'un véhicule pour les puces.
   *
   * ⚠️ Il part de `connectivity()` et de `liveStatus()` — LES MÊMES sources que les
   * lignes de la liste. Une puce qui compterait autrement afficherait « Roule 6 »
   * au-dessus d'une liste qui n'en montre que 4 : deux vérités sur le même écran.
   */
  protected statutDe(v: VehicleDetailDto): FiltreStatut {
    const c = this.connectivity(v);
    if (c === 'NOT_CONFIGURED') return 'sans-boitier';
    if (c !== 'ONLINE') return 'hors-ligne';
    // ⚠️ `liveStatus` vaut null tant qu'aucune position live n'est arrivée — c'est
    // « on ne sait pas encore », PAS « à l'arrêt ». Relevé au navigateur le
    // 2026-08-12 : au premier rendu les deux véhicules étaient comptés à l'arrêt
    // alors que leurs cartes affichaient une vitesse. On retombe alors sur le
    // drapeau `moving` de la charge REST — la même source que `seedMovingState`.
    const live = this.liveStatus(v.id);
    if (live) return live.kind === 'moving' ? 'roulage' : 'arret';
    return v.moving ? 'roulage' : 'arret';
  }

  /** Compteurs des puces — sur la flotte ENTIÈRE, jamais sur la vue déjà filtrée. */
  protected readonly compteursStatut = computed(() => {
    const tous = this.vehicles();
    const n: Record<FiltreStatut, number> = {
      tous: tous.length, roulage: 0, arret: 0, 'hors-ligne': 0, 'sans-boitier': 0,
    };
    for (const v of tous) n[this.statutDe(v)]++;
    return n;
  });

  protected reinitialiserFiltres(): void {
    this.search.set('');
    this.groupFilter.set('');
    this.statutFiltre.set('tous');
  }

  /**
   * Lève le filtre société global. C'est la seule sortie qui marche quand la
   * société choisie n'a aucun véhicule : le sélecteur est dans la barre du haut,
   * loin du message, et rien n'y renvoyait.
   */
  protected voirToutesLesSocietes(): void {
    this.fleetFilter.set(null);
  }
  /** feat/comptes-conducteurs (4a) — véhicule dont on affiche le QR (null = modale fermée). */
  protected readonly qrVehicle = signal<VehicleDetailDto | null>(null);

  // Assign tracker drawer
  readonly showAssignTracker = signal(false);
  readonly assignLoading = signal(false);
  readonly assignError = signal('');
  readonly assignPlate = signal('');
  private assignVehicleId = '';
  assignImei = '';
  assignModel = '';

  protected readonly Plus = Plus;
  protected readonly TruckIcon = Truck;
  protected readonly Truck = Truck;
  protected readonly ExternalLink = ExternalLink;
  protected readonly FolderOpenIcon = FolderOpen;
  protected readonly GaugeIcon = Gauge;
  protected readonly WrenchIcon = Wrench;
  protected readonly RadioIcon = Radio;
  protected readonly PencilIcon = Pencil;
  protected readonly Trash2Icon = Trash2;
  protected readonly EyeIcon = Eye;
  protected readonly QrCodeIcon = QrCode;
  protected readonly SearchIcon = Search;
  protected readonly LayoutGridIcon = LayoutGrid;
  protected readonly TableIcon = Table;
  protected readonly LayersIcon = Layers;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly ChevronDownIcon = ChevronDown;

  // Delete vehicle
  readonly showDeleteVehicle = signal(false);
  readonly deleting = signal(false);
  readonly vehicleToDelete = signal<VehicleDetailDto | null>(null);

  private readonly sanitizer = inject(DomSanitizer);

  protected getTypeIconHtml(type: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${getVehicleSvg(type)}</svg>`
    );
  }
  protected readonly WifiIcon = Wifi;
  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly ShieldOffIcon = ShieldOff;

  ngOnInit(): void {
    // Sprint 1 — retour depuis le détail : si on revient d'un groupe précis, on
    // scrolle vers sa section après le rendu (la vue groupée est restaurée via
    // les préférences, et les sections sont dépliées par défaut).
    const g = this.route.snapshot.queryParams['group'];
    if (g) this.pendingScrollGroup.set(g);
    // Deep-link d'onglet via ?tab= (redirection /groups → /vehicles?tab=groups).
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if ((tab === 'groups' && this.perms.can('groups_view')) || tab === 'capacity') {
      this.activeTab.set(tab as 'groups' | 'capacity');
    }
    this.loadVehicles();
  }

  /**
   * Changement d'onglet AVEC synchro URL (?tab=) : le Router émet un NavigationEnd
   * → le tracker d'activité voit un PAGE_VIEW distinct (« Véhicules · Groupes »)
   * avec sa durée. `replaceUrl` pour ne pas polluer l'historique du bouton retour.
   */
  protected selectTab(tab: 'vehicles' | 'groups' | 'capacity' | 'privacy'): void {
    this.activeTab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'vehicles' ? null : tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected setViewMode(mode: 'cards' | 'table' | 'grouped'): void {
    this.viewMode.set(mode);
    this.vueImposee = true;
    this.preferences.update({ vehiclesView: mode });
  }

  /** Vrai dès que l'utilisateur a touché au sélecteur pendant cette visite. */
  private vueImposee = false;

  /**
   * La vue GROUPÉE par défaut — mais seulement quand elle apporte quelque chose.
   *
   * La planche montre la liste groupée par groupe sur les trois plateformes.
   * L'imposer partout serait pourtant faux : une flotte sans groupe, ou avec un
   * seul, n'y gagne qu'un en-tête inutile au-dessus de la même liste.
   *
   * D'où la règle : groupée dès qu'il y a PLUSIEURS groupes, plate sinon — et
   * jamais si l'utilisateur a lui-même choisi une vue. `aChoisi()` distingue son
   * clic d'un défaut jamais touché ; sans cette distinction, on écraserait à
   * chaque chargement le choix de quelqu'un qui préfère les cartes.
   *
   * Le veilleur garde son cas à part (il démarre toujours groupé, son périmètre
   * EST ses groupes), traité à l'initialisation de `viewMode`.
   */
  private appliquerVueParDefaut(): void {
    if (this.vueImposee || this.auth.isWatchman()) return;
    if (this.preferences.aChoisi('vehiclesView')) return;
    const plusieursGroupes = this.groupOptions().length > 1;
    this.viewMode.set(plusieursGroupes ? 'grouped' : 'cards');
  }

  /** Sprint 1 — replie/déplie une section de groupe (clé = groupId ou '__none__'). */
  protected toggleGroup(key: string): void {
    const next = new Set(this.collapsedGroups());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.collapsedGroups.set(next);
  }

  protected isCollapsed(key: string): boolean {
    return this.collapsedGroups().has(key);
  }

  /** Veilleur : une section n'est repliée QUE hors recherche (une recherche montre tout). */
  protected wnCollapsed(key: string): boolean {
    return !this.search().trim() && this.isCollapsed(key);
  }

  /** Sprint 1 — contexte de retour rapide transmis à la fiche détail (retour groupé). */
  protected groupedLinkParams(groupId: string | null): Record<string, string> {
    return { from: 'grouped', group: groupId ?? '' };
  }

  protected onDialogClosed(): void {
    this.showAddDialog.set(false);
    this.showEditDialog.set(false);
    this.editVehicleId.set('');
    this.loadVehicles();
  }

  /**
   * État de connectivité (tri-état partagé) du véhicule : ONLINE / OFFLINE /
   * NOT_CONFIGURED. Basé sur la FRAÎCHEUR du dernier signal (`lastSeenAt`), pas
   * sur le statut TCP qui flappe ni sur `status` (collant) — cohérent avec la
   * carte et le reste de l'app. Sert à griser l'icône et à flaguer les véhicules
   * « pas dans l'app » (débranchés ou non configurés).
   */
  protected connectivity(v: VehicleDetailDto): VehicleConnectivityState {
    return getVehicleConnectivityState({
      trackerId: v.tracker?.id ?? null,
      lastSeenAt: v.tracker?.lastSeenAt ?? null,
      // null = boîtier jamais localisé → « Recherche GPS » s'il émet (vivant sans fix).
      lastPositionAt: v.tracker?.lastPositionAt ?? null,
      // Incident FS-253 — no_fix frais + position périmée → GPS_LOST (« GPS perdu »).
      lastNoFixAt: v.tracker?.lastNoFixAt ?? null,
      lastIgnition: v.tracker?.lastKnownIgnition ?? null,
    });
  }

  /**
   * Dernier signal le plus FRAIS entre le REST (liste chargée au montage) et le snapshot
   * temps réel (rafraîchi par les événements WS). Sans ça, un véhicule dormant qui se
   * réveille pendant que la liste est ouverte resterait marqué « Dormant » jusqu'au
   * prochain rechargement de page — alors que la dormance doit s'inverser TOUTE SEULE
   * dès la première trame reçue.
   */
  private freshestLastSeen(v: VehicleDetailDto): string | null {
    const rest = v.tracker?.lastSeenAt ?? null;
    const live = this.realtime.snapshot().find((s) => s.vehicleId === v.id)?.lastSeenAt ?? null;
    if (!rest) return live;
    if (!live) return rest;
    return new Date(live).getTime() > new Date(rest).getTime() ? live : rest;
  }

  /**
   * État de PRÉSENCE = le tri-état ci-dessus élargi d'un cran `DORMANT` (boîtier qui
   * parlait puis s'est tu depuis > 7 j). C'est ce qu'on donne au badge.
   *
   * Seuil COUNTING (7 j) et non ACTING (72 h) : ici on AFFICHE, on ne commande rien. À 72 h
   * un pont ou une semaine d'atelier reste plausible ; taguer « Dormant » un véhicule
   * simplement garé depuis 4 jours serait une fausse alerte à répétition sur 37 véhicules.
   * Les GARDES DE BOUTON, elles, doivent rester sur 72 h — exactement comme le serveur.
   */
  protected presence(v: VehicleDetailDto): VehiclePresenceState {
    return getVehiclePresenceState({
      trackerId: v.tracker?.id ?? null,
      lastSeenAt: this.freshestLastSeen(v),
      lastPositionAt: v.tracker?.lastPositionAt ?? null,
      lastNoFixAt: v.tracker?.lastNoFixAt ?? null,
      lastIgnition: v.tracker?.lastKnownIgnition ?? null,
    });
  }

  /** Dernier signal du boîtier, pour que le badge affiche « Dormant · 89 j ». */
  protected lastSeenOf(v: VehicleDetailDto): string | null {
    return this.freshestLastSeen(v);
  }

  /** Le véhicule est-il dormant ? (muet > 7 j alors qu'il a un boîtier qui a déjà parlé) */
  protected isDormant(v: VehicleDetailDto): boolean {
    return isVehicleDormant({ trackerId: v.tracker?.id ?? null, lastSeenAt: this.freshestLastSeen(v) });
  }

  /** « 89 j » — ancienneté du silence, affichée à côté du badge compact (qui n'a pas de texte). */
  protected silenceLabel(v: VehicleDetailDto): string | null {
    return formatSilenceLabel(this.freshestLastSeen(v));
  }

  /**
   * « Installation à revoir » : boîtier posé depuis < 1 mois mais hors-ligne
   * (a déjà communiqué puis s'est déconnecté) → pose probablement bâclée.
   */
  protected installToReview(v: VehicleDetailDto): boolean {
    return isInstallationToReview(this.connectivity(v), v.tracker?.createdAt ?? null);
  }

  /**
   * Statut live dérivé du signal positions :
   *  - moving : ignition ON et vitesse > 3 km/h (seuil cohérent avec le sampling backend)
   *  - idle   : ignition ON mais véhicule arrêté
   *  - stopped : ignition OFF (ou pas de position)
   * Retourne null si le véhicule n'est pas dans le snapshot (pas de tracker ou pas hydraté).
   */
  protected liveStatus(vehicleId: string): { kind: 'moving' | 'idle' | 'stopped'; speedKmh: number; cssClass: string } | null {
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === vehicleId);
    if (!pos) return null;
    // DORMANCE — garde AJOUTÉE en amont (aucune garde existante n'est retirée). Le snapshot
    // hydrate une position pour TOUS les véhicules, y compris ceux muets depuis 89 jours :
    // sans ce filtre, FV-941-LZ afficherait la pastille « Stationné » comme s'il venait d'être
    // vu, et le badge de présence — le seul à dire la vérité — ne s'afficherait JAMAIS (il est
    // dans la branche `@else` de cette pastille). Le véhicule n'est pas retiré de la liste : il
    // bascule sur le badge « Dormant · 89 j », qui date la donnée au lieu de la maquiller.
    const dormantV = this.vehicles().find((v) => v.id === vehicleId);
    if (dormantV && this.isDormant(dormantV)) return null;
    // Incident FS-253 — GPS perdu : la vitesse live est FIGÉE (dernière position vieille de
    // plusieurs heures). On n'affiche AUCUNE pastille de vitesse (le badge « GPS perdu » du
    // tri-état s'en charge) pour ne pas laisser croire que le véhicule roule.
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === vehicleId);
    if (snap && getVehicleConnectivityState({
      trackerId: snap.trackerId,
      lastSeenAt: snap.lastSeenAt,
      lastPositionAt: snap.lastPositionAt,
      lastNoFixAt: snap.lastNoFixAt,
      lastIgnition: snap.lastIgnition,
    }) === 'GPS_LOST') return null;
    const speedKmh = Math.round(pos.speedKmh);
    if (pos.ignition && speedKmh > 3) {
      return { kind: 'moving', speedKmh, cssClass: 'v-live-pill--moving' };
    }
    if (pos.ignition) {
      return { kind: 'idle', speedKmh, cssClass: 'v-live-pill--idle' };
    }
    return { kind: 'stopped', speedKmh, cssClass: 'v-live-pill--stopped' };
  }

  /** Dernière position live (lat/lng/horodatage) depuis le snapshot temps réel. */
  protected positionFor(vehicleId: string): { lat: number; lng: number; timestamp: string } | null {
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === vehicleId);
    if (!pos) return null;
    return { lat: pos.lat, lng: pos.lng, timestamp: pos.timestamp };
  }

  /** Adresse courte de la dernière position (géocodage inverse serveur, mémoïsé). '' si indispo. */
  protected addressFor(vehicleId: string): string {
    const pos = this.positionFor(vehicleId);
    if (!pos) return '';
    return this.geocode.reverse(pos.lat, pos.lng)();
  }

  /** « il y a X » depuis la dernière position (ou dernier contact tracker). */
  protected lastContactLabel(v: VehicleDetailDto): string {
    const iso = this.positionFor(v.id)?.timestamp ?? v.tracker?.lastSeenAt ?? null;
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return "à l'instant";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `il y a ${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `il y a ${h} h`;
    return `il y a ${Math.floor(h / 24)} j`;
  }

  /**
   * Ancienneté affichée sous la position. Pour un dormant, on préfixe « dernière valeur
   * connue » : « il y a 89 j » seul se lit comme « il vient de bouger il y a longtemps »,
   * alors que la donnée affichée au-dessus est un souvenir figé depuis trois mois.
   */
  protected posAgeLabel(v: VehicleDetailDto): string {
    const ago = this.lastContactLabel(v);
    if (!ago) return '';
    return this.isDormant(v) ? `dernière valeur connue ${ago}` : ago;
  }

  /** Conducteur assigné, format « P. Nom » (réf. maquette). « Non assigné » sinon. */
  protected driverLabel(v: VehicleDetailDto): string {
    const d = v.currentDriver;
    if (!d) return 'Non assigné';
    const first = d.firstName?.trim() ?? '';
    const last = d.lastName?.trim() ?? '';
    if (first && last) return `${first[0]}. ${last}`;
    return last || first || 'Conducteur';
  }

  /** V1.15 — badge installation derive : tracker + IMEI + SIM => Installé. */
  protected instBadge(v: VehicleDetailDto): { cls: string; label: string } | null {
    if (!v.tracker?.imei) return null;
    if (v.tracker.simPhoneNumber) return { cls: 'installed', label: 'Installé' };
    return { cls: 'no-sim', label: 'SIM manquante' };
  }

  protected openEditVehicle(v: VehicleDetailDto): void {
    this.editVehicleId.set(v.id);
    this.showEditDialog.set(true);
  }

  protected openQr(v: VehicleDetailDto): void {
    this.qrVehicle.set(v);
  }

  /**
   * Feuille imprimable de TOUS les QR (fleet-scopée) — rendu PREMIUM client-side : on récupère les
   * liens signés (JSON), on régénère chaque QR stylisé (buildTrackyQrSvg, niveau H) et on ouvre une
   * feuille de cartes identiques à la fiche véhicule (une carte = une page à l'impression).
   */
  protected async printAllQr(): Promise<void> {
    // Fenêtre ouverte SYNCHRONEMENT sur le clic (sinon bloquée par le navigateur), remplie après le fetch.
    const w = window.open('', '_blank', 'width=920,height=800');
    try {
      const res = await firstValueFrom(this.vehiclesApi.getUnlockQrLinks(this.fleetFilter.selectedFleetId()));
      const cards = (res.items ?? []).map((v) => ({ plate: v.plate ?? '', model: v.model, qrSvg: buildTrackyQrSvg(v.url) }));
      if (!w) return;
      w.document.write(buildQrSheetHtml(cards));
      w.document.close();
    } catch (err) {
      swallow('vehicles-list:printAllQr', err);
      w?.close();
    }
  }

  protected confirmDeleteVehicle(v: VehicleDetailDto): void {
    this.vehicleToDelete.set(v);
    this.showDeleteVehicle.set(true);
  }

  protected async onDeleteVehicle(): Promise<void> {
    const v = this.vehicleToDelete();
    if (!v) return;
    this.deleting.set(true);
    try {
      await firstValueFrom(this.vehiclesApi.delete(v.id));
      this.showDeleteVehicle.set(false);
      this.vehicleToDelete.set(null);
      await this.loadVehicles();
    } catch (err) {
      // error
      swallow('vehicles-list:onDeleteVehicle', err);
    }
    finally { this.deleting.set(false); }
  }

  protected openAssignTracker(vehicleId: string): void {
    const v = this.vehicles().find((x) => x.id === vehicleId);
    this.assignVehicleId = vehicleId;
    this.assignPlate.set(v?.plate ?? '');
    this.assignImei = '';
    this.assignModel = '';
    this.assignError.set('');
    this.showAssignTracker.set(true);
  }

  protected async onAssignTracker(): Promise<void> {
    this.assignLoading.set(true);
    this.assignError.set('');
    try {
      const tracker = await firstValueFrom(
        this.trackersApi.create({ imei: this.assignImei.trim(), model: this.assignModel.trim() || undefined }),
      );
      await firstValueFrom(this.trackersApi.assign(tracker.id, this.assignVehicleId));
      this.showAssignTracker.set(false);
      await this.loadVehicles();
    } catch (err: unknown) {
      swallow('vehicles-list:onAssignTracker', err);
      const msg = (err as { error?: { message?: string } })?.error?.message ?? 'Erreur';
      this.assignError.set(typeof msg === 'string' ? msg : String(msg));
    } finally { this.assignLoading.set(false); }
  }

  protected async loadVehicles(): Promise<void> {
    this.loading.set(true);
    this.chargementEnErreur.set(false);
    try {
      const list = await firstValueFrom(this.vehiclesApi.list());
      this.vehicles.set(list);
      this.appliquerVueParDefaut();
      // Fix veilleur — amorce l'état « en mouvement » (le veilleur ne reçoit aucune
      // position en live) pour griser le bouton « Couper » dès le chargement. Les
      // transitions WS `VEHICLE_MOVEMENT` prennent ensuite le relais.
      this.realtime.seedMovingState(
        list
          .filter((v) => v.tracker)
          .map((v) => ({ trackerId: v.tracker!.id, moving: !!v.moving })),
      );
      this.scrollToPendingGroup();
    } catch (err) {
      swallow('vehicles-list:loadVehicles', err);
      // ⚠️ NE PAS poser un tableau vide ici. C'est le motif le plus répandu de cette
      // base — relevé une 5ᵉ fois le 2026-08-12, sur un 5ᵉ écran sans rapport avec
      // les quatre autres (activity, privacy-coverage, integrations, driver).
      //
      // `vehicles.set([])` faisait dire à la page « Aucun véhicule dans votre flotte »
      // AVEC le bouton « Ajouter votre premier véhicule » — à un gestionnaire dont la
      // flotte existe et dont l'API vient de tomber. Le mensonge est rassurant, et il
      // tombe sur l'écran qui sert précisément à vérifier que la flotte va bien.
      //
      // « vide » et « erreur » sont deux états, pas un : on garde la liste précédente
      // si on en avait une, et on nomme la panne.
      this.chargementEnErreur.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Sprint 1 — scrolle vers la section de groupe demandée au retour (si vue groupée). */
  private scrollToPendingGroup(): void {
    const g = this.pendingScrollGroup();
    if (!g || this.viewMode() !== 'grouped') return;
    this.pendingScrollGroup.set(null);
    setTimeout(() => {
      document.getElementById('vg-' + g)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 60);
  }
}
