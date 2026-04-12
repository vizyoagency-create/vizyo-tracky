import { Component, inject, OnInit, signal } from '@angular/core';
import { LucideAngularModule, Plus, Shield, Trash2, Edit, MapPin } from 'lucide-angular';
import type { GeofenceDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { GeofencesApiService } from '../../core/services/geofences.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GeofenceDrawDialogComponent } from './geofence-draw-dialog/geofence-draw-dialog.component';

@Component({
  selector: 'app-geofences-list',
  standalone: true,
  imports: [LucideAngularModule, GeofenceDrawDialogComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Geofences</h1>
        @if (canManage()) {
          <button
            (click)="showDrawDialog.set(true)"
            class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl
                   bg-tracky hover:bg-tracky-dark text-white transition-colors cursor-pointer">
            <lucide-icon [img]="Plus" [size]="16"></lucide-icon>
            Creer une geofence
          </button>
        }
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center h-40">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (geofences().length === 0) {
        <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-3">
          <lucide-icon [img]="Shield" [size]="48" class="opacity-30"></lucide-icon>
          <p>Aucune geofence configuree</p>
        </div>
      } @else {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
          <table class="w-full text-sm">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Nom</th>
                <th class="p-3 text-right">Rayon</th>
                <th class="p-3 text-left">Regle</th>
                <th class="p-3 text-center">Statut</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (g of geofences(); track g.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors">
                  <td class="p-3">
                    <div class="flex items-center gap-2">
                      <span class="w-3 h-3 rounded-full shrink-0" [style.background]="g.color"></span>
                      <span class="font-semibold text-fg-primary">{{ g.name }}</span>
                    </div>
                  </td>
                  <td class="p-3 text-right text-fg-secondary font-mono">{{ g.radiusMeters }}m</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 text-xs rounded-md bg-tracky/10 text-tracky-light">
                      {{ ruleLabel(g.rule) }}
                    </span>
                  </td>
                  <td class="p-3 text-center">
                    <span class="w-2 h-2 rounded-full inline-block"
                          [class]="g.active ? 'bg-tracky-light' : 'bg-fg-tertiary'"></span>
                  </td>
                  <td class="p-3 text-right">
                    @if (canManage()) {
                      <button (click)="onDelete(g.id)"
                              class="text-fg-tertiary hover:text-red-400 cursor-pointer p-1">
                        <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <app-geofence-draw-dialog
      [open]="showDrawDialog()"
      (created)="onDialogClosed()"
    />
  `,
})
export class GeofencesListComponent implements OnInit {
  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  protected canManage(): boolean {
    const role = this.auth.user()?.role;
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN' || role === 'FLEET_MANAGER';
  }

  protected readonly geofences = signal<GeofenceDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly showDrawDialog = signal(false);

  protected readonly Plus = Plus;
  protected readonly Shield = Shield;
  protected readonly Trash2 = Trash2;
  protected readonly Edit = Edit;
  protected readonly MapPin = MapPin;

  ngOnInit(): void { this.loadGeofences(); }

  protected ruleLabel(rule: string): string {
    if (rule === 'ENTER') return 'Entree';
    if (rule === 'EXIT') return 'Sortie';
    return 'Entree + Sortie';
  }

  protected async onDelete(id: string): Promise<void> {
    try {
      await firstValueFrom(this.geofencesApi.delete(id));
      this.geofences.update((list) => list.filter((g) => g.id !== id));
      this.toast.success('Geofence supprimee');
    } catch { this.toast.error('Echec de la suppression'); }
  }

  protected onDialogClosed(): void {
    this.showDrawDialog.set(false);
    this.loadGeofences();
  }

  private async loadGeofences(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.geofencesApi.list());
      this.geofences.set(list);
    } catch { this.geofences.set([]); }
    finally { this.loading.set(false); }
  }
}
