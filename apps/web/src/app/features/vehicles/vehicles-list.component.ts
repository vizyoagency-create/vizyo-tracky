import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, Truck, ExternalLink, FolderOpen } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { AddVehicleDialogComponent } from './add-vehicle-dialog/add-vehicle-dialog.component';
import { VehicleGroupsTabComponent } from './vehicle-groups-tab.component';

@Component({
  selector: 'app-vehicles-list',
  standalone: true,
  imports: [RouterLink, LucideAngularModule, AddVehicleDialogComponent, VehicleGroupsTabComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Vehicules</h1>
        <div class="flex items-center gap-2">
          @if (isAdmin()) {
            <div class="flex rounded-xl border border-border-subtle overflow-hidden">
              <button (click)="activeTab.set('vehicles')"
                class="px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                [class]="activeTab() === 'vehicles' ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-secondary hover:text-fg-primary'">
                <lucide-icon [img]="TruckIcon" [size]="12" class="inline mr-1"></lucide-icon> Vehicules
              </button>
              <button (click)="activeTab.set('groups')"
                class="px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                [class]="activeTab() === 'groups' ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-secondary hover:text-fg-primary'">
                <lucide-icon [img]="FolderOpenIcon" [size]="12" class="inline mr-1"></lucide-icon> Groupes
              </button>
            </div>
          }
        </div>
      </div>

      @if (activeTab() === 'groups') {
        <app-vehicle-groups-tab />
      } @else {
        @if (isAdmin()) {
          <div class="flex items-center justify-end">
            <button
              (click)="showAddDialog.set(true)"
              class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl
                     bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer">
              <lucide-icon [img]="Plus" [size]="16"></lucide-icon>
              Ajouter un vehicule
            </button>
          </div>
        }

        @if (loading()) {
          <div class="flex items-center justify-center h-40">
            <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-3">
            <lucide-icon [img]="Truck" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucun vehicule dans votre flotte</p>
            <button
              (click)="showAddDialog.set(true)"
              class="text-sm text-tracky-light hover:underline cursor-pointer">
              Ajouter votre premier vehicule
            </button>
          </div>
        } @else {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
            <table class="w-full text-sm">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Plaque</th>
                  <th class="p-3 text-left">Marque / Modele</th>
                  <th class="p-3 text-left">Annee</th>
                  <th class="p-3 text-left">Tracker</th>
                  <th class="p-3 text-center">Statut</th>
                  <th class="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (v of vehicles(); track v.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors">
                    <td class="p-3">
                      <span class="font-semibold text-fg-primary">{{ v.plate }}</span>
                    </td>
                    <td class="p-3 text-fg-secondary">
                      {{ v.brand ?? '—' }} {{ v.model ?? '' }}
                    </td>
                    <td class="p-3 text-fg-secondary">{{ v.year ?? '—' }}</td>
                    <td class="p-3">
                      @if (v.tracker) {
                        <span class="font-mono text-xs text-fg-secondary">{{ v.tracker.imei }}</span>
                      } @else {
                        <span class="text-fg-tertiary text-xs">Non assigne</span>
                      }
                    </td>
                    <td class="p-3 text-center">
                      @if (v.tracker) {
                        <span class="w-2 h-2 rounded-full inline-block"
                              [class]="isTrackerOnline(v.tracker.id, v.tracker.status) ? 'bg-tracky-light' : 'bg-fg-tertiary'"></span>
                      } @else {
                        <span class="w-2 h-2 rounded-full bg-fg-tertiary inline-block"></span>
                      }
                    </td>
                    <td class="p-3 text-right">
                      <a [routerLink]="['/vehicles', v.id]"
                         class="inline-flex items-center gap-1 text-xs text-tracky-light hover:underline cursor-pointer">
                        Voir
                        <lucide-icon [img]="ExternalLink" [size]="12"></lucide-icon>
                      </a>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        <app-add-vehicle-dialog
          [open]="showAddDialog()"
          (created)="onDialogClosed()"
        />
      }
    </div>
  `,
})
export class VehiclesListComponent implements OnInit {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly auth = inject(AuthService);

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly showAddDialog = signal(false);
  protected readonly activeTab = signal<'vehicles' | 'groups'>('vehicles');

  protected readonly Plus = Plus;
  protected readonly TruckIcon = Truck;
  protected readonly Truck = Truck;
  protected readonly ExternalLink = ExternalLink;
  protected readonly FolderOpenIcon = FolderOpen;

  protected isAdmin(): boolean {
    const role = this.auth.user()?.role;
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN';
  }

  ngOnInit(): void {
    this.loadVehicles();
  }

  protected onDialogClosed(): void {
    this.showAddDialog.set(false);
    this.loadVehicles();
  }

  protected isTrackerOnline(trackerId: string, httpStatus: string): boolean {
    const live = this.realtime.trackerStatuses().get(trackerId);
    if (live) return live === 'online';
    return httpStatus === 'ONLINE';
  }

  private async loadVehicles(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.vehiclesApi.list());
      this.vehicles.set(list);
    } catch {
      this.vehicles.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
