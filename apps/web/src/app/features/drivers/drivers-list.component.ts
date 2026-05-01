import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Plus, Archive, Pencil, Mail, Phone, IdCard, UserRound } from 'lucide-angular';
import type { DriverDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DriversApiService } from '../../core/services/drivers.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { DriverDrawerComponent, type DriverDrawerData, type DriverDrawerResult } from './driver-drawer.component';

/**
 * Phase 2 — Page liste des Conducteurs.
 * Clone visuel du users-list (cards + drawer + confirmation archive).
 *
 * - VIEWER : voit la liste mais ne peut pas creer/modifier/archiver.
 * - FLEET_MANAGER (avec perm `drivers_manage`) + FLEET_ADMIN + SUPER_ADMIN :
 *   pleins droits.
 * - Soft-delete (`isActive=false`) — preserve l'historique Trip.driverId.
 */
@Component({
  selector: 'app-drivers-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, ConfirmModalComponent, DriverDrawerComponent],
  template: `
    <div class="dpage">
      <div class="d-blobs"></div>

      <div class="d-header">
        <div>
          <h1 class="d-title">Conducteurs</h1>
          <p class="d-sub">
            {{ drivers().length }} conducteur(s){{ includeArchived() ? ' (archivés inclus)' : ' actif(s)' }}
          </p>
        </div>
        <div class="d-header-actions">
          @if (canManage()) {
            <label class="d-toggle-archived">
              <input type="checkbox" [checked]="includeArchived()" (change)="toggleArchived()" />
              <span>Archivés</span>
            </label>
            <button (click)="openCreateDrawer()" class="d-add-btn">
              <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Nouveau
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="d-loading">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (drivers().length === 0) {
        <div class="d-empty">
          <div class="d-empty-icon"><lucide-icon [img]="UserRoundIcon" [size]="32"></lucide-icon></div>
          <p>Aucun conducteur enregistré</p>
          @if (canManage()) {
            <button (click)="openCreateDrawer()" class="d-empty-cta">
              Créer votre premier conducteur
            </button>
          }
        </div>
      } @else {
        <div class="d-grid">
          @for (d of drivers(); track d.id) {
            <div class="d-card" [class.archived]="!d.isActive">
              <!-- Pastille couleur en glow d'angle -->
              <div class="d-card-glow"
                   [style.background]="d.color ?? '#10E0A0'"></div>

              <!-- Top: avatar + info -->
              <div class="d-card-top">
                <div class="d-avatar"
                     [style.background]="d.color ?? '#10E0A0'">
                  {{ initials(d) }}
                </div>
                <div class="d-info">
                  <p class="d-name">{{ d.firstName }} {{ d.lastName }}</p>
                  @if (d.licenseNumber) {
                    <p class="d-license">
                      <lucide-icon [img]="IdCardIcon" [size]="10"></lucide-icon>
                      {{ d.licenseNumber }}
                    </p>
                  }
                </div>
                <div class="d-status" [class]="d.isActive ? 'active' : 'suspended'">
                  {{ d.isActive ? 'Actif' : 'Archivé' }}
                </div>
              </div>

              <!-- Mid: contact -->
              @if (d.phone || d.email) {
                <div class="d-card-mid">
                  @if (d.phone) {
                    <a [href]="'tel:' + d.phone" class="d-contact-item">
                      <lucide-icon [img]="PhoneIcon" [size]="11"></lucide-icon>
                      {{ d.phone }}
                    </a>
                  }
                  @if (d.email) {
                    <a [href]="'mailto:' + d.email" class="d-contact-item">
                      <lucide-icon [img]="MailIcon" [size]="11"></lucide-icon>
                      <span class="d-contact-email">{{ d.email }}</span>
                    </a>
                  }
                </div>
              }

              <!-- Bottom: actions -->
              @if (canManage() && d.isActive) {
                <div class="d-card-actions">
                  <button (click)="openEditDrawer(d)" class="d-action-btn" title="Modifier">
                    <lucide-icon [img]="PencilIcon" [size]="14"></lucide-icon> Modifier
                  </button>
                  <button (click)="confirmArchive(d)" class="d-action-btn danger" title="Archiver">
                    <lucide-icon [img]="ArchiveIcon" [size]="14"></lucide-icon>
                  </button>
                </div>
              }
              @if (canManage() && !d.isActive) {
                <div class="d-card-actions">
                  <button (click)="reactivate(d)" class="d-action-btn" title="Réactiver">
                    Réactiver
                  </button>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>

    <app-driver-drawer
      [open]="showDrawer()"
      [data]="drawerData()"
      [loading]="drawerLoading()"
      (closed)="showDrawer.set(false)"
      (saved)="onDrawerSave($event)"
    />

    <app-confirm-modal
      [open]="showArchiveModal()"
      title="Archiver ce conducteur"
      [description]="archiveDescription()"
      confirmLabel="Archiver"
      [danger]="true"
      [loading]="archiving()"
      (confirmed)="onArchive()"
      (cancelled)="showArchiveModal.set(false)"
    />
  `,
  styles: [`
    .dpage { position: relative; min-height: 100% }
    .d-blobs { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden }
    .d-blobs::before {
      content: ''; position: absolute; top: -10%; right: -10%; width: 50%; height: 55%;
      background: radial-gradient(ellipse, rgba(16,224,160,.07) 0%, transparent 70%);
      border-radius: 50% 40% 60% 30%;
    }
    .d-blobs::after {
      content: ''; position: absolute; bottom: -15%; left: -10%; width: 45%; height: 50%;
      background: radial-gradient(ellipse, rgba(59,130,246,.05) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%;
    }

    .d-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px }
    .d-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .d-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .d-header-actions { display: flex; align-items: center; gap: 10px }
    .d-toggle-archived {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--fg-tertiary); cursor: pointer;
    }
    .d-toggle-archived input { accent-color: var(--tracky); cursor: pointer }
    .d-add-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px;
      font-size: 12px; font-weight: 700; background: #059669; color: white; border: none; cursor: pointer;
      box-shadow: 0 2px 8px rgba(5,150,105,.3);
    }
    .d-add-btn:hover { background: #047857 }

    .d-loading { position: relative; z-index: 1; display: flex; justify-content: center; padding: 60px 0 }
    .d-empty {
      position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 50px 20px; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.55); backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.1); color: var(--fg-tertiary);
    }
    .d-empty-icon {
      width: 60px; height: 60px; border-radius: 16px; background: var(--bg-tertiary);
      display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary);
    }
    .d-empty-cta {
      font-size: 13px; color: var(--tracky-light); background: none; border: none;
      cursor: pointer; text-decoration: underline;
    }

    .d-grid {
      position: relative; z-index: 1;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px;
    }

    .d-card {
      position: relative; padding: 18px; border-radius: 14px; overflow: hidden;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.55);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.08); transition: all .3s;
    }
    .d-card:hover {
      border-color: rgba(16,224,160,.2);
      box-shadow: 0 0 30px rgba(16,224,160,.06), 0 8px 24px rgba(0,0,0,.15);
    }
    .d-card.archived { opacity: .45; filter: grayscale(.5) }
    :host-context([data-theme="light"]) .d-card { background: rgba(255,255,255,.6); border-color: rgba(16,224,160,.1) }
    :host-context([data-theme="light"]) .d-card:hover { border-color: rgba(16,224,160,.25); box-shadow: 0 0 30px rgba(16,224,160,.05), 0 8px 24px rgba(0,0,0,.05) }

    .d-card-glow {
      position: absolute; top: 0; right: 0; width: 60px; height: 60px;
      border-radius: 0 0 0 60px; opacity: .12; pointer-events: none;
    }

    .d-card-top { display: flex; align-items: center; gap: 12px; margin-bottom: 12px }
    .d-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700; color: white; flex-shrink: 0;
    }
    .d-info { flex: 1; min-width: 0 }
    .d-name {
      font-size: 14px; font-weight: 700; color: var(--fg-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .d-license {
      font-size: 11px; color: var(--fg-tertiary); margin-top: 2px;
      display: flex; align-items: center; gap: 4px;
      font-family: var(--font-mono, monospace);
    }
    .d-status {
      font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 6px; flex-shrink: 0;
    }
    .d-status.active { background: rgba(16,224,160,.1); color: var(--tracky-light) }
    .d-status.suspended { background: rgba(239,68,68,.1); color: #f87171 }

    .d-card-mid {
      display: flex; flex-direction: column; gap: 4px;
      padding: 10px 0; margin: 8px 0;
      border-top: 1px solid var(--border-subtle);
      border-bottom: 1px solid var(--border-subtle);
    }
    .d-contact-item {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--fg-tertiary);
      text-decoration: none; transition: color .15s;
    }
    .d-contact-item:hover { color: var(--tracky-light) }
    .d-contact-item lucide-icon { color: inherit; flex-shrink: 0 }
    .d-contact-email {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .d-card-actions { display: flex; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-subtle) }
    .d-action-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: 8px;
      font-size: 11px; font-weight: 600;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); cursor: pointer; transition: all .2s;
    }
    .d-action-btn:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.2) }
    .d-action-btn.danger:hover { color: #f87171; border-color: rgba(239,68,68,.2) }
  `],
})
export class DriversListComponent implements OnInit {
  private readonly driversApi = inject(DriversApiService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly drivers = signal<DriverDto[]>([]);
  readonly includeArchived = signal(false);

  readonly showDrawer = signal(false);
  readonly drawerData = signal<DriverDrawerData | null>(null);
  readonly drawerLoading = signal(false);

  readonly showArchiveModal = signal(false);
  readonly archiving = signal(false);
  readonly driverToArchive = signal<DriverDto | null>(null);

  protected readonly Plus = Plus;
  protected readonly ArchiveIcon = Archive;
  protected readonly PencilIcon = Pencil;
  protected readonly MailIcon = Mail;
  protected readonly PhoneIcon = Phone;
  protected readonly IdCardIcon = IdCard;
  protected readonly UserRoundIcon = UserRound;

  /** Roles autorises a creer/modifier/archiver un driver. */
  protected readonly canManage = computed(() => {
    const r = this.auth.user()?.role;
    if (r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN') return true;
    if (r === 'FLEET_MANAGER') return this.perms.can('drivers_manage');
    return false;
  });

  /**
   * Description du modal d'archivage (avec apostrophes francaises).
   * Calculee dans un computed pour eviter les soucis de parsing inline.
   */
  protected readonly archiveDescription = computed(() => {
    const d = this.driverToArchive();
    const name = d ? `${d.firstName} ${d.lastName}` : '';
    return `Voulez-vous archiver <strong>${name}</strong> ? L'historique des trajets est conservé. Le conducteur est retiré des véhicules où il était actif.`;
  });

  async ngOnInit(): Promise<void> {
    await this.loadDrivers();
  }

  protected initials(d: DriverDto): string {
    const fi = d.firstName?.[0] ?? '';
    const li = d.lastName?.[0] ?? '';
    return (fi + li).toUpperCase() || '?';
  }

  protected async toggleArchived(): Promise<void> {
    this.includeArchived.update((v) => !v);
    await this.loadDrivers();
  }

  protected openCreateDrawer(): void {
    this.drawerData.set({ mode: 'create' });
    this.showDrawer.set(true);
  }

  protected openEditDrawer(driver: DriverDto): void {
    this.drawerData.set({ mode: 'edit', driver });
    this.showDrawer.set(true);
  }

  protected confirmArchive(driver: DriverDto): void {
    this.driverToArchive.set(driver);
    this.showArchiveModal.set(true);
  }

  protected async onArchive(): Promise<void> {
    const d = this.driverToArchive();
    if (!d) return;
    this.archiving.set(true);
    try {
      await firstValueFrom(this.driversApi.archive(d.id));
      this.toast.success('Conducteur archivé');
      this.showArchiveModal.set(false);
      this.driverToArchive.set(null);
      await this.loadDrivers();
    } catch (err) {
      this.toast.error('Échec archivage', err instanceof Error ? err.message : '');
    } finally {
      this.archiving.set(false);
    }
  }

  /** Reactive un driver archive : juste un PATCH isActive=true. */
  protected async reactivate(driver: DriverDto): Promise<void> {
    try {
      await firstValueFrom(this.driversApi.update(driver.id, { isActive: true }));
      this.toast.success('Conducteur réactivé');
      await this.loadDrivers();
    } catch (err) {
      this.toast.error('Échec réactivation', err instanceof Error ? err.message : '');
    }
  }

  protected async onDrawerSave(result: DriverDrawerResult): Promise<void> {
    this.drawerLoading.set(true);
    try {
      const mode = this.drawerData()?.mode;
      if (mode === 'create') {
        await firstValueFrom(this.driversApi.create({
          firstName: result.firstName,
          lastName: result.lastName,
          phone: result.phone,
          email: result.email,
          licenseNumber: result.licenseNumber,
          color: result.color,
          notes: result.notes,
        }));
        this.toast.success('Conducteur créé');
      } else {
        const id = this.drawerData()?.driver?.id;
        if (id) {
          await firstValueFrom(this.driversApi.update(id, result));
          this.toast.success('Conducteur mis à jour');
        }
      }
      this.showDrawer.set(false);
      await this.loadDrivers();
    } catch (err) {
      this.toast.error('Échec', err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      this.drawerLoading.set(false);
    }
  }

  private async loadDrivers(): Promise<void> {
    this.loading.set(true);
    try {
      this.drivers.set(await this.driversApi.list(this.includeArchived()));
    } catch (err) {
      this.toast.error('Échec de chargement', err instanceof Error ? err.message : '');
    } finally {
      this.loading.set(false);
    }
  }
}
