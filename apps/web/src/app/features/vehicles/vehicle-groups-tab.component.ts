import { ToastService } from '../../shared/ui/toast/toast.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Trash2, FolderOpen, Truck, Eye, X } from 'lucide-angular';
import { VehicleGroupsService, type VehicleGroup } from '../../core/services/vehicle-groups.service';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { firstValueFrom } from 'rxjs';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';
import { VehicleLinkDirective } from '../../shared/directives/vehicle-link.directive';

@Component({
  selector: 'app-vehicle-groups-tab',
  standalone: true,
  imports: [FormsModule, RouterLink, LucideAngularModule, ConfirmModalComponent, SaFleetBadgeComponent, VehicleLinkDirective],
  template: `
    <div class="flex flex-col gap-4">
      <!-- Header : description + bouton (stack en mobile, row en desktop) -->
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-fg-secondary flex-1">Organisez vos véhicules en groupes pour gérer les accès.</p>
        <div class="flex gap-2 items-center">
          @if (perms.can('users_view')) {
            <a routerLink="/users/overview"
              class="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-bg-secondary border border-border-subtle
                     text-fg-tertiary hover:text-tracky-light hover:border-tracky/30 transition-colors"
              title="Vue d'ensemble permissions">
              <lucide-icon [img]="EyeIcon" [size]="15"></lucide-icon>
            </a>
          }
          @if (perms.can('groups_manage')) {
            <button (click)="showCreateModal.set(true)"
              class="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl
                     bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer
                     whitespace-nowrap shrink-0 self-start sm:self-auto">
              <lucide-icon [img]="Plus" [size]="14"></lucide-icon>
              Nouveau groupe
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-5 h-5 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (visibleGroups().length === 0) {
        <div class="flex flex-col items-center justify-center h-32 rounded-xl
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
          <lucide-icon [img]="FolderOpen" [size]="36" class="opacity-30"></lucide-icon>
          <p class="text-sm">Aucun groupe créé</p>
        </div>
      } @else {
        <div class="flex flex-col gap-3">
          @for (g of visibleGroups(); track g.id) {
            <div class="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2 flex-wrap">
                  <lucide-icon [img]="FolderOpen" [size]="16" class="text-tracky-light"></lucide-icon>
                  <span class="font-semibold text-fg-primary text-sm">{{ g.name }}</span>
                  <span class="text-xs text-fg-tertiary">({{ g._count.vehicles }} véhicule{{ g._count.vehicles > 1 ? 's' : '' }})</span>
                  <!-- V1.15 — Badge fleet (visible SA only). -->
                  <app-sa-fleet-badge [fleetId]="g.fleetId" />
                  <!-- Score de conduite du groupe (rang dans le classement) — motivation. -->
                  @if (scoreFor(g.id); as sc) {
                    <a routerLink="/scores" class="gsc-badge" [attr.data-grade]="sc.grade"
                       [title]="'Score de conduite du groupe : ' + sc.score + '/100 — ' + sc.rank + 'e / ' + sc.total + '. Voir le classement.'">
                      {{ sc.grade }} · {{ sc.score }} · {{ sc.rank }}<sup>{{ sc.rank === 1 ? 'er' : 'e' }}</sup>
                    </a>
                  }
                </div>
                @if (perms.can('groups_manage')) {
                  <button (click)="confirmDeleteGroup(g)"
                    class="p-1 rounded-lg text-fg-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer">
                    <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                  </button>
                }
              </div>

              <!-- Véhicules du groupe — la plaque est cliquable → fiche véhicule ;
                   le × (si gestion) retire du groupe, cible distincte (aucune navigation). -->
              <div class="flex flex-wrap gap-2 mb-3">
                @for (va of g.vehicles; track va.vehicleId) {
                  <span class="inline-flex items-center rounded-lg bg-bg-tertiary text-xs text-fg-secondary">
                    <span [vehicleLink]="va.vehicleId"
                      [title]="'Voir la fiche de ' + vehiclePlate(va.vehicleId)"
                      class="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 font-medium">
                      <lucide-icon [img]="TruckIcon" [size]="12"></lucide-icon>
                      {{ vehiclePlate(va.vehicleId) }}
                    </span>
                    @if (perms.can('groups_manage')) {
                      <button (click)="removeFromGroup(g.id, va.vehicleId)"
                        [attr.aria-label]="'Retirer ' + vehiclePlate(va.vehicleId) + ' du groupe'"
                        class="inline-flex items-center justify-center w-6 h-6 mr-1 rounded-md
                               text-fg-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer">
                        <lucide-icon [img]="XIcon" [size]="13"></lucide-icon>
                      </button>
                    }
                  </span>
                }
                @if (g.vehicles.length === 0) {
                  <span class="text-xs text-fg-tertiary italic">Aucun véhicule assigné</span>
                }
              </div>

              <!-- Ajouter un véhicule -->
              @if (perms.can('groups_manage')) {
              <div class="flex items-center gap-2 min-w-0">
                <select [(ngModel)]="selectedVehicleForGroup[g.id]"
                  class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-bg-tertiary border border-border-subtle text-fg-primary text-xs
                         focus:outline-none focus:border-tracky">
                  <option value="">Ajouter un véhicule...</option>
                  @for (v of availableVehicles(g); track v.id) {
                    <option [value]="v.id">{{ v.plate }} — {{ v.brand ?? '' }} {{ v.model ?? '' }}</option>
                  }
                </select>
                <button (click)="addToGroup(g.id)"
                  [disabled]="!selectedVehicleForGroup[g.id]"
                  class="shrink-0 px-2.5 py-1.5 rounded-lg bg-tracky/20 text-tracky-light text-xs font-medium
                         hover:bg-tracky/30 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors">
                  Ajouter
                </button>
              </div>
              }
            </div>
          }
        </div>
      }
    </div>

    <!-- Create Group Modal -->
    <app-confirm-modal
      [open]="showCreateModal()"
      title="Nouveau groupe"
      confirmLabel="Créer"
      [loading]="creating()"
      (confirmed)="onCreate()"
      (cancelled)="showCreateModal.set(false)"
    >
      <div class="mt-4 flex flex-col gap-3">
        @if (createError()) {
          <p class="text-sm text-red-400 mb-2">{{ createError() }}</p>
        }
        @if (isSuperAdmin()) {
          <div>
            <label class="text-xs font-medium text-fg-tertiary uppercase mb-1 block">Fleet</label>
            <select [(ngModel)]="selectedFleetId"
              class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                     focus:outline-none focus:border-tracky">
              @for (f of fleets(); track f.id) {
                <option [value]="f.id">{{ f.name }}</option>
              }
            </select>
          </div>
        }
        <input type="text" [(ngModel)]="newGroupName" placeholder="Nom du groupe (ex: Camions Nord)"
          class="w-full px-3 py-2 rounded-xl bg-bg-tertiary border border-border-subtle text-fg-primary text-sm
                 placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
      </div>
    </app-confirm-modal>

    <!-- Delete Group Modal -->
    <app-confirm-modal
      [open]="showDeleteModal()"
      title="Supprimer le groupe"
      [description]="'Supprimer le groupe <strong>' + (groupToDelete()?.name ?? '') + '</strong> ? Les véhicules ne seront pas supprimés.'"
      confirmLabel="Supprimer"
      [danger]="true"
      [loading]="deleting()"
      (confirmed)="onDeleteGroup()"
      (cancelled)="showDeleteModal.set(false)"
    />
  `,
  styles: [`
    .gsc-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .gsc-badge sup { font-size: 8px; }
    .gsc-badge[data-grade="A"] { background: color-mix(in srgb, #10E0A0 16%, transparent); color: #10E0A0; border-color: transparent; }
    .gsc-badge[data-grade="B"] { background: color-mix(in srgb, #84CC16 16%, transparent); color: #84CC16; border-color: transparent; }
    .gsc-badge[data-grade="C"] { background: color-mix(in srgb, #F59E0B 16%, transparent); color: #F59E0B; border-color: transparent; }
    .gsc-badge[data-grade="D"] { background: color-mix(in srgb, #F97316 16%, transparent); color: #F97316; border-color: transparent; }
    .gsc-badge[data-grade="E"] { background: color-mix(in srgb, #EF4444 16%, transparent); color: #EF4444; border-color: transparent; }
  `],
})
export class VehicleGroupsTabComponent implements OnInit {
  private readonly groupsService = inject(VehicleGroupsService);
  private readonly toast = inject(ToastService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly auth = inject(AuthService);
  protected readonly perms = inject(PermissionsService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly analysisApi = inject(TripAnalysisApiService);
  /** Score de conduite par groupe (note + rang), chargé en une fois → badge sur chaque groupe. */
  protected readonly groupScores = signal<Map<string, { score: number; grade: string; rank: number; total: number }>>(new Map());

  /** Recharge les scores (rang par société) quand le super-admin change de société.
   *  On saute le 1er run (ngOnInit → load() → loadScores() fait le chargement initial). */
  private groupScoresFleetFirstRun = true;
  private readonly groupScoresFleetEffect = effect(() => {
    this.fleetFilter.selectedFleetId();
    if (this.groupScoresFleetFirstRun) { this.groupScoresFleetFirstRun = false; return; }
    void this.loadScores();
  });

  readonly loading = signal(true);
  readonly groups = signal<VehicleGroup[]>([]);
  readonly allVehicles = signal<VehicleDetailDto[]>([]);

  /** Groupes filtrés par le sélecteur de société global (SUPER_ADMIN). No-op sinon. */
  protected readonly visibleGroups = computed(() =>
    this.groups().filter((g) => this.fleetFilter.matches(g.fleetId)),
  );
  readonly fleets = signal<FleetSummary[]>([]);

  readonly showCreateModal = signal(false);
  readonly creating = signal(false);
  readonly createError = signal('');
  newGroupName = '';
  selectedFleetId = '';

  readonly showDeleteModal = signal(false);
  readonly deleting = signal(false);
  readonly groupToDelete = signal<VehicleGroup | null>(null);

  selectedVehicleForGroup: Record<string, string> = {};

  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly FolderOpen = FolderOpen;
  protected readonly TruckIcon = Truck;
  protected readonly EyeIcon = Eye;
  protected readonly XIcon = X;

  protected isSuperAdmin(): boolean {
    return this.auth.user()?.role === 'SUPER_ADMIN';
  }

  async ngOnInit(): Promise<void> {
    if (this.isSuperAdmin()) {
      const fleets = await firstValueFrom(this.fleetsApi.list());
      this.fleets.set(fleets);
      if (fleets.length > 0) this.selectedFleetId = fleets[0].id;
    }
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [groups, vehicles] = await Promise.all([
        this.groupsService.list(),
        firstValueFrom(this.vehiclesApi.list()),
      ]);
      this.groups.set(groups);
      this.allVehicles.set(vehicles);
      void this.loadScores();
    } catch (err) {
      // ⚠️ C'ETAIT MUET : en panne, l'onglet affichait « aucun groupe » — donc la reponse
      // d'une flotte qui n'en a pas. L'utilisateur pouvait en recreer un qui existait
      // deja, ou conclure que son travail de la veille avait disparu.
      this.groups.set([]);
      this.toast.error('Chargement impossible', httpFailureMessage(err, 'les groupes'));
    } finally { this.loading.set(false); }
  }

  /** Classement des groupes (90 j, aligné sur la carte de score) → note + rang par groupe. Best-effort (badge motivant). */
  private async loadScores(): Promise<void> {
    try {
      const from = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const res = await firstValueFrom(
        this.analysisApi.scores('group', from, undefined, this.fleetFilter.selectedFleetId() ?? undefined),
      );
      const map = new Map<string, { score: number; grade: string; rank: number; total: number }>();
      res.rows.forEach((r, i) => map.set(r.id, { score: r.score, grade: r.grade, rank: i + 1, total: res.rows.length }));
      this.groupScores.set(map);
    } catch { this.groupScores.set(new Map()); }
  }

  protected scoreFor(groupId: string): { score: number; grade: string; rank: number; total: number } | null {
    return this.groupScores().get(groupId) ?? null;
  }

  vehiclePlate(vehicleId: string): string {
    return this.allVehicles().find((v) => v.id === vehicleId)?.plate ?? vehicleId.slice(0, 8);
  }

  availableVehicles(group: VehicleGroup): VehicleDetailDto[] {
    const assigned = new Set(group.vehicles.map((v) => v.vehicleId));
    return this.allVehicles().filter((v) => !assigned.has(v.id));
  }

  async addToGroup(groupId: string): Promise<void> {
    const vehicleId = this.selectedVehicleForGroup[groupId];
    if (!vehicleId) return;
    await this.groupsService.addVehicle(groupId, vehicleId);
    this.selectedVehicleForGroup[groupId] = '';
    await this.load();
  }

  async removeFromGroup(groupId: string, vehicleId: string): Promise<void> {
    await this.groupsService.removeVehicle(groupId, vehicleId);
    await this.load();
  }

  async onCreate(): Promise<void> {
    if (!this.newGroupName.trim()) return;
    this.creating.set(true);
    this.createError.set('');
    try {
      const fleetId = this.isSuperAdmin()
        ? this.selectedFleetId || undefined
        : undefined; // FLEET_ADMIN utilise sa propre fleet automatiquement côté backend
      await this.groupsService.create(this.newGroupName.trim(), fleetId);
      this.showCreateModal.set(false);
      this.newGroupName = '';
      await this.load();
    } catch (e) {
      this.createError.set((e as Error).message);
    } finally { this.creating.set(false); }
  }

  confirmDeleteGroup(group: VehicleGroup): void {
    this.groupToDelete.set(group);
    this.showDeleteModal.set(true);
  }

  async onDeleteGroup(): Promise<void> {
    const g = this.groupToDelete();
    if (!g) return;
    this.deleting.set(true);
    try {
      await this.groupsService.remove(g.id);
      this.showDeleteModal.set(false);
      this.groupToDelete.set(null);
      await this.load();
    } catch (err) {
      // `fetch` natif : hors intercepteur, donc le toast se pose ici ou nulle part.
      this.toast.error('Suppression impossible', httpFailureMessage(err, 'ce groupe'));
    } finally { this.deleting.set(false); }
  }
}
