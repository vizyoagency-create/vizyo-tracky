import { Component, HostListener, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, X, Truck, FolderOpen, Shield, Bell, FileBarChart, Users, Save, UserRound } from 'lucide-angular';
import type { TrackyUser } from '../../core/services/users.service';

export interface UserDrawerData {
  mode: 'create' | 'edit';
  user?: TrackyUser;
}

export interface UserDrawerResult {
  // Create fields
  email?: string;
  password?: string;
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
                {{ data()?.mode === 'create' ? 'Inviter un utilisateur' : 'Modifier l\\'utilisateur' }}
              </h2>
              @if (data()?.mode === 'edit') {
                <p class="text-xs text-fg-tertiary mt-0.5">{{ data()?.user?.email }}</p>
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
              <!-- Mode invitation : email + rôle uniquement -->
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

              <section>
                <h3 class="section-title">Role</h3>
                <div class="flex gap-2">
                  <button (click)="setRole('VIEWER')"
                    class="role-btn" [class.active]="role === 'VIEWER'" [class.viewer]="role === 'VIEWER'">
                    Lecteur
                  </button>
                  <button (click)="setRole('FLEET_MANAGER')"
                    class="role-btn" [class.active]="role === 'FLEET_MANAGER'" [class.manager]="role === 'FLEET_MANAGER'">
                    Manager
                  </button>
                </div>
              </section>
            }

            @if (data()?.mode === 'edit') {
              <section>
                <h3 class="section-title">Informations</h3>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="field-label">Prenom</label>
                    <input type="text" [(ngModel)]="firstName" placeholder="Prenom" class="field-input" />
                  </div>
                  <div>
                    <label class="field-label">Nom</label>
                    <input type="text" [(ngModel)]="lastName" placeholder="Nom" class="field-input" />
                  </div>
                </div>
              </section>

              <section>
                <h3 class="section-title">Role</h3>
                <div class="flex gap-2">
                  <button (click)="setRole('VIEWER')"
                    class="role-btn" [class.active]="role === 'VIEWER'" [class.viewer]="role === 'VIEWER'">
                    Lecteur
                  </button>
                  <button (click)="setRole('FLEET_MANAGER')"
                    class="role-btn" [class.active]="role === 'FLEET_MANAGER'" [class.manager]="role === 'FLEET_MANAGER'">
                    Manager
                  </button>
                </div>
              </section>

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

              <!-- Section: Permissions (edit only) -->
              <section>
                <h3 class="section-title">Permissions</h3>
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
            </section>
            }
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
              {{ data()?.mode === 'create' ? 'Envoyer' : 'Enregistrer' }}
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

    .toggle { position: relative; display: inline-block; cursor: pointer }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute }
    .toggle-track {
      display: flex; align-items: center; width: 44px; height: 24px; background: rgba(239,68,68,.15); border: 1.5px solid rgba(239,68,68,.25);
      border-radius: 24px; transition: all .25s; position: relative; padding: 0 3px;
    }
    .toggle-thumb {
      position: relative; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
      background: #ef4444; border-radius: 50%; transition: transform .25s, background .25s; box-shadow: 0 1px 3px rgba(0,0,0,.3);
    }
    .toggle-thumb::after {
      content: '✕'; font-size: 9px; font-weight: 700; color: white; line-height: 1;
    }
    .toggle input:checked + .toggle-track { background: rgba(16,224,160,.15); border-color: rgba(16,224,160,.3) }
    .toggle input:checked + .toggle-track .toggle-thumb {
      transform: translateX(20px); background: var(--tracky-light);
    }
    .toggle input:checked + .toggle-track .toggle-thumb::after { content: '✓' }

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
  perms: Record<string, boolean> = { ...ROLE_DEFAULTS['VIEWER'] };

  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;

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
      const existing = (d.user as unknown as { permissions?: Record<string, boolean> }).permissions;
      this.perms = existing ? { ...existing } : { ...(ROLE_DEFAULTS[d.user.role] ?? ROLE_DEFAULTS['VIEWER']) };
    } else {
      this.email = '';
      this.password = '';
      this.firstName = '';
      this.lastName = '';
      this.role = 'VIEWER';
      this.isActive = true;
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
    });
  }
}
