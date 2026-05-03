import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  inject,
  viewChild,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { MapService } from '../../../core/services/map.service';

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
      <div class="map-mask"></div>
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
      :host-context([data-theme='light']) .map-mask {
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

      /* === Markers (les elements sont crees en JS, donc ::ng-deep) === */
      :host ::ng-deep .auth-city {
        width: 10px;
        height: 10px;
        position: relative;
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

      /* Vehicule = pin localisation classique (forme universelle, plus
         lisible qu'un truck minuscule a cette echelle). On le rend
         orientable via .auth-vehicle__inner (rotation appliquee en JS). */
      :host ::ng-deep .auth-vehicle {
        width: 22px;
        height: 22px;
        pointer-events: none;
        will-change: transform;
        filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.55));
      }
      :host ::ng-deep .auth-vehicle__inner {
        width: 100%;
        height: 100%;
        display: block;
        transform-origin: center;
      }
      :host ::ng-deep .auth-vehicle__pulse {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 28px;
        height: 28px;
        margin: -14px 0 0 -14px;
        border-radius: 50%;
        background: rgba(16, 224, 160, 0.35);
        animation: auth-vehicle-pulse 2.2s ease-out infinite;
        pointer-events: none;
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
    // Centre legerement sud pour englober Marseille (43.3°N) avec un
    // pitch eleve. Zoom 4.4 pour tenir Lyon/Bordeaux/Nantes/Marseille dans
    // la mini-fenetre 392x216 sur desktop et garder un cadrage propre
    // sur mobile.
    const map = this.mapSvc.createMap(el, {
      center: { lat: 45.4, lng: 2.6 },
      zoom: 4.25,
      style: 'dark',
      pitch: 48,
      bearing: -6,
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
          'hillshade-exaggeration': 0.85,
          'hillshade-shadow-color': '#020404',
          'hillshade-highlight-color': '#1ef0a8',
          'hillshade-accent-color': '#0d8a5e',
        },
      });
    }
    try {
      map.setTerrain({ source: 'auth-dem', exaggeration: 2.4 });
    } catch {
      // setTerrain peut echouer si la source DEM n'est pas encore prete ;
      // on retente une fois apres un sourcedata.
      const onSrc = (e: maplibregl.MapSourceDataEvent) => {
        if (e.sourceId === 'auth-dem' && e.isSourceLoaded) {
          map.off('sourcedata', onSrc);
          map.setTerrain({ source: 'auth-dem', exaggeration: 2.4 });
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
    el.innerHTML = `
      <span class="auth-vehicle__pulse"></span>
      <svg class="auth-vehicle__inner" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 22s7-7.58 7-13a7 7 0 1 0-14 0c0 5.42 7 13 7 13z"
              fill="#10e0a0" stroke="#053826" stroke-width="1.2" stroke-linejoin="round"/>
        <circle cx="12" cy="9" r="2.4" fill="#053826"/>
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

    const segments = ROUTE_ORDER.slice(0, -1).map((from, i) => {
      const a = CITIES.find((c) => c.key === from)!;
      const b = CITIES.find((c) => c.key === ROUTE_ORDER[i + 1]!)!;
      return { a, b };
    });

    const tick = (now: number) => {
      if (this.destroyed || !this.map || !this.vehicleMarker || !this.vehicleEl) return;

      const t = ((now - start) % LOOP_MS) / LOOP_MS;
      const segLen = 1 / segments.length;
      const segIdx = Math.min(segments.length - 1, Math.floor(t / segLen));
      const localT = (t - segIdx * segLen) / segLen;
      // Easing : in-out cubic pour decoller doucement et freiner pres
      // de chaque ville (au lieu d'une vitesse constante saccadee).
      const eased = localT < 0.5
        ? 4 * localT * localT * localT
        : 1 - Math.pow(-2 * localT + 2, 3) / 2;
      const { a, b } = segments[segIdx]!;
      const lng = a.lng + (b.lng - a.lng) * eased;
      const lat = a.lat + (b.lat - a.lat) * eased;
      this.vehicleMarker.setLngLat([lng, lat]);

      const elapsed = (now - start) / 1000;
      const bearing = -6 + Math.sin(elapsed / 18) * 4;
      this.map.setBearing(bearing);

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }
}
