import {
  AfterViewInit,
  Component,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import type { GeofenceDto, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { GeofencesApiService } from '../../core/services/geofences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehiclesApiService } from '../../core/services/vehicles.service';

function speedColor(speed: number): string {
  if (speed <= 0) return '#5C746C';
  if (speed <= 50) return '#10E0A0';
  if (speed <= 90) return '#F59E0B';
  return '#EF4444';
}

function createIcon(speed: number, heading: number): L.DivIcon {
  const color = speedColor(speed);
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:44px;height:44px">
      <div style="position:absolute;inset:-4px;border-radius:9999px;background:${color};opacity:0.3;animation:tracky-ping 1.5s cubic-bezier(0,0,0.2,1) infinite"></div>
      <div style="position:relative;width:44px;height:44px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4),0 0 20px ${color}60">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="white" style="transform:rotate(${Math.round(heading)}deg);filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))">
          <path d="M12 2 L5 20 L12 15 L19 20 Z"/>
        </svg>
      </div>
    </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

@Component({
  selector: 'app-map',
  standalone: true,
  template: `
    <div #mapContainer style="position:absolute;top:0;left:0;width:100%;height:100%"></div>

    <div style="position:absolute;top:16px;left:16px;z-index:1000">
      <div class="bg-bg-secondary/80 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-4 min-w-[200px]">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-display font-semibold text-fg-primary">Suivi temps reel</h3>
          @if (realtime.connected()) {
            <span class="w-2 h-2 rounded-full bg-tracky-light animate-pulse"></span>
          } @else {
            <span class="w-2 h-2 rounded-full bg-fg-tertiary animate-pulse"></span>
          }
        </div>
        <p class="text-xs text-fg-secondary">
          {{ realtime.positionsList().length }} vehicule(s) actif(s)
        </p>
        <button
          (click)="centerAll()"
          class="mt-3 w-full text-xs font-medium py-1.5 rounded-lg
                 bg-tracky/20 text-tracky-light border border-tracky/30
                 hover:bg-tracky/30 transition-colors cursor-pointer">
          Centrer
        </button>
      </div>
    </div>

    <div style="position:absolute;bottom:24px;right:16px;z-index:1000">
      <div class="bg-bg-secondary/80 backdrop-blur-md border border-border-subtle
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
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
    @keyframes tracky-ping {
      75%, 100% { transform: scale(2); opacity: 0; }
    }
  `],
})
export class MapComponent implements AfterViewInit, OnDestroy {
  protected readonly realtime = inject(RealtimeService);
  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly mapContainerRef = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  private map: L.Map | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private markers = new Map<string, L.Marker>();
  private trails = new Map<string, L.Polyline>();
  private trailPoints = new Map<string, L.LatLng[]>();
  private geofenceCircles = new Map<string, L.Circle>();
  private hasFittedBounds = false;
  private accessibleVehicleIds: Set<string> | 'ALL' = 'ALL';

  private positionsEffect = effect(() => {
    const all = this.realtime.positionsList();
    const positions = this.accessibleVehicleIds === 'ALL'
      ? all
      : all.filter((p) => (this.accessibleVehicleIds as Set<string>).has(p.vehicleId));
    if (!this.map || positions.length === 0) return;
    this.updateMarkers(positions);
  });

  ngAfterViewInit(): void {
    setTimeout(() => this.initMap(), 0);
    firstValueFrom(this.vehiclesApi.list()).then((vehicles) => {
      this.accessibleVehicleIds = new Set(vehicles.map((v) => v.id));
    }).catch(() => { /* fallback to ALL */ });
  }

  private initMap(): void {
    const container = this.mapContainerRef().nativeElement;

    this.map = L.map(container, {
      center: [33.5731, -7.5898],
      zoom: 12,
      zoomControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(this.map);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    this.resizeObserver = new ResizeObserver(() => {
      this.map?.invalidateSize();
    });
    this.resizeObserver.observe(container);

    this.loadGeofences();

    this.map.invalidateSize();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.markers.forEach((m) => m.remove());
    this.trails.forEach((t) => t.remove());
    this.geofenceCircles.forEach((c) => c.remove());
    this.markers.clear();
    this.trails.clear();
    this.trailPoints.clear();
    this.geofenceCircles.clear();

    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  centerAll(): void {
    if (!this.map || this.markers.size === 0) return;
    const bounds = L.latLngBounds(
      Array.from(this.markers.values()).map((m) => m.getLatLng()),
    );
    this.map.fitBounds(bounds, { padding: [50, 50] });
  }

  private updateMarkers(positions: PositionUpdateEvent[]): void {
    const activeIds = new Set<string>();

    for (const pos of positions) {
      activeIds.add(pos.trackerId);
      const latLng = L.latLng(pos.lat, pos.lng);

      const existing = this.markers.get(pos.trackerId);
      if (existing) {
        existing.setLatLng(latLng);
        existing.setIcon(createIcon(pos.speedKmh, pos.heading));
        existing.setPopupContent(this.popupContent(pos));
      } else {
        const marker = L.marker(latLng, { icon: createIcon(pos.speedKmh, pos.heading) })
          .addTo(this.map!)
          .bindPopup(this.popupContent(pos));
        this.markers.set(pos.trackerId, marker);
      }

      let points = this.trailPoints.get(pos.trackerId);
      if (!points) {
        points = [];
        this.trailPoints.set(pos.trackerId, points);
      }
      points.push(latLng);
      if (points.length > 20) points.shift();

      const color = speedColor(pos.speedKmh);
      const trail = this.trails.get(pos.trackerId);
      if (trail) {
        trail.setLatLngs(points);
        trail.setStyle({ color });
      } else {
        const polyline = L.polyline(points, {
          color,
          weight: 4,
          opacity: 0.6,
          dashArray: '8,6',
        }).addTo(this.map!);
        this.trails.set(pos.trackerId, polyline);
      }
    }

    for (const [id, marker] of this.markers) {
      if (!activeIds.has(id)) {
        marker.remove();
        this.markers.delete(id);
        this.trails.get(id)?.remove();
        this.trails.delete(id);
        this.trailPoints.delete(id);
      }
    }

    if (!this.hasFittedBounds && this.markers.size > 0) {
      this.hasFittedBounds = true;
      this.centerAll();
    }
  }

  private async loadGeofences(): Promise<void> {
    if (!this.map) return;
    try {
      const zones = await firstValueFrom(this.geofencesApi.list());
      for (const z of zones) {
        if (!z.active || !z.centerLat || !z.centerLng) continue;
        const circle = L.circle([z.centerLat, z.centerLng], {
          radius: z.radiusMeters,
          color: z.color ?? '#10e0a0',
          fillColor: z.color ?? '#10e0a0',
          fillOpacity: 0.12,
          weight: 2,
          opacity: 0.6,
        }).addTo(this.map);
        circle.bindTooltip(`${z.name} (${z.rule})`, { sticky: true });
        this.geofenceCircles.set(z.id, circle);
      }
    } catch { /* silent */ }
  }

  private popupContent(pos: PositionUpdateEvent): string {
    const ago = Math.round((Date.now() - new Date(pos.timestamp).getTime()) / 1000);
    return `<div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.6">
      <strong style="font-family:monospace">${pos.trackerId.slice(0, 8)}...</strong><br>
      Vitesse : <strong>${pos.speedKmh.toFixed(0)} km/h</strong><br>
      Position : ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}<br>
      <span style="color:#888">il y a ${ago}s</span><br>
      <a href="/vehicles/${pos.vehicleId}" style="color:#10E0A0;text-decoration:underline;font-size:11px">Voir fiche vehicule</a>
    </div>`;
  }
}
