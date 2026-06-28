import { Component, HostListener, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, X, Truck, FolderOpen, Shield, Bell, FileBarChart, Users, Save, UserRound, Map } from 'lucide-angular';
import type { TrackyUser } from '../../core/services/users.service';
import type { FleetSummary } from '../../core/services/fleets.service';

export interface UserDrawerData {
  mode: 'create' | 'edit' | 'edit-invitation';
  user?: TrackyUser;
  invitation?: { id: string; email: string; role: string; fleetId: string | null; permissions: Record<string, boolean> | null };
  isSuperAdmin?: boolean;
  fleets?: FleetSummary[];
}

export interface UserDrawerResult {
  // Create fields
  email?: string;
  password?: string;
  fleetId?: string | null;
  invitationId?: string;
  // Shared fields
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
  permissions: Record<string, boolean>;
}

const ROLE_DEFAULTS: Record<string, Record<string, boolean>> = {
  VIEWER: { vehicles_view: true, vehicles_create: false, vehicles_edit: false, vehicles_delete: false, groups_view: false, groups_manage: false, geofences_view: true, geofences_manage: false, alerts_view: true, alerts_acknowledge: false, reports_view: true, users_view: false, users_manage: false, drivers_view: true, drivers_manage: false },
  FLEET_MANAGER: { vehicles_view: true, vehicles_create: true, vehicles_edit: true, vehicles_delete: true, groups_view: true, groups_manage: true, geofences_view: true, geofences_manage: true, alerts_view: true, alerts_acknowledge: true, reports_view: true, users_view: false, users_manage: false, drivers_view: true, drivers_manage: true },
  FLEET_ADMIN: { vehicles_view: true, vehicles_create: true, vehicles_edit: true, vehicles_delete: true, groups_view: true, groups_manage: true, geofences_view: true, geofences_manage: true, alerts_view: true, alerts_acknowledge: true, reports_view: true, users_view: true, users_manage: true, drivers_view: true, drivers_manage: true },
  // Sprint 3 — veilleur de nuit : voit ses véhicules + coupe/redémarre le moteur (engine_control), rien d'autre.
  NIGHT_WATCHMAN: { vehicles_view: true, vehicles_create: false, vehicles_edit: false, vehicles_delete: false, engine_control: true, schedules_manage: false, groups_view: false, groups_manage: false, geofences_view: false, geofences_manage: false, alerts_view: false, alerts_acknowledge: false, reports_view: false, users_view: false, users_manage: false, drivers_view: false, drivers_manage: false },
};

