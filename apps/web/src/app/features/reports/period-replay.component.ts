/**
 * Period Replay — replay multi-trajets d'un vehicule sur une periode donnee.
 *
 * Fonctionnement :
 *   - Recoit en input la liste des trips deja filtres par vehicule + periode
 *     (le parent `reports.component.ts` gere la selection).
 *   - Construit une "timeline" sequentielle : pour chaque trip, on cree un
 *     segment avec sa polyligne (preferentiellement matched OSRM) ; entre
 *     deux trips, un segment "stop" est cree au point d'arrivee.
 *   - L'animation projette une "horloge virtuelle" qui avance dans le temps
 *     reel multipliee par le speedFactor, et calcule la position du marker
 *     par interpolation lineaire dans le segment courant.
 *   - HUD top-left : date/heure, vitesse, n° trajet, distance cumulee, etat.
 *   - Timeline bas : scrubber clickable + segments colores trips/arrets.
 *   - Camera "chase" : map.easeTo doux centre sur le marker a chaque frame.
 *
 * Defensif :
 *   - Trips legacy avec durations 0 ou polyline vide → segment temps zero,
 *     ignore proprement.
 *   - Speed sanitize via clampSpeed (aligne sur reports.utils).
 *   - Si plus aucun trip, le composant ne s'ouvre pas (le parent garde le
 *     bouton desactive).
 *
 * Mobile / iOS PWA :
 *   - Safe-area-inset (top/bottom/left/right) respecte via padding shell.
 *   - Bouton X 9x9 dans une pastille pour rester clickable meme avec le
 *     finger fat-tap, jamais cache par l'island/notch grace au padding shell.
 *   - HUD compact en mobile (positionne sous le header, pas par-dessus).
 *   - Timeline tactile (44px min de tap target sur les segments).
 */
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { DatePipe, DecimalPipe } from '@angular/common';
import { LucideAngularModule, Play, Pause, X, Navigation, Square } from 'lucide-angular';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import type { TripDto } from '@vizyo/tracky-shared';
import { isValidLatLng, haversineMeters } from '@vizyo/tracky-shared';
import { MapService } from '../../core/services/map.service';
import { PreferencesService } from '../../core/services/preferences.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../shared/utils/maplibre-markers';
import { clampSpeed, formatDuration, max0 } from './reports.utils';

// Marker de version au load du module : si on ne voit pas ce log dans la
// console du browser, c'est que le bundle n'a PAS ete charge (cache, deploy
// stale, etc.). Permet de discriminer "code pas servi" vs "code execute mais
// bug d'init".
console.log('[period-replay] MODULE LOADED v3', new Date().toISOString());

interface TripSegment {
  kind: 'trip';
  trip: TripDto;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Polyligne en [lng, lat] nettoyee. Au moins 2 points. */
  points: Array<[number, number]>;
  /** Distance cumulee de chaque point depuis le debut du segment, en metres. */
  cumulDistMeters: number[];
  /** Distance totale du segment (= cumulDistMeters[last]). */
  totalDistMeters: number;
}
interface StopSegment {
  kind: 'stop';
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Lieu de l'arret (= fin du trip precedent). */
  lng: number;
  lat: number;
}
type Segment = TripSegment | StopSegment;

interface TimelineState {
  segments: Segment[];
  totalMs: number;
  totalDistanceMeters: number;
  /** Premier point map (pour init du marker). */
  firstLngLat: [number, number] | null;
  /** Tous les points pour fitBounds initial. */
  allPoints: Array<[number, number]>;
  /** Polylignes par trip pour rendu fond. */
  tripLines: Array<{ tripId: string; points: Array<[number, number]> }>;
}

