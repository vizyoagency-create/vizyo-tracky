import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  Component,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, MapPin, X } from 'lucide-angular';
import * as L from 'leaflet';
import { firstValueFrom } from 'rxjs';
import { GeofencesApiService } from '../../../core/services/geofences.service';

const RADIUS_STEPS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];

@Component({
  selector: 'app-geofence-draw-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>
        <div class="relative bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                    max-w-2xl w-full mx-4 shadow-2xl overflow-hidden">

          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div class="flex items-center gap-2">
              <lucide-icon [img]="MapPin" [size]="20" class="text-tracky-light"></lucide-icon>
              <h3 class="text-lg font-display font-semibold text-fg-primary">
                {{ currentStep() === 1 ? 'Nouvelle geofence' : 'Dessiner la zone' }}
              </h3>
            </div>
            <button (click)="onClose()" class="text-fg-tertiary hover:text-fg-primary cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          @if (errorMessage()) {
            <div class="mx-6 mt-4 p-3 rounded-lg bg-red-600/10 border border-red-600/20 text-red-400 text-sm">
              {{ errorMessage() }}
            </div>
          }

          @if (currentStep() === 1) {
            <form (ngSubmit)="goToStep2()" class="p-6 flex flex-col gap-4">
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg-secondary">Nom de la zone *</label>
                <input type="text" [(ngModel)]="name" name="name" required placeholder="Ex: Depot central"
                       class="input-tracky" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg-secondary">Regle de declenchement</label>
                <div class="flex gap-2">
                  @for (r of rules; track r.value) {
                    <button type="button" (click)="rule = r.value"
                            class="flex-1 px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer"
                            [class]="rule === r.value
                              ? 'bg-tracky/20 text-tracky-light border-tracky/30'
                              : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
                      {{ r.label }}
                    </button>
                  }
                </div>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg-secondary">Couleur</label>
                <input type="color" [(ngModel)]="color" name="color" class="w-12 h-8 rounded cursor-pointer border-0" />
              </div>
              <div class="flex justify-end gap-3 mt-2">
                <button type="button" (click)="onClose()"
                        class="px-4 py-2 text-sm rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle cursor-pointer">
                  Annuler
                </button>
                <button type="submit" [disabled]="!name.trim()"
                        class="px-4 py-2 text-sm font-medium rounded-xl text-white bg-tracky hover:bg-tracky-dark
                               transition-colors cursor-pointer disabled:opacity-50">
                  Suivant — placer sur la carte
                </button>
              </div>
            </form>
          }

          @if (currentStep() === 2) {
            <div class="flex flex-col">
              <div class="px-6 py-3 text-sm text-fg-tertiary">
                Cliquez sur la carte pour placer le centre, puis ajustez le rayon.
              </div>
              <div #mapContainer style="height:400px;width:100%"></div>
              <div class="px-6 py-4 flex items-center gap-4">
                <label class="text-sm text-fg-secondary shrink-0">Rayon :</label>
                <input type="range" [min]="0" [max]="RADIUS_STEPS.length - 1" [step]="1"
                       [(ngModel)]="radiusIndex" name="radius"
                       class="flex-1 accent-[var(--color-tracky)]" />
                <div class="flex items-center gap-1">
                  <input type="number" [(ngModel)]="radiusMeters" name="radiusNum" min="50" max="5000"
                         class="w-20 px-2 py-1 text-sm rounded-lg bg-bg-tertiary border border-border-subtle text-fg-primary text-center" />
                  <span class="text-xs text-fg-tertiary">m</span>
                </div>
              </div>
              <div class="px-6 pb-4 flex justify-end gap-3">
                <button (click)="currentStep.set(1)"
                        class="px-4 py-2 text-sm rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle cursor-pointer">
                  Precedent
                </button>
                <button (click)="onSubmit()" [disabled]="isLoading() || !center"
                        class="px-4 py-2 text-sm font-medium rounded-xl text-white bg-tracky hover:bg-tracky-dark
                               transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-2">
                  @if (isLoading()) {
                    <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  }
                  Creer la geofence
                </button>
              </div>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .input-tracky {
      width: 100%; padding: 0.625rem 1rem; border-radius: 0.75rem;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
      color: var(--text-primary); font-size: 0.875rem; outline: none;
    }
    .input-tracky::placeholder { color: var(--text-tertiary); }
    .input-tracky:focus { border-color: var(--color-tracky); }
    @keyframes tracky-ping { 75%, 100% { transform: scale(2); opacity: 0; } }
  `],
})
export class GeofenceDrawDialogComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly created = output<void>();

  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');

  protected readonly currentStep = signal(1);
  protected readonly isLoading = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly MapPin = MapPin;
  protected readonly XIcon = X;
  protected readonly RADIUS_STEPS = RADIUS_STEPS;

  protected name = '';
  protected rule: 'ENTER' | 'EXIT' | 'BOTH' = 'BOTH';
  protected color = '#10e0a0';
  protected center: L.LatLng | null = null;

  protected readonly rules = [
    { value: 'ENTER' as const, label: 'Entree' },
    { value: 'EXIT' as const, label: 'Sortie' },
    { value: 'BOTH' as const, label: 'Les deux' },
  ];

  private map: L.Map | null = null;
  private circle: L.Circle | null = null;
  private marker: L.Marker | null = null;

  private radiusEffect = effect(() => {
    const idx = this.radiusIndex;
    // Sync slider→number when slider moves
  });

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.isLoading()) this.onClose(); }

  ngAfterViewInit(): void {
    // Map is initialized when step 2 is shown
  }

  ngOnDestroy(): void {
    this.destroyMap();
  }

  protected goToStep2(): void {
    this.currentStep.set(2);
    setTimeout(() => this.initMap(), 50);
  }

  protected onClose(): void {
    if (this.isLoading()) return;
    this.reset();
    this.created.emit();
  }

  protected get radiusIndex(): number {
    return this._radiusIndex;
  }
  protected set radiusIndex(v: number) {
    this._radiusIndex = v;
    this.radiusMeters = RADIUS_STEPS[v] ?? 500;
    this.updateCircle();
  }
  private _radiusIndex = 4;

  protected get radiusMeters(): number {
    return this._radiusMeters;
  }
  protected set radiusMeters(v: number) {
    this._radiusMeters = Math.max(50, Math.min(5000, v));
    const closest = RADIUS_STEPS.reduce((prev, curr, i) =>
      Math.abs(curr - this._radiusMeters) < Math.abs(RADIUS_STEPS[prev]! - this._radiusMeters) ? i : prev, 0);
    this._radiusIndex = closest;
    this.updateCircle();
  }
  private _radiusMeters = 500;

  protected async onSubmit(): Promise<void> {
    if (!this.center) return;
    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      await firstValueFrom(this.geofencesApi.create({
        name: this.name.trim(),
        centerLat: this.center.lat,
        centerLng: this.center.lng,
        radiusMeters: this._radiusMeters,
        rule: this.rule,
        color: this.color,
      }));
      this.reset();
      this.created.emit();
    } catch (err) {
      this.errorMessage.set(
        err instanceof HttpErrorResponse
          ? (Array.isArray(err.error?.message) ? err.error.message.join(', ') : err.error?.message ?? 'Erreur')
          : String(err),
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  private initMap(): void {
    const el = this.mapRef()?.nativeElement;
    if (!el || this.map) return;

    this.map = L.map(el, { center: [33.5731, -7.5898], zoom: 12, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.center = e.latlng;
      if (this.marker) {
        this.marker.setLatLng(e.latlng);
      } else {
        this.marker = L.marker(e.latlng).addTo(this.map!);
      }
      this.updateCircle();
    });

    setTimeout(() => this.map?.invalidateSize(), 100);
  }

  private updateCircle(): void {
    if (!this.map || !this.center) return;
    if (this.circle) {
      this.circle.setLatLng(this.center);
      this.circle.setRadius(this._radiusMeters);
      this.circle.setStyle({ color: this.color, fillColor: this.color });
    } else {
      this.circle = L.circle(this.center, {
        radius: this._radiusMeters,
        color: this.color,
        fillColor: this.color,
        fillOpacity: 0.2,
        weight: 2,
      }).addTo(this.map);
    }
  }

  private destroyMap(): void {
    this.marker?.remove();
    this.circle?.remove();
    if (this.map) { this.map.remove(); this.map = null; }
    this.marker = null;
    this.circle = null;
  }

  private reset(): void {
    this.destroyMap();
    this.currentStep.set(1);
    this.errorMessage.set('');
    this.name = '';
    this.rule = 'BOTH';
    this.color = '#10e0a0';
    this._radiusMeters = 500;
    this._radiusIndex = 4;
    this.center = null;
  }
}