@Component({
  selector: 'app-user-drawer',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative w-full max-w-md bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div>
              <h2 class="text-lg font-display font-bold text-fg-primary">
                {{ data()?.mode === 'create' ? 'Inviter un utilisateur' : data()?.mode === 'edit-invitation' ? 'Modifier l\\'invitation' : 'Modifier l\\'utilisateur' }}
              </h2>
              @if (data()?.mode === 'edit') {
                <p class="text-xs text-fg-tertiary mt-0.5">{{ data()?.user?.email }}</p>
              }
              @if (data()?.mode === 'edit-invitation') {
                <p class="text-xs text-fg-tertiary mt-0.5">{{ data()?.invitation?.email }}</p>
              }
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Content (scrollable) -->
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-6">

            <!-- Section: Identité -->
            @if (data()?.mode === 'create') {
              <!-- Mode invitation : email uniquement -->
              <section>
                <h3 class="section-title">Inviter un utilisateur</h3>
                <p class="text-xs text-fg-tertiary mb-3">
                  Un email d'invitation sera envoye. L'utilisateur pourra creer son mot de passe et renseigner ses informations.
                </p>
                <div class="space-y-3">
                  <div>
                    <label class="field-label">Email</label>
                    <input type="email" [(ngModel)]="email" placeholder="utilisateur&#64;entreprise.com"
                      class="field-input" />
                  </div>
                </div>
              </section>

              <!-- Fleet selector (SUPER_ADMIN only) -->
              @if (data()?.isSuperAdmin && data()?.fleets?.length) {
                <section>
                  <h3 class="section-title">
                    <lucide-icon [img]="MapIcon" [size]="12" class="inline-block mr-1 text-tracky-light"></lucide-icon>
                    Flotte
                  </h3>
                  <select [(ngModel)]="selectedFleetId" class="field-input field-select">
                    <option value="">-- Aucune flotte --</option>
                    @for (f of data()!.fleets!; track f.id) {
                      <option [value]="f.id">{{ f.name }}</option>
                    }
                  </select>
                </section>
              }
            }

            <!-- Edit invitation: fleet selector -->
            @if (data()?.mode === 'edit-invitation' && data()?.isSuperAdmin && data()?.fleets?.length) {
              <section>
                <h3 class="section-title">
                  <lucide-icon [img]="MapIcon" [size]="12" class="inline-block mr-1 text-tracky-light"></lucide-icon>
                  Flotte
                </h3>
                <select [(ngModel)]="selectedFleetId" class="field-input field-select">
                  <option value="">-- Aucune flotte --</option>
                  @for (f of data()!.fleets!; track f.id) {
                    <option [value]="f.id">{{ f.name }}</option>
                  }
                </select>
              </section>
            }

            @if (data()?.mode === 'edit') {
              <section>
                <h3 class="section-title">Informations</h3>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="field-label">Prénom</label>
                    <input type="text" [(ngModel)]="firstName" placeholder="Prénom" class="field-input" />
                  </div>
                  <div>
                    <label class="field-label">Nom</label>
                    <input type="text" [(ngModel)]="lastName" placeholder="Nom" class="field-input" />
                  </div>
                </div>
              </section>
            }

            <!-- Role (both modes) -->
            <section>
              <h3 class="section-title">Role</h3>
              <div class="flex gap-2 flex-wrap">
                <button (click)="setRole('VIEWER')"
                  class="role-btn" [class.active]="role === 'VIEWER'" [class.viewer]="role === 'VIEWER'">
                  Lecteur
                </button>
                <button (click)="setRole('FLEET_MANAGER')"
                  class="role-btn" [class.active]="role === 'FLEET_MANAGER'" [class.manager]="role === 'FLEET_MANAGER'">
                  Manager
                </button>
                <button (click)="setRole('NIGHT_WATCHMAN')"
                  class="role-btn" [class.active]="role === 'NIGHT_WATCHMAN'" [class.viewer]="role === 'NIGHT_WATCHMAN'">
                  Veilleur
                </button>
                @if (data()?.isSuperAdmin) {
                  <button (click)="setRole('FLEET_ADMIN')"
                    class="role-btn" [class.active]="role === 'FLEET_ADMIN'" [class.admin-role]="role === 'FLEET_ADMIN'">
                    Admin flotte
                  </button>
                }
              </div>
            </section>

            <!-- Fleet reassignment in edit mode (SUPER_ADMIN only, not for FLEET_ADMIN users) -->
            @if (data()?.mode === 'edit' && data()?.isSuperAdmin && data()?.fleets?.length && data()?.user?.role !== 'FLEET_ADMIN') {
              <section>
                <h3 class="section-title">
                  <lucide-icon [img]="MapIcon" [size]="12" class="inline-block mr-1 text-tracky-light"></lucide-icon>
                  Flotte
                </h3>
                <select [(ngModel)]="selectedFleetId" class="field-input field-select">
                  <option value="">-- Aucune flotte --</option>
                  @for (f of data()!.fleets!; track f.id) {
                    <option [value]="f.id">{{ f.name }}</option>
                  }
                </select>
              </section>
            }

            @if (data()?.mode === 'edit') {
              <section>
                <h3 class="section-title">Statut</h3>
                <div class="flex items-center justify-between p-3 rounded-xl bg-bg-secondary border border-border-subtle">
                  <span class="text-sm text-fg-secondary">Compte actif</span>
                  <label class="toggle">
                    <input type="checkbox" [(ngModel)]="isActive" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
              </section>
            }

            <!-- Permissions -->
            <section>
              <h3 class="section-title">Permissions</h3>
              @if (data()?.mode === 'edit') {
                <div class="p-3 rounded-xl bg-bg-secondary border border-border-subtle">
                  <p class="text-xs text-fg-tertiary">
                    Configurez les permissions via le bouton <strong>Acces & Perms</strong> sur la carte utilisateur.
                  </p>
                </div>
              } @else {
                <p class="text-xs text-fg-tertiary mb-3">
                  Permissions preconfigurées pour l'utilisateur invité.
                </p>
                <div class="space-y-4">
                  @for (group of permGroups; track group.label) {
                    <div class="perm-group">
                      <div class="perm-group-header">
                        <lucide-icon [img]="group.icon" [size]="14" class="text-tracky-light"></lucide-icon>
                        <span>{{ group.label }}</span>
                      </div>
                      @for (p of group.items; track p.key) {
                        <div class="perm-row">
                          <span class="text-sm text-fg-secondary">{{ p.label }}</span>
                          <label class="toggle">
                            <input type="checkbox" [checked]="perms[p.key]" (change)="perms[p.key] = !perms[p.key]" />
                            <span class="toggle-track"><span class="toggle-thumb"></span></span>
                          </label>
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </section>
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
            @if (error()) {
              <p class="text-xs text-red-400 flex-1">{{ error() }}</p>
            }
            <button (click)="onClose()"
              class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle
                     hover:text-fg-primary transition-colors cursor-pointer">
              Annuler
            </button>
            <button (click)="onSave()" [disabled]="loading()"
              class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                     transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
              @if (loading()) {
                <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
              } @else {
                <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
              }
              {{ data()?.mode === 'create' ? 'Envoyer' : 'Sauvegarder' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .animate-slide-in { animation: slideIn .25s ease-out }
    @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }

    .section-title { font-size: 10px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px }

    .field-label { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin-bottom: 4px }
    .field-input {
      width: 100%; padding: 10px 14px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle);
      border-radius: 12px; color: var(--fg-primary); font-size: 13px;
      outline: none; transition: border-color .2s;
    }
    .field-input:focus { border-color: var(--tracky) }
    .field-input::placeholder { color: var(--fg-tertiary) }

    .role-btn {
      flex: 1; padding: 10px; border-radius: 12px; font-size: 13px; font-weight: 600; text-align: center;
      background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); color: var(--fg-secondary);
      cursor: pointer; transition: all .2s;
    }
    .role-btn:hover { border-color: var(--border-strong) }
    .role-btn.active.viewer { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }
    .role-btn.active.manager { border-color: #3b82f6; color: #60a5fa; background: rgba(59,130,246,.06) }
    .role-btn.active.admin-role { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }

    .field-select {
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; cursor: pointer;
    }

    /* .toggle : styles globaux (styles.css) */

    .perm-group { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden }
    .perm-group-header {
      display: flex; align-items: center; gap: 6px; padding: 8px 14px;
      font-size: 11px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .04em;
      border-bottom: 1px solid var(--border-subtle); background: var(--bg-tertiary);
    }
    .perm-row {
      display: flex; align-items: center; justify-content: space-between; padding: 8px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .perm-row:last-child { border-bottom: none }
  `],
})
export class UserDrawerComponent {
  readonly open = input.required<boolean>();
  readonly data = input.required<UserDrawerData | null>();
  readonly loading = input(false);

  readonly closed = output<void>();
  readonly saved = output<UserDrawerResult>();

  readonly error = signal('');

  // Form fields
  email = '';
  password = '';
  firstName = '';
  lastName = '';
  role = 'VIEWER';
  isActive = true;
  selectedFleetId = '';
  perms: Record<string, boolean> = { ...ROLE_DEFAULTS['VIEWER'] };

  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly MapIcon = Map;

  readonly permGroups = [
    { label: 'Véhicules', icon: Truck, items: [
      { key: 'vehicles_view', label: 'Voir la liste' },
      { key: 'vehicles_create', label: 'Ajouter' },
      { key: 'vehicles_edit', label: 'Modifier' },
      { key: 'vehicles_delete', label: 'Supprimer' },
    ]},
    { label: 'Groupes', icon: FolderOpen, items: [
      { key: 'groups_view', label: 'Voir les groupes' },
      { key: 'groups_manage', label: 'Gérer les groupes' },
    ]},
    { label: 'Géofences', icon: Shield, items: [
      { key: 'geofences_view', label: 'Voir' },
      { key: 'geofences_manage', label: 'Créer / Supprimer' },
    ]},
    { label: 'Alertes', icon: Bell, items: [
      { key: 'alerts_view', label: 'Voir' },
      { key: 'alerts_acknowledge', label: 'Acquitter' },
    ]},
    { label: 'Rapports', icon: FileBarChart, items: [
      { key: 'reports_view', label: 'Voir' },
    ]},
    { label: 'Utilisateurs', icon: Users, items: [
      { key: 'users_view', label: 'Voir' },
      { key: 'users_manage', label: 'Gérer' },
    ]},
    { label: 'Conducteurs', icon: UserRound, items: [
      { key: 'drivers_view', label: 'Voir' },
      { key: 'drivers_manage', label: 'Gérer' },
    ]},
  ];

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.loading()) this.onClose(); }

  ngOnChanges(): void {
    const d = this.data();
    if (!d) return;
    if (d.mode === 'edit' && d.user) {
      this.email = d.user.email;
      this.firstName = d.user.firstName ?? '';
      this.lastName = d.user.lastName ?? '';
      this.role = d.user.role;
      this.isActive = d.user.isActive;
      this.selectedFleetId = d.user.fleetId ?? '';
      const existing = (d.user as unknown as { permissions?: Record<string, boolean> }).permissions;
      this.perms = existing ? { ...existing } : { ...(ROLE_DEFAULTS[d.user.role] ?? ROLE_DEFAULTS['VIEWER']) };
    } else if (d.mode === 'edit-invitation' && d.invitation) {
      this.email = d.invitation.email;
      this.role = d.invitation.role;
      this.selectedFleetId = d.invitation.fleetId ?? '';
      this.isActive = true;
      this.perms = d.invitation.permissions ? { ...d.invitation.permissions } : { ...(ROLE_DEFAULTS[d.invitation.role] ?? ROLE_DEFAULTS['VIEWER']) };
    } else {
      this.email = '';
      this.password = '';
      this.firstName = '';
      this.lastName = '';
      this.role = 'VIEWER';
      this.isActive = true;
      this.selectedFleetId = d.fleets?.length === 1 ? d.fleets[0].id : '';
      this.perms = { ...ROLE_DEFAULTS['VIEWER'] };
    }
    this.error.set('');
  }

  setRole(role: string): void {
    this.role = role;
    this.perms = { ...(ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS['VIEWER']) };
  }

  onClose(): void {
    this.closed.emit();
  }

  onSave(): void {
    if (this.data()?.mode === 'create' && !this.email) {
      this.error.set('Email requis');
      return;
    }
    this.saved.emit({
      ...(this.data()?.mode === 'create' ? { email: this.email } : {}),
      firstName: this.firstName || undefined,
      lastName: this.lastName || undefined,
      role: this.role,
      isActive: this.isActive,
      permissions: this.perms,
      fleetId: this.selectedFleetId || null,
    });
  }
}
