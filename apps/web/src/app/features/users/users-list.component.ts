import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Plus, Trash2, Users, Shield, Pencil } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { VehicleGroupsService, type VehicleGroup, type UserAccess } from '../../core/services/vehicle-groups.service';
import { UsersApiService, type TrackyUser } from '../../core/services/users.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';

@Component({
  selector: 'app-users-list',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ConfirmModalComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Utilisateurs</h1>
        @if (perms.can('users_manage')) {
          <button
            (click)="showCreateModal.set(true)"
            class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl
                   bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer">
            <lucide-icon [img]="Plus" [size]="16"></lucide-icon>
            Ajouter un utilisateur
          </button>
        }
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center h-40">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (users().length === 0) {
        <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-3">
          <lucide-icon [img]="UsersIcon" [size]="48" class="opacity-30"></lucide-icon>
          <p>Aucun utilisateur dans votre flotte</p>
          @if (perms.can('users_manage')) {
            <button
              (click)="showCreateModal.set(true)"
              class="text-sm text-tracky-light hover:underline cursor-pointer">
              Ajouter votre premier utilisateur
            </button>
          }
        </div>
      } @else {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
          <table class="w-full text-sm">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Email</th>
                <th class="p-3 text-left">Nom</th>
                <th class="p-3 text-center">Role</th>
                <th class="p-3 text-center">Statut</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors">
                  <td class="p-3">
                    <span class="font-semibold text-fg-primary">{{ u.email }}</span>
                  </td>
                  <td class="p-3 text-fg-secondary">
                    {{ u.firstName ?? '' }} {{ u.lastName ?? '' }}
                    @if (!u.firstName && !u.lastName) { <span class="text-fg-tertiary">—</span> }
                  </td>
                  <td class="p-3 text-center">
                    <span class="px-2 py-0.5 rounded-full text-xs font-medium"
                          [class]="u.role === 'FLEET_ADMIN' ? 'bg-tracky/20 text-tracky-light' : 'bg-bg-tertiary text-fg-secondary'">
                      {{ roleLabel(u.role) }}
                    </span>
                  </td>
                  <td class="p-3 text-center">
                    <span class="w-2 h-2 rounded-full inline-block"
                          [class]="u.isActive ? 'bg-tracky-light' : 'bg-red-400'"></span>
                  </td>
                  <td class="p-3 text-right flex items-center justify-end gap-1">
                    @if (u.role !== 'FLEET_ADMIN' && perms.can('users_manage')) {
                      <button
                        (click)="openEditModal(u)"
                        title="Modifier l'utilisateur"
                        class="p-1.5 rounded-lg text-fg-tertiary hover:text-tracky-light hover:bg-tracky/10
                               transition-colors cursor-pointer">
                        <lucide-icon [img]="PencilIcon" [size]="16"></lucide-icon>
                      </button>
                      <button
                        (click)="openAccessModal(u)"
                        title="Gerer l'acces vehicules"
                        class="p-1.5 rounded-lg text-fg-tertiary hover:text-tracky-light hover:bg-tracky/10
                               transition-colors cursor-pointer">
                        <lucide-icon [img]="ShieldIcon" [size]="16"></lucide-icon>
                      </button>
                      <button
                        (click)="confirmDelete(u)"
                        class="p-1.5 rounded-lg text-fg-tertiary hover:text-red-400 hover:bg-red-400/10
                               transition-colors cursor-pointer">
                        <lucide-icon [img]="Trash2" [size]="16"></lucide-icon>
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <!-- Create Modal -->
    <app-confirm-modal
      [open]="showCreateModal()"
      title="Ajouter un utilisateur"
      confirmLabel="Creer"
      [loading]="creating()"
      (confirmed)="onCreate()"
      (cancelled)="showCreateModal.set(false)"
    >
      <div class="flex flex-col gap-3 mt-4">
        @if (createError()) {
          <p class="text-sm text-red-400">{{ createError() }}</p>
        }
        <input type="email" [(ngModel)]="newEmail" placeholder="Email"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        <input type="password" [(ngModel)]="newPassword" placeholder="Mot de passe (min 12 car.)"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        <div class="grid grid-cols-2 gap-3">
          <input type="text" [(ngModel)]="newFirstName" placeholder="Prenom (optionnel)"
            class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                   placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
          <input type="text" [(ngModel)]="newLastName" placeholder="Nom (optionnel)"
            class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                   placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        </div>
        <select [(ngModel)]="newRole"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 focus:outline-none focus:border-tracky">
          <option value="VIEWER">Lecteur</option>
          <option value="FLEET_MANAGER">Manager</option>
        </select>
      </div>
    </app-confirm-modal>

    <!-- Delete Modal -->
    <app-confirm-modal
      [open]="showDeleteModal()"
      title="Supprimer l'utilisateur"
      [description]="'Voulez-vous supprimer <strong>' + (userToDelete()?.email ?? '') + '</strong> ? Cette action est irreversible.'"
      confirmLabel="Supprimer"
      [danger]="true"
      [loading]="deleting()"
      (confirmed)="onDelete()"
      (cancelled)="showDeleteModal.set(false)"
    />

    <!-- Access Modal -->
    <app-confirm-modal
      [open]="showAccessModal()"
      [title]="'Acces vehicules — ' + (accessUser()?.email ?? '')"
      confirmLabel="Enregistrer"
      [loading]="savingAccess()"
      (confirmed)="onSaveAccess()"
      (cancelled)="showAccessModal.set(false)"
    >
      <div class="flex flex-col gap-3 mt-4">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="radio" name="accessType" value="ALL" [(ngModel)]="accessType"
            class="accent-[var(--tracky)]" />
          <span class="text-sm text-fg-primary">Tous les vehicules</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="radio" name="accessType" value="CUSTOM" [(ngModel)]="accessType"
            class="accent-[var(--tracky)]" />
          <span class="text-sm text-fg-primary">Selection personnalisee</span>
        </label>

        @if (accessType === 'CUSTOM') {
          @if (accessGroups().length > 0) {
            <div class="mt-2">
              <p class="text-xs font-semibold text-fg-tertiary uppercase mb-1">Groupes</p>
              @for (g of accessGroups(); track g.id) {
                <label class="flex items-center gap-2 py-1 cursor-pointer">
                  <input type="checkbox" [checked]="selectedGroupIds.has(g.id)"
                    (change)="toggleGroup(g.id)" class="accent-[var(--tracky)]" />
                  <span class="text-sm text-fg-secondary">{{ g.name }} ({{ g._count.vehicles }})</span>
                </label>
              }
            </div>
          }
          <div class="mt-2">
            <p class="text-xs font-semibold text-fg-tertiary uppercase mb-1">Vehicules individuels</p>
            @for (v of accessVehicles(); track v.id) {
              <label class="flex items-center gap-2 py-1 cursor-pointer">
                <input type="checkbox" [checked]="selectedVehicleIds.has(v.id)"
                  (change)="toggleVehicle(v.id)" class="accent-[var(--tracky)]" />
                <span class="text-sm text-fg-secondary">{{ v.plate }} — {{ v.brand ?? '' }}</span>
              </label>
            }
          </div>
        }
      </div>
    </app-confirm-modal>

    <!-- Edit Modal -->
    <app-confirm-modal
      [open]="showEditModal()"
      [title]="'Modifier — ' + (editUser()?.email ?? '')"
      confirmLabel="Enregistrer"
      [loading]="saving()"
      (confirmed)="onSaveEdit()"
      (cancelled)="showEditModal.set(false)"
    >
      <div class="flex flex-col gap-3 mt-4">
        <div class="grid grid-cols-2 gap-3">
          <input type="text" [(ngModel)]="editFirstName" placeholder="Prenom"
            class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                   placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
          <input type="text" [(ngModel)]="editLastName" placeholder="Nom"
            class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                   placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        </div>
        <select [(ngModel)]="editRole" (ngModelChange)="onRoleChange($event)"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 focus:outline-none focus:border-tracky">
          <option value="VIEWER">Lecteur</option>
          <option value="FLEET_MANAGER">Manager</option>
        </select>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" [(ngModel)]="editIsActive" class="accent-[var(--tracky)]" />
          <span class="text-sm text-fg-primary">Compte actif</span>
        </label>

        <!-- Permissions -->
        <div class="mt-2 border-t border-border-subtle pt-3">
          <p class="text-xs font-semibold text-fg-tertiary uppercase mb-2">Permissions</p>
          <div class="grid grid-cols-1 gap-1.5 text-sm">
            @for (group of permissionGroups; track group.label) {
              <p class="text-[10px] font-bold text-fg-tertiary uppercase mt-1">{{ group.label }}</p>
              @for (p of group.items; track p.key) {
                <label class="flex items-center justify-between gap-2 py-0.5 cursor-pointer">
                  <span class="text-fg-secondary text-xs">{{ p.label }}</span>
                  <input type="checkbox" [checked]="editPerms[p.key]"
                    (change)="editPerms[p.key] = !editPerms[p.key]" class="accent-[var(--tracky)]" />
                </label>
              }
            }
          </div>
        </div>
      </div>
    </app-confirm-modal>
  `,
})
export class UsersListComponent implements OnInit {
  private readonly usersService = inject(UsersApiService);

  readonly loading = signal(true);
  readonly users = signal<TrackyUser[]>([]);

  readonly showCreateModal = signal(false);
  readonly creating = signal(false);
  readonly createError = signal('');
  newEmail = '';
  newPassword = '';
  newFirstName = '';
  newLastName = '';

  readonly showDeleteModal = signal(false);
  readonly deleting = signal(false);
  readonly userToDelete = signal<TrackyUser | null>(null);

  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly groupsService = inject(VehicleGroupsService);

  // Access modal
  readonly showAccessModal = signal(false);
  readonly savingAccess = signal(false);
  readonly accessUser = signal<TrackyUser | null>(null);
  readonly accessGroups = signal<VehicleGroup[]>([]);
  readonly accessVehicles = signal<VehicleDetailDto[]>([]);
  accessType: 'ALL' | 'CUSTOM' = 'ALL';
  selectedGroupIds = new Set<string>();
  selectedVehicleIds = new Set<string>();

  private readonly auth = inject(AuthService);
  protected readonly perms = inject(PermissionsService);

  // Edit modal
  readonly showEditModal = signal(false);
  readonly saving = signal(false);
  readonly editUser = signal<TrackyUser | null>(null);
  editFirstName = '';
  editLastName = '';
  editRole = 'VIEWER';
  editIsActive = true;

  // Create form
  newRole = 'VIEWER';

  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly UsersIcon = Users;
  protected readonly ShieldIcon = Shield;
  protected readonly PencilIcon = Pencil;

  // Permission groups for the edit modal
  editPerms: Record<string, boolean> = {};
  readonly permissionGroups = [
    { label: 'Vehicules', items: [
      { key: 'vehicles_view', label: 'Voir la liste' },
      { key: 'vehicles_create', label: 'Ajouter' },
      { key: 'vehicles_edit', label: 'Modifier' },
      { key: 'vehicles_delete', label: 'Supprimer' },
    ]},
    { label: 'Groupes', items: [
      { key: 'groups_view', label: 'Voir les groupes' },
      { key: 'groups_manage', label: 'Gerer les groupes' },
    ]},
    { label: 'Geofences', items: [
      { key: 'geofences_view', label: 'Voir' },
      { key: 'geofences_manage', label: 'Creer / Supprimer' },
    ]},
    { label: 'Alertes', items: [
      { key: 'alerts_view', label: 'Voir' },
      { key: 'alerts_acknowledge', label: 'Acquitter' },
    ]},
    { label: 'Rapports', items: [
      { key: 'reports_view', label: 'Voir' },
    ]},
    { label: 'Utilisateurs', items: [
      { key: 'users_view', label: 'Voir' },
      { key: 'users_manage', label: 'Gerer' },
    ]},
  ];

  // Default permissions per role (mirror of backend)
  private readonly roleDefaults: Record<string, Record<string, boolean>> = {
    VIEWER: { vehicles_view: true, vehicles_create: false, vehicles_edit: false, vehicles_delete: false, groups_view: false, groups_manage: false, geofences_view: true, geofences_manage: false, alerts_view: true, alerts_acknowledge: false, reports_view: true, users_view: false, users_manage: false },
    FLEET_MANAGER: { vehicles_view: true, vehicles_create: true, vehicles_edit: true, vehicles_delete: true, groups_view: true, groups_manage: true, geofences_view: true, geofences_manage: true, alerts_view: true, alerts_acknowledge: true, reports_view: true, users_view: false, users_manage: false },
  };

  protected onRoleChange(role: string): void {
    this.editPerms = { ...(this.roleDefaults[role] ?? this.roleDefaults['VIEWER']) };
  }

  async ngOnInit(): Promise<void> {
    await this.loadUsers();
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    try {
      this.users.set(await this.usersService.findAll());
    } catch { /* error */ }
    finally { this.loading.set(false); }
  }

  roleLabel(role: string): string {
    const map: Record<string, string> = {
      SUPER_ADMIN: 'Super Admin',
      FLEET_ADMIN: 'Administrateur',
      FLEET_MANAGER: 'Manager',
      VIEWER: 'Lecteur',
    };
    return map[role] ?? role;
  }

  async onCreate(): Promise<void> {
    if (!this.newEmail || !this.newPassword) return;
    this.creating.set(true);
    this.createError.set('');
    try {
      await this.usersService.create({
        email: this.newEmail,
        password: this.newPassword,
        firstName: this.newFirstName || undefined,
        lastName: this.newLastName || undefined,
        role: this.newRole,
      });
      this.showCreateModal.set(false);
      this.newEmail = '';
      this.newPassword = '';
      this.newFirstName = '';
      this.newLastName = '';
      this.newRole = 'VIEWER';
      await this.loadUsers();
    } catch (e) {
      this.createError.set((e as Error).message);
    } finally {
      this.creating.set(false);
    }
  }

  confirmDelete(user: TrackyUser): void {
    this.userToDelete.set(user);
    this.showDeleteModal.set(true);
  }

  async onDelete(): Promise<void> {
    const user = this.userToDelete();
    if (!user) return;
    this.deleting.set(true);
    try {
      await this.usersService.remove(user.id);
      this.showDeleteModal.set(false);
      this.userToDelete.set(null);
      await this.loadUsers();
    } catch { /* error */ }
    finally { this.deleting.set(false); }
  }

  // ─── Edit User ────────────────────────────────────────────

  openEditModal(user: TrackyUser): void {
    this.editUser.set(user);
    this.editFirstName = user.firstName ?? '';
    this.editLastName = user.lastName ?? '';
    this.editRole = user.role;
    this.editIsActive = user.isActive;
    // Load existing permissions or defaults for the role
    const existing = (user as unknown as { permissions?: Record<string, boolean> }).permissions;
    this.editPerms = existing ? { ...existing } : { ...(this.roleDefaults[user.role] ?? this.roleDefaults['VIEWER']) };
    this.showEditModal.set(true);
  }

  async onSaveEdit(): Promise<void> {
    const user = this.editUser();
    if (!user) return;
    this.saving.set(true);
    try {
      const roleChanged = this.editRole !== user.role;
      await this.usersService.update(user.id, {
        firstName: this.editFirstName || undefined,
        lastName: this.editLastName || undefined,
        role: this.editRole,
        isActive: this.editIsActive,
        // Si le rôle change, le backend reset les perms par défaut. Sinon envoyer les perms custom.
        ...(!roleChanged ? { permissions: this.editPerms } : {}),
      });
      this.showEditModal.set(false);
      await this.loadUsers();
    } catch { /* error */ }
    finally { this.saving.set(false); }
  }

  // ─── Vehicle Access ──────────────────────────────────────

  async openAccessModal(user: TrackyUser): Promise<void> {
    this.accessUser.set(user);
    this.showAccessModal.set(true);

    const [groups, vehicles, currentAccess] = await Promise.all([
      this.groupsService.list(),
      firstValueFrom(this.vehiclesApi.list()),
      this.groupsService.getUserAccess(user.id),
    ]);

    this.accessGroups.set(groups);
    this.accessVehicles.set(vehicles);
    this.accessType = currentAccess.type;
    this.selectedGroupIds = new Set(currentAccess.groupIds);
    this.selectedVehicleIds = new Set(currentAccess.vehicleIds);
  }

  toggleGroup(id: string): void {
    if (this.selectedGroupIds.has(id)) this.selectedGroupIds.delete(id);
    else this.selectedGroupIds.add(id);
  }

  toggleVehicle(id: string): void {
    if (this.selectedVehicleIds.has(id)) this.selectedVehicleIds.delete(id);
    else this.selectedVehicleIds.add(id);
  }

  async onSaveAccess(): Promise<void> {
    const user = this.accessUser();
    if (!user) return;
    this.savingAccess.set(true);
    try {
      await this.groupsService.setUserAccess(user.id, {
        type: this.accessType,
        groupIds: this.accessType === 'ALL' ? [] : [...this.selectedGroupIds],
        vehicleIds: this.accessType === 'ALL' ? [] : [...this.selectedVehicleIds],
      });
      this.showAccessModal.set(false);
    } catch { /* error */ }
    finally { this.savingAccess.set(false); }
  }
}