@Component({
  selector: 'app-period-replay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DatePipe, DecimalPipe],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9000] flex flex-col pr-shell">
        <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" (click)="onClose()"></div>

        <div class="relative flex-1 flex flex-col bg-bg-secondary border border-border-subtle
                    rounded-[--radius-card] overflow-hidden pr-card">

          <!-- Header : titre vehicule + periode + close -->
          <div class="flex items-center justify-between gap-3 px-4 sm:px-6 py-3
                      border-b border-border-subtle shrink-0 bg-bg-secondary/95 backdrop-blur">
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2 flex-wrap">
                <strong class="text-fg-primary text-sm sm:text-base">Replay période</strong>
                @if (vehiclePlate()) {
                  <span class="text-[11px] font-bold uppercase tracking-wider text-tracky-light
                               px-1.5 py-0.5 rounded bg-tracky/15 border border-tracky/25">
                    {{ vehiclePlate() }}
                  </span>
                }
              </div>
              @if (timeline(); as tl) {
                <div class="text-[11px] text-fg-tertiary mt-0.5 truncate">
                  {{ tl.segments.length }} étape{{ tl.segments.length > 1 ? 's' : '' }} ·
                  {{ tripCount() }} trajet{{ tripCount() > 1 ? 's' : '' }} ·
                  {{ (tl.totalDistanceMeters / 1000) | number:'1.1-1' }} km
                </div>
              }
            </div>
            <button (click)="onClose()"
                    aria-label="Fermer le replay"
                    class="shrink-0 inline-flex items-center justify-center
                           w-9 h-9 rounded-full bg-bg-tertiary/80 backdrop-blur-sm
                           text-fg-secondary hover:text-fg-primary hover:bg-bg-tertiary
                           border border-border-subtle cursor-pointer transition-colors">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>

          <!-- Zone carte + overlays.
               Wrapper relative + flex-1 + flex flex-col + min-h-280 :
                 - relative = positioning context pour les overlays HUD/erreur
                 - flex-1 = prend toute la hauteur dispo dans la card
                 - flex flex-col = fait du map container un flex item enfant
               Map container = flex-1 (pas absolute inset-0) : MapLibre prefere
               un container en flow normal plutot qu'un absolute dans un
               parent flex (cause de bugs silencieux d'init constates en prod). -->
          <div class="relative flex-1 flex flex-col min-h-[280px]">
            <div #mapContainer
                 id="period-replay-map-container"
                 class="flex-1"></div>

            <!-- Overlays positionnes par-dessus le map container -->
            @if (mapError(); as err) {
              <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10
                          max-w-md px-4 py-3 rounded-lg bg-red-500/15 border border-red-500/40
                          text-red-200 text-xs text-center backdrop-blur pointer-events-none">
                <div class="font-bold mb-1">Carte indisponible</div>
                <div class="font-mono break-all">{{ err }}</div>
              </div>
            }

            <!-- HUD overlay : date/heure + vitesse + etat -->
            @if (timeline()) {
              <div class="pr-hud absolute top-3 left-3 right-3 sm:right-auto sm:max-w-[320px] z-10
                          bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                          rounded-xl p-3 shadow-xl pointer-events-none">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    @if (currentState() === 'stop') {
                      <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase
                                   tracking-wider px-1.5 py-0.5 rounded
                                   bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        <lucide-icon [img]="SquareIcon" [size]="10"></lucide-icon>
                        Arrêt
                      </span>
                    } @else if (currentState() === 'trip') {
                      <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase
                                   tracking-wider px-1.5 py-0.5 rounded
                                   bg-tracky/20 text-tracky-light border border-tracky/30">
                        <lucide-icon [img]="NavigationIcon" [size]="10"></lucide-icon>
                        En route
                      </span>
                    } @else {
                      <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase
                                   tracking-wider px-1.5 py-0.5 rounded
                                   bg-bg-tertiary text-fg-tertiary border border-border-subtle">
                        Prêt
                      </span>
                    }
                    @if (currentTripIndex() >= 0) {
                      <span class="text-[10px] text-fg-tertiary font-mono">
                        Trajet {{ currentTripIndex() + 1 }}/{{ tripCount() }}
                      </span>
                    }
                  </div>
                </div>

                <div class="mt-2 flex items-baseline gap-2">
                  <div class="font-mono text-fg-primary text-base sm:text-lg leading-none">
                    {{ currentTimestamp() | date:'HH:mm:ss' }}
                  </div>
                  <div class="text-[11px] text-fg-tertiary leading-none">
                    {{ currentTimestamp() | date:'EEE dd MMM' }}
                  </div>
                </div>

                <div class="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <div class="text-[9px] text-fg-tertiary uppercase tracking-wider">Vitesse</div>
                    <div class="font-mono text-fg-primary text-sm flex items-baseline gap-0.5">
                      <span>{{ currentSpeedKmh() | number:'1.0-0' }}</span>
                      <span class="text-[9px] text-fg-tertiary">km/h</span>
                    </div>
                  </div>
                  <div>
                    <div class="text-[9px] text-fg-tertiary uppercase tracking-wider">Parcouru</div>
                    <div class="font-mono text-fg-primary text-sm flex items-baseline gap-0.5">
                      <span>{{ (cumulDistanceM() / 1000) | number:'1.1-1' }}</span>
                      <span class="text-[9px] text-fg-tertiary">km</span>
                    </div>
                  </div>
                  <div>
                    @if (currentState() === 'stop' && currentStopRemainingMs() > 0) {
                      <div class="text-[9px] text-amber-300/80 uppercase tracking-wider">Arrêt</div>
                      <div class="font-mono text-amber-300 text-sm">
                        {{ formatDur(currentStopRemainingMs() / 1000) }}
                      </div>
                    } @else {
                      <div class="text-[9px] text-fg-tertiary uppercase tracking-wider">Écoulé</div>
                      <div class="font-mono text-fg-primary text-sm">
                        {{ formatDur(virtualMs() / 1000) }}
                      </div>
                    }
                  </div>
                </div>
              </div>
            }
          </div>

          <!-- Footer : controles play/pause + scrubber + speed -->
          <div class="shrink-0 border-t border-border-subtle bg-bg-secondary/95 backdrop-blur
                      px-3 sm:px-4 py-3 flex flex-col gap-2">

            <!-- Timeline scrubber : segments colores + cursor -->
            <div #scrubberRef class="relative h-7 rounded-md overflow-hidden bg-bg-tertiary
                                      cursor-pointer touch-none select-none"
                 (pointerdown)="onScrubberPointer($event)"
                 (pointermove)="onScrubberPointerMove($event)"
                 (pointerup)="onScrubberPointerUp($event)">
              @if (timeline(); as tl) {
                @for (seg of tl.segments; track $index) {
                  <div class="absolute top-0 bottom-0"
                       [class]="seg.kind === 'trip' ? 'pr-seg-trip' : 'pr-seg-stop'"
                       [style.left.%]="(seg.startMs - tl.segments[0].startMs) / tl.totalMs * 100"
                       [style.width.%]="seg.durationMs / tl.totalMs * 100"
                       [title]="seg.kind === 'trip' ? 'Trajet' : 'Arrêt'"></div>
                }
                <!-- Cursor de lecture -->
                <div class="absolute top-0 bottom-0 w-[2px] bg-fg-primary shadow-md pointer-events-none"
                     [style.left.%]="(virtualMs() / tl.totalMs) * 100"></div>
              }
            </div>

            <!-- Controles -->
            <div class="flex items-center gap-2 sm:gap-3">
              <button (click)="togglePlay()"
                      class="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full
                             bg-tracky/15 border border-tracky/30 text-tracky-light
                             hover:bg-tracky/25 cursor-pointer transition-colors"
                      [attr.aria-label]="playing() ? 'Pause' : 'Lecture'">
                @if (playing()) {
                  <lucide-icon [img]="PauseIcon" [size]="18"></lucide-icon>
                } @else {
                  <lucide-icon [img]="PlayIcon" [size]="18"></lucide-icon>
                }
              </button>

              <div class="flex-1 min-w-0 flex flex-wrap gap-1 justify-end">
                @for (preset of speedPresets; track preset.label) {
                  <button (click)="setSpeed(preset.factor)"
                          class="px-2 sm:px-2.5 py-1 text-[11px] rounded-md cursor-pointer
                                 transition-colors min-h-[28px]"
                          [class]="speedFactor() === preset.factor
                            ? 'bg-tracky/20 text-tracky-light border border-tracky/30'
                            : 'bg-bg-tertiary text-fg-tertiary border border-border-subtle hover:text-fg-secondary'">
                    {{ preset.label }}
                  </button>
                }
                <button (click)="setSpeedAuto()"
                        class="px-2 sm:px-2.5 py-1 text-[11px] rounded-md cursor-pointer
                               transition-colors min-h-[28px]"
                        [class]="autoSpeed() ? 'bg-tracky/20 text-tracky-light border border-tracky/30'
                                              : 'bg-bg-tertiary text-fg-tertiary border border-border-subtle hover:text-fg-secondary'">
                  Adapter
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .pr-shell {
      padding-top: max(1rem, env(safe-area-inset-top));
      padding-bottom: max(1rem, env(safe-area-inset-bottom));
      padding-left: max(1rem, env(safe-area-inset-left));
      padding-right: max(1rem, env(safe-area-inset-right));
    }
    .pr-card { min-height: 0; }
    .pr-seg-trip {
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--color-tracky) 70%, transparent),
        color-mix(in srgb, var(--color-tracky) 45%, transparent));
    }
    .pr-seg-stop {
      background: repeating-linear-gradient(
        45deg,
        color-mix(in srgb, var(--fg-tertiary) 25%, transparent) 0 4px,
        color-mix(in srgb, var(--fg-tertiary) 12%, transparent) 4px 8px);
    }
    /* Mobile : reduit le HUD pour ne pas couvrir trop de carte */
    @media (max-width: 640px) {
      .pr-hud { font-size: 12px; }
    }
  `],
})
export class PeriodReplayComponent implements AfterViewInit, OnDestroy {
  readonly open = input.required<boolean>();
  readonly trips = input<TripDto[]>([]);
  readonly vehicleType = input<string>('OTHER');
  readonly vehiclePlate = input<string | null>(null);
  readonly closed = output<void>();

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly scrubberRef = viewChild<ElementRef<HTMLDivElement>>('scrubberRef');
  private readonly mapSvc = inject(MapService);
  private readonly preferences = inject(PreferencesService);

  protected readonly PlayIcon = Play;
  protected readonly PauseIcon = Pause;
  protected readonly XIcon = X;
  protected readonly NavigationIcon = Navigation;
  protected readonly SquareIcon = Square;

  protected readonly playing = signal(false);
  protected readonly virtualMs = signal(0);
  protected readonly speedFactor = signal(600); // 10 min/sec par defaut
  protected readonly autoSpeed = signal(true);
  /** Diagnostic : message d'erreur visible si la carte ne se charge pas en 3s. */
  protected readonly mapError = signal<string | null>(null);
  /** Indique si MapLibre a emis 'load' au moins une fois. */
  protected readonly mapReady = signal(false);

  /** Timeline construite a partir des trips. null tant que pas calcule. */
  protected readonly timeline = signal<TimelineState | null>(null);
  protected readonly tripCount = computed(() => {
    const tl = this.timeline();
    if (!tl) return 0;
    return tl.segments.filter((s) => s.kind === 'trip').length;
  });

  /** Index du trip actuellement actif (parmi les segments trip), -1 si arret/inactif. */
  protected readonly currentTripIndex = signal(-1);
  /** 'idle' avant lecture, 'trip' en deplacement, 'stop' a l'arret. */
  protected readonly currentState = signal<'idle' | 'trip' | 'stop'>('idle');
  protected readonly currentSpeedKmh = signal(0);
  protected readonly currentTimestamp = signal<Date>(new Date());
  protected readonly cumulDistanceM = signal(0);
  /** Si en arret, ms restant avant fin de l'arret. */
  protected readonly currentStopRemainingMs = signal(0);

  protected readonly speedPresets = [
    { label: '60×', factor: 60 },     // 1 min reelle / sec
    { label: '600×', factor: 600 },   // 10 min / sec
    { label: '3600×', factor: 3600 }, // 1 h / sec
  ];

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;
  private markerEl: HTMLElement | null = null;
  private animId: number | null = null;
  private lastFrameTime = 0;
  private scrubberDragging = false;
  private resizeObserver: ResizeObserver | null = null;

  // --- Lifecycle ---

  /** Effect : recompute la timeline a chaque changement d'open/trips. */
  private initEffect = effect(() => {
    const isOpen = this.open();
    const trips = this.trips();
    console.log('[period-replay] effect fired', { isOpen, tripsLength: trips?.length });
    if (!isOpen) return;
    const tl = buildTimeline(trips);
    this.timeline.set(tl);
    this.virtualMs.set(0);
    this.cumulDistanceM.set(0);
    this.currentState.set('idle');
    this.currentTripIndex.set(-1);
    if (tl && tl.segments.length > 0) {
      this.currentTimestamp.set(new Date(tl.segments[0]!.startMs));
      if (this.autoSpeed()) this.applyAutoSpeed(tl);
    }
    console.log('[period-replay] timeline built', {
      segments: tl?.segments?.length, totalMs: tl?.totalMs,
      hasFirstLngLat: !!tl?.firstLngLat,
    });
    // Approche simple, calquee sur trip-replay (qui marche) : setTimeout 200ms
    // pour laisser Angular finir le rendu du modal, puis init. ResizeObserver
    // posterieur gere les changements de taille (rotation, animation modal).
    setTimeout(() => this.initMap(), 200);
  });

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.open()) this.onClose(); }

  ngAfterViewInit(): void { /* noop */ }

  ngOnDestroy(): void { this.cleanup(); }

  // --- Controls ---

  protected onClose(): void {
    this.cleanup();
    this.closed.emit();
  }

  protected togglePlay(): void {
    if (this.playing()) {
      this.playing.set(false);
      if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
      return;
    }
    const tl = this.timeline();
    if (!tl || tl.totalMs === 0) return;
    // Si on est en fin de timeline, redemarrer du debut.
    if (this.virtualMs() >= tl.totalMs) {
      this.virtualMs.set(0);
      this.cumulDistanceM.set(0);
    }
    this.playing.set(true);
    this.lastFrameTime = performance.now();
    this.animate();
  }

  protected setSpeed(factor: number): void {
    this.speedFactor.set(factor);
    this.autoSpeed.set(false);
  }

  protected setSpeedAuto(): void {
    this.autoSpeed.set(true);
    const tl = this.timeline();
    if (tl) this.applyAutoSpeed(tl);
  }

  private applyAutoSpeed(tl: TimelineState): void {
    // 30 secondes de lecture cible.
    const targetSec = 30;
    const totalSec = tl.totalMs / 1000;
    if (totalSec <= 0) { this.speedFactor.set(60); return; }
    const f = Math.max(60, Math.min(7200, Math.round(totalSec / targetSec)));
    this.speedFactor.set(f);
  }

  // --- Scrubber pointer interactions ---

  protected onScrubberPointer(ev: PointerEvent): void {
    this.scrubberDragging = true;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.seekFromPointer(ev);
  }
  protected onScrubberPointerMove(ev: PointerEvent): void {
    if (!this.scrubberDragging) return;
    this.seekFromPointer(ev);
  }
  protected onScrubberPointerUp(ev: PointerEvent): void {
    this.scrubberDragging = false;
    try { (ev.target as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* */ }
  }

  private seekFromPointer(ev: PointerEvent): void {
    const el = this.scrubberRef()?.nativeElement;
    const tl = this.timeline();
    if (!el || !tl) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const targetMs = ratio * tl.totalMs;
    this.virtualMs.set(targetMs);
    this.applyVirtualMs(tl, targetMs, /* updateCumul= */ true);
  }

  // --- Animation ---

  private animate(): void {
    if (!this.playing()) return;
    const tl = this.timeline();
    if (!tl) return;

    const now = performance.now();
    const realDeltaSec = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const virtualDeltaMs = realDeltaSec * 1000 * this.speedFactor();
    let nextMs = this.virtualMs() + virtualDeltaMs;

    if (nextMs >= tl.totalMs) {
      nextMs = tl.totalMs;
      this.playing.set(false);
    }
    this.virtualMs.set(nextMs);
    this.applyVirtualMs(tl, nextMs, /* updateCumul= */ false);

    if (this.playing()) {
      this.animId = requestAnimationFrame(() => this.animate());
    }
  }

  /**
   * Projette virtualMs sur la timeline : trouve le segment courant, met a
   * jour marker, HUD, camera. Si `updateCumul`, recalcule la distance cumulee
   * depuis le debut (couteux mais necessaire apres un seek).
   */
  private applyVirtualMs(tl: TimelineState, virtualMs: number, updateCumul: boolean): void {
    if (tl.segments.length === 0) return;
    const baseMs = tl.segments[0]!.startMs;
    const absoluteMs = baseMs + virtualMs;

    // Linear search : nb segments faible (~100 max), pas besoin de bsearch.
    let segIdx = 0;
    for (let i = 0; i < tl.segments.length; i++) {
      const s = tl.segments[i]!;
      if (absoluteMs <= s.endMs) { segIdx = i; break; }
      segIdx = i;
    }
    const seg = tl.segments[segIdx]!;
    const localMs = absoluteMs - seg.startMs;

    if (seg.kind === 'stop') {
      this.currentState.set('stop');
      this.currentSpeedKmh.set(0);
      this.currentStopRemainingMs.set(Math.max(0, seg.durationMs - localMs));
      this.currentTripIndex.set(this.findLastTripIndex(tl, segIdx));
      this.currentTimestamp.set(new Date(absoluteMs));
      this.moveMarker(seg.lng, seg.lat, /* heading= */ null);
    } else {
      this.currentState.set('trip');
      this.currentStopRemainingMs.set(0);
      this.currentSpeedKmh.set(clampSpeed(seg.trip.avgSpeed));
      this.currentTripIndex.set(this.tripIndexInList(tl, seg.trip));
      this.currentTimestamp.set(new Date(absoluteMs));

      const ratio = seg.durationMs > 0 ? Math.max(0, Math.min(1, localMs / seg.durationMs)) : 0;
      const proj = projectAlong(seg, ratio);
      if (proj) this.moveMarker(proj.lng, proj.lat, proj.heading);
    }

    if (updateCumul) {
      // Recalcule la distance parcourue jusqu'a virtualMs.
      let cumul = 0;
      for (let i = 0; i < segIdx; i++) {
        const s = tl.segments[i]!;
        if (s.kind === 'trip') cumul += s.totalDistMeters;
      }
      if (seg.kind === 'trip') {
        const ratio = seg.durationMs > 0 ? Math.max(0, Math.min(1, localMs / seg.durationMs)) : 0;
        cumul += seg.totalDistMeters * ratio;
      }
      this.cumulDistanceM.set(cumul);
    } else if (seg.kind === 'trip') {
      // En lecture continue : derivee instantanee du cumul.
      const ratio = seg.durationMs > 0 ? Math.max(0, Math.min(1, localMs / seg.durationMs)) : 0;
      // Recalcule rapide : segment courant ratio + somme des trips < segIdx.
      let cumul = 0;
      for (let i = 0; i < segIdx; i++) {
        const s = tl.segments[i]!;
        if (s.kind === 'trip') cumul += s.totalDistMeters;
      }
      cumul += seg.totalDistMeters * ratio;
      this.cumulDistanceM.set(cumul);
    }
  }

  private moveMarker(lng: number, lat: number, heading: number | null): void {
    if (!this.marker) return;
    this.marker.setLngLat([lng, lat]);
    if (this.markerEl) {
      updateVehicleMarkerEl(this.markerEl, {
        trackerId: '',
        vehicleId: '',
        type: this.vehicleType(),
        plate: '',
        speedKmh: this.currentSpeedKmh(),
        heading: heading ?? 0,
        ignition: this.currentState() === 'trip',
      });
    }
    // Camera "chase" : easeTo doux si la map est initialisee.
    if (this.map) {
      this.mapSvc.panTo(this.map, lat, lng, 250);
    }
  }

  private findLastTripIndex(tl: TimelineState, fromSegIdx: number): number {
    for (let i = fromSegIdx; i >= 0; i--) {
      const s = tl.segments[i]!;
      if (s.kind === 'trip') return this.tripIndexInList(tl, s.trip);
    }
    return -1;
  }

  private tripIndexInList(tl: TimelineState, trip: TripDto): number {
    let idx = 0;
    for (const s of tl.segments) {
      if (s.kind === 'trip') {
        if (s.trip.id === trip.id) return idx;
        idx++;
      }
    }
    return -1;
  }

  /** Helper template-friendly. */
  protected formatDur(s: number): string { return formatDuration(s); }

  // --- Map init ---

  private initMap(): void {
    console.log('[period-replay] initMap called');
    const tl = this.timeline();
    const el = this.mapRef()?.nativeElement;
    this.mapError.set(null);
    this.mapReady.set(false);
    console.log('[period-replay] initMap state', {
      hasTl: !!tl,
      hasEl: !!el,
      w: el?.clientWidth,
      h: el?.clientHeight,
      hasFirstLngLat: !!tl?.firstLngLat,
      segments: tl?.segments?.length,
    });
    if (!tl || !el) {
      this.mapError.set(`Init aborted: tl=${!!tl} el=${!!el}`);
      console.error('[period-replay] init aborted: missing tl or el');
      return;
    }
    if (!tl.firstLngLat) {
      this.mapError.set(`Aucun point GPS exploitable dans la periode (${tl.segments.length} segments)`);
      console.error('[period-replay] no firstLngLat', { segments: tl.segments.length });
      return;
    }
    if (el.clientWidth === 0 || el.clientHeight === 0) {
      console.warn('[period-replay] map container size 0', {
        w: el.clientWidth, h: el.clientHeight,
      });
    }
    this.disposeMap();

    const styleId = this.preferences.prefs().map.style;
    const [lng0, lat0] = tl.firstLngLat;
    try {
      this.map = this.mapSvc.createMap(el, {
        center: { lat: lat0, lng: lng0 },
        zoom: 14,
        style: styleId,
        withGeolocateControl: false,
        withNavigationControl: true,
        withScaleControl: true,
      });
    } catch (err) {
      console.error('[period-replay] createMap throw', err);
      this.mapError.set(`createMap: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Diag : si 'load' n'a pas firé en 3s, affiche un encart d'erreur visible.
    const loadGuardId = window.setTimeout(() => {
      if (!this.mapReady()) {
        const w = el.clientWidth, h = el.clientHeight;
        this.mapError.set(
          `Map.load timeout (3s) — container ${w}x${h}px, style="${styleId}". ` +
          `Verifie console + Network (tuiles).`,
        );
        console.error('[period-replay] map.load timeout', { w, h, styleId });
      }
    }, 3000);

    this.map.on('error', (ev: any) => {
      const msg = ev?.error?.message ?? ev?.message ?? 'unknown error';
      console.error('[period-replay] maplibre error', ev);
      // N'efface pas un mapReady=true existant (les erreurs tuiles partielles
      // sont normales, on veut juste signaler les bloquants).
      if (!this.mapReady()) {
        this.mapError.set(`MapLibre: ${msg}`);
      }
    });

    // Observer la taille du container : tout changement (modal qui finit de
     // s'animer, rotation device, viewport resize) declenche un map.resize()
     // pour eviter une carte rendue dans le vide.
     try {
       this.resizeObserver?.disconnect();
       this.resizeObserver = new ResizeObserver(() => {
         this.map?.resize();
       });
       this.resizeObserver.observe(el);
     } catch { /* ResizeObserver indispo : tant pis, fallback timers ci-dessous */ }

     this.map.on('load', () => {
      console.log('[period-replay] map.LOAD fired', {
        center: this.map?.getCenter(),
        zoom: this.map?.getZoom(),
        styleLoaded: this.map?.isStyleLoaded(),
        canvasW: el.clientWidth,
        canvasH: el.clientHeight,
      });
      if (!this.map) return;
      this.mapReady.set(true);
      window.clearTimeout(loadGuardId);
      // Polylignes en fond : toutes les lignes des trips.
      console.log('[period-replay] adding tripLines', tl.tripLines.length);
      for (const line of tl.tripLines) {
        const srcId = `pr-line-${line.tripId}`;
        const layerId = `pr-layer-${line.tripId}`;
        if (this.map.getSource(srcId)) continue;
        this.map.addSource(srcId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: line.points },
            properties: {},
          },
        });
        this.map.addLayer({
          id: layerId,
          type: 'line',
          source: srcId,
          paint: {
            'line-color': '#10E0A0',
            'line-width': 3,
            'line-opacity': 0.55,
          },
        });
      }
      // Auto-fit sur l'ensemble.
      const allLatLng = tl.allPoints.map(([lng, lat]) => ({ lat, lng }));
      this.mapSvc.fitBounds(this.map, allLatLng, { padding: 60, animate: false });

      // Marker initial.
      const data: VehicleMarkerData = {
        trackerId: '', vehicleId: '',
        type: this.vehicleType(),
        plate: '',
        speedKmh: 0,
        heading: 0,
        ignition: false,
      };
      this.markerEl = buildVehicleMarkerEl(data);
      this.markerEl.classList.add('tracky-marker--no-plate');
      this.marker = attachVehicleMarker(this.map, this.markerEl, lat0, lng0);
    });

    // Triple resize defensif : couvre les cas de transition CSS qui finissent
    // apres l'init, et l'animation d'apparition du modal.
    setTimeout(() => this.map?.resize(), 50);
    setTimeout(() => this.map?.resize(), 250);
    setTimeout(() => this.map?.resize(), 600);
  }

  private disposeMap(): void {
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch { /* */ }
      this.resizeObserver = null;
    }
    this.marker?.remove();
    this.marker = null;
    this.markerEl = null;
    if (this.map) { this.map.remove(); this.map = null; }
  }

  private cleanup(): void {
    this.playing.set(false);
    this.disposeMap();
    this.timeline.set(null);
    this.virtualMs.set(0);
    this.cumulDistanceM.set(0);
    this.currentState.set('idle');
    this.currentTripIndex.set(-1);
    this.mapError.set(null);
    this.mapReady.set(false);
  }
}

