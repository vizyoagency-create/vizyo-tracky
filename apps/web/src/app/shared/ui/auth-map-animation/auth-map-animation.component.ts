import {
  AfterViewInit,
  Component,
  ElementRef,
  HostBinding,
  NgZone,
  OnDestroy,
  inject,
  input,
  viewChild,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { MapService } from '../../../core/services/map.service';
import { routeAnimationState, type RouteSegment } from '../../utils/route-animation';

/**
 * Mini-carte 3D de la France placee sous la card de login : carte raster
 * sombre + DEM Terrarium pour le relief, vue inclinee, oscillation lente
 * du bearing pour l'ambiance, et un vehicule qui sillonne Paris -> Lyon
 * -> Marseille -> Bordeaux -> Nantes -> Paris pour evoquer concretement
 * le metier (suivi de flotte GPS sur le terrain).
 *
 * Implementation : on s'appuie sur `MapService.createMap()` (le meme
 * pipeline que la page Map et la mini-map du dashboard) puis on ajoute
 * une source raster-dem + un layer hillshade + setTerrain dans le
 * `load`. Decoratif donc on desactive les controles et on neutralise les
 * handlers d'interaction apres init.
 */
type CityKey = 'paris' | 'lyon' | 'marseille' | 'bordeaux' | 'nantes';
interface City {
  key: CityKey;
  name: string;
  lng: number;
  lat: number;
  /** Direction du label par rapport au dot. */
  pos: 'top' | 'right' | 'left';
}

const CITIES: City[] = [
  { key: 'paris',     name: 'Paris',     lng: 2.3522,  lat: 48.8566, pos: 'top'   },
  { key: 'lyon',      name: 'Lyon',      lng: 4.8357,  lat: 45.7640, pos: 'right' },
  { key: 'marseille', name: 'Marseille', lng: 5.3698,  lat: 43.2965, pos: 'right' },
  { key: 'bordeaux',  name: 'Bordeaux',  lng: -0.5792, lat: 44.8378, pos: 'left'  },
  { key: 'nantes',    name: 'Nantes',    lng: -1.5536, lat: 47.2184, pos: 'left'  },
];

/** Trajet boucle Paris -> Lyon -> Marseille -> Bordeaux -> Nantes -> Paris. */
const ROUTE_ORDER: CityKey[] = ['paris', 'lyon', 'marseille', 'bordeaux', 'nantes', 'paris'];
/** Duree d'un tour complet (ms). 40s = ~8s par segment, vitesse posee. */
const LOOP_MS = 40_000;

@Component({
  selector: 'app-auth-map-animation',
  standalone: true,
  template: `
    <div class="map-wrap" aria-hidden="true">
      <div #mapContainer class="map-canvas"></div>
      <!-- Vignettage + fade haut/bas pour fondre la carte dans la card -->
      <div class="map-mask" [class.map-mask--fullbleed]="fullBleed()"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        max-width: 28rem;
        margin: 0 auto;
        pointer-events: none;
      }
      /* Mode plein-cadre desktop : la carte occupe tout son conteneur,
         pas de max-width, pas de border-radius (le panneau parent gere
         les arrondis si besoin). */
      :host(.is-fullbleed) {
        width: 100%;
        height: 100%;
        max-width: none;
        margin: 0;
      }

      .map-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 400 / 220;
        border-radius: 18px;
        overflow: hidden;
        box-shadow:
          0 14px 40px -16px rgba(0, 0, 0, 0.55),
          0 0 0 1px rgba(255, 255, 255, 0.06) inset;
        background: #0a0f0d;
      }
      :host(.is-fullbleed) .map-wrap {
        height: 100%;
        aspect-ratio: auto;
        border-radius: 0;
        box-shadow: none;
      }
      :host-context([data-theme='light']) .map-wrap {
        box-shadow:
          0 18px 38px -18px rgba(5, 105, 70, 0.35),
          0 0 0 1px rgba(16, 185, 129, 0.18) inset;
      }

      .map-canvas {
        position: absolute;
        inset: 0;
      }

      /* Fade pour fondre les bords (effet "carte qui flotte") */
      .map-mask {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 2;
        background:
          radial-gradient(
            ellipse at center,
            transparent 65%,
            rgba(10, 15, 13, 0.4) 100%
          ),
          linear-gradient(
            to bottom,
            rgba(10, 15, 13, 0.25) 0%,
            transparent 18%,
            transparent 82%,
            rgba(10, 15, 13, 0.4) 100%
          );
      }
      /* En plein-cadre, le mask sert plutot a fondre la carte vers le
         panneau formulaire a gauche (transition propre entre les deux
         moities de l'ecran) + un voile bas/haut subtil pour l'ambiance. */
      .map-mask--fullbleed {
        background:
          linear-gradient(
            to right,
            rgba(10, 15, 13, 0.85) 0%,
            rgba(10, 15, 13, 0.25) 12%,
            transparent 28%
          ),
          linear-gradient(
            to bottom,
            rgba(10, 15, 13, 0.45) 0%,
            transparent 22%,
            transparent 78%,
            rgba(10, 15, 13, 0.45) 100%
          );
      }
      /* Light theme : la carte reste sombre (dark style CARTO + relief),
         mais on remplace le fade gauche par un voile blanc qui se fond
         dans le panneau formulaire blanc, sans le ternir lui. */
      :host-context([data-theme='light']) .map-mask--fullbleed {
        background:
          linear-gradient(
            to right,
            rgba(255, 255, 255, 0.92) 0%,
            rgba(255, 255, 255, 0.35) 10%,
            transparent 26%
          ),
          linear-gradient(
            to bottom,
            rgba(255, 255, 255, 0.35) 0%,
            transparent 22%,
            transparent 78%,
            rgba(255, 255, 255, 0.35) 100%
          );
      }
      /* Mini-map (mobile) light theme : voile blanc subtil */
      :host-context([data-theme='light']) .map-mask:not(.map-mask--fullbleed) {
        background:
          radial-gradient(
            ellipse at center,
            transparent 60%,
            rgba(255, 255, 255, 0.5) 100%
          ),
          linear-gradient(
            to bottom,
            rgba(255, 255, 255, 0.45) 0%,
            transparent 25%,
            transparent 70%,
            rgba(255, 255, 255, 0.55) 100%
          );
      }


      /* === Markers (les elements sont crees en JS, donc ::ng-deep) ===
         Important : position absolute (et non relative) pour que la
         position du marker soit pilotee uniquement par le transform que
         MapLibre injecte (translate vers lat/lng). En position relative,
         les markers s'empilent dans le flux DOM et accumulent un
         decalage Y (chaque marker pousse le suivant), ce qui les
         desaligne du basemap. */
      :host ::ng-deep .auth-city {
        width: 10px;
        height: 10px;
        position: absolute;
        pointer-events: none;
      }
      /* Halo statique tres discret -- on retire la pulsation pour calmer
         la scene (un vehicule en mouvement suffit a la rendre vivante). */
      :host ::ng-deep .auth-city__halo {
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(16, 224, 160, 0.32), transparent 70%);
      }
      :host ::ng-deep .auth-city__dot {
        position: absolute;
        inset: 2.5px;
        border-radius: 50%;
        background: #10e0a0;
        box-shadow: 0 0 6px rgba(16, 224, 160, 0.7);
      }
      :host ::ng-deep .auth-city__label {
        position: absolute;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.92);
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
        white-space: nowrap;
        pointer-events: none;
      }
      :host ::ng-deep .auth-city__label[data-pos='top']    { left: 6px;  top: -4px;  transform: translate(-50%, -100%); }
      :host ::ng-deep .auth-city__label[data-pos='right']  { left: 18px; top: 6px;   transform: translate(0, -50%);    }
      :host ::ng-deep .auth-city__label[data-pos='left']   { left: -6px; top: 6px;   transform: translate(-100%, -50%); }

      /* Vehicule = camionnette stylisee de profil. Aspect ratio 260:130
         (~2:1). On la rend orientable via .auth-vehicle__inner : un flip
         horizontal (scaleX -1) est applique en JS quand le segment va
         vers l'ouest (sinon elle roule en marche arriere). */
      :host ::ng-deep .auth-vehicle {
        width: 44px;
        height: 22px;
        pointer-events: none;
        will-change: transform;
        filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.45));
      }
      :host(.is-fullbleed) ::ng-deep .auth-vehicle {
        width: 64px;
        height: 32px;
      }
      :host ::ng-deep .auth-vehicle__inner {
        width: 100%;
        height: 100%;
        display: block;
        transform-origin: center;
        transition: transform 0.4s cubic-bezier(0.5, 0, 0.5, 1);
      }
      :host ::ng-deep .auth-vehicle__pulse {
        position: absolute;
        left: 50%;
        bottom: -2px;
        width: 32px;
        height: 32px;
        margin-left: -16px;
        border-radius: 50%;
        background: rgba(16, 224, 160, 0.32);
        animation: auth-vehicle-pulse 2.4s ease-out infinite;
        pointer-events: none;
      }
      :host(.is-fullbleed) ::ng-deep .auth-vehicle__pulse {
        width: 44px;
        height: 44px;
        margin-left: -22px;
      }

      @keyframes auth-vehicle-pulse {
        0%   { transform: scale(0.4); opacity: 0.7; }
        100% { transform: scale(1.6); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        :host ::ng-deep .auth-vehicle__pulse { animation: none; opacity: 0.4; }
      }
    `,
  ],
})
export class AuthMapAnimationComponent implements AfterViewInit, OnDestroy {
  /** En mode plein-cadre desktop : pas de max-width, pas de border-radius,
   *  fade gauche pour transition vers le panneau formulaire, badge "Temps
   *  reel" en overlay et parametres camera plus dramatiques (pitch eleve,
   *  zoom resserre). */
  readonly fullBleed = input(false);

