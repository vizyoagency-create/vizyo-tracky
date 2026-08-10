import {
  AfterViewInit,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker, GeoJSONSource } from 'maplibre-gl';
import { MapService } from '../../../core/services/map.service';
import { PreferencesService } from '../../../core/services/preferences.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  speedColor,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../utils/maplibre-markers';

@Component({
  selector: 'app-mini-map',
  standalone: true,
  template: `
    @if (center()) {
      <div #mapContainer class="w-full rounded-[--radius-card] overflow-hidden border border-border-subtle"
           [style.height]="height()"></div>
    } @else {
      <!-- « Une mini-carte grise sans explication ressemble à un bug de chargement »
           (Kit Partage). Le vide DIT donc pourquoi il est vide : sans raison, le
           lecteur attend, recharge, puis ouvre un ticket. Le contour tireté distingue
           l'absence d'une carte qui n'a pas fini de charger. -->
      <div class="mm-vide"
           [style.height]="height()"
           role="status">
        <p class="mm-vide-t">Aucune position connue</p>
        <p class="mm-vide-d">{{ raisonVide() }}</p>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .mm-vide {
      width: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3px; padding: 12px; text-align: center;
      background: var(--bg-secondary);
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-card, 16px);
    }
    .mm-vide-t { margin: 0; font-size: .84rem; font-weight: 600; color: var(--fg-secondary) }
    .mm-vide-d { margin: 0; max-width: 34ch; font-size: .74rem; line-height: 1.4; color: var(--fg-tertiary) }
  `],
})
export class MiniMapComponent implements AfterViewInit, OnDestroy {
  readonly center = input<{ lat: number; lng: number } | null>(null);
  readonly trail = input<{ lat: number; lng: number }[]>([]);
  readonly speedKmh = input(0);
  readonly heading = input(0);
  readonly vehicleType = input<string>('OTHER');
  readonly plate = input<string>('');
  readonly ignition = input(true);
  readonly zoom = input(15);
  readonly height = input('300px');
  /** Sprint 3 — false = carte figée (pan/zoom/rotation désactivés), pour le veilleur de nuit. */
  readonly interactive = input(true);
  /**
   * Pourquoi il n'y a pas de position. L'appelant le sait — boîtier absent, mode privé,
   * véhicule muet depuis des semaines — et c'est la seule chose qui distingue une carte
   * vide d'une carte cassée.
   */
  readonly raisonVide = input<string>(
    'Le boîtier n\'a encore transmis aucune position, ou le véhicule est en mode vie privée.',
  );

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly mapSvc = inject(MapService);
  private readonly preferences = inject(PreferencesService);

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;
  private markerEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Signal qui déclenche l'effect une fois la carte initialisée. */
  private readonly mapReady = signal(false);

  private updateEffect = effect(() => {
    const c = this.center();
    const t = this.trail();
    const speed = this.speedKmh();
    const heading = this.heading();
    const ign = this.ignition();
    const type = this.vehicleType();
    const plate = this.plate();
    const ready = this.mapReady(); // tracké par l'effect

    if (!this.map || !c || !ready) return;

    const data: VehicleMarkerData = {
      trackerId: '',
      vehicleId: '',
      type,
      plate,
      speedKmh: speed,
      heading,
      ignition: ign,
      active: false,
    };

    if (this.marker && this.markerEl) {
      this.marker.setLngLat([c.lng, c.lat]);
      updateVehicleMarkerEl(this.markerEl, data);
    } else {
      this.markerEl = buildVehicleMarkerEl(data);
      this.markerEl.classList.add('tracky-marker--no-plate');
      this.marker = attachVehicleMarker(this.map, this.markerEl, c.lat, c.lng);
    }

    // Recentrer la mini-carte sur le vehicule (zoom inchange).
    this.map.easeTo({ center: [c.lng, c.lat], duration: 300 });

    // Update trail layer.
    const src = this.map.getSource('mini-trail') as GeoJSONSource | undefined;
    if (src && t.length >= 2) {
      src.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.map((p) => [p.lng, p.lat]) },
        properties: { color: speedColor(speed) },
      });
    } else if (src) {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  });

  ngAfterViewInit(): void {
    setTimeout(() => this.initMap(), 0);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.marker?.remove();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  private initMap(): void {
    const el = this.mapRef()?.nativeElement;
    if (!el) return;

    const c = this.center();
    const center = c ?? { lat: 33.57, lng: -7.59 };
    const styleId = this.preferences.prefs().map.style;

    this.map = this.mapSvc.createMap(el, {
      center,
      zoom: this.zoom(),
      style: styleId,
      withNavigationControl: false,
      withGeolocateControl: false,
      withScaleControl: false,
    });

    if (!this.interactive()) {
      // Sprint 3 — mini-carte non-interactive : figée sur la dernière position connue,
      // sans pan/zoom/rotation (le veilleur « voit où est le véhicule » sans manipuler la carte).
      this.map.dragPan.disable();
      this.map.scrollZoom.disable();
      this.map.boxZoom.disable();
      this.map.doubleClickZoom.disable();
      this.map.touchZoomRotate.disable();
      this.map.dragRotate.disable();
      this.map.keyboard.disable();
    }

    this.map.on('load', () => {
      // Mini trail layer.
      this.map!.addSource('mini-trail', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map!.addLayer({
        id: 'mini-trail-line',
        type: 'line',
        source: 'mini-trail',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#10e0a0'],
          'line-width': 3,
          'line-opacity': 0.55,
          'line-dasharray': [2, 1.5],
        },
      });
    });

    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(el);
    this.mapReady.set(true);
    void maplibregl;
  }
}
