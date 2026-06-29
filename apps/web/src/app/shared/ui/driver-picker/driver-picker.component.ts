import { Component, HostListener, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Plus, Search, UserRound, X, XCircle } from 'lucide-angular';
import type { DriverDto } from '@vizyo/tracky-shared';
import { DriversApiService } from '../../../core/services/drivers.service';

/**
 * Phase 2 — Modal centre pour selectionner (ou retirer) un conducteur.
 *
 * Reutilise par :
 *   - Vehicle detail (carte "Conducteur courant")
 *   - Reports table (reaffectation a posteriori)
 *   - Trip replay (futur)
 *
 * Le composant fetch lui-meme la liste des drivers actifs au mount (via
 * effect sur `open`). Selection => emit `selected` avec id ou null.
 *
 * Recherche live cote client par firstName+lastName (case-insensitive).
 */
@Component({
  selector: 'app-driver-picker',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9100] flex items-center justify-center"
           role="dialog" aria-modal="true">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                    p-5 max-w-md w-full mx-4 shadow-2xl flex flex-col gap-4 max-h-[80dvh]">

          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center
                        bg-tracky/15 text-tracky-light shrink-0">
              <lucide-icon [img]="UserRoundIcon" [size]="18"></lucide-icon>
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-base font-display font-semibold text-fg-primary">
                {{ title() ?? 'Choisir un conducteur' }}
              </h3>
              @if (subtitle()) {
                <p class="text-xs text-fg-tertiary mt-0.5">{{ subtitle() }}</p>
              }
            </div>
            <button type="button" (click)="onClose()"
                    class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary
                           hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="16"></lucide-icon>
            </button>
          </div>

          <!-- Search input -->
          <div class="relative">
            <lucide-icon [img]="SearchIcon" [size]="14"
              class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary"></lucide-icon>
            <input type="text" [(ngModel)]="search"
              class="w-full pl-9 pr-3 py-2.5 bg-bg-tertiary border border-border-subtle
                     rounded-xl text-fg-primary text-sm focus:outline-none focus:border-tracky"
              placeholder="Rechercher un conducteur..." autofocus />
          </div>

          <!-- Liste -->
          <div class="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
            @if (loading()) {
              <div class="flex justify-center py-6">
                <span class="w-5 h-5 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
              </div>
            } @else if (filtered().length === 0) {
              <div class="text-center py-6">
                <p class="text-fg-tertiary text-sm">
                  @if (search) { Aucun conducteur trouve. }
                  @else { Aucun conducteur enregistre. }
                </p>
                @if (!search && showCreate()) {
                  <button type="button" (click)="onCreateRequested()"
                    class="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl
                           bg-tracky/15 text-tracky-light border border-tracky/25
                           hover:bg-tracky/25 transition-colors cursor-pointer">
                    <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon>
                    Nouveau conducteur
                  </button>
                }
              </div>
            } @else {
              @for (d of filtered(); track d.id) {
                <button type="button" (click)="onPick(d)"
                  class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left
                         bg-transparent hover:bg-bg-tertiary transition-colors cursor-pointer
                         border border-transparent hover:border-border-subtle"
                  [class.dp-row--current]="d.id === currentDriverId()">
                  <span class="dp-avatar"
                        [style.background]="d.color ?? '#10E0A0'">
                    {{ initials(d) }}
                  </span>
                  <span class="flex-1 min-w-0">
                    <p class="text-sm font-semibold text-fg-primary">
                      {{ d.firstName }} {{ d.lastName }}
                    </p>
                    @if (d.licenseNumber) {
                      <p class="text-[10px] text-fg-tertiary mt-0.5 font-mono">
                        {{ d.licenseNumber }}
                      </p>
                    }
                  </span>
                  @if (d.id === currentDriverId()) {
                    <span class="dp-current-badge">Actuel</span>
                  }
                </button>
              }
            }
          </div>

          <!-- Bouton creer en bas de liste -->
          @if (showCreate() && !loading() && drivers().length > 0) {
            <button type="button" (click)="onCreateRequested()"
              class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium
                     text-tracky-light hover:bg-tracky/10 transition-colors cursor-pointer
                     border border-dashed border-tracky/25 hover:border-tracky/40">
              <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon>
              Nouveau conducteur
            </button>
          }

          <!-- Footer -->
          <div class="flex items-center justify-between pt-2 border-t border-border-subtle">
            @if (currentDriverId()) {
              <button type="button" (click)="onPick(null)"
                      class="text-xs font-medium text-red-400 hover:text-red-300
                             flex items-center gap-1 cursor-pointer">
                <lucide-icon [img]="XCircleIcon" [size]="13"></lucide-icon>
                Retirer le conducteur
              </button>
            } @else {
              <span></span>
            }
            <button type="button" (click)="onClose()"
                    class="px-4 py-2 text-sm font-medium rounded-xl
                           bg-bg-tertiary text-fg-secondary border border-border-subtle
                           hover:text-fg-primary transition-colors cursor-pointer">
              Annuler
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .dp-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: white; flex-shrink: 0;
    }
    .dp-current-badge {
      font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 6px;
      background: rgba(16,224,160,.15); color: var(--tracky-light);
      text-transform: uppercase; letter-spacing: .04em;
    }
    .dp-row--current { background: rgba(16,224,160,.05); border-color: rgba(16,224,160,.18) !important }
  `],
})
export class DriverPickerComponent {
  private readonly driversApi = inject(DriversApiService);

  readonly open = input.required<boolean>();
  /** Id du driver actuellement assigne (highlight + bouton retirer). */
  readonly currentDriverId = input<string | null>(null);
  readonly title = input<string | undefined>();
  readonly subtitle = input<string | undefined>();
  readonly closed = output<void>();
  /** Selection : null = retirer, sinon le driver complet. */
  readonly selected = output<DriverDto | null>();
  /** Affiche le bouton "Nouveau conducteur" (desactive pour les VIEWER). */
  readonly showCreate = input(false);
  /** Emis quand l'utilisateur clique "Nouveau conducteur". */
  readonly createRequested = output<void>();

  protected readonly drivers = signal<DriverDto[]>([]);
  protected readonly loading = signal(false);
  protected search = '';

  protected readonly filtered = computed(() => {
    const q = this.search.trim().toLowerCase();
    if (!q) return this.drivers();
    return this.drivers().filter((d) =>
      `${d.firstName} ${d.lastName} ${d.email ?? ''} ${d.licenseNumber ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  });

  protected readonly UserRoundIcon = UserRound;
  protected readonly SearchIcon = Search;
  protected readonly XIcon = X;
  protected readonly XCircleIcon = XCircle;
  protected readonly PlusIcon = Plus;

  /** Charge la liste a chaque ouverture (en cas de creation entre-temps). */
  private fetchEffect = effect(() => {
    if (!this.open()) return;
    this.loading.set(true);
    this.driversApi.list(false)
      .then((list) => this.drivers.set(list))
      .catch(() => this.drivers.set([]))
      .finally(() => this.loading.set(false));
  });

  protected initials(d: DriverDto): string {
    return ((d.firstName?.[0] ?? '') + (d.lastName?.[0] ?? '')).toUpperCase() || '?';
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.open()) this.onClose(); }

  protected onClose(): void { this.closed.emit(); }

  protected onPick(d: DriverDto | null): void {
    this.selected.emit(d);
  }

  protected onCreateRequested(): void {
    this.createRequested.emit();
  }
}