  @HostBinding('class.is-fullbleed') get fullBleedClass(): boolean {
    return this.fullBleed();
  }

  private readonly mapRef = viewChild<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly zone = inject(NgZone);
  private readonly mapSvc = inject(MapService);

  private map: MlMap | null = null;
  private vehicleMarker: MlMarker | null = null;
  private vehicleEl: HTMLElement | null = null;
  private cityMarkers: MlMarker[] = [];
  private rafId = 0;
  private destroyed = false;
  private readonly onVisibility = (): void => {
    if (this.destroyed) return;
    if (document.visibilityState === 'visible' && !this.map) {
      this.initMap();
    }
  };

  ngAfterViewInit(): void {
    // On ne cree la carte qu'une fois la tab visible : maplibre utilise
    // rAF pour son render loop, fortement throttle quand la tab est en
    // arriere-plan -- ce qui peut bloquer l'init des tuiles. On attend
    // donc proprement, et on n'a pas besoin de retomber dessus apres.
    if (document.visibilityState === 'visible') {
      setTimeout(() => this.initMap(), 0);
    } else {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    for (const m of this.cityMarkers) m.remove();
    this.cityMarkers = [];
    this.vehicleMarker?.remove();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  private initMap(): void {
    const el = this.mapRef()?.nativeElement;
    if (!el || this.map) return;
    document.removeEventListener('visibilitychange', this.onVisibility);

    // On utilise MapService pour beneficier du pipeline de styles raster
    // valide partout dans l'app (URL tiles, headers, NgZone, etc.).
    // Cadrage : en plein-cadre desktop on a un container portrait (~50vw
    // x 100svh), donc on resserre le zoom et accentue le pitch pour que
    // le relief soit hero. En mode mini (mobile) on est en paysage 400x220
    // et il faut tenir les 5 villes dans une lucarne plus contrainte.
    const isFull = this.fullBleed();
    const map = this.mapSvc.createMap(el, {
      center: { lat: isFull ? 46.2 : 45.4, lng: isFull ? 2.5 : 2.6 },
      zoom: isFull ? 4.85 : 4.25,
      style: 'dark',
      pitch: isFull ? 56 : 48,
      bearing: isFull ? -10 : -6,
      withNavigationControl: false,
      withGeolocateControl: false,
      withScaleControl: false,
    });
    this.map = map;

    this.zone.runOutsideAngular(() => {
      // Desactive les interactions une fois la carte creee (la carte est
      // purement decorative).
      map.boxZoom.disable();
      map.dragPan.disable();
      map.dragRotate.disable();
      map.scrollZoom.disable();
      map.doubleClickZoom.disable();
      map.touchZoomRotate.disable();
      map.keyboard.disable();
      map.getCanvas().style.cursor = 'default';

      map.on('load', () => {
        if (this.destroyed) return;
        this.installRelief(map);
        this.addCityMarkers();
        this.addVehicleMarker();
        this.startAnimationLoop();
      });
    });
  }

  /**
   * Ajoute la source raster-dem (Terrarium) + un layer hillshade pour
   * teinter le relief, puis active le terrain 3D.
   */
  private installRelief(map: MlMap): void {
    if (!map.getSource('auth-dem')) {
      map.addSource('auth-dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 12,
      });
    }
    if (!map.getLayer('auth-hillshade')) {
      map.addLayer({
        id: 'auth-hillshade',
        type: 'hillshade',
        source: 'auth-dem',
        paint: {
          'hillshade-exaggeration': 1,
          'hillshade-shadow-color': '#020404',
          'hillshade-highlight-color': '#1ef0a8',
          'hillshade-accent-color': '#0d8a5e',
        },
      });
    }
    try {
      map.setTerrain({ source: 'auth-dem', exaggeration: 1.4 });
    } catch {
      // setTerrain peut echouer si la source DEM n'est pas encore prete ;
      // on retente une fois apres un sourcedata.
      const onSrc = (e: maplibregl.MapSourceDataEvent) => {
        if (e.sourceId === 'auth-dem' && e.isSourceLoaded) {
          map.off('sourcedata', onSrc);
          map.setTerrain({ source: 'auth-dem', exaggeration: 1.4 });
        }
      };
      map.on('sourcedata', onSrc);
    }
  }

  private addCityMarkers(): void {
    if (!this.map) return;
    for (const city of CITIES) {
      const el = document.createElement('div');
      el.className = 'auth-city';
      const halo = document.createElement('div');
      halo.className = 'auth-city__halo';
      const dot = document.createElement('div');
      dot.className = 'auth-city__dot';
      const label = document.createElement('div');
      label.className = 'auth-city__label';
      label.textContent = city.name;
      label.dataset['pos'] = city.pos;
      el.append(halo, dot, label);

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([city.lng, city.lat])
        .addTo(this.map);
      this.cityMarkers.push(marker);
    }
  }

  private addVehicleMarker(): void {
    if (!this.map) return;
    const el = document.createElement('div');
    el.className = 'auth-vehicle';
    // Camionnette Vizyo Tracky stylisee, vue de profil (orientee a droite
    // par defaut). Le flip horizontal pour les segments qui vont vers
    // l'ouest est applique sur .auth-vehicle__inner dans la boucle rAF.
    el.innerHTML = `
      <span class="auth-vehicle__pulse"></span>
      <svg class="auth-vehicle__inner" viewBox="0 0 260 130" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="130" cy="122" rx="100" ry="4" fill="#0A2F24" opacity="0.12"/>
        <path d="M 18 100 L 18 52 Q 18 46 24 44 L 58 32 Q 63 30 70 30 L 232 30 Q 242 30 242 40 L 242 100 Z" fill="#10B981"/>
        <path d="M 24 44 L 58 32 Q 63 30 70 30 L 232 30 Q 242 30 242 40 L 242 44 L 18 52 Z" fill="#34d399" opacity="0.55"/>
        <path d="M 18 90 L 242 90 L 242 100 L 18 100 Z" fill="#059669"/>
        <path d="M 220 42 L 232 34 Q 237 32 238 38 L 238 54 L 220 54 Z" fill="#0F172A"/>
        <path d="M 224 42 L 232 38 L 232 44 L 226 48 Z" fill="#60A5FA" opacity="0.25"/>
        <rect x="180" y="40" width="34" height="14" rx="1.5" fill="#0F172A"/>
        <rect x="184" y="42" width="12" height="4" rx="0.5" fill="#60A5FA" opacity="0.2"/>
        <line x1="172" y1="32" x2="172" y2="90" stroke="#0A2F24" stroke-width="1.5" opacity="0.5"/>
        <line x1="110" y1="32" x2="110" y2="90" stroke="#0A2F24" stroke-width="1.5" opacity="0.5"/>
        <rect x="118" y="62" width="9" height="3" rx="1" fill="#0A2F24"/>
        <circle cx="60" cy="100" r="22" fill="#0A2F24"/>
        <circle cx="200" cy="100" r="22" fill="#0A2F24"/>
        <circle cx="60" cy="100" r="18" fill="#111827"/>
        <circle cx="60" cy="100" r="9" fill="#374151"/>
        <circle cx="60" cy="100" r="3" fill="#6B7280"/>
        <circle cx="200" cy="100" r="18" fill="#111827"/>
        <circle cx="200" cy="100" r="9" fill="#374151"/>
        <circle cx="200" cy="100" r="3" fill="#6B7280"/>
        <ellipse cx="240" cy="70" rx="4" ry="6" fill="#FEF3C7"/>
        <path d="M 234 52 L 244 50 L 244 58 L 236 58 Z" fill="#0A2F24"/>
        <rect x="225" y="86" width="17" height="6" rx="1" fill="#1F2937"/>
        <rect x="20" y="56" width="5" height="20" rx="1" fill="#DC2626"/>
      </svg>`;
    this.vehicleEl = el.querySelector<HTMLElement>('.auth-vehicle__inner');

    this.vehicleMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([CITIES[0]!.lng, CITIES[0]!.lat])
      .addTo(this.map);
  }

  /**
   * Boucle rAF : interpole la position du vehicule sur la polyligne entre
   * villes (vitesse uniforme par segment) et applique une oscillation
   * lente du bearing pour un effet "vivant".
   */
  private startAnimationLoop(): void {
    const start = performance.now();

    const segments: RouteSegment[] = ROUTE_ORDER.slice(0, -1).map((from, i) => {
      const a = CITIES.find((c) => c.key === from)!;
      const b = CITIES.find((c) => c.key === ROUTE_ORDER[i + 1]!)!;
      return { a, b };
    });

    const tick = (now: number) => {
      if (this.destroyed || !this.map || !this.vehicleMarker || !this.vehicleEl) return;

      // `phase` peut etre negative si le timestamp rAF `now` precede le `start`
      // capture synchrones (clock skew / precision rAF clampee, surtout 1ere
      // frame ou retour de background). routeAnimationState wrappe dans [0,1) et
      // clampe l'index sur les deux bornes -> plus aucune frame ne peut crasher.
      const state = routeAnimationState(segments, (now - start) / LOOP_MS);
      if (state) {
        this.vehicleMarker.setLngLat([state.lng, state.lat]);
        // Flip horizontal selon la direction du segment : le SVG par defaut
        // pointe vers l'est (droite). Transition CSS sur .auth-vehicle__inner.
        this.vehicleEl.style.transform = state.facingRight ? 'scaleX(1)' : 'scaleX(-1)';
      }

      const elapsed = (now - start) / 1000;
      const bearing = -6 + Math.sin(elapsed / 18) * 4;
      this.map.setBearing(bearing);

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }
}
