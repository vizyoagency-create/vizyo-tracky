import {
  AfterViewInit,
  Component,
  effect,
  ElementRef,
  input,
  OnDestroy,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { createTrackyIcon, speedColor } from '../../utils/leaflet-markers';

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
  styles: [`
    :host { display: block; }
    @keyframes tracky-ping {
      75%, 100% { transform: scale(2); opacity: 0; }
    }
  `],
})
export class MiniMapComponent implements AfterViewInit, OnDestroy {
  readonly center = input<{ lat: number; lng: number } | null>(null);
  readonly trail = input<{ lat: number; lng: number }[]>([]);
  readonly speedKmh = input(0);
  readonly zoom = input(15);
  readonly height = input('300px');

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');

  private map: L.Map | null = null;
  private marker: L.Marker | null = null;
  private trailLine: L.Polyline | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private updateEffect = effect(() => {
    const c = this.center();
    const t = this.trail();
    const speed = this.speedKmh();
    if (!this.map || !c) return;

    const latLng = L.latLng(c.lat, c.lng);

    if (this.marker) {
      this.marker.setLatLng(latLng);
      this.marker.setIcon(createTrackyIcon(speed));
    } else {
      this.marker = L.marker(latLng, { icon: createTrackyIcon(speed) }).addTo(this.map);
    }

    this.map.setView(latLng, this.map.getZoom());

    if (t.length > 0) {
      const points = t.map((p) => L.latLng(p.lat, p.lng));
      if (this.trailLine) {
        this.trailLine.setLatLngs(points);
        this.trailLine.setStyle({ color: speedColor(speed) });
      } else {
        this.trailLine = L.polyline(points, {
          color: speedColor(speed),
          weight: 3,
          opacity: 0.5,
          dashArray: '6,4',
        }).addTo(this.map);
      }
    }
  });

  ngAfterViewInit(): void {
    setTimeout(() => this.initMap(), 0);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.marker?.remove();
    this.trailLine?.remove();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  private initMap(): void {
    const el = this.mapRef()?.nativeElement;
    if (!el) return;

    const c = this.center();
    const initialCenter: L.LatLngExpression = c ? [c.lat, c.lng] : [33.57, -7.59];

    this.map = L.map(el, {
      center: initialCenter,
      zoom: this.zoom(),
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(this.map);

    this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
    this.resizeObserver.observe(el);
  }
}
