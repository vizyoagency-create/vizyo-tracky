import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Plus, Trash2, FolderOpen, Truck } from 'lucide-angular';
import { VehicleGroupsService, type VehicleGroup } from '../../core/services/vehicle-groups.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { firstValueFrom } from 'rxjs';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-vehicle-groups-tab',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ConfirmModalComponent],
  template: `
    <div class="flex flex-col gap-4">
      <!-- Header : description + bouton (stack en mobile, row en desktop) -->
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-fg-secondary flex-1">Organisez vos véhicules en groupes pour gérer les accès.</p>
        <button (click)="showCreateModal.set(true)"
          class="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl
                 bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer
                 whitespace-nowrap shrink-0 self-start sm:self-auto">
          <lucide-icon [img]="Plus" [size]="14"></lucide-icon>
          Nouveau groupe
        </button>
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-5 h-5 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (groups().length === 0) {
        <div class="flex flex-col items-center justify-center h-32 rounded-xl
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
          <lucide-icon [img]="FolderOpen" [size]="36" class="opacity-30"></lucide-icon>
          <p class="text-sm">Aucun groupe créé</p>
        </div>
      } @else {
        <div class="flex flex-col gap-3">
          @for (g of groups(); track g.id) {
            <div class="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <lucide-icon [img]="FolderOpen" [size]="16" class="text-tracky-light"></lucide-icon>
                  <span class="font-semibold text-fg-primary text-sm">{{ g.name }}</span>
                  <span class="text-xs text-fg-tertiary">({{ g._count.vehicles }} véhicule{{ g._count.vehicles > 1 ? 's' : '' }})</span>
                </div>
                <button (click)="confirmDeleteGroup(g)"
                  class="p-1 rounded-lg text-fg-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer">
                  <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                </button>
              </div>

              <!-- Véhicules du groupe -->
              <div class="flex flex-wrap gap-2 mb-3">
                @for (va of g.vehicles; track va.vehicleId) {
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-tertiary text-xs text-fg-secondary">
                    <lucide-icon [img]="TruckIcon" [size]="12"></lucide-icon>
                    {{ vehiclePlate(va.vehicleId) }}
                    <button (click)="removeFromGroup(g.id, va.vehicleId)"
                      class="ml-1 text-fg-tertiary hover:text-red-400 cursor-pointer">&times;</button>
                  </span>
                }
                @if (g.vehicles.length === 0) {
                  <span class="text-xs text-fg-tertiary italic">Aucun véhicule assigné</span>
                }
              </div>

              <!-- Ajouter un véhicule -->
              <div class="flex items-center gap-2">
                <select [(ngModel)]="selectedVehicleForGroup[g.id]"
                  class="flex-1 px-2.5 py-1.5 rounded-lg bg-bg-tertiary border border-border-subtle text-fg-primary text-xs
                         focus:outline-none focus:border-tracky">
                  <option value="">Ajouter un véhicule...</option>
                  @for (v of availableVehicles(g); track v.id) {
                    <option [value]="v.id">{{ v.plate }} — {{ v.brand ?? '' }} {{ v.model ?? '' }}</option>
                  }
                </select>
                <button (click)="addToGroup(g.id)"
                  [disabled]="!selectedVehicleForGroup[g.id]"
                  class="px-2.5 py-1.5 rounded-lg bg-tracky/20 text-tracky-light text-xs font-medium
                         hover:bg-tracky/30 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors">
                  Ajouter
                </button>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Create Group Modal -->
    <app-confirm-modal
      [open]="showCreateModal()"
      title="Nouveau groupe"
      confirmLabel="Créer"
      [loading]="creating()"
      (confirmed)="onCreate()"
      (cancelled)="showCreateModal.set(false)"
    >
      <div class="mt-4">
        @if (createError()) {
          <p class="text-sm text-red-400 mb-2">{{ createError() }}</p>
        }
        <input type="text" [(ngModel)]="newGroupName" placeholder="Nom du groupe (ex: Camions Nord)"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
      </div>
    </app-confirm-modal>

    <!-- Delete Group Modal -->
    <app-confirm-modal
      [open]="showDeleteModal()"
      title="Supprimer le groupe"
      [description]="'Supprimer le groupe <strong>' + (groupToDelete()?.name ?? '') + '</strong> ? Les véhicules ne seront pas supprimés.'"
      confirmLabel="Supprimer"
      [danger]="true"
      [loading]="deleting()"
      (confirmed)="onDeleteGroup()"
      (cancelled)="showDeleteModal.set(false)"
    />
  `,
})
export class VehicleGroupsTabComponent implements OnInit {
  private readonly groupsService = inject(VehicleGroupsService);
  private readonly vehiclesApi = inject(VehiclesApiService);

  readonly loading = signal(true);
  readonly groups = signal<VehicleGroup[]>([]);
  readonly allVehicles = signal<VehicleDetailDto[]>([]);

  readonly showCreateModal = signal(false);
  readonly creating = signal(false);
  readonly createError = signal('');
  newGroupName = '';

  readonly showDeleteModal = signal(false);
  readonly deleting = signal(false);
  readonly groupToDelete = signal<VehicleGroup | null>(null);

  selectedVehicleForGroup: Record<string, string> = {};

  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly FolderOpen = FolderOpen;
  protected readonly TruckIcon = Truck;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [groups, vehicles] = await Promise.all([
        this.groupsService.list(),
        firstValueFrom(this.vehiclesApi.list()),
      ]);
      this.groups.set(groups);
      this.allVehicles.set(vehicles);
    } catch { /* error */ }
    finally { this.loading.set(false); }
  }

  vehiclePlate(vehicleId: string): string {
    return this.allVehicles().find((v) => v.id === vehicleId)?.plate ?? vehicleId.slice(0, 8);
  }

  availableVehicles(group: VehicleGroup): VehicleDetailDto[] {
    const assigned = new Set(group.vehicles.map((v) => v.vehicleId));
    return this.allVehicles().filter((v) => !assigned.has(v.id));
  }

  async addToGroup(groupId: string): Promise<void> {
    const vehicleId = this.selectedVehicleForGroup[groupId];
    if (!vehicleId) return;
    await this.groupsService.addVehicle(groupId, vehicleId);
    this.selectedVehicleForGroup[groupId] = '';
    await this.load();
  }

  async removeFromGroup(groupId: string, vehicleId: string): Promise<void> {
    await this.groupsService.removeVehicle(groupId, vehicleId);
    await this.load();
  }

  async onCreate(): Promise<void> {
    if (!this.newGroupName.trim()) return;
    this.creating.set(true);
    this.createError.set('');
    try {
      await this.groupsService.create(this.newGroupName.trim());
      this.showCreateModal.set(false);
      this.newGroupName = '';
      await this.load();
    } catch (e) {
      this.createError.set((e as Error).message);
    } finally { this.creating.set(false); }
  }

  confirmDeleteGroup(group: VehicleGroup): void {
    this.groupToDelete.set(group);
    this.showDeleteModal.set(true);
  }

  async onDeleteGroup(): Promise<void> {
    const g = this.groupToDelete();
    if (!g) return;
    this.deleting.set(true);
    try {
      await this.groupsService.remove(g.id);
      this.showDeleteModal.set(false);
      this.groupToDelete.set(null);
      await this.load();
    } catch { /* error */ }
    finally { this.deleting.set(false); }
  }
}
