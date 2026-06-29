import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, HostListener, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Truck, Radio, ChevronRight, X, Save, Check, Pencil } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { FleetsApiService, type FleetSummary } from '../../../core/services/fleets.service';
import { TrackersApiService } from '../../../core/services/trackers.service';
import { VehiclesApiService } from '../../../core/services/vehicles.service';
import { VEHICLE_TYPES } from '../../../shared/utils/vehicle-icons';
import { VEHICLE_BRANDS } from '../../../shared/utils/vehicle-brands';
import { BrandLogoComponent } from '../../../shared/ui/brand-logo/brand-logo.component';

@Component({
  selector: 'app-vehicle-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, BrandLogoComponent],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative w-full max-w-md max-h-full bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden vd-overlay">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div class="flex items-center gap-3">
              @if (isEditMode()) {
                <div class="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
                  <lucide-icon [img]="PencilIcon" [size]="16" class="text-blue-400"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Modifier le véhicule</h2>
                  <p class="text-[10px] text-fg-tertiary">Modifier les informations du véhicule</p>
                </div>
              } @else if (currentStep() === 1) {
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="TruckIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Nouveau véhicule</h2>
                  <p class="text-[10px] text-fg-tertiary">Étape 1 — Informations du véhicule</p>
                </div>
              } @else {
                <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                  <lucide-icon [img]="RadioIcon" [size]="16" class="text-tracky-light"></lucide-icon>
                </div>
                <div>
                  <h2 class="text-lg font-display font-bold text-fg-primary">Assigner un tracker</h2>
                  <p class="text-[10px] text-fg-tertiary">Étape 2 — Tracker GPS</p>
                </div>
              }
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Stepper (create mode only) -->
          @if (!isEditMode()) {
            <div class="flex items-center px-6 py-3 border-b border-border-subtle bg-bg-secondary">
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                  [class]="currentStep() > 1 ? 'bg-tracky text-white' : 'bg-tracky text-white'">
                  @if (currentStep() > 1) {
                    <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon>
                  } @else { 1 }
                </span>
                <span class="text-xs font-medium" [class]="currentStep() >= 1 ? 'text-fg-primary' : 'text-fg-tertiary'">Véhicule</span>
              </div>
              <div class="flex-1 h-px bg-border-subtle mx-3"></div>
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                  [class]="currentStep() >= 2 ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-tertiary'">2</span>
                <span class="text-xs font-medium" [class]="currentStep() >= 2 ? 'text-fg-primary' : 'text-fg-tertiary'">Tracker</span>
              </div>
            </div>
          }

          <!-- Content -->
          <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">

            <!-- Loading vehicle data (edit mode) -->
            @if (isEditMode() && vehicleLoading()) {
              <div class="flex items-center justify-center gap-2 text-sm text-fg-tertiary py-8">
                <span class="w-5 h-5 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin"></span>
                Chargement du véhicule...
              </div>
            }

            <!-- Error -->
            @if (errorMessage()) {
              <div class="p-3 rounded-xl bg-red-600/10 border border-red-600/20 text-red-400 text-sm">
                {{ errorMessage() }}
              </div>
            }

            <!-- Step 1: Vehicle info (create) or Edit form -->
            @if ((currentStep() === 1 && !isEditMode()) || (isEditMode() && !vehicleLoading())) {
              @if (isSuperAdmin()) {
                <section>
                  <p class="section-title">Flotte</p>
                  @if (fleetsLoading()) {
                    <div class="flex items-center gap-2 text-sm text-fg-tertiary py-2">
                      <span class="w-4 h-4 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin"></span>
                      Chargement des flottes...
                    </div>
                  } @else if (fleetsError()) {
                    <div class="p-3 rounded-xl bg-red-600/10 border border-red-600/20 text-red-400 text-sm">
                      {{ fleetsError() }}
                    </div>
                  } @else if (fleets().length === 0) {
                    <div class="p-3 rounded-xl bg-amber-600/10 border border-amber-600/20 text-amber-400 text-sm">
                      Aucune flotte disponible, créez une flotte d'abord
                    </div>
                  } @else {
                    <div>
                      <label class="field-label">Flotte *</label>
                      <select [(ngModel)]="selectedFleetId" class="field-input">
                        <option value="" disabled>Sélectionnez une flotte</option>
                        @for (f of fleets(); track f.id) {
                          <option [value]="f.id">{{ f.name }}</option>
                        }
                      </select>
                    </div>
                  }
                </section>
              }

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
                <p class="section-title">Type de véhicule</p>
                <div class="type-grid">
                  @for (t of vehicleTypes; track t.key) {
                    <button (click)="vehicleType = t.key" class="type-btn" [class.active]="vehicleType === t.key">
                      <span class="type-icon" [innerHTML]="getSvgHtml(t.svg)"></span>
                      <span>{{ t.label }}</span>
                    </button>
                  }
                </div>
              </section>

              <section>
                <p class="section-title">Détails (optionnel)</p>
                <div class="space-y-3">
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="field-label">Marque</label>
                      <div class="brand-field">
                        <app-brand-logo [brand]="brand" [size]="22" [chip]="true" />
                        <select [(ngModel)]="brand" class="field-input">
                          <option value="">— Sélectionner —</option>
                          @for (b of brandOptions(); track b) {
                            <option [value]="b">{{ b }}</option>
                          }
                        </select>
                      </div>
                    </div>
                    <div>
                      <label class="field-label">Modèle</label>
                      <input type="text" [(ngModel)]="model" placeholder="Master" class="field-input" />
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div>
                      <label class="field-label">Année</label>
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

            <!-- Step 2: Tracker (create mode only) -->
            @if (!isEditMode() && currentStep() === 2) {
              <div class="p-3 rounded-xl bg-tracky/8 border border-tracky/20 text-sm text-tracky-light flex items-center gap-2">
                <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon>
                Véhicule <strong class="text-fg-primary mx-1">{{ plate }}</strong> créé avec succès
              </div>

              <section>
                <p class="section-title">Tracker GPS</p>
                <div class="space-y-3">
                  <div>
                    <label class="field-label">IMEI du tracker *</label>
                    <input type="text" [(ngModel)]="imei" placeholder="123456789012345" pattern="\\d{15}" maxlength="15"
                      class="field-input font-mono tracking-wider" />
                    <p class="text-[10px] text-fg-tertiary mt-1">15 chiffres, visible sur l'étiquette du boîtier GPS</p>
                  </div>
                  <div>
                    <label class="field-label">Modèle du tracker</label>
                    <input type="text" [(ngModel)]="trackerModel" placeholder="Coban GPS403D" class="field-input" />
                  </div>
                  <div>
                    <label class="field-label">N° SIM du boîtier</label>
                    <input type="tel" [(ngModel)]="simPhoneNumber" placeholder="+33612345678" maxlength="16"
                      class="field-input font-mono" />
                    <p class="text-[10px] text-fg-tertiary mt-1">Format international (E.164). Optionnel — requis pour le statut « Installé ».</p>
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

            @if (!isEditMode() && currentStep() === 2) {
              <button (click)="onSkipTracker()"
                class="px-4 py-2.5 text-sm font-medium rounded-xl text-fg-tertiary
                       hover:text-fg-secondary transition-colors cursor-pointer">
                Passer
              </button>
            }

            @if (isEditMode()) {
              <!-- Edit mode: save button -->
              <button (click)="onSubmitEdit()" [disabled]="isLoading() || !plate.trim() || (isSuperAdmin() && !selectedFleetId)"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-blue-600 hover:bg-blue-700 text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                } @else {
                  <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
                }
                Enregistrer
              </button>
            } @else if (currentStep() === 1) {
              <button (click)="onSubmitStep1()" [disabled]="isLoading() || !plate.trim() || (isSuperAdmin() && !selectedFleetId)"
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
    /* iOS PWA standalone : le panneau (flex flex-col) s'etire sinon sur tout le
       fixed inset-0 = plein ecran, et son header passe SOUS le notch / la status
       bar (titre clippe), le footer SOUS le home indicator. On insette l'overlay
       par les safe-areas (top/bottom + lateral pour iPhone paysage) ; combine au
       max-h-full du panneau, header + footer restent visibles. env() = 0 hors iOS
       => additif, aucune regression Android/desktop. */
    .vd-overlay {
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
      border-radius: 12px; color: var(--fg-primary); font-size: 13px; outline: none; transition: border-color .2s;
    }
    .field-input:focus { border-color: var(--tracky) }
    .field-input::placeholder { color: var(--fg-tertiary) }
    select.field-input {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
    }
    select.field-input option { background: #1a1d21; color: #e5e7eb }
    select.field-input option:checked { background: #10b981; color: white }
    .brand-field { display: flex; align-items: center; gap: 8px }
    .brand-field select { flex: 1; min-width: 0 }
    .type-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px }
    .type-btn {
      display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 10px;
      background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); color: var(--fg-tertiary);
      cursor: pointer; transition: all .2s; font-size: 10px; font-weight: 600;
    }
    .type-btn:hover { border-color: var(--border-strong); color: var(--fg-secondary) }
    .type-btn.active { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }
    .type-icon { display: flex; align-items: center; justify-content: center; height: 24px }
    @media (max-width: 480px) { .type-grid { grid-template-columns: repeat(3, 1fr) } }
  `],
})
export class VehicleDialogComponent {
  readonly open = input.required<boolean>();
  readonly mode = input<'create' | 'edit'>('create');
  readonly vehicleId = input<string>('');
  readonly done = output<void>();

  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly authService = inject(AuthService);
  private readonly sanitizer = inject(DomSanitizer);

  protected getSvgHtml(svgContent: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(
      `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${svgContent}</svg>`
    );
  }

  protected readonly isEditMode = computed(() => this.mode() === 'edit');
  protected readonly isSuperAdmin = computed(() => this.authService.user()?.role === 'SUPER_ADMIN');
  protected readonly fleets = signal<FleetSummary[]>([]);
  protected readonly fleetsLoading = signal(false);
  protected readonly fleetsError = signal('');
  protected readonly vehicleLoading = signal(false);
  protected selectedFleetId = '';

  protected readonly currentStep = signal(1);
  protected readonly isLoading = signal(false);
  protected readonly errorMessage = signal('');
  private readonly createdVehicleId = signal('');

  protected readonly vehicleTypes = VEHICLE_TYPES;
  private readonly brandLabels = VEHICLE_BRANDS.map((b) => b.label);

  /**
   * Options de la liste déroulante Marque. Inclut la valeur courante si elle
   * n'est pas dans la liste connue (ex. ancien véhicule saisi en texte libre)
   * pour ne pas la perdre à l'édition.
   */
  protected brandOptions(): string[] {
    const current = this.brand.trim();
    if (current && !this.brandLabels.includes(current)) {
      return [current, ...this.brandLabels];
    }
    return this.brandLabels;
  }

  protected plate = '';
  protected vehicleType = 'CAR';
  protected brand = '';
  protected model = '';
  protected year: number | undefined;
  protected color = '';
  protected imei = '';
  protected trackerModel = '';
  protected simPhoneNumber = '';

  protected readonly TruckIcon = Truck;
  protected readonly RadioIcon = Radio;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly CheckIcon = Check;
  protected readonly PencilIcon = Pencil;

  constructor() {
    effect(() => {
      if (!this.open()) return;

      if (this.isSuperAdmin()) {
        this.loadFleets();
      }

      if (this.isEditMode() && this.vehicleId()) {
        this.loadVehicle(this.vehicleId());
      }
    });
  }

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.isLoading()) this.onClose(); }

  onClose(): void {
    if (this.isLoading()) return;
    this.reset();
    this.done.emit();
  }

  onSkipTracker(): void {
    this.reset();
    this.done.emit();
  }

  private async loadFleets(): Promise<void> {
    this.fleetsLoading.set(true);
    this.fleetsError.set('');
    try {
      const list = await firstValueFrom(this.fleetsApi.list());
      this.fleets.set(list);
      if (!this.isEditMode() && list.length === 1) {
        this.selectedFleetId = list[0].id;
      }
    } catch {
      this.fleetsError.set('Impossible de charger les flottes');
    } finally {
      this.fleetsLoading.set(false);
    }
  }

  private async loadVehicle(id: string): Promise<void> {
    this.vehicleLoading.set(true);
    this.errorMessage.set('');
    try {
      const v = await firstValueFrom(this.vehiclesApi.findOne(id));
      this.plate = v.plate;
      this.vehicleType = v.type;
      this.brand = v.brand ?? '';
      this.model = v.model ?? '';
      this.year = v.year ?? undefined;
      this.color = v.color ?? '';
      this.selectedFleetId = v.fleetId;
    } catch {
      this.errorMessage.set('Impossible de charger le véhicule');
    } finally {
      this.vehicleLoading.set(false);
    }
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
      if (this.selectedFleetId) data['fleetId'] = this.selectedFleetId;
      const vehicle = await firstValueFrom(this.vehiclesApi.create(data as Parameters<VehiclesApiService['create']>[0]));
      this.createdVehicleId.set(vehicle.id);
      this.currentStep.set(2);
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  async onSubmitEdit(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const data: Record<string, unknown> = {
        plate: this.plate.trim(),
        type: this.vehicleType,
      };
      if (this.brand.trim()) data['brand'] = this.brand.trim();
      if (this.model.trim()) data['model'] = this.model.trim();
      if (this.year) data['year'] = this.year;
      if (this.color.trim()) data['color'] = this.color.trim();
      if (this.isSuperAdmin() && this.selectedFleetId) {
        data['fleetId'] = this.selectedFleetId;
      }
      await firstValueFrom(this.vehiclesApi.update(this.vehicleId(), data));
      this.reset();
      this.done.emit();
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  async onSubmitStep2(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      const tracker = await firstValueFrom(
        this.trackersApi.create({
          imei: this.imei.trim(),
          model: this.trackerModel.trim() || undefined,
          simPhoneNumber: this.simPhoneNumber.trim() || undefined,
        }),
      );
      await firstValueFrom(this.trackersApi.assign(tracker.id, this.createdVehicleId()));
      this.reset();
      this.done.emit();
    } catch (err) {
      this.errorMessage.set(this.extractError(err));
    } finally { this.isLoading.set(false); }
  }

  private reset(): void {
    this.currentStep.set(1);
    this.errorMessage.set('');
    this.createdVehicleId.set('');
    this.selectedFleetId = '';
    this.plate = '';
    this.vehicleType = 'CAR';
    this.brand = '';
    this.model = '';
    this.year = undefined;
    this.color = '';
    this.imei = '';
    this.trackerModel = '';
    this.simPhoneNumber = '';
  }

  private extractError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = err.error?.message;
      return Array.isArray(msg) ? msg.join(', ') : msg ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
