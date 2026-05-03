import { Component, computed, inject } from '@angular/core';
import { LucideAngularModule, Download, Sparkles } from 'lucide-angular';
import { PwaUpdateService } from '../../../core/services/pwa-update.service';

/**
 * Modale bloquante affichee au root des qu'une nouvelle version du SW est prete.
 *
 * Contrairement a une simple notification, l'utilisateur doit cliquer "Mettre a jour"
 * pour pouvoir continuer a utiliser l'app : pas de bouton de fermeture, pas de
 * clic-outside, pas d'escape. Objectif : garantir que la flotte tourne toujours
 * sur la derniere version (criticite metier : trips, alertes, coupure moteur).
 */
@Component({
  selector: 'app-update-required-modal',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (visible()) {
      <div
        class="fixed inset-0 z-[9999] flex items-center justify-center px-4
               animate-[fadeIn_180ms_ease-out]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        aria-describedby="update-modal-desc"
      >
        <!-- Backdrop opaque, pas de clic-outside -->
        <div class="absolute inset-0 bg-black/70 backdrop-blur-md" aria-hidden="true"></div>

        <div
          class="relative w-full max-w-md bg-bg-secondary border border-border-subtle
                 rounded-[--radius-card] p-6 sm:p-7 shadow-2xl
                 animate-[slideUp_220ms_cubic-bezier(0.16,1,0.3,1)]"
        >
          <!-- Halo decoratif tracky -->
          <div
            class="absolute -top-px left-1/2 -translate-x-1/2 h-px w-32
                   bg-gradient-to-r from-transparent via-tracky to-transparent
                   pointer-events-none"
            aria-hidden="true"
          ></div>

          <div class="flex items-start gap-4 mb-5">
            <div
              class="shrink-0 flex items-center justify-center w-12 h-12 rounded-2xl
                     bg-tracky/10 ring-1 ring-tracky/20"
            >
              <lucide-icon
                [img]="Sparkles"
                [size]="24"
                class="text-tracky"
                aria-hidden="true"
              ></lucide-icon>
            </div>
            <div class="flex-1 min-w-0">
              <h2
                id="update-modal-title"
                class="text-lg sm:text-xl font-display font-semibold text-fg-primary"
              >
                Mise a jour disponible
              </h2>
              <p id="update-modal-desc" class="text-sm text-fg-secondary mt-1.5 leading-relaxed">
                Une nouvelle version de Vizyo Tracky est prete. Pour continuer
                avec les dernieres ameliorations et correctifs, l'application
                doit etre rafraichie.
              </p>
            </div>
          </div>

          <button
            type="button"
            (click)="apply()"
            [disabled]="loading()"
            class="w-full inline-flex items-center justify-center gap-2
                   px-4 py-3 rounded-xl text-sm font-semibold text-white
                   bg-tracky hover:bg-tracky-dark active:scale-[0.99]
                   transition-all cursor-pointer
                   disabled:opacity-70 disabled:cursor-progress"
          >
            @if (loading()) {
              <span
                class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                aria-hidden="true"
              ></span>
              Mise a jour en cours...
            } @else {
              <lucide-icon [img]="Download" [size]="18" aria-hidden="true"></lucide-icon>
              Mettre a jour maintenant
            }
          </button>

          <p class="text-xs text-fg-tertiary text-center mt-3">
            L'application va se recharger automatiquement
          </p>
        </div>
      </div>
    }
  `,
  styles: [
    `
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(16px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    `,
  ],
})
export class UpdateRequiredModalComponent {
  private readonly pwa = inject(PwaUpdateService);

  protected readonly visible = computed(() => this.pwa.updateAvailable());
  protected readonly loading = this.pwa.applying;

  protected readonly Download = Download;
  protected readonly Sparkles = Sparkles;

  protected apply(): void {
    void this.pwa.applyUpdate();
  }
}
