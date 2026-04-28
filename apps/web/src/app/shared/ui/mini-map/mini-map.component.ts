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
      <div class="w-full rounded-[--radius-card] border border-border-subtle bg-bg-secondary
                  flex items-center justify-center text-fg-tertiary text-sm"
           [style.height]="height()">
        Aucune position connue
      </div>
    }
  `,
  styles: [`:host { display: block; }`],
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
