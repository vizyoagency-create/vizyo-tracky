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
import { Router } from '@angular/router';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker, Popup } from 'maplibre-gl';
import type { GeofenceDto, PositionUpdateEvent } from '@vizyo/tracky-shared';
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
  template: `
    <div #mapContainer style="position:absolute;top:0;left:0;width:100%;height:100%"></div>

    <!-- HUD top-left : statut realtime -->
    <div style="position:absolute;top:16px;left:16px;z-index:1000">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-4 min-w-[220px]">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-display font-semibold text-fg-primary">Suivi temps reel</h3>
          @if (realtime.connected()) {
            <span class="w-2 h-2 rounded-full bg-tracky-light animate-pulse"></span>
          } @else {
            <span class="w-2 h-2 rounded-full bg-fg-tertiary animate-pulse"></span>
          }
        </div>
        <p class="text-xs text-fg-secondary">
          {{ filteredPositionCount() }} vehicule(s) actif(s)
          @if (cameraMode() !== 'free' && followedVehicleId()) {
            · <span class="text-tracky-light">Suivi : {{ followedPlate() }}</span>
          }
        </p>
        <div class="flex gap-1.5 mt-3">
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
      </div>

      <!-- Search bar (Nominatim) -->
      <div class="mt-2 bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 min-w-[220px]">
        <input
          type="search"
          placeholder="Rechercher une adresse..."
          [value]="searchQuery()"
          (keydown.enter)="searchAddress($event)"
          (input)="onSearchInput($event)"
          class="w-full bg-transparent text-xs text-fg-primary placeholder:text-fg-tertiary
                 px-2 py-1.5 outline-none" />
      </div>
    </div>

    <!-- Style picker top-right -->
    <div style="position:absolute;top:16px;right:16px;z-index:1000">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 flex gap-1">
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
                  rounded-[--radius-card] p-2 flex gap-1">
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

    <!-- Calques (filtres statut) - bottom-left -->
    <div style="position:absolute;bottom:90px;left:16px;z-index:1000">
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
        <span class="text-xs text-fg-secondary">Connexion temps reel interrompue...</span>
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

  protected readonly showGeofences = signal(true);
  protected readonly showTrails = signal(true);
  protected readonly showPlates = signal(true);

  protected readonly filters = signal<{ moving: boolean; idle: boolean; off: boolean; offline: boolean }>({
    moving: true, idle: true, off: true, offline: true,
  });

  protected readonly contextMenu = signal<{ x: number; y: number; lat: number; lng: number } | null>(null);

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

    this.map.on('click', () => this.closeContextMenu());

    // Setup sources/layers de base apres `load`.
    this.map.on('load', () => {
      this.setupGeofencesLayer();
      this.setupTrailsLayer();
      this.loadGeofences();
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
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
      this.loadGeofences();
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
    });
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

  private async loadGeofences(): Promise<void> {
    if (!this.map) return;
    try {
      const zones = await firstValueFrom(this.geofencesApi.list());
      const features = (zones as GeofenceDto[])
        .filter((z) => z.active && z.centerLat != null && z.centerLng != null && z.radiusMeters != null)
        .map((z) => circleFeature(z.centerLat!, z.centerLng!, z.radiusMeters!, {
          id: z.id, name: z.name, rule: z.rule, color: z.color ?? '#10e0a0',
        }));
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
