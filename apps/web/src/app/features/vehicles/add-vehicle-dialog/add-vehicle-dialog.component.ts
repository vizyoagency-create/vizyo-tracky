import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Truck, Radio, ChevronRight, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { TrackersApiService } from '../../../core/services/trackers.service';
import { VehiclesApiService } from '../../../core/services/vehicles.service';

@Component({
  selector: 'app-add-vehicle-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                    p-6 max-w-lg w-full mx-4 shadow-2xl">

          <!-- Header -->
          <div class="flex items-center justify-between mb-6">
            <div class="flex items-center gap-3">
              @if (currentStep() === 1) {
                <lucide-icon [img]="Truck" [size]="20" class="text-tracky-light"></lucide-icon>
                <h3 class="text-lg font-display font-semibold text-fg-primary">Nouveau vehicule</h3>
              } @else {
                <lucide-icon [img]="RadioIcon" [size]="20" class="text-tracky-light"></lucide-icon>
                <h3 class="text-lg font-display font-semibold text-fg-primary">Assigner un tracker</h3>
              }
            </div>
            <button (click)="onClose()" class="text-fg-tertiary hover:text-fg-primary cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Stepper indicator -->
          <div class="flex items-center gap-2 mb-6">
            <div class="flex items-center gap-2 flex-1">
              <span class="w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center"
                    [class]="currentStep() >= 1 ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-tertiary'">1</span>
              <span class="text-xs" [class]="currentStep() >= 1 ? 'text-fg-primary' : 'text-fg-tertiary'">Vehicule</span>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="14" class="text-fg-tertiary"></lucide-icon>
            <div class="flex items-center gap-2 flex-1">
              <span class="w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center"
                    [class]="currentStep() >= 2 ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-tertiary'">2</span>
              <span class="text-xs" [class]="currentStep() >= 2 ? 'text-fg-primary' : 'text-fg-tertiary'">Tracker</span>
            </div>
          </div>

          <!-- Error -->
          @if (errorMessage()) {
            <div class="mb-4 p-3 rounded-lg bg-red-600/10 border border-red-600/20 text-red-400 text-sm">
              {{ errorMessage() }}
            </div>
          }

          <!-- Step 1: Vehicle -->
          @if (currentStep() === 1) {
            <form (ngSubmit)="onSubmitStep1()" class="flex flex-col gap-4">
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg-secondary">Plaque d'immatriculation *</label>
                <input type="text" [(ngModel)]="plate" name="plate" required maxlength="20"
                       placeholder="AB-123-CD"
                       class="input-tracky" />
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1.5">
                  <label class="text-sm font-medium text-fg-secondary">Marque</label>
                  <input type="text" [(ngModel)]="brand" name="brand" placeholder="Renault" class="input-tracky" />
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-sm font-medium text-fg-secondary">Modele</label>
                  <input type="text" [(ngModel)]="model" name="model" placeholder="Master" class="input-tracky" />
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1.5">
                  <label class="text-sm font-medium text-fg-secondary">Annee</label>
                  <input type="number" [(ngModel)]="year" name="year" placeholder="2024" min="1950" class="input-tracky" />
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-sm font-medium text-fg-secondary">Couleur</label>
                  <input type="text" [(ngModel)]="color" name="color" placeholder="Blanc" class="input-tracky" />
                </div>
              </div>
              <div class="flex justify-end gap-3 mt-2">
                <button type="button" (click)="onClose()"
                        class="px-4 py-2 text-sm rounded-xl bg-bg-tertiary text-fg-secondary
                               border border-border-subtle hover:text-fg-primary transition-colors cursor-pointer">
                  Annuler
                </button>
                <button type="submit" [disabled]="isLoading() || !plate.trim()"
                        class="px-4 py-2 text-sm font-medium rounded-xl text-white
                               bg-tracky hover:bg-tracky-dark transition-colors cursor-pointer
                               disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                  @if (isLoading()) {
                    <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  }
                  Suivant
                  <lucide-icon [img]="ChevronRight" [size]="16"></lucide-icon>
                </button>
              </div>
            </form>
          }

          <!-- Step 2: Tracker -->
          @if (currentStep() === 2) {
            <form (ngSubmit)="onSubmitStep2()" class="flex flex-col gap-4">
              <p class="text-sm text-fg-tertiary">
                Vehicule <strong class="text-fg-primary">{{ plate }}</strong> cree avec succes.
                Assignez maintenant un tracker GPS.
              </p>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg-secondary">IMEI du tracker *</label>
                <input type="text" [(ngModel)]="imei" name="imei" required
                       pattern="\\d{15}" maxlength="15"
                       placeholder="123456789012345"
                       class="input-tracky font-mono" />
                <p class="text-[10px] text-fg-tertiary">Exactement 15 chiffres, visible sur l'etiquette du boitier</p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg-secondary">Modele du tracker</label>
                <input type="text" [(ngModel)]="trackerModel" name="trackerModel"
                       placeholder="Coban GPS403D"
                       class="input-tracky" />
              </div>
              <div class="flex justify-end gap-3 mt-2">
                <button type="button" disabled
                        class="px-4 py-2 text-sm rounded-xl bg-bg-tertiary text-fg-tertiary
                               border border-border-subtle opacity-50 cursor-not-allowed">
                  Precedent
                </button>
                <button type="submit" [disabled]="isLoading() || imei.length !== 15"
                        class="px-4 py-2 text-sm font-medium rounded-xl text-white
                               bg-tracky hover:bg-tracky-dark transition-colors cursor-pointer
                               disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                  @if (isLoading()) {
                    <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  }
                  Assigner et terminer
                </button>
              </div>
            </form>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .input-tracky {
      width: 100%;
      padding: 0.625rem 1rem;
      border-radius: 0.75rem;
      background: var(--surface-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .input-tracky::placeholder { color: var(--text-tertiary); }
    .input-tracky:focus { border-color: var(--color-tracky); }
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

  protected plate = '';
  protected brand = '';
  protected model = '';
  protected year: number | undefined;
  protected color = '';
  protected imei = '';
  protected trackerModel = '';

  protected readonly Truck = Truck;
  protected readonly RadioIcon = Radio;
  protected readonly ChevronRight = ChevronRight;
  protected readonly XIcon = X;

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open() && !this.isLoading()) this.onClose();
  }

  onClose(): void {
    if (this.isLoading()) return;
    this.reset();
    this.created.emit();
  }

  async onSubmitStep1(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const data: Record<string, unknown> = { plate: this.plate.trim() };
      if (this.brand.trim()) data['brand'] = this.brand.trim();
      if (this.model.trim()) data['model'] = this.model.trim();
      if (this.year) data['year'] = this.year;
      if (this.color.trim()) data['color'] = this.color.trim();

      const vehicle = await firstValueFrom(this.vehiclesApi.create(data as any));
      this.createdVehicleId.set(vehicle.id);
      this.currentStep.set(2);
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  async onSubmitStep2(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const tracker = await firstValueFrom(
        this.trackersApi.create({
          imei: this.imei.trim(),
          model: this.trackerModel.trim() || undefined,
        }),
      );
      await firstValueFrom(
        this.trackersApi.assign(tracker.id, this.createdVehicleId()),
      );
      this.reset();
      this.created.emit();
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  private reset(): void {
    this.currentStep.set(1);
    this.errorMessage.set('');
    this.createdVehicleId.set('');
    this.plate = '';
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
