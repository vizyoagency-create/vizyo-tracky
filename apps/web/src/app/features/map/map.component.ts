import {
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker, Popup, GeoJSONSource } from 'maplibre-gl';
import type { GeofenceDto, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { haversineMeters, sanitizePositions } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { GeofencesApiService } from '../../core/services/geofences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { PreferencesService, type CameraMode } from '../../core/services/preferences.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { EngineControlService } from '../../core/services/engine-control.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { MapService } from '../../core/services/map.service';
import { MapStyleService, type MapStyleId } from '../../core/services/map-style.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  speedColor,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../shared/utils/maplibre-markers';
import { catmullRom, lerp, lerpHeading } from '../../shared/utils/spline';

interface MarkerEntry {
  marker: MlMarker;
  el: HTMLElement;
}

interface VehicleMeta {
  type: string;
  plate: string;
}

/**
 * Etat d'interpolation d'un marker : entre deux trames Coban (~30s), on fait
 * glisser le marker de `from` vers `to` plutot que de teleporter. Cf. Sprint C.
 */
interface InterpState {
  fromLat: number;
  fromLng: number;
  fromHeading: number;
  toLat: number;
  toLng: number;
  toHeading: number;
  startedAt: number;
  durationMs: number;
}

const INTERP_DURATION_MS = 28_000; // legerement < 30s pour atteindre la cible avant la nouvelle trame

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    <div #mapContainer style="position:absolute;top:0;left:0;width:100%;height:100%"></div>

    <!-- HUD top-left : statut realtime -->
    <div style="position:absolute;top:16px;left:16px;z-index:1000">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-4 min-w-[220px]">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-display font-semibold text-fg-primary">Suivi temps réel</h3>
          @if (realtime.connected()) {
            <span class="w-2 h-2 rounded-full bg-tracky-light animate-pulse"></span>
          } @else {
            <span class="w-2 h-2 rounded-full bg-fg-tertiary animate-pulse"></span>
          }
        </div>
        <p class="text-xs text-fg-secondary">
          {{ filteredPositionCount() }} véhicule(s) actif(s)
          @if (cameraMode() !== 'free' && followedVehicleId()) {
            · <span class="text-tracky-light">Suivi : {{ followedPlate() }}</span>
          }
        </p>
        <div class="flex gap-1.5 mt-3 flex-wrap">
          <button
            (click)="centerAll()"
            class="flex-1 text-xs font-medium py-1.5 rounded-lg
                   bg-tracky/20 text-tracky-light border border-tracky/30
                   hover:bg-tracky/30 transition-colors cursor-pointer">
            Vue d'ensemble
          </button>
          <button
            (click)="toggleFullscreen()"
            class="px-2 py-1.5 text-xs rounded-lg bg-bg-tertiary/60 border border-border-subtle
                   text-fg-secondary hover:text-fg-primary cursor-pointer"
            title="Plein ecran (F)">
            ⛶
          </button>
        </div>
        <div class="flex gap-1.5 mt-1.5 flex-wrap">
          <button
            (click)="toggleMeasure()"
            [class]="'flex-1 text-[10px] font-medium py-1.5 rounded-lg cursor-pointer transition-colors ' +
                     (measureMode()
                       ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                       : 'bg-bg-tertiary/60 text-fg-secondary border border-border-subtle hover:text-fg-primary')"
            title="Mesurer une distance">
            Mesurer
          </button>
          <button
            (click)="shareUrl()"
            class="flex-1 text-[10px] font-medium py-1.5 rounded-lg bg-bg-tertiary/60 border border-border-subtle
                   text-fg-secondary hover:text-fg-primary cursor-pointer"
            title="Copier URL de la vue">
            Partager
          </button>
          <button
            (click)="toggleCinema()"
            [class]="'flex-1 text-[10px] font-medium py-1.5 rounded-lg cursor-pointer transition-colors ' +
                     (cinemaMode()
                       ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                       : 'bg-bg-tertiary/60 text-fg-secondary border border-border-subtle hover:text-fg-primary')"
            title="Cycle automatique sur les vehicules (8s)">
            Cinema
          </button>
        </div>
        @if (measureMode()) {
          <div class="mt-2 px-2 py-1 rounded bg-purple-500/10 border border-purple-500/30
                      text-[10px] text-purple-300 flex items-center justify-between">
            <span>{{ measurePoints().length }} pts · {{ measureTotalKm() | number:'1.2-2' }} km</span>
            <button (click)="clearMeasure()" class="text-[10px] underline cursor-pointer">Reset</button>
          </div>
        }
        @if (miniReplayVehicleId()) {
          <div class="mt-2 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30
                      text-[10px] text-blue-300 flex items-center justify-between">
            <span>Replay 1h actif</span>
            <button (click)="toggleMiniReplay(miniReplayVehicleId()!)" class="text-[10px] underline cursor-pointer">Fermer</button>
          </div>
        }
      </div>

      <!-- Smart search : vehicule ou adresse (Sprint G.1) -->
      <div class="mt-2 bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 min-w-[220px] relative">
        <input
          type="search"
          placeholder="Plaque ou adresse..."
          [value]="searchQuery()"
          (keydown.enter)="searchAddress($event)"
          (input)="onSearchInput($event)"
          (focus)="searchFocused.set(true)"
          (blur)="onSearchBlur()"
          class="w-full bg-transparent text-xs text-fg-primary placeholder:text-fg-tertiary
                 px-2 py-1.5 outline-none" />
        @if (searchFocused() && vehicleMatches().length > 0) {
          <div style="position:absolute;top:100%;left:0;right:0;z-index:1500"
               class="mt-1 bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                      rounded-lg overflow-hidden shadow-2xl">
            @for (v of vehicleMatches(); track v.vehicleId) {
              <button (mousedown)="jumpToVehicle(v.vehicleId)"
                      class="w-full text-left px-3 py-2 text-xs text-fg-primary
                             hover:bg-bg-tertiary cursor-pointer flex items-center justify-between gap-2">
                <span class="font-mono">{{ v.plate }}</span>
                <span class="text-[10px] text-fg-tertiary">{{ v.type }}</span>
              </button>
            }
          </div>
        }
      </div>
    </div>

    <!-- Style picker top-right (wrappable on mobile) -->
    <div class="tracky-style-picker"
         style="position:absolute;top:16px;right:16px;z-index:1000;max-width:calc(100% - 32px)">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 flex gap-1 flex-wrap">
        @for (s of styles.catalog; track s.id) {
          <button
            (click)="setStyle(s.id)"
            [class]="'px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ' +
                     (currentStyle() === s.id
                       ? 'bg-tracky/20 text-tracky-light border border-tracky/30'
                       : 'text-fg-tertiary hover:text-fg-primary')"
            [title]="s.label">
            {{ s.label }}
          </button>
        }
      </div>

      <!-- Camera mode pills -->
      <div class="mt-2 bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 flex gap-1 flex-wrap">
        @for (m of cameraModes; track m.id) {
          <button
            (click)="setCameraMode(m.id)"
            [class]="'px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ' +
                     (cameraMode() === m.id
                       ? 'bg-tracky/20 text-tracky-light border border-tracky/30'
                       : 'text-fg-tertiary hover:text-fg-primary')"
            [title]="m.tooltip">
            {{ m.label }}
          </button>
        }
      </div>
    </div>

    <!-- FAB mobile : toggle bottom-sheet (calques + actions). Visible < 768px. -->
    <button
      (click)="mobileSheetOpen.set(!mobileSheetOpen())"
      class="md:hidden"
      style="position:absolute;bottom:24px;right:80px;z-index:1500;
             width:48px;height:48px;border-radius:9999px;
             background:#10E0A0;color:#0a0a0a;font-size:20px;font-weight:700;
             border:0;cursor:pointer;
             box-shadow:0 6px 20px rgba(16,224,160,0.4)">
      ☰
    </button>

    <!-- Calques (filtres statut) - bottom-left desktop, sheet mobile -->
    <div [class]="mobileSheetOpen() ? 'tracky-mobile-sheet--open' : ''"
         class="tracky-calques-panel"
         style="position:absolute;bottom:90px;left:16px;z-index:1000">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-3 min-w-[180px]">
        <p class="text-[10px] font-semibold text-fg-secondary mb-2 uppercase tracking-wider">Calques</p>
        <div class="flex flex-col gap-1.5">
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="filters().moving" (change)="toggleFilter('moving')" />
            <span class="w-2 h-2 rounded-full" style="background:#10E0A0"></span>
            <span>En mouvement</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="filters().idle" (change)="toggleFilter('idle')" />
            <span class="w-2 h-2 rounded-full" style="background:#5C746C"></span>
            <span>Arret moteur ON</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="filters().off" (change)="toggleFilter('off')" />
            <span class="w-2 h-2 rounded-full" style="background:#6b7280"></span>
            <span>Eteint</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="filters().offline" (change)="toggleFilter('offline')" />
            <span class="w-2 h-2 rounded-full" style="background:#9ca3af"></span>
            <span>Hors-ligne (>10min)</span>
          </label>
          <hr class="my-1 border-border-subtle" />
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="showGeofences()" (change)="toggleGeofences()" />
            <span>Geofences</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="showTrails()" (change)="toggleTrails()" />
            <span>Traces</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="showPlates()" (change)="togglePlates()" />
            <span>Plaques</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="showStops()" (change)="toggleStops()" />
            <span>Arrets > 5min (24h)</span>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-fg-secondary cursor-pointer">
            <input type="checkbox" [checked]="showHeatmap()" (change)="toggleHeatmap()" />
            <span>Heatmap densite (24h)</span>
          </label>
        </div>
      </div>
    </div>

    <!-- Compass reset -->
    @if (bearingNonZero() || pitchNonZero()) {
      <button
        (click)="resetNorth()"
        title="Recentrer Nord (C)"
        style="position:absolute;bottom:200px;right:16px;z-index:1000;
               width:42px;height:42px;border-radius:9999px;
               background:var(--surface-secondary, rgba(20,24,32,0.85));
               backdrop-filter:blur(8px);
               border:1px solid var(--border-color, rgba(255,255,255,0.1));
               display:flex;align-items:center;justify-content:center;cursor:pointer;
               box-shadow:0 4px 16px rgba(0,0,0,0.3)">
        <span [style.transform]="'rotate(' + (-mapBearing()) + 'deg)'"
              style="display:inline-block;font-size:18px;color:#EF4444;font-weight:700;
                     transition:transform 200ms ease">N</span>
      </button>
    }

    <!-- Legende vitesse (toujours visible) -->
    <div style="position:absolute;bottom:24px;right:16px;z-index:1000">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-3">
        <p class="text-[10px] font-semibold text-fg-secondary mb-1.5 uppercase tracking-wider">Vitesse</p>
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background:#5C746C"></span>
            <span class="text-[10px] text-fg-tertiary">0 km/h</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background:#10E0A0"></span>
            <span class="text-[10px] text-fg-tertiary">1-50 km/h</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background:#F59E0B"></span>
            <span class="text-[10px] text-fg-tertiary">51-90 km/h</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background:#EF4444"></span>
            <span class="text-[10px] text-fg-tertiary">91+ km/h</span>
          </div>
        </div>
      </div>
    </div>

    @if (!realtime.connected()) {
      <div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:1000"
           class="bg-bg-secondary/90 backdrop-blur-md border border-border-subtle
                  rounded-xl px-4 py-2 flex items-center gap-2">
        <span class="w-3 h-3 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        <span class="text-xs text-fg-secondary">Connexion temps réel interrompue...</span>
      </div>
    }

    <!-- Menu contextuel (right-click) -->
    @if (contextMenu()) {
      <div [style.left.px]="contextMenu()!.x" [style.top.px]="contextMenu()!.y"
           style="position:absolute;z-index:2000;min-width:200px"
           class="bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                  shadow-2xl overflow-hidden"
           (click)="$event.stopPropagation()">
        <button (click)="copyCoords(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Copier les coordonnees
        </button>
        <button (click)="centerHere(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Centrer ici
        </button>
        <button (click)="resetNorth(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Recentrer Nord
        </button>
        <button (click)="toggleLock(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          {{ mapLocked() ? 'Deverrouiller la carte' : 'Verrouiller la carte' }}
        </button>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
    /* Sprint F.3 — Mobile bottom-sheet pour le panneau Calques.
       En desktop (>=768px) : affichage normal en panneau flottant.
       En mobile (<768px)   : caché par défaut, slide-up depuis le bas si .tracky-mobile-sheet--open. */
    @media (max-width: 767px) {
      .tracky-calques-panel {
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        transform: translateY(100%);
        transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
        max-height: 60vh;
        overflow: auto;
      }
      .tracky-calques-panel.tracky-mobile-sheet--open {
        transform: translateY(0);
      }
      .tracky-calques-panel > div {
        border-radius: 16px 16px 0 0 !important;
        min-width: 0 !important;
        margin: 0 !important;
      }
    }
  `],
})
export class MapComponent implements AfterViewInit, OnDestroy {
  protected readonly realtime = inject(RealtimeService);
  protected readonly styles = inject(MapStyleService);
  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly preferences = inject(PreferencesService);
  private readonly mapSvc = inject(MapService);
  private readonly engineControl = inject(EngineControlService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);

  private readonly mapContainerRef = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  private map: MlMap | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private markers = new Map<string, MarkerEntry>();
  private vehicleMeta = new Map<string, VehicleMeta>();
  private trailPoints = new Map<string, Array<[number, number]>>();
  private hasFittedBounds = false;
  private currentPopup: Popup | null = null;
  private activePopupTrackerId: string | null = null;

  /** Etat d'interpolation par trackerId : permet animation fluide entre 2 events WS. */
  private interp = new Map<string, InterpState>();
  /** Derniere data de marker connue (pour update du DOM pendant interpolation). */
  private lastMarkerData = new Map<string, VehicleMarkerData>();
  private animFrameId: number | null = null;

  protected readonly currentStyle = signal<MapStyleId>('osm');
  protected readonly cameraMode = signal<CameraMode>('free');
  protected readonly followedVehicleId = signal<string | null>(null);
  protected readonly mapBearing = signal(0);
  protected readonly mapPitch = signal(0);
  protected readonly bearingNonZero = computed(() => Math.abs(this.mapBearing()) > 0.5);
  protected readonly pitchNonZero = computed(() => Math.abs(this.mapPitch()) > 0.5);
  protected readonly searchQuery = signal('');
  /** Sprint G.1 — focus + suggestions vehicules. */
  protected readonly searchFocused = signal(false);
  protected readonly vehicleMatches = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length < 1) return [];
    const snap = this.realtime.snapshot();
    return snap
      .filter((v) => v.plate.toLowerCase().includes(q) || v.type.toLowerCase().includes(q))
      .slice(0, 5);
  });

  protected readonly showGeofences = signal(true);
  protected readonly showTrails = signal(true);
  protected readonly showPlates = signal(true);
  /** Sprint F.1 — affichage des arrets > 5min calcules sur les 24 dernieres heures. */
  protected readonly showStops = signal(false);
  /** Sprint G.4 — heatmap densite des positions (24h). */
  protected readonly showHeatmap = signal(false);
  /** Sprint G.5 — verrouillage du pan (la carte ne peut plus etre deplacee). */
  protected readonly mapLocked = signal(false);
  /** Sprint F.3 — sheet mobile pour les calques (FAB toggle). */
  protected readonly mobileSheetOpen = signal(false);

  protected readonly filters = signal<{ moving: boolean; idle: boolean; off: boolean; offline: boolean }>({
    moving: true, idle: true, off: true, offline: true,
  });

  protected readonly contextMenu = signal<{ x: number; y: number; lat: number; lng: number } | null>(null);

  /** Sprint D.2 — vehicleId actuellement affiche en mini-replay 1h (null = aucun). */
  protected readonly miniReplayVehicleId = signal<string | null>(null);
  /** Sprint D.4 — mode mesure de distance actif. */
  protected readonly measureMode = signal(false);
  protected readonly measurePoints = signal<Array<{ lat: number; lng: number }>>([]);
  protected readonly measureTotalKm = computed(() => {
    const pts = this.measurePoints();
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += haversineMeters(pts[i - 1]!.lat, pts[i - 1]!.lng, pts[i]!.lat, pts[i]!.lng);
    }
    return total / 1000;
  });
  /** Sprint E.1 — mode Cinema : cycle sur les vehicules en mouvement, 8s chacun. */
  protected readonly cinemaMode = signal(false);
  private cinemaIntervalId: ReturnType<typeof setInterval> | null = null;
  private cinemaIndex = 0;

  private readonly _accessibleIds = signal<Set<string> | 'ALL'>('ALL');

  protected readonly cameraModes: Array<{ id: CameraMode; label: string; tooltip: string }> = [
    { id: 'free',        label: 'Libre',     tooltip: 'Navigation libre (drag, zoom, rotation)' },
    { id: 'follow',      label: 'Suivre',    tooltip: 'Suivre le vehicule selectionne' },
    { id: 'heading-up',  label: 'Sens',      tooltip: 'Suivre + carte alignee dans le sens de marche' },
    { id: 'chase',       label: '3D',        tooltip: 'Suivi 3D type cockpit GPS' },
  ];

  protected readonly filteredPositionCount = computed(() => {
    const ids = this._accessibleIds();
    return ids === 'ALL'
      ? this.realtime.positionsList().length
      : this.realtime.positionsList().filter((p) => (ids as Set<string>).has(p.vehicleId)).length;
  });

  protected readonly followedPlate = computed(() => {
    const vid = this.followedVehicleId();
    if (!vid) return '';
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === vid);
    return snap?.plate ?? '';
  });

  // Re-render markers chaque fois que les positions changent.
  private positionsEffect = effect(() => {
    const all = this.realtime.positionsList();
    const ids = this._accessibleIds();
    const filtered = ids === 'ALL'
      ? all
      : all.filter((p) => (ids as Set<string>).has(p.vehicleId));
    if (!this.map) return;
    this.applyPositions(this.applyFilters(filtered));
  });

  ngAfterViewInit(): void {
    // Charger prefs map
    const prefs = this.preferences.prefs().map;
    this.currentStyle.set(prefs.style);
    this.cameraMode.set(prefs.cameraMode);
    this.showTrails.set(prefs.showTrails);
    this.showPlates.set(prefs.showPlates);

    setTimeout(() => this.initMap(), 0);

    // Hydratation : si snapshot deja la, pre-construire la metadata vehicule.
    const snap = this.realtime.snapshot();
    for (const v of snap) {
      this.vehicleMeta.set(v.vehicleId, { type: v.type, plate: v.plate });
    }

    // Recupere aussi depuis /api/vehicles pour les types manquants (ex : si snapshot vide).
    firstValueFrom(this.vehiclesApi.list()).then((vehicles) => {
      this._accessibleIds.set(new Set(vehicles.map((v) => v.id)));
      vehicles.forEach((v) => {
        const cast = v as VehicleDetailDto & { type?: string };
        this.vehicleMeta.set(v.id, { type: cast.type ?? 'OTHER', plate: v.plate });
      });
      // Re-render apres MAJ meta
      if (this.map) this.applyPositions(this.applyFilters(this.realtime.positionsList()));
    }).catch(() => { /* fallback to ALL */ });
  }

  private initMap(): void {
    const container = this.mapContainerRef().nativeElement;
    const prefs = this.preferences.prefs().map;

    this.map = this.mapSvc.createMap(container, {
      center: { lat: prefs.centerLat, lng: prefs.centerLng },
      zoom: prefs.zoom,
      style: prefs.style,
    });

    this.map.on('rotate', () => this.mapBearing.set(this.map!.getBearing()));
    this.map.on('pitch', () => this.mapPitch.set(this.map!.getPitch()));

    // Quand l'utilisateur drag manuellement en mode follow, sortir du mode.
    this.map.on('dragstart', () => {
      if (this.cameraMode() !== 'free') {
        this.setCameraMode('free');
      }
    });

    // Right-click context menu.
    this.map.on('contextmenu', (e) => {
      const rect = container.getBoundingClientRect();
      this.contextMenu.set({
        x: e.point.x,
        y: e.point.y,
        lat: e.lngLat.lat,
        lng: e.lngLat.lng,
      });
      // Eviter que rect/scroll polluent — pas critique pour V1.
      void rect;
    });

    // Setup sources/layers de base apres `load`.
    this.map.on('load', () => {
      this.setupGeofencesLayer();
      this.setupTrailsLayer();
      this.setupMiniReplayLayer();
      this.setupMeasureLayer();
      this.setupStopsLayer();
      this.setupHeatmapLayer();
      this.setupClusterLayer();
      this.loadGeofences();
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
      this.applyClusterVisibility();
      this.restoreFromUrl();
    });

    // Sprint G.2 — refresh cluster visibility on zoom change.
    this.map.on('zoom', () => this.applyClusterVisibility());

    // Click pour la mesure de distance.
    this.map.on('click', (e) => {
      this.closeContextMenu();
      if (this.measureMode()) {
        const pts = [...this.measurePoints(), { lat: e.lngLat.lat, lng: e.lngLat.lng }];
        this.measurePoints.set(pts);
        this.refreshMeasureLayer();
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(container);

    // Boucle d'animation pour l'interpolation des markers (Sprint C).
    this.startAnimLoop();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.cinemaIntervalId) {
      clearInterval(this.cinemaIntervalId);
      this.cinemaIntervalId = null;
    }

    this.markers.forEach((m) => m.marker.remove());
    this.markers.clear();
    this.trailPoints.clear();
    this.interp.clear();
    this.lastMarkerData.clear();

    this.currentPopup?.remove();
    this.currentPopup = null;

    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  /**
   * Boucle d'interpolation : a chaque RAF, fait avancer chaque marker en cours
   * d'interpolation. Une trame WS Coban arrive toutes les ~30s ; on glisse le
   * marker sur cette duree pour eviter les teleports.
   */
  private startAnimLoop(): void {
    const tick = (now: number) => {
      this.animFrameId = requestAnimationFrame(tick);
      if (this.interp.size === 0) return;

      const followedVid = this.followedVehicleId();
      const camMode = this.cameraMode();

      for (const [trackerId, st] of this.interp) {
        const t = Math.min(1, (now - st.startedAt) / st.durationMs);
        const lat = lerp(st.fromLat, st.toLat, t);
        const lng = lerp(st.fromLng, st.toLng, t);
        const heading = lerpHeading(st.fromHeading, st.toHeading, t);

        const entry = this.markers.get(trackerId);
        if (entry) {
          entry.marker.setLngLat([lng, lat]);
          const data = this.lastMarkerData.get(trackerId);
          if (data) {
            updateVehicleMarkerEl(entry.el, { ...data, heading });
          }
        }

        // Si on suit ce vehicule, faire suivre la camera en douceur (sans animation
        // MapLibre supplementaire — on copie la position interpolee directement).
        if (this.map && (camMode === 'follow' || camMode === 'heading-up' || camMode === 'chase')) {
          const data = this.lastMarkerData.get(trackerId);
          if (data && data.vehicleId === followedVid) {
            this.map.jumpTo({
              center: [lng, lat],
              bearing: (camMode === 'heading-up' || camMode === 'chase') ? heading : this.map.getBearing(),
            });
          }
        }

        if (t >= 1) this.interp.delete(trackerId);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  /* --- Camera & view --- */

  protected centerAll(): void {
    if (!this.map || this.markers.size === 0) return;
    const points = Array.from(this.markers.values()).map((m) => {
      const ll = m.marker.getLngLat();
      return { lat: ll.lat, lng: ll.lng };
    });
    this.mapSvc.fitBounds(this.map, points, { padding: 70, maxZoom: 15 });
  }

  protected setStyle(id: MapStyleId): void {
    if (!this.map) return;
    this.currentStyle.set(id);
    this.preferences.update({ map: { ...this.preferences.prefs().map, style: id } });
    this.mapSvc.setStyle(this.map, id);
    // Apres setStyle, les sources custom (geofences/trails) sont perdues — on les recree.
    this.map.once('styledata', () => {
      this.setupGeofencesLayer();
      this.setupTrailsLayer();
      this.setupMiniReplayLayer();
      this.setupMeasureLayer();
      this.setupStopsLayer();
      this.setupHeatmapLayer();
      this.setupClusterLayer();
      this.loadGeofences();
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
      this.applyClusterVisibility();
      // Mini-replay : si actif, recharger.
      const vid = this.miniReplayVehicleId();
      if (vid) this.loadMiniReplay(vid).catch(() => { /* silent */ });
      this.refreshMeasureLayer();
      if (this.showStops()) this.loadStops().catch(() => { /* silent */ });
    });
  }

  /**
   * Sprint G.2 — bascule entre markers DOM (zoom eleve) et cluster GeoJSON
   * (zoom faible). Le seuil 12 garde le rendu riche pour la grande majorite
   * des cas d'usage (ville/quartier) et la performance pour les vues "pays".
   */
  private applyClusterVisibility(): void {
    if (!this.map) return;
    const z = this.map.getZoom();
    const showClusters = z < 12;
    // Toggle DOM markers
    document.querySelectorAll('.tracky-marker').forEach((el) => {
      (el as HTMLElement).style.display = showClusters ? 'none' : '';
    });
    // Toggle cluster layers
    this.setLayerVisibility('vehicles-cluster-bg', showClusters);
    this.setLayerVisibility('vehicles-cluster-count', showClusters);
  }

  /** Sprint D.2 — toggle l'affichage de la derniere heure pour un vehicule. */
  protected async toggleMiniReplay(vehicleId: string): Promise<void> {
    if (this.miniReplayVehicleId() === vehicleId) {
      this.miniReplayVehicleId.set(null);
      const src = this.map?.getSource('mini-replay') as GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    this.miniReplayVehicleId.set(vehicleId);
    await this.loadMiniReplay(vehicleId);
  }

  private async loadMiniReplay(vehicleId: string): Promise<void> {
    if (!this.map) return;
    try {
      const fromIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const res = await firstValueFrom(
        this.http.get<{ items: Array<{ lat: number; lng: number; timestamp: string; speedKmh: number }> }>(
          `/api/positions?vehicleId=${vehicleId}&from=${encodeURIComponent(fromIso)}&limit=500`,
        ),
      );
      // L'API trie DESC ; on inverse pour avoir un trace chronologique.
      const items = (res.items ?? []).slice().reverse();
      const cleaned = sanitizePositions(items.map((p) => ({
        lat: p.lat, lng: p.lng, timestamp: p.timestamp,
      })));
      if (cleaned.length < 2) {
        this.toast.show({ kind: 'info', title: 'Pas assez de positions sur la derniere heure', duration: 3000 });
        return;
      }
      const coords = cleaned.map((p) => [p.lng, p.lat] as [number, number]);
      const src = this.map.getSource('mini-replay') as GeoJSONSource | undefined;
      src?.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {},
      });
    } catch {
      this.toast.show({ kind: 'error', title: 'Echec du chargement de la derniere heure', duration: 3000 });
    }
  }

  /** Sprint D.4 — toggle l'outil de mesure de distance. */
  protected toggleMeasure(): void {
    const next = !this.measureMode();
    this.measureMode.set(next);
    if (!next) this.clearMeasure();
  }

  protected clearMeasure(): void {
    this.measurePoints.set([]);
    this.refreshMeasureLayer();
  }

  private refreshMeasureLayer(): void {
    const src = this.map?.getSource('measure') as GeoJSONSource | undefined;
    if (!src) return;
    const pts = this.measurePoints();
    const features: GeoJSON.Feature[] = pts.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {},
    }));
    if (pts.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) },
        properties: {},
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }

  /** Sprint D.5 — copie une URL avec la vue carte courante (lat/lng/zoom/bearing/pitch/style). */
  protected async shareUrl(): Promise<void> {
    if (!this.map) return;
    const c = this.map.getCenter();
    const params = new URLSearchParams({
      lat: c.lat.toFixed(6), lng: c.lng.toFixed(6),
      zoom: this.map.getZoom().toFixed(2),
      bearing: this.map.getBearing().toFixed(1),
      pitch: this.map.getPitch().toFixed(1),
      style: this.currentStyle(),
    });
    const url = `${window.location.origin}/map?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.show({ kind: 'info', title: 'URL de la vue copiee', message: url, duration: 4000 });
    } catch {
      this.toast.show({ kind: 'warning', title: url, duration: 6000 });
    }
  }

  private restoreFromUrl(): void {
    if (!this.map) return;
    const params = this.route.snapshot.queryParamMap;
    const lat = parseFloat(params.get('lat') ?? '');
    const lng = parseFloat(params.get('lng') ?? '');
    const zoom = parseFloat(params.get('zoom') ?? '');
    const bearing = parseFloat(params.get('bearing') ?? '');
    const pitch = parseFloat(params.get('pitch') ?? '');
    const style = params.get('style') as MapStyleId | null;

    if (style && this.styles.byId(style).id === style) {
      this.currentStyle.set(style);
      // Note : pas de re-setStyle car le map est deja initialise avec un style.
      // Le partage URL fonctionne mieux a partir du second load. V1.5 polish.
    }
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      this.map.jumpTo({
        center: [lng, lat],
        zoom: Number.isFinite(zoom) ? zoom : this.map.getZoom(),
        bearing: Number.isFinite(bearing) ? bearing : 0,
        pitch: Number.isFinite(pitch) ? pitch : 0,
      });
      this.hasFittedBounds = true;
    }
  }

  /** Sprint E.1 — mode Cinema : cycle 8s sur les vehicules. */
  protected toggleCinema(): void {
    if (this.cinemaMode()) {
      this.cinemaMode.set(false);
      if (this.cinemaIntervalId) clearInterval(this.cinemaIntervalId);
      this.cinemaIntervalId = null;
      return;
    }
    this.cinemaMode.set(true);
    this.cinemaIndex = 0;
    this.cinemaTick();
    this.cinemaIntervalId = setInterval(() => this.cinemaTick(), 8000);
  }

  private cinemaTick(): void {
    if (!this.map) return;
    const list = this.realtime.positionsList();
    if (list.length === 0) return;
    const target = list[this.cinemaIndex % list.length]!;
    this.cinemaIndex++;
    this.followedVehicleId.set(target.vehicleId);
    this.map.flyTo({ center: [target.lng, target.lat], zoom: 16, duration: 1500 });
  }

  protected setCameraMode(mode: CameraMode): void {
    this.cameraMode.set(mode);
    this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: mode } });

    if (mode === 'free') {
      this.followedVehicleId.set(null);
      return;
    }

    if (mode === 'chase' && this.map) {
      this.map.easeTo({ pitch: 60, duration: 600 });
    } else if (mode !== 'chase' && this.map) {
      this.map.easeTo({ pitch: 0, duration: 400 });
    }

    // Apply immediately to current focus.
    this.applyCameraMode();
  }

  /** Applique le mode camera courant : si follow/heading-up/chase, focus sur le suivi. */
  private applyCameraMode(): void {
    const mode = this.cameraMode();
    if (mode === 'free' || !this.map) return;

    const targetId = this.followedVehicleId();
    if (!targetId) {
      // Auto-pick : premier vehicule en mouvement, ou premier de la liste.
      const list = this.realtime.positionsList();
      const moving = list.find((p) => p.speedKmh > 5);
      const pick = moving ?? list[0];
      if (pick) this.followedVehicleId.set(pick.vehicleId);
    }

    const id = this.followedVehicleId();
    if (!id) return;
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === id);
    if (!pos) return;

    this.map.easeTo({
      center: [pos.lng, pos.lat],
      zoom: mode === 'chase' ? 17 : Math.max(this.map.getZoom(), 14),
      bearing: mode === 'heading-up' || mode === 'chase' ? pos.heading : this.map.getBearing(),
      pitch: mode === 'chase' ? 60 : this.map.getPitch(),
      duration: 600,
    });
  }

  protected resetNorth(): void {
    if (!this.map) return;
    this.mapSvc.resetNorth(this.map);
  }

  /* --- Filtres --- */

  protected toggleFilter(key: 'moving' | 'idle' | 'off' | 'offline'): void {
    const cur = this.filters();
    this.filters.set({ ...cur, [key]: !cur[key] });
  }

  private applyFilters(positions: PositionUpdateEvent[]): PositionUpdateEvent[] {
    const f = this.filters();
    const now = Date.now();
    return positions.filter((p) => {
      const ageMin = (now - new Date(p.timestamp).getTime()) / 60000;
      if (ageMin > 10) return f.offline;
      if (!p.ignition) return f.off;
      if (p.speedKmh > 5) return f.moving;
      return f.idle;
    });
  }

  protected toggleGeofences(): void {
    const v = !this.showGeofences();
    this.showGeofences.set(v);
    this.setLayerVisibility('geofences-fill', v);
    this.setLayerVisibility('geofences-line', v);
  }

  protected toggleTrails(): void {
    const v = !this.showTrails();
    this.showTrails.set(v);
    this.preferences.update({ map: { ...this.preferences.prefs().map, showTrails: v } });
    this.setLayerVisibility('trails-line', v);
  }

  /** Sprint G.4 — toggle de la heatmap. */
  protected toggleHeatmap(): void {
    const v = !this.showHeatmap();
    this.showHeatmap.set(v);
    this.setLayerVisibility('positions-heatmap', v);
    if (v) this.loadHeatmap().catch(() => { /* silent */ });
  }

  /** Sprint G.4 — charge les positions des 24h pour densite. */
  private async loadHeatmap(): Promise<void> {
    if (!this.map) return;
    const fromIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ids = this._accessibleIds();
    const vehiclesToScan = ids === 'ALL'
      ? Array.from(this.vehicleMeta.keys())
      : Array.from(ids as Set<string>);

    const features: Array<GeoJSON.Feature<GeoJSON.Point>> = [];
    for (const vehicleId of vehiclesToScan) {
      try {
        const res = await firstValueFrom(
          this.http.get<{ items: Array<{ lat: number; lng: number }> }>(
            `/api/positions?vehicleId=${vehicleId}&from=${encodeURIComponent(fromIso)}&limit=500`,
          ),
        );
        for (const p of res.items ?? []) {
          features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} });
        }
      } catch { /* silent per vehicle */ }
    }
    const src = this.map.getSource('positions-heatmap') as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
  }

  /** Sprint G.5 — verrouille / deverrouille le pan de la carte. Zoom + rotation restent libres. */
  protected toggleLock(): void {
    if (!this.map) return;
    const next = !this.mapLocked();
    this.mapLocked.set(next);
    if (next) {
      this.map.dragPan.disable();
    } else {
      this.map.dragPan.enable();
    }
    this.toast.show({
      kind: 'info',
      title: next ? 'Carte verrouillee (pas de drag)' : 'Carte deverrouillee',
      duration: 2500,
    });
  }

  /** Sprint F.1 — toggle l'affichage des arrets > 5min (24h). */
  protected toggleStops(): void {
    const v = !this.showStops();
    this.showStops.set(v);
    this.setLayerVisibility('stops-circle', v);
    this.setLayerVisibility('stops-label', v);
    if (v) this.loadStops().catch(() => { /* silent */ });
  }

  /**
   * Charge les positions des 24 dernieres heures de tous les vehicules accessibles
   * et detecte les "stop clusters" : groupes de positions consecutives avec
   * speedKmh ~= 0 separees de moins de 50m, durant >= 5min. Place un picto P
   * au centre de chaque cluster.
   */
  private async loadStops(): Promise<void> {
    if (!this.map) return;
    const STOP_MIN_DURATION_MS = 5 * 60 * 1000;
    const STOP_MAX_RADIUS_M = 50;
    const STOP_MAX_SPEED = 2; // km/h — bruit GPS tolere

    const fromIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const features: Array<GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>> = [];

    const ids = this._accessibleIds();
    const vehiclesToScan = ids === 'ALL'
      ? Array.from(this.vehicleMeta.keys())
      : Array.from(ids as Set<string>);

    for (const vehicleId of vehiclesToScan) {
      try {
        const res = await firstValueFrom(
          this.http.get<{ items: Array<{ lat: number; lng: number; speedKmh: number; timestamp: string }> }>(
            `/api/positions?vehicleId=${vehicleId}&from=${encodeURIComponent(fromIso)}&limit=500`,
          ),
        );
        const items = (res.items ?? []).slice().reverse(); // chronologique
        if (items.length < 2) continue;

        let clusterStart: typeof items[0] | null = null;
        let clusterCenterLat = 0, clusterCenterLng = 0, clusterCount = 0;

        for (let i = 0; i < items.length; i++) {
          const p = items[i]!;
          if (p.speedKmh <= STOP_MAX_SPEED) {
            if (!clusterStart) {
              clusterStart = p;
              clusterCenterLat = p.lat;
              clusterCenterLng = p.lng;
              clusterCount = 1;
              continue;
            }
            // Verifier si le point est dans le rayon du cluster
            const d = haversineMeters(clusterCenterLat, clusterCenterLng, p.lat, p.lng);
            if (d > STOP_MAX_RADIUS_M) {
              // Sortie du cluster — verifier sa duree
              this.maybePushStopFeature(features, clusterStart, items[i - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS);
              clusterStart = p;
              clusterCenterLat = p.lat;
              clusterCenterLng = p.lng;
              clusterCount = 1;
            } else {
              // Moyenne mobile pour le centre
              clusterCenterLat = (clusterCenterLat * clusterCount + p.lat) / (clusterCount + 1);
              clusterCenterLng = (clusterCenterLng * clusterCount + p.lng) / (clusterCount + 1);
              clusterCount++;
            }
          } else if (clusterStart) {
            // Mouvement detecte — fermer le cluster precedent
            this.maybePushStopFeature(features, clusterStart, items[i - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS);
            clusterStart = null;
            clusterCount = 0;
          }
        }
        // Cluster final
        if (clusterStart) {
          this.maybePushStopFeature(features, clusterStart, items[items.length - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS);
        }
      } catch { /* silent per vehicle */ }
    }

    const src = this.map.getSource('stops') as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
  }

  private maybePushStopFeature(
    features: Array<GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>>,
    start: { timestamp: string },
    end: { timestamp: string },
    lat: number,
    lng: number,
    minDurationMs: number,
  ): void {
    const dur = new Date(end.timestamp).getTime() - new Date(start.timestamp).getTime();
    if (dur < minDurationMs) return;
    const minutes = Math.round(dur / 60000);
    const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}min`;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { duration: label, startedAt: start.timestamp },
    });
  }

  protected togglePlates(): void {
    const v = !this.showPlates();
    this.showPlates.set(v);
    this.preferences.update({ map: { ...this.preferences.prefs().map, showPlates: v } });
    document.querySelectorAll('.tracky-marker').forEach((el) => {
      el.classList.toggle('tracky-marker--no-plate', !v);
    });
  }

  private setLayerVisibility(layerId: string, visible: boolean): void {
    if (!this.map?.getLayer(layerId)) return;
    this.map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }

  /* --- Sources/layers --- */

  private setupGeofencesLayer(): void {
    if (!this.map || this.map.getSource('geofences')) return;
    this.map.addSource('geofences', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'geofences-fill',
      type: 'fill',
      source: 'geofences',
      paint: { 'fill-color': ['coalesce', ['get', 'color'], '#10e0a0'], 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: 'geofences-line',
      type: 'line',
      source: 'geofences',
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#10e0a0'],
        'line-width': 2,
        'line-opacity': 0.6,
      },
    });
  }

  private setupTrailsLayer(): void {
    if (!this.map || this.map.getSource('trails')) return;
    this.map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'trails-line',
      type: 'line',
      source: 'trails',
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#10e0a0'],
        'line-width': 4,
        'line-opacity': 0.6,
        'line-dasharray': [2, 1.5],
      },
    });
  }

  /** Sprint D.2 — setup layer pour la polyligne historique 1h (couleur bleue distincte du trail live). */
  private setupMiniReplayLayer(): void {
    if (!this.map || this.map.getSource('mini-replay')) return;
    this.map.addSource('mini-replay', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'mini-replay-line',
      type: 'line',
      source: 'mini-replay',
      paint: {
        'line-color': '#3b82f6',
        'line-width': 5,
        'line-opacity': 0.85,
      },
    });
  }

  /**
   * Sprint G.2 — cluster layer pour les markers vehicules.
   * Quand le zoom est < CLUSTER_ZOOM_THRESHOLD, les markers DOM sont caches
   * et un layer GeoJSON cluster prend le relais (badge avec compteur).
   * Au-dela, les markers DOM riches (heading, plaque, ACC) reapparaissent.
   */
  private setupClusterLayer(): void {
    if (!this.map || this.map.getSource('vehicles-cluster')) return;
    this.map.addSource('vehicles-cluster', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterMaxZoom: 13,
      clusterRadius: 40,
    });
    this.map.addLayer({
      id: 'vehicles-cluster-bg',
      type: 'circle',
      source: 'vehicles-cluster',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#10E0A0',
        'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 50, 28],
        'circle-opacity': 0.9,
        'circle-stroke-width': 3,
        'circle-stroke-color': '#0a0a0a',
      },
    });
    this.map.addLayer({
      id: 'vehicles-cluster-count',
      type: 'symbol',
      source: 'vehicles-cluster',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 13,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#0a0a0a' },
    });
    // Click sur cluster = zoom in.
    this.map.on('click', 'vehicles-cluster-bg', (e) => {
      if (!this.map) return;
      const feat = e.features?.[0];
      const clusterId = feat?.properties?.['cluster_id'];
      if (clusterId == null) return;
      const src = this.map.getSource('vehicles-cluster') as maplibregl.GeoJSONSource;
      Promise.resolve(src.getClusterExpansionZoom(clusterId)).then((zoom: number) => {
        if (!this.map) return;
        const geom = feat?.geometry as GeoJSON.Point | undefined;
        if (!geom) return;
        this.map.flyTo({ center: geom.coordinates as [number, number], zoom, speed: 1.4, curve: 1.4 });
      });
    });
  }

  /** Sprint G.4 — setup layer heatmap des densites de positions sur 24h. */
  private setupHeatmapLayer(): void {
    if (!this.map || this.map.getSource('positions-heatmap')) return;
    this.map.addSource('positions-heatmap', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'positions-heatmap',
      type: 'heatmap',
      source: 'positions-heatmap',
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 14, 1.6],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)',
          0.2, '#10E0A0',
          0.5, '#F59E0B',
          0.8, '#EF4444',
        ],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 14, 30],
        'heatmap-opacity': 0.7,
      },
    });
  }

  /** Sprint F.1 — setup layer pour les stop markers (pictos P aux arrets > 5min). */
  private setupStopsLayer(): void {
    if (!this.map || this.map.getSource('stops')) return;
    this.map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'stops-circle',
      type: 'circle',
      source: 'stops',
      paint: {
        'circle-radius': 14,
        'circle-color': '#1f2937',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fbbf24',
        'circle-opacity': 0.9,
      },
    });
    this.map.addLayer({
      id: 'stops-label',
      type: 'symbol',
      source: 'stops',
      layout: {
        'text-field': 'P',
        'text-size': 14,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#fbbf24',
        'text-halo-color': '#1f2937',
        'text-halo-width': 1,
      },
    });
  }

  /** Sprint D.4 — setup layer pour l'outil de mesure (ligne + points). */
  private setupMeasureLayer(): void {
    if (!this.map || this.map.getSource('measure')) return;
    this.map.addSource('measure', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'measure-line',
      type: 'line',
      source: 'measure',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#a855f7', 'line-width': 3, 'line-dasharray': [3, 2] },
    });
    this.map.addLayer({
      id: 'measure-points',
      type: 'circle',
      source: 'measure',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#a855f7', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
    });
  }

  private async loadGeofences(): Promise<void> {
    if (!this.map) return;
    try {
      const zones = await firstValueFrom(this.geofencesApi.list());
      const features: GeoJSON.Feature[] = [];
      for (const z of zones as GeofenceDto[]) {
        if (!z.active) continue;
        const props = { id: z.id, name: z.name, rule: z.rule, color: z.color ?? '#10e0a0' };
        if (z.type === 'POLYGON' && z.polygonPoints && z.polygonPoints.length >= 3) {
          features.push(polygonFeature(z.polygonPoints, props));
        } else if (z.centerLat != null && z.centerLng != null && z.radiusMeters != null) {
          features.push(circleFeature(z.centerLat, z.centerLng, z.radiusMeters, props));
        }
      }
      const src = this.map.getSource('geofences') as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features });
    } catch { /* silent */ }
  }

  /* --- Markers update --- */

  private applyPositions(positions: PositionUpdateEvent[]): void {
    if (!this.map) return;

    const activeIds = new Set<string>();
    const trailFeatures: Array<GeoJSON.Feature<GeoJSON.LineString, { color: string; trackerId: string }>> = [];
    const followedId = this.followedVehicleId();
    const trailLength = this.preferences.prefs().map.trailLength;
    const showTrails = this.showTrails();
    const hydratedSet = this.realtime.hydratedTrackerIds();
    const showPlatesNow = this.showPlates();

    for (const pos of positions) {
      activeIds.add(pos.trackerId);
      const meta = this.vehicleMeta.get(pos.vehicleId) ?? { type: 'OTHER', plate: '' };
      const data: VehicleMarkerData = {
        trackerId: pos.trackerId,
        vehicleId: pos.vehicleId,
        type: meta.type,
        plate: meta.plate,
        speedKmh: pos.speedKmh,
        heading: pos.heading,
        ignition: pos.ignition,
        active: pos.vehicleId === followedId,
        hydrated: hydratedSet.has(pos.trackerId),
      };

      let entry = this.markers.get(pos.trackerId);
      if (!entry) {
        const el = buildVehicleMarkerEl(data);
        if (!showPlatesNow) el.classList.add('tracky-marker--no-plate');
        const marker = attachVehicleMarker(this.map, el, pos.lat, pos.lng);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.openMarkerPopup(pos.trackerId);
        });
        el.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          this.followedVehicleId.set(pos.vehicleId);
          if (this.cameraMode() === 'free') this.setCameraMode('follow');
          else this.applyCameraMode();
        });
        entry = { marker, el };
        this.markers.set(pos.trackerId, entry);
      } else {
        // Demarrer une interpolation depuis la position courante (lue sur le marker)
        // vers la nouvelle position WS. Anime sur ~28s pour eviter les teleports
        // entre deux trames Coban (cf. spec Sprint C — chantier 3 du roadmap).
        const cur = entry.marker.getLngLat();
        const lastData = this.lastMarkerData.get(pos.trackerId);
        const fromHeading = lastData?.heading ?? pos.heading;
        const isHydrated = data.hydrated === true;
        if (isHydrated || !lastData) {
          // Premier rendu (hydratation ou nouveau tracker) : positionner direct, pas d'anim.
          entry.marker.setLngLat([pos.lng, pos.lat]);
          updateVehicleMarkerEl(entry.el, data);
        } else {
          this.interp.set(pos.trackerId, {
            fromLat: cur.lat, fromLng: cur.lng, fromHeading,
            toLat: pos.lat, toLng: pos.lng, toHeading: pos.heading,
            startedAt: performance.now(), durationMs: INTERP_DURATION_MS,
          });
          // Update les attributs non-positionnels (couleur, ACC, plaque, active)
          // immediatement pour qu'ils refletent le nouvel etat sans attendre l'anim.
          updateVehicleMarkerEl(entry.el, { ...data, heading: fromHeading });
        }
      }
      this.lastMarkerData.set(pos.trackerId, data);

      // Trail accumulation (en memoire, capee a trailLength).
      if (showTrails) {
        let pts = this.trailPoints.get(pos.trackerId);
        if (!pts) {
          pts = [];
          this.trailPoints.set(pos.trackerId, pts);
        }
        pts.push([pos.lng, pos.lat]);
        while (pts.length > trailLength) pts.shift();

        if (pts.length >= 2) {
          // Lissage Catmull-Rom : insere des points intermediaires pour adoucir
          // les coins de virage (la trame Coban tous les 30s coupe les courbes).
          // 6 echantillons par segment garde un rendu fluide sans surcharger
          // (un trail de 20 points devient 19*6+20 = ~134 points GeoJSON).
          const smoothPts = catmullRom(
            pts.map(([lng, lat]) => ({ lat, lng })),
            6,
          ).map((p) => [p.lng, p.lat] as [number, number]);
          trailFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: smoothPts },
            properties: { color: speedColor(pos.speedKmh), trackerId: pos.trackerId },
          });
        }
      }
    }

    // Remove disappeared markers.
    for (const [id, entry] of this.markers) {
      if (!activeIds.has(id)) {
        entry.marker.remove();
        this.markers.delete(id);
        this.trailPoints.delete(id);
      }
    }

    // Update trails source.
    const trailsSrc = this.map.getSource('trails') as maplibregl.GeoJSONSource | undefined;
    trailsSrc?.setData({ type: 'FeatureCollection', features: trailFeatures });

    // Sprint G.2 — alimente la source cluster.
    const clusterSrc = this.map.getSource('vehicles-cluster') as maplibregl.GeoJSONSource | undefined;
    clusterSrc?.setData({
      type: 'FeatureCollection',
      features: positions.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { vehicleId: p.vehicleId, trackerId: p.trackerId },
      })),
    });

    // Auto-fit la premiere fois qu'on a des markers.
    if (!this.hasFittedBounds && this.markers.size > 0) {
      this.hasFittedBounds = true;
      const mapPrefs = this.preferences.prefs().map;
      const defaults = this.preferences.getDefaults().map;
      const isDefaultCenter = mapPrefs.centerLat === defaults.centerLat && mapPrefs.centerLng === defaults.centerLng;
      if (isDefaultCenter) this.centerAll();
    }

    // Camera follow sur le vehicule actif.
    if (this.cameraMode() !== 'free') {
      this.applyCameraMode();
    }

    // Update popover content si ouvert.
    if (this.activePopupTrackerId && this.currentPopup) {
      const pos = positions.find((p) => p.trackerId === this.activePopupTrackerId);
      if (pos) this.currentPopup.setHTML(this.buildPopupHtml(pos));
    }
  }

  /* --- Popover info marker --- */

  private openMarkerPopup(trackerId: string): void {
    const pos = this.realtime.positionsList().find((p) => p.trackerId === trackerId);
    if (!pos || !this.map) return;

    this.closePopup();
    const html = this.buildPopupHtml(pos);
    this.currentPopup = new maplibregl.Popup({
      anchor: 'bottom',
      offset: 30,
      maxWidth: '320px',
      closeOnClick: false,
    })
      .setLngLat([pos.lng, pos.lat])
      .setHTML(html)
      .addTo(this.map);
    this.activePopupTrackerId = trackerId;

    // Wire les boutons du popover (delegation event).
    setTimeout(() => this.wirePopupActions(trackerId, pos.vehicleId), 0);

    this.currentPopup.on('close', () => {
      this.activePopupTrackerId = null;
      this.currentPopup = null;
    });
  }

  private buildPopupHtml(pos: PositionUpdateEvent): string {
    const meta = this.vehicleMeta.get(pos.vehicleId) ?? { type: 'OTHER', plate: '?' };
    const ago = Math.round((Date.now() - new Date(pos.timestamp).getTime()) / 1000);
    const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}min`;
    return `
      <div style="padding:14px;font-family:Inter,sans-serif">
        <div style="font-family:Poppins,sans-serif;font-weight:600;font-size:14px;color:#fff;margin-bottom:2px">
          ${escapeHtml(meta.plate)}
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:10px">
          ${escapeHtml(meta.type)} · il y a ${agoStr}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:11px;color:rgba(255,255,255,0.85)">
          <div>Vitesse : <strong>${pos.speedKmh.toFixed(0)} km/h</strong></div>
          <div>Cap : <strong>${Math.round(pos.heading)}°</strong></div>
          <div>ACC : <strong style="color:${pos.ignition ? '#10E0A0' : '#9ca3af'}">${pos.ignition ? 'ON' : 'OFF'}</strong></div>
          <div style="font-family:JetBrains Mono,monospace;font-size:10px">${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button data-action="follow"
                  style="padding:6px 10px;border-radius:8px;background:rgba(16,224,160,0.15);
                         color:#10E0A0;border:1px solid rgba(16,224,160,0.3);font-size:11px;cursor:pointer">
            Suivre
          </button>
          <button data-action="detail"
                  style="padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.06);
                         color:#fff;border:1px solid rgba(255,255,255,0.1);font-size:11px;cursor:pointer">
            Voir fiche detaillee
          </button>
          <button data-action="replay1h"
                  style="padding:6px 10px;border-radius:8px;background:rgba(59,130,246,0.15);
                         color:#3b82f6;border:1px solid rgba(59,130,246,0.3);font-size:11px;cursor:pointer">
            Voir derniere heure
          </button>
          <div style="display:flex;gap:6px">
            <button data-action="cut"
                    style="flex:1;padding:6px 10px;border-radius:8px;background:rgba(239,68,68,0.15);
                           color:#EF4444;border:1px solid rgba(239,68,68,0.3);font-size:11px;cursor:pointer">
              Couper moteur
            </button>
            <button data-action="restore"
                    style="flex:1;padding:6px 10px;border-radius:8px;background:rgba(16,224,160,0.1);
                           color:#10E0A0;border:1px solid rgba(16,224,160,0.2);font-size:11px;cursor:pointer">
              Restaurer
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private wirePopupActions(trackerId: string, vehicleId: string): void {
    const root = this.currentPopup?.getElement();
    if (!root) return;
    root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
      const action = btn.dataset['action'];
      btn.addEventListener('click', () => {
        switch (action) {
          case 'follow':
            this.followedVehicleId.set(vehicleId);
            if (this.cameraMode() === 'free') this.setCameraMode('follow');
            else this.applyCameraMode();
            this.closePopup();
            break;
          case 'detail':
            this.router.navigate(['/vehicles', vehicleId]);
            break;
          case 'replay1h':
            this.toggleMiniReplay(vehicleId);
            this.closePopup();
            break;
          case 'cut':
            this.requestEngine(trackerId, 'CUT');
            break;
          case 'restore':
            this.requestEngine(trackerId, 'RESTORE');
            break;
        }
      });
    });
  }

  private requestEngine(trackerId: string, action: 'CUT' | 'RESTORE'): void {
    const verb = action === 'CUT' ? 'couper' : 'restaurer';
    const ok = window.confirm(
      `Confirmer ${verb} le moteur du vehicule ?\n\n` +
        'Cette action est tracee dans l\'audit trail. Annulez si pas certain.',
    );
    if (!ok) return;

    this.engineControl.requestCommand(trackerId, action, 'depuis carte').subscribe({
      next: () => {
        this.toast.show({
          kind: 'info',
          title: action === 'CUT' ? 'Coupure demandee' : 'Restauration demandee',
          message: `Commande ${action} envoyee.`,
          duration: 4000,
        });
        this.closePopup();
      },
      error: (err) => {
        this.toast.show({
          kind: 'error',
          title: 'Echec commande moteur',
          message: err?.error?.message ?? 'Erreur inconnue',
          duration: 6000,
        });
      },
    });
  }

  private closePopup(): void {
    this.currentPopup?.remove();
    this.currentPopup = null;
    this.activePopupTrackerId = null;
  }

  /* --- Search Nominatim --- */

  protected onSearchInput(ev: Event): void {
    this.searchQuery.set((ev.target as HTMLInputElement).value);
  }

  /** Sprint G.1 — delai pour permettre au mousedown du dropdown de tirer avant le blur. */
  protected onSearchBlur(): void {
    setTimeout(() => this.searchFocused.set(false), 150);
  }

  /** Sprint G.1 — saut sur un vehicule depuis les suggestions. */
  protected jumpToVehicle(vehicleId: string): void {
    if (!this.map) return;
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === vehicleId);
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === vehicleId);
    const lat = pos?.lat ?? snap?.lastLat;
    const lng = pos?.lng ?? snap?.lastLng;
    if (lat == null || lng == null) {
      this.toast.show({ kind: 'warning', title: 'Position inconnue', duration: 3000 });
      return;
    }
    this.mapSvc.flyTo(this.map, lat, lng, 16);
    this.searchQuery.set('');
    this.searchFocused.set(false);
  }

  protected async searchAddress(ev: Event): Promise<void> {
    ev.preventDefault();
    const q = this.searchQuery().trim();
    if (!q || !this.map) return;

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
      const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      if (data.length === 0) {
        this.toast.show({ kind: 'warning', title: 'Adresse introuvable', duration: 4000 });
        return;
      }
      const hit = data[0]!;
      this.mapSvc.flyTo(this.map, parseFloat(hit.lat), parseFloat(hit.lon), 15);
    } catch (err) {
      this.toast.show({ kind: 'error', title: 'Recherche impossible', duration: 4000 });
      void err;
    }
  }

  /* --- Context menu --- */

  protected closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  protected copyCoords(): void {
    const ctx = this.contextMenu();
    if (!ctx) return;
    const text = `${ctx.lat.toFixed(6)}, ${ctx.lng.toFixed(6)}`;
    navigator.clipboard?.writeText(text).then(
      () => this.toast.show({ kind: 'info', title: 'Coordonnees copiees', message: text, duration: 3000 }),
      () => { /* noop */ },
    );
  }

  protected centerHere(): void {
    const ctx = this.contextMenu();
    if (!ctx || !this.map) return;
    this.mapSvc.flyTo(this.map, ctx.lat, ctx.lng);
  }

  /* --- Fullscreen & shortcuts --- */

  protected toggleFullscreen(): void {
    const el = this.mapContainerRef().nativeElement.parentElement ?? this.mapContainerRef().nativeElement;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.();
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(ev: KeyboardEvent): void {
    // Eviter les raccourcis quand on est dans un input.
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch (ev.key.toLowerCase()) {
      case 'f': ev.preventDefault(); this.toggleFullscreen(); break;
      case 'c': ev.preventDefault(); this.resetNorth(); break;
      case 'o': ev.preventDefault(); this.centerAll(); break;
      case 'm': {
        ev.preventDefault();
        const idx = this.cameraModes.findIndex((m) => m.id === this.cameraMode());
        const next = this.cameraModes[(idx + 1) % this.cameraModes.length]!;
        this.setCameraMode(next.id);
        break;
      }
    }
  }
}

/* --- Helpers --- */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;',
  );
}

/**
 * Construit un Polygon GeoJSON approximant un cercle (64 segments) autour
 * d'un centre lat/lng et rayon en metres. Utilise pour les geofences.
 */
/** Sprint F.2 — feature GeoJSON pour un polygone defini par ses sommets. */
function polygonFeature(
  points: Array<{ lat: number; lng: number }>,
  props: Record<string, unknown>,
): GeoJSON.Feature<GeoJSON.Polygon, Record<string, unknown>> {
  const ring: Array<[number, number]> = points.map((p) => [p.lng, p.lat]);
  // Fermer le polygone (premier == dernier).
  if (ring.length > 0 && (ring[0]![0] !== ring[ring.length - 1]![0] || ring[0]![1] !== ring[ring.length - 1]![1])) {
    ring.push(ring[0]!);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: props,
  };
}

function circleFeature(
  centerLat: number,
  centerLng: number,
  radiusM: number,
  props: Record<string, unknown>,
): GeoJSON.Feature<GeoJSON.Polygon, Record<string, unknown>> {
  const points = 64;
  const km = radiusM / 1000;
  const distanceX = km / (111.320 * Math.cos((centerLat * Math.PI) / 180));
  const distanceY = km / 110.574;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    const x = distanceX * Math.cos(theta);
    const y = distanceY * Math.sin(theta);
    ring.push([centerLng + x, centerLat + y]);
  }
  ring.push(ring[0]!);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: props,
  };
}
