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
import { COULEURS_CARTE } from '../../shared/utils/couleurs-carte';
import { clampSpeed, formatDuration, max0 } from './reports.utils';

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

/** Un bloc dessiné dans la barre d'un jour : un trajet plein, un arrêt creux. */
interface BlocJour {
  kind: 'trip' | 'stop';
  gauche: number;
  largeur: number;
}

/**
 * Une journée de la période, avec sa propre barre.
 *
 * La fenêtre d'une journée va de son PREMIER départ à sa DERNIÈRE arrivée, pas de
 * 00:00 à 24:00 : c'est ce qui fait disparaître les nuits. Sur une frise continue de
 * trois jours, elles mangeaient la majeure partie de la barre sans rien porter.
 */
interface Journee {
  cle: string;
  libelle: string;
  nbTrajets: number;
  debutMs: number;
  finMs: number;
  blocs: BlocJour[];
}

interface TimelineState {
  segments: Segment[];
  totalMs: number;
  /**
   * ── LE TOTAL DU REPLAY NE DOIT PAS CONTREDIRE L'INDICATEUR « DISTANCE » ────────────
   *
   * Il était re-mesuré sur la trace SIMPLIFIÉE : quelques points suffisent à dessiner un
   * trajet, pas à en mesurer les kilomètres. Le bandeau du replay affichait donc un total
   * inférieur à celui de la page qui venait de l'ouvrir, sans que rien ne l'explique — deux
   * chiffres pour le même mois, sur deux écrans superposés.
   *
   * C'est désormais la somme des distances ENREGISTRÉES des trajets rejoués, celle-là même
   * qu'additionne l'indicateur.
   */
  totalDistanceMeters: number;
  /**
   * Trajets écartés du replay faute de trace exploitable (moins de deux points), et leurs
   * kilomètres. ⚠️ Comptés, jamais tus : sans eux, un replay de 3 trajets sur 5 passerait
   * pour un mois de 3 trajets — et l'écart avec l'indicateur redeviendrait inexplicable.
   */
  trajetsSansTrace: number;
  metresSansTrace: number;
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
                  <span class="pr-plaque text-[11px] font-bold uppercase tracking-wider
                               px-1.5 py-0.5 rounded bg-tracky/15 border border-tracky/25">
                    {{ vehiclePlate() }}
                  </span>
                }
              </div>
              @if (timeline(); as tl) {
                <div class="text-[11px] text-fg-secondary mt-0.5 truncate">
                  {{ tl.segments.length }} étape{{ tl.segments.length > 1 ? 's' : '' }} ·
                  {{ tripCount() }} trajet{{ tripCount() > 1 ? 's' : '' }} ·
                  {{ (tl.totalDistanceMeters / 1000) | number:'1.1-1' }} km
                  @if (tl.trajetsSansTrace > 0) {
                    <!-- ⚠️ Sans cette mention, l'écart avec l'indicateur « Distance » de la
                         page serait inexplicable : on croirait l'un des deux faux. -->
                    · {{ tl.trajetsSansTrace }} trajet{{ tl.trajetsSansTrace > 1 ? 's' : '' }}
                    ({{ (tl.metresSansTrace / 1000) | number:'1.1-1' }} km) sans trace GPS, non rejoué{{ tl.trajetsSansTrace > 1 ? 's' : '' }}
                  }
                </div>
              }
            </div>
            <button (click)="onClose()"
                    aria-label="Fermer le replay"
                    class="shrink-0 inline-flex items-center justify-center
                           w-11 h-11 rounded-full bg-bg-tertiary/80 backdrop-blur-sm
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
          <div class="pr-corps">
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
                                   bg-bg-tertiary text-fg-secondary border border-border-subtle">
                        Prêt
                      </span>
                    }
                    @if (currentTripIndex() >= 0) {
                      <span class="text-[10px] text-fg-secondary font-mono">
                        Trajet {{ currentTripIndex() + 1 }}/{{ tripCount() }}
                      </span>
                    }
                  </div>
                </div>

                <div class="mt-2 flex items-baseline gap-2">
                  <div class="font-mono text-fg-primary text-base sm:text-lg leading-none">
                    {{ currentTimestamp() | date:'HH:mm:ss' }}
                  </div>
                  <div class="text-[11px] text-fg-secondary leading-none">
                    {{ currentTimestamp() | date:'EEE dd MMM' }}
                  </div>
                </div>

                <div class="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <!-- « Vitesse » était un mensonge : c'est la moyenne du trajet, constante
                         du départ à l'arrivée. Ce replay ne charge pas les relevés GPS des
                         trajets (seul le replay d'UN trajet les reçoit avec son analyse), donc
                         il ne peut pas afficher une vitesse instantanée — il le DIT. -->
                    <div class="text-[9px] text-fg-secondary uppercase tracking-wider">{{ libelleVitesse() }}</div>
                    <div class="font-mono text-sm flex items-baseline gap-0.5"
                         [class.text-fg-primary]="currentState() === 'stop'"
                         [class.pr-hud-moyenne]="currentState() !== 'stop'">
                      <span>{{ currentSpeedKmh() | number:'1.0-0' }}</span>
                      <span class="text-[9px] text-fg-secondary">km/h</span>
                    </div>
                  </div>
                  <div>
                    <div class="text-[9px] text-fg-secondary uppercase tracking-wider">Parcouru</div>
                    <div class="font-mono text-fg-primary text-sm flex items-baseline gap-0.5">
                      <span>{{ (cumulDistanceM() / 1000) | number:'1.1-1' }}</span>
                      <span class="text-[9px] text-fg-secondary">km</span>
                    </div>
                  </div>
                  <div>
                    @if (currentState() === 'stop' && currentStopRemainingMs() > 0) {
                      <div class="text-[9px] text-amber-300/80 uppercase tracking-wider">Arrêt</div>
                      <div class="font-mono text-amber-300 text-sm">
                        {{ formatDur(currentStopRemainingMs() / 1000) }}
                      </div>
                    } @else {
                      <div class="text-[9px] text-fg-secondary uppercase tracking-wider">Écoulé</div>
                      <div class="font-mono text-fg-primary text-sm">
                        {{ formatDur(virtualMs() / 1000) }}
                      </div>
                    }
                  </div>
                </div>

                <p class="pr-hud-note">
                  Vitesse moyenne du trajet en cours, pas une mesure à cet instant.
                  Le détail d'un trajet s'ouvre depuis sa ligne.
                </p>
              </div>
            }
          </div>

          <!-- Les trajets de la période, cliquables. Le curseur seul obligeait à
               chercher à l'aveugle le début d'un trajet précis. -->
          @if (trajets().length) {
            <aside class="pr-aside">
              <h3 class="pr-aside-titre">
                Les trajets
                <span>{{ trajets().length }}</span>
              </h3>
              <ul class="pr-trajets">
                @for (t of trajets(); track t.startMs) {
                  <li>
                    <button type="button" class="pr-trajet"
                            [class.pr-trajet--on]="currentTripIndex() + 1 === t.rang"
                            (click)="allerAMs(t.startMs)">
                      <span class="pr-trajet-r">{{ t.rang }}</span>
                      <span class="pr-trajet-c">
                        <span class="pr-trajet-h">{{ t.heure }}</span>
                        <span class="pr-trajet-d">{{ t.distance }} · {{ t.duree }}</span>
                      </span>
                    </button>
                  </li>
                }
              </ul>
            </aside>
          }
          </div>

          <!-- Footer : controles play/pause + scrubber + speed -->
          <div class="shrink-0 border-t border-border-subtle bg-bg-secondary/95 backdrop-blur
                      px-3 sm:px-4 py-3 flex flex-col gap-2">

            <!-- UNE BARRE PAR JOUR. Une frise continue de trois jours laissait les
                 nuits occuper la majeure partie de la barre sans rien porter, et
                 ne disait pas quel jour avait eu de l'activité. -->
            <div class="pr-jours">
              @for (j of journees(); track j.cle) {
                <div class="pr-jour">
                  <div class="pr-jour-h">
                    <span class="pr-jour-nom">{{ j.libelle }}</span>
                    <span class="pr-jour-n">{{ j.nbTrajets }} trajet{{ j.nbTrajets > 1 ? 's' : '' }}</span>
                  </div>
                  <div class="pr-barre touch-none select-none"
                       role="slider" tabindex="0"
                       [attr.aria-label]="'Position dans la journée du ' + j.libelle"
                       [attr.aria-valuetext]="j.nbTrajets + ' trajets'"
                       (pointerdown)="onBarreJour($event, j)">
                    @for (b of j.blocs; track $index) {
                      <div class="absolute top-0 bottom-0"
                           [class]="b.kind === 'trip' ? 'pr-seg-trip' : 'pr-seg-stop'"
                           [style.left.%]="b.gauche" [style.width.%]="b.largeur"
                           [title]="b.kind === 'trip' ? 'Trajet' : 'Arrêt'"></div>
                    }
                    @if (curseurDansJour(j); as c) {
                      <div class="pr-curseur" [style.left.%]="c.pos"></div>
                    }
                  </div>
                </div>
              }
              @if (journees().length) {
                <p class="pr-jours-note">Les creux sont les arrêts. Une barre s'arrête à la dernière arrivée du jour.</p>
              }
            </div>

            <!-- Controles -->
            <div class="flex items-center gap-2 sm:gap-3">
              <button (click)="togglePlay()"
                      class="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-full
                             bg-tracky/15 border border-tracky/30 text-tracky-light
                             hover:bg-tracky/25 cursor-pointer transition-colors"
                      [attr.aria-label]="playing() ? 'Pause' : 'Lecture'">
                @if (playing()) {
                  <lucide-icon [img]="PauseIcon" [size]="18"></lucide-icon>
                } @else {
                  <lucide-icon [img]="PlayIcon" [size]="18"></lucide-icon>
                }
              </button>

              <div class="flex-1 min-w-0 flex flex-wrap gap-1 justify-end items-center">
                @for (preset of speedPresets; track preset.label) {
                  <button (click)="setSpeed(preset.factor)" class="pr-mult"
                          [attr.aria-pressed]="speedFactor() === preset.factor && !autoSpeed()"
                          [class.pr-mult--on]="speedFactor() === preset.factor && !autoSpeed()">
                    {{ preset.label }}
                  </button>
                }
                <button (click)="setSpeedAuto()" class="pr-mult"
                        [attr.aria-pressed]="autoSpeed()"
                        [class.pr-mult--on]="autoSpeed()">
                  Adapter
                </button>
              </div>
            </div>

            <!-- « 600× » ne dit ni ce qu'une seconde représente, ni combien de temps
                 on va rester devant l'écran. Et « Adapter » choisissait un facteur
                 sans jamais le dire : il est nommé ici. -->
            <p class="pr-equiv">
              @if (autoSpeed()) { <strong>Adapté à {{ speedFactor() }}×</strong> — } {{ equivalentVitesse() }}
            </p>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .pr-shell {
      /* La top-bar de l'app (z-1800) repeint par-dessus le replay sur iOS (stacking
         context piege). On descend le contenu SOUS la top-bar (hauteur 56px + safe-area
         + 10px = env+66px) pour que le bouton X reste atteignable. */
      padding-top: calc(env(safe-area-inset-top) + 70px);
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

    /* ─── Une barre par jour ─── */
    .pr-jours { display: grid; gap: 6px; }
    .pr-jour { display: grid; gap: 3px; }
    .pr-jour-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .pr-jour-nom { font-size: 11.5px; font-weight: 700; color: var(--fg-primary); text-transform: capitalize; }
    .pr-jour-n { font-size: 11px; color: var(--fg-secondary); }
    /* 44 px : la barre est la commande principale de cet ecran, et elle se saisit
       au doigt. La hauteur VUE reste fine — le reste est de la surface de visee. */
    .pr-barre {
      position: relative; height: 44px; border-radius: 8px; overflow: hidden;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      cursor: pointer;
    }
    .pr-curseur {
      position: absolute; top: 0; bottom: 0; width: 2px;
      background: var(--fg-primary); box-shadow: 0 0 0 1px var(--bg-secondary);
      pointer-events: none;
    }
    .pr-jours-note { margin: 2px 0 0; font-size: 11px; line-height: 1.4; color: var(--fg-secondary); }
    /* La plaque etait en text-tracky-light sur un lavis vert : 3,43:1 en clair.
       --texte-succes est la valeur assombrie prevue pour du petit texte. */
    .pr-plaque { color: var(--texte-succes); }
    .pr-equiv { margin: 0; font-size: 11.5px; line-height: 1.4; color: var(--fg-secondary); text-align: right; }
    .pr-equiv strong { color: var(--fg-primary); font-weight: 700; }
    .pr-mult {
      min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 10px;
      font-size: 11.5px; font-weight: 600; cursor: pointer;
      background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle);
    }
    .pr-mult--on {
      background: color-mix(in srgb, var(--color-tracky-light) 18%, transparent);
      color: var(--texte-succes); border-color: transparent;
    }

    /* ─── Les trajets, a cote de la carte au-dela de 1024 px ─── */
    .pr-corps { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .pr-aside {
      display: flex; flex-direction: column; min-height: 0; max-height: 34%;
      border-top: 1px solid var(--border-subtle); background: var(--bg-secondary);
    }
    @media (min-width: 1024px) {
      .pr-corps { flex-direction: row; }
      .pr-aside { max-height: none; width: 280px; flex: none; border-top: none; border-left: 1px solid var(--border-subtle); }
    }
    .pr-aside-titre {
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      margin: 0; padding: 10px 12px 6px; font-size: 12.5px; font-weight: 700; color: var(--fg-primary);
    }
    .pr-aside-titre span { font-size: 11px; font-weight: 600; color: var(--fg-secondary); }
    .pr-trajets { list-style: none; margin: 0; padding: 0 8px 10px; overflow-y: auto; display: grid; gap: 3px; }
    .pr-trajet {
      width: 100%; min-height: 44px; display: flex; align-items: center; gap: 9px;
      padding: 6px 8px; border-radius: 9px; text-align: left; cursor: pointer;
      background: transparent; border: 1px solid transparent;
    }
    .pr-trajet:hover { background: var(--bg-tertiary); }
    .pr-trajet--on {
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
    }
    .pr-trajet-r {
      flex: none; width: 22px; height: 22px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--bg-quaternary); color: var(--fg-primary);
      font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
    }
    .pr-trajet--on .pr-trajet-r { background: color-mix(in srgb, var(--color-tracky-light) 22%, transparent); color: var(--texte-succes); }
    .pr-trajet-c { display: grid; gap: 1px; min-width: 0; }
    .pr-trajet-h { font-size: 12px; font-weight: 600; color: var(--fg-primary); text-transform: capitalize; }
    .pr-trajet-d { font-size: 11px; color: var(--fg-secondary); }
    /* Une valeur qui n'est PAS une mesure ne prend pas l'encre d'une mesure. */
    .pr-hud-moyenne { color: var(--fg-secondary); }
    .pr-hud-note { margin: 8px 0 0; font-size: 10.5px; line-height: 1.35; color: var(--fg-tertiary); }
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

  /**
   * Ce que la case de vitesse affirme.
   *
   * À l'arrêt, 0 km/h est un FAIT (le véhicule est entre deux trajets). En roulant,
   * la valeur est la moyenne du trajet — la nommer « Vitesse » laissait croire à une
   * mesure prise à l'instant affiché, y compris pendant un excès.
   */
  protected readonly libelleVitesse = computed(
    () => (this.currentState() === 'stop' ? 'À l\'arrêt' : 'V. moyenne'),
  );

  protected readonly speedPresets = [
    { label: '60×', factor: 60 },     // 1 min reelle / sec
    { label: '600×', factor: 600 },   // 10 min / sec
    { label: '1800×', factor: 1800 }, // 30 min / sec — l'ecart 600 -> 3600 etait trop grand
    { label: '3600×', factor: 3600 }, // 1 h / sec
  ];

  /**
   * Ce que le multiplicateur veut dire, en clair : ce qu'une seconde de lecture
   * représente, et le temps qu'on va rester devant l'écran. « 600× » ne le dit pas.
   */
  protected readonly equivalentVitesse = computed(() => {
    const f = this.speedFactor();
    const tl = this.timeline();
    const parSeconde = this.dureeCourte(f);
    if (!tl || tl.totalMs <= 0) return `${parSeconde} par seconde`;
    return `${parSeconde} par seconde · la période en ${this.dureeCourte(tl.totalMs / 1000 / f)}`;
  });

  /**
   * Une barre PAR JOUR, plutôt qu'une frise continue.
   *
   * On voit immédiatement quel jour a eu de l'activité, et les nuits ne mangent plus
   * la barre : chaque journée s'étend de son premier départ à sa dernière arrivée.
   * Un segment est rattaché au jour où il COMMENCE — un arrêt de nuit appartient à
   * la soirée qui l'ouvre, pas au matin qui le referme.
   */
  protected readonly journees = computed<Journee[]>(() => {
    const tl = this.timeline();
    if (!tl || tl.segments.length === 0) return [];

    const groupes = new Map<string, Segment[]>();
    for (const s of tl.segments) {
      const d = new Date(s.startMs);
      const cle = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const liste = groupes.get(cle);
      if (liste) liste.push(s); else groupes.set(cle, [s]);
    }

    const out: Journee[] = [];
    for (const [cle, segs] of groupes) {
      // La fenêtre est bornée par les TRAJETS, pas par les segments. Un arrêt du soir
      // court jusqu'au lendemain matin : le borner sur lui étirerait la barre sur la
      // nuit, et elle en occuperait la majeure partie — mesuré à 58 % et 71 %, soit
      // exactement le défaut que cette barre par jour existe pour supprimer.
      const trajets = segs.filter((s) => s.kind === 'trip');
      const bornes = trajets.length ? trajets : segs;
      const debutMs = Math.min(...bornes.map((s) => s.startMs));
      const finMs = Math.max(...bornes.map((s) => s.endMs));
      const etendue = Math.max(1, finMs - debutMs);

      const blocs: BlocJour[] = [];
      for (const s of segs) {
        // Un segment qui sort de la fenêtre est rogné ; celui qui n'y entre pas
        // du tout — la nuit — n'est pas dessiné.
        const d = Math.max(s.startMs, debutMs);
        const f = Math.min(s.endMs, finMs);
        if (f <= d) continue;
        const gauche = ((d - debutMs) / etendue) * 100;
        const largeur = ((f - d) / etendue) * 100;
        blocs.push({ kind: s.kind, gauche, largeur: Math.max(0.4, Math.min(100 - gauche, largeur)) });
      }

      out.push({
        cle,
        libelle: new Date(debutMs).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }),
        nbTrajets: trajets.length,
        debutMs, finMs, blocs,
      });
    }
    return out.sort((a, b) => a.debutMs - b.debutMs);
  });

  /** Les trajets de la période, cliquables — on saute au départ de celui qu'on désigne. */
  protected readonly trajets = computed(() => {
    const tl = this.timeline();
    if (!tl) return [];
    return tl.segments
      .filter((s): s is TripSegment => s.kind === 'trip')
      .map((s, i) => ({
        rang: i + 1,
        startMs: s.startMs,
        heure: new Date(s.startMs).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
        distance: `${(s.totalDistMeters / 1000).toFixed(1)} km`,
        duree: this.dureeCourte(s.durationMs / 1000),
      }));
  });

  /** « 45 s », « 12 min », « 3 h 20 », « 2 j 4 h » — court, sans zéro inutile. */
  protected dureeCourte(secondes: number): string {
    const s = Math.max(0, Math.round(secondes));
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return rm ? `${h} h ${String(rm).padStart(2, '0')}` : `${h} h`;
    const j = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${j} j ${rh} h` : `${j} j`;
  }

  /**
   * Position du curseur dans la barre d'un jour — `null` si la lecture est ailleurs.
   *
   * Renvoie un OBJET et non un nombre : `@if (…; as pos)` teste la véracité, et une
   * position de `0 %` — le tout début d'une journée — est fausse. Le curseur
   * disparaissait donc au premier trajet de chaque jour.
   */
  protected curseurDansJour(j: Journee): { pos: number } | null {
    const tl = this.timeline();
    if (!tl || tl.segments.length === 0) return null;
    const absolu = tl.segments[0]!.startMs + this.virtualMs();
    if (absolu < j.debutMs || absolu > j.finMs) return null;
    return { pos: ((absolu - j.debutMs) / Math.max(1, j.finMs - j.debutMs)) * 100 };
  }

  /** Saute à une date absolue de la période. */
  protected allerAMs(absoluMs: number): void {
    const tl = this.timeline();
    if (!tl || tl.segments.length === 0) return;
    const cible = Math.max(0, Math.min(tl.totalMs, absoluMs - tl.segments[0]!.startMs));
    this.virtualMs.set(cible);
    this.applyVirtualMs(tl, cible, /* updateCumul= */ true);
  }

  protected onBarreJour(ev: PointerEvent, j: Journee): void {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    this.allerAMs(j.debutMs + ratio * (j.finMs - j.debutMs));
  }

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;
  private markerEl: HTMLElement | null = null;
  private animId: number | null = null;
  private lastFrameTime = 0;
  private resizeObserver: ResizeObserver | null = null;
  /**
   * Toutes les minuteries armées par cet écran (init différée, resize défensifs).
   *
   * Elles étaient des variables locales que personne n'annulait : fermer puis rouvrir
   * le replay en moins de 3 s laissait la minuterie de garde de l'ouverture précédente
   * tirer sur la nouvelle carte et afficher « la carte n'a pas pu se charger » alors
   * qu'elle arrivait.
   */
  private minuteries: number[] = [];
  /** La minuterie de garde du chargement de carte — annulée dès que 'load' arrive. */
  private loadGuardId: number | null = null;

  /** Arme une minuterie SUIVIE : elle se retire de la liste en tirant. */
  private armer(fn: () => void, delaiMs: number): void {
    const id = window.setTimeout(() => {
      this.minuteries = this.minuteries.filter((x) => x !== id);
      fn();
    }, delaiMs);
    this.minuteries.push(id);
  }

  /** Annule toute minuterie en attente — fermeture, ou nouvelle ouverture. */
  private annulerMinuteries(): void {
    for (const id of this.minuteries) window.clearTimeout(id);
    this.minuteries = [];
    if (this.loadGuardId != null) { window.clearTimeout(this.loadGuardId); this.loadGuardId = null; }
  }

  // --- Lifecycle ---

  /** Effect : recompute la timeline a chaque changement d'open/trips. */
  /** Le replay a-t-il été ouvert depuis le dernier nettoyage ? */
  private ouvertPrecedemment = false;

  private initEffect = effect(() => {
    const isOpen = this.open();
    const trips = this.trips();
    if (!isOpen) {
      /**
       * ⚠️ FERMETURE PAR LE PARENT, sans passer par le bouton.
       *
       * `onClose()` nettoie déjà — mais il n'est appelé que par le bouton et par Échap. Si
       * l'écran repasse `open` à faux autrement, la timeline restait en mémoire : pour un
       * mois de trajets, c'est plusieurs mégaoctets de points GPS conservés par une modale
       * que plus personne ne regarde.
       *
       * Le drapeau évite de relire un signal écrit par `cleanup()` — ce qui rendrait cet
       * effet dépendant de sa propre écriture.
       */
      if (this.ouvertPrecedemment) {
        this.ouvertPrecedemment = false;
        this.cleanup();
      }
      return;
    }
    this.ouvertPrecedemment = true;
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
    // Approche simple, calquee sur trip-replay (qui marche) : setTimeout 200ms
    // pour laisser Angular finir le rendu du modal, puis init. ResizeObserver
    // posterieur gere les changements de taille (rotation, animation modal).
    // La minuterie est SUIVIE : deux ouvertures rapprochees en armaient deux.
    this.annulerMinuteries();
    this.armer(() => this.initMap(), 200);
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

  /*
   * La frise UNIQUE et ses trois gestionnaires de pointeur vivaient ici. Elle est
   * remplacee par une barre par jour : chacune connait sa propre fenetre de temps,
   * donc `onBarreJour()` suffit — il n'y a plus de ratio global a projeter.
   */

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
    // Une init chasse l'autre : la garde et les resize de la precedente n'ont plus
    // rien a surveiller.
    this.annulerMinuteries();
    const tl = this.timeline();
    const el = this.mapRef()?.nativeElement;
    this.mapError.set(null);
    this.mapReady.set(false);
    if (!tl || !el) {
      this.mapError.set(`Init aborted: tl=${!!tl} el=${!!el}`);
      return;
    }
    if (!tl.firstLngLat) {
      this.mapError.set(`Aucun point GPS exploitable dans la periode (${tl.segments.length} segments)`);
      return;
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
      this.mapError.set(`createMap: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Garde-fou : si 'load' n'a pas fire en 3s, affiche un encart d'erreur.
    this.loadGuardId = window.setTimeout(() => {
      this.loadGuardId = null;
      if (!this.mapReady()) {
        const w = el.clientWidth, h = el.clientHeight;
        this.mapError.set(
          `La carte n'a pas pu se charger (delai 3s depasse) — ` +
          `conteneur ${w}x${h}px, style "${styleId}". Vérifiez le reseau (tuiles).`,
        );
      }
    }, 3000);

    this.map.on('error', (ev: any) => {
      const msg = ev?.error?.message ?? ev?.message ?? 'unknown error';
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
      if (!this.map) return;
      this.mapReady.set(true);
      if (this.loadGuardId != null) { window.clearTimeout(this.loadGuardId); this.loadGuardId = null; }
      // Polylignes en fond : toutes les lignes des trips.
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
            'line-color': COULEURS_CARTE.trace,
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
    this.armer(() => this.map?.resize(), 50);
    this.armer(() => this.map?.resize(), 250);
    this.armer(() => this.map?.resize(), 600);
  }

  private disposeMap(): void {
    // La carte s'en va : plus rien a surveiller ni a redimensionner.
    this.annulerMinuteries();
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
    trajetsSansTrace: 0, metresSansTrace: 0,
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

  let trajetsSansTrace = 0;
  let metresSansTrace = 0;

  for (let i = 0; i < valid.length; i++) {
    const { t, startMs, endMs } = valid[i]!;
    const points = parseTripPolyline(t);
    if (points.length < 2) {
      // Rien à dessiner — mais le trajet a bien eu lieu, et ses kilomètres comptent
      // dans l'indicateur de la page. On les retient pour pouvoir l'expliquer.
      trajetsSansTrace++;
      metresSansTrace += max0(t.distanceMeters);
      continue;
    }

    const cumul = computeCumulDistMeters(points);
    const geometrique = cumul[cumul.length - 1] ?? 0;
    /**
     * ⚠️ LA FORME VIENT DE LA TRACE, LA GRANDEUR VIENT DU TRAJET.
     *
     * Le compteur qui défile pendant la lecture suivait la géométrie simplifiée ; il
     * finissait donc sous le total, et sous l'indicateur de la page. On met la distance
     * cumulée À L'ÉCHELLE de la distance enregistrée : le tracé reste le même, mais le
     * chiffre qui court sous les yeux atterrit exactement sur celui du bandeau.
     */
    const declaree = max0(t.distanceMeters);
    const facteur = geometrique > 0 && declaree > 0 ? declaree / geometrique : 1;
    const cumulEchelle = facteur === 1 ? cumul : cumul.map((m) => m * facteur);
    const seg: TripSegment = {
      kind: 'trip',
      trip: t,
      startMs, endMs,
      durationMs: endMs - startMs,
      points,
      cumulDistMeters: cumulEchelle,
      totalDistMeters: cumulEchelle[cumulEchelle.length - 1] ?? 0,
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
  // Somme des distances ENREGISTRÉES des trajets rejoués — la même grandeur que
  // l'indicateur « Distance », aux trajets sans trace près, qui sont annoncés à part.
  const totalDistanceMeters = segments
    .filter((s): s is TripSegment => s.kind === 'trip')
    .reduce((sum, s) => sum + max0(s.totalDistMeters), 0);

  return {
    segments, totalMs, totalDistanceMeters,
    trajetsSansTrace, metresSansTrace,
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
