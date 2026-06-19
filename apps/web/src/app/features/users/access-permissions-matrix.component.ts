import { Component, computed, inject, input, OnChanges, OnInit, output, signal, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, X, Plus, Trash2, Globe, FolderOpen, Truck } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  PERMISSION_GROUP_ORDER,
  PERMISSION_LABELS,
  type UserPermissions,
  getDefaultPermissions,
} from '@vizyo/tracky-shared';
import type { VehicleGroup } from '../../core/services/vehicle-groups.service';
import type { VehicleDetailDto } from '../../core/services/vehicles.service';
import { UserAccessService, type AccessEntryDto } from '../../core/services/user-access.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

export interface MatrixDrawerData {
  userId: string;
  userEmail: string;
  userRole: 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' | 'NIGHT_WATCHMAN';
  groups: VehicleGroup[];
  vehicles: VehicleDetailDto[];
}

/**
 * V1.11 Phase 1 — Matrice 2D acces x permissions.
 *
 * Lignes = scopes (entries UserVehicleAccess : ALL, GROUP, VEHICLE).
 * Colonnes = permissions regroupees par categorie metier (Vehicules, Groupes, ...).
 * Chaque case = toggle qui PATCH l'entry correspondante.
 *
 * Note design : on n'edite PAS le scope (groupId / vehicleId) une fois la ligne
 * cree. Pour changer le scope, supprimer la ligne et en recreer une.
 *
 * Resolution per-vehicle (rappel doc backend) : VEHICLE > GROUP > ALL. Si un
 * user a `engine_control=true` sur ALL et `=false` sur un vehicule X, X gagne.
 */
