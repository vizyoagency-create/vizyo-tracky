import { Component, effect, HostListener, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ScrollLockService } from '../../core/services/scroll-lock.service';
import { LucideAngularModule, IdCard, Mail, Palette, Phone, Save, StickyNote, User, X } from 'lucide-angular';
import type { DriverDto } from '@vizyo/tracky-shared';
import { DrivingScoreCardComponent } from '../trip-analysis/driving-score-card.component';

export interface DriverDrawerData {
  mode: 'create' | 'edit';
  driver?: DriverDto;
}

export interface DriverDrawerResult {
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  licenseNumber?: string | null;
  color?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

/**
 * Phase 2 — Drawer lateral d'edition d'un Conducteur.
 * Clone le pattern user-drawer (animation slide-in + sections + footer fixe).
 *
 * Le compteur de note est volontairement discret (10px) en bas du textarea.
 */
@Component({
  selector: 'app-driver-drawer',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, DrivingScoreCardComponent],
  template: `
    @if (open()) {
      <div class="fixed inset-0 h-[100dvh] z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <!-- Même manque que la modale véhicule, corrigé le 2026-08-17 : le panneau
             n'était pas déclaré comme une modale, donc pas annoncé comme telle. -->
        <div class="relative w-full max-w-md max-h-full bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden drawer-overlay-safe"
             role="dialog" aria-modal="true"
             [attr.aria-label]="data()?.mode === 'create' ? 'Nouveau conducteur' : 'Modifier le conducteur'">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div>
              <h2 class="text-lg font-display font-bold text-fg-primary">
                {{ data()?.mode === 'create' ? 'Nouveau conducteur' : 'Modifier le conducteur' }}
              </h2>
              @if (data()?.mode === 'edit' && data()?.driver) {
                <p class="text-xs text-fg-tertiary mt-0.5">
                  {{ data()!.driver!.firstName }} {{ data()!.driver!.lastName }}
                </p>
              }
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary
                     transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Content (scrollable) -->
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-6">

            <!-- Score de conduite du conducteur (rang + vs moyenne) — motivation. -->
            @if (data()?.mode === 'edit' && data()?.driver) {
              <app-driving-score-card scope="driver" [entityId]="data()!.driver!.id" />
            }

            <!-- Identite -->
            <section>
              <h3 class="section-title">Identite</h3>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="field-label">Prénom *</label>
                  <input type="text" [(ngModel)]="firstName" placeholder="Votre prénom"
                    class="field-input" maxlength="80" />
                </div>
                <div>
                  <label class="field-label">Nom *</label>
                  <input type="text" [(ngModel)]="lastName" placeholder="Votre nom"
                    class="field-input" maxlength="80" />
                </div>
              </div>
            </section>

            <!-- Contact -->
            <section>
              <h3 class="section-title">Contact</h3>
              <div class="space-y-3">
                <div>
                  <label class="field-label">
                    <lucide-icon [img]="PhoneIcon" [size]="11" class="inline mr-1"></lucide-icon>
                    Téléphone
                  </label>
                  <input type="tel" [(ngModel)]="phone" placeholder="+33612345678"
                    class="field-input" maxlength="32" />
                </div>
                <div>
                  <label class="field-label">
                    <lucide-icon [img]="MailIcon" [size]="11" class="inline mr-1"></lucide-icon>
                    Email
                  </label>
                  <input type="email" [(ngModel)]="email" placeholder="prenom.nom&#64;exemple.com"
                    class="field-input" maxlength="255" />
                </div>
              </div>
            </section>

            <!-- Permis + couleur -->
            <section>
              <h3 class="section-title">Identification</h3>
              <div class="space-y-3">
                <div>
                  <label class="field-label">
                    <lucide-icon [img]="IdCardIcon" [size]="11" class="inline mr-1"></lucide-icon>
                    N° de permis
                  </label>
                  <input type="text" [(ngModel)]="licenseNumber" placeholder="12AB34567"
                    class="field-input" maxlength="64" />
                </div>
                <div>
                  <label class="field-label">
                    <lucide-icon [img]="PaletteIcon" [size]="11" class="inline mr-1"></lucide-icon>
                    Couleur (pastille UI)
                  </label>
                  <div class="flex items-center gap-3">
                    <input type="color" [(ngModel)]="color"
                      class="w-12 h-9 rounded-lg border border-border-subtle bg-bg-secondary cursor-pointer" />
                    <input type="text" [(ngModel)]="color"
                      class="field-input flex-1" placeholder="#10E0A0" />
                  </div>
                </div>
              </div>
            </section>

            <!-- Notes -->
            <section>
              <h3 class="section-title">
                <lucide-icon [img]="StickyNoteIcon" [size]="11" class="inline mr-1"></lucide-icon>
                Notes
              </h3>
              <textarea [(ngModel)]="notes" maxlength="500"
                class="field-input min-h-[80px] resize-y"
                placeholder="Infos internes : disponibilités, contrainte horaire, équipement..."
                rows="3"></textarea>
              <div class="text-right mt-1">
                <span class="text-[10px] text-fg-tertiary"
                      [class.text-amber-400]="(notes.length) > 450">
                  {{ notes.length }} / 500
                </span>
              </div>
            </section>

            <!-- Statut (edit only) -->
            @if (data()?.mode === 'edit') {
              <section>
                <h3 class="section-title">Statut</h3>
                <div class="flex items-center justify-between p-3 rounded-xl bg-bg-secondary border border-border-subtle">
                  <span class="text-sm text-fg-secondary">Conducteur actif</span>
                  <label class="toggle">
                    <input type="checkbox" [(ngModel)]="isActive" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
              </section>
            }
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
            @if (error()) {
              <p class="text-xs text-red-400 flex-1">{{ error() }}</p>
            }
            <button (click)="onClose()"
              class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary
                     border border-border-subtle hover:text-fg-primary transition-colors cursor-pointer">
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
              {{ data()?.mode === 'create' ? 'Creer' : 'Enregistrer' }}
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

    .field-label { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin-bottom: 4px }
    .field-input {
      width: 100%; padding: 10px 14px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle);
      border-radius: 12px; color: var(--fg-primary); font-size: 13px;
      outline: none; transition: border-color .2s; font-family: inherit;
    }
    .field-input:focus { border-color: var(--tracky) }
    .field-input::placeholder { color: var(--fg-tertiary) }

    /* .toggle : styles globaux (styles.css) */
  `],
})
export class DriverDrawerComponent {
  readonly open = input.required<boolean>();
  readonly data = input.required<DriverDrawerData | null>();
  readonly loading = input(false);

