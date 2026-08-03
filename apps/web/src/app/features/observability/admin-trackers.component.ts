import { swallow } from '../../core/error/swallow';
import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Edit3,
  LucideAngularModule,
  Radio,
  RefreshCw,
  Search,
  Unlink,
  Wifi,
  WifiOff,
  X,
  Link,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { isTrackerOnline } from '@vizyo/tracky-shared';
import {
  TrackerDetail,
  TrackersApiService,
} from '../../core/services/trackers.service';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';

@Component({
  selector: 'app-admin-trackers',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule, RouterLink, GroupBadgeComponent],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Trackers</h1>
          <p class="text-sm text-fg-tertiary">
            Vue d'ensemble de tous les trackers, toutes flottes confondues.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <a routerLink="/admin/unknown-trackers"
             class="px-3 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-lg text-sm font-medium hover:bg-amber-500/20 cursor-pointer flex items-center gap-2">
            <lucide-icon [img]="AlertTriangle" [size]="14"></lucide-icon>
            Boîtiers non reconnus
          </a>
          <button (click)="reload()"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
            Rafraichir
          </button>
        </div>
      </div>

      <!-- Summary -->
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div class="bg-bg-secondary border border-sky-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="Radio" [size]="28" class="text-sky-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Total</div>
            <div class="text-2xl font-display font-bold text-sky-400">{{ summary().total }}</div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-emerald-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="Wifi" [size]="28" class="text-emerald-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Online</div>
            <div class="text-2xl font-display font-bold text-emerald-400">{{ summary().online }}</div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-amber-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="WifiOff" [size]="28" class="text-amber-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Offline</div>
            <div class="text-2xl font-display font-bold text-amber-400">{{ summary().offline }}</div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-purple-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="Unlink" [size]="28" class="text-purple-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Non assignes</div>
            <div class="text-2xl font-display font-bold text-purple-400">{{ summary().unassigned }}</div>
          </div>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-3">
        <div class="relative flex-1 min-w-[200px] max-w-[360px]">
          <lucide-icon [img]="Search" [size]="14"
                       class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"></lucide-icon>
          <input type="text" placeholder="Rechercher IMEI, plaque, flotte..."
                 [(ngModel)]="searchQuery"
                 class="w-full pl-9 pr-3 py-2 text-sm bg-bg-secondary border border-border-subtle rounded-lg text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
        </div>
        <select [(ngModel)]="filterStatus"
                class="px-3 py-2 text-sm bg-bg-secondary border border-border-subtle rounded-lg text-fg-primary focus:outline-none focus:border-tracky">
          <option value="">Tous les statuts</option>
          <option value="ONLINE">Online</option>
          <option value="OFFLINE">Offline</option>
        </select>
        <select [(ngModel)]="filterAssigned"
                class="px-3 py-2 text-sm bg-bg-secondary border border-border-subtle rounded-lg text-fg-primary focus:outline-none focus:border-tracky">
          <option value="">Tous</option>
          <option value="assigned">Assignes</option>
          <option value="unassigned">Non assignes</option>
        </select>
      </div>

      <!-- Table -->
      @if (filtered().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
          <table class="w-full text-sm min-w-[900px]">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Statut</th>
                <th class="p-3 text-left">IMEI</th>
                <th class="p-3 text-left">Modele</th>
                <th class="p-3 text-left">SIM</th>
                <th class="p-3 text-left">Vehicule</th>
                <th class="p-3 text-left">Flotte</th>
                <th class="p-3 text-left">Dernier signal</th>
                <th class="p-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (t of filtered(); track t.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                  <!-- Status -->
                  <td class="p-3">
                    @if (isLive(t)) {
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] rounded-md bg-emerald-500/10 text-emerald-400 font-medium">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        ON
                      </span>
                    } @else {
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] rounded-md bg-amber-500/10 text-amber-400 font-medium">
                        <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                        OFF
                      </span>
                    }
                  </td>
                  <!-- IMEI -->
                  <td class="p-3 font-mono text-xs">
                    <a [routerLink]="['/admin/trackers', t.id]" class="text-tracky-light hover:underline">{{ t.imei }}</a>
                  </td>
                  <!-- Model -->
                  <td class="p-3 text-fg-secondary text-xs">{{ t.model }}</td>
                  <!-- SIM -->
                  <td class="p-3">
                    @if (editingSimId() === t.id) {
                      <div class="flex items-center gap-1">
                        <input type="text" [ngModel]="editingSimValue()"
                               (ngModelChange)="editingSimValue.set($event)"
                               class="w-[130px] px-2 py-1 text-xs bg-bg-tertiary border border-border-subtle rounded text-fg-primary font-mono focus:outline-none focus:border-tracky"
                               placeholder="+33..." />
                        <button (click)="saveSim(t)" class="text-emerald-400 hover:text-emerald-300">
                          <lucide-icon [img]="CheckCircle" [size]="14"></lucide-icon>
                        </button>
                        <button (click)="cancelEditSim()" class="text-fg-tertiary hover:text-fg-secondary">
                          <lucide-icon [img]="XIcon" [size]="14"></lucide-icon>
                        </button>
                      </div>
                    } @else {
                      <div class="flex items-center gap-1 group">
                        <span class="font-mono text-xs text-fg-secondary">{{ t.simPhoneNumber || '—' }}</span>
                        <button (click)="startEditSim(t)"
                                class="opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-tracky-light transition-opacity">
                          <lucide-icon [img]="Edit3" [size]="12"></lucide-icon>
                        </button>
                      </div>
                    }
                  </td>
                  <!-- Vehicle -->
                  <td class="p-3 text-fg-primary text-xs font-medium">
                    @if (t.vehicle) {
                      <div class="flex items-center gap-1.5">
                        <a [routerLink]="['/vehicles', t.vehicle.id]" class="text-tracky-light hover:underline">{{ t.vehicle.plate }}</a>
                        <app-group-badge [group]="t.vehicle.group" />
                      </div>
                    } @else { — }
                  </td>
                  <!-- Fleet -->
                  <td class="p-3 text-fg-tertiary text-xs">
                    {{ t.vehicle?.fleet?.name ?? '—' }}
                  </td>
                  <!-- Last seen -->
                  <td class="p-3 text-fg-tertiary text-xs">
                    @if (t.lastSeenAt) {
                      {{ t.lastSeenAt | date: 'dd/MM HH:mm' }}
                    } @else {
                      jamais
                    }
                  </td>
                  <!-- Actions -->
                  <td class="p-3">
                    <div class="flex items-center justify-center gap-2">
                      @if (t.vehicle) {
                        <button (click)="unassign(t)" title="Desassigner"
                                class="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
                          <lucide-icon [img]="Unlink" [size]="12"></lucide-icon>
                          Detacher
                        </button>
                      } @else {
                        <button (click)="startAssign(t)" title="Assigner a un vehicule"
                                class="text-xs text-tracky-light hover:text-emerald-300 flex items-center gap-1">
                          <lucide-icon [img]="LinkIcon" [size]="12"></lucide-icon>
                          Assigner
                        </button>
                      }
                      <a [routerLink]="['/admin/trackers', t.id, 'fix-mode']"
                         class="text-xs text-sky-400 hover:text-sky-300">Fix</a>
                      <a [routerLink]="['/admin/trackers', t.id, 'sampling']"
                         class="text-xs text-purple-400 hover:text-purple-300">Sampling</a>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (trackers().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center">
          <lucide-icon [img]="Search" [size]="36" class="mx-auto mb-3 text-fg-tertiary"></lucide-icon>
          <p class="text-sm text-fg-tertiary">Aucun tracker ne correspond aux filtres.</p>
        </div>
      }

      <!-- Assign Modal -->
      @if (assigningTracker()) {
        <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
             (click)="cancelAssign()">
          <div class="bg-bg-secondary border border-border-subtle rounded-xl p-6 w-full max-w-md shadow-xl"
               (click)="$event.stopPropagation()">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-lg font-display font-bold text-fg-primary">
                Assigner {{ assigningTracker()!.imei }}
              </h3>
              <button (click)="cancelAssign()" class="text-fg-tertiary hover:text-fg-primary">
                <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
              </button>
            </div>
            <div class="relative mb-4">
              <input type="text" placeholder="Rechercher un vehicule (plaque)..."
                     [(ngModel)]="vehicleSearch"
                     class="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border-subtle rounded-lg text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
            </div>
            <div class="max-h-[260px] overflow-y-auto flex flex-col gap-1">
              @for (v of filteredVehicles(); track v.id) {
                <button (click)="confirmAssign(v.id)"
                        class="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-bg-tertiary/80 transition-colors flex items-center justify-between group">
                  <span class="font-medium text-fg-primary">{{ v.plate }}</span>
                  @if (v.hasTracker) {
                    <span class="text-[10px] text-amber-400">deja equipe</span>
                  }
                </button>
              } @empty {
                <p class="text-sm text-fg-tertiary text-center py-4">Aucun vehicule sans tracker.</p>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class AdminTrackersComponent implements OnInit {
  private readonly trackersApi = inject(TrackersApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly toast = inject(ToastService);

  // Icons
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly CheckCircle = CheckCircle;
  protected readonly Edit3 = Edit3;
  protected readonly LinkIcon = Link;
  protected readonly Radio = Radio;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Search = Search;
  protected readonly Unlink = Unlink;
  protected readonly Wifi = Wifi;
  protected readonly WifiOff = WifiOff;
  protected readonly XIcon = X;

  // State
  readonly trackers = signal<TrackerDetail[]>([]);
  readonly loading = signal(false);

  // Filters
  searchQuery = '';
  filterStatus = '';
  filterAssigned = '';

  // SIM inline edit
  readonly editingSimId = signal<string | null>(null);
  readonly editingSimValue = signal('');

  // Assign modal
  readonly assigningTracker = signal<TrackerDetail | null>(null);
  vehicleSearch = '';
  private allVehicles: VehicleForAssign[] = [];

  // Sprint 0.1 — « online » = fraîcheur du dernier signal (isTrackerOnline), PAS
  // la colonne `status` collante (jamais remise OFFLINE côté serveur). Voir
  // docs/sprint-0.1/DIAGNOSTIC.md §3.
  readonly summary = computed(() => {
    const all = this.trackers();
    const online = all.filter((t) => isTrackerOnline(t.lastSeenAt)).length;
    return {
      total: all.length,
      online,
      offline: all.length - online,
      unassigned: all.filter((t) => !t.vehicleId).length,
    };
  });

  /** Liveness d'affichage : dernier signal récent ? (cf. summary). */
  protected isLive(t: TrackerDetail): boolean {
    return isTrackerOnline(t.lastSeenAt);
  }

  readonly filtered = computed(() => {
    let list = this.trackers();
    const q = this.searchQuery.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (t) =>
          t.imei.toLowerCase().includes(q) ||
          (t.vehicle?.plate ?? '').toLowerCase().includes(q) ||
          (t.vehicle?.fleet?.name ?? '').toLowerCase().includes(q) ||
          (t.simPhoneNumber ?? '').includes(q),
      );
    }
    if (this.filterStatus === 'ONLINE') {
      list = list.filter((t) => isTrackerOnline(t.lastSeenAt));
    } else if (this.filterStatus === 'OFFLINE') {
      list = list.filter((t) => !isTrackerOnline(t.lastSeenAt));
    }
    if (this.filterAssigned === 'assigned') {
      list = list.filter((t) => !!t.vehicleId);
    } else if (this.filterAssigned === 'unassigned') {
      list = list.filter((t) => !t.vehicleId);
    }
    return list;
  });

  readonly filteredVehicles = computed(() => {
    const q = this.vehicleSearch.toLowerCase().trim();
    let list = this.allVehicles.filter((v) => !v.hasTracker);
    if (q) {
      list = list.filter((v) => v.plate.toLowerCase().includes(q));
    }
    return list.slice(0, 50);
  });

  ngOnInit(): void {
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(
        this.trackersApi.list({ limit: '500' }),
      );
      this.trackers.set(data);
    } catch (err) {
      swallow('admin-trackers:reload', err);
      this.toast.error('Echec du chargement des trackers');
    } finally {
      this.loading.set(false);
    }
  }

  // --- SIM inline edit ---

  startEditSim(t: TrackerDetail): void {
    this.editingSimId.set(t.id);
    this.editingSimValue.set(t.simPhoneNumber ?? '');
  }

  cancelEditSim(): void {
    this.editingSimId.set(null);
  }

  async saveSim(t: TrackerDetail): Promise<void> {
    const val = this.editingSimValue().trim();
    try {
      await firstValueFrom(
        this.trackersApi.update(t.id, { simPhoneNumber: val || '' }),
      );
      this.toast.success('SIM mise a jour');
      this.editingSimId.set(null);
      this.reload();
    } catch (e: any) {
      swallow('admin-trackers:saveSim', e);
      this.toast.error(e?.error?.message ?? 'Echec de la mise a jour SIM');
    }
  }

  // --- Unassign ---

  async unassign(t: TrackerDetail): Promise<void> {
    if (!confirm(`Detacher le tracker ${t.imei} du vehicule ${t.vehicle?.plate} ?`)) return;
    try {
      await firstValueFrom(this.trackersApi.unassign(t.id));
      this.toast.success('Tracker detache');
      this.reload();
    } catch (err) {
      swallow('admin-trackers:unassign', err);
      this.toast.error('Echec du detachement');
    }
  }

  // --- Assign modal ---

  async startAssign(t: TrackerDetail): Promise<void> {
    this.assigningTracker.set(t);
    this.vehicleSearch = '';
    try {
      const vehicles = await firstValueFrom(this.vehiclesApi.list());
      this.allVehicles = vehicles.map((v) => ({
        id: v.id,
        plate: v.plate,
        hasTracker: !!v.tracker,
      }));
    } catch (err) {
      swallow('admin-trackers:startAssign', err);
      this.toast.error('Echec du chargement des vehicules');
      this.assigningTracker.set(null);
    }
  }

  cancelAssign(): void {
    this.assigningTracker.set(null);
  }

  async confirmAssign(vehicleId: string): Promise<void> {
    const tracker = this.assigningTracker();
    if (!tracker) return;
    try {
      await firstValueFrom(this.trackersApi.assign(tracker.id, vehicleId));
      this.toast.success(`Tracker ${tracker.imei} assigne`);
      this.assigningTracker.set(null);
      this.reload();
    } catch (e: any) {
      swallow('admin-trackers:confirmAssign', e);
      this.toast.error(e?.error?.message ?? 'Echec de l\'assignation');
    }
  }
}

interface VehicleForAssign {
  id: string;
  plate: string;
  hasTracker: boolean;
}