@Component({
  selector: 'app-access-permissions-matrix',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative w-full max-w-3xl bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden">

          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div>
              <h2 class="text-lg font-display font-bold text-fg-primary">Acces & Permissions</h2>
              <p class="text-xs text-fg-tertiary mt-0.5">{{ data()?.userEmail }} ({{ data()?.userRole }})</p>
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          @if (loading()) {
            <div class="flex-1 flex items-center justify-center">
              <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
            </div>
          } @else {
            <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              <!-- Add new scope -->
              <div class="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-bg-secondary border border-border-subtle">
                <span class="text-xs text-fg-secondary font-medium mr-2">Ajouter un scope :</span>
                @if (!hasAllEntry()) {
                  <button (click)="addEntry('ALL')" class="add-scope-btn">
                    <lucide-icon [img]="GlobeIcon" [size]="14"></lucide-icon>
                    <span>Toute la flotte</span>
                  </button>
                }
                <select [(ngModel)]="newGroupId"
                        class="add-scope-select"
                        [disabled]="availableGroups().length === 0">
                  <option [ngValue]="null">+ Groupe...</option>
                  @for (g of availableGroups(); track g.id) {
                    <option [ngValue]="g.id">{{ g.name }}</option>
                  }
                </select>
                @if (newGroupId) {
                  <button (click)="addGroupEntry()" class="add-scope-confirm">Ajouter</button>
                }
                <select [(ngModel)]="newVehicleId"
                        class="add-scope-select"
                        [disabled]="availableVehicles().length === 0">
                  <option [ngValue]="null">+ Vehicule...</option>
                  @for (v of availableVehicles(); track v.id) {
                    <option [ngValue]="v.id">{{ v.plate }}</option>
                  }
                </select>
                @if (newVehicleId) {
                  <button (click)="addVehicleEntry()" class="add-scope-confirm">Ajouter</button>
                }
              </div>

              <!-- Matrix -->
              @if (entries().length === 0) {
                <div class="flex flex-col items-center justify-center py-12 gap-3 text-fg-tertiary">
                  <lucide-icon [img]="GlobeIcon" [size]="32" class="opacity-30"></lucide-icon>
                  <p class="text-sm">Aucun scope d'acces. Ajoutez-en un ci-dessus.</p>
                </div>
              } @else {
                @for (entry of entries(); track entry.id) {
                  <div class="rounded-xl bg-bg-secondary border border-border-subtle p-4">
                    <div class="flex items-center justify-between mb-3">
                      <div class="flex items-center gap-2">
                        @if (entry.accessType === 'ALL') {
                          <lucide-icon [img]="GlobeIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                          <span class="text-sm font-semibold text-fg-primary">Toute la flotte</span>
                        } @else if (entry.accessType === 'GROUP') {
                          <lucide-icon [img]="FolderIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                          <span class="text-sm font-semibold text-fg-primary">Groupe : {{ groupName(entry.groupId) }}</span>
                        } @else {
                          <lucide-icon [img]="TruckIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                          <span class="text-sm font-semibold text-fg-primary">Vehicule : {{ vehiclePlate(entry.vehicleId) }}</span>
                        }
                      </div>
                      @if (entries().length > 1) {
                        <button (click)="confirmDelete(entry)"
                                class="p-1 rounded text-fg-tertiary hover:text-red-400 hover:bg-red-400/10 cursor-pointer"
                                title="Retirer ce scope">
                          <lucide-icon [img]="TrashIcon" [size]="14"></lucide-icon>
                        </button>
                      }
                    </div>

                    <!-- Permission groups -->
                    @for (group of permissionGroups; track group) {
                      <div class="mb-2 last:mb-0">
                        <p class="text-[10px] uppercase tracking-wide text-fg-tertiary mb-1.5">{{ group }}</p>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5">
                          @for (k of permissionsByGroup[group]; track k) {
                            <label class="flex items-center gap-2 text-xs text-fg-primary cursor-pointer hover:bg-bg-tertiary px-2 py-1 rounded">
                              <input type="checkbox"
                                     [checked]="isChecked(entry, k)"
                                     (change)="togglePermission(entry, k, $any($event.target).checked)" />
                              <span>{{ labelOf(k) }}</span>
                            </label>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              }

              <!-- Doc rapide -->
              <div class="rounded-xl bg-bg-tertiary border border-border-subtle p-3 text-xs text-fg-secondary">
                <strong class="text-fg-primary">Regle de resolution :</strong> en cas de conflit entre plusieurs scopes
                qui couvrent un meme vehicule, le plus specifique gagne (Vehicule &gt; Groupe &gt; Toute la flotte).
                Exemple : <em>engine_control=true</em> sur la flotte et <em>=false</em> sur un vehicule precis → la
                ligne vehicule l'emporte (refus).
              </div>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .animate-slide-in { animation: slideIn 0.25s ease-out; }
    .add-scope-btn {
      display: inline-flex; align-items: center; gap: 0.375rem;
      padding: 0.375rem 0.75rem; font-size: 0.75rem; border-radius: 0.5rem;
      background: var(--tracky); color: white; cursor: pointer;
      border: none; font-weight: 500;
    }
    .add-scope-btn:hover { background: var(--tracky-dark, var(--tracky)); }
    .add-scope-select {
      padding: 0.375rem 0.5rem; font-size: 0.75rem; border-radius: 0.5rem;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); cursor: pointer;
    }
    .add-scope-select:disabled { opacity: 0.4; cursor: not-allowed; }
    .add-scope-confirm {
      padding: 0.375rem 0.75rem; font-size: 0.75rem; border-radius: 0.5rem;
      background: var(--tracky); color: white; cursor: pointer; border: none;
    }
  `],
})
export class AccessPermissionsMatrixComponent implements OnInit, OnChanges {
  readonly open = input(false);
  readonly data = input<MatrixDrawerData | null>(null);
  readonly closed = output<void>();

  private readonly api = inject(UserAccessService);
  private readonly toast = inject(ToastService);

  protected readonly XIcon = X;
  protected readonly GlobeIcon = Globe;
  protected readonly FolderIcon = FolderOpen;
  protected readonly TruckIcon = Truck;
  protected readonly PlusIcon = Plus;
  protected readonly TrashIcon = Trash2;

  protected readonly loading = signal(false);
  protected readonly entries = signal<AccessEntryDto[]>([]);
  protected newGroupId: string | null = null;
  protected newVehicleId: string | null = null;

  // Calcules dans ngOnInit pour eviter "Object.keys(undefined)" si le bundle
  // Angular lazy-charge le shared package APRES l'init des field initializers.
  protected permissionGroups: readonly string[] = [];
  protected permissionsByGroup: Record<string, (keyof UserPermissions)[]> = {};

  protected readonly hasAllEntry = computed(() => this.entries().some((e) => e.accessType === 'ALL'));

  protected readonly usedGroupIds = computed(
    () => new Set(this.entries().filter((e) => e.groupId).map((e) => e.groupId!)),
  );
  protected readonly usedVehicleIds = computed(
    () => new Set(this.entries().filter((e) => e.vehicleId).map((e) => e.vehicleId!)),
  );

  protected readonly availableGroups = computed(() => {
    const used = this.usedGroupIds();
    return (this.data()?.groups ?? []).filter((g) => !used.has(g.id));
  });
  protected readonly availableVehicles = computed(() => {
    const used = this.usedVehicleIds();
    return (this.data()?.vehicles ?? []).filter((v) => !used.has(v.id));
  });

  ngOnInit(): void {
    this.permissionGroups = PERMISSION_GROUP_ORDER ?? [];
    const labels = PERMISSION_LABELS ?? {};
    const groups: Record<string, (keyof UserPermissions)[]> = {};
    for (const key of Object.keys(labels) as (keyof UserPermissions)[]) {
      const label = labels[key];
      if (!label) continue;
      if (!groups[label.group]) groups[label.group] = [];
      groups[label.group].push(key);
    }
    this.permissionsByGroup = groups;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true && this.data()) {
      this.loadEntries();
    }
  }

  protected onClose(): void {
    this.closed.emit();
  }

  protected groupName(id: string | null): string {
    if (!id) return '?';
    return this.data()?.groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  }

  protected vehiclePlate(id: string | null): string {
    if (!id) return '?';
    return this.data()?.vehicles.find((v) => v.id === id)?.plate ?? id.slice(0, 8);
  }

  protected labelOf(k: keyof UserPermissions): string {
    return PERMISSION_LABELS[k].label;
  }

  protected isChecked(entry: AccessEntryDto, key: keyof UserPermissions): boolean {
    if (entry.permissions && key in entry.permissions) {
      return entry.permissions[key] === true;
    }
    // Fallback aux defaults du role (UX : on montre "activable par defaut").
    const role = this.data()?.userRole;
    if (!role) return false;
    return getDefaultPermissions(role)[key] === true;
  }

  protected async togglePermission(entry: AccessEntryDto, key: keyof UserPermissions, value: boolean): Promise<void> {
    const data = this.data();
    if (!data) return;
    const newPerms = { ...(entry.permissions ?? {}), [key]: value };
    try {
      const updated = await firstValueFrom(this.api.updateEntryPermissions(data.userId, entry.id, newPerms));
      this.entries.update((list) => list.map((e) => (e.id === entry.id ? updated : e)));
    } catch (err) {
      this.toast.error('Echec', this.errorMessage(err));
    }
  }

  protected async addEntry(type: 'ALL'): Promise<void> {
    await this.appendEntry({ type });
  }

  protected async addGroupEntry(): Promise<void> {
    if (!this.newGroupId) return;
    await this.appendEntry({ type: 'GROUP', groupId: this.newGroupId });
    this.newGroupId = null;
  }

  protected async addVehicleEntry(): Promise<void> {
    if (!this.newVehicleId) return;
    await this.appendEntry({ type: 'VEHICLE', vehicleId: this.newVehicleId });
    this.newVehicleId = null;
  }

  private async appendEntry(scope: { type: 'ALL' | 'GROUP' | 'VEHICLE'; groupId?: string; vehicleId?: string }): Promise<void> {
    const data = this.data();
    if (!data) return;
    // On reconstruit toutes les entries (PUT remplace), c'est le seul endpoint
    // qui cree une nouvelle ligne. PATCH ne peut que modifier l'existant.
    const next = [
      ...this.entries().map((e) => ({
        type: e.accessType,
        groupId: e.groupId ?? undefined,
        vehicleId: e.vehicleId ?? undefined,
        permissions: e.permissions ?? undefined,
      })),
      scope,
    ];
    try {
      const res = await firstValueFrom(this.api.setAccess(data.userId, next));
      this.entries.set(res.entries);
    } catch (err) {
      this.toast.error('Echec ajout scope', this.errorMessage(err));
    }
  }

  protected async confirmDelete(entry: AccessEntryDto): Promise<void> {
    const data = this.data();
    if (!data) return;
    if (this.entries().length <= 1) {
      this.toast.warning('Impossible', 'Au moins un scope doit subsister');
      return;
    }
    if (!confirm('Retirer ce scope ?')) return;
    try {
      await firstValueFrom(this.api.deleteEntry(data.userId, entry.id));
      this.entries.update((list) => list.filter((e) => e.id !== entry.id));
    } catch (err) {
      this.toast.error('Echec suppression', this.errorMessage(err));
    }
  }

  private async loadEntries(): Promise<void> {
    const data = this.data();
    if (!data) return;
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.getAccess(data.userId));
      this.entries.set(res.entries);
    } catch (err) {
      this.toast.error('Echec chargement', this.errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  private errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'error' in err) {
      const e = (err as { error: { message?: string } }).error;
      return e?.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
