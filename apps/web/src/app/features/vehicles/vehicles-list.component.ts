import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Truck, ExternalLink, FolderOpen, Radio, X, Save, Wifi, Pencil, Trash2, Eye, Search, LayoutGrid, Table } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PermissionsService } from '../../core/services/permissions.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { TrackersApiService } from '../../core/services/trackers.service';
import { getVehicleSvg, getVehicleTypeLabel } from '../../shared/utils/vehicle-icons';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { VehicleDialogComponent } from './vehicle-dialog/vehicle-dialog.component';
import { VehicleGroupsTabComponent } from './vehicle-groups-tab.component';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';

@Component({
  selector: 'app-vehicles-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, LucideAngularModule, VehicleDialogComponent, VehicleGroupsTabComponent, ConfirmModalComponent, SaFleetBadgeComponent],
  template: `
    <div class="vlist-page">
      <div class="vlist-grid-bg"></div>
      <div class="vlist-glow"></div>

      <!-- Header -->
      <div class="vlist-header">
        <div>
          <h1 class="vlist-title">Véhicules</h1>
          <p class="vlist-sub">{{ vehicles().length }} véhicule(s) dans votre flotte</p>
        </div>
        <div class="vlist-actions">
          @if (perms.can('groups_view')) {
            <div class="tab-switch">
              <button (click)="activeTab.set('vehicles')" class="tab-btn" [class.active]="activeTab() === 'vehicles'">
                <lucide-icon [img]="TruckIcon" [size]="15"></lucide-icon> Véhicules
              </button>
              <button (click)="activeTab.set('groups')" class="tab-btn" [class.active]="activeTab() === 'groups'">
                <lucide-icon [img]="FolderOpenIcon" [size]="15"></lucide-icon> Groupes
              </button>
            </div>
          }
          @if (perms.can('vehicles_create') && activeTab() === 'vehicles') {
            <button (click)="showAddDialog.set(true)" class="add-btn add-btn--inline">
              <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Ajouter
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
        <button (click)="showAddDialog.set(true)" class="vlist-fab" aria-label="Ajouter un véhicule">
          <lucide-icon [img]="Plus" [size]="22"></lucide-icon>
        </button>
      }

      @if (activeTab() === 'groups') {
        <app-vehicle-groups-tab />
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
            <span class="vlist-count">{{ filteredVehicles().length }} / {{ vehicles().length }}</span>
            <div class="view-switch">
              <button (click)="setViewMode('cards')" class="view-btn" [class.active]="viewMode() === 'cards'"
                      title="Vue cartes" aria-label="Vue cartes">
                <lucide-icon [img]="LayoutGridIcon" [size]="15"></lucide-icon>
              </button>
              <button (click)="setViewMode('table')" class="view-btn" [class.active]="viewMode() === 'table'"
                      title="Vue tableau" aria-label="Vue tableau">
                <lucide-icon [img]="TableIcon" [size]="15"></lucide-icon>
              </button>
            </div>
          </div>
        }
        @if (loading()) {
          <div class="vlist-loading">
            <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="vlist-empty">
            <div class="empty-icon"><lucide-icon [img]="Truck" [size]="36"></lucide-icon></div>
            <p class="empty-text">Aucun véhicule {{ perms.can('vehicles_create') ? 'dans votre flotte' : 'accessible' }}</p>
            @if (perms.can('vehicles_create')) {
              <button (click)="showAddDialog.set(true)" class="empty-cta">Ajouter votre premier véhicule</button>
            }
          </div>
        } @else if (filteredVehicles().length === 0) {
          <div class="vlist-empty">
            <div class="empty-icon"><lucide-icon [img]="Truck" [size]="36"></lucide-icon></div>
            <p class="empty-text">Aucun véhicule ne correspond à votre recherche</p>
            <button (click)="search.set('')" class="empty-cta">Réinitialiser la recherche</button>
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
                      @if (v.brand) {
                        {{ v.brand }} {{ v.model ?? '' }}
                      } @else {
                        <span class="muted">Non renseigné</span>
                      }
                      @if (v.year) { <span class="v-td-year">· {{ v.year }}</span> }
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
                        <span class="muted">—</span>
                      }
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
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="v-grid">
            @for (v of filteredVehicles(); track v.id) {
              <a [routerLink]="['/vehicles', v.id]" class="v-card">
                <div class="v-card-glow" [class]="v.tracker ? 'online' : 'offline'"></div>
                <div class="v-card-top">
                  <div class="v-plate-wrap">
                    <div class="v-type-icon" [class]="v.tracker && isTrackerOnline(v.tracker.id, v.tracker.status) ? 'online' : 'offline'"
                      [innerHTML]="getTypeIconHtml(v.type)"></div>
                    <span class="v-plate">{{ v.plate }}</span>
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
                    {{ d.firstName }} {{ d.lastName?.charAt(0) ?? '' }}.
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
                  @if (instBadge(v); as b) {
                    <span class="v-inst" [class]="'v-inst--' + b.cls">{{ b.label }}</span>
                  }
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
                  </div>
                </div>
              </a>
            }
          </div>
        }

        <app-vehicle-dialog
          [open]="showAddDialog() || showEditDialog()"
          [mode]="showEditDialog() ? 'edit' : 'create'"
          [vehicleId]="editVehicleId()"
          (done)="onDialogClosed()"
        />
      }

      <!-- Assign Tracker Drawer -->
      @if (showAssignTracker()) {
        <div class="fixed inset-0 z-[9000] flex justify-end">
          <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="showAssignTracker.set(false)"></div>
          <div class="relative w-full max-w-md bg-bg-primary border-l border-border-subtle shadow-2xl
                      flex flex-col animate-slide-in overflow-hidden">
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
                <div class="p-3 rounded-xl bg-red-600/10 border border-red-600/20 text-red-400 text-sm">{{ assignError() }}</div>
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
  `,
  styles: [`
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
      background: radial-gradient(ellipse, rgba(59,130,246,.06) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%;
      animation: morph2 10s ease-in-out infinite alternate;
    }
    .vlist-glow {
      position: fixed; top: 30%; left: 50%; transform: translate(-50%, -50%); width: 35%; height: 40%;
      background: radial-gradient(ellipse, rgba(168,85,247,.05) 0%, transparent 70%);
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
      .vlist-actions { width: 100%; justify-content: space-between }
    }

    .tab-switch { display: flex; border-radius: 10px; border: 1px solid var(--border-subtle); overflow: hidden }
    .tab-btn {
      display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: 12px; font-weight: 600;
      background: var(--bg-secondary); color: var(--fg-tertiary); cursor: pointer; transition: all .2s; border: none;
    }
    .tab-btn:hover { color: var(--fg-secondary) }
    .tab-btn.active { background: #059669; color: white }

    .add-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px; font-size: 12px; font-weight: 700;
      background: #059669; color: white; border: none; cursor: pointer; box-shadow: 0 2px 8px rgba(5,150,105,.3);
    }
    .add-btn:hover { background: #047857 }

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
      color: #FFFFFF;
      background: linear-gradient(135deg,
        #A7F3D0 0%, #5EEAD4 20%, #6EE7B7 40%, #34D399 55%, #67E8F9 75%, #A7F3D0 100%);
      background-size: 240% 240%;
      animation: vlist-fab-gradient 8s ease-in-out infinite;
      box-shadow:
        0 8px 22px rgba(94,234,212,.35),
        0 2px 8px rgba(16,224,160,.22),
        inset 0 1px 0 rgba(255,255,255,.55);
      opacity: .92;
      transition: transform .25s cubic-bezier(0.34, 1.56, 0.64, 1), filter .2s, opacity .2s;
    }
    .vlist-fab:hover { opacity: 1; filter: brightness(1.05); }
    .vlist-fab:active { transform: scale(.92); opacity: 1; filter: brightness(1.08); }
    :host-context([data-theme='dark']) .vlist-fab { color: #000000; }
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
    .vlist-count { font-size: 12px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap }

    /* #3 — toggle cartes / tableau */
    .view-switch { display: flex; margin-left: auto; border-radius: 9px; border: 1px solid var(--border-subtle); overflow: hidden }
    .view-btn { display: flex; align-items: center; padding: 7px 11px; background: var(--bg-secondary); color: var(--fg-tertiary); border: none; cursor: pointer; transition: all .2s }
    .view-btn:hover { color: var(--fg-secondary) }
    .view-btn.active { background: #059669; color: #fff }

    /* #3 — vue tableau véhicules */
    .v-table-wrap { position: relative; z-index: 1; overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary) }
    .v-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px }
    .v-table thead th { text-align: left; padding: 11px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); border-bottom: 1px solid var(--border-subtle); font-weight: 700 }
    .v-table tbody tr { border-bottom: 1px solid var(--border-subtle); transition: background .15s }
    .v-table tbody tr:last-child { border-bottom: none }
    .v-table tbody tr:hover { background: var(--bg-tertiary) }
    .v-table td { padding: 10px 14px; color: var(--fg-secondary); vertical-align: middle }
    .v-td-plate a { font-family: var(--font-mono, monospace); font-weight: 800; color: var(--fg-primary); text-decoration: none; letter-spacing: .03em }
    .v-td-plate a:hover { color: var(--tracky-light) }
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
    .empty-cta { font-size: 13px; color: var(--tracky-light); background: none; border: none; cursor: pointer; text-decoration: underline }

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
    .v-type-icon.online { background: rgba(16,224,160,.15); color: var(--tracky-light) }
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
      background: #10b981;
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
      color: #10E0A0; background: rgba(16,224,160,.12); border-color: rgba(16,224,160,.25);
    }
    .v-live-pill--moving .v-live-dot { background: #10E0A0; box-shadow: 0 0 6px rgba(16,224,160,.6) }
    .v-live-pill--idle {
      color: #f59e0b; background: rgba(245,158,11,.1); border-color: rgba(245,158,11,.22);
    }
    .v-live-pill--idle .v-live-dot { background: #f59e0b }
    .v-live-pill--stopped {
      color: var(--fg-tertiary); background: var(--bg-tertiary); border-color: var(--border-subtle);
    }
    .v-live-pill--stopped .v-live-dot { background: var(--fg-tertiary) }

    /* V1.15 — badge installation (derive IMEI + SIM) */
    .v-inst { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 9999px; line-height: 1.4 }
    .v-inst--installed { color: var(--tracky-light); background: rgba(16,224,160,.12); border: 1px solid rgba(16,224,160,.22) }
    .v-inst--no-sim { color: #f59e0b; background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.22) }

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
    .v-action-btn.edit:hover { color: #60a5fa; border-color: rgba(59,130,246,.2); background: rgba(59,130,246,.06) }
    .v-action-btn.delete:hover { color: #f87171; border-color: rgba(239,68,68,.2); background: rgba(239,68,68,.06) }
    .v-tracker { display: flex; align-items: center; gap: 5px; font-size: 11px; font-family: var(--font-mono, monospace); color: var(--fg-tertiary) }
    .v-assign-btn {
      font-size: 11px; color: var(--tracky-light); background: none; border: none; cursor: pointer; font-weight: 600;
    }
    .v-assign-btn:hover { text-decoration: underline }
    .v-no-tracker { font-size: 11px; color: var(--fg-tertiary); font-style: italic }

    .animate-slide-in { animation: slideIn .25s ease-out }
    @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
  `],
})
export class VehiclesListComponent implements OnInit {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly realtime = inject(RealtimeService);
  protected readonly perms = inject(PermissionsService);
  private readonly preferences = inject(PreferencesService);

