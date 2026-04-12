import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit, Component, effect, ElementRef, HostListener,
  inject, input, OnDestroy, output, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, MapPin, X, ChevronRight, Check, Save } from 'lucide-angular';
import * as L from 'leaflet';
import { firstValueFrom } from 'rxjs';
import { GeofencesApiService } from '../../../core/services/geofences.service';
import { PreferencesService } from '../../../core/services/preferences.service';

const RADIUS_STEPS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];

@Component({
  selector: 'app-geofence-draw-dialog',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex justify-end">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative bg-bg-primary border-l border-border-subtle shadow-2xl
                    flex flex-col animate-slide-in overflow-hidden"
             [style.width]="currentStep() === 2 ? '600px' : '420px'"
             style="max-width:95vw; transition: width .3s ease">

          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                <lucide-icon [img]="MapPinIcon" [size]="16" class="text-tracky-light"></lucide-icon>
              </div>
              <div>
                <h2 class="text-lg font-display font-bold text-fg-primary">
                  {{ currentStep() === 1 ? 'Nouvelle geofence' : 'Placer sur la carte' }}
                </h2>
                <p class="text-[10px] text-fg-tertiary">Etape {{ currentStep() }} sur 2</p>
              </div>
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
                @if (currentStep() > 1) { <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> } @else { 1 }
              </span>
              <span class="text-xs font-medium text-fg-primary">Informations</span>
            </div>
            <div class="flex-1 h-px bg-border-subtle mx-3"></div>
            <div class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                [class]="currentStep() >= 2 ? 'bg-tracky text-white' : 'bg-bg-tertiary text-fg-tertiary'">2</span>
              <span class="text-xs font-medium" [class]="currentStep() >= 2 ? 'text-fg-primary' : 'text-fg-tertiary'">Carte</span>
            </div>
          </div>

          @if (errorMessage()) {
            <div class="mx-6 mt-4 p-3 rounded-xl bg-red-600/10 border border-red-600/20 text-red-400 text-sm">
              {{ errorMessage() }}
            </div>
          }

          <!-- Step 1 -->
          @if (currentStep() === 1) {
            <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <section>
                <p class="section-title">Zone</p>
                <div>
                  <label class="field-label">Nom de la zone *</label>
                  <input type="text" [(ngModel)]="name" placeholder="Ex: Depot central" class="field-input" />
                </div>
              </section>
              <section>
                <p class="section-title">Regle de declenchement</p>
                <div class="flex gap-2">
                  @for (r of rules; track r.value) {
                    <button (click)="rule = r.value" class="rule-btn" [class.active]="rule === r.value">{{ r.label }}</button>
                  }
                </div>
              </section>
              <section>
                <p class="section-title">Couleur</p>
                <div class="flex items-center gap-3">
                  @for (c of presetColors; track c) {
                    <button (click)="color = c" class="color-btn" [style.background]="c" [class.active]="color === c"></button>
                  }
                  <input type="color" [(ngModel)]="color" class="w-8 h-8 rounded-lg cursor-pointer border-0" />
                </div>
              </section>
            </div>
          }

          <!-- Step 2: Map -->
          @if (currentStep() === 2) {
            <div class="px-6 py-3 text-xs text-fg-tertiary border-b border-border-subtle">
              Cliquez sur la carte pour placer le centre, puis ajustez le rayon.
            </div>
            <div #mapContainer class="flex-1" style="min-height:300px"></div>
            <div class="px-6 py-3 border-t border-border-subtle flex items-center gap-4">
              <label class="text-xs text-fg-tertiary shrink-0 font-semibold">RAYON</label>
              <input type="range" [min]="0" [max]="RADIUS_STEPS.length - 1" [step]="1"
                     [(ngModel)]="radiusIndex" class="flex-1 accent-[var(--tracky)]" />
              <div class="flex items-center gap-1">
                <input type="number" [(ngModel)]="radiusMeters" min="50" max="5000"
                       class="w-16 px-2 py-1 text-xs rounded-lg bg-bg-tertiary border border-border-subtle text-fg-primary text-center font-mono" />
                <span class="text-[10px] text-fg-tertiary">m</span>
              </div>
            </div>
          }

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
            @if (currentStep() === 2) {
              <button (click)="currentStep.set(1)"
                class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle
                       hover:text-fg-primary transition-colors cursor-pointer">
                Precedent
              </button>
            } @else {
              <button (click)="onClose()"
                class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle
                       hover:text-fg-primary transition-colors cursor-pointer">
                Annuler
              </button>
            }

            @if (currentStep() === 1) {
              <button (click)="goToStep2()" [disabled]="!name.trim()"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                Placer sur la carte
                <lucide-icon [img]="ChevronRightIcon" [size]="14"></lucide-icon>
              </button>
            } @else {
              <button (click)="onSubmit()" [disabled]="isLoading() || !center"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                } @else {
                  <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
                }
                Creer la geofence
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
    .rule-btn {
      flex: 1; padding: 10px; border-radius: 12px; font-size: 12px; font-weight: 600; text-align: center;
      background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; transition: all .2s;
    }
    .rule-btn:hover { border-color: var(--border-strong) }
    .rule-btn.active { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }
    .color-btn {
      width: 28px; height: 28px; border-radius: 8px; border: 2px solid transparent; cursor: pointer; transition: all .2s;
    }
    .color-btn:hover { transform: scale(1.1) }
    .color-btn.active { border-color: white; box-shadow: 0 0 0 2px var(--tracky) }
    @keyframes tracky-ping { 75%, 100% { transform: scale(2); opacity: 0; } }
  `],
})
export class GeofenceDrawDialogComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly created = output<void>();

  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly preferences = inject(PreferencesService);
  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');

  protected readonly currentStep = signal(1);
  protected readonly isLoading = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly MapPinIcon = MapPin;
  protected readonly XIcon = X;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly CheckIcon = Check;
  protected readonly SaveIcon = Save;
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

  protected readonly presetColors = ['#10e0a0', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#ec4899'];

  private map: L.Map | null = null;
  private circle: L.Circle | null = null;
  private marker: L.Marker | null = null;

  private radiusEffect = effect(() => { void this.radiusIndex; });

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open() && !this.isLoading()) this.onClose(); }

  ngAfterViewInit(): void {}
  ngOnDestroy(): void { this.destroyMap(); }

  protected goToStep2(): void {
    this.currentStep.set(2);
    setTimeout(() => this.initMap(), 50);
  }

  protected onClose(): void {
    if (this.isLoading()) return;
    this.reset();
    this.created.emit();
  }

  protected get radiusIndex(): number { return this._radiusIndex; }
  protected set radiusIndex(v: number) {
    this._radiusIndex = v;
    this.radiusMeters = RADIUS_STEPS[v] ?? 500;
    this.updateCircle();
  }
  private _radiusIndex = 4;

  protected get radiusMeters(): number { return this._radiusMeters; }
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
        name: this.name.trim(), centerLat: this.center.lat, centerLng: this.center.lng,
        radiusMeters: this._radiusMeters, rule: this.rule, color: this.color,
      }));
      this.reset();
      this.created.emit();
    } catch (err) {
      this.errorMessage.set(
        err instanceof HttpErrorResponse
          ? (Array.isArray(err.error?.message) ? err.error.message.join(', ') : err.error?.message ?? 'Erreur')
          : String(err),
      );
    } finally { this.isLoading.set(false); }
  }

  private initMap(): void {
    const el = this.mapRef()?.nativeElement;
    if (!el || this.map) return;
    const mapPrefs = this.preferences.prefs().map;
    this.map = L.map(el, { center: [mapPrefs.centerLat, mapPrefs.centerLng], zoom: mapPrefs.zoom, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(this.map);
    const pinIcon = L.divIcon({
      className: '',
      html: `<div style="width:24px;height:24px;border-radius:50%;background:${this.color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>`,
      iconSize: [24, 24], iconAnchor: [12, 12],
    });
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.center = e.latlng;
      if (this.marker) { this.marker.setLatLng(e.latlng); } else { this.marker = L.marker(e.latlng, { icon: pinIcon }).addTo(this.map!); }
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
      this.circle = L.circle(this.center, { radius: this._radiusMeters, color: this.color, fillColor: this.color, fillOpacity: 0.2, weight: 2 }).addTo(this.map);
    }
  }

  private destroyMap(): void {
    this.marker?.remove(); this.circle?.remove();
    if (this.map) { this.map.remove(); this.map = null; }
    this.marker = null; this.circle = null;
  }

  private reset(): void {
    this.destroyMap();
    this.currentStep.set(1); this.errorMessage.set('');
    this.name = ''; this.rule = 'BOTH'; this.color = '#10e0a0';
    this._radiusMeters = 500; this._radiusIndex = 4; this.center = null;
  }
}
