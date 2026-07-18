import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  LucideAngularModule, ArrowLeft, Users, FolderOpen, Shield, Truck,
  ChevronDown, ChevronRight, Search, Eye, EyeOff,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { PERMISSION_GROUP_ORDER, PERMISSION_LABELS, type UserPermissions } from '@vizyo/tracky-shared';
import { roleLabel as roleLabelFr } from '../../shared/utils/role-labels';
import { SpinnerComponent } from '../../shared/ui/spinner/spinner.component';

interface AccessEntry {
  id: string;
  accessType: 'ALL' | 'GROUP' | 'VEHICLE';
  permissions: Partial<UserPermissions> | null;
  group: { id: string; name: string } | null;
  vehicle: { id: string; plate: string } | null;
}

interface PanoramaUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  fleetId: string | null;
  permissions: Record<string, boolean> | null;
  vehicleAccess: AccessEntry[];
}

interface PanoramaGroup {
  id: string;
  name: string;
  fleetId: string;
  vehicles: { vehicle: { id: string; plate: string } }[];
  users: { userId: string }[];
}

interface PanoramaData {
  users: PanoramaUser[];
  groups: PanoramaGroup[];
}

/**
 * Catalogue des permissions — **DÉRIVÉ** de la source partagée (`PERMISSION_LABELS` +
 * `PERMISSION_GROUP_ORDER`), plus recopié à la main.
 *
 * Cette page listait auparavant un sous-ensemble FIGÉ (~16 permissions sur 40) : chaque nouvelle
 * permission la rendait un peu plus fausse, et un panorama d'accès incomplet est pire que pas de
 * panorama — on croit voir les droits d'un utilisateur alors qu'il en a d'autres. La dérivation
 * garantit que toute permission ajoutée au paquet partagé apparaît ici automatiquement.
 */
const PERM_GROUPS = PERMISSION_GROUP_ORDER.map((group) => ({
  label: group,
  keys: (Object.keys(PERMISSION_LABELS) as (keyof UserPermissions)[]).filter(
    (k) => PERMISSION_LABELS[k].group === group,
  ),
})).filter((g) => g.keys.length > 0);

