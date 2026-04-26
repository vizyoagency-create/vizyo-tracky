import {
  AfterViewInit,
  Component,
  effect,
  ElementRef,
  HostListener,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule, Play, Pause, X } from 'lucide-angular';
import * as L from 'leaflet';
import type { TripDto } from '@vizyo/tracky-shared';
import { isValidLatLng, haversineMeters } from '@vizyo/tracky-shared';
import { createTrackyIcon } from '../../shared/utils/leaflet-markers';

@Component({
  selector: 'app-trip-replay',
  standalone: true,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex flex-col">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" (click)="onClose()"></div>
        <div class="relative flex-1 flex flex-col m-4 bg-bg-secondary border border-border-subtle
                    rounded-[--radius-card] overflow-hidden">

          <div class="flex items-center justify-between px-6 py-3 border-b border-border-subtle shrink-0">
            <div class="text-sm text-fg-primary">
              <strong>Replay trajet</strong>
              @if (trip()) {
                <span class="text-fg-tertiary ml-2">
                  {{ (trip()!.distanceMeters / 1000) | number:'1.1-1' }} km ·
                  {{ formatDur(trip()!.durationSeconds) }} ·
                  max {{ trip()!.maxSpeed | number:'1.0-0' }} km/h
                </span>
              }
            </div>
            <button (click)="onClose()" class="text-fg-tertiary hover:text-fg-primary cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <div #mapContainer class="flex-1"></div>

          <div class="flex items-center gap-4 px-6 py-3 border-t border-border-subtle shrink-0">
            <button (click)="togglePlay()" class="text-tracky-light cursor-pointer">
              @if (playing()) {
                <lucide-icon [img]="PauseIcon" [size]="20"></lucide-icon>
              } @else {
                <lucide-icon [img]="PlayIcon" [size]="20"></lucide-icon>
              }
            </button>
            <input type="range" [min]="0" [max]="pointCount() - 1" [value]="currentIndex()"
                   (input)="seekTo($event)" class="flex-1 accent-[var(--color-tracky)]" />
            <div class="flex gap-1">
              @for (s of speeds; track s) {
                <button (click)="speed.set(s)"
                        class="px-2 py-0.5 text-xs rounded cursor-pointer"
                        [class]="speed() === s ? 'bg-tracky/20 text-tracky-light' : 'text-fg-tertiary'">
                  {{ s }}x
                </button>
              }
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    @keyframes tracky-ping { 75%, 100% { transform: scale(2); opacity: 0; } }
  `],
})
export class TripReplayComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly trip = input<TripDto | null>(null);
  readonly vehicleType = input<string>('OTHER');
  readonly closed = output<void>();

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');
  protected readonly playing = signal(false);
  protected readonly currentIndex = signal(0);
  protected readonly speed = signal(1);
  protected readonly pointCount = signal(0);

  protected readonly PlayIcon = Play;
  protected readonly PauseIcon = Pause;
  protected readonly XIcon = X;
  protected readonly speeds = [1, 2, 4, 8];

  private map: L.Map | null = null;
  private polyline: L.Polyline | null = null;
  private marker: L.Marker | null = null;
  private points: L.LatLng[] = [];
  private animId: number | null = null;
  private lastFrameTime = 0;
  private floatIndex = 0;

  private initEffect = effect(() => {
    const t = this.trip();
    const isOpen = this.open();
    if (isOpen && t) {
      setTimeout(() => this.initReplay(t), 100);
    }
  });

  @HostListener('document:keydown.escape')
  onEscape() { if (this.open()) this.onClose(); }

  ngAfterViewInit(): void {}

  ngOnDestroy(): void {
    this.cleanup();
  }

  protected onClose(): void {
    this.cleanup();
    this.closed.emit();
  }

  protected togglePlay(): void {
    if (this.playing()) {
      this.playing.set(false);
      if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    } else {
      this.playing.set(true);
      this.lastFrameTime = performance.now();
      this.floatIndex = this.currentIndex();
      this.animate();
    }
  }

  protected seekTo(event: Event): void {
    const idx = parseInt((event.target as HTMLInputElement).value, 10);
    this.floatIndex = idx;
    this.currentIndex.set(idx);
    if (this.points[idx] && this.marker) {
      this.marker.setLatLng(this.points[idx]!);
    }
  }

  protected formatDur(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
  }

  private initReplay(trip: TripDto): void {
    this.cleanup();

    const el = this.mapRef()?.nativeElement;
    if (!el) return;

    let parsed: Array<{ lat: number; lng: number }> = [];
    try {
      parsed = trip.polyline ? JSON.parse(trip.polyline) : [];
    } catch { /* */ }

    if (parsed.length === 0) {
      parsed = [{ lat: trip.startLat, lng: trip.startLng }];
      if (trip.endLat != null && trip.endLng != null) {
        parsed.push({ lat: trip.endLat, lng: trip.endLng });
      }
    }

    // Garde-fou cote frontend (defense en profondeur) : meme si la backend a
    // deja sanitize, on filtre les points invalides et les sauts trop longs
    // entre points consecutifs (heuristique : > 5 km est presque toujours
    // un saut GPS pour un point intermediaire d'une polyligne).
    const cleaned: Array<{ lat: number; lng: number }> = [];
    for (const p of parsed) {
      if (!isValidLatLng(p.lat, p.lng)) continue;
      const last = cleaned[cleaned.length - 1];
      if (last && haversineMeters(last.lat, last.lng, p.lat, p.lng) > 5000) continue;
      cleaned.push(p);
    }

    this.points = cleaned.map((p) => L.latLng(p.lat, p.lng));
    this.pointCount.set(this.points.length);
    this.currentIndex.set(0);

    this.map = L.map(el, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(this.map);

    this.polyline = L.polyline(this.points, {
      color: '#10E0A0',
      weight: 4,
      opacity: 0.8,
    }).addTo(this.map);

    if (this.points.length > 0) {
      this.marker = L.marker(this.points[0]!, {
        icon: createTrackyIcon(0, 0, this.vehicleType()),
      }).addTo(this.map);

      this.map.fitBounds(this.polyline.getBounds(), { padding: [40, 40] });
    }

    setTimeout(() => this.map?.invalidateSize(), 200);
  }

  private animate(): void {
    if (!this.playing()) return;

    const now = performance.now();
    const delta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const replayDurationSeconds = 30;
    const pointsPerSecond = this.points.length / replayDurationSeconds;
    const step = delta * this.speed() * pointsPerSecond;
    let idx = this.floatIndex + step;

    if (idx >= this.points.length - 1) {
      idx = this.points.length - 1;
      this.playing.set(false);
    }

    this.floatIndex = idx;
    this.currentIndex.set(Math.round(idx));
    const pt = this.points[Math.round(idx)];
    if (pt && this.marker) {
      this.marker.setLatLng(pt);
    }

    if (this.playing()) {
      this.animId = requestAnimationFrame(() => this.animate());
    }
  }

  private cleanup(): void {
    this.playing.set(false);
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    this.marker?.remove();
    this.polyline?.remove();
    if (this.map) { this.map.remove(); this.map = null; }
    this.marker = null;
    this.polyline = null;
    this.points = [];
  }
}
