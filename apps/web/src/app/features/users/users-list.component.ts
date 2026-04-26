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
    <div class="upage">
      <div class="u-blobs"></div>
      <div class="u-blob-c"></div>

      <!-- Header -->
      <div class="u-header">
        <div>
          <h1 class="u-title">Utilisateurs</h1>
          <p class="u-sub">{{ users().length }} membre(s) dans votre flotte</p>
        </div>
        @if (perms.can('users_manage')) {
          <button (click)="openCreateDrawer()" class="u-add-btn">
            <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Ajouter
          </button>
        }
      </div>

      @if (loading()) {
        <div class="u-loading"><span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span></div>
      } @else if (users().length === 0) {
        <div class="u-empty">
          <div class="u-empty-icon"><lucide-icon [img]="UsersIcon" [size]="32"></lucide-icon></div>
          <p>Aucun utilisateur dans votre flotte</p>
          @if (perms.can('users_manage')) {
            <button (click)="openCreateDrawer()" class="u-empty-cta">Ajouter votre premier utilisateur</button>
          }
        </div>
      } @else {
        <div class="u-grid">
          @for (u of users(); track u.id) {
            <div class="u-card" [class.admin]="u.role === 'FLEET_ADMIN'">
              <div class="u-card-glow" [class]="u.role === 'FLEET_ADMIN' ? 'green' : u.role === 'FLEET_MANAGER' ? 'blue' : 'gray'"></div>

              <!-- Top: avatar + info -->
              <div class="u-card-top">
                <div class="u-avatar" [class]="u.role === 'FLEET_ADMIN' ? 'admin' : u.role === 'FLEET_MANAGER' ? 'manager' : 'viewer'">
                  {{ userInitials(u) }}
                </div>
                <div class="u-info">
                  <p class="u-name">{{ u.firstName ?? '' }} {{ u.lastName ?? '' }}{{ !u.firstName && !u.lastName ? u.email.split('&#64;')[0] : '' }}</p>
                  <p class="u-email">{{ u.email }}</p>
                </div>
                <div class="u-status" [class]="u.isActive ? 'active' : 'suspended'">
                  {{ u.isActive ? 'Actif' : 'Suspendu' }}
                </div>
              </div>

              <!-- Mid: role + meta -->
              <div class="u-card-mid">
                <span class="u-role-badge" [class]="u.role === 'FLEET_ADMIN' ? 'admin' : u.role === 'FLEET_MANAGER' ? 'manager' : 'viewer'">
                  {{ roleLabel(u.role) }}
                </span>
                <span class="u-date">Depuis {{ formatDate(u.createdAt) }}</span>
              </div>

              <!-- Bottom: actions -->
              @if (u.role !== 'FLEET_ADMIN' && perms.can('users_manage')) {
                <div class="u-card-actions">
                  <button (click)="openEditDrawer(u)" class="u-action-btn" title="Modifier">
                    <lucide-icon [img]="PencilIcon" [size]="14"></lucide-icon> Modifier
                  </button>
                  <button (click)="openAccessModal(u)" class="u-action-btn" title="Accès véhicules">
                    <lucide-icon [img]="ShieldIcon" [size]="14"></lucide-icon> Accès
                  </button>
                  <button (click)="confirmDelete(u)" class="u-action-btn danger" title="Supprimer">
                    <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                  </button>
                </div>
              }
            </div>
          }
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
      [description]="'Voulez-vous supprimer <strong>' + (userToDelete()?.email ?? '') + '</strong> ? Cette action est irréversible.'"
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
  styles: [`
    .upage { position: relative; min-height: 100% }
    .u-blobs {
      position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden;
    }
    .u-blobs::before {
      content: ''; position: absolute; top: -10%; right: -10%; width: 50%; height: 55%;
      background: radial-gradient(ellipse, rgba(168,85,247,.06) 0%, transparent 70%);
      border-radius: 50% 40% 60% 30%; animation: ub1 12s ease-in-out infinite alternate;
    }
    .u-blobs::after {
      content: ''; position: absolute; bottom: -15%; left: -10%; width: 45%; height: 50%;
      background: radial-gradient(ellipse, rgba(16,224,160,.07) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%; animation: ub2 10s ease-in-out infinite alternate;
    }
    .u-blob-c {
      position: fixed; top: 40%; left: 55%; transform: translate(-50%,-50%); width: 30%; height: 35%;
      background: radial-gradient(ellipse, rgba(59,130,246,.05) 0%, transparent 70%);
      border-radius: 60% 40% 50% 30%; pointer-events: none; z-index: 0;
      animation: ub3 14s ease-in-out infinite alternate;
    }
    @keyframes ub1 { 0%{border-radius:50% 40% 60% 30%;transform:translate(0,0)} 100%{border-radius:30% 60% 40% 50%;transform:translate(-4%,6%)} }
    @keyframes ub2 { 0%{border-radius:40% 60% 30% 50%;transform:translate(0,0)} 100%{border-radius:60% 30% 50% 40%;transform:translate(4%,-4%)} }
    @keyframes ub3 { 0%{border-radius:60% 40% 50% 30%;transform:translate(-50%,-50%) scale(1)} 100%{border-radius:40% 50% 30% 60%;transform:translate(-50%,-50%) scale(1.1)} }

    .u-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px }
    .u-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .u-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .u-add-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px;
      font-size: 12px; font-weight: 700; background: #059669; color: white; border: none; cursor: pointer;
      box-shadow: 0 2px 8px rgba(5,150,105,.3);
    }
    .u-add-btn:hover { background: #047857 }

    .u-loading { position: relative; z-index: 1; display: flex; justify-content: center; padding: 60px 0 }
    .u-empty {
      position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 50px 20px; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.55); backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.1); color: var(--fg-tertiary);
    }
    .u-empty-icon { width: 60px; height: 60px; border-radius: 16px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }
    .u-empty-cta { font-size: 13px; color: var(--tracky-light); background: none; border: none; cursor: pointer; text-decoration: underline }

    /* Grid */
    .u-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px }

    /* Card */
    .u-card {
      position: relative; padding: 18px; border-radius: 14px; overflow: hidden;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.55);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.08); transition: all .3s;
    }
    .u-card:hover { border-color: rgba(16,224,160,.2); box-shadow: 0 0 30px rgba(16,224,160,.06), 0 8px 24px rgba(0,0,0,.15) }
    .u-card.admin { border-color: rgba(16,224,160,.15) }

    :host-context([data-theme="light"]) .u-card { background: rgba(255,255,255,.6); border-color: rgba(16,224,160,.1) }
    :host-context([data-theme="light"]) .u-card:hover { border-color: rgba(16,224,160,.25); box-shadow: 0 0 30px rgba(16,224,160,.05), 0 8px 24px rgba(0,0,0,.05) }

    .u-card-glow { position: absolute; top: 0; right: 0; width: 60px; height: 60px; border-radius: 0 0 0 60px; opacity: .08; pointer-events: none }
    .u-card-glow.green { background: var(--tracky-light) }
    .u-card-glow.blue { background: #3b82f6 }
    .u-card-glow.gray { background: var(--fg-tertiary) }

    /* Top */
    .u-card-top { display: flex; align-items: center; gap: 12px; margin-bottom: 12px }
    .u-avatar {
      width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700; color: white; flex-shrink: 0;
    }
    .u-avatar.admin { background: var(--tracky) }
    .u-avatar.manager { background: #3b82f6 }
    .u-avatar.viewer { background: var(--fg-tertiary) }
    .u-info { flex: 1; min-width: 0 }
    .u-name { font-size: 14px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .u-email { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .u-status { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 6px; flex-shrink: 0 }
    .u-status.active { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .u-status.suspended { background: rgba(239,68,68,.1); color: #f87171 }

    /* Mid */
    .u-card-mid { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding-top: 10px; border-top: 1px solid var(--border-subtle) }
    .u-role-badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 8px }
    .u-role-badge.admin { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .u-role-badge.manager { background: rgba(59,130,246,.12); color: #60a5fa }
    .u-role-badge.viewer { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .u-date { font-size: 10px; color: var(--fg-tertiary) }

    /* Actions */
    .u-card-actions { display: flex; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-subtle) }
    .u-action-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: 8px;
      font-size: 11px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); cursor: pointer; transition: all .2s;
    }
    .u-action-btn:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.2) }
    .u-action-btn.danger:hover { color: #f87171; border-color: rgba(239,68,68,.2) }
  `],
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

  protected userInitials(u: TrackyUser): string {
    if (u.firstName && u.lastName) return (u.firstName[0] + u.lastName[0]).toUpperCase();
    if (u.firstName) return u.firstName.slice(0, 2).toUpperCase();
    return u.email.slice(0, 2).toUpperCase();
  }

  protected formatDate(date: string): string {
    try {
      return new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric' }).format(new Date(date));
    } catch { return ''; }
  }

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
