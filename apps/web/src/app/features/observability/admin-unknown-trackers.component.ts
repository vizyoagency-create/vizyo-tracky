import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ArrowLeft, CheckCircle, LucideAngularModule, Plus, Radio, RefreshCw, Search, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { TrackersApiService } from '../../core/services/trackers.service';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import {
  UnknownTrackerDto,
  UnknownTrackersApiService,
} from '../../core/services/unknown-trackers.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

interface VehicleForAssign {
  id: string;
  plate: string;
  hasTracker: boolean;
}

@Component({
  selector: 'app-admin-unknown-trackers',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule, RouterLink],
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
          <h1 class="text-2xl font-display font-bold text-fg-primary">Boîtiers non reconnus</h1>
          <p class="text-sm text-fg-tertiary">
            Boîtiers qui tentent de se connecter mais dont l'IMEI n'est pas enregistré.
          </p>
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- Explainer -->
      <div class="bg-amber-500/10 border border-amber-500/20 rounded-[--radius-card] p-4 text-sm text-amber-200/90 flex gap-3">
        <lucide-icon [img]="Radio" [size]="20" class="text-amber-400 shrink-0 mt-0.5"></lucide-icon>
        <div>
          Ces IMEI tapent le serveur en <strong>GPRS</strong> mais ne sont pas en base → le serveur
          rejette la connexion et le boîtier <strong>retombe en SMS</strong> (spam de positions).
          Crée le tracker sur son véhicule : dès qu'il est enregistré, la connexion passe et le SMS s'arrête.
          <span class="text-amber-200/60">(Liste rafraîchie automatiquement ; un boîtier disparaît dès qu'il est créé et se connecte.)</span>
        </div>
      </div>

      <!-- Table -->
      @if (entries().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
          <table class="w-full text-sm min-w-[720px]">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">IMEI</th>
                <th class="p-3 text-center">Tentatives</th>
                <th class="p-3 text-left">1ʳᵉ vue</th>
                <th class="p-3 text-left">Dernière tentative</th>
                <th class="p-3 text-left">IP</th>
                <th class="p-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (e of entries(); track e.imei) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                  <td class="p-3 font-mono text-xs text-fg-primary">{{ e.imei }}</td>
                  <td class="p-3 text-center">
                    <span class="inline-flex items-center px-2 py-0.5 text-[11px] rounded-md bg-amber-500/10 text-amber-400 font-medium">
                      {{ e.attempts }}
                    </span>
                  </td>
                  <td class="p-3 text-fg-tertiary text-xs">{{ e.firstSeenAt | date: 'dd/MM HH:mm:ss' }}</td>
                  <td class="p-3 text-fg-tertiary text-xs">{{ e.lastSeenAt | date: 'dd/MM HH:mm:ss' }}</td>
                  <td class="p-3 font-mono text-[11px] text-fg-tertiary">{{ cleanIp(e.lastRemoteAddr) }}</td>
                  <td class="p-3">
                    <div class="flex items-center justify-center gap-3">
                      <button (click)="startCreate(e)" title="Créer le tracker et l'assigner"
                              class="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium">
                        <lucide-icon [img]="Plus" [size]="13"></lucide-icon>
                        Créer le tracker
                      </button>
                      <button (click)="ignore(e)" title="Retirer de la liste"
                              class="text-xs text-fg-tertiary hover:text-fg-secondary flex items-center gap-1">
                        <lucide-icon [img]="XIcon" [size]="12"></lucide-icon>
                        Ignorer
                      </button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center">
          <lucide-icon [img]="CheckCircle" [size]="36" class="mx-auto mb-3 text-emerald-400"></lucide-icon>
          <p class="text-sm text-fg-secondary font-medium">Aucun boîtier non reconnu.</p>
          <p class="text-xs text-fg-tertiary mt-1">Tous les boîtiers qui se connectent sont enregistrés. 🎉</p>
        </div>
      }

      <!-- Create modal -->
      @if (creatingFor()) {
        <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" (click)="cancelCreate()">
          <div class="bg-bg-secondary border border-border-subtle rounded-xl p-6 w-full max-w-md shadow-xl"
               (click)="$event.stopPropagation()">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-lg font-display font-bold text-fg-primary">
                Créer le tracker
              </h3>
              <button (click)="cancelCreate()" class="text-fg-tertiary hover:text-fg-primary">
                <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
              </button>
            </div>
            <p class="text-xs text-fg-tertiary mb-1">IMEI</p>
            <p class="font-mono text-sm text-fg-primary mb-4 px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg">
              {{ creatingFor()!.imei }}
            </p>
            <p class="text-xs text-fg-tertiary mb-1">N° SIM (optionnel)</p>
            <input type="text" placeholder="+33..." [(ngModel)]="simValue"
                   class="w-full mb-4 px-3 py-2 text-sm bg-bg-tertiary border border-border-subtle rounded-lg text-fg-primary font-mono placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
            <p class="text-xs text-fg-tertiary mb-1">Assigner au véhicule <span class="text-fg-tertiary/60">(optionnel)</span></p>
            <div class="relative mb-2">
              <lucide-icon [img]="Search" [size]="14"
                           class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"></lucide-icon>
              <input type="text" placeholder="Rechercher une plaque..."
                     [ngModel]="vehicleSearch()" (ngModelChange)="vehicleSearch.set($event)"
                     class="w-full pl-9 pr-3 py-2 text-sm bg-bg-tertiary border border-border-subtle rounded-lg text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-tracky" />
            </div>
            <div class="max-h-[190px] overflow-y-auto flex flex-col gap-1 mb-4">
              @for (v of filteredVehicles(); track v.id) {
                <button (click)="selectedVehicleId.set(v.id)"
                        class="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between border"
                        [class]="selectedVehicleId() === v.id ? 'bg-tracky/15 border-tracky' : 'border-transparent hover:bg-bg-tertiary/80'">
                  <span class="font-medium text-fg-primary">{{ v.plate }}</span>
                  @if (selectedVehicleId() === v.id) {
                    <lucide-icon [img]="CheckCircle" [size]="14" class="text-tracky-light"></lucide-icon>
                  }
                </button>
              } @empty {
                <p class="text-sm text-fg-tertiary text-center py-4">Aucun véhicule sans tracker disponible.</p>
              }
            </div>
            <div class="flex items-center justify-end gap-2 pt-3 border-t border-border-subtle">
              <button (click)="cancelCreate()"
                      class="px-3 py-2 text-sm text-fg-secondary hover:text-fg-primary cursor-pointer">Annuler</button>
              <button (click)="confirmCreate()" [disabled]="creating()"
                      class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2 disabled:opacity-50">
                <lucide-icon [img]="Plus" [size]="14"></lucide-icon>
                {{ creating() ? 'Création…' : (selectedVehicleId() ? 'Créer + assigner' : 'Créer le tracker') }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class AdminUnknownTrackersComponent implements OnInit {
  private readonly unknownApi = inject(UnknownTrackersApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly CheckCircle = CheckCircle;
  protected readonly Plus = Plus;
  protected readonly Radio = Radio;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Search = Search;
  protected readonly XIcon = X;

  readonly entries = signal<UnknownTrackerDto[]>([]);

  // Create modal
  readonly creatingFor = signal<UnknownTrackerDto | null>(null);
  readonly creating = signal(false);
  simValue = '';
  readonly vehicleSearch = signal('');
  readonly selectedVehicleId = signal<string | null>(null);
  private readonly allVehicles = signal<VehicleForAssign[]>([]);

  readonly filteredVehicles = computed(() => {
    const q = this.vehicleSearch().toLowerCase().trim();
    const list = this.allVehicles();
    return (q ? list.filter((v) => v.plate.toLowerCase().includes(q)) : list).slice(0, 50);
  });

  ngOnInit(): void {
    this.reload();
    // Rafraîchissement auto : les boîtiers retentent toutes les ~30 s.
    const id = setInterval(() => {
      if (!this.creatingFor()) this.reload();
    }, 20_000);
    this.destroyRef.onDestroy(() => clearInterval(id));
  }

  async reload(): Promise<void> {
    try {
      const data = await firstValueFrom(this.unknownApi.list());
      this.entries.set(data);
    } catch {
      this.toast.error('Échec du chargement des boîtiers non reconnus');
    }
  }

  /** `::ffff:46.114.229.57` → `46.114.229.57`. */
  protected cleanIp(addr: string | null): string {
    if (!addr) return '—';
    return addr.replace(/^::ffff:/, '');
  }

  async ignore(e: UnknownTrackerDto): Promise<void> {
    try {
      await firstValueFrom(this.unknownApi.forget(e.imei));
      this.entries.update((list) => list.filter((x) => x.imei !== e.imei));
    } catch {
      this.toast.error('Échec');
    }
  }

  // --- Create modal ---

  async startCreate(e: UnknownTrackerDto): Promise<void> {
    this.creatingFor.set(e);
    this.simValue = '';
    this.vehicleSearch.set('');
    this.selectedVehicleId.set(null);
    this.allVehicles.set([]);
    try {
      // hasTracker=false → le backend ne renvoie QUE les véhicules sans tracker (toutes
      // flottes pour un SUPER_ADMIN). Modale gardée ouverte si ça échoue (création sans assign possible).
      const vehicles = await firstValueFrom(this.vehiclesApi.list({ hasTracker: 'false' }));
      this.allVehicles.set(vehicles.map((v) => ({ id: v.id, plate: v.plate, hasTracker: false })));
    } catch {
      this.toast.error('Échec du chargement des véhicules');
    }
  }

  cancelCreate(): void {
    this.creatingFor.set(null);
  }

  async confirmCreate(): Promise<void> {
    const entry = this.creatingFor();
    if (!entry || this.creating()) return;
    this.creating.set(true);
    try {
      const sim = this.simValue.trim();
      const tracker = await firstValueFrom(
        this.trackersApi.create(sim ? { imei: entry.imei, simPhoneNumber: sim } : { imei: entry.imei }),
      );
      const vid = this.selectedVehicleId();
      if (vid) await firstValueFrom(this.trackersApi.assign(tracker.id, vid));
      // Retire de la liste des inconnus (il se reconnectera et sera accepté).
      await firstValueFrom(this.unknownApi.forget(entry.imei)).catch(() => undefined);
      this.toast.success(`Tracker ${entry.imei} créé${vid ? ' et assigné' : ''}`);
      this.creatingFor.set(null);
      this.entries.update((list) => list.filter((x) => x.imei !== entry.imei));
    } catch (e: unknown) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Échec de la création';
      this.toast.error(msg);
    } finally {
      this.creating.set(false);
    }
  }
}
