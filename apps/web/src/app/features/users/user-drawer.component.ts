import { Component, effect, HostListener, inject, input, output, signal } from '@angular/core';
import { ScrollLockService } from '../../core/services/scroll-lock.service';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, X, Save, Map } from 'lucide-angular';
import type { TrackyUser } from '../../core/services/users.service';
import type { FleetSummary } from '../../core/services/fleets.service';
import type { VehicleGroup } from '../../core/services/vehicle-groups.service';
import type { VehicleDetailDto } from '../../core/services/vehicles.service';
import { AccessMatrixEditorComponent, type EditableAccessScope } from './access-matrix-editor.component';

/** Scope d'accès envoyé au backend (miroir de AccessEntryDto, sans clé locale). */
export interface DrawerAccessScope {
  type: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId?: string;
  vehicleId?: string;
  permissions?: Record<string, boolean>;
}

export interface UserDrawerData {
  mode: 'create' | 'edit' | 'edit-invitation';
  user?: TrackyUser;
  invitation?: {
    id: string; email: string; role: string; fleetId: string | null;
    permissions: Record<string, boolean> | null;
    accessScopes?: DrawerAccessScope[] | null;
  };
  isSuperAdmin?: boolean;
  fleets?: FleetSummary[];
  /** Véhicules/groupes de la flotte (pour les scopes GROUP/VEHICLE de la matrice). */
  groups?: VehicleGroup[];
  vehicles?: VehicleDetailDto[];
  audioEligible?: boolean;
  /** Mode edit — scopes d'accès existants de l'utilisateur (UserVehicleAccess), pour amorcer la matrice. */
  accessEntries?: DrawerAccessScope[];
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
  /** Matrice d'accès — scopes à envoyer (invitation ou setAccess utilisateur). */
  accessScopes?: DrawerAccessScope[];
}

@Component({
  selector: 'app-user-drawer',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, AccessMatrixEditorComponent],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative w-full max-w-md max-h-full bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden drawer-overlay-safe">

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

            <!-- Accès & Permissions -->
            <section>
              <h3 class="section-title">Accès & permissions</h3>
              <p class="text-xs text-fg-tertiary mb-3">
                @if (data()?.mode === 'create') {
                  Préconfiguré selon le rôle. Le scope « Toute la flotte » couvre tout ;
                  ajoutez des scopes Groupe/Véhicule pour des permissions plus fines.
                } @else {
                  Le scope « Toute la flotte » couvre tout ; ajoutez des scopes
                  Groupe/Véhicule pour des permissions plus fines.
                }
              </p>
              <app-access-matrix-editor
                [scopes]="scopes()"
                [groups]="data()?.groups ?? []"
                [vehicles]="data()?.vehicles ?? []"
                [role]="$any(role)"
                [audioEligible]="!!data()?.audioEligible"
                (scopesChange)="scopes.set($event)"
              />
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
    /* iOS PWA standalone : insette l'overlay drawer par les safe-areas pour que
       le header (titre) ne passe pas sous le notch et le footer pas sous le home
       indicator. Combine au max-h-full du panneau. env() = 0 hors iOS => additif. */
    .drawer-overlay-safe {
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
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
    .role-btn.active.manager { border-color: var(--border-strong); color: var(--fg-secondary); background: var(--bg-tertiary) }
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

  // Verrou de scroll : fige la page derrière le drawer tant qu'il est ouvert
  // (cleanup = déverrouille aussi si le composant est détruit en étant ouvert).
  private readonly scrollLock = inject(ScrollLockService);
  private readonly lockEffect = effect((onCleanup) => {
    if (this.open()) {
      this.scrollLock.lock();
      onCleanup(() => this.scrollLock.unlock());
    }
  });
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

  /**
   * Scopes d'accès édités en mémoire (matrice), tous modes. Amorcé selon le mode
   * (scopes existants ou un scope « Toute la flotte » hérité du rôle). Émis au Save.
   */
  readonly scopes = signal<EditableAccessScope[]>([]);

  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly MapIcon = Map;

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
      // Amorce la matrice depuis les scopes d'accès existants (UserVehicleAccess), sinon
      // un scope ALL hérité du rôle.
      this.scopes.set(this.toEditableScopes(d.accessEntries, d.user.role));
    } else if (d.mode === 'edit-invitation' && d.invitation) {
      this.email = d.invitation.email;
      this.role = d.invitation.role;
      this.selectedFleetId = d.invitation.fleetId ?? '';
      this.isActive = true;
      this.scopes.set(this.toEditableScopes(d.invitation.accessScopes, d.invitation.role));
    } else {
      this.email = '';
      this.password = '';
      this.firstName = '';
      this.lastName = '';
      this.role = 'VIEWER';
      this.isActive = true;
      this.selectedFleetId = d.fleets?.length === 1 ? d.fleets[0].id : '';
      // Amorce la matrice : un scope « Toute la flotte », permissions héritées du rôle.
      this.scopes.set([{ _key: this.newScopeKey(), type: 'ALL', permissions: {} }]);
    }
    this.error.set('');
  }

  /**
   * Convertit des scopes backend (invitation.accessScopes / UserVehicleAccess) en scopes
   * éditables. Si la liste est vide/absente (invitation ou utilisateur legacy), on amorce
   * un unique scope « Toute la flotte » hérité du rôle → la matrice n'est jamais vide.
   */
  private toEditableScopes(scopes: DrawerAccessScope[] | null | undefined, _role: string): EditableAccessScope[] {
    if (scopes && scopes.length > 0) {
      return scopes.map((s) => ({
        _key: this.newScopeKey(),
        type: s.type,
        groupId: s.groupId ?? null,
        vehicleId: s.vehicleId ?? null,
        permissions: { ...(s.permissions ?? {}) },
      }));
    }
    return [{ _key: this.newScopeKey(), type: 'ALL', permissions: {} }];
  }

  private newScopeKey(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return c?.randomUUID ? c.randomUUID() : 'k' + Date.now() + Math.round(Math.random() * 1e6);
  }

  setRole(role: string): void {
    this.role = role;
  }

  onClose(): void {
    this.closed.emit();
  }

  onSave(): void {
    if (this.data()?.mode === 'create' && !this.email) {
      this.error.set('Email requis');
      return;
    }
    const isCreate = this.data()?.mode === 'create';
    this.saved.emit({
      ...(isCreate ? { email: this.email } : {}),
      firstName: this.firstName || undefined,
      lastName: this.lastName || undefined,
      role: this.role,
      isActive: this.isActive,
      fleetId: this.selectedFleetId || null,
      // La matrice pilote l'accès (tous les modes) → on envoie les scopes (sans clé locale).
      accessScopes: this.scopes().map((s) => ({
        type: s.type,
        ...(s.type === 'GROUP' && s.groupId ? { groupId: s.groupId } : {}),
        ...(s.type === 'VEHICLE' && s.vehicleId ? { vehicleId: s.vehicleId } : {}),
        permissions: s.permissions,
      })),
    });
  }
}
