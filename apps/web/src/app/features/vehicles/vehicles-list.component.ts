import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Truck, ExternalLink, FolderOpen, Radio, X, Save } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { TrackersApiService } from '../../core/services/trackers.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { AddVehicleDialogComponent } from './add-vehicle-dialog/add-vehicle-dialog.component';
import { VehicleGroupsTabComponent } from './vehicle-groups-tab.component';

@Component({
  selector: 'app-vehicles-list',
  standalone: true,
  imports: [RouterLink, FormsModule, LucideAngularModule, AddVehicleDialogComponent, VehicleGroupsTabComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Vehicules</h1>
        <div class="flex items-center gap-2">
          @if (perms.can('groups_view')) {
            <div class="flex rounded-xl border border-border-subtle overflow-hidden">
              <button (click)="activeTab.set('vehicles')"
                class="px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                [class]="activeTab() === 'vehicles' ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-secondary hover:text-fg-primary'">
                <lucide-icon [img]="TruckIcon" [size]="12" class="inline mr-1"></lucide-icon> Vehicules
              </button>
              <button (click)="activeTab.set('groups')"
                class="px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                [class]="activeTab() === 'groups' ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-secondary hover:text-fg-primary'">
                <lucide-icon [img]="FolderOpenIcon" [size]="12" class="inline mr-1"></lucide-icon> Groupes
              </button>
            </div>
          }
        </div>
      </div>

      @if (activeTab() === 'groups') {
        <app-vehicle-groups-tab />
      } @else {
        @if (perms.can('vehicles_create')) {
          <div class="flex items-center justify-end">
            <button
              (click)="showAddDialog.set(true)"
              class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl
                     bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer">
              <lucide-icon [img]="Plus" [size]="16"></lucide-icon>
              Ajouter un vehicule
            </button>
          </div>
        }

        @if (loading()) {
          <div class="flex items-center justify-center h-40">
            <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-3">
            <lucide-icon [img]="Truck" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucun vehicule {{ perms.can('vehicles_create') ? 'dans votre flotte' : 'accessible' }}</p>
            @if (perms.can('vehicles_create')) {
              <button
                (click)="showAddDialog.set(true)"
                class="text-sm text-tracky-light hover:underline cursor-pointer">
                Ajouter votre premier vehicule
              </button>
            }
          </div>
        } @else {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
            <table class="w-full text-sm">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Plaque</th>
                  <th class="p-3 text-left">Marque / Modele</th>
                  <th class="p-3 text-left">Annee</th>
                  <th class="p-3 text-left">Tracker</th>
                  <th class="p-3 text-center">Statut</th>
                  <th class="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (v of vehicles(); track v.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors">
                    <td class="p-3">
                      <span class="font-semibold text-fg-primary">{{ v.plate }}</span>
                    </td>
                    <td class="p-3 text-fg-secondary">
                      {{ v.brand ?? '—' }} {{ v.model ?? '' }}
                    </td>
                    <td class="p-3 text-fg-secondary">{{ v.year ?? '—' }}</td>
                    <td class="p-3">
                      @if (v.tracker) {
                        <span class="font-mono text-xs text-fg-secondary">{{ v.tracker.imei }}</span>
                      } @else if (perms.can('vehicles_edit')) {
                        <button (click)="openAssignTracker(v.id)"
                          class="text-xs text-tracky-light hover:underline cursor-pointer">
                          Assigner un tracker
                        </button>
                      } @else {
                        <span class="text-fg-tertiary text-xs">Non assigne</span>
                      }
                    </td>
                    <td class="p-3 text-center">
                      @if (v.tracker) {
                        <span class="w-2 h-2 rounded-full inline-block"
                              [class]="isTrackerOnline(v.tracker.id, v.tracker.status) ? 'bg-tracky-light' : 'bg-fg-tertiary'"></span>
                      } @else {
                        <span class="w-2 h-2 rounded-full bg-fg-tertiary inline-block"></span>
                      }
                    </td>
                    <td class="p-3 text-right">
                      <a [routerLink]="['/vehicles', v.id]"
                         class="inline-flex items-center gap-1 text-xs text-tracky-light hover:underline cursor-pointer">
                        Voir
                        <lucide-icon [img]="ExternalLink" [size]="12"></lucide-icon>
                      </a>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
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