  // Verrou de scroll : fige la page derrière le drawer tant qu'il est ouvert.
  private readonly scrollLock = inject(ScrollLockService);
  private readonly lockEffect = effect((onCleanup) => {
    if (this.open()) {
      this.scrollLock.lock();
      onCleanup(() => this.scrollLock.unlock());
    }
  });

  readonly closed = output<void>();
  readonly saved = output<DriverDrawerResult>();

  readonly error = signal('');

  // Form fields
  firstName = '';
  lastName = '';
  phone = '';
  email = '';
  licenseNumber = '';
  color = '#10E0A0';
  notes = '';
  isActive = true;

  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly PhoneIcon = Phone;
  protected readonly MailIcon = Mail;
  protected readonly IdCardIcon = IdCard;
  protected readonly PaletteIcon = Palette;
  protected readonly StickyNoteIcon = StickyNote;
  protected readonly UserIcon = User;

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.open() && !this.loading()) this.onClose(); }

  ngOnChanges(): void {
    const d = this.data();
    if (!d) return;
    if (d.mode === 'edit' && d.driver) {
      this.firstName = d.driver.firstName;
      this.lastName = d.driver.lastName;
      this.phone = d.driver.phone ?? '';
      this.email = d.driver.email ?? '';
      this.licenseNumber = d.driver.licenseNumber ?? '';
      this.color = d.driver.color ?? '#10E0A0';
      this.notes = d.driver.notes ?? '';
      this.isActive = d.driver.isActive;
    } else {
      this.firstName = '';
      this.lastName = '';
      this.phone = '';
      this.email = '';
      this.licenseNumber = '';
      this.color = '#10E0A0';
      this.notes = '';
      this.isActive = true;
    }
    this.error.set('');
  }

  onClose(): void {
    this.closed.emit();
  }

  onSave(): void {
    if (!this.firstName.trim() || !this.lastName.trim()) {
      this.error.set('Prenom et nom sont obligatoires.');
      return;
    }
    this.error.set('');
    this.saved.emit({
      firstName: this.firstName.trim(),
      lastName: this.lastName.trim(),
      phone: this.phone.trim() || null,
      email: this.email.trim() || null,
      licenseNumber: this.licenseNumber.trim() || null,
      color: this.color || '#10E0A0',
      notes: this.notes.trim() || null,
      ...(this.data()?.mode === 'edit' ? { isActive: this.isActive } : {}),
    });
  }
}
