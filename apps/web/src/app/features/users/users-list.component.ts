import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Plus, Trash2, Users, Shield, Pencil } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { VehicleGroupsService } from '../../core/services/vehicle-groups.service';
import { UsersApiService, type TrackyUser } from '../../core/services/users.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { UserDrawerComponent, type UserDrawerData, type UserDrawerResult } from './user-drawer.component';
import { VehicleAccessDrawerComponent, type AccessDrawerData, type AccessDrawerResult } from './vehicle-access-drawer.component';

@Component({
  selector: 'app-users-list',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ConfirmModalComponent, UserDrawerComponent, VehicleAccessDrawerComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Utilisateurs</h1>
        @if (perms.can('users_manage')) {
          <button
            (click)="openCreateDrawer()"
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
              (click)="openCreateDrawer()"
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
                        (click)="openEditDrawer(u)"
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

    <!-- User Drawer (create + edit) -->
    <app-user-drawer
      [open]="showDrawer()"
      [data]="drawerData()"
      [loading]="drawerLoading()"
      (closed)="showDrawer.set(false)"
      (saved)="onDrawerSave($event)"
    />

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

    <!-- Vehicle Access Drawer -->
    <app-vehicle-access-drawer
      [open]="showAccessDrawer()"
      [data]="accessDrawerData()"
      [loading]="savingAccess()"
      (closed)="showAccessDrawer.set(false)"
      (saved)="onAccessDrawerSave($event)"
    />

  `,
})
export class UsersListComponent implements OnInit {
  private readonly usersService = inject(UsersApiService);

  readonly loading = signal(true);
  readonly users = signal<TrackyUser[]>([]);

  // Drawer (create + edit)
  readonly showDrawer = signal(false);
  readonly drawerData = signal<UserDrawerData | null>(null);
  readonly drawerLoading = signal(false);

  readonly showDeleteModal = signal(false);
  readonly deleting = signal(false);
  readonly userToDelete = signal<TrackyUser | null>(null);

  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly groupsService = inject(VehicleGroupsService);

  // Access drawer
  readonly showAccessDrawer = signal(false);
  readonly accessDrawerData = signal<AccessDrawerData | null>(null);
  readonly savingAccess = signal(false);

  private readonly auth = inject(AuthService);
  protected readonly perms = inject(PermissionsService);

  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly UsersIcon = Users;
  protected readonly ShieldIcon = Shield;
  protected readonly PencilIcon = Pencil;

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

  openCreateDrawer(): void {
    this.drawerData.set({ mode: 'create' });
    this.showDrawer.set(true);
  }

  openEditDrawer(user: TrackyUser): void {
    this.drawerData.set({ mode: 'edit', user });
    this.showDrawer.set(true);
  }

  async onDrawerSave(result: UserDrawerResult): Promise<void> {
    this.drawerLoading.set(true);
    try {
      const mode = this.drawerData()?.mode;
      if (mode === 'create') {
        await this.usersService.create({
          email: result.email!,
          password: result.password!,
          firstName: result.firstName,
          lastName: result.lastName,
          role: result.role,
        });
        // Update permissions after creation
        const users = await this.usersService.findAll();
        const created = users.find((u) => u.email === result.email);
        if (created) {
          await this.usersService.update(created.id, { permissions: result.permissions });
        }
      } else {
        const userId = this.drawerData()?.user?.id;
        if (userId) {
          const roleChanged = result.role !== this.drawerData()?.user?.role;
          await this.usersService.update(userId, {
            firstName: result.firstName,
            lastName: result.lastName,
            role: result.role,
            isActive: result.isActive,
            ...(!roleChanged ? { permissions: result.permissions } : {}),
          });
        }
      }
      this.showDrawer.set(false);
      await this.loadUsers();
    } catch { /* error handled in drawer */ }
    finally { this.drawerLoading.set(false); }
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

  // ─── Vehicle Access Drawer ───────────────────────────────

  private accessUserId = '';

  async openAccessModal(user: TrackyUser): Promise<void> {
    this.accessUserId = user.id;

    const [groups, vehicles, currentAccess] = await Promise.all([
      this.groupsService.list(),
      firstValueFrom(this.vehiclesApi.list()),
      this.groupsService.getUserAccess(user.id),
    ]);

    this.accessDrawerData.set({
      userEmail: user.email,
      currentType: currentAccess.type,
      currentGroupIds: currentAccess.groupIds,
      currentVehicleIds: currentAccess.vehicleIds,
      groups,
      vehicles,
    });
    this.showAccessDrawer.set(true);
  }

  async onAccessDrawerSave(result: AccessDrawerResult): Promise<void> {
    this.savingAccess.set(true);
    try {
      await this.groupsService.setUserAccess(this.accessUserId, {
        type: result.type,
        groupIds: result.type === 'ALL' ? [] : result.groupIds,
        vehicleIds: result.type === 'ALL' ? [] : result.vehicleIds,
      });
      this.showAccessDrawer.set(false);
    } catch { /* error */ }
    finally { this.savingAccess.set(false); }
  }
}
