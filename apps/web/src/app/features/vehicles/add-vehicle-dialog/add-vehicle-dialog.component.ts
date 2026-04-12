import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Truck, Radio, ChevronRight, X, Save, Check } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { TrackersApiService } from '../../../core/services/trackers.service';
import { VehiclesApiService } from '../../../core/services/vehicles.service';
import { VEHICLE_TYPES } from '../../../shared/utils/vehicle-icons';

@Component({
  selector: 'app-add-vehicle-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative w-full max-w-md bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div class="flex items-center gap-3">
              @if (currentStep() === 1) {
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="TruckIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Nouveau vehicule</h2>
                  <p class="text-[10px] text-fg-tertiary">Etape 1 — Informations du vehicule</p>
                </div>
              } @else {
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="RadioIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Assigner un tracker</h2>
                  <p class="text-[10px] text-fg-tertiary">Etape 2 — Tracker GPS</p>
                </div>
              }
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Stepper -->
          <div class="flex items-center px-6 py-3 border-b border-border-subtle bg-bg-secondary">
            <div class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                [class]="currentStep() > 1 ? 'bg-tracky text-white' : 'bg-tracky text-white'">
                @if (currentStep() > 1) {
                  <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon>
                } @else { 1 }
              </span>
              <span class="text-xs font-medium" [class]="currentStep() >= 1 ? 'text-fg-primary' : 'text-fg-tertiary'">Vehicule</span>
            </div>
            <div class="flex-1 h-px bg-border-subtle mx-3"></div>
            <div class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                [class]="currentStep() >= 2 ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-tertiary'">2</span>
              <span class="text-xs font-medium" [class]="currentStep() >= 2 ? 'text-fg-primary' : 'text-fg-tertiary'">Tracker</span>
            </div>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

            <!-- Error -->
            @if (errorMessage()) {
              <div class="p-3 rounded-xl bg-red-600/10 border border-red-600/20 text-red-400 text-sm">
                {{ errorMessage() }}
              </div>
            }

            <!-- Step 1: Vehicle info -->
            @if (currentStep() === 1) {
              <section>
                <p class="section-title">Identification</p>
                <div class="space-y-3">
                  <div>
                    <label class="field-label">Plaque d'immatriculation *</label>
                    <input type="text" [(ngModel)]="plate" placeholder="AB-123-CD" maxlength="20" class="field-input font-mono" />
                  </div>
                </div>
              </section>

              <section>
                <p class="section-title">Type de vehicule</p>
                <div class="type-grid">
                  @for (t of vehicleTypes; track t.key) {
                    <button (click)="vehicleType = t.key" class="type-btn" [class.active]="vehicleType === t.key">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" [innerHTML]="t.svg"></svg>
                      <span>{{ t.label }}</span>
                    </button>
                  }
                </div>
              </section>

              <section>
                <p class="section-title">Details (optionnel)</p>
                <div class="space-y-3">
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="field-label">Marque</label>
                      <input type="text" [(ngModel)]="brand" placeholder="Renault" class="field-input" />
                    </div>
                    <div>
                      <label class="field-label">Modele</label>
                      <input type="text" [(ngModel)]="model" placeholder="Master" class="field-input" />
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="field-label">Annee</label>
                      <input type="number" [(ngModel)]="year" placeholder="2024" min="1950" class="field-input" />
                    </div>
                    <div>
                      <label class="field-label">Couleur</label>
                      <input type="text" [(ngModel)]="color" placeholder="Blanc" class="field-input" />
                    </div>
                  </div>
                </div>
              </section>
            }

            <!-- Step 2: Tracker -->
            @if (currentStep() === 2) {
              <div class="p-3 rounded-xl bg-tracky/8 border border-tracky/20 text-sm text-tracky-light flex items-center gap-2">
                <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon>
                Vehicule <strong class="text-fg-primary mx-1">{{ plate }}</strong> cree avec succes
              </div>

              <section>
                <p class="section-title">Tracker GPS</p>
                <div class="space-y-3">
                  <div>
                    <label class="field-label">IMEI du tracker *</label>
                    <input type="text" [(ngModel)]="imei" placeholder="123456789012345" pattern="\\d{15}" maxlength="15"
                      class="field-input font-mono tracking-wider" />
                    <p class="text-[10px] text-fg-tertiary mt-1">15 chiffres, visible sur l'etiquette du boitier GPS</p>
                  </div>
                  <div>
                    <label class="field-label">Modele du tracker</label>
                    <input type="text" [(ngModel)]="trackerModel" placeholder="Coban GPS403D" class="field-input" />
                  </div>
                </div>
              </section>
            }
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
            <button (click)="onClose()"
              class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle
                     hover:text-fg-primary transition-colors cursor-pointer">
              Annuler
            </button>

            @if (currentStep() === 2) {
              <button (click)="onSkipTracker()"
                class="px-4 py-2.5 text-sm font-medium rounded-xl text-fg-tertiary
                       hover:text-fg-secondary transition-colors cursor-pointer">
                Passer
              </button>
            }

            @if (currentStep() === 1) {
              <button (click)="onSubmitStep1()" [disabled]="isLoading() || !plate.trim()"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                }
                Suivant
                <lucide-icon [img]="ChevronRightIcon" [size]="14"></lucide-icon>
              </button>
            } @else {
              <button (click)="onSubmitStep2()" [disabled]="isLoading() || imei.length !== 15"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                } @else {
                  <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
                }
                Assigner et terminer
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .animate-slide-in { animation: slideIn .25s ease-out }
    @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }
    .section-title { font-size: 10px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px }
    .field-label { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin-bottom: 4px }
    .field-input {
      width: 100%; padding: 10px 14px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle);
      border-radius: 12px; color: var(--fg-primary); font-size: 13px; outline: none; transition: border-color .2s;
    }
    .field-input:focus { border-color: var(--tracky) }
    .field-input::placeholder { color: var(--fg-tertiary) }
    .type-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px }
    .type-btn {
      display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 10px;
      background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); color: var(--fg-tertiary);
      cursor: pointer; transition: all .2s; font-size: 10px; font-weight: 600;
    }
    .type-btn:hover { border-color: var(--border-strong); color: var(--fg-secondary) }
    .type-btn.active { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }
    @media (max-width: 480px) { .type-grid { grid-template-columns: repeat(3, 1fr) } }
  `],
})
export class AddVehicleDialogComponent {
  readonly open = input.required<boolean>();
  readonly created = output<void>();

  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly trackersApi = inject(TrackersApiService);

  protected readonly currentStep = signal(1);
  protected readonly isLoading = signal(false);
  protected readonly errorMessage = signal('');
  private readonly createdVehicleId = signal('');

  protected readonly vehicleTypes = VEHICLE_TYPES;
  protected plate = '';
  protected vehicleType = 'CAR';
  protected brand = '';
  protected model = '';
  protected year: number | undefined;
  protected color = '';
  protected imei = '';
  protected trackerModel = '';

  protected readonly TruckIcon = Truck;
  protected readonly RadioIcon = Radio;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly CheckIcon = Check;

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.isLoading()) this.onClose(); }

  onClose(): void {
    if (this.isLoading()) return;
    this.reset();
    this.created.emit();
  }

  onSkipTracker(): void {
    this.reset();
    this.created.emit();
  }

  async onSubmitStep1(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const data: Record<string, unknown> = { plate: this.plate.trim(), type: this.vehicleType };
      if (this.brand.trim()) data['brand'] = this.brand.trim();
      if (this.model.trim()) data['model'] = this.model.trim();
      if (this.year) data['year'] = this.year;
      if (this.color.trim()) data['color'] = this.color.trim();
      const vehicle = await firstValueFrom(this.vehiclesApi.create(data as any));
      this.createdVehicleId.set(vehicle.id);
      this.currentStep.set(2);
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  async onSubmitStep2(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const tracker = await firstValueFrom(
        this.trackersApi.create({ imei: this.imei.trim(), model: this.trackerModel.trim() || undefined }),
      );
      await firstValueFrom(this.trackersApi.assign(tracker.id, this.createdVehicleId()));
      this.reset();
      this.created.emit();
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  private reset(): void {
    this.currentStep.set(1);
    this.errorMessage.set('');
    this.createdVehicleId.set('');
    this.plate = '';
    this.vehicleType = 'CAR';
    this.brand = '';
    this.model = '';
    this.year = undefined;
    this.color = '';
    this.imei = '';
    this.trackerModel = '';
  }

  private extractError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = err.error?.message;
      return Array.isArray(msg) ? msg.join(', ') : msg ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
