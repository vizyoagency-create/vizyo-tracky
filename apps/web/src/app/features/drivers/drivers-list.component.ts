import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Archive, Pencil, Mail, Phone, IdCard, UserRound, Truck, Route, ChevronDown, ChevronRight, Download, UserX, CalendarClock } from 'lucide-angular';
import type { DriverDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DriversApiService } from '../../core/services/drivers.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { DriverDrawerComponent, type DriverDrawerData, type DriverDrawerResult } from './driver-drawer.component';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';

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
  imports: [FormsModule, RouterLink, LucideAngularModule, ConfirmModalComponent, DriverDrawerComponent, SaFleetBadgeComponent],
  template: `
    <div class="dpage" [class.dpage--embedded]="embedded()">
      @if (!embedded()) {
        <div class="d-blobs"></div>
      }

      <div class="d-header" [class.d-header--embedded]="embedded()">
        <div>
          @if (!embedded()) {
            <h1 class="d-title">Conducteurs</h1>
          }
          <p class="d-sub">
            {{ visibleDrivers().length }} conducteur(s){{ includeArchived() ? ' (archivés inclus)' : ' actif(s)' }}
            @if (embedded()) { — personnes qui conduisent les véhicules (≠ comptes d'accès à l'app). }
          </p>
        </div>
        <div class="d-header-actions">
          @if (canManage()) {
            <label class="d-toggle-archived">
              <input type="checkbox" [checked]="includeArchived()" (change)="toggleArchived()" />
              <span>Archivés</span>
            </label>
            <button (click)="openCreateDrawer()" class="btn-primary">
              <lucide-icon [img]="Plus" [size]="15"></lucide-icon> Nouveau
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="d-loading">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (visibleDrivers().length === 0) {
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
          @for (d of visibleDrivers(); track d.id) {
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

              <!-- V1.15 — Badge contextuel SUPER_ADMIN + compteurs vehicules/trajets -->
              <div class="d-meta-row">
                <!-- Consolidation IA : marqueur de type explicite (≠ compte utilisateur). -->
                <span class="d-type-badge">
                  <lucide-icon [img]="UserRoundIcon" [size]="10"></lucide-icon> Conducteur
                </span>
                <app-sa-fleet-badge [fleetId]="d.fleetId" />
                @if ((d._count?.currentVehicles ?? 0) > 0) {
                  <button type="button" class="d-count-chip d-count-chip--btn" (click)="toggleDriver(d.id)"
                          title="Voir les véhicules attribués">
                    <lucide-icon [img]="TruckIcon" [size]="10"></lucide-icon>
                    {{ d._count?.currentVehicles }} véhicule{{ (d._count?.currentVehicles ?? 0) > 1 ? 's' : '' }}
                    <lucide-icon [img]="isDriverExpanded(d.id) ? ChevronDownIcon : ChevronRightIcon" [size]="10"></lucide-icon>
                  </button>
                }
                @if ((d._count?.trips ?? 0) > 0) {
                  <span class="d-count-chip" title="Trajets historiques">
                    <lucide-icon [img]="RouteIcon" [size]="10"></lucide-icon>
                    {{ d._count?.trips }} trajet{{ (d._count?.trips ?? 0) > 1 ? 's' : '' }}
                  </span>
                }
              </div>

              @if (isDriverExpanded(d.id) && d.currentVehicles?.length) {
                <div class="d-vehicles">
                  @for (v of d.currentVehicles; track v.id) {
                    <a [routerLink]="['/vehicles', v.id]" class="d-vehicle-item">{{ v.plate }}</a>
                  }
                </div>
              }

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
                  <button (click)="exportRgpd(d)" class="d-action-btn" title="Export RGPD (art. 15) — toutes les données du conducteur">
                    <lucide-icon [img]="DownloadIcon" [size]="14"></lucide-icon>
                  </button>
                  <button (click)="exportWorkTime(d)" class="d-action-btn" title="Registre du temps de travail (CSV, 5 ans)">
                    <lucide-icon [img]="CalendarClockIcon" [size]="14"></lucide-icon>
                  </button>
                  <button (click)="confirmArchive(d)" class="d-action-btn danger" title="Archiver">
                    <lucide-icon [img]="ArchiveIcon" [size]="14"></lucide-icon>
                  </button>
                  <button (click)="confirmAnonymize(d)" class="d-action-btn danger" title="Anonymiser (RGPD art. 17) — irréversible">
                    <lucide-icon [img]="UserXIcon" [size]="14"></lucide-icon>
                  </button>
                </div>
              }
              @if (canManage() && !d.isActive) {
                <div class="d-card-actions">
                  <button (click)="reactivate(d)" class="d-action-btn" title="Réactiver">
                    Réactiver
                  </button>
                  <button (click)="exportRgpd(d)" class="d-action-btn" title="Export RGPD (art. 15)">
                    <lucide-icon [img]="DownloadIcon" [size]="14"></lucide-icon>
                  </button>
                  <button (click)="confirmAnonymize(d)" class="d-action-btn danger" title="Anonymiser (RGPD art. 17) — irréversible">
                    <lucide-icon [img]="UserXIcon" [size]="14"></lucide-icon>
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
      [consequences]="archiveConsequences()"
      confirmLabel="Archiver"
      [danger]="true"
      [loading]="archiving()"
      (confirmed)="onArchive()"
      (cancelled)="showArchiveModal.set(false)"
    />

    <app-confirm-modal
      [open]="showAnonymizeModal()"
      title="Anonymiser ce conducteur ?"
      [description]="anonymizeDescription()"
      [consequences]="anonymizeConsequences()"
      [irreversible]="true"
      confirmLabel="Anonymiser définitivement"
      [danger]="true"
      [loading]="anonymizing()"
      (confirmed)="onAnonymize()"
      (cancelled)="showAnonymizeModal.set(false)"
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
      background: radial-gradient(ellipse, rgba(16,224,160,.045) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%;
    }

    .d-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px }
    .d-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .d-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .d-header-actions { display: flex; align-items: center; gap: 10px }
    /* Mobile : en-tête empilé (titre au-dessus, actions pleine largeur en dessous)
       au lieu de comprimer le titre — .d-header n'a pas de flex-wrap. */
    @media (max-width: 600px) {
      .d-header { flex-direction: column; align-items: stretch; gap: 12px; }
      .d-header-actions { width: 100%; }
    }
    .d-toggle-archived {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--fg-tertiary); cursor: pointer;
    }
    .d-toggle-archived input { accent-color: var(--tracky); cursor: pointer }
    /* bouton « Ajouter » : .btn-primary global (styles.css) */

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

    /* V1.15 — Ligne meta : fleet badge + compteurs vehicules/trajets. */
    .d-meta-row {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
      margin-top: 8px;
    }
    .d-count-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; font-weight: 600;
      padding: 2px 6px;
      border-radius: 9999px;
      background: var(--bg-tertiary);
      color: var(--fg-secondary);
      white-space: nowrap;
    }
    .d-count-chip--btn { border: 1px solid var(--border-subtle); cursor: pointer; transition: border-color .15s; }
    .d-count-chip--btn:hover { border-color: var(--tracky-light); color: var(--fg-primary); }
    .d-vehicles { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .d-vehicle-item { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 9999px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); text-decoration: none;
      font-size: 11px; font-weight: 700; color: var(--fg-primary); transition: border-color .15s; }
    .d-vehicle-item:hover { border-color: var(--tracky-light); }

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

    /* Marqueur de type « Conducteur » (différenciation vs cartes Compte). */
    .d-type-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 10px; font-weight: 700; letter-spacing: .02em;
      padding: 2px 7px; border-radius: 9999px;
      background: rgba(16,224,160,.12); color: var(--tracky-light);
      border: 1px solid rgba(16,224,160,.25); white-space: nowrap;
    }

    /* ─── Mode embarqué (onglet Conducteurs dans Utilisateurs) ─── */
    .dpage--embedded { min-height: auto }
    .d-header--embedded { align-items: center; margin-bottom: 16px }
  `],
})
export class DriversListComponent implements OnInit {
  private readonly driversApi = inject(DriversApiService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly fleetFilter = inject(FleetFilterService);

  /** Embarqué comme onglet (page Utilisateurs) : masque l'en-tête de page + les blobs. */
  readonly embedded = input(false);

  readonly loading = signal(true);
  readonly drivers = signal<DriverDto[]>([]);

  /** Vue filtrée par le sélecteur de société global (SUPER_ADMIN). No-op sinon. */
  protected readonly visibleDrivers = computed(() =>
    this.drivers().filter((d) => this.fleetFilter.matches(d.fleetId)),
  );
  /** Conducteurs dont la liste de véhicules attribués est dépliée (drill-down). */
  protected readonly expandedDrivers = signal<Set<string>>(new Set());
  protected toggleDriver(id: string): void {
    const next = new Set(this.expandedDrivers());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.expandedDrivers.set(next);
  }
  protected isDriverExpanded(id: string): boolean { return this.expandedDrivers().has(id); }
  readonly includeArchived = signal(false);

  readonly showDrawer = signal(false);
  readonly drawerData = signal<DriverDrawerData | null>(null);
  readonly drawerLoading = signal(false);

  readonly showArchiveModal = signal(false);
  readonly archiving = signal(false);
  // RGPD art. 17 — anonymisation (modal dédiée, irréversible).
  readonly showAnonymizeModal = signal(false);
  readonly driverToAnonymize = signal<DriverDto | null>(null);
  readonly anonymizing = signal(false);
  readonly driverToArchive = signal<DriverDto | null>(null);

  protected readonly Plus = Plus;
  protected readonly ArchiveIcon = Archive;
  protected readonly PencilIcon = Pencil;
  protected readonly DownloadIcon = Download;
  protected readonly UserXIcon = UserX;
  protected readonly CalendarClockIcon = CalendarClock;
  protected readonly MailIcon = Mail;
  protected readonly PhoneIcon = Phone;
  protected readonly IdCardIcon = IdCard;
  protected readonly UserRoundIcon = UserRound;
  protected readonly TruckIcon = Truck;
  protected readonly RouteIcon = Route;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronRightIcon = ChevronRight;

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
  protected readonly anonymizeDescription = computed(() => {
    const d = this.driverToAnonymize();
    if (!d) return '';
    return `<strong>${d.firstName} ${d.lastName}</strong> — droit à l'effacement (RGPD art. 17). `
      + 'Pensez à lancer l\'export RGPD avant, si vous en avez besoin.';
  });

  /**
   * Ce qui disparaît, énuméré. La règle du kit demande des chiffres ; ici ce sont des
   * CHAMPS, et les nommer un par un vaut mieux qu'un « ses données » qui laisse croire
   * que les trajets partent aussi — c'est précisément l'inverse.
   */
  protected readonly anonymizeConsequences = computed(() => {
    const d = this.driverToAnonymize();
    if (!d) return '';
    return 'Nom, téléphone, e-mail, permis et notes sont effacés, le compte de connexion désactivé '
      + 'et les accès supprimés. Les trajets, eux, sont conservés sous une fiche anonyme.';
  });

  protected readonly archiveDescription = computed(() => {
    const d = this.driverToArchive();
    const name = d ? `${d.firstName} ${d.lastName}` : '';
    return `Archiver <strong>${name}</strong>.`;
  });

  protected readonly archiveConsequences = computed(() => {
    const d = this.driverToArchive();
    // `_count` n'est renvoyé que par GET /drivers ; absent, on ne CHIFFRE PAS plutôt que
    // d'annoncer « 0 véhicule » à quelqu'un qui en conduit trois. Un compteur faux dans
    // une modale de danger est pire que pas de compteur.
    const n = d?._count?.currentVehicles;
    const vehicules = n === undefined
      ? 'Il est retiré des véhicules où il est actif.'
      : n === 0 ? 'Il n\'est affecté à aucun véhicule.'
      : n === 1 ? 'Il est retiré du véhicule où il est actif.'
      : `Il est retiré des ${n} véhicules où il est actif.`;
    const trajets = d?._count?.trips;
    const histo = trajets === undefined
      ? 'L\'historique de ses trajets est conservé'
      : `Ses ${trajets.toLocaleString('fr-FR')} trajets sont conservés`;
    return `${vehicules} ${histo}, et l'archivage se défait.`;
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
      swallow('drivers-list:onArchive', err);
      this.toast.error('Échec archivage', err instanceof Error ? err.message : '');
    } finally {
      this.archiving.set(false);
    }
  }

  /** RGPD art. 15 — télécharge l'export JSON complet (audité côté serveur). */
  protected async exportRgpd(driver: DriverDto): Promise<void> {
    try {
      const blob = await firstValueFrom(this.driversApi.gdprExport(driver.id));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rgpd-conducteur-${driver.lastName || driver.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast.success('Export RGPD téléchargé', `${driver.firstName} ${driver.lastName}`);
    } catch (err) {
      swallow('drivers-list:exportRgpd', err);
      this.toast.error('Export impossible', 'Réessayez.');
    }
  }

  /** RGPD 4.5 — télécharge le registre du temps de travail (CSV, audité côté serveur). */
  protected async exportWorkTime(driver: DriverDto): Promise<void> {
    try {
      const blob = await firstValueFrom(this.driversApi.workTimeCsv(driver.id));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `temps-travail-${driver.lastName || driver.id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast.success('Registre téléchargé', `${driver.firstName} ${driver.lastName}`);
    } catch (err) {
      swallow('drivers-list:exportWorkTime', err);
      this.toast.error('Export impossible', 'Réessayez.');
    }
  }

  protected confirmAnonymize(driver: DriverDto): void {
    this.driverToAnonymize.set(driver);
    this.showAnonymizeModal.set(true);
  }
  protected async onAnonymize(): Promise<void> {
    const d = this.driverToAnonymize();
    if (!d) return;
    this.anonymizing.set(true);
    try {
      await firstValueFrom(this.driversApi.anonymize(d.id));
      this.toast.success('Conducteur anonymisé', 'PII effacée, compte désactivé (irréversible).');
      this.showAnonymizeModal.set(false);
      this.driverToAnonymize.set(null);
      await this.loadDrivers();
    } catch (err) {
      swallow('drivers-list:onAnonymize', err);
      this.toast.error('Échec anonymisation', err instanceof Error ? err.message : '');
    } finally {
      this.anonymizing.set(false);
    }
  }

  /** Reactive un driver archive : juste un PATCH isActive=true. */
  protected async reactivate(driver: DriverDto): Promise<void> {
    try {
      await firstValueFrom(this.driversApi.update(driver.id, { isActive: true }));
      this.toast.success('Conducteur réactivé');
      await this.loadDrivers();
    } catch (err) {
      swallow('drivers-list:reactivate', err);
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
      swallow('drivers-list:onDrawerSave', err);
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