@Component({
  selector: 'app-permissions-overview',
  standalone: true,
  imports: [RouterLink, FormsModule, LucideAngularModule, SpinnerComponent],
  template: `
    <div class="po-page">
      <header class="po-header">
        <a routerLink="/users" class="po-back">
          <lucide-icon [img]="ArrowLeft" [size]="13"></lucide-icon>
          Utilisateurs
        </a>
        <span class="vt-eyebrow">Pilotage des accès</span>
        <h1>Vue d'ensemble.</h1>
        <p class="po-sub">Permissions, groupes et accès de chaque utilisateur.</p>
      </header>

      <!-- Search -->
      <div class="po-search">
        <lucide-icon [img]="Search" [size]="16"></lucide-icon>
        <input type="text" [(ngModel)]="searchQuery" placeholder="Rechercher un utilisateur..." />
      </div>

      @if (loading()) {
        <div class="po-loading"><app-spinner [size]="24" /></div>
      } @else {
        <!-- Groups summary -->
        <section class="po-section">
          <h2 class="po-section-title">
            <lucide-icon [img]="FolderOpen" [size]="16"></lucide-icon>
            Groupes ({{ data()?.groups?.length || 0 }})
          </h2>
          <div class="po-groups-grid">
            @for (g of data()?.groups || []; track g.id) {
              <div class="po-group-card">
                <div class="po-group-name">{{ g.name }}</div>
                <div class="po-group-meta">
                  <span><lucide-icon [img]="Truck" [size]="12"></lucide-icon> {{ g.vehicles.length }}</span>
                  <span><lucide-icon [img]="Users" [size]="12"></lucide-icon> {{ g.users.length }}</span>
                </div>
                <div class="po-group-vehicles">
                  @for (v of g.vehicles; track v.vehicle.id) {
                    <span class="po-pill">{{ v.vehicle.plate }}</span>
                  }
                </div>
              </div>
            }
            @if (!data()?.groups?.length) {
              <p class="po-empty">Aucun groupe</p>
            }
          </div>
        </section>

        <!-- Users matrix -->
        <section class="po-section">
          <h2 class="po-section-title">
            <lucide-icon [img]="Users" [size]="16"></lucide-icon>
            Utilisateurs ({{ filteredUsers().length }})
          </h2>

          <div class="po-users-list">
            @for (u of filteredUsers(); track u.id) {
              <div class="po-user-card" [class.po-user-card--expanded]="expandedUserId() === u.id">
                <!-- User header (toujours visible) -->
                <button class="po-user-header" (click)="toggleUser(u.id)">
                  <div class="po-user-avatar" [class]="roleColor(u.role)">
                    {{ userInitials(u) }}
                  </div>
                  <div class="po-user-info">
                    <span class="po-user-name">
                      {{ u.firstName || '' }} {{ u.lastName || '' }}
                      @if (!u.firstName && !u.lastName) { {{ u.email.split('&#64;')[0] }} }
                    </span>
                    <span class="po-user-email">{{ u.email }}</span>
                  </div>
                  <span class="po-role-badge" [class]="roleColor(u.role)">{{ roleLabel(u.role) }}</span>
                  <div class="po-user-scope-summary">
                    @for (entry of u.vehicleAccess; track entry.id) {
                      @if (entry.accessType === 'ALL') {
                        <span class="po-scope-pill all">Toute la flotte</span>
                      } @else if (entry.accessType === 'GROUP' && entry.group) {
                        <span class="po-scope-pill group">{{ entry.group.name }}</span>
                      } @else if (entry.accessType === 'VEHICLE' && entry.vehicle) {
                        <span class="po-scope-pill vehicle">{{ entry.vehicle.plate }}</span>
                      }
                    }
                    @if (u.vehicleAccess.length === 0) {
                      <span class="po-scope-pill none">Aucun acces</span>
                    }
                  </div>
                  <lucide-icon [img]="expandedUserId() === u.id ? ChevronDown : ChevronRight" [size]="16" class="po-chevron"></lucide-icon>
                </button>

                <!-- Expanded: permissions detail -->
                @if (expandedUserId() === u.id) {
                  <div class="po-user-detail">
                    @if (u.role === 'FLEET_ADMIN' || u.role === 'SUPER_ADMIN') {
                      <div class="po-admin-note">
                        <lucide-icon [img]="Shield" [size]="14"></lucide-icon>
                        Les administrateurs ont toutes les permissions.
                      </div>
                    } @else {
                      @for (entry of u.vehicleAccess; track entry.id) {
                        <div class="po-scope-block">
                          <div class="po-scope-label">
                            @if (entry.accessType === 'ALL') { Toute la flotte }
                            @else if (entry.group) { Groupe : {{ entry.group.name }} }
                            @else if (entry.vehicle) { Vehicule : {{ entry.vehicle.plate }} }
                          </div>
                          <div class="po-perms-grid">
                            @for (pg of permGroups; track pg.label) {
                              <div class="po-perm-group">
                                <span class="po-perm-group-label">{{ pg.label }}</span>
                                <div class="po-perm-items">
                                  @for (key of pg.keys; track key) {
                                    <span class="po-perm-item" [class.on]="resolvePermission(entry, u, key)" [class.off]="!resolvePermission(entry, u, key)">
                                      <lucide-icon [img]="resolvePermission(entry, u, key) ? Eye : EyeOff" [size]="10"></lucide-icon>
                                      {{ permLabel(key) }}
                                    </span>
                                  }
                                </div>
                              </div>
                            }
                          </div>
                        </div>
                      }
                      @if (u.vehicleAccess.length === 0) {
                        <p class="po-empty">Aucun scope d'acces configure.</p>
                      }
                    }
                  </div>
                }
              </div>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .po-page { max-width: 1000px }
    .po-header { margin-bottom: 20px }
    .po-header h1 { font-family: var(--font-display, inherit); font-size: 1.72rem; font-weight: 800; letter-spacing: -.03em; line-height: 1.1; color: var(--fg-primary); margin: 8px 0 0 }
    .po-sub { font-size: 14px; color: var(--fg-tertiary); margin: 8px 0 0 }
    .po-back { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--fg-tertiary); text-decoration: none }
    .po-back:hover { color: var(--fg-secondary) }
    .po-loading { display: flex; justify-content: center; padding: 40px }

    .po-search {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; margin-bottom: 20px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px;
      color: var(--fg-tertiary);
    }
    .po-search input {
      flex: 1; background: transparent; border: 0; outline: none;
      color: var(--fg-primary); font-size: 13px;
    }

    .po-section { margin-bottom: 24px }
    .po-section-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0 0 12px;
    }
    .po-section-title lucide-icon { color: var(--tracky-light) }
    .po-empty { font-size: 12px; color: var(--fg-tertiary); text-align: center; padding: 16px }

    /* Groups grid */
    .po-groups-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px }
    .po-group-card {
      padding: 12px 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 12px; display: flex; flex-direction: column; gap: 6px;
    }
    .po-group-name { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .po-group-meta { display: flex; gap: 12px; font-size: 11px; color: var(--fg-tertiary) }
    .po-group-meta span { display: flex; align-items: center; gap: 4px }
    .po-group-vehicles { display: flex; flex-wrap: wrap; gap: 4px }

    .po-pill {
      display: inline-block; padding: 2px 7px; border-radius: 6px;
      font-size: 10px; font-weight: 600; background: var(--bg-tertiary); color: var(--fg-tertiary);
      font-family: var(--font-mono, monospace);
    }

    /* Users list */
    .po-users-list { display: flex; flex-direction: column; gap: 8px }
    .po-user-card {
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 14px; overflow: hidden; transition: border-color .15s;
    }
    .po-user-card--expanded { border-color: rgba(16,224,160,.3) }
    .po-user-header {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 12px 14px;
      background: transparent; border: 0; cursor: pointer;
      text-align: left; transition: background .12s;
    }
    .po-user-header:hover { background: var(--bg-tertiary) }
    .po-user-avatar {
      width: 36px; height: 36px; border-radius: 9999px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: white;
    }
    .po-user-avatar.admin { background: var(--tracky) }
    .po-user-avatar.manager { background: #64748b }
    .po-user-avatar.viewer { background: #6b7280 }
    .po-user-info { flex: 1; min-width: 0 }
    .po-user-name { display: block; font-size: 13px; font-weight: 600; color: var(--fg-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .po-user-email { display: block; font-size: 11px; color: var(--fg-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .po-role-badge {
      padding: 3px 8px; border-radius: 8px; font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em; flex-shrink: 0;
    }
    .po-role-badge.admin { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .po-role-badge.manager { background: var(--bg-tertiary); color: var(--fg-secondary) }
    .po-role-badge.viewer { background: rgba(107,114,128,.12); color: #9ca3af }
    .po-chevron { color: var(--fg-tertiary); flex-shrink: 0 }

    .po-user-scope-summary { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0 }
    .po-scope-pill {
      padding: 2px 7px; border-radius: 6px; font-size: 10px; font-weight: 600;
    }
    .po-scope-pill.all { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .po-scope-pill.group { background: var(--bg-tertiary); color: var(--fg-secondary) }
    .po-scope-pill.vehicle { background: rgba(245,158,11,.1); color: #f59e0b }
    .po-scope-pill.none { background: rgba(239,68,68,.08); color: #f87171 }

    /* Detail expanded */
    .po-user-detail { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 12px }
    .po-admin-note {
      display: flex; align-items: center; gap: 8px; padding: 10px 14px;
      background: rgba(16,224,160,.06); border: 1px solid rgba(16,224,160,.2);
      border-radius: 10px; font-size: 12px; color: var(--tracky-light);
    }
    .po-scope-block {
      padding: 10px 12px; background: var(--bg-tertiary); border-radius: 10px;
    }
    .po-scope-label { font-size: 11px; font-weight: 700; color: var(--fg-secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: .04em }
    .po-perms-grid { display: flex; flex-wrap: wrap; gap: 6px }
    .po-perm-group { display: flex; flex-direction: column; gap: 3px; min-width: 140px }
    .po-perm-group-label { font-size: 9px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .06em }
    .po-perm-items { display: flex; flex-wrap: wrap; gap: 3px }
    .po-perm-item {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 6px; border-radius: 5px; font-size: 10px; font-weight: 500;
    }
    .po-perm-item.on { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .po-perm-item.off { background: var(--bg-tertiary); color: var(--fg-tertiary) }

    /* Mobile */
    @media (max-width: 640px) {
      .po-user-scope-summary { display: none }
      .po-groups-grid { grid-template-columns: 1fr }
      .po-perm-group { min-width: 100% }
    }
  `],
})
export class PermissionsOverviewComponent implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Users = Users;
  protected readonly FolderOpen = FolderOpen;
  protected readonly Shield = Shield;
  protected readonly Truck = Truck;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Search = Search;
  protected readonly Eye = Eye;
  protected readonly EyeOff = EyeOff;

  protected readonly permGroups = PERM_GROUPS;
  protected readonly loading = signal(false);
  protected readonly data = signal<PanoramaData | null>(null);
  protected readonly expandedUserId = signal<string | null>(null);
  protected searchQuery = '';

  protected readonly filteredUsers = computed(() => {
    const users = this.data()?.users ?? [];
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) return users;
    return users.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      (u.firstName ?? '').toLowerCase().includes(q) ||
      (u.lastName ?? '').toLowerCase().includes(q),
    );
  });

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.http.get<PanoramaData>('/api/users/panorama'));
      this.data.set(res);
    } catch { /* silent */ }
    finally { this.loading.set(false); }
  }

  protected toggleUser(id: string): void {
    this.expandedUserId.set(this.expandedUserId() === id ? null : id);
  }

  protected userInitials(u: PanoramaUser): string {
    if (u.firstName && u.lastName) return (u.firstName[0] + u.lastName[0]).toUpperCase();
    return u.email.slice(0, 2).toUpperCase();
  }

  protected roleLabel(role: string): string {
    return roleLabelFr(role);
  }

  protected roleColor(role: string): string {
    if (role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN') return 'admin';
    if (role === 'FLEET_MANAGER') return 'manager';
    return 'viewer';
  }

  protected permLabel(key: string): string {
    return PERMISSION_LABELS[key as keyof UserPermissions]?.label ?? key;
  }

  protected resolvePermission(entry: AccessEntry, user: PanoramaUser, key: string): boolean {
    // Scope permissions take priority, fallback to user.permissions
    if (entry.permissions && key in entry.permissions) {
      return (entry.permissions as Record<string, boolean>)[key] === true;
    }
    if (user.permissions && key in user.permissions) {
      return (user.permissions as Record<string, boolean>)[key] === true;
    }
    return false;
  }
}
