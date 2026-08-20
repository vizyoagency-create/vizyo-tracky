import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { GpsZoneDiagnosticDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { CheckCheck, LucideAngularModule, MapPin, RotateCcw, SatelliteDish } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { GpsDiagnosticApiService } from '../../core/services/gps-diagnostic.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Qualité GPS — les zones mortes diagnostiquées.
 *
 * Ce que cet écran apporte, et qui n'existait nulle part : la réponse à « est-ce le LIEU ou le
 * BOÎTIER ? ». Les zones de perte sont apprises par véhicule ; il fallait les croiser entre
 * véhicules pour trancher. Un boîtier mis en cause part au centre d'alerte, pas ici : une panne
 * matérielle demande une action datée, un lieu mal couvert demande une qualification durable.
 *
 * Pensé pour 375 px : une carte par diagnostic, le constat en clair, la recommandation dessous.
 */
@Component({
  selector: 'app-gps-diagnostics',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="p-4 space-y-4 max-w-3xl mx-auto">
      <header class="space-y-1">
        <h1 class="text-lg font-semibold text-fg-primary flex items-center gap-2">
          <lucide-icon [img]="SatelliteDish" [size]="18" class="text-tracky-light" />
          Qualité GPS — zones mortes
        </h1>
        <p class="text-xs text-fg-tertiary">
          Endroits où plusieurs véhicules perdent le signal. Un boîtier mis en cause part au centre
          d'alerte, pas ici.
        </p>
      </header>

      <div class="flex items-center justify-between gap-2">
        <button type="button" (click)="basculer()"
                class="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-1.5 text-xs
                       text-fg-secondary hover:text-fg-primary transition-colors">
          {{ tous() ? 'Masquer les traités' : 'Afficher les traités' }}
        </button>
        <span class="text-xs text-fg-tertiary">{{ liste().length }} diagnostic(s)</span>
      </div>

      @if (liste().length === 0) {
        <p class="rounded-lg border border-border-subtle bg-bg-secondary p-4 text-sm text-fg-tertiary">
          Aucune zone morte diagnostiquée. L'agent tourne la nuit&nbsp;; il ne conclut que
          lorsqu'au moins deux véhicules perdent le signal au même endroit.
        </p>
      }

      <ul class="space-y-3">
        @for (z of liste(); track z.id) {
          <li class="rounded-lg border bg-bg-secondary p-3 space-y-2"
              [class]="z.traiteAt ? 'border-border-subtle opacity-70' : 'border-border-strong'">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-sm text-fg-primary flex items-center gap-1.5">
                  <lucide-icon [img]="MapPin" [size]="14" class="text-fg-tertiary shrink-0" />
                  <span class="truncate">{{ z.placeLabel || 'Lieu non nommé' }}</span>
                </p>
                <p class="text-xs text-fg-tertiary truncate">
                  {{ z.fleetName }} · {{ z.vehicules.join(', ') }}
                </p>
              </div>
              @if (z.traiteAt) {
                <lucide-icon [img]="CheckCheck" [size]="15" class="text-texte-succes shrink-0" />
              }
            </div>

            <p class="text-sm text-fg-secondary">{{ z.constat }}</p>
            <p class="text-xs text-fg-tertiary">{{ z.recommandation }}</p>

            <p class="text-xs text-fg-tertiary">
              {{ z.episodes }} épisode(s) · {{ z.lat.toFixed(4) }}, {{ z.lng.toFixed(4) }}
            </p>

            @if (z.traiteAt) {
              <div class="rounded border border-border-subtle bg-bg-tertiary p-2 space-y-1">
                <p class="text-xs text-fg-tertiary">Traité par {{ z.traiteParEmail }}</p>
                @if (z.note) { <p class="text-xs text-fg-secondary">{{ z.note }}</p> }
                <button type="button" (click)="rouvrir(z)" [disabled]="occupe()"
                        class="inline-flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-fg-secondary disabled:opacity-40">
                  <lucide-icon [img]="RotateCcw" [size]="12" />
                  Rouvrir
                </button>
              </div>
            } @else {
              <div class="space-y-2 border-t border-border-subtle pt-2">
                <label [attr.for]="'note-' + z.id" class="text-xs text-fg-tertiary">
                  Ce qui a été constaté sur place (ou pourquoi on classe sans suite)
                </label>
                <textarea [attr.id]="'note-' + z.id" rows="2" [(ngModel)]="notes[z.id]" [disabled]="occupe()"
                          class="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm
                                 text-fg-primary placeholder:text-fg-tertiary focus:outline-none
                                 focus:border-border-strong disabled:opacity-40"></textarea>
                <button type="button" (click)="traiter(z)" [disabled]="occupe()"
                        class="w-full inline-flex items-center justify-center gap-2 rounded-lg border
                               border-border-subtle bg-bg-tertiary px-3 py-2 text-sm text-fg-secondary
                               hover:text-fg-primary transition-colors disabled:opacity-40">
                  <lucide-icon [img]="CheckCheck" [size]="14" />
                  Marquer traité
                </button>
              </div>
            }
          </li>
        }
      </ul>
    </div>
  `,
})
export class GpsDiagnosticsComponent implements OnInit {
  private readonly api = inject(GpsDiagnosticApiService);
  private readonly toast = inject(ToastService);

  protected readonly CheckCheck = CheckCheck;
  protected readonly MapPin = MapPin;
  protected readonly RotateCcw = RotateCcw;
  protected readonly SatelliteDish = SatelliteDish;

  protected readonly liste = signal<GpsZoneDiagnosticDto[]>([]);
  protected readonly tous = signal(false);
  protected readonly occupe = signal(false);
  protected notes: Record<string, string> = {};

  async ngOnInit(): Promise<void> {
    await this.charger();
  }

  private async charger(): Promise<void> {
    try {
      this.liste.set(await firstValueFrom(this.api.zones(this.tous())));
    } catch (err) {
      swallow('gps-diagnostics:charger', err);
    }
  }

  protected async basculer(): Promise<void> {
    this.tous.set(!this.tous());
    await this.charger();
  }

  protected async traiter(z: GpsZoneDiagnosticDto): Promise<void> {
    this.occupe.set(true);
    try {
      await firstValueFrom(this.api.traiter(z.id, { note: (this.notes[z.id] ?? '').trim() || undefined }));
      this.toast.success('Diagnostic traité');
      await this.charger();
    } catch (err) {
      swallow('gps-diagnostics:traiter', err);
      this.toast.error('Enregistrement impossible');
    } finally {
      this.occupe.set(false);
    }
  }

  protected async rouvrir(z: GpsZoneDiagnosticDto): Promise<void> {
    this.occupe.set(true);
    try {
      await firstValueFrom(this.api.traiter(z.id, { traite: false }));
      await this.charger();
    } catch (err) {
      swallow('gps-diagnostics:rouvrir', err);
      this.toast.error('Réouverture impossible');
    } finally {
      this.occupe.set(false);
    }
  }
}