// --- Helpers : timeline construction & projection ---

/**
 * Construit une timeline a partir d'une liste de trips. Trips sont tries
 * chronologiquement (le tableau peut arriver desc, on s'aligne asc).
 *
 * Defensif :
 *   - Trips sans endedAt → ignore.
 *   - Trips sans polyline → fallback sur start/end coords (segment droit).
 *   - Trips avec durationSeconds <= 0 (legacy) → ignore.
 *   - Sauts > 5 km entre points consecutifs → filtre comme dans trip-replay.
 *   - Stop entre trips si gap >= 30 secondes (sinon ignore = trips contigus).
 */
function buildTimeline(trips: TripDto[]): TimelineState {
  const empty: TimelineState = {
    segments: [], totalMs: 0, totalDistanceMeters: 0,
    firstLngLat: null, allPoints: [], tripLines: [],
  };
  if (!trips || trips.length === 0) return empty;

  // Tri ascendant chronologique + filtre defensif.
  const valid = trips
    .filter((t) => !!t.endedAt && t.durationSeconds > 0)
    .map((t) => ({
      t,
      startMs: new Date(t.startedAt).getTime(),
      endMs: new Date(t.endedAt as string).getTime(),
    }))
    .filter((x) => Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs > x.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (valid.length === 0) return empty;

  const segments: Segment[] = [];
  const tripLines: Array<{ tripId: string; points: Array<[number, number]> }> = [];
  const allPoints: Array<[number, number]> = [];

  const STOP_MIN_MS = 30 * 1000; // gap mini pour creer un stop visible

  for (let i = 0; i < valid.length; i++) {
    const { t, startMs, endMs } = valid[i]!;
    const points = parseTripPolyline(t);
    if (points.length < 2) continue; // pas exploitable

    const cumul = computeCumulDistMeters(points);
    const seg: TripSegment = {
      kind: 'trip',
      trip: t,
      startMs, endMs,
      durationMs: endMs - startMs,
      points,
      cumulDistMeters: cumul,
      totalDistMeters: cumul[cumul.length - 1] ?? 0,
    };
    segments.push(seg);
    tripLines.push({ tripId: t.id, points });
    for (const p of points) allPoints.push(p);

    // Stop entre ce trip et le suivant si gap suffisant.
    const nextItem = valid[i + 1];
    if (nextItem) {
      const gapMs = nextItem.startMs - endMs;
      if (gapMs >= STOP_MIN_MS) {
        const last = points[points.length - 1]!;
        segments.push({
          kind: 'stop',
          startMs: endMs,
          endMs: nextItem.startMs,
          durationMs: gapMs,
          lng: last[0], lat: last[1],
        });
      }
    }
  }

  if (segments.length === 0) return empty;

  const totalMs = segments[segments.length - 1]!.endMs - segments[0]!.startMs;
  const totalDistanceMeters = segments
    .filter((s): s is TripSegment => s.kind === 'trip')
    .reduce((sum, s) => sum + max0(s.totalDistMeters), 0);

  return {
    segments, totalMs, totalDistanceMeters,
    firstLngLat: allPoints[0] ?? null,
    allPoints, tripLines,
  };
}

function parseTripPolyline(trip: TripDto): Array<[number, number]> {
  let parsed: Array<{ lat: number; lng: number }> = [];
  try {
    if (trip.polylineMatched) {
      parsed = JSON.parse(trip.polylineMatched);
    } else if (trip.polyline) {
      parsed = JSON.parse(trip.polyline);
    }
  } catch { parsed = []; }

  if (parsed.length === 0) {
    parsed = [{ lat: trip.startLat, lng: trip.startLng }];
    if (trip.endLat != null && trip.endLng != null) {
      parsed.push({ lat: trip.endLat, lng: trip.endLng });
    }
  }

  // Filtre garde-fou (mirror trip-replay) : lat/lng valides + sauts < 5 km.
  const cleaned: Array<{ lat: number; lng: number }> = [];
  for (const p of parsed) {
    if (!isValidLatLng(p.lat, p.lng)) continue;
    const last = cleaned[cleaned.length - 1];
    if (last && haversineMeters(last.lat, last.lng, p.lat, p.lng) > 5000) continue;
    cleaned.push(p);
  }
  return cleaned.map((p) => [p.lng, p.lat] as [number, number]);
}

function computeCumulDistMeters(points: Array<[number, number]>): number[] {
  const out = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const d = haversineMeters(prev[1], prev[0], cur[1], cur[0]);
    out[i] = (out[i - 1] ?? 0) + d;
  }
  return out;
}