  // #3 — vue liste : cartes (défaut) ou tableau, persistée dans PreferencesService.
  protected readonly viewMode = signal<'cards' | 'table'>(this.preferences.prefs().vehiclesView);

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  // #2 — recherche client-side (plaque / marque / modèle / IMEI).
  protected readonly search = signal('');
  protected readonly filteredVehicles = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.vehicles();
    return this.vehicles().filter((v) =>
      v.plate.toLowerCase().includes(q) ||
      (v.brand ?? '').toLowerCase().includes(q) ||
      (v.model ?? '').toLowerCase().includes(q) ||
      (v.tracker?.imei ?? '').toLowerCase().includes(q),
    );
  });
  protected readonly loading = signal(true);
  protected readonly showAddDialog = signal(false);
  protected readonly showEditDialog = signal(false);
  protected readonly editVehicleId = signal('');
  protected readonly activeTab = signal<'vehicles' | 'groups'>('vehicles');

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
  protected readonly RadioIcon = Radio;
  protected readonly PencilIcon = Pencil;
  protected readonly Trash2Icon = Trash2;
  protected readonly EyeIcon = Eye;
  protected readonly SearchIcon = Search;
  protected readonly LayoutGridIcon = LayoutGrid;
  protected readonly TableIcon = Table;

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

  ngOnInit(): void {
    this.loadVehicles();
  }

  protected setViewMode(mode: 'cards' | 'table'): void {
    this.viewMode.set(mode);
    this.preferences.update({ vehiclesView: mode });
  }

  protected onDialogClosed(): void {
    this.showAddDialog.set(false);
    this.showEditDialog.set(false);
    this.editVehicleId.set('');
    this.loadVehicles();
  }

  protected isTrackerOnline(trackerId: string, httpStatus: string): boolean {
    const live = this.realtime.trackerStatuses().get(trackerId);
    if (live) return live === 'online';
    return httpStatus === 'ONLINE';
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
    const speedKmh = Math.round(pos.speedKmh);
    if (pos.ignition && speedKmh > 3) {
      return { kind: 'moving', speedKmh, cssClass: 'v-live-pill--moving' };
    }
    if (pos.ignition) {
      return { kind: 'idle', speedKmh, cssClass: 'v-live-pill--idle' };
    }
    return { kind: 'stopped', speedKmh, cssClass: 'v-live-pill--stopped' };
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
    } catch { /* error */ }
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
      const msg = (err as { error?: { message?: string } })?.error?.message ?? 'Erreur';
      this.assignError.set(typeof msg === 'string' ? msg : String(msg));
    } finally { this.assignLoading.set(false); }
  }

  private async loadVehicles(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.vehiclesApi.list());
      this.vehicles.set(list);
    } catch {
      this.vehicles.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
