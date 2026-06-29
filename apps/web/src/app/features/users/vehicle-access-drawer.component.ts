import { Component, HostListener, input, OnChanges, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, X, Save, Truck, FolderOpen, Globe } from 'lucide-angular';
import type { VehicleGroup } from '../../core/services/vehicle-groups.service';
import type { VehicleDetailDto } from '../../core/services/vehicles.service';

export interface AccessDrawerData {
  userEmail: string;
  currentType: 'ALL' | 'CUSTOM';
  currentGroupIds: string[];
  currentVehicleIds: string[];
  groups: VehicleGroup[];
  vehicles: VehicleDetailDto[];
}

export interface AccessDrawerResult {
  type: 'ALL' | 'CUSTOM';
  groupIds: string[];
  vehicleIds: string[];
}

@Component({
  selector: 'app-vehicle-access-drawer',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end drawer-overlay-safe">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative w-full max-w-md max-h-full bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div>
              <h2 class="text-lg font-display font-bold text-fg-primary">Accès véhicules</h2>
              <p class="text-xs text-fg-tertiary mt-0.5">{{ data()?.userEmail }}</p>
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

            <!-- Mode selection -->
            <section>
              <p class="section-title">Mode d'accès</p>
              <div class="flex gap-2">
                <button (click)="accessType = 'ALL'"
                  class="mode-btn" [class.active]="accessType === 'ALL'">
                  <lucide-icon [img]="GlobeIcon" [size]="16"></lucide-icon>
                  <span>Tous les véhicules</span>
                </button>
                <button (click)="accessType = 'CUSTOM'"
                  class="mode-btn" [class.active]="accessType === 'CUSTOM'">
                  <lucide-icon [img]="TruckIcon" [size]="16"></lucide-icon>
                  <span>Sélection</span>
                </button>
              </div>
            </section>

            @if (accessType === 'CUSTOM') {
              <!-- Groups -->
              @if (data()?.groups?.length) {
                <section>
                  <div class="section-header">
                    <lucide-icon [img]="FolderIcon" [size]="14" class="text-tracky-light"></lucide-icon>
                    <span class="section-title" style="margin:0">Groupes</span>
                  </div>
                  <div class="access-list">
                    @for (g of data()!.groups; track g.id) {
                      <div class="access-row">
                        <div class="flex items-center gap-2.5">
                          <span class="w-2 h-2 rounded-full bg-tracky-light shrink-0"></span>
                          <span class="text-sm text-fg-primary font-medium">{{ g.name }}</span>
                          <span class="text-[10px] text-fg-tertiary">({{ g._count.vehicles }})</span>
                        </div>
                        <label class="toggle">
                          <input type="checkbox" [checked]="selectedGroupIds.has(g.id)" (change)="toggleGroup(g.id)" />
                          <span class="toggle-track"><span class="toggle-thumb"></span></span>
                        </label>
                      </div>
                    }
                  </div>
                </section>
              }

              <!-- Individual vehicles -->
              <section>
                <div class="section-header">
                  <lucide-icon [img]="TruckIcon" [size]="14" class="text-tracky-light"></lucide-icon>
                  <span class="section-title" style="margin:0">Véhicules individuels</span>
                </div>
                <div class="access-list">
                  @for (v of data()!.vehicles; track v.id) {
                    <div class="access-row">
                      <div class="flex items-center gap-2.5">
                        <span class="w-2 h-2 rounded-full shrink-0"
                          [class]="selectedVehicleIds.has(v.id) ? 'bg-tracky-light' : 'bg-fg-tertiary'"></span>
                        <div>
                          <span class="text-sm text-fg-primary font-medium font-mono">{{ v.plate }}</span>
                          @if (v.brand) {
                            <span class="text-xs text-fg-tertiary ml-1.5">{{ v.brand }} {{ v.model ?? '' }}</span>
                          }
                        </div>
                      </div>
                      <label class="toggle">
                        <input type="checkbox" [checked]="selectedVehicleIds.has(v.id)" (change)="toggleVehicle(v.id)" />
                        <span class="toggle-track"><span class="toggle-thumb"></span></span>
                      </label>
                    </div>
                  }
                  @if (!data()?.vehicles?.length) {
                    <p class="text-xs text-fg-tertiary py-3 text-center">Aucun véhicule dans la flotte</p>
                  }
                </div>
              </section>
            }

            @if (accessType === 'ALL') {
              <div class="flex flex-col items-center justify-center py-8 text-center gap-2">
                <lucide-icon [img]="GlobeIcon" [size]="32" class="text-tracky-light opacity-40"></lucide-icon>
                <p class="text-sm text-fg-secondary">Cet utilisateur a accès à <strong class="text-fg-primary">tous les véhicules</strong> de la flotte.</p>
              </div>
            }
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
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
              Enregistrer
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
    .section-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px }

    .mode-btn {
      flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 12px; border-radius: 12px; font-size: 13px; font-weight: 600;
      background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); color: var(--fg-secondary);
      cursor: pointer; transition: all .2s;
    }
    .mode-btn:hover { border-color: var(--border-strong) }
    .mode-btn.active { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }

    .access-list { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden }
    .access-row {
      display: flex; align-items: center; justify-content: space-between; padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .access-row:last-child { border-bottom: none }

    /* .toggle : styles globaux (styles.css) */
  `],
})
export class VehicleAccessDrawerComponent implements OnChanges {
  readonly open = input.required<boolean>();
  readonly data = input.required<AccessDrawerData | null>();
  readonly loading = input(false);

  readonly closed = output<void>();
  readonly saved = output<AccessDrawerResult>();

  accessType: 'ALL' | 'CUSTOM' = 'ALL';
  selectedGroupIds = new Set<string>();
  selectedVehicleIds = new Set<string>();

  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly TruckIcon = Truck;
  protected readonly FolderIcon = FolderOpen;
  protected readonly GlobeIcon = Globe;

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.loading()) this.onClose(); }

  ngOnChanges(): void {
    const d = this.data();
    if (!d) return;
    this.accessType = d.currentType;
    this.selectedGroupIds = new Set(d.currentGroupIds);
    this.selectedVehicleIds = new Set(d.currentVehicleIds);
  }

  toggleGroup(id: string): void {
    if (this.selectedGroupIds.has(id)) this.selectedGroupIds.delete(id);
    else this.selectedGroupIds.add(id);
  }

  toggleVehicle(id: string): void {
    if (this.selectedVehicleIds.has(id)) this.selectedVehicleIds.delete(id);
    else this.selectedVehicleIds.add(id);
  }

  onClose(): void { this.closed.emit(); }

  onSave(): void {
    this.saved.emit({
      type: this.accessType,
      groupIds: [...this.selectedGroupIds],
      vehicleIds: [...this.selectedVehicleIds],
    });
  }
}