/**
 * Projette le marker dans le segment trip a `ratio` de progression temporelle.
 * On utilise la distance cumulee proportionnelle (= mouvement uniforme dans
 * le temps, suffisant en V1 sans timestamps par point GPS).
 */
function projectAlong(
  seg: TripSegment,
  ratio: number,
): { lng: number; lat: number; heading: number } | null {
  const { points, cumulDistMeters, totalDistMeters } = seg;
  if (points.length < 2) {
    const p0 = points[0];
    return p0 ? { lng: p0[0], lat: p0[1], heading: 0 } : null;
  }
  if (totalDistMeters === 0) {
    const p0 = points[0]!;
    return { lng: p0[0], lat: p0[1], heading: 0 };
  }
  const targetDist = ratio * totalDistMeters;
  // Bsearch sur cumul pour trouver le segment.
  let lo = 0, hi = cumulDistMeters.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulDistMeters[mid]! < targetDist) lo = mid + 1; else hi = mid;
  }
  const idx = Math.max(1, lo);
  const a = points[idx - 1]!;
  const b = points[idx]!;
  const da = cumulDistMeters[idx - 1]!;
  const db = cumulDistMeters[idx]!;
  const localT = db === da ? 0 : (targetDist - da) / (db - da);
  const lng = a[0] + (b[0] - a[0]) * localT;
  const lat = a[1] + (b[1] - a[1]) * localT;
  const heading = bearing(a[1], a[0], b[1], b[0]);
  return { lng, lat, heading };
}

function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
