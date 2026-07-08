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
import { DecimalPipe } from '@angular/common';
import { LucideAngularModule, Play, Pause, X, MessageSquare, Pencil } from 'lucide-angular';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import type { TripAnalysisDto, TripDto } from '@vizyo/tracky-shared';
import { isValidLatLng, haversineMeters } from '@vizyo/tracky-shared';
import { MapService } from '../../core/services/map.service';
import { PreferencesService } from '../../core/services/preferences.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../shared/utils/maplibre-markers';

@Component({
  selector: 'app-trip-replay',
  standalone: true,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex flex-col tr-replay-shell">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" (click)="onClose()"></div>
        <div class="relative flex-1 flex flex-col bg-bg-secondary border border-border-subtle
                    rounded-[--radius-card] overflow-hidden tr-replay-card">

          <div class="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border-subtle shrink-0 gap-3">
            <div class="text-sm text-fg-primary min-w-0 flex-1">
              <div>
                <strong>Replay trajet</strong>
                @if (trip()) {
                  <span class="text-fg-tertiary ml-2">
                    {{ (max0(trip()!.distanceMeters) / 1000) | number:'1.1-1' }} km ·
                    {{ formatDur(trip()!.durationSeconds) }} ·
                    max {{ clampSpeed(trip()!.maxSpeed) | number:'1.0-0' }} km/h
                  </span>
                  @if (trip()!.polylineMatched) {
                    <span class="ml-2 inline-block px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300
                                 border border-blue-500/30 text-[9px] uppercase tracking-wider">
                      Snap-to-road
                    </span>
                  }
                }
              </div>
              @if (analysis(); as a) {
                <div class="tr-analysis-summary">
                  <span class="tr-as-chip" [attr.data-tier]="ecoTier(a.ecoScore)">🍃 Éco {{ a.ecoScore }}</span>
                  @if (a.stopCount > 0) { <span class="tr-as-chip tr-as-chip--stop">🅿 {{ a.stopCount }} arrêt{{ a.stopCount > 1 ? 's' : '' }}</span> }
                  @if (a.speedingCount > 0) { <span class="tr-as-chip tr-as-chip--speed" [title]="speedingTitle(a)">⚠ {{ a.speedingCount }} excès@if (a.limitsKnown && a.maxOverKmh > 0) { <span class="opacity-80"> +{{ a.maxOverKmh | number:'1.0-0' }}</span> }</span> }
                  @if (a.fuelLiters != null) { <span class="tr-as-chip">⛽ {{ a.fuelLiters | number:'1.1-1' }} L</span> }
                </div>
              }
              <!-- Bandeau driver + note : visibles si presents OU si role autorise. -->
              <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                @if (trip()?.driver) {
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px]
                               font-semibold border"
                        [style.background]="'color-mix(in srgb, ' + (trip()!.driver!.color || '#10E0A0') + ' 12%, transparent)'"
                        [style.border-color]="'color-mix(in srgb, ' + (trip()!.driver!.color || '#10E0A0') + ' 30%, transparent)'"
                        [style.color]="'var(--fg-primary)'">
                    <span class="inline-block w-2 h-2 rounded-full"
                          [style.background]="trip()!.driver!.color || '#10E0A0'"></span>
                    {{ trip()!.driver!.firstName }} {{ trip()!.driver!.lastName }}
                  </span>
                }
                @if (trip()?.notes) {
                  <span class="flex items-center gap-1.5 text-xs min-w-0">
                    <lucide-icon [img]="MessageSquareIcon" [size]="12" class="text-tracky-light shrink-0"></lucide-icon>
                    <span class="text-fg-secondary truncate">{{ trip()!.notes }}</span>
                    @if (canEditNote()) {
                      <button type="button" (click)="onEditNoteClick()"
                              class="text-fg-tertiary hover:text-tracky-light cursor-pointer shrink-0"
                              title="Modifier la note">
                        <lucide-icon [img]="PencilIcon" [size]="11"></lucide-icon>
                      </button>
                    }
                  </span>
                } @else if (canEditNote()) {
                  <button type="button" (click)="onEditNoteClick()"
                          class="inline-flex items-center gap-1 text-[11px] text-fg-tertiary
                                 hover:text-tracky-light cursor-pointer">
                    <lucide-icon [img]="MessageSquareIcon" [size]="11"></lucide-icon>
                    Ajouter une note
                  </button>
                }
              </div>
            </div>
            <button (click)="onClose()"
                    aria-label="Fermer le replay"
                    class="tr-replay-close shrink-0 inline-flex items-center justify-center
                           w-9 h-9 rounded-full bg-bg-tertiary/80 backdrop-blur-sm
                           text-fg-secondary hover:text-fg-primary hover:bg-bg-tertiary
                           border border-border-subtle cursor-pointer transition-colors">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Container carte : flex-1 en flow normal (PAS absolute inset-0).
               MapLibre s'initialise mal dans un absolute au sein d'un parent
               flex — bug silencieux de canvas blanc constaté en prod (idem
               period-replay). Le min-h évite un collapse à 0 au tick d'init. -->
          <div class="relative flex-1 flex flex-col min-h-[280px]">
            <div #mapContainer class="flex-1"></div>
            @if (analysis(); as a) {
              @if (a.stopCount > 0 || a.speedingCount > 0) {
                <div class="tr-legend">
                  @if (a.stopCount > 0) { <span><i class="tr-dot tr-dot--stop"></i> Arrêt</span> }
                  @if (a.speedingCount > 0) { <span><i class="tr-dot tr-dot--speed"></i> Excès de vitesse</span> }
                </div>
              }
            }
          </div>

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
    /* Safe-area iOS PWA standalone : evite que le bouton X / le header soient
       caches sous l'island/notch ou sous la home indicator. Le shell reserve
       l'espace via padding ; la carte reste plein-shell visuellement. */
    .tr-replay-shell {
      /* La top-bar de l'app (z-1800) repeint par-dessus le replay sur iOS (stacking
         context piege). On descend le contenu SOUS la top-bar (hauteur 56px + safe-area
         + 10px = env+66px) pour que le bouton X reste atteignable. */
      padding-top: calc(env(safe-area-inset-top) + 70px);
      padding-bottom: max(1rem, env(safe-area-inset-bottom));
      padding-left: max(1rem, env(safe-area-inset-left));
      padding-right: max(1rem, env(safe-area-inset-right));
    }
    .tr-replay-card { min-height: 0; }

    /* Résumé d'analyse (en-tête) */
    .tr-analysis-summary { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .tr-as-chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .tr-as-chip[data-tier="good"] { background: color-mix(in srgb, var(--tracky-light,#10E0A0) 16%, transparent); color: var(--tracky-light,#10E0A0); border-color: transparent; }
    .tr-as-chip[data-tier="mid"]  { background: color-mix(in srgb, #F59E0B 16%, transparent); color: #F59E0B; border-color: transparent; }
    .tr-as-chip[data-tier="bad"]  { background: color-mix(in srgb, #EF4444 16%, transparent); color: #EF4444; border-color: transparent; }
    .tr-as-chip--stop { color: #60A5FA; }
    .tr-as-chip--speed { background: color-mix(in srgb, #EF4444 14%, transparent); color: #EF4444; border-color: transparent; }

    /* Légende carte */
    .tr-legend {
      position: absolute; left: 10px; bottom: 10px; z-index: 5;
      display: flex; flex-direction: column; gap: 4px;
      padding: 8px 10px; border-radius: 10px;
      background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
      backdrop-filter: blur(6px);
      border: 1px solid var(--border-subtle);
      font-size: 11px; font-weight: 600; color: var(--fg-secondary);
    }
    .tr-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .tr-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 2px rgba(255,255,255,.5); }
    .tr-dot--stop { background: #3B82F6; }
    .tr-dot--speed { background: #EF4444; }
  `],
})
export class TripReplayComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly trip = input<TripDto | null>(null);
  /** Analyse déterministe du trajet (Palier 4) — arrêts + excès de vitesse affichés sur la carte. */
  readonly analysis = input<TripAnalysisDto | null>(null);
  readonly vehicleType = input<string>('OTHER');
  /** Si true, affiche le bouton crayon "Modifier la note". */
  readonly canEditNote = input<boolean>(false);
  readonly closed = output<void>();
  /** Demande au parent d'ouvrir le modal d'edition pour le trip courant. */
  readonly editNote = output<TripDto>();

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly mapSvc = inject(MapService);
  private readonly preferences = inject(PreferencesService);

  protected readonly playing = signal(false);
  protected readonly currentIndex = signal(0);
  protected readonly speed = signal(1);
  protected readonly pointCount = signal(0);

  protected readonly PlayIcon = Play;
  protected readonly PauseIcon = Pause;
  protected readonly XIcon = X;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;

  protected onEditNoteClick(): void {
    const t = this.trip();
    if (t) this.editNote.emit(t);
  }

  protected readonly speeds = [1, 2, 4, 8];

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;
  private markerEl: HTMLElement | null = null;
  private points: Array<[number, number]> = []; // [lng, lat]
  private resizeObserver: ResizeObserver | null = null;
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
  onEscape(): void { if (this.open()) this.onClose(); }

  ngAfterViewInit(): void { /* noop */ }

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
    const pt = this.points[idx];
    if (pt && this.marker) {
      this.marker.setLngLat(pt);
    }
  }

  protected formatDur(s: number): string {
    // Clamp defensif : aligne sur reports.component formatDuration. Une legacy
    // negative ne doit jamais s'afficher en "-11min".
    const safe = Number.isFinite(s) && s > 0 ? s : 0;
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
  }

  protected max0(n: number): number {
    return Math.max(0, Number.isFinite(n) ? n : 0);
  }

  /** Clamp d'une vitesse km/h dans [0, 250]. Voir reports.component#clampSpeed. */
  protected clampSpeed(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 250) return 250;
    return n;
  }

  protected ecoTier(score: number): 'good' | 'mid' | 'bad' {
    return score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
  }
  protected speedingTitle(a: TripAnalysisDto): string {
    return a.limitsKnown
      ? `${a.speedingCount} excès — dépassement max +${Math.round(a.maxOverKmh)} km/h`
      : `${a.speedingCount} pointe(s) de vitesse (limites non résolues — excès probable)`;
  }

  private initReplay(trip: TripDto): void {
    this.cleanup();

    const el = this.mapRef()?.nativeElement;
    if (!el) return;

    let parsed: Array<{ lat: number; lng: number }> = [];
    let usedMatched = false;
    try {
      // Sprint G.3 — preferer la polyligne snappee aux routes si disponible.
      if (trip.polylineMatched) {
        parsed = JSON.parse(trip.polylineMatched);
        usedMatched = parsed.length >= 2;
      }
      if (!usedMatched && trip.polyline) {
        parsed = JSON.parse(trip.polyline);
      }
    } catch { /* */ }

    if (parsed.length === 0) {
      parsed = [{ lat: trip.startLat, lng: trip.startLng }];
      if (trip.endLat != null && trip.endLng != null) {
        parsed.push({ lat: trip.endLat, lng: trip.endLng });
      }
    }

    // Garde-fou cote frontend : filtre points invalides et sauts > 5 km.
    const cleaned: Array<{ lat: number; lng: number }> = [];
    for (const p of parsed) {
      if (!isValidLatLng(p.lat, p.lng)) continue;
      const last = cleaned[cleaned.length - 1];
      if (last && haversineMeters(last.lat, last.lng, p.lat, p.lng) > 5000) continue;
      cleaned.push(p);
    }

    this.points = cleaned.map((p) => [p.lng, p.lat] as [number, number]);
    this.pointCount.set(this.points.length);
    this.currentIndex.set(0);

    if (this.points.length === 0) return;

    const first = this.points[0]!;
    const styleId = this.preferences.prefs().map.style;

    this.map = this.mapSvc.createMap(el, {
      center: { lat: first[1], lng: first[0] },
      zoom: 15,
      style: styleId,
      withGeolocateControl: false,
    });

    // Observe la taille du container : la fin de l'animation d'ouverture du
    // shell / une rotation device déclenche un resize() pour éviter un canvas
    // rendu dans le vide (carte blanche). Idem period-replay.
    try {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.map?.resize());
      this.resizeObserver.observe(el);
    } catch { /* ResizeObserver indispo : les timers ci-dessous prennent le relais */ }

    this.map.on('load', () => {
      // Polyligne replay (gradient couleur si donnees vitesse, sinon vert).
      this.map!.addSource('replay-line', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: this.points },
          properties: {},
        },
      });
      this.map!.addLayer({
        id: 'replay-line',
        type: 'line',
        source: 'replay-line',
        paint: {
          'line-color': '#10E0A0',
          'line-width': 4,
          'line-opacity': 0.85,
        },
      });

      // Auto-fit sur l'ensemble du trajet.
      const points = this.points.map(([lng, lat]) => ({ lat, lng }));
      this.mapSvc.fitBounds(this.map!, points, { padding: 50, animate: false });

      // Marker initial.
      const data: VehicleMarkerData = {
        trackerId: '',
        vehicleId: '',
        type: this.vehicleType(),
        plate: '',
        speedKmh: trip.avgSpeed ?? 0,
        heading: 0,
        ignition: true,
      };
      this.markerEl = buildVehicleMarkerEl(data);
      this.markerEl.classList.add('tracky-marker--no-plate');
      this.marker = attachVehicleMarker(this.map!, this.markerEl, first[1], first[0]);

      // Traçabilité fine (Palier 4) : arrêts (bleu) + excès de vitesse (rouge) sur la carte.
      this.addAnalysisLayers();
    });

    // Triple resize défensif : couvre les transitions CSS qui finissent après
    // l'init et l'animation d'apparition du shell (sinon canvas blanc).
    setTimeout(() => this.map?.resize(), 50);
    setTimeout(() => this.map?.resize(), 250);
    setTimeout(() => this.map?.resize(), 600);
  }

  /** Ajoute les couches d'analyse (arrêts + excès) — appelé une fois la carte chargée. */
  private addAnalysisLayers(): void {
    const a = this.analysis();
    const map = this.map;
    if (!a || !map) return;

    const stops = (a.detail?.stops ?? []).filter((s) => isValidLatLng(s.lat, s.lng));
    if (stops.length > 0) {
      map.addSource('replay-stops', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: stops.map((s) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
            properties: { radius: Math.min(5 + s.durationMin / 4, 13) },
          })),
        },
      });
      map.addLayer({
        id: 'replay-stops', type: 'circle', source: 'replay-stops',
        paint: { 'circle-radius': ['get', 'radius'], 'circle-color': '#3B82F6', 'circle-opacity': 0.8, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
      });
    }

    const speeding = (a.detail?.speeding ?? []).filter((s) => isValidLatLng(s.lat, s.lng));
    if (speeding.length > 0) {
      map.addSource('replay-speeding', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: speeding.map((s) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
            properties: { radius: Math.min(5 + s.overKmh / 5, 12) },
          })),
        },
      });
      map.addLayer({
        id: 'replay-speeding', type: 'circle', source: 'replay-speeding',
        paint: { 'circle-radius': ['get', 'radius'], 'circle-color': '#EF4444', 'circle-opacity': 0.9, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
      });
    }
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
      this.marker.setLngLat(pt);

      // Update marker icon : vitesse via interpolation lineaire (rough), heading
      // calcule sur la direction du segment courant.
      const next = this.points[Math.min(this.points.length - 1, Math.round(idx) + 1)];
      let heading = 0;
      if (next && (next[0] !== pt[0] || next[1] !== pt[1])) {
        heading = bearingFrom(pt[1], pt[0], next[1], next[0]);
      }
      if (this.markerEl) {
        updateVehicleMarkerEl(this.markerEl, {
          trackerId: '',
          vehicleId: '',
          type: this.vehicleType(),
          plate: '',
          speedKmh: this.trip()?.avgSpeed ?? 30,
          heading,
          ignition: true,
        });
      }
    }

    if (this.playing()) {
      this.animId = requestAnimationFrame(() => this.animate());
    }
  }

  private cleanup(): void {
    this.playing.set(false);
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch { /* */ }
      this.resizeObserver = null;
    }
    this.marker?.remove();
    this.marker = null;
    this.markerEl = null;
    if (this.map) { this.map.remove(); this.map = null; }
    this.points = [];
  }
}

function bearingFrom(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}
