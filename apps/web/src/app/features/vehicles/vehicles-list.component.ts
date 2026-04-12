import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Truck, ExternalLink, FolderOpen, Radio, X, Save, Wifi } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { TrackersApiService } from '../../core/services/trackers.service';
import { getVehicleSvg, getVehicleTypeLabel } from '../../shared/utils/vehicle-icons';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { AddVehicleDialogComponent } from './add-vehicle-dialog/add-vehicle-dialog.component';
import { VehicleGroupsTabComponent } from './vehicle-groups-tab.component';

@Component({
  selector: 'app-vehicles-list',
  standalone: true,
  imports: [RouterLink, FormsModule, LucideAngularModule, AddVehicleDialogComponent, VehicleGroupsTabComponent],
  template: `
    <div class="vlist-page">
      <div class="vlist-grid-bg"></div>
      <div class="vlist-glow"></div>

      <!-- Header -->
      <div class="vlist-header">
        <div>
          <h1 class="vlist-title">Vehicules</h1>
          <p class="vlist-sub">{{ vehicles().length }} vehicule(s) dans votre flotte</p>
        </div>
        <div class="vlist-actions">
          @if (perms.can('groups_view')) {
            <div class="tab-switch">
              <button (click)="activeTab.set('vehicles')" class="tab-btn" [class.active]="activeTab() === 'vehicles'">
                <lucide-icon [img]="TruckIcon" [size]="13"></lucide-icon> Vehicules
              </button>
              <button (click)="activeTab.set('groups')" class="tab-btn" [class.active]="activeTab() === 'groups'">
                <lucide-icon [img]="FolderOpenIcon" [size]="13"></lucide-icon> Groupes
              </button>
            </div>
          }
          @if (perms.can('vehicles_create') && activeTab() === 'vehicles') {
            <button (click)="showAddDialog.set(true)" class="add-btn">
              <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Ajouter
            </button>
          }
        </div>
      </div>

      @if (activeTab() === 'groups') {
        <app-vehicle-groups-tab />
      } @else {
        @if (loading()) {
          <div class="vlist-loading">
            <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="vlist-empty">
            <div class="empty-icon"><lucide-icon [img]="Truck" [size]="36"></lucide-icon></div>
            <p class="empty-text">Aucun vehicule {{ perms.can('vehicles_create') ? 'dans votre flotte' : 'accessible' }}</p>
            @if (perms.can('vehicles_create')) {
              <button (click)="showAddDialog.set(true)" class="empty-cta">Ajouter votre premier vehicule</button>
            }
          </div>
        } @else {
          <div class="v-grid">
            @for (v of vehicles(); track v.id) {
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
                <div class="v-card-mid">
                  @if (v.brand) {
                    <span class="v-brand">{{ v.brand }} {{ v.model ?? '' }}</span>
                  } @else {
                    <span class="v-brand muted">Non renseigne</span>
                  }
                </div>
                <div class="v-card-bottom">
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
              </a>
            }
          </div>
        }

        <app-add-vehicle-dialog
          [open]="showAddDialog()"
          (created)="onDialogClosed()"
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
                  <p class="text-[10px] text-fg-tertiary">Vehicule {{ assignPlate() }}</p>
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
                <p class="text-[10px] text-fg-tertiary mt-1">15 chiffres, visible sur l'etiquette du boitier</p>
              </div>
              <div>
                <label class="block text-[11px] font-semibold text-fg-tertiary mb-1">MODELE (OPTIONNEL)</label>
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

    .vlist-loading { position: relative; z-index: 1; display: flex; justify-content: center; padding: 60px 0 }

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

    .v-card-mid { margin-bottom: 12px }
    .v-brand { font-size: 13px; font-weight: 500; color: var(--fg-secondary) }
    .v-brand.muted { color: var(--fg-tertiary); font-style: italic }

    .v-card-bottom { padding-top: 10px; border-top: 1px solid var(--border-subtle) }
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

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly showAddDialog = signal(false);
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

  protected getTypeIconHtml(type: string): string {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${getVehicleSvg(type)}</svg>`;
  }
  protected readonly WifiIcon = Wifi;
  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;

  ngOnInit(): void {
    this.loadVehicles();
  }

  protected onDialogClosed(): void {
    this.showAddDialog.set(false);
    this.loadVehicles();
  }

  protected isTrackerOnline(trackerId: string, httpStatus: string): boolean {
    const live = this.realtime.trackerStatuses().get(trackerId);
    if (live) return live === 'online';
    return httpStatus === 'ONLINE';
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
