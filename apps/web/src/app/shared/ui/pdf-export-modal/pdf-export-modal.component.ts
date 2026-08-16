import {
  Component,
  HostListener,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertTriangle,
  BarChart3,
  Check,
  FileText,
  ListChecks,
  LucideAngularModule,
  Route,
  Search,
  Trophy,
  Truck,
  X,
} from 'lucide-angular';
import type { VehicleDetailDto } from '../../../core/services/vehicles.service';
import type { PdfReportSection } from '../../../core/services/reports.service';

export interface PdfExportRequest {
  /** undefined => toute la flotte. Sinon liste explicite. */
  vehicleIds?: string[];
  sections: PdfReportSection[];
  maxTrips: number;
  topN: number;
}

type Scope = 'all' | 'selected';

/**
 * Modal d'export PDF configurable — point d'entree unique depuis la page
 * Rapports. L'utilisateur choisit le perimetre vehicules (tout ou sous-ensemble),
 * les sections embarquees, et les caps trajets/top. La periode est heritee de
 * la page parente (le selecteur de periode reste l'unique source de verite).
 *
 * Patterns DA reutilises :
 *  - structure backdrop + dialog identique a DriverPicker / ConfirmModal
 *  - bottom-sheet sur mobile (full width, slide depuis le bas), modal centree
 *    sur desktop (max-w-2xl)
 *  - safe-area-inset-bottom pour les boutons sur iOS PWA
 *  - z-index 9100 (au-dessus des autres dialogs feature)
 */
