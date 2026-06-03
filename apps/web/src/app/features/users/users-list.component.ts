import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Archive, Users, Shield, Pencil, KeyRound, Send, XCircle } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { VehicleGroupsService } from '../../core/services/vehicle-groups.service';
import { UsersApiService, type TrackyUser, type PendingInvitation } from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { UserDrawerComponent, type UserDrawerData, type UserDrawerResult } from './user-drawer.component';
import { VehicleAccessDrawerComponent, type AccessDrawerData, type AccessDrawerResult } from './vehicle-access-drawer.component';
import { AccessPermissionsMatrixComponent, type MatrixDrawerData } from './access-permissions-matrix.component';

@Component({
  selector: 'app-users-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideAngularModule, ConfirmModalComponent, UserDrawerComponent, VehicleAccessDrawerComponent, AccessPermissionsMatrixComponent],
  template: `
    <div class="upage">
      <div class="u-blobs"></div>
      <div class="u-blob-c"></div>

      <!-- Header -->
      <div class="u-header">
        <div>
          <h1 class="u-title">Utilisateurs</h1>
          <p class="u-sub">{{ totalCount() }} membre(s){{ includeArchived() ? ' (archives inclus)' : ' dans votre flotte' }}</p>
        </div>
        <div class="u-header-actions">
          <a routerLink="/users/overview" class="u-overview-btn" title="Vue d'ensemble permissions">
            <lucide-icon [img]="ShieldIcon" [size]="15"></lucide-icon>
            <span class="u-overview-label">Vue d'ensemble</span>
          </a>
          @if (perms.can('users_manage')) {
            <label class="u-toggle-archived">
              <input type="checkbox" [checked]="includeArchived()" (change)="toggleArchived()" />
              <span>Archives</span>
            </label>
            <button (click)="openCreateDrawer()" class="u-add-btn">
              <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Inviter
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="u-loading"><span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span></div>
      } @else if (users().length === 0 && pendingInvitations().length === 0) {
        <div class="u-empty">
          <div class="u-empty-icon"><lucide-icon [img]="UsersIcon" [size]="32"></lucide-icon></div>
          <p>Aucun utilisateur dans votre flotte</p>
          @if (perms.can('users_manage')) {
            <button (click)="openCreateDrawer()" class="u-empty-cta">Inviter votre premier utilisateur</button>
          }
        </div>
      } @else {
        <div class="u-grid">
          <!-- Active users -->
          @for (u of users(); track u.id) {
            <div class="u-card" [class.admin]="u.role === 'FLEET_ADMIN'" [class.archived]="!u.isActive">
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
              @if ((isSuperAdmin() || u.role !== 'FLEET_ADMIN') && perms.can('users_manage') && u.isActive) {
                <div class="u-card-actions">
                  <button (click)="openEditDrawer(u)" class="u-action-btn" title="Modifier">
                    <lucide-icon [img]="PencilIcon" [size]="14"></lucide-icon> Modifier
                  </button>
                  @if (u.role !== 'FLEET_ADMIN' && u.role !== 'SUPER_ADMIN') {
                    <button (click)="openMatrixModal(u)" class="u-action-btn" title="Acces & Permissions">
                      <lucide-icon [img]="ShieldIcon" [size]="14"></lucide-icon> Acces & Perms
                    </button>
                  }
                  <button (click)="onResetPassword(u)" class="u-action-btn" title="Reinitialiser le mot de passe">
                    <lucide-icon [img]="KeyIcon" [size]="14"></lucide-icon>
                  </button>
                  <button (click)="confirmDelete(u)" class="u-action-btn danger" title="Archiver">
                    <lucide-icon [img]="ArchiveIcon" [size]="14"></lucide-icon>
                  </button>
                </div>
              }
              @if (!u.isActive && perms.can('users_manage')) {
                <div class="u-card-actions">
                  <span class="u-archived-badge">Archivé</span>
                  <button (click)="onUnarchive(u)" class="u-action-btn">
                    <lucide-icon [img]="ArchiveIcon" [size]="14"></lucide-icon> Désarchiver
                  </button>
                </div>
              } @else if (!u.isActive) {
                <div class="u-card-actions">
                  <span class="u-archived-badge">Archivé</span>
                </div>
              }
            </div>
          }

          <!-- Pending invitations -->
          @for (inv of pendingInvitations(); track inv.id) {
            <div class="u-card invited" [class.expired]="inv.status === 'EXPIRED'">
              <div class="u-card-glow gray"></div>

              <div class="u-card-top">
                <div class="u-avatar pending">
                  {{ inv.email.slice(0, 2).toUpperCase() }}
                </div>
                <div class="u-info">
                  <p class="u-name">{{ inv.email.split('&#64;')[0] }}</p>
                  <p class="u-email">{{ inv.email }}</p>
                </div>
                <div class="u-status" [class]="inv.status === 'PENDING' ? 'pending' : 'expired'">
                  {{ inv.status === 'PENDING' ? 'Invite' : 'Expire' }}
                </div>
              </div>

              <div class="u-card-mid">
                <span class="u-role-badge" [class]="inv.role === 'FLEET_MANAGER' ? 'manager' : 'viewer'">
                  {{ roleLabel(inv.role) }}
                </span>
                <span class="u-date">Invite {{ formatDate(inv.createdAt) }}</span>
              </div>

              @if (perms.can('users_manage')) {
                <div class="u-card-actions">
                  @if (isSuperAdmin() && inv.status === 'PENDING') {
                    <button (click)="openEditInvitationDrawer(inv)" class="u-action-btn" title="Modifier l'invitation">
                      <lucide-icon [img]="PencilIcon" [size]="14"></lucide-icon> Modifier
                    </button>
                  }
                  <button (click)="onResendInvitation(inv)" class="u-action-btn" title="Renvoyer l'invitation">
                    <lucide-icon [img]="SendIcon" [size]="14"></lucide-icon> Renvoyer
                  </button>
                  <button (click)="onRevokeInvitation(inv)" class="u-action-btn danger" title="Revoquer l'invitation">
                    <lucide-icon [img]="XCircleIcon" [size]="14"></lucide-icon> Revoquer
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

    <!-- Archive Modal -->
    <app-confirm-modal
      [open]="showDeleteModal()"
      title="Archiver l'utilisateur"
      [description]="'Voulez-vous archiver <strong>' + (userToDelete()?.email ?? '') + '</strong> ? Cet utilisateur ne pourra plus se connecter. Ses actions passees seront conservees.'"
      confirmLabel="Archiver"
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

    <!-- V1.11 Phase 1 — Matrice scope x permissions -->
    <app-access-permissions-matrix
      [open]="showMatrixDrawer()"
      [data]="matrixDrawerData()"
      (closed)="showMatrixDrawer.set(false)"
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
    .u-overview-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px;
      font-size: 12px; font-weight: 600; background: var(--bg-secondary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle); text-decoration: none; cursor: pointer;
      transition: all .15s;
    }
    .u-overview-btn:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.3); background: rgba(16,224,160,.06) }
    @media (max-width: 640px) {
      .u-overview-label { display: none }
      .u-overview-btn { width: 36px; height: 36px; padding: 0; justify-content: center }
    }

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
    .u-card.invited { border-style: dashed; border-color: rgba(245,158,11,.2) }
    .u-card.invited:hover { border-color: rgba(245,158,11,.35); box-shadow: 0 0 30px rgba(245,158,11,.06), 0 8px 24px rgba(0,0,0,.15) }
    .u-card.invited.expired { border-color: rgba(239,68,68,.2) }
    .u-card.invited.expired:hover { border-color: rgba(239,68,68,.3) }

    :host-context([data-theme="light"]) .u-card { background: rgba(255,255,255,.6); border-color: rgba(16,224,160,.1) }
    :host-context([data-theme="light"]) .u-card:hover { border-color: rgba(16,224,160,.25); box-shadow: 0 0 30px rgba(16,224,160,.05), 0 8px 24px rgba(0,0,0,.05) }
    :host-context([data-theme="light"]) .u-card.invited { border-color: rgba(245,158,11,.25) }

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
    .u-avatar.pending { background: transparent; border: 2px dashed rgba(245,158,11,.4); color: #f59e0b }
    .u-info { flex: 1; min-width: 0 }
    .u-name { font-size: 14px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .u-email { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .u-status { font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 6px; flex-shrink: 0 }
    .u-status.active { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .u-status.suspended { background: rgba(239,68,68,.1); color: #f87171 }
    .u-status.pending { background: rgba(245,158,11,.1); color: #f59e0b }
    .u-status.expired { background: rgba(239,68,68,.1); color: #f87171 }

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
    .u-card.archived { opacity: .45; filter: grayscale(.5) }
    .u-archived-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 700;
      background: rgba(239,68,68,.1); color: #f87171; text-transform: uppercase;
      letter-spacing: .04em;
    }
    .u-header-actions { display: flex; align-items: center; gap: 10px }
    .u-toggle-archived {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--fg-tertiary); cursor: pointer;
    }
    .u-toggle-archived input { accent-color: var(--tracky); cursor: pointer }
  `],
})
export class UsersListComponent implements OnInit {
  private readonly usersService = inject(UsersApiService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly users = signal<TrackyUser[]>([]);
  readonly pendingInvitations = signal<PendingInvitation[]>([]);
  readonly includeArchived = signal(false);
  readonly totalCount = computed(() => this.users().length + this.pendingInvitations().length);

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

  // V1.11 Phase 1 — Matrice scope x permissions
  readonly showMatrixDrawer = signal(false);
  readonly matrixDrawerData = signal<MatrixDrawerData | null>(null);

  private readonly auth = inject(AuthService);
  private readonly fleetsApi = inject(FleetsApiService);
  protected readonly perms = inject(PermissionsService);
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  private fleets: FleetSummary[] = [];

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
  protected readonly ArchiveIcon = Archive;
  protected readonly KeyIcon = KeyRound;
  protected readonly UsersIcon = Users;
  protected readonly ShieldIcon = Shield;
  protected readonly PencilIcon = Pencil;
  protected readonly SendIcon = Send;
  protected readonly XCircleIcon = XCircle;

  async ngOnInit(): Promise<void> {
    await this.loadUsers();
    if (this.isSuperAdmin()) {
      this.fleets = await firstValueFrom(this.fleetsApi.list()).catch(() => []);
    }
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.usersService.findAll(this.includeArchived(), true);
      this.users.set(result.users);
      this.pendingInvitations.set(result.pendingInvitations);
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
    this.drawerData.set({
      mode: 'create',
      isSuperAdmin: this.isSuperAdmin(),
      fleets: this.fleets,
    });
    this.showDrawer.set(true);
  }

  openEditDrawer(user: TrackyUser): void {
    this.drawerData.set({
      mode: 'edit',
      user,
      isSuperAdmin: this.isSuperAdmin(),
      fleets: this.fleets,
    });
    this.showDrawer.set(true);
  }

  openEditInvitationDrawer(inv: PendingInvitation): void {
    this.drawerData.set({
      mode: 'edit-invitation',
      invitation: {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        fleetId: inv.fleetId,
        permissions: inv.permissions,
      },
      isSuperAdmin: this.isSuperAdmin(),
      fleets: this.fleets,
    });
    this.showDrawer.set(true);
  }

  async onDrawerSave(result: UserDrawerResult): Promise<void> {
    this.drawerLoading.set(true);
    try {
      const mode = this.drawerData()?.mode;
      if (mode === 'create') {
        await this.usersService.invite({
          email: result.email!,
          role: result.role,
          fleetId: result.fleetId,
          permissions: result.permissions,
        });
        this.toast.success(`Invitation envoyee a ${result.email}`);
      } else if (mode === 'edit-invitation') {
        const invId = this.drawerData()?.invitation?.id;
        if (invId) {
          await this.usersService.updateInvitation(invId, {
            fleetId: result.fleetId,
            role: result.role,
            permissions: result.permissions,
          });
          this.toast.success('Invitation mise a jour');
        }
      } else {
        const userId = this.drawerData()?.user?.id;
        if (userId) {
          const roleChanged = result.role !== this.drawerData()?.user?.role;
          const fleetChanged = this.isSuperAdmin() && result.fleetId !== undefined;
          await this.usersService.update(userId, {
            firstName: result.firstName,
            lastName: result.lastName,
            role: result.role,
            isActive: result.isActive,
            ...(!roleChanged ? { permissions: result.permissions } : {}),
            ...(fleetChanged ? { fleetId: result.fleetId } : {}),
          });
        }
      }
      this.showDrawer.set(false);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
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

  async toggleArchived(): Promise<void> {
    this.includeArchived.update((v) => !v);
    await this.loadUsers();
  }

  async onUnarchive(user: TrackyUser): Promise<void> {
    try {
      await this.usersService.update(user.id, { isActive: true });
      this.toast.success(`${user.email} a été désarchivé.`);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
  }

  async onResetPassword(user: TrackyUser): Promise<void> {
    try {
      await this.usersService.resetPassword(user.id);
      this.toast.success(`Un email de reinitialisation a ete envoye a ${user.email}.`);
    } catch {
      this.toast.error('Erreur lors de l\'envoi du lien de reinitialisation.');
    }
  }

  // ─── Invitation actions ────────────────────────────────

  async onResendInvitation(inv: PendingInvitation): Promise<void> {
    try {
      await this.usersService.resendInvitation(inv.id);
      this.toast.success(`Invitation renvoyee a ${inv.email}`);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
  }

  async onRevokeInvitation(inv: PendingInvitation): Promise<void> {
    try {
      await this.usersService.revokeInvitation(inv.id);
      this.toast.success(`Invitation revoquee pour ${inv.email}`);
      await this.loadUsers();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Erreur');
    }
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

  /**
   * V1.11 Phase 1 — Ouvre la matrice scope x permissions pour ce user.
   * Affiche les permissions per-scope (vs perm global du drawer "Acces").
   */
  async openMatrixModal(user: TrackyUser): Promise<void> {
    const [groups, vehicles] = await Promise.all([
      this.groupsService.list(),
      firstValueFrom(this.vehiclesApi.list()),
    ]);
    this.matrixDrawerData.set({
      userId: user.id,
      userEmail: user.email,
      userRole: user.role as 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER',
      groups,
      vehicles,
    });
    this.showMatrixDrawer.set(true);
  }
}
