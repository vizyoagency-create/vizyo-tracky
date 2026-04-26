import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit, Component, effect, ElementRef, HostListener,
  inject, input, OnDestroy, output, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, MapPin, X, ChevronRight, Check, Save } from 'lucide-angular';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker, GeoJSONSource } from 'maplibre-gl';
import { firstValueFrom } from 'rxjs';
import { GeofencesApiService } from '../../../core/services/geofences.service';
import { PreferencesService } from '../../../core/services/preferences.service';
import { MapService } from '../../../core/services/map.service';

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

          <div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
                <lucide-icon [img]="MapPinIcon" [size]="16" class="text-tracky-light"></lucide-icon>
              </div>
              <div>
                <h2 class="text-lg font-display font-bold text-fg-primary">
                  {{ editData() ? (currentStep() === 1 ? 'Modifier la géofence' : 'Repositionner') : (currentStep() === 1 ? 'Nouvelle géofence' : 'Placer sur la carte') }}
                </h2>
                <p class="text-[10px] text-fg-tertiary">{{ editData() ? editData()!.name : 'Étape ' + currentStep() + ' sur 2' }}</p>
              </div>
            </div>
            <button (click)="onClose()"
              class="p-1.5 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

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

          @if (currentStep() === 1) {
            <div class="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <section>
                <p class="section-title">Zone</p>
                <div>
                  <label class="field-label">Nom de la zone *</label>
                  <input type="text" [(ngModel)]="name" placeholder="Ex: Dépôt central" class="field-input" />
                </div>
              </section>
              <section>
                <p class="section-title">Forme</p>
                <div class="flex gap-2">
                  <button (click)="shape = 'CIRCLE'" class="rule-btn" [class.active]="shape === 'CIRCLE'">Cercle</button>
                  <button (click)="shape = 'POLYGON'" class="rule-btn" [class.active]="shape === 'POLYGON'">Polygone</button>
                </div>
              </section>
              <section>
                <p class="section-title">Règle de déclenchement</p>
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

          @if (currentStep() === 2) {
            <div class="px-6 py-3 text-xs text-fg-tertiary border-b border-border-subtle">
              @if (shape === 'CIRCLE') {
                Cliquez sur la carte pour placer le centre, puis ajustez le rayon.
              } @else {
                Cliquez pour ajouter chaque sommet ({{ polygonVertices().length }}). Au moins 3 sommets requis.
              }
            </div>
            <div #mapContainer class="flex-1" style="min-height:300px"></div>
            @if (shape === 'CIRCLE') {
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
            } @else {
              <div class="px-6 py-3 border-t border-border-subtle flex items-center gap-3 text-xs">
                <span class="text-fg-tertiary">{{ polygonVertices().length }} sommet(s)</span>
                <button (click)="undoLastVertex()" [disabled]="polygonVertices().length === 0"
                        class="px-3 py-1 rounded-lg bg-bg-tertiary border border-border-subtle text-fg-secondary
                               hover:text-fg-primary disabled:opacity-50 cursor-pointer">
                  Annuler dernier
                </button>
                <button (click)="clearPolygon()" [disabled]="polygonVertices().length === 0"
                        class="px-3 py-1 rounded-lg bg-bg-tertiary border border-border-subtle text-fg-secondary
                               hover:text-fg-primary disabled:opacity-50 cursor-pointer">
                  Effacer
                </button>
              </div>
            }
          }

          <div class="px-6 py-4 border-t border-border-subtle flex items-center justify-end gap-3">
            @if (currentStep() === 2) {
              <button (click)="currentStep.set(1)"
                class="px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary text-fg-secondary border border-border-subtle
                       hover:text-fg-primary transition-colors cursor-pointer">
                Précédent
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
              <button (click)="onSubmit()" [disabled]="isLoading() || (shape === 'CIRCLE' ? !center : polygonVertices().length < 3)"
                class="px-5 py-2.5 text-sm font-medium rounded-xl bg-tracky hover:bg-tracky-dark text-white
                       transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2">
                @if (isLoading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                } @else {
                  <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
                }
                {{ editData() ? 'Enregistrer' : 'Créer la géofence' }}
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
  `],
})
export class GeofenceDrawDialogComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly editData = input<{
    id: string;
    name: string;
    rule: 'ENTER' | 'EXIT' | 'BOTH';
    color: string;
    type?: 'CIRCLE' | 'POLYGON';
    centerLat: number;
    centerLng: number;
    radiusMeters: number;
    polygonPoints?: Array<{ lat: number; lng: number }> | null;
  } | null>(null);
  readonly created = output<void>();

  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly preferences = inject(PreferencesService);
  private readonly mapSvc = inject(MapService);
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
  protected shape: 'CIRCLE' | 'POLYGON' = 'CIRCLE';
  protected rule: 'ENTER' | 'EXIT' | 'BOTH' = 'BOTH';
  protected color = '#10e0a0';
  protected center: { lat: number; lng: number } | null = null;
  /** Sprint F.2 — sommets du polygone en cours de dessin. */
  protected readonly polygonVertices = signal<Array<{ lat: number; lng: number }>>([]);

  protected readonly rules = [
    { value: 'ENTER' as const, label: 'Entrée' },
    { value: 'EXIT' as const, label: 'Sortie' },
    { value: 'BOTH' as const, label: 'Les deux' },
  ];

  protected readonly presetColors = ['#10e0a0', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#ec4899'];

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;

  // Effect : si l'utilisateur change le rayon dans le slider, mettre a jour le cercle.
  private radiusEffect = effect(() => { void this._radiusIndex; });

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.open() && !this.isLoading()) this.onClose(); }

  ngAfterViewInit(): void { /* noop */ }
  ngOnDestroy(): void { this.destroyMap(); }

  ngOnChanges(): void {
    const d = this.editData();
    if (d && this.open()) {
      this.name = d.name;
      this.shape = d.type === 'POLYGON' ? 'POLYGON' : 'CIRCLE';
      this.rule = d.rule;
      this.color = d.color;
      this.center = { lat: d.centerLat, lng: d.centerLng };
      this._radiusMeters = d.radiusMeters;
      const closest = RADIUS_STEPS.reduce((prev, curr, i) =>
        Math.abs(curr - d.radiusMeters) < Math.abs(RADIUS_STEPS[prev]! - d.radiusMeters) ? i : prev, 0);
      this._radiusIndex = closest;
      this.polygonVertices.set(d.polygonPoints ?? []);
    }
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

  protected get radiusIndex(): number { return this._radiusIndex; }
  protected set radiusIndex(v: number) {
    this._radiusIndex = v;
    this._radiusMeters = RADIUS_STEPS[v] ?? 500;
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
    // Validation selon le mode
    if (this.shape === 'CIRCLE' && !this.center) return;
    if (this.shape === 'POLYGON' && this.polygonVertices().length < 3) return;

    this.isLoading.set(true);
    this.errorMessage.set('');
    try {
      let data: Parameters<typeof this.geofencesApi.create>[0];
      if (this.shape === 'POLYGON') {
        const verts = this.polygonVertices();
        // Centre = centroid pour la compat (centerLat/Lng/radius restent obligatoires backend).
        const cLat = verts.reduce((s, p) => s + p.lat, 0) / verts.length;
        const cLng = verts.reduce((s, p) => s + p.lng, 0) / verts.length;
        data = {
          name: this.name.trim(),
          type: 'POLYGON',
          centerLat: cLat,
          centerLng: cLng,
          radiusMeters: 100, // valeur factice ; backend ignore pour POLYGON
          rule: this.rule,
          color: this.color,
          polygonPoints: verts,
        };
      } else {
        data = {
          name: this.name.trim(),
          type: 'CIRCLE',
          centerLat: this.center!.lat,
          centerLng: this.center!.lng,
          radiusMeters: this._radiusMeters,
          rule: this.rule,
          color: this.color,
        };
      }

      const ed = this.editData();
      if (ed) {
        await firstValueFrom(this.geofencesApi.update(ed.id, data as unknown as Record<string, unknown>));
      } else {
        await firstValueFrom(this.geofencesApi.create(data));
      }
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

  protected undoLastVertex(): void {
    const verts = this.polygonVertices();
    if (verts.length === 0) return;
    this.polygonVertices.set(verts.slice(0, -1));
    this.refreshPolygonLayer();
  }

  protected clearPolygon(): void {
    this.polygonVertices.set([]);
    this.refreshPolygonLayer();
  }

  private refreshPolygonLayer(): void {
    if (!this.map) return;
    const src = this.map.getSource('draw-polygon') as GeoJSONSource | undefined;
    if (!src) return;
    const verts = this.polygonVertices();
    const features: GeoJSON.Feature[] = [];
    // Sommets visibles
    for (const v of verts) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
        properties: { color: this.color },
      });
    }
    // Polygone si >= 3 sommets, sinon ligne ouverte
    if (verts.length >= 3) {
      const ring = verts.map((v) => [v.lng, v.lat] as [number, number]);
      ring.push(ring[0]!);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color: this.color },
      });
    } else if (verts.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: verts.map((v) => [v.lng, v.lat]) },
        properties: { color: this.color },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }

  private initMap(): void {
    const el = this.mapRef()?.nativeElement;
    if (!el || this.map) return;
    const mapPrefs = this.preferences.prefs().map;
    const initCenter = this.center ?? { lat: mapPrefs.centerLat, lng: mapPrefs.centerLng };
    const initZoom = this.center ? 14 : mapPrefs.zoom;

    this.map = this.mapSvc.createMap(el, {
      center: initCenter,
      zoom: initZoom,
      style: mapPrefs.style,
      withGeolocateControl: true,
    });

    this.map.on('load', () => {
      this.setupCircleLayer();
      this.setupPolygonLayer();
      if (this.shape === 'CIRCLE' && this.center) {
        this.placeMarker(this.center.lat, this.center.lng);
        this.updateCircle();
      } else if (this.shape === 'POLYGON' && this.polygonVertices().length > 0) {
        this.refreshPolygonLayer();
      }
    });

    this.map.on('click', (e) => {
      if (this.shape === 'POLYGON') {
        const verts = [...this.polygonVertices(), { lat: e.lngLat.lat, lng: e.lngLat.lng }];
        this.polygonVertices.set(verts);
        this.refreshPolygonLayer();
      } else {
        this.center = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        this.placeMarker(e.lngLat.lat, e.lngLat.lng);
        this.updateCircle();
      }
    });

    setTimeout(() => this.map?.resize(), 100);
  }

  /** Sprint F.2 — setup layer pour le polygone en cours de dessin. */
  private setupPolygonLayer(): void {
    if (!this.map || this.map.getSource('draw-polygon')) return;
    this.map.addSource('draw-polygon', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    this.map.addLayer({
      id: 'draw-polygon-fill',
      type: 'fill',
      source: 'draw-polygon',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['coalesce', ['get', 'color'], '#10e0a0'], 'fill-opacity': 0.2 },
    });
    this.map.addLayer({
      id: 'draw-polygon-line',
      type: 'line',
      source: 'draw-polygon',
      filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
      paint: { 'line-color': ['coalesce', ['get', 'color'], '#10e0a0'], 'line-width': 2 },
    });
    this.map.addLayer({
      id: 'draw-polygon-points',
      type: 'circle',
      source: 'draw-polygon',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-color': ['coalesce', ['get', 'color'], '#10e0a0'] },
    });
  }

  private setupCircleLayer(): void {
    if (!this.map || this.map.getSource('draw-circle')) return;
    this.map.addSource('draw-circle', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    this.map.addLayer({
      id: 'draw-circle-fill',
      type: 'fill',
      source: 'draw-circle',
      paint: { 'fill-color': ['coalesce', ['get', 'color'], '#10e0a0'], 'fill-opacity': 0.18 },
    });
    this.map.addLayer({
      id: 'draw-circle-line',
      type: 'line',
      source: 'draw-circle',
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#10e0a0'],
        'line-width': 2,
      },
    });
  }

  private placeMarker(lat: number, lng: number): void {
    if (!this.map) return;
    if (this.marker) {
      this.marker.setLngLat([lng, lat]);
      const inner = this.marker.getElement().querySelector<HTMLElement>('.geofence-pin__dot');
      if (inner) inner.style.background = this.color;
      return;
    }
    const el = document.createElement('div');
    el.className = 'geofence-pin';
    el.innerHTML = `<div class="geofence-pin__dot" style="
      width:24px;height:24px;border-radius:50%;
      background:${this.color};border:3px solid white;
      box-shadow:0 2px 8px rgba(0,0,0,0.3)"></div>`;
    this.marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true })
      .setLngLat([lng, lat])
      .addTo(this.map);
    this.marker.on('dragend', () => {
      const pos = this.marker!.getLngLat();
      this.center = { lat: pos.lat, lng: pos.lng };
      this.updateCircle();
    });
  }

  private updateCircle(): void {
    if (!this.map || !this.center) return;
    const src = this.map.getSource('draw-circle') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'Feature',
      geometry: circleGeometry(this.center.lat, this.center.lng, this._radiusMeters),
      properties: { color: this.color },
    });
  }

  private destroyMap(): void {
    this.marker?.remove();
    if (this.map) { this.map.remove(); this.map = null; }
    this.marker = null;
  }

  private reset(): void {
    this.destroyMap();
    this.currentStep.set(1); this.errorMessage.set('');
    this.name = ''; this.shape = 'CIRCLE'; this.rule = 'BOTH'; this.color = '#10e0a0';
    this._radiusMeters = 500; this._radiusIndex = 4; this.center = null;
    this.polygonVertices.set([]);
  }
}

function circleGeometry(centerLat: number, centerLng: number, radiusM: number): GeoJSON.Polygon {
  const points = 64;
  const km = radiusM / 1000;
  const distanceX = km / (111.320 * Math.cos((centerLat * Math.PI) / 180));
  const distanceY = km / 110.574;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    ring.push([centerLng + distanceX * Math.cos(theta), centerLat + distanceY * Math.sin(theta)]);
  }
  ring.push(ring[0]!);
  return { type: 'Polygon', coordinates: [ring] };
}