@Component({
  selector: 'app-pdf-export-modal',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9100] flex flex-col sm:items-center sm:justify-center"
           role="dialog" aria-modal="true"
           [attr.aria-labelledby]="'pem-title-' + uid">
        <div class="absolute inset-0 bg-black/50 sm:backdrop-blur-sm"
             (click)="onClose()" aria-hidden="true"></div>

        <!-- Spacer mobile : pousse la sheet en bas en preservant le clic outside -->
        <div class="flex-1 sm:hidden" (click)="onClose()" aria-hidden="true"></div>

        <div class="pem-container">
          <!-- Header -->
          <header class="pem-header">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center
                        bg-tracky/15 text-tracky-light shrink-0">
              <lucide-icon [img]="FileTextIcon" [size]="18"></lucide-icon>
            </div>
            <div class="flex-1 min-w-0">
              <h3 [id]="'pem-title-' + uid"
                  class="text-base font-display font-semibold text-fg-primary">
                Exporter un rapport PDF
              </h3>
              <p class="text-xs text-fg-tertiary mt-0.5">
                {{ periodLabel() }}
              </p>
            </div>
            <button type="button" (click)="onClose()" aria-label="Fermer"
                    class="p-2 -m-1 rounded-lg text-fg-tertiary hover:text-fg-primary
                           hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>

          <!-- Body scrollable -->
          <div class="pem-body">
            <!-- Section 1 : Perimetre vehicules -->
            <section class="space-y-3">
              <header class="flex items-center gap-2">
                <lucide-icon [img]="TruckIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                <h4 class="text-xs font-display font-semibold uppercase tracking-wider text-fg-secondary">
                  Périmètre véhicules
                </h4>
              </header>

              <div class="grid grid-cols-2 gap-2">
                <button type="button" (click)="scope.set('all')"
                        class="pem-pill"
                        [class.pem-pill--active]="scope() === 'all'">
                  <span class="pem-pill-label">Tous</span>
                  <span class="pem-pill-count">{{ vehicles().length }}</span>
                </button>
                <button type="button" (click)="scope.set('selected')"
                        class="pem-pill"
                        [class.pem-pill--active]="scope() === 'selected'">
                  <span class="pem-pill-label">Sélection</span>
                  <span class="pem-pill-count">{{ selectedIds().size }}</span>
                </button>
              </div>

              @if (scope() === 'selected') {
                <div class="space-y-2">
                  <div class="flex items-center gap-2">
                    <div class="relative flex-1">
                      <lucide-icon [img]="SearchIcon" [size]="14"
                        class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary"></lucide-icon>
                      <input type="text" [(ngModel)]="search"
                        class="w-full pl-9 pr-3 py-2.5 bg-bg-tertiary border border-border-subtle
                               rounded-xl text-fg-primary text-sm focus:outline-none focus:border-tracky"
                        placeholder="Plaque, marque, modèle..." />
                    </div>
                    <button type="button" (click)="onToggleAllFiltered()"
                      class="px-3 py-2.5 text-xs font-medium rounded-xl
                             bg-bg-tertiary text-fg-secondary border border-border-subtle
                             hover:text-fg-primary transition-colors cursor-pointer whitespace-nowrap">
                      {{ allFilteredSelected() ? 'Décocher' : 'Tout cocher' }}
                    </button>
                  </div>

                  <div class="border border-border-subtle rounded-xl overflow-hidden">
                    @if (filteredVehicles().length === 0) {
                      <p class="text-center text-fg-tertiary text-sm py-6 px-3">
                        @if (search) { Aucun véhicule trouvé. }
                        @else { Aucun véhicule enregistré dans cette flotte. }
                      </p>
                    } @else {
                      <div class="max-h-64 overflow-y-auto divide-y divide-border-subtle">
                        @for (v of filteredVehicles(); track v.id) {
                          <label class="pem-row">
                            <input type="checkbox"
                                   class="pem-checkbox"
                                   [checked]="selectedIds().has(v.id)"
                                   (change)="onToggleVehicle(v.id)" />
                            <span class="flex-1 min-w-0">
                              <span class="text-sm font-semibold text-fg-primary block truncate">
                                {{ v.plate }}
                              </span>
                              @if (v.brand || v.model) {
                                <span class="text-xs text-fg-tertiary block truncate">
                                  {{ v.brand }} {{ v.model }}
                                </span>
                              }
                            </span>
                            @if (selectedIds().has(v.id)) {
                              <lucide-icon [img]="CheckIcon" [size]="14"
                                class="text-tracky-light shrink-0"></lucide-icon>
                            }
                          </label>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
            </section>

            <!-- Section 2 : Contenu du rapport -->
            <section class="space-y-3">
              <header class="flex items-center gap-2">
                <lucide-icon [img]="ListChecksIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                <h4 class="text-xs font-display font-semibold uppercase tracking-wider text-fg-secondary">
                  Contenu du rapport
                </h4>
              </header>

              <div class="space-y-1.5">
                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeKpi()" (change)="includeKpi.set(!includeKpi())" />
                  <lucide-icon [img]="BarChart3Icon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Indicateurs clés</span>
                    <span class="text-xs text-fg-tertiary block">8 cartes : distance, durée, vitesses, conso…</span>
                  </span>
                </label>

                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeAlerts()" (change)="includeAlerts.set(!includeAlerts())" />
                  <lucide-icon [img]="AlertTriangleIcon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Alertes</span>
                    <span class="text-xs text-fg-tertiary block">Total + ventilation par type et sévérité</span>
                  </span>
                </label>

                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeTopVehicles()" (change)="includeTopVehicles.set(!includeTopVehicles())" />
                  <lucide-icon [img]="TrophyIcon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Top véhicules</span>
                    <span class="text-xs text-fg-tertiary block">Classement par km parcourus</span>
                  </span>
                </label>
                @if (includeTopVehicles()) {
                  <div class="pem-suboption">
                    <label class="text-xs text-fg-tertiary" [attr.for]="'pem-topn-' + uid">
                      Top {{ topN() }}
                    </label>
                    <input type="range" min="3" max="30" step="1"
                           [id]="'pem-topn-' + uid"
                           [value]="topN()" (input)="onTopNInput($event)"
                           class="pem-range" />
                  </div>
                }

                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeTrips()" (change)="includeTrips.set(!includeTrips())" />
                  <lucide-icon [img]="RouteIcon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Trajets détaillés</span>
                    <span class="text-xs text-fg-tertiary block">Date, plaque, durée, distance, conducteur, note</span>
                  </span>
                </label>
                @if (includeTrips()) {
                  <div class="pem-suboption">
                    <label class="text-xs text-fg-tertiary" [attr.for]="'pem-max-trips-' + uid">
                      Max {{ maxTrips() }} trajets
                    </label>
                    <input type="range" min="10" max="200" step="10"
                           [id]="'pem-max-trips-' + uid"
                           [value]="maxTrips()" (input)="onMaxTripsInput($event)"
                           class="pem-range" />
                  </div>
                }
              </div>
            </section>
          </div>

          <!-- Footer sticky -->
          <footer class="pem-footer">
            <p class="text-[11px] sm:text-xs text-fg-tertiary order-2 sm:order-1 w-full sm:w-auto sm:flex-1 truncate">
              {{ summaryLabel() }}
            </p>
            <div class="flex items-center gap-2 order-1 sm:order-2">
              <button type="button" (click)="onClose()" [disabled]="loading()"
                class="px-4 py-2.5 text-sm font-medium rounded-xl
                       bg-bg-tertiary text-fg-secondary border border-border-subtle
                       hover:text-fg-primary transition-colors cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed">
                Annuler
              </button>
              <button type="button" (click)="onExport()" [disabled]="!canExport() || loading()"
                class="px-4 py-2.5 text-sm font-medium rounded-xl text-white
                       bg-tracky hover:bg-tracky-dark transition-colors cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center gap-2">
                @if (loading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                        aria-hidden="true"></span>
                  <span>Export…</span>
                } @else {
                  <lucide-icon [img]="FileTextIcon" [size]="14"></lucide-icon>
                  <span>Exporter</span>
                }
              </button>
            </div>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [`
    /* Container : bottom-sheet sur mobile, modal centree sur desktop */
    .pem-container {
      position: relative;
      width: 100%;
      max-width: 100%;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-subtle);
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      border-top-left-radius: 20px;
      border-top-right-radius: 20px;
      display: flex;
      flex-direction: column;
      max-height: 92dvh;
      box-shadow: 0 -8px 32px rgba(0, 0, 0, .35);
      animation: pem-slide-up .22s ease-out;
    }
    @media (min-width: 640px) {
      .pem-container {
        max-width: 42rem;
        margin: auto 1rem;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-card, 16px);
        max-height: 85dvh;
        box-shadow: 0 24px 48px rgba(0, 0, 0, .45);
        animation: pem-fade-in .18s ease-out;
      }
    }
    @keyframes pem-slide-up {
      from { transform: translateY(20px); opacity: .7 }
      to   { transform: translateY(0);    opacity: 1  }
    }
    @keyframes pem-fade-in {
      from { transform: scale(.98); opacity: 0 }
      to   { transform: scale(1);   opacity: 1 }
    }

    .pem-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 18px 20px 12px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .pem-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      -webkit-overflow-scrolling: touch;
    }
    .pem-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 12px 20px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    /* Pills "Tous / Selection" */
    .pem-pill {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 14px;
      min-height: 44px;
      border-radius: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color .15s, border-color .15s, color .15s;
    }
    .pem-pill:hover { color: var(--fg-primary) }
    .pem-pill--active {
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 35%, transparent);
      color: var(--tracky-light);
    }
    .pem-pill-label { font-weight: 600 }
    .pem-pill-count {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .06);
      color: var(--fg-tertiary);
    }
    .pem-pill--active .pem-pill-count {
      background: color-mix(in srgb, var(--color-tracky-light) 18%, transparent);
      color: var(--tracky-light);
    }

    /* Lignes vehicule + lignes option */
    .pem-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      min-height: 48px;
      background: transparent;
      cursor: pointer;
      transition: background-color .12s;
    }
    .pem-row:hover { background: var(--bg-tertiary) }
    .pem-row--option {
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
    }
    .pem-row--option:has(input:checked) {
      background: color-mix(in srgb, var(--color-tracky-light) 6%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 25%, transparent);
    }

    /* Checkbox custom — touch-friendly */
    .pem-checkbox {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 5px;
      accent-color: var(--color-tracky-light);
      cursor: pointer;
    }

    /* Sous-option (slider) */
    .pem-suboption {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 14px 4px 46px;
      animation: pem-fade-in .18s ease-out;
    }
    .pem-suboption label { white-space: nowrap; min-width: 96px }
    .pem-range {
      flex: 1;
      accent-color: var(--color-tracky-light);
      cursor: pointer;
    }
  `],
})
export class PdfExportModalComponent {
  readonly open = input.required<boolean>();
  readonly vehicles = input.required<VehicleDetailDto[]>();
  /** Periode courante de la page rapports (affichee en sous-titre, non modifiable ici). */
  readonly periodLabel = input<string>('');
  readonly loading = input(false);

  readonly closed = output<void>();
  readonly exportRequested = output<PdfExportRequest>();

  // ─── State ──────────────────────────────────────────────────────────────
  protected readonly scope = signal<Scope>('all');
  protected readonly selectedIds = signal<Set<string>>(new Set<string>());
  protected search = '';

  protected readonly includeKpi = signal(true);
  protected readonly includeAlerts = signal(true);
  protected readonly includeTopVehicles = signal(true);
  protected readonly includeTrips = signal(true);

  protected readonly maxTrips = signal(30);
  protected readonly topN = signal(10);

  // Reset state at each opening to match the parent's intent.
  private readonly resetEffect = effect(() => {
    if (this.open()) {
      this.scope.set('all');
      this.selectedIds.set(new Set());
      this.search = '';
      this.includeKpi.set(true);
      this.includeAlerts.set(true);
      this.includeTopVehicles.set(true);
      this.includeTrips.set(true);
      this.maxTrips.set(30);
      this.topN.set(10);
    }
  });

  // ─── Icons ──────────────────────────────────────────────────────────────
  protected readonly FileTextIcon = FileText;
  protected readonly XIcon = X;
  protected readonly SearchIcon = Search;
  protected readonly CheckIcon = Check;
  protected readonly TruckIcon = Truck;
  protected readonly ListChecksIcon = ListChecks;
  protected readonly BarChart3Icon = BarChart3;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly TrophyIcon = Trophy;
  protected readonly RouteIcon = Route;

  protected readonly uid = Math.random().toString(36).slice(2, 9);

  // ─── Derived ────────────────────────────────────────────────────────────
  protected readonly filteredVehicles = computed(() => {
    const q = this.search.trim().toLowerCase();
    const list = this.vehicles();
    if (!q) return list;
    return list.filter((v) =>
      `${v.plate} ${v.brand ?? ''} ${v.model ?? ''}`.toLowerCase().includes(q),
    );
  });

  protected readonly allFilteredSelected = computed(() => {
    const filtered = this.filteredVehicles();
    if (filtered.length === 0) return false;
    const sel = this.selectedIds();
    return filtered.every((v) => sel.has(v.id));
  });

  protected readonly selectedSectionCount = computed(() => {
    let n = 0;
    if (this.includeKpi()) n++;
    if (this.includeAlerts()) n++;
    if (this.includeTopVehicles()) n++;
    if (this.includeTrips()) n++;
    return n;
  });

  protected readonly summaryLabel = computed(() => {
    const total = this.vehicles().length;
    const scopeStr =
      this.scope() === 'all'
        ? `${total} véhicule${total > 1 ? 's' : ''}`
        : `${this.selectedIds().size} véhicule${this.selectedIds().size > 1 ? 's' : ''}`;
    const sections = this.selectedSectionCount();
    return `${scopeStr} · ${sections} section${sections > 1 ? 's' : ''}`;
  });

  protected readonly canExport = computed(() => {
    if (this.selectedSectionCount() === 0) return false;
    if (this.scope() === 'selected' && this.selectedIds().size === 0) return false;
    return true;
  });

  // ─── Handlers ───────────────────────────────────────────────────────────
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open() && !this.loading()) this.onClose();
  }

  protected onClose(): void {
    if (this.loading()) return;
    this.closed.emit();
  }

  protected onToggleVehicle(id: string): void {
    const next = new Set(this.selectedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedIds.set(next);
  }

  protected onToggleAllFiltered(): void {
    const filtered = this.filteredVehicles();
    const next = new Set(this.selectedIds());
    if (this.allFilteredSelected()) {
      for (const v of filtered) next.delete(v.id);
    } else {
      for (const v of filtered) next.add(v.id);
    }
    this.selectedIds.set(next);
  }

  protected onMaxTripsInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isNaN(value)) this.maxTrips.set(value);
  }

  protected onTopNInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isNaN(value)) this.topN.set(value);
  }

  protected onExport(): void {
    if (!this.canExport() || this.loading()) return;

    const sections: PdfReportSection[] = [];
    if (this.includeKpi()) sections.push('kpi');
    if (this.includeAlerts()) sections.push('alerts');
    if (this.includeTopVehicles()) sections.push('topVehicles');
    if (this.includeTrips()) sections.push('trips');

    this.exportRequested.emit({
      vehicleIds: this.scope() === 'selected' ? Array.from(this.selectedIds()) : undefined,
      sections,
      maxTrips: this.maxTrips(),
      topN: this.topN(),
    });
  }
}
