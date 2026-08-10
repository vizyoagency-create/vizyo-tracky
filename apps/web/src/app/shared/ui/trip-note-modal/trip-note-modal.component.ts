import { swallow } from '../../../core/error/swallow';
import { Component, HostListener, computed, effect, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, MessageSquare, Save, Trash2, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { TripDto } from '@vizyo/tracky-shared';
import { TripsApiService } from '../../../core/services/trips.service';
import { ToastService } from '../toast/toast.service';

/**
 * Modal centre d'edition de la note d'un trajet. Reutilise depuis :
 *   - Reports (table) — bouton crayon dans la colonne note.
 *   - Trip replay (modal) — bouton crayon dans le header.
 *
 * Le composant possede sa propre logique de save (APIs.updateNote) et emet
 * `(saved)` avec le Trip a jour pour que le parent rafraichisse son etat
 * sans avoir a re-fetch toute la liste.
 */
@Component({
  selector: 'app-trip-note-modal',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9100] flex items-center justify-center"
           role="dialog"
           aria-modal="true">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                    p-5 max-w-md w-full mx-4 shadow-2xl flex flex-col gap-4">

          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center
                        bg-tracky/15 text-tracky-light shrink-0">
              <lucide-icon [img]="MessageSquareIcon" [size]="18"></lucide-icon>
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-base font-display font-semibold text-fg-primary">
                {{ trip()?.notes ? 'Modifier la note' : 'Ajouter une note' }}
              </h3>
              <p class="text-xs text-fg-tertiary mt-0.5">
                Trajet du {{ formatDate(trip()?.startedAt) }}
              </p>
            </div>
            <button type="button" (click)="onClose()"
                    class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary
                           hover:bg-bg-tertiary transition-colors cursor-pointer"
                    aria-label="Fermer">
              <lucide-icon [img]="XIcon" [size]="16"></lucide-icon>
            </button>
          </div>

          <textarea
            class="w-full px-3 py-2.5 bg-bg-tertiary border border-border-subtle
                   rounded-xl text-fg-primary text-sm resize-y min-h-[110px]
                   focus:outline-none focus:border-tracky"
            [(ngModel)]="text"
            [maxlength]="500"
            [disabled]="saving()"
            placeholder="Ex : Dépose Eric au sport, livraison client X, RDV chantier..."
            rows="4"
          ></textarea>

          <div class="flex items-center justify-between gap-2 -mt-1">
            <span class="text-[10px] text-fg-tertiary"
                  [class.text-amber-400]="text.length > 450">
              {{ text.length }} / 500
            </span>
            @if (trip()?.notes) {
              <button type="button"
                      (click)="onClear()"
                      [disabled]="saving()"
                      class="text-xs font-medium text-red-400 hover:text-red-300
                             flex items-center gap-1 cursor-pointer disabled:opacity-50">
                <lucide-icon [img]="Trash2Icon" [size]="12"></lucide-icon>
                Supprimer la note
              </button>
            }
          </div>

          <div class="flex items-center justify-end gap-2 pt-1">
            <button type="button" (click)="onClose()"
                    [disabled]="saving()"
                    class="px-4 py-2 text-sm font-medium rounded-xl
                           bg-bg-tertiary text-fg-secondary border border-border-subtle
                           hover:text-fg-primary transition-colors cursor-pointer
                           disabled:opacity-50">
              Annuler
            </button>
            <button type="button" (click)="onSave()"
                    [disabled]="saving() || !canSave()"
                    class="px-4 py-2 text-sm font-medium rounded-xl text-white
                           bg-tracky hover:bg-tracky-dark transition-colors cursor-pointer
                           disabled:opacity-50 flex items-center gap-2">
              @if (saving()) {
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
})
export class TripNoteModalComponent {
  private readonly tripsApi = inject(TripsApiService);
  private readonly toast = inject(ToastService);

  readonly open = input.required<boolean>();
  readonly trip = input<TripDto | null>(null);
  readonly closed = output<void>();
  readonly saved = output<TripDto>();

  protected text = '';
  protected readonly saving = signal(false);
  protected readonly canSave = computed(() => true); // toujours ok (vide = clear)

  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly SaveIcon = Save;
  protected readonly Trash2Icon = Trash2;
  protected readonly XIcon = X;

  /**
   * Initialise le textarea avec la note existante a chaque ouverture.
   * effect() => garantit la sync en cas de re-clic sur un autre trip.
   */
  private syncEffect = effect(() => {
    if (this.open()) {
      this.text = this.trip()?.notes ?? '';
    }
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open() && !this.saving()) this.onClose();
  }

  onClose(): void {
    this.closed.emit();
  }

  protected formatDate(iso?: string | null): string {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('fr-FR', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }

  protected async onSave(): Promise<void> {
    const t = this.trip();
    if (!t) return;
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.tripsApi.updateNote(t.id, this.text.trim() || null),
      );
      this.saved.emit(updated);
      this.toast.success('Note enregistrée');
      this.closed.emit();
    } catch (err) {
      swallow('trip-note-modal:onSave', err);
      const msg = err instanceof HttpErrorResponse
        ? err.error?.message ?? 'Erreur inconnue'
        : err instanceof Error ? err.message : 'Erreur inconnue';
      this.toast.error('Échec enregistrement note', msg);
    } finally {
      this.saving.set(false);
    }
  }

  /** Vide la note (= efface cote backend, set notes a null). */
  protected async onClear(): Promise<void> {
    const t = this.trip();
    if (!t) return;
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(this.tripsApi.updateNote(t.id, null));
      this.saved.emit(updated);
      this.toast.success('Note supprimée');
      this.closed.emit();
    } catch (err) {
      swallow('trip-note-modal:onClear', err);
      const msg = err instanceof HttpErrorResponse
        ? err.error?.message ?? 'Erreur inconnue'
        : err instanceof Error ? err.message : 'Erreur inconnue';
      this.toast.error('Échec suppression note', msg);
    } finally {
      this.saving.set(false);
    }
  }
}
