import {
  AfterViewInit,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  NgZone,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker, Popup, GeoJSONSource } from 'maplibre-gl';
import type { GeofenceDto, PositionUpdateEvent } from '@vizyo/tracky-shared';
import {
  deriveMotion,
  DORMANT_STOP_ACTING_MS,
  DORMANT_STOP_COUNTING_MS,
  extrapolate,
  formatSilenceLabel,
  getVehicleConnectivityState,
  GPS_FIX_STALE_THRESHOLD_MS,
  isAcceptableLiveFix,
  isTrackerOnline,
  isVehicleDormant,
  MOVING_FRESHNESS_MS,
  sanitizePositions,
  type VehicleConnectivityState,
} from '@vizyo/tracky-shared';

/** Distance Haversine en mètres entre deux points GPS. Inline pour éviter
 *  les problèmes de bundle workspace en dev (Vite). */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
import { firstValueFrom } from 'rxjs';
import { ActivityTrackerService } from '../../core/services/activity-tracker.service';
import { GeofencesApiService } from '../../core/services/geofences.service';
import { GpsDeadZonesApiService, type GpsDeadZoneMapDto } from '../../core/services/gps-dead-zones.service';
import { matchDeadZone, deadZoneNatureLabel } from '../../shared/utils/gps-dead-zone';
import { FormsModule } from '@angular/forms';
import { FleetPlacesApiService, type FleetPlaceDto, type FleetPlaceKind } from '../../core/services/fleet-places.service';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { PreferencesService, type CameraMode } from '../../core/services/preferences.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { AuthService } from '../../core/services/auth.service';
import { EngineControlService } from '../../core/services/engine-control.service';
import { VisibilityService } from '../../core/services/visibility.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { MapService } from '../../core/services/map.service';
import { MapBridgeService } from '../../core/services/map-bridge.service';
import { MapStyleService, type MapStyleId } from '../../core/services/map-style.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  speedColor,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../shared/utils/maplibre-markers';
import { catmullRom, lerpHeading } from '../../shared/utils/spline';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { ConnectivityBadgeComponent } from '../../shared/ui/connectivity-badge/connectivity-badge.component';
import { TrackClickDirective } from '../../shared/directives/track-click.directive';

interface MarkerEntry {
  marker: MlMarker;
  el: HTMLElement;
  /**
   * V1.10 (Sprint 3 perf) — AbortController dont le signal est attache aux
   * addEventListener click/dblclick du marker DOM. Abort() au moment de retirer
   * le marker (vehicule filtre / disparu) pour eviter une fuite memoire :
   * sinon les handlers restaient lies a un Element supprime du DOM,
   * empechant son garbage collection. A 100+ vehicules + filtres cliques
   * regulierement, ~30 MB/heure de fuite mesuree.
   */
  abort: AbortController;
}

interface VehicleMeta {
  type: string;
  plate: string;
  /** Marque (texte libre) pour le logo de marque sur le marqueur. */
  brand?: string | null;
  /** V1.15 — Source SA pour la card popup (badge fleet + meta tracker). */
  fleetId?: string | null;
  imei?: string | null;
  lastSeenAt?: string | null;
  /** Sprint 1 (Fondation Groupes) — groupe (single) du véhicule pour le popup carte. */
  group?: { id: string; name: string } | null;
}

/** Donnees affichees dans la bottom card Baanool au clic sur un marker. */
interface BaanoolCardData {
  trackerId: string;
  vehicleId: string;
  plate: string;
  type: string;
  ignition: boolean;
  speedKmh: number;
  lat: number;
  lng: number;
  cutActive: boolean;
  /** Sprint 2 (revue #2) — coupure commandée non confirmée (en attente). Affichage tri-état. */
  cutPending: boolean;
  /** Mode vie privée actif : la position affichée est FIGÉE (dernière connue avant activation). */
  privacyModeEnabled?: boolean;
  /** V1.15 — Contexte SUPER_ADMIN. */
  fleetId?: string | null;
  imei?: string | null;
  lastSeenAt?: string | null;
  /** Incident FS-253 — ISO dernière position GPS + dernière trame `no_fix` (sans lock). */
  lastPositionAt?: string | null;
  lastNoFixAt?: string | null;
  /** Sprint 1 (Fondation Groupes) — groupe (single) du véhicule. */
  group?: { id: string; name: string } | null;
}

/**
 * Lieux clés — données de la card d'un REPÈRE cliqué sur la carte. Deux natures :
 *  - `station` : station-service DÉTECTÉE (agrégat des passages), pas encore adoptée par la flotte ;
 *  - `place`   : lieu de la flotte (station validée, parking, dépôt) → renommable / déplaçable.
 */
type PlaceCardData =
  | {
      type: 'station';
      stationId: string;
      title: string;
      where: string;
      visits: number;
      distinctVehicles: number;
      lastPriceEur: number | null;
      lastVisitAt: string | null;
      lat: number;
      lng: number;
      vehicles: { plate: string | null; visits: number }[];
    }
  | { type: 'place'; place: FleetPlaceDto };

/**
 * Etat de mouvement d'un marker.
 *
 * Entre deux trames Coban (~30s en MOVING), on n'interpole plus from→to (ce qui
 * affichait toujours la position d'il y a ~30s). On extrapole depuis la derniere
 * verite serveur en utilisant `speedKmh + heading` :
 *   target(now) = truth + (now - truthAt) * speedVector
 * puis on lisse `display → target` via un filtre passe-bas exponentiel pour
 * absorber les corrections sans saccade quand la trame suivante arrive.
 *
 * Resultat : l'icone colle au temps reel quand le vehicule roule droit, et
 * corrige doucement sur les virages / freinages.
 */
interface MotionState {
  // Derniere verite serveur (depuis le dernier event WS)
  truthLat: number;
  truthLng: number;
  truthHeading: number;     // cap robuste (deg) — derive du vecteur reel si possible
  truthSpeedMs: number;     // m/s, vitesse robuste = max(rapportee, derivee du deplacement)
  truthAt: number;          // performance.now() a la reception de la trame
  turnRateDegPerS: number;  // yaw rate (deg/s) pour courber l'extrapolation en virage

  // Intervalle inter-trame typique pour ce tracker, lisse en EMA.
  // Sert a borner l'extrapolation : on ne projette jamais plus loin que
  // 1.3 * intervalMs (sinon une coupure GPRS ferait partir l'icone a l'infini).
  intervalMs: number;

  // Position actuellement affichee (drive marker.setLngLat)
  displayLat: number;
  displayLng: number;
  displayHeading: number;

  // V1.10 (Sprint 3 perf) — derniere position EFFECTIVEMENT pushee au marker DOM.
  // Sert a skip les mutations DOM si le delta est < epsilon (cas vehicule arrete
  // ou interpolation stabilisee). A 100 vehicules x 60fps, evite ~6000 ops/s
  // de marker.setLngLat + updateVehicleMarkerEl quand rien ne bouge visiblement.
  pushedLat?: number;
  pushedLng?: number;
  pushedHeading?: number;
}

// Intervalle inter-trame initial avant qu'on en observe un reel (Coban MOVING ~= 30s).
const TYPICAL_INTERVAL_MS = 30_000;
// Borne haute de l'extrapolation = INTERVAL * facteur. Au-dela on fige le marker
// sur la derniere verite (cas trame perdue / GPRS coupe).
const EXTRAPOLATION_CAP_FACTOR = 1.3;
// Constantes de temps (ms) du filtre passe-bas display → target.
// Plus c'est petit, plus c'est reactif. ~250-350ms = correction nette mais sans jitter.
const SMOOTHING_TAU_MS = 350;
const HEADING_TAU_MS = 250;
// Apprentissage EMA pour intervalMs (0.3 = reagit en ~3 trames).
const INTERVAL_EMA_ALPHA = 0.3;
// V1.10 (Sprint 3 perf) — epsilons pour skip les push DOM si le delta entre
// display et derniere valeur pushee est negligeable. 1e-6 deg lat ~= 10 cm,
// 0.3 deg heading = a peine perceptible sur une icone de 32px.
const PUSH_LATLNG_EPSILON = 1e-6;
const PUSH_HEADING_EPSILON = 0.3;
// dt max entre 2 frames RAF : evite un saut enorme apres un retour de tab cache.
const MAX_FRAME_DT_MS = 100;
// Resynchronisation anti-blocage : si N trames consecutives sont rejetees par le
// filtre anti-teleportation MAIS convergent vers la meme nouvelle zone (rayon
// ci-dessous), c'est un vrai deplacement (vehicule deplace pendant une coupure
// GPRS, remorquage) et non un outlier transitoire → on snap au lieu de figer.
const RESYNC_MIN_FRAMES = 3;
const RESYNC_RADIUS_M = 150;

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ConfirmModalComponent, SaFleetBadgeComponent, GroupBadgeComponent, ConnectivityBadgeComponent, TrackClickDirective],
  template: `
    <div #mapContainer style="position:absolute;top:0;left:0;width:100%;height:100%"></div>

    <!-- ════════════════════════════════════════════════════════════
         MOBILE TOP BAR (chip statut + boutons recherche/actions)
         Visible < 768px uniquement
         ════════════════════════════════════════════════════════════ -->
    <div class="tracky-mobile-topbar">
      <!-- Chip statut compacte -->
      <button
        type="button"
        (click)="mobileSheetOpen.set(true)"
        class="tracky-mobile-status-chip">
        @if (realtime.connected()) {
          <span class="tracky-status-dot tracky-status-dot--on"></span>
        } @else {
          <span class="tracky-status-dot"></span>
        }
        <span class="tracky-status-text">{{ filteredPositionCount() }} actif(s)</span>
        @if (cameraMode() !== 'free' && followedPlate()) {
          <span class="tracky-status-follow">· {{ followedPlate() }}</span>
        }
      </button>

      <!-- Bouton recherche mobile -->
      <button
        type="button"
        (click)="mobileSearchOpen.set(!mobileSearchOpen())"
        class="tracky-mobile-fab-sm"
        [class.tracky-mobile-fab-sm--active]="mobileSearchOpen()"
        aria-label="Recherche">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
    </div>

    <!-- Banner Mesure (mobile + visible quand le mode mesure est actif) -->
    @if (measureMode()) {
      <div class="tracky-measure-banner">
        <div class="tracky-measure-banner-info">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 8.7 8.7 21.3a2.4 2.4 0 0 1-3.4 0l-2.6-2.6a2.4 2.4 0 0 1 0-3.4L15.3 2.7a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/></svg>
          <span class="tracky-measure-banner-text">
            @if (measurePoints().length === 0) {
              <span class="tracky-measure-banner-hint">Touchez la carte pour mesurer</span>
            } @else {
              <strong>{{ measureTotalKm() | number:'1.2-2' }} km</strong>
              <span class="tracky-measure-banner-meta">· {{ measurePoints().length }} pt{{ measurePoints().length > 1 ? 's' : '' }}</span>
            }
          </span>
        </div>
        <div class="tracky-measure-banner-actions">
          @if (measurePoints().length > 0) {
            <button (click)="clearMeasure()" class="tracky-measure-banner-btn">Effacer</button>
          }
          <button (click)="toggleMeasure()" class="tracky-measure-banner-close" aria-label="Fermer mesure">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>
    }

    <!-- Banner « Poser un lieu » (surtout mobile : la barre d'outils desktop est masquée). -->
    @if (placeMode() && !pendingPlace()) {
      <div class="tracky-measure-banner">
        <div class="tracky-measure-banner-info">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span class="tracky-measure-banner-text">
            <span class="tracky-measure-banner-hint">Touchez la carte pour poser le lieu</span>
          </span>
        </div>
        <div class="tracky-measure-banner-actions">
          <button (click)="togglePlaceMode()" class="tracky-measure-banner-close" aria-label="Annuler la pose">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>
    }

    <!-- Mobile search overlay (slide-down depuis top bar) -->
    @if (mobileSearchOpen()) {
      <div class="tracky-mobile-search">
        <div class="tracky-mobile-search-inner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--fg-tertiary);flex-shrink:0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            type="search"
            placeholder="Plaque ou adresse..."
            [value]="searchQuery()"
            (keydown.enter)="searchAddress($event)"
            (input)="onSearchInput($event)"
            (focus)="searchFocused.set(true)"
            (blur)="onSearchBlur()"
            autofocus />
          <button type="button" (click)="mobileSearchOpen.set(false); searchQuery.set('')"
                  class="tracky-mobile-search-close" aria-label="Fermer">×</button>
        </div>
        @if (searchFocused() && vehicleMatches().length > 0) {
          <div class="tracky-mobile-search-results">
            @for (v of vehicleMatches(); track v.vehicleId) {
              <button (mousedown)="jumpToVehicle(v.vehicleId); mobileSearchOpen.set(false)"
                      class="tracky-mobile-search-result">
                <span class="font-mono">{{ v.plate }}</span>
                <span class="tracky-mobile-search-result-type">{{ v.type }}</span>
              </button>
            }
          </div>
        }
      </div>
    }

    <!-- ════════════════════════════════════════════════════════════
         DESKTOP HUD top-left : statut realtime + actions
         Caché en mobile (< 768px)
         ════════════════════════════════════════════════════════════ -->
    <!-- HUD top-left : z-index élevé (1800) pour que les suggestions auto-complete
         restent visibles au-dessus du panel Calques (1600) malgré le stacking
         context du wrapper. -->
    <div class="tracky-desktop-hud" style="position:absolute;top:16px;left:16px;z-index:1800">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-4 min-w-[220px]">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-sm font-display font-semibold text-fg-primary">Suivi temps réel</h3>
          @if (realtime.connected()) {
            <span class="w-2 h-2 rounded-full bg-tracky-light animate-pulse"></span>
          } @else {
            <span class="w-2 h-2 rounded-full bg-fg-tertiary animate-pulse"></span>
          }
        </div>
        <p class="text-xs text-fg-secondary">
          {{ filteredPositionCount() }} véhicule(s) actif(s)
          @if (cameraMode() !== 'free' && followedVehicleId()) {
            · <span class="text-tracky-light">Suivi : {{ followedPlate() }}</span>
          }
        </p>
        <div class="flex gap-1.5 mt-3 flex-wrap">
          <button
            (click)="centerAll()"
            class="flex-1 text-xs font-medium py-1.5 rounded-lg
                   bg-tracky/20 text-tracky-light border border-tracky/30
                   hover:bg-tracky/30 transition-colors cursor-pointer">
            Vue d'ensemble
          </button>
          <button
            (click)="centerOnUser()"
            class="px-2 py-1.5 text-xs rounded-lg bg-bg-tertiary/60 border border-border-subtle
                   text-fg-secondary hover:text-fg-primary cursor-pointer"
            [class.text-tracky-light]="userPosition()"
            [class.border-tracky/30]="userPosition()"
            title="Ma position">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="4"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/>
            </svg>
          </button>
          <button
            (click)="toggleFullscreen()"
            class="px-2 py-1.5 text-xs rounded-lg bg-bg-tertiary/60 border border-border-subtle
                   text-fg-secondary hover:text-fg-primary cursor-pointer"
            title="Plein ecran (F)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
            </svg>
          </button>
        </div>
        <div class="flex gap-1.5 mt-1.5 flex-wrap">
          <button
            (click)="toggleMeasure()"
            trackClick="carte-mesure"
            [class]="'flex-1 text-[10px] font-medium py-1.5 rounded-lg cursor-pointer transition-colors ' +
                     (measureMode()
                       ? 'bg-tracky/20 text-tracky-light border border-tracky/40'
                       : 'bg-bg-tertiary/60 text-fg-secondary border border-border-subtle hover:text-fg-primary')"
            title="Mesurer une distance">
            Mesurer
          </button>
          <button
            (click)="shareUrl()"
            class="flex-1 text-[10px] font-medium py-1.5 rounded-lg bg-bg-tertiary/60 border border-border-subtle
                   text-fg-secondary hover:text-fg-primary cursor-pointer"
            title="Copier URL de la vue">
            Partager
          </button>
          <button
            (click)="toggleCinema()"
            [class]="'flex-1 text-[10px] font-medium py-1.5 rounded-lg cursor-pointer transition-colors ' +
                     (cinemaMode()
                       ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                       : 'bg-bg-tertiary/60 text-fg-secondary border border-border-subtle hover:text-fg-primary')"
            title="Cycle automatique sur les véhicules (8s)">
            Cinéma
          </button>
          <!-- Lieux clés — poser un parking / stationnement récurrent (ex. « CDEF Launaguet »). -->
          @if (canManagePlaces()) {
            <button
              (click)="togglePlaceMode()"
              trackClick="carte-poser-lieu"
              [class]="'flex-1 text-[10px] font-medium py-1.5 rounded-lg cursor-pointer transition-colors ' +
                       (placeMode()
                         ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                         : 'bg-bg-tertiary/60 text-fg-secondary border border-border-subtle hover:text-fg-primary')"
              title="Poser un lieu de la flotte (parking, stationnement récurrent, dépôt)">
              Poser un lieu
            </button>
          }
        </div>
        @if (placeMode() && !pendingPlace()) {
          <div class="mt-2 px-2 py-1 rounded bg-sky-500/10 border border-sky-500/30 text-[10px] text-sky-300">
            Cliquez sur la carte à l'endroit du lieu à enregistrer.
          </div>
        }
        @if (measureMode()) {
          <div class="mt-2 px-2 py-1 rounded bg-tracky/10 border border-tracky/30
                      text-[10px] text-tracky-light flex items-center justify-between">
            <span>{{ measurePoints().length }} pts · {{ measureTotalKm() | number:'1.2-2' }} km</span>
            <button (click)="clearMeasure()" class="text-[10px] underline cursor-pointer">Effacer</button>
          </div>
        }
        @if (miniReplayVehicleId()) {
          <div class="mt-2 px-2 py-1 rounded bg-tracky/10 border border-tracky/30
                      text-[10px] text-tracky-light flex items-center justify-between">
            <span>Replay 1h actif</span>
            <button (click)="toggleMiniReplay(miniReplayVehicleId()!)" class="text-[10px] underline cursor-pointer">Fermer</button>
          </div>
        }
      </div>

      <!-- Smart search desktop (placée AVANT le toggle Calques pour qu'elle reste
           accessible quand le panel Calques est ouvert et grandit vers le bas).
           Le z-index explicite assure que les suggestions (qui sortent vers la
           droite via .tracky-search-suggestions--flyout) restent au-dessus du
           panel Calques, qui crée son propre stacking context (backdrop-filter). -->
      <div class="mt-2 bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 min-w-[220px] relative"
           style="z-index: 50">
        <input
          type="search"
          placeholder="Plaque ou adresse..."
          [value]="searchQuery()"
          (keydown.enter)="searchAddress($event)"
          (input)="onSearchInput($event)"
          (focus)="searchFocused.set(true)"
          (blur)="onSearchBlur()"
          class="w-full bg-transparent text-xs text-fg-primary placeholder:text-fg-tertiary
                 px-2 py-1.5 outline-none" />
        @if (searchFocused() && vehicleMatches().length > 0) {
          <!-- Flyout : sort à DROITE de la card du HUD au lieu de descendre,
               afin de ne pas se faire couvrir par le panel Calques inline ouvert
               en dessous. Sur viewport étroit (HUD trop large) on retombe sous
               le champ via media query plus bas. -->
          <div class="tracky-search-suggestions tracky-search-suggestions--flyout
                      bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                      rounded-lg overflow-hidden shadow-2xl">
            @for (v of vehicleMatches(); track v.vehicleId) {
              <button (mousedown)="jumpToVehicle(v.vehicleId)"
                      class="w-full text-left px-3 py-2 text-xs text-fg-primary
                             hover:bg-bg-tertiary cursor-pointer flex items-center justify-between gap-2">
                <span class="font-mono">{{ v.plate }}</span>
                <span class="text-[10px] text-fg-tertiary">{{ v.type }}</span>
              </button>
            }
          </div>
        }
      </div>

      <!-- Calques toggle desktop : ouvre le panel collapsable inline (en dessous) -->
      <button
        (click)="calquesPanelOpen.set(!calquesPanelOpen())"
        trackClick="carte-calques"
        [class]="'tracky-desktop-only mt-2 w-full flex items-center justify-between gap-2 px-3 py-2 ' +
                 'bg-bg-secondary/85 backdrop-blur-md border rounded-[--radius-card] ' +
                 'text-xs font-medium cursor-pointer transition-colors ' +
                 (calquesPanelOpen()
                   ? 'border-tracky/40 text-tracky-light'
                   : 'border-border-subtle text-fg-secondary hover:text-fg-primary')"
        title="Afficher / masquer le panneau des calques">
        <span class="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>
          Calques
          @if (activeFiltersCount() > 0) {
            <span class="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-tracky/20 text-tracky-light">{{ activeFiltersCount() }}</span>
          }
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" [style.transform]="calquesPanelOpen() ? 'rotate(180deg)' : ''" style="transition: transform 200ms"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      <!-- Calques inline desktop panel (visible quand calquesPanelOpen() && >=768px).
           Remplace l'ancien panel absolu fixé en bas qui chevauchait la barre de
           recherche quand il grandissait. Maintenant le panel pousse simplement
           le contenu du HUD vers le bas, sans aucun overlap possible. -->
      @if (calquesPanelOpen()) {
        <div class="tracky-calques-inline tracky-desktop-only mt-2
                    bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                    rounded-[--radius-card] p-3 min-w-[220px]">
          <div class="flex flex-col gap-1.5">
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().moving" (change)="toggleFilter('moving')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#10E0A0"></span>
              <span>En mouvement</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().idle" (change)="toggleFilter('idle')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#5C746C"></span>
              <span>Arrêt moteur ON</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().off" (change)="toggleFilter('off')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#6b7280"></span>
              <span>Éteint</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().offline" (change)="toggleFilter('offline')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#9ca3af"></span>
              <span>Hors-ligne (>15min)</span>
            </label>
            <hr class="my-1 border-border-subtle" />
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showGeofences()" (change)="toggleGeofences()" />
              <span>Géofences</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showTrails()" (change)="toggleTrails()" />
              <span>Traces</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showPlates()" (change)="togglePlates()" />
              <span>Plaques</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showStops()" (change)="toggleStops()" />
              <span>Arrêts > 5min (24h)</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showFuelStations()" (change)="toggleFuelStations()" />
              <span>Stations-service (passages)</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showDeadZones()" (change)="toggleDeadZones()" />
              <span>Parkings souterrains / zones mortes</span>
            </label>
            @if (canViewPlaces()) {
              <label class="tracky-sheet-checkbox">
                <input type="checkbox" [checked]="showFleetPlaces()" (change)="toggleFleetPlaces()" />
                <span>Lieux de la flotte (stations validées, parkings)</span>
              </label>
            }
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showHeatmap()" (change)="toggleHeatmap()" />
              <span>Heatmap densité (24h)</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="compactMarkers()" (change)="toggleCompactMarkers()" />
              <span>Mode compact (zoom faible)</span>
            </label>
          </div>
        </div>
      }
    </div>

    <!-- Style + Camera pickers top-right - DESKTOP ONLY (caché en mobile)
         V1.9 — refonte en dropdowns compacts au lieu de pills horizontales :
         gain de place ~70% top-right, plus d'espace pour la map. -->
    <div class="tracky-style-picker tracky-desktop-hud"
         style="position:absolute;top:16px;right:16px;z-index:1500;max-width:calc(100% - 32px)">
      <!-- Dropdown style de carte -->
      <div class="relative">
        <button (click)="stylePickerOpen.set(!stylePickerOpen()); cameraPickerOpen.set(false)"
                [class]="'flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-[--radius-card] cursor-pointer transition-colors ' +
                         'bg-bg-secondary/85 backdrop-blur-md border ' +
                         (stylePickerOpen() ? 'border-tracky/40 text-tracky-light' : 'border-border-subtle text-fg-secondary hover:text-fg-primary')"
                title="Style de carte">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6.5V21"/><path d="M9 6.5 2.4 4.6a1 1 0 0 0-1.3 1V19a1 1 0 0 0 .7 1l6.9 1.6"/><path d="m15 6.5-6 1.5"/><path d="M15 6.5v14.5"/><path d="m15 6.5 6.6-1.9a1 1 0 0 1 1.3 1V19a1 1 0 0 1-.7 1L15 21"/></svg>
          {{ currentStyleLabel() }}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" [style.transform]="stylePickerOpen() ? 'rotate(180deg)' : ''" style="transition: transform 200ms"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        @if (stylePickerOpen()) {
          <div class="map-dropdown-backdrop" (click)="stylePickerOpen.set(false)"></div>
          <div class="map-dropdown-menu">
            @for (s of styles.catalog; track s.id) {
              <button
                (click)="setStyle(s.id); stylePickerOpen.set(false)"
                [class]="'map-dropdown-item ' + (currentStyle() === s.id ? 'map-dropdown-item--active' : '')">
                <span>{{ s.label }}</span>
                @if (currentStyle() === s.id) {
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                }
              </button>
            }
          </div>
        }
      </div>

      <!-- Dropdown caméra -->
      <div class="relative mt-2">
        <button (click)="cameraPickerOpen.set(!cameraPickerOpen()); stylePickerOpen.set(false)"
                [class]="'flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-[--radius-card] cursor-pointer transition-colors w-full ' +
                         'bg-bg-secondary/85 backdrop-blur-md border ' +
                         (cameraPickerOpen() ? 'border-tracky/40 text-tracky-light' : 'border-border-subtle text-fg-secondary hover:text-fg-primary')"
                title="Mode caméra">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
          Vue : {{ currentCameraLabel() }}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="ml-auto" [style.transform]="cameraPickerOpen() ? 'rotate(180deg)' : ''" style="transition: transform 200ms"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        @if (cameraPickerOpen()) {
          <div class="map-dropdown-backdrop" (click)="cameraPickerOpen.set(false)"></div>
          <div class="map-dropdown-menu">
            @for (m of cameraModes; track m.id) {
              <button
                (click)="setCameraMode(m.id); cameraPickerOpen.set(false)"
                [class]="'map-dropdown-item ' + (cameraMode() === m.id ? 'map-dropdown-item--active' : '')"
                [title]="m.tooltip">
                <span>{{ m.label }}</span>
                @if (cameraMode() === m.id) {
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                }
              </button>
            }
          </div>
        }
      </div>
    </div>

    <!-- ════════════════════════════════════════════════════════════
         FAB principal mobile : ouvre la bottom-sheet (Calques + Actions)
         ════════════════════════════════════════════════════════════ -->
    <button
      (click)="mobileSheetOpen.set(!mobileSheetOpen())"
      class="tracky-mobile-fab-main"
      [class.tracky-mobile-fab-main--active]="mobileSheetOpen()"
      aria-label="Menu carte">
      @if (mobileSheetOpen()) {
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      } @else {
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
      }
    </button>

    <!-- ════════════════════════════════════════════════════════════
         Mobile bottom-sheet : Calques + Style + Caméra + Actions
         Reprend le panneau Calques desktop en mode classique.
         ════════════════════════════════════════════════════════════ -->
    @if (mobileSheetOpen()) {
      <div class="tracky-mobile-sheet-overlay" (click)="mobileSheetOpen.set(false)"></div>
    }
    <div [class.tracky-mobile-sheet--open]="mobileSheetOpen()"
         [class.tracky-calques-panel--desktop-open]="calquesPanelOpen()"
         class="tracky-calques-panel"
         [style.--sheet-drag-y]="sheetDragY() + 'px'"
         style="position:absolute;bottom:90px;left:16px;z-index:1600">
      <div class="tracky-calques-inner bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-3">
        <!-- Handle drag-to-dismiss (mobile only) -->
        <div class="tracky-sheet-handle-zone"
             (touchstart)="onSheetTouchStart($event)"
             (touchmove)="onSheetTouchMove($event)"
             (touchend)="onSheetTouchEnd()">
          <div class="tracky-sheet-handle"></div>
          <button (click)="mobileSheetOpen.set(false)" class="tracky-sheet-close-btn" aria-label="Fermer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <!-- ─── ACTIONS RAPIDES (mobile only) ─── -->
        <div class="tracky-sheet-section tracky-sheet-section--mobile-only">
          <p class="tracky-sheet-title">Actions</p>
          <div class="tracky-sheet-actions-grid">
            <button (click)="centerAll(); mobileSheetOpen.set(false)" class="tracky-sheet-action">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></svg>
              <span>Vue d'ensemble</span>
            </button>
            <!-- Parité mobile du bouton « Ma position » : la carte ne recentre plus d'office sur
                 l'utilisateur au chargement, il faut donc pouvoir le demander ici aussi. -->
            <button (click)="centerOnUser(); mobileSheetOpen.set(false)"
                    [class.tracky-sheet-action--active]="!!userPosition()"
                    class="tracky-sheet-action">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>
              <span>Ma position</span>
            </button>
            <button (click)="toggleMeasure(); mobileSheetOpen.set(false)"
                    [class.tracky-sheet-action--active]="measureMode()"
                    class="tracky-sheet-action">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 8.7 8.7 21.3a2.4 2.4 0 0 1-3.4 0l-2.6-2.6a2.4 2.4 0 0 1 0-3.4L15.3 2.7a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/></svg>
              <span>Mesurer</span>
            </button>
            <button (click)="shareUrl()" class="tracky-sheet-action">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
              <span>Partager</span>
            </button>
            <button (click)="toggleCinema(); mobileSheetOpen.set(false)"
                    [class.tracky-sheet-action--active]="cinemaMode()"
                    class="tracky-sheet-action">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21V11"/><path d="M2 17v-5a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v5"/><path d="m22 17-1.5 4h-17L2 17"/></svg>
              <span>Cinéma</span>
            </button>
            <!-- Lieux clés — parité mobile du « Poser un lieu » (gaté places_manage). -->
            @if (canManagePlaces()) {
              <button (click)="togglePlaceMode(); mobileSheetOpen.set(false)"
                      [class.tracky-sheet-action--active]="placeMode()"
                      class="tracky-sheet-action">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
                <span>Poser un lieu</span>
              </button>
            }
          </div>
          @if (measureMode()) {
            <div class="tracky-sheet-info tracky-sheet-info--purple">
              <span>{{ measurePoints().length }} pts · {{ measureTotalKm() | number:'1.2-2' }} km</span>
              <button (click)="clearMeasure()" class="tracky-sheet-info-action">Effacer</button>
            </div>
          }
          @if (miniReplayVehicleId()) {
            <div class="tracky-sheet-info tracky-sheet-info--blue">
              <span>Replay 1h actif</span>
              <button (click)="toggleMiniReplay(miniReplayVehicleId()!)" class="tracky-sheet-info-action">Fermer</button>
            </div>
          }
        </div>

        <!-- ─── STYLE DE CARTE (mobile only) ─── -->
        <div class="tracky-sheet-section tracky-sheet-section--mobile-only">
          <p class="tracky-sheet-title">Style de carte</p>
          <div class="tracky-sheet-pills">
            @for (s of styles.catalog; track s.id) {
              <button
                (click)="setStyle(s.id)"
                [class.tracky-sheet-pill--active]="currentStyle() === s.id"
                class="tracky-sheet-pill">
                {{ s.label }}
              </button>
            }
          </div>
        </div>

        <!-- ─── MODE CAMÉRA (mobile only) ─── -->
        <div class="tracky-sheet-section tracky-sheet-section--mobile-only">
          <p class="tracky-sheet-title">Mode caméra</p>
          <div class="tracky-sheet-pills">
            @for (m of cameraModes; track m.id) {
              <button
                (click)="setCameraMode(m.id)"
                [class.tracky-sheet-pill--active]="cameraMode() === m.id"
                class="tracky-sheet-pill">
                {{ m.label }}
              </button>
            }
          </div>
          @if (cameraMode() === 'follow' || cameraMode() === 'heading-up') {
            @if (followedPlate()) {
              <div class="tracky-sheet-info tracky-sheet-info--blue">
                <span>Suivi : <strong>{{ followedPlate() }}</strong></span>
                <button (click)="setCameraMode('free')" class="tracky-sheet-info-action">Arrêter</button>
              </div>
            }
          }
          @if (vehiclePickerOpen()) {
            <div class="tracky-vehicle-picker">
              <p class="tracky-vehicle-picker-title">
                Choisir un véhicule à suivre
                <button (click)="cancelVehiclePicker()" class="tracky-vehicle-picker-cancel">×</button>
              </p>
              @if (cameraPickerVehicles().length === 0) {
                <p class="tracky-vehicle-picker-empty">Aucun véhicule disponible</p>
              } @else {
                @if (cameraPickerLiveCount() === 0) {
                  <!-- Repli explicite : plus rien ne communique. On n'affiche pas une
                       liste muette qui donnerait l'impression que le suivi va marcher. -->
                  <p class="tracky-vehicle-picker-empty">
                    Aucun véhicule ne communique. En choisir un affiche sa dernière
                    position connue, sans suivi caméra.
                  </p>
                }
                @for (v of cameraPickerVehicles(); track v.vehicleId) {
                  <button
                    (click)="pickVehicleForCamera(v.vehicleId)"
                    [class.tracky-vehicle-picker-item--dormant]="v.dormant"
                    class="tracky-vehicle-picker-item">
                    <span class="tracky-vehicle-picker-plate">{{ v.plate }}</span>
                    <span class="tracky-vehicle-picker-meta">
                      @if (v.dormant) { Muet depuis {{ v.silenceLabel }} } @else { {{ v.type }} }
                    </span>
                  </button>
                }
              }
            </div>
          }
        </div>

        <!-- ─── CALQUES (always visible) ─── -->
        <div class="tracky-sheet-section">
          <p class="tracky-sheet-title">Calques</p>
          <div class="flex flex-col gap-1.5">
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().moving" (change)="toggleFilter('moving')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#10E0A0"></span>
              <span>En mouvement</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().idle" (change)="toggleFilter('idle')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#5C746C"></span>
              <span>Arrêt moteur ON</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().off" (change)="toggleFilter('off')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#6b7280"></span>
              <span>Éteint</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="filters().offline" (change)="toggleFilter('offline')" />
              <span class="w-2.5 h-2.5 rounded-full" style="background:#9ca3af"></span>
              <span>Hors-ligne (>15min)</span>
            </label>
            <hr class="my-1 border-border-subtle" />
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showGeofences()" (change)="toggleGeofences()" />
              <span>Géofences</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showTrails()" (change)="toggleTrails()" />
              <span>Traces</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showPlates()" (change)="togglePlates()" />
              <span>Plaques</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showStops()" (change)="toggleStops()" />
              <span>Arrêts > 5min (24h)</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showFuelStations()" (change)="toggleFuelStations()" />
              <span>Stations-service (passages)</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showDeadZones()" (change)="toggleDeadZones()" />
              <span>Parkings souterrains / zones mortes</span>
            </label>
            @if (canViewPlaces()) {
              <label class="tracky-sheet-checkbox">
                <input type="checkbox" [checked]="showFleetPlaces()" (change)="toggleFleetPlaces()" />
                <span>Lieux de la flotte (stations validées, parkings)</span>
              </label>
            }
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="showHeatmap()" (change)="toggleHeatmap()" />
              <span>Heatmap densité (24h)</span>
            </label>
            <label class="tracky-sheet-checkbox">
              <input type="checkbox" [checked]="compactMarkers()" (change)="toggleCompactMarkers()" />
              <span>Mode compact (zoom faible)</span>
            </label>
          </div>
        </div>

        <!-- ─── LÉGENDE VITESSE (mobile only) ─── -->
        <div class="tracky-sheet-section tracky-sheet-section--mobile-only">
          <p class="tracky-sheet-title">Légende vitesse</p>
          <div class="tracky-sheet-legend">
            <div class="tracky-sheet-legend-item">
              <span class="w-2.5 h-2.5 rounded-full" style="background:#5C746C"></span>
              <span>0 km/h</span>
            </div>
            <div class="tracky-sheet-legend-item">
              <span class="w-2.5 h-2.5 rounded-full" style="background:#10E0A0"></span>
              <span>1-50 km/h</span>
            </div>
            <div class="tracky-sheet-legend-item">
              <span class="w-2.5 h-2.5 rounded-full" style="background:#F59E0B"></span>
              <span>51-90 km/h</span>
            </div>
            <div class="tracky-sheet-legend-item">
              <span class="w-2.5 h-2.5 rounded-full" style="background:#EF4444"></span>
              <span>91+ km/h</span>
            </div>
          </div>
          @if (showFuelStations() || showDeadZones() || placesLayerVisible()) {
            <p class="tracky-sheet-title" style="margin-top:10px">Repères carte</p>
            <div class="tracky-sheet-legend">
              @if (showFuelStations()) {
                <div class="tracky-sheet-legend-item">
                  <span class="w-2.5 h-2.5 rounded-full" style="background:#A78BFA"></span>
                  <span>Station détectée</span>
                </div>
              }
              @if (placesLayerVisible()) {
                <div class="tracky-sheet-legend-item">
                  <span class="w-2.5 h-2.5 rounded-[3px]" style="background:#10E0A0"></span>
                  <span>Station de la flotte (validée)</span>
                </div>
                <div class="tracky-sheet-legend-item">
                  <span class="w-2.5 h-2.5 rounded-[3px]" style="background:#0ea5e9"></span>
                  <span>Parking de la flotte</span>
                </div>
              }
              @if (showDeadZones()) {
                <div class="tracky-sheet-legend-item">
                  <span class="w-2.5 h-2.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white" style="background:#0ea5e9">P</span>
                  <span>Parking souterrain</span>
                </div>
                <div class="tracky-sheet-legend-item">
                  <span class="w-2.5 h-2.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white" style="background:#ef4444">!</span>
                  <span>Zone GPS suspecte</span>
                </div>
              }
            </div>
          }
        </div>
      </div>
    </div>

    <!-- Compass reset (responsive position) -->
    @if (bearingNonZero() || pitchNonZero()) {
      <button
        (click)="resetNorth()"
        title="Recentrer Nord (C)"
        class="tracky-compass-btn"
        aria-label="Recentrer Nord">
        <span [style.transform]="'rotate(' + (-mapBearing()) + 'deg)'"
              style="display:inline-block;font-size:18px;color:#EF4444;font-weight:700;
                     transition:transform 200ms ease">N</span>
      </button>
    }

    <!-- Légende vitesse - DESKTOP ONLY (mobile : dans la sheet) -->
    <div class="tracky-desktop-hud" style="position:absolute;bottom:24px;right:16px;z-index:1000">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
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
        @if (showFuelStations() || showDeadZones() || placesLayerVisible()) {
          <hr class="my-2 border-border-subtle" />
          <p class="text-[10px] font-semibold text-fg-secondary mb-1.5 uppercase tracking-wider">Repères</p>
          <div class="flex flex-col gap-1">
            @if (showFuelStations()) {
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full" style="background:#A78BFA"></span>
                <span class="text-[10px] text-fg-tertiary">Station détectée (taille = passages)</span>
              </div>
            }
            @if (placesLayerVisible()) {
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-[3px] flex items-center justify-center text-[7px] font-bold text-white" style="background:#10E0A0">⛽</span>
                <span class="text-[10px] text-fg-tertiary">Station de la flotte (validée)</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-[3px] flex items-center justify-center text-[7px] font-bold text-white" style="background:#0ea5e9">P</span>
                <span class="text-[10px] text-fg-tertiary">Parking / stationnement de la flotte</span>
              </div>
            }
            @if (showDeadZones()) {
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white" style="background:#0ea5e9">P</span>
                <span class="text-[10px] text-fg-tertiary">Parking souterrain / couvert</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white" style="background:#f59e0b">P</span>
                <span class="text-[10px] text-fg-tertiary">Zone GPS récurrente</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white" style="background:#ef4444">!</span>
                <span class="text-[10px] text-fg-tertiary">Zone GPS suspecte (brouilleur ?)</span>
              </div>
            }
          </div>
        }
      </div>
    </div>

    <!-- ═══ Card d'un REPÈRE : station détectée ou lieu de la flotte ═══
         Même habillage que la card véhicule (.bn-vcard*) → carte cohérente, et connectée à la
         page « Lieux clés » (valider une station, renommer/retirer un lieu, ouvrir la page). -->
    @if (placeCard(); as pc) {
      <div class="bn-vcard-backdrop" (click)="closePlaceCard()"></div>
      <div class="bn-vcard">
        <div class="bn-vcard-handle" (click)="closePlaceCard()"></div>
        <div class="bn-vcard-header">
          <div class="bn-vcard-left">
            @if (pc.type === 'place' && renamingPlaceId() === pc.place.id) {
              <input
                class="bn-place-rename"
                [(ngModel)]="renameValue"
                maxlength="120"
                placeholder="Nom du lieu"
                (keydown.enter)="confirmRenamePlace()"
                (keydown.escape)="cancelRenamePlace()"
              />
            } @else {
              <div class="bn-vcard-plate">{{ pc.type === 'station' ? pc.title : pc.place.name }}</div>
            }

            <div class="bn-vcard-badges">
              @if (pc.type === 'station') {
                <span class="bn-vcard-badge" style="color:#A78BFA">
                  <span class="bn-vcard-badge-dot" style="background:#A78BFA"></span>
                  Station détectée
                </span>
                @if (placeCardStationValidated()) {
                  <span class="bn-vcard-badge" style="color:#10E0A0">
                    <span class="bn-vcard-badge-dot" style="background:#10E0A0"></span>
                    Lieu de la flotte
                  </span>
                }
              } @else {
                <span class="bn-vcard-badge" style="color:#10E0A0">
                  <span class="bn-vcard-badge-dot" style="background:#10E0A0"></span>
                  {{ placeKindLabel(pc.place.kind) }}
                </span>
              }
            </div>

            <div class="bn-place-meta">
              @if (pc.type === 'station') {
                @if (pc.where) { <div>{{ pc.where }}</div> }
                <div>
                  <b>{{ pc.visits }}</b> passage(s) · <b>{{ pc.distinctVehicles }}</b> véhicule(s)
                  @if (pc.lastPriceEur != null) { · <b>{{ pc.lastPriceEur | number: '1.3-3' }} €/L</b> }
                </div>
                @if (pc.vehicles.length) {
                  <div class="bn-place-vehicles">
                    @for (v of pc.vehicles; track $index) {
                      @if ($index < 6) {
                        <span class="bn-place-veh"><b>{{ v.plate || 'véhicule' }}</b> {{ v.visits }}×</span>
                      }
                    }
                    @if (pc.vehicles.length > 6) {
                      <span class="bn-place-veh">+{{ pc.vehicles.length - 6 }}</span>
                    }
                  </div>
                }
              } @else {
                <div>Rayon {{ pc.place.radiusM }} m</div>
                @if (pc.place.note) { <div>{{ pc.place.note }}</div> }
                @if (canManagePlaces()) {
                  <div class="bn-place-hint">Glissez le repère sur la carte pour le déplacer.</div>
                }
              }
            </div>
          </div>
          <button class="bn-vcard-close" (click)="closePlaceCard()" aria-label="Fermer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="bn-vcard-actions">
          @if (pc.type === 'station') {
            @if (canManagePlaces() && !placeCardStationValidated()) {
              <button class="bn-vcard-act bn-vcard-act--primary" [disabled]="placeCardSaving()" (click)="validateStationFromCard()">
                <span>{{ placeCardSaving() ? 'Ajout…' : 'Ajouter aux lieux' }}</span>
              </button>
            }
          } @else if (canManagePlaces()) {
            @if (renamingPlaceId() === pc.place.id) {
              <button class="bn-vcard-act bn-vcard-act--primary" [disabled]="!renameValue.trim() || placeCardSaving()" (click)="confirmRenamePlace()">
                <span>Enregistrer</span>
              </button>
              <button class="bn-vcard-act" (click)="cancelRenamePlace()"><span>Annuler</span></button>
            } @else {
              <button class="bn-vcard-act" (click)="startRenamePlace()"><span>Renommer</span></button>
              <button class="bn-vcard-act bn-vcard-act--danger" [disabled]="placeCardSaving()" (click)="deletePlaceFromCard()">
                <span>Retirer</span>
              </button>
            }
          }
          <!--
            Analyse IA : seulement sur un lieu DÉJÀ enregistré (on n'analyse pas une station qui
            n'appartient pas encore au référentiel), et seulement si l'IA est active pour la société.
            Ouvre la page « Lieux clés » directement sur ce lieu, où la fiche se lit et se relance.
          -->
          @if (pc.type === 'place' && placeAnalyzeVisible()) {
            <button class="bn-vcard-act bn-vcard-act--ai" (click)="goToPlaces(pc.place.id)"><span>Analyser</span></button>
          }
          @if (canViewPlaces()) {
            <button class="bn-vcard-act" (click)="goToPlaces()"><span>Lieux clés</span></button>
          }
        </div>
      </div>
    }

    <!-- Lieux clés — confirmation du point posé (nom + nature) avant enregistrement. -->
    @if (pendingPlace(); as pt) {
      <div class="tracky-place-dialog-backdrop" (click)="cancelPendingPlace()"></div>
      <div class="tracky-place-dialog">
        <p class="tracky-place-dialog-title">Nouveau lieu de la flotte</p>
        <p class="tracky-place-dialog-coords">
          {{ pt.lat | number: '1.5-5' }}, {{ pt.lng | number: '1.5-5' }}
        </p>
        <label class="tracky-place-field">
          <span>Nom</span>
          <input
            type="text"
            [(ngModel)]="pendingPlaceName"
            placeholder="Ex. CDEF Launaguet"
            maxlength="120"
            autocomplete="off"
          />
        </label>
        <label class="tracky-place-field">
          <span>Nature</span>
          <select [(ngModel)]="pendingPlaceKind">
            <option value="PARKING">Parking / stationnement</option>
            <option value="DEPOT">Dépôt / base</option>
            <option value="FUEL_STATION">Station-service</option>
            <option value="OTHER">Autre</option>
          </select>
        </label>
        <div class="tracky-place-actions">
          <button type="button" class="tracky-place-btn" (click)="cancelPendingPlace()">Annuler</button>
          <button
            type="button"
            class="tracky-place-btn tracky-place-btn--ok"
            [disabled]="!pendingPlaceName.trim() || placeSaving()"
            (click)="confirmPendingPlace()"
          >
            {{ placeSaving() ? 'Enregistrement…' : 'Enregistrer' }}
          </button>
        </div>
      </div>
    }

    @if (!realtime.connected()) {
      <div class="tracky-disconnect-banner">
        <span class="w-3 h-3 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        <span class="text-xs text-fg-secondary">Connexion temps réel interrompue...</span>
      </div>
    }

    <!-- Menu contextuel (right-click) -->
    @if (contextMenu()) {
      <div [style.left.px]="contextMenu()!.x" [style.top.px]="contextMenu()!.y"
           style="position:absolute;z-index:2000;min-width:200px"
           class="bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                  shadow-2xl overflow-hidden"
           (click)="$event.stopPropagation()">
        <button (click)="copyCoords(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Copier les coordonnees
        </button>
        <button (click)="centerHere(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Centrer ici
        </button>
        <button (click)="resetNorth(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Recentrer Nord
        </button>
        <button (click)="toggleLock(); closeContextMenu()"
                class="w-full text-left px-4 py-2 text-xs text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          {{ mapLocked() ? 'Deverrouiller la carte' : 'Verrouiller la carte' }}
        </button>
      </div>
    }

    <!-- ════════════════════════════════════════════════════════════
         BAANOOL BOTTOM CARD — remplace le popup MapLibre classique
         par une card fixe en bas, discrete, avec actions en icones.
         Visible uniquement en mode Baanool au clic sur un marker.
         ════════════════════════════════════════════════════════════ -->
    @if (baanoolCard()) {
      <div class="bn-vcard-backdrop" (click)="closeBaanoolCard()"></div>
      <div class="bn-vcard">
        <div class="bn-vcard-handle" (click)="closeBaanoolCard()"></div>
        <div class="bn-vcard-header">
          <div class="bn-vcard-left">
            <div class="bn-vcard-plate">{{ baanoolCard()!.plate }}</div>
            <div class="bn-vcard-badges">
              @if (cardShowsLive()) {
                <span class="bn-vcard-badge" [class.on]="baanoolCard()!.ignition">
                  <span class="bn-vcard-badge-dot"></span>
                  {{ baanoolCard()!.ignition ? 'Contact ON' : 'Contact OFF' }}
                </span>
                <span class="bn-vcard-speed-badge"
                      [style.color]="baanoolCard()!.speedKmh > 90 ? '#ef4444' : baanoolCard()!.speedKmh > 50 ? '#f59e0b' : baanoolCard()!.speedKmh > 0 ? '#10E0A0' : '#999'">
                  {{ baanoolCard()!.speedKmh | number:'1.0-0' }} km/h
                </span>
              } @else if (cardLastFixLabel(); as ago) {
                <!-- Incident FS-253 — boîtier pas en suivi direct (GPS perdu / hors ligne /
                     garé) : on n'affiche PAS la vitesse figée comme du live. On montre
                     l'âge de la dernière position GPS à la place, pour ne pas tromper. -->
                <span class="bn-vcard-badge" style="color:#94a3b8"
                      [attr.title]="'Dernière position GPS reçue ' + ago + ' — la vitesse affichée n’est pas en direct'">
                  <span class="bn-vcard-badge-dot" style="background:#94a3b8"></span>
                  Dernière position {{ ago }}
                </span>
              }
              <!-- V1.15 — Badge Fleet (visible SA only). -->
              <app-sa-fleet-badge [fleetId]="baanoolCard()!.fleetId" />
              <!-- Sprint 1 — Groupe du véhicule. -->
              @if (baanoolCard()!.group; as g) { <app-group-badge [group]="g" /> }
              <!-- Connectivité : flague un boîtier GPS perdu / hors-ligne / non configuré.
                   Masquée si on affiche déjà « à l'arrêt · parking souterrain » (zone confirmée),
                   pour ne pas alarmer avec « GPS perdu » là où c'est normal. -->
              @if (!deadZoneHint()?.benign) {
                <app-connectivity-badge [state]="cardConnectivity()" [hideWhenOnline]="true" />
              }
              <!-- Zone morte GPS connue (suivi FS-253) : GPS perdu à un endroit habituel → ton calme. -->
              @if (deadZoneHint(); as dz) {
                @if (dz.benign) {
                  <!-- Bleu « parking » et NON vert : le vert se lit comme « actif/en ligne » et prêtait
                       à confusion (le véhicule est à l'arrêt, pas en train de rouler). -->
                  <span class="bn-vcard-badge" style="color:#0ea5e9"
                        [attr.title]="'Parking souterrain confirmé — perte GPS normale ici, véhicule à l’arrêt'">
                    <span class="bn-vcard-badge-dot" style="background:#0ea5e9"></span>
                    À l'arrêt · parking souterrain
                  </span>
                } @else {
                  <span class="bn-vcard-badge" style="color:#0ea5e9"
                        [attr.title]="'Endroit où ce véhicule perd régulièrement le GPS (probablement pas une panne)'">
                    <span class="bn-vcard-badge-dot" style="background:#0ea5e9"></span>
                    Zone morte GPS · {{ dz.label }}
                  </span>
                }
              }
              <!-- Mode vie privée : position figée, collecte en pause. -->
              @if (baanoolCard()!.privacyModeEnabled) {
                <span class="bn-vcard-badge" style="color:#38bdf8">
                  <span class="bn-vcard-badge-dot" style="background:#38bdf8"></span>
                  Mode privé (position figée)
                </span>
              }
              <!-- Sprint 2 (revue #2) — état coupe TRI-ÉTAT (badge statut, distinct du bouton d'action). -->
              @if (baanoolCard()!.cutActive) {
                <span class="bn-vcard-badge" style="color:#ef4444">
                  <span class="bn-vcard-badge-dot" style="background:#ef4444"></span>
                  Moteur coupé
                </span>
              } @else if (baanoolCard()!.cutPending) {
                <span class="bn-vcard-badge" style="color:#f59e0b"
                      [attr.title]="'Commande de coupure envoyée au boîtier, en attente de confirmation (chute du contact). Sans position GPS, la confirmation peut être impossible.'">
                  <span class="bn-vcard-badge-dot" style="background:#f59e0b"></span>
                  Coupure envoyée (non confirmée)
                </span>
              }
            </div>
            <!-- V1.15 — Meta tracker visible SA only via le badge component
                 qui s'auto-cache si role != SUPER_ADMIN. La ligne est rendue
                 systematiquement mais le contenu se masque lui-meme. -->
            @if (baanoolCard()!.imei) {
              <div class="bn-vcard-sa-meta" [attr.aria-hidden]="!isSuperAdmin()">
                @if (isSuperAdmin()) {
                  <span class="bn-vcard-sa-imei">IMEI {{ baanoolCard()!.imei }}</span>
                }
              </div>
            }
          </div>
          <button class="bn-vcard-close" (click)="closeBaanoolCard()" aria-label="Fermer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="bn-vcard-actions">
          <button class="bn-vcard-act bn-vcard-act--primary" (click)="baanoolCardAction('follow')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            <span>Suivre</span>
          </button>
          <button class="bn-vcard-act" (click)="baanoolCardAction('detail')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span>Fiche</span>
          </button>
          <button class="bn-vcard-act" (click)="baanoolCardAction('replay1h')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>Replay</span>
          </button>
          <button class="bn-vcard-act" (click)="baanoolCardAction('navigate')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            <span>Y aller</span>
          </button>
          <!-- Fix cohérence coupe-circuit : n'afficher couper/rallumer que si l'utilisateur
               a la permission engine_control sur ce véhicule (comme le bouton partagé, qui
               se masque sinon). Griser « Couper » quand la coupe est interdite (mouvement /
               fix invalide) au lieu d'afficher une action dangereuse toujours active. -->
          @if (canEngineControl(baanoolCard()!.vehicleId)) {
            @if (baanoolCard()!.cutActive) {
              <button class="bn-vcard-act bn-vcard-act--restore" (click)="baanoolCardAction('restore')">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                <span>Rallumer</span>
              </button>
            } @else {
              <button class="bn-vcard-act bn-vcard-act--danger"
                      [disabled]="cutBlockedReason() !== null"
                      [title]="cutBlockedReason() ?? ''"
                      (click)="cutBlockedReason() === null ? baanoolCardAction('cut') : null">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                <span>Couper</span>
              </button>
            }
          }
        </div>
      </div>
    }

    <!-- Modal confirmation CUT/RESTORE (remplace window.confirm) -->
    <app-confirm-modal
      [open]="engineModalOpen() !== null"
      [title]="engineModalOpen() === 'cut' ? 'Couper le moteur ?' : 'Rallumer le moteur ?'"
      [description]="engineModalDescription()"
      [confirmLabel]="engineModalConfirmLabel()"
      cancelLabel="Annuler"
      [danger]="engineModalOpen() === 'cut'"
      [loading]="engineModalLoading()"
      (confirmed)="onEngineModalConfirm()"
      (cancelled)="engineModalOpen.set(null)"
    />
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    /* ─── User position marker — styles inline car MapLibre injecte
         les markers hors du composant Angular (pas d'encapsulation) ─── */

    /* ─── Compass button (desktop = bottom-right, mobile = top-right) ─── */
    .tracky-compass-btn {
      position: absolute;
      bottom: 200px; right: 16px;
      z-index: 1000;
      width: 42px; height: 42px;
      border-radius: 9999px;
      background: var(--surface-secondary, rgba(20,24,32,0.85));
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-color, rgba(255,255,255,0.1));
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }

    /* ─── Measure banner (visible quand le mode mesure est actif, sur la carte) ─── */
    .tracky-measure-banner {
      position: absolute;
      top: 70px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1100;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px 8px 14px;
      background: rgba(168, 85, 247, 0.15);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(168, 85, 247, 0.4);
      border-radius: 9999px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 0 0 1px rgba(168,85,247,0.05);
      max-width: calc(100% - 24px);
      animation: tracky-measure-pop 220ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes tracky-measure-pop {
      from { opacity: 0; transform: translate(-50%, -8px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }
    .tracky-measure-banner-info {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #c084fc;
      min-width: 0;
    }
    .tracky-measure-banner-text {
      font-size: 13px;
      color: var(--fg-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tracky-measure-banner-text strong { color: #c084fc; font-weight: 700; font-size: 14px; }
    .tracky-measure-banner-meta { color: var(--fg-tertiary); margin-left: 4px; font-size: 12px; }
    .tracky-measure-banner-hint { color: var(--fg-secondary); font-style: italic; font-size: 12px; }
    .tracky-measure-banner-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .tracky-measure-banner-btn {
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      color: #c084fc;
      background: rgba(168,85,247,0.15);
      border: 1px solid rgba(168,85,247,0.3);
      border-radius: 9999px;
      cursor: pointer;
    }
    .tracky-measure-banner-btn:active { background: rgba(168,85,247,0.25); }
    .tracky-measure-banner-close {
      width: 26px; height: 26px;
      border-radius: 50%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
    }
    .tracky-measure-banner-close:active { background: var(--bg-tertiary); }

    /* ─── Lieux clés : contenu de la card d'un repère (réutilise l'habillage .bn-vcard) ─── */
    .bn-place-meta { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .bn-place-meta b { color: var(--fg-primary); }
    .bn-place-vehicles { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .bn-place-veh { padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); font-size: 11px; color: var(--fg-secondary); }
    .bn-place-veh b { color: var(--fg-primary); font-weight: 700; }
    .bn-place-hint { color: var(--fg-tertiary); font-size: 11px; font-style: italic; }
    .bn-place-rename {
      width: 100%; padding: 6px 9px; border-radius: 8px; font-size: 16px; font-weight: 700;
      border: 1px solid var(--tracky-light); background: var(--bg-primary); color: var(--fg-primary); outline: none;
    }

    /* ─── Lieux clés : panneau de confirmation d'un point posé ─── */
    .tracky-place-dialog-backdrop {
      position: absolute; inset: 0; z-index: 2000; background: rgba(0, 0, 0, .35);
    }
    .tracky-place-dialog {
      position: absolute; z-index: 2001; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(340px, calc(100% - 32px));
      display: flex; flex-direction: column; gap: 10px; padding: 16px;
      border-radius: 14px; background: var(--bg-secondary);
      border: 1px solid var(--border-strong); box-shadow: 0 12px 34px rgba(0, 0, 0, .45);
    }
    .tracky-place-dialog-title { margin: 0; font-size: 14px; font-weight: 800; color: var(--fg-primary); }
    .tracky-place-dialog-coords { margin: -6px 0 0; font-size: 11px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
    .tracky-place-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-secondary); }
    .tracky-place-field input, .tracky-place-field select {
      padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border-strong);
      background: var(--bg-primary); color: var(--fg-primary); font-size: 13px; outline: none;
    }
    .tracky-place-field input:focus, .tracky-place-field select:focus { border-color: var(--tracky-light); }
    .tracky-place-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    .tracky-place-btn {
      padding: 7px 13px; border-radius: 9px; border: 1px solid var(--border-strong);
      background: transparent; color: var(--fg-secondary); font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .tracky-place-btn:disabled { opacity: .5; cursor: not-allowed; }
    .tracky-place-btn--ok { border-color: color-mix(in srgb, var(--tracky-light) 45%, var(--border-strong)); color: var(--tracky-light); }

    /* ─── Disconnect banner ─── */
    .tracky-disconnect-banner {
      position: absolute;
      top: 16px; left: 50%;
      transform: translateX(-50%);
      z-index: 1100;
      background: var(--bg-secondary, #fff);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 8px 16px;
      display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    }

    /* ════════════════════════════════════════════════════════════
       MOBILE TOP BAR (status chip + search FAB)
       Visible < 768px uniquement
       ════════════════════════════════════════════════════════════ */
    .tracky-mobile-topbar { display: none; }

    .tracky-mobile-status-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 9999px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-primary);
      cursor: pointer;
      transition: all .2s;
      min-height: 36px;
      max-width: calc(100% - 56px);
      overflow: hidden;
      white-space: nowrap;
    }
    .tracky-mobile-status-chip:active { transform: scale(.97); }
    .tracky-status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--fg-tertiary);
      flex-shrink: 0;
    }
    .tracky-status-dot--on {
      background: #10E0A0;
      box-shadow: 0 0 0 3px rgba(16,224,160,0.2);
      animation: tracky-pulse 2s ease infinite;
    }
    @keyframes tracky-pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
    .tracky-status-text { font-size: 12px; }
    .tracky-status-follow {
      color: #10E0A0;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100px;
    }

    .tracky-mobile-fab-sm {
      width: 38px; height: 38px;
      border-radius: 50%;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      color: var(--fg-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all .2s;
      flex-shrink: 0;
    }
    .tracky-mobile-fab-sm:active { transform: scale(.92); }
    .tracky-mobile-fab-sm--active {
      background: rgba(16,224,160,.15);
      border-color: rgba(16,224,160,.4);
      color: #10E0A0;
    }

    /* Mobile search input (slides down from top) */
    .tracky-mobile-search {
      display: none;
    }

    /* ════════════════════════════════════════════════════════════
       FAB principal mobile (bottom-right, ouvre la sheet)
       Design premium : compact (44px), glassy, dégradé animé,
       glow pulsant, micro-interactions tactiles fluides.
       ════════════════════════════════════════════════════════════ */
    .tracky-mobile-fab-main {
      display: none;
      position: absolute;
      bottom: 18px; right: 14px;
      z-index: 1500;
      width: 40px; height: 40px;
      border-radius: 50%;
      border: 0;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      isolation: isolate;
      overflow: hidden;
      /* Icône blanche par défaut (mode light) — basculée en noir en mode dark plus bas */
      color: #FFFFFF;
      /* Dégradé pastel mint/cyan/aqua : 5 stops clairs, jamais de teinte foncée */
      background: linear-gradient(135deg,
        #A7F3D0 0%,
        #5EEAD4 20%,
        #6EE7B7 40%,
        #34D399 55%,
        #67E8F9 75%,
        #A7F3D0 100%);
      background-size: 240% 240%;
      animation: tracky-fab-gradient 8s ease-in-out infinite;
      box-shadow:
        0 8px 22px rgba(94,234,212,.35),
        0 2px 8px rgba(16,224,160,.22),
        inset 0 1px 0 rgba(255,255,255,.55),
        inset 0 -1px 0 rgba(255,255,255,.15);
      opacity: .92;
      transition: transform .25s cubic-bezier(0.34, 1.56, 0.64, 1),
                  filter .2s ease,
                  opacity .2s ease,
                  box-shadow .3s ease;
      will-change: transform;
    }
    /* En mode dark : on bascule l'icône en noir pour contraster avec le gradient pastel clair */
    :host-context([data-theme='dark']) .tracky-mobile-fab-main {
      color: #000000;
    }
    /* Halo pulsant subtil derrière le FAB (zoom/fade lent, n'attire pas trop l'oeil) */
    .tracky-mobile-fab-main::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(16,224,160,.45) 0%, transparent 70%);
      opacity: 0;
      transform: scale(1);
      z-index: -1;
      animation: tracky-fab-pulse 3.4s ease-in-out infinite;
    }
    /* Reflet lumineux haut (effet glassy) */
    .tracky-mobile-fab-main::after {
      content: '';
      position: absolute;
      top: 2px; left: 6px; right: 6px;
      height: 35%;
      border-radius: 50% 50% 50% 50% / 100% 100% 0 0;
      background: linear-gradient(to bottom, rgba(255,255,255,.35), transparent);
      pointer-events: none;
      z-index: 0;
    }
    .tracky-mobile-fab-main > * { position: relative; z-index: 1; }
    .tracky-mobile-fab-main:hover { opacity: 1; filter: brightness(1.05); }
    .tracky-mobile-fab-main:active {
      transform: scale(.92);
      opacity: 1;
      filter: brightness(1.08);
      transition-duration: .12s;
    }
    /* État actif (sheet ouverte) : se transforme en bouton fermeture neutre */
    .tracky-mobile-fab-main--active {
      background: var(--bg-secondary);
      color: var(--fg-primary);
      border: 1px solid var(--border-strong);
      box-shadow: 0 4px 16px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.06);
      animation: none;
      opacity: 1;
    }
    .tracky-mobile-fab-main--active::before,
    .tracky-mobile-fab-main--active::after { display: none; }

    @keyframes tracky-fab-gradient {
      0%   { background-position: 0% 50%; }
      50%  { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes tracky-fab-pulse {
      0%, 100% { opacity: 0; transform: scale(.95); }
      50%      { opacity: .55; transform: scale(1.45); }
    }
    /* Respecter prefers-reduced-motion : on coupe le gradient + pulse pour les utilisateurs sensibles */
    @media (prefers-reduced-motion: reduce) {
      .tracky-mobile-fab-main { animation: none; }
      .tracky-mobile-fab-main::before { animation: none; opacity: 0; }
    }

    /* ════════════════════════════════════════════════════════════
       Bottom-sheet sections styles
       ════════════════════════════════════════════════════════════ */
    .tracky-sheet-handle-zone { display: none; }
    .tracky-sheet-handle { display: none; }
    .tracky-sheet-close-btn { display: none; }
    .tracky-sheet-section { margin-bottom: 16px; }
    .tracky-sheet-section:last-child { margin-bottom: 0; }
    .tracky-sheet-section--mobile-only { display: none; }
    .tracky-sheet-title {
      font-size: 10px;
      font-weight: 700;
      color: var(--fg-secondary);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .tracky-sheet-checkbox {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--fg-secondary);
      cursor: pointer;
      padding: 6px 4px;
      border-radius: 6px;
    }
    .tracky-sheet-checkbox:active { background: var(--bg-tertiary); }
    .tracky-sheet-checkbox input { width: 16px; height: 16px; accent-color: #10E0A0; flex-shrink: 0; }

    .tracky-sheet-actions-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .tracky-sheet-action {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 12px 8px;
      border-radius: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all .2s;
      min-height: 64px;
    }
    .tracky-sheet-action:active { transform: scale(.96); }
    .tracky-sheet-action--active {
      background: rgba(16,224,160,.15);
      border-color: rgba(16,224,160,.4);
      color: #10E0A0;
    }

    .tracky-sheet-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tracky-sheet-pill {
      padding: 8px 14px;
      border-radius: 9999px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all .2s;
    }
    .tracky-sheet-pill:active { transform: scale(.96); }
    .tracky-sheet-pill--active {
      background: rgba(16,224,160,.15);
      border-color: rgba(16,224,160,.4);
      color: #10E0A0;
    }

    .tracky-sheet-info {
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tracky-sheet-info--purple {
      background: rgba(168,85,247,.1);
      border: 1px solid rgba(168,85,247,.3);
      color: #c084fc;
    }
    .tracky-sheet-info--blue {
      background: rgba(59,130,246,.1);
      border: 1px solid rgba(59,130,246,.3);
      color: #93c5fd;
    }
    .tracky-sheet-info-action {
      font-size: 11px;
      text-decoration: underline;
      cursor: pointer;
      background: none;
      border: 0;
      color: inherit;
    }

    .tracky-sheet-legend {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .tracky-sheet-legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--fg-tertiary);
    }

    /* ─── Vehicle picker (Suivre/Sens) ─── */
    .tracky-vehicle-picker {
      margin-top: 10px;
      padding: 10px;
      border-radius: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
    }
    .tracky-vehicle-picker-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--fg-primary);
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tracky-vehicle-picker-cancel {
      width: 24px; height: 24px;
      border-radius: 50%;
      background: var(--bg-secondary);
      border: 0;
      color: var(--fg-secondary);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }
    .tracky-vehicle-picker-empty {
      font-size: 12px;
      color: var(--fg-tertiary);
      padding: 8px 0;
      text-align: center;
    }
    .tracky-vehicle-picker-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border-radius: 8px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-primary);
      cursor: pointer;
      transition: all .15s;
    }
    .tracky-vehicle-picker-item:active {
      background: rgba(16,224,160,.1);
      border-color: rgba(16,224,160,.4);
    }
    .tracky-vehicle-picker-plate {
      font-family: var(--font-mono, monospace);
      font-size: 13px;
      font-weight: 700;
    }
    .tracky-vehicle-picker-meta {
      font-size: 10px;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    /* Muet de longue date : estompé et rangé en fin de liste, mais toujours
       présent et cliquable (voir sa dernière position reste légitime). */
    .tracky-vehicle-picker-item--dormant { opacity: .6; }
    .tracky-vehicle-picker-item--dormant .tracky-vehicle-picker-meta { text-transform: none; }

    /* Sheet overlay backdrop */
    .tracky-mobile-sheet-overlay { display: none; }

    /* ─── DESKTOP : panel Calques collapsable ───────────────────────────
     * Sur desktop on utilise désormais .tracky-calques-inline rendu
     * directement dans le HUD top-left (sous le toggle Calques). L'ancien
     * panel absolu .tracky-calques-panel est utilisé UNIQUEMENT pour la
     * bottom-sheet mobile et reste donc caché sur desktop quoiqu'il arrive.
     * Cela résout le bug d'overlap entre la barre de recherche et le panel
     * Calques quand celui-ci grandissait. */
    @media (min-width: 768px) {
      .tracky-calques-panel { display: none !important; }
      .tracky-desktop-only { display: flex; }

      /* Calques inline desktop — version compacte alignée avec le reste du HUD */
      .tracky-calques-inline {
        animation: calques-inline-pop .18s cubic-bezier(0.16, 1, 0.3, 1) both;
        position: relative;
        z-index: 1; /* explicite < z-index search wrapper (50) */
      }
      .tracky-calques-inline .tracky-sheet-checkbox {
        font-size: 12px;
        padding: 4px 4px;
        gap: 8px;
      }
      .tracky-calques-inline .tracky-sheet-checkbox input {
        width: 14px; height: 14px;
      }
      @keyframes calques-inline-pop {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* ─── Suggestions de recherche (desktop) ──────────────────────────
       * Par défaut on les sort à DROITE de la card du HUD pour ne pas
       * se faire couvrir par le panel Calques inline quand il est ouvert.
       * Largeur fixe ~280px, projection à 8px du bord droit du wrapper. */
      .tracky-search-suggestions--flyout {
        position: absolute;
        top: 0;
        left: calc(100% + 8px);
        width: 280px;
        z-index: 1700;
        animation: search-flyout-pop .18s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      @keyframes search-flyout-pop {
        from { opacity: 0; transform: translateX(-6px); }
        to   { opacity: 1; transform: translateX(0); }
      }
    }
    /* Sur viewports étroits (tablette portrait) : fallback sous le champ
     * pour éviter un overflow horizontal hors de l'écran. */
    @media (min-width: 768px) and (max-width: 1023px) {
      .tracky-search-suggestions--flyout {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        width: auto;
        margin-top: 4px;
      }
    }
    @media (max-width: 767px) {
      .tracky-desktop-only { display: none !important; }
    }

    /* ─── Dropdown style/caméra (top-right) ─────────────────────────────
     * Remplace les anciennes pills horizontales par un dropdown compact.
     * Anchored à droite du wrapper, s'étire vers la gauche.  */
    .map-dropdown-backdrop {
      position: fixed; inset: 0; z-index: 1; background: transparent;
    }
    .map-dropdown-menu {
      position: absolute; top: calc(100% + 6px); right: 0; z-index: 2;
      min-width: 180px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-strong);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      padding: 4px;
      display: flex; flex-direction: column;
      animation: map-dd-pop .18s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes map-dd-pop {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .map-dropdown-item {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
      padding: 8px 12px;
      font-size: 12px; font-weight: 500;
      color: var(--fg-secondary);
      background: transparent; border: none; border-radius: 8px;
      cursor: pointer;
      text-align: left;
      transition: background .12s, color .12s;
    }
    .map-dropdown-item:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .map-dropdown-item--active {
      background: rgba(16,224,160,.1); color: var(--tracky-light, #10E0A0);
    }
    .map-dropdown-item--active:hover { background: rgba(16,224,160,.16); }

    /* ════════════════════════════════════════════════════════════
       MOBILE (< 768px) — toutes les overrides responsive
       ════════════════════════════════════════════════════════════ */
    @media (max-width: 767px) {
      /* Cacher les HUDs desktop */
      .tracky-desktop-hud { display: none !important; }

      /* Top bar mobile visible.
       * top: 16px (au lieu de 12px) pour aerer la chip "X actif(s)" et le FAB
       * recherche de la top-bar layout (cloche/user/theme) qui s'affiche juste
       * au-dessus en mode fullscreen. */
      .tracky-mobile-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        position: absolute;
        top: 16px; left: 12px; right: 12px;
        z-index: 1000;
        pointer-events: none;
      }
      .tracky-mobile-topbar > * { pointer-events: auto; }

      /* FAB principal mobile */
      .tracky-mobile-fab-main {
        display: flex;
        bottom: 24px; right: 16px;
      }

      /* Compass mobile : top-right (sous le bouton search) */
      .tracky-compass-btn {
        bottom: auto;
        top: 64px;
        right: 12px;
        width: 38px; height: 38px;
      }

      /* Search overlay mobile */
      .tracky-mobile-search {
        display: block;
        position: absolute;
        top: 60px; left: 12px; right: 12px;
        z-index: 1500;
        animation: tracky-slide-down 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .tracky-mobile-search-inner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        border-radius: 14px;
        box-shadow: 0 8px 24px rgba(0,0,0,.15);
      }
      .tracky-mobile-search-inner input {
        flex: 1;
        background: transparent;
        border: 0;
        outline: 0;
        color: var(--fg-primary);
        font-size: 14px;
        min-width: 0;
      }
      .tracky-mobile-search-inner input::placeholder { color: var(--fg-tertiary); }
      .tracky-mobile-search-close {
        width: 28px; height: 28px;
        border-radius: 50%;
        background: var(--bg-tertiary);
        border: 0;
        color: var(--fg-secondary);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
      }
      .tracky-mobile-search-results {
        margin-top: 6px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0,0,0,.15);
      }
      .tracky-mobile-search-result {
        width: 100%;
        text-align: left;
        padding: 12px 14px;
        background: transparent;
        border: 0;
        color: var(--fg-primary);
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .tracky-mobile-search-result:active { background: var(--bg-tertiary); }
      .tracky-mobile-search-result-type {
        font-size: 11px;
        color: var(--fg-tertiary);
      }
      @keyframes tracky-slide-down {
        from { transform: translateY(-12px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }

      /* Bottom sheet mobile : full width slide up (plus de bottom-nav, on va jusqu'en bas) */
      .tracky-calques-panel {
        position: fixed !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        top: auto !important;
        transform: translate3d(0, calc(110% + var(--sheet-drag-y, 0px)), 0);
        transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
        max-height: calc(85dvh - env(safe-area-inset-bottom));
        z-index: 1700 !important;
      }
      .tracky-calques-panel.tracky-mobile-sheet--open {
        transform: translate3d(0, var(--sheet-drag-y, 0px), 0);
      }
      .tracky-calques-inner {
        border-radius: 20px 20px 0 0 !important;
        max-height: calc(85dvh - env(safe-area-inset-bottom));
        overflow-y: auto;
        padding: 0 16px !important;
        padding-bottom: calc(env(safe-area-inset-bottom) + 24px) !important;
        margin: 0 !important;
        background: var(--bg-secondary) !important;
        position: relative;
      }
      /* Zone du handle = sticky en haut pour faciliter le drag */
      .tracky-sheet-handle-zone {
        display: flex;
        align-items: center;
        justify-content: center;
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 12px 0 8px;
        background: var(--bg-secondary);
        border-radius: 20px 20px 0 0;
        margin: 0 -16px 4px;
        cursor: grab;
        touch-action: none;
      }
      .tracky-sheet-handle-zone:active { cursor: grabbing; }
      .tracky-sheet-handle {
        display: block;
        width: 44px;
        height: 5px;
        border-radius: 3px;
        background: var(--border-strong, rgba(120,120,120,.4));
      }
      .tracky-sheet-close-btn {
        display: flex;
        position: absolute;
        right: 12px;
        top: 8px;
        width: 32px; height: 32px;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: var(--bg-tertiary);
        border: 0;
        color: var(--fg-secondary);
        cursor: pointer;
      }
      .tracky-sheet-close-btn:active { background: var(--border-strong); }
      .tracky-sheet-section--mobile-only { display: block; }

      /* Attribution maplibre cachée en mobile (pas critique en mobile) */
      :host ::ng-deep .maplibregl-ctrl-attrib,
      :host ::ng-deep .maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib {
        display: none !important;
      }

      /* Sheet overlay backdrop visible quand sheet open */
      .tracky-mobile-sheet-overlay {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.4);
        backdrop-filter: blur(2px);
        z-index: 1650;
        animation: tracky-fade-in 200ms ease;
      }
      @keyframes tracky-fade-in { from { opacity: 0 } to { opacity: 1 } }

      /* Disconnect banner : ne pas chevaucher la chip top */
      .tracky-disconnect-banner {
        top: 60px;
      }
    }

    /* ════════════════════════════════════════════════════════════
       BAANOOL BOTTOM CARD — card fixe en bas au clic marker.
       Glassmorphism + handle + badges + actions colorees.
       ════════════════════════════════════════════════════════════ */
    .bn-vcard-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1800;
      background: rgba(0, 0, 0, 0.15);
    }
    @keyframes bn-vcard-slide-up {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    .bn-vcard {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1801;
      animation: bn-vcard-slide-up 280ms cubic-bezier(0.16, 1, 0.3, 1);
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(20px) saturate(1.4);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      border-radius: 20px 20px 0 0;
      box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.10), 0 -2px 8px rgba(0, 0, 0, 0.04);
      padding: 0 20px calc(16px + env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    /* Handle drag visuel — tap pour fermer */
    .bn-vcard-handle {
      align-self: center;
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: rgba(0, 0, 0, 0.12);
      margin: 10px 0 2px;
      cursor: pointer;
      touch-action: manipulation;
    }
    .bn-vcard-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .bn-vcard-left {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .bn-vcard-plate {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 17px;
      color: #111;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .bn-vcard-badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bn-vcard-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(156, 163, 175, 0.12);
      color: #888;
    }
    .bn-vcard-badge.on {
      background: rgba(16, 224, 160, 0.12);
      color: var(--tracky);
    }
    .bn-vcard-badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ccc;
    }
    .bn-vcard-badge.on .bn-vcard-badge-dot {
      background: #10E0A0;
      box-shadow: 0 0 0 2px rgba(16, 224, 160, 0.3);
    }
    .bn-vcard-speed-badge {
      font-family: var(--font-display);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .bn-vcard-close {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: none;
      background: rgba(0, 0, 0, 0.06);
      color: #888;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 120ms, color 120ms;
      touch-action: manipulation;
      margin-top: 2px;
    }
    .bn-vcard-close:active { background: rgba(0, 0, 0, 0.12); color: #333; }
    .bn-vcard-actions {
      display: flex;
      gap: 8px;
    }
    .bn-vcard-act {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      flex: 1;
      padding: 12px 4px 10px;
      border-radius: 14px;
      border: none;
      background: rgba(0, 0, 0, 0.04);
      color: #555;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: background 120ms, transform 80ms;
      white-space: nowrap;
      touch-action: manipulation;
    }
    .bn-vcard-act:active { transform: scale(0.94); background: rgba(0, 0, 0, 0.08); }
    .bn-vcard-act--primary {
      background: rgba(16, 224, 160, 0.12);
      color: var(--tracky-dark);
    }
    .bn-vcard-act--primary:active { background: rgba(16, 224, 160, 0.22); }
    .bn-vcard-act--danger {
      color: #dc2626;
      background: rgba(239, 68, 68, 0.08);
    }
    .bn-vcard-act--danger:active { background: rgba(239, 68, 68, 0.16); }
    /* Analyse IA — même violet que les autres surfaces IA de l'app. */
    .bn-vcard-act--ai { color: #7C3AED; background: rgba(167, 139, 250, 0.12); }
    .bn-vcard-act--ai:active { background: rgba(167, 139, 250, 0.22); }
    .bn-vcard-act--restore {
      color: var(--tracky);
      background: rgba(16, 224, 160, 0.10);
    }
    .bn-vcard-act--restore:active { background: rgba(16, 224, 160, 0.18); }
    /* Fix cohérence coupe-circuit — bouton « Couper » grisé quand la coupe est
       interdite (véhicule en mouvement / fix invalide), aligné sur le garde backend. */
    .bn-vcard-act:disabled { opacity: 0.4; cursor: not-allowed; }
    .bn-vcard-act:disabled:active { transform: none; background: rgba(239, 68, 68, 0.08); }
  `],
})
export class MapComponent implements AfterViewInit, OnDestroy {
  protected readonly realtime = inject(RealtimeService);
  /** Filtre société global (sélecteur super-admin). matches() = true pour un non-super. */
  private readonly fleetFilter = inject(FleetFilterService);
  /** Snapshot borné à la société sélectionnée (picker + comptes). */
  protected readonly scopedSnapshot = computed(() =>
    this.realtime.snapshot().filter((v) => this.fleetFilter.matches(v.fleetId)),
  );
  private readonly perms = inject(PermissionsService);

  /**
   * Fix cohérence coupe-circuit (carte) — la carte a son PROPRE bouton « Couper »
   * (pas le composant partagé `<app-engine-control-button>`). Il faut donc y reproduire
   * les mêmes gardes que le backend / le bouton partagé, sinon la carte affiche une
   * action dangereuse comme disponible (même piège que le bug veilleur, mais sans AUCUNE
   * garde) : bouton « Couper » rouge/actif pour un rôle sans droit ou sur un véhicule en
   * pleine vitesse.
   */
  protected canEngineControl(vehicleId: string | undefined): boolean {
    return !!vehicleId && this.perms.can('engine_control', vehicleId);
  }

  /**
   * Raison de blocage de la coupe depuis la carte (null = coupe autorisée), alignée sur
   * le garde backend non-veilleur (engine-control.service) : vitesse > 20 km/h refusée,
   * fix GPS invalide refusé, position trop ancienne (>60s) si le véhicule roulait. Le
   * serveur reste le rempart final ; ceci ne fait que griser le bouton pour ne pas
   * proposer une action qui échouera / serait dangereuse.
   */
  protected readonly cutBlockedReason = computed<string | null>(() => {
    const card = this.baanoolCard();
    if (!card) return null;
    const pos = this.realtime.positions().get(card.trackerId);
    const speed = pos?.speedKmh ?? card.speedKmh;
    const valid = pos?.valid ?? true;
    const ageS = pos ? (Date.now() - new Date(pos.timestamp).getTime()) / 1000 : undefined;
    const atRest = speed <= 5; // REST_SPEED_KMH backend
    if (!atRest && ageS !== undefined && ageS > 60) return `Position trop ancienne (${Math.round(ageS)}s)`;
    if (!valid) return 'Fix GPS invalide';
    if (speed > 20) return `Vitesse trop élevée (${speed.toFixed(0)} km/h) — coupure impossible en mouvement`;
    return null;
  });
  protected readonly styles = inject(MapStyleService);
  private readonly zone = inject(NgZone);
  private readonly auth = inject(AuthService);
  /** V1.15 — Helper utilise dans la card popup (SA voit IMEI). */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly deadZonesApi = inject(GpsDeadZonesApiService);
  private readonly fleetPlacesApi = inject(FleetPlacesApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly tripAnalysisApi = inject(TripAnalysisApiService);
  private readonly preferences = inject(PreferencesService);
  private readonly mapSvc = inject(MapService);
  private readonly mapBridge = inject(MapBridgeService);
  private readonly engineControl = inject(EngineControlService);
  private readonly visibility = inject(VisibilityService);
  private readonly toast = inject(ToastService);
  // V1.10 (Sprint 5 stabilite) — DestroyRef pour brancher takeUntilDestroyed
  // sur les subscribe() qui sortent du cycle de vie automatique (ex: callbacks
  // imperatifs comme onEngineModalConfirm).
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly activityTracker = inject(ActivityTrackerService);

  /** Mode Baanool : UI simplifiee, bottom card au lieu du popup MapLibre. */
  private readonly isBaanoolMode = computed(() =>
    this.auth.user()?.preferences?.uiMode === 'baanool',
  );
  /** Donnees de la bottom card Baanool (null = fermee). */
  protected readonly baanoolCard = signal<BaanoolCardData | null>(null);
  /**
   * Zones mortes GPS (suivi FS-253) — si un véhicule GPS_LOST a sa dernière position figée dans
   * une zone connue, on affiche un message CALME (« parking souterrain probable ») au lieu du
   * « GPS perdu » alarmant. Chargé à la demande à l'ouverture de la card (seulement si GPS_LOST).
   */
  protected readonly deadZoneHint = signal<{ label: string; benign: boolean } | null>(null);

  private readonly mapContainerRef = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  private map: MlMap | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private markers = new Map<string, MarkerEntry>();
  private vehicleMeta = new Map<string, VehicleMeta>();
  private trailPoints = new Map<string, Array<[number, number]>>();
  // Derniere position consideree comme "verite" par tracker (fix GPS valid).
  // Sert d'ancrage pour `isAcceptableLiveFix` : on rejette les sauts > 250 km/h
  // depuis cette ancre, ce qui filtre les teleportations meme sur trames marquees
  // `valid: true` par le boitier mais aberrantes (multipath urbain, etc.).
  private lastTruthPosition = new Map<string, { lat: number; lng: number; timestamp: string; speedKmh: number }>();
  // Suivi des trames rejetees par le filtre anti-teleportation, pour la
  // resynchronisation (voir RESYNC_MIN_FRAMES). { derniere pos rejetee + compteur }.
  private rejectStreak = new Map<string, { lat: number; lng: number; n: number }>();
  private hasFittedBounds = false;
  private userMarker: MlMarker | null = null;
  protected readonly userPosition = signal<{ lat: number; lng: number } | null>(null);
  private currentPopup: Popup | null = null;
  private activePopupTrackerId: string | null = null;
  private activePopupVehicleId: string | null = null;

  // Modal engine CUT/RESTORE (remplace window.confirm)
  protected readonly engineModalOpen = signal<'cut' | 'restore' | null>(null);
  protected readonly engineModalLoading = signal(false);
  private engineModalTrackerId: string | null = null;
  private engineModalHasSchedule = false;

  protected readonly engineModalDescription = computed(() => {
    const action = this.engineModalOpen();
    if (this.engineModalHasSchedule) {
      const verb = action === 'cut' ? 'immobiliser' : 'rallumer';
      return `Vous êtes sur le point de ${verb} ce véhicule.<br><br>` +
        `<strong>Le mode horaire reste actif.</strong> ` +
        `Cette action tient jusqu'à la prochaine bascule programmée, puis le planning reprend ` +
        `automatiquement.<br><br>` +
        `<span class="text-fg-tertiary text-xs">Cette action sera enregistrée dans l'audit trail.</span>`;
    }
    return action === 'cut'
      ? `Le véhicule sera immobilisé immédiatement.<br><br>` +
        `<span class="text-fg-tertiary text-xs">Cette action sera enregistrée dans l'audit trail.</span>`
      : `Le véhicule sera à nouveau utilisable.<br><br>` +
        `<span class="text-fg-tertiary text-xs">Cette action sera enregistrée dans l'audit trail.</span>`;
  });

  protected readonly engineModalConfirmLabel = computed(() => {
    const action = this.engineModalOpen();
    return action === 'cut' ? 'Oui, couper le moteur' : 'Oui, rallumer';
  });

  /** Etat de mouvement par trackerId : extrapolation speed/heading + lissage display. */
  private motion = new Map<string, MotionState>();
  /** Derniere data de marker connue (pour update du DOM a chaque tick). */
  private lastMarkerData = new Map<string, VehicleMarkerData>();
  private animFrameId: number | null = null;
  /** performance.now() de la frame precedente, pour calculer dt dans le low-pass. */
  private lastTickAt: number | null = null;

  // V1.10 (Sprint 3 perf) — tracking des listeners cluster pour les .off() avant
  // chaque rerun de setupClusterLayer (apres setStyle). Sans ca, les listeners
  // s'empilent silencieusement (chaque setStyle = +4 listeners) et finissent par
  // ralentir les hovers/clicks visiblement apres 5-10 changements de style.
  private clusterListenerCleanups: Array<() => void> = [];
  // Drapeau anti-race : si l'utilisateur change de style 2 fois en < 200ms, le
  // second appel attend que le premier ait fini de setup les layers (sinon les
  // sources s'empilent dans des states intermediaires => render glitch).
  private styleChangeInFlight = false;

  protected readonly currentStyle = signal<MapStyleId>('osm');
  protected readonly cameraMode = signal<CameraMode>('free');
  protected readonly followedVehicleId = signal<string | null>(null);
  protected readonly mapBearing = signal(0);
  protected readonly mapPitch = signal(0);
  protected readonly bearingNonZero = computed(() => Math.abs(this.mapBearing()) > 0.5);
  protected readonly pitchNonZero = computed(() => Math.abs(this.mapPitch()) > 0.5);
  protected readonly searchQuery = signal('');
  /** Sprint G.1 — focus + suggestions vehicules. */
  protected readonly searchFocused = signal(false);
  protected readonly vehicleMatches = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length < 1) return [];
    const snap = this.scopedSnapshot();
    return snap
      .filter((v) => v.plate.toLowerCase().includes(q) || v.type.toLowerCase().includes(q))
      .slice(0, 5);
  });

  protected readonly showGeofences = signal(true);
  protected readonly showTrails = signal(true);
  protected readonly showPlates = signal(true);
  /** Sprint F.1 — affichage des arrets > 5min calcules sur les 24 dernieres heures. */
  protected readonly showStops = signal(false);
  /** Sprint G.4 — heatmap densite des positions (24h). */
  protected readonly showHeatmap = signal(false);
  /** Carburant (2026-07) — stations-service fréquentées par la flotte (fréquence + récence). Défaut ON (demande client). */
  protected readonly showFuelStations = signal(true);
  private fuelClickHandler: ((e: maplibregl.MapLayerMouseEvent) => void) | null = null;
  private fuelCursorBound = false;
  /** Détail par véhicule d'une station (qui + combien de passages), indexé par stationId (popup). */
  private fuelStationVehicles = new Map<string, { plate: string | null; visits: number }[]>();
  /** Zones mortes GPS (suivi FS-253) — parkings souterrains + zones récurrentes/suspectes de la flotte.
   *  Chargées en continu (pas seulement au toggle) pour l'override « à l'arrêt · souterrain » des cards. */
  protected readonly showDeadZones = signal(true);
  protected readonly deadZonesData = signal<GpsDeadZoneMapDto[]>([]);
  private deadZonePopup: Popup | null = null;
  /** Pins parkings/zones mortes en marqueurs HTML (z-index > véhicules), indexés par id de zone. */
  private deadZoneMarkers = new Map<string, maplibregl.Marker>();

  /**
   * Lieux clés (2026-07) — stations VALIDÉES par la flotte + parkings/stationnements posés à la
   * main. Marqueurs HTML (comme les parkings détectés) pour passer devant les véhicules.
   */
  /** Calque « Lieux de la flotte » (stations validées + parkings posés). Défaut ON. */
  protected readonly showFleetPlaces = signal(true);
  protected readonly fleetPlaces = signal<FleetPlaceDto[]>([]);
  private fleetPlaceMarkers = new Map<string, maplibregl.Marker>();
  /** Mode « poser un lieu » : le prochain clic carte capture le point. */
  protected readonly placeMode = signal(false);
  /** Point capturé en attente de nom/nature (petit panneau de confirmation). */
  protected readonly pendingPlace = signal<{ lat: number; lng: number } | null>(null);
  protected pendingPlaceName = '';
  protected pendingPlaceKind: FleetPlaceKind = 'PARKING';
  protected readonly placeSaving = signal(false);
  /**
   * Permissions « Lieux clés ». `places_view` conditionne TOUT ce qui touche aux lieux sur la
   * carte (chargement, marqueurs, calque, légende) — sans le droit, aucun appel réseau et aucun
   * repère ; `places_manage` conditionne en plus la création/édition (poser, déplacer, renommer).
   */
  protected readonly canViewPlaces = computed(() => this.perms.can('places_view'));
  protected readonly canManagePlaces = computed(() => this.perms.can('places_manage'));
  /** Repères « lieux » réellement affichés : droit de lecture ET calque activé. */
  protected readonly placesLayerVisible = computed(() => this.canViewPlaces() && this.showFleetPlaces());
  /**
   * L'analyse IA d'un lieu est-elle proposable ? Renseigné par le SERVEUR (option IA de la société
   * + kill-switch owner + clé provider) et fail-CLOSED. Sans ça, aucune trace d'IA sur la carte :
   * une fonction non souscrite ne doit pas être visible.
   */
  protected readonly placesAiEnabled = signal(false);
  protected readonly canAnalyzePlaces = computed(() => this.perms.can('places_analyze'));
  /** Bouton « Analyser » de la card : IA active ET droit de déclencher. */
  protected readonly placeAnalyzeVisible = computed(() => this.placesAiEnabled() && this.canAnalyzePlaces());

  /**
   * Card carte unifiée pour un REPÈRE (station détectée ou lieu de la flotte) — remplace les
   * anciens popups HTML bruts. Même habillage que la card véhicule (classes `.bn-vcard*`) pour
   * une carte cohérente, et connectée à la page « Lieux clés » (validation, renommage, retrait).
   */
  protected readonly placeCard = signal<PlaceCardData | null>(null);
  /** Dérivé : la station de la card est-elle DÉJÀ un lieu de la flotte ? (suit les validations) */
  protected readonly placeCardStationValidated = computed(() => {
    const c = this.placeCard();
    if (!c || c.type !== 'station') return false;
    return this.fleetPlaces().some((p) => p.stationId === c.stationId);
  });
  /** Renommage inline en cours (id du lieu) + valeur saisie. */
  protected readonly renamingPlaceId = signal<string | null>(null);
  protected renameValue = '';
  protected readonly placeCardSaving = signal(false);
  /** Arrêts > 5min (24h) : popup + cleanups des listeners (calque re-setup au changement de fond). */
  private stopPopup: Popup | null = null;
  private stopsListenerCleanups: Array<() => void> = [];
  /** V1.7 — si false, jamais de mode compact a faible zoom (markers riches partout).
   *  Toggle dans le panneau Calques pour les utilisateurs qui preferent voir les
   *  markers detailles meme a zoom 5. Persisté dans les prefs. */
  protected readonly compactMarkers = signal(true);
  /** V1.7 — etat actuel du mode mini (avec hysteresis pour eviter le flicker
   *  autour de zoom = 10). null = pas encore initialise. */
  private lastMiniState: boolean | null = null;
  private static readonly ZOOM_MINI_ENTER = 9.5;
  private static readonly ZOOM_MINI_EXIT = 10.5;
  /** Sprint G.5 — verrouillage du pan (la carte ne peut plus etre deplacee). */
  protected readonly mapLocked = signal(false);
  /** Sprint F.3 — sheet mobile pour les calques (FAB toggle). */
  protected readonly mobileSheetOpen = signal(false);
  /** Desktop — panel Calques collapsable (fermé par défaut pour libérer la map). */
  protected readonly calquesPanelOpen = signal(false);
  /** Label du style de carte courant (ex: "Plan", "Satellite") pour le bouton dropdown. */
  protected readonly currentStyleLabel = computed(() => {
    const id = this.currentStyle();
    return this.styles.catalog.find((s) => s.id === id)?.label ?? 'Plan';
  });
  /** Label du mode caméra courant pour le bouton dropdown. */
  protected readonly currentCameraLabel = computed(() => {
    const id = this.cameraMode();
    return this.cameraModes.find((m) => m.id === id)?.label ?? 'Libre';
  });

  /** Compte le nombre de filtres "non par défaut" actifs (badge sur le bouton Calques). */
  protected readonly activeFiltersCount = computed(() => {
    let n = 0;
    const f = this.filters();
    // Par défaut tous les 4 filtres statut sont true → on compte ceux qui sont OFF
    if (!f.moving) n++;
    if (!f.idle) n++;
    if (!f.off) n++;
    if (!f.offline) n++;
    // Calques optionnels comptés s'ils sont activés
    if (this.showStops()) n++;
    if (this.showHeatmap()) n++;
    if (!this.showGeofences()) n++;     // par défaut true
    if (!this.showTrails()) n++;        // par défaut true
    if (!this.showPlates()) n++;        // par défaut true
    if (!this.showFuelStations()) n++;  // par défaut true (demande client)
    if (!this.showDeadZones()) n++;     // par défaut true (demande client)
    // Lieux : ne compte que si l'utilisateur peut les voir (sinon le calque n'existe pas pour lui).
    if (this.canViewPlaces() && !this.showFleetPlaces()) n++;
    return n;
  });
  /** Desktop — dropdown style de carte (Plan / Sombre / Clair / etc.). */
  protected readonly stylePickerOpen = signal(false);
  /** Desktop — dropdown mode caméra (Libre / 3D / Suivre / Sens). */
  protected readonly cameraPickerOpen = signal(false);
  /** Mobile : overlay de recherche déployable depuis la top bar. */
  protected readonly mobileSearchOpen = signal(false);
  /** Picker véhicule pour les modes Suivre/Sens. */
  protected readonly vehiclePickerOpen = signal(false);
  /** Mode caméra cible en attente de sélection véhicule. */
  protected readonly pendingCameraMode = signal<CameraMode | null>(null);

  /**
   * Liste du picker « suivre ce véhicule », les vivants d'abord, les muets ensuite.
   *
   * Aucun véhicule n'est retiré de la liste — on la TRIE et on DATE les muets. Un
   * exploitant a le droit d'aller voir où son boîtier déposé s'est arrêté ; ce qu'on
   * lui évite, c'est de choisir « suivre » un véhicule qui ne bougera plus et de se
   * retrouver avec une caméra verrouillée sur un point mort sans explication
   * (cf. `pickVehicleForCamera`).
   *
   * Seuil d'ACTION (72 h), pas de comptage : c'est la garde d'un bouton, et on
   * l'aligne sur le seuil au-delà duquel le serveur cesse lui-même d'agir sur un
   * boîtier. Un véhicule SANS boîtier (TEST-xxx) n'est jamais « muet » — il n'a
   * jamais parlé, ce n'est pas la même chose (cf. `isVehicleDormant`).
   */
  protected readonly cameraPickerVehicles = computed(() => {
    const now = Date.now();
    return this.scopedSnapshot()
      .map((v) => ({
        vehicleId: v.vehicleId,
        plate: v.plate,
        type: v.type,
        dormant: isVehicleDormant(
          { trackerId: v.trackerId, lastSeenAt: v.lastSeenAt },
          now,
          DORMANT_STOP_ACTING_MS,
        ),
        silenceLabel: formatSilenceLabel(v.lastSeenAt, now),
      }))
      .sort((a, b) => Number(a.dormant) - Number(b.dormant) || a.plate.localeCompare(b.plate));
  });

  /** Combien de véhicules du picker peuvent réellement être suivis (non muets). */
  protected readonly cameraPickerLiveCount = computed(
    () => this.cameraPickerVehicles().filter((v) => !v.dormant).length,
  );
  /** Drag-to-dismiss sheet (offset Y en cours). */
  protected readonly sheetDragY = signal(0);
  private sheetTouchStartY = 0;

  protected readonly filters = signal<{ moving: boolean; idle: boolean; off: boolean; offline: boolean }>({
    moving: true, idle: true, off: true, offline: true,
  });

  protected readonly contextMenu = signal<{ x: number; y: number; lat: number; lng: number } | null>(null);

  /** Sprint D.2 — vehicleId actuellement affiche en mini-replay 1h (null = aucun). */
  protected readonly miniReplayVehicleId = signal<string | null>(null);
  /** Sprint D.4 — mode mesure de distance actif. */
  protected readonly measureMode = signal(false);
  protected readonly measurePoints = signal<Array<{ lat: number; lng: number }>>([]);
  protected readonly measureTotalKm = computed(() => {
    const pts = this.measurePoints();
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += haversineMeters(pts[i - 1]!.lat, pts[i - 1]!.lng, pts[i]!.lat, pts[i]!.lng);
    }
    return total / 1000;
  });
  /** Sprint E.1 — mode Cinema : cycle sur les vehicules en mouvement, 8s chacun. */
  protected readonly cinemaMode = signal(false);
  private cinemaIntervalId: ReturnType<typeof setInterval> | null = null;
  private cinemaIndex = 0;

  private readonly _accessibleIds = signal<Set<string> | 'ALL'>('ALL');

  protected readonly cameraModes: Array<{ id: CameraMode; label: string; tooltip: string }> = [
    { id: 'free',        label: 'Libre',     tooltip: 'Navigation libre (drag, zoom, rotation)' },
    { id: 'chase',       label: '3D',        tooltip: 'Vue plongée 60° pour explorer le relief' },
    { id: 'follow',      label: 'Suivre',    tooltip: 'Suivre un véhicule (sélection requise)' },
    { id: 'heading-up',  label: 'Sens',      tooltip: 'Suivre + carte orientée dans le sens de marche' },
  ];

  // Sprint 0.1 — « actif(s) » = positions FRAÎCHES (live), pas « a une dernière
  // position connue ». Avant, le compteur restait figé pendant une coupure
  // realtime (positions hydratées via REST, jamais périmées) et affichait un
  // nombre trompeur À CÔTÉ du bandeau « interrompue ». Désormais cohérent avec
  // l'admin Trackers (même seuil de fraîcheur). Cf. docs/sprint-0.1.
  protected readonly filteredPositionCount = computed(() => {
    const ids = this._accessibleIds();
    const accessible =
      ids === 'ALL'
        ? this.realtime.positionsList()
        : this.realtime.positionsList().filter((p) => (ids as Set<string>).has(p.vehicleId));
    // Fraîcheur lue sur `lastSeenAt` (heure SERVEUR) et non sur `timestamp` (horloge
    // du boîtier, qui dérive ou repart à zéro après une coupure) : sinon le compteur
    // « actifs » comptait des boîtiers morts et en oubliait des vivants.
    const now = Date.now();
    const lastSeen = new Map(this.realtime.snapshot().map((s) => [s.vehicleId, s.lastSeenAt]));
    return accessible
      .filter((p) => this.fleetFilter.matches(p.fleetId))
      .filter((p) => isTrackerOnline(lastSeen.get(p.vehicleId) ?? p.timestamp, now)).length;
  });

  protected readonly followedPlate = computed(() => {
    const vid = this.followedVehicleId();
    if (!vid) return '';
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === vid);
    return snap?.plate ?? '';
  });

  // Re-render markers chaque fois que les positions changent.
  private positionsEffect = effect(() => {
    const all = this.realtime.positionsList();
    const ids = this._accessibleIds();
    const filtered = ids === 'ALL'
      ? all
      : all.filter((p) => (ids as Set<string>).has(p.vehicleId));
    if (!this.map) return;
    this.applyPositions(this.applyFilters(filtered));
  });

  // Le calque stations-service est chargé côté API (agrégat flotte), donc pas
  // filtrable client-side comme les markers : on le recharge quand le super-admin
  // change de société. Dépendance UNIQUE = selectedFleetId (map/showFuelStations
  // lus en untracked pour ne pas re-déclencher au simple toggle du calque).
  private fuelStationsFleetEffect = effect(() => {
    this.fleetFilter.selectedFleetId();
    untracked(() => {
      if (this.map && this.showFuelStations()) {
        this.loadFuelStations().catch(() => { /* silent */ });
      }
    });
  });

  // Zones mortes GPS : chargées EN CONTINU (indépendamment du toggle d'affichage) car elles servent
  // à l'override « à l'arrêt · parking souterrain » des cards, pas seulement au calque. Rechargées
  // au changement de société (super-admin).
  private deadZonesFleetEffect = effect(() => {
    this.fleetFilter.selectedFleetId();
    untracked(() => {
      if (this.map) {
        this.loadDeadZones().catch(() => { /* silent */ });
        // Lieux clés : idem, le référentiel est propre à la société sélectionnée.
        this.loadFleetPlaces().catch(() => { /* silent */ });
      }
    });
  });

  // Reagir aux events ENGINE_COMMAND_UPDATED (CUT/RESTORE via SMS, scheduler, etc.)
  // pour rafraichir la bottom card ouverte et mettre a jour l'etat ignition affiche.
  private engineCommandEffect = effect(() => {
    const updates = this.realtime.engineCommandUpdates();
    if (!this.activePopupTrackerId) return;
    const update = updates.get(this.activePopupTrackerId);
    if (!update) return;
    const pos = this.realtime.positionsList().find((p) => p.trackerId === this.activePopupTrackerId);
    if (!pos) return;
    // #high — lire la carte en `untracked` : sinon l'effet DEPEND de baanoolCard ET
    // y ecrit un nouvel objet a chaque run => boucle infinie (re-declenche par sa
    // propre ecriture, 1 coeur CPU a fond tant que le popup reste ouvert). En plus,
    // on ne re-set QUE si l'ignition ou le cutActive a reellement change.
    const currentCard = untracked(() => this.baanoolCard());
    if (currentCard) {
      const patched = this.patchIgnitionFromCommands(pos);
      const cutActive = this.isCutActiveForTracker(pos.trackerId);
      const cutPending = this.isCutPendingForTracker(pos.trackerId);
      if (currentCard.ignition !== patched.ignition || currentCard.cutActive !== cutActive || currentCard.cutPending !== cutPending) {
        this.baanoolCard.set({ ...currentCard, ignition: patched.ignition, cutActive, cutPending });
      }
    }
  });

  // V1.12 — Bridge avec BaanoolMapOverlay : effects en field initializers (= injection
  // context valide). Triggers numeriques incrementes par l'overlay → on fire l'action
  // map correspondante. La 1ere lecture du signal sert juste de baseline (pas d'action).
  private bridgeRecenterEffect = effect(() => {
    const n = this.mapBridge.recenterTrigger();
    // ⚠️ `untracked` OBLIGATOIRE : `centerAll()` lit désormais `realtime.snapshot()` (pour
    // écarter les muets du cadrage) et peut pousser un toast (qui lit la pile de toasts).
    // Sans ce garde-fou, l'effet s'abonnerait à ces deux signaux alors que `n` reste > 0 :
    // la carte se recadrerait à CHAQUE trame reçue (l'utilisateur ne pourrait plus ni
    // déplacer ni zoomer après un seul clic sur « recentrer »), et re-cadrerait en boucle
    // à chaque expiration du toast qu'elle vient elle-même d'afficher.
    if (n > 0) untracked(() => this.centerAll());
  });
  private bridgeLocateEffect = effect(() => {
    const n = this.mapBridge.locateTrigger();
    if (n > 0) this.centerOnUser();
  });
  private bridgeSatelliteEffect = effect(() => {
    const n = this.mapBridge.toggleSatelliteTrigger();
    if (n > 0 && this.map) {
      const next: MapStyleId = this.currentStyle() === 'satellite' ? 'osm' : 'satellite';
      this.setStyle(next);
    }
  });
  /** Click sur un vehicule depuis le panel Baanool : centre la map sur sa
   *  position connue (snapshot realtime). Reset le signal apres consommation
   *  pour permettre un nouveau click sur le meme vehicule. */
  private bridgeFlyToEffect = effect(() => {
    // ⚠️ On lit les DEUX signaux AVANT tout retour anticipé. Sinon, quand la demande vient d'une
    // AUTRE page (vignette du tableau de bord), l'effet s'exécute alors que la carte n'existe pas
    // encore, sort immédiatement, et ne se relancerait jamais : la demande serait perdue.
    const vid = this.mapBridge.flyToVehicleId();
    const positions = this.realtime.positionsList();
    if (!vid || !this.map) return;
    this.consumeFlyTo(vid, positions);
  });

  /** Centre sur le véhicule demandé et libère la demande. Appelé aussi à la fin du chargement
   *  de la carte, pour ne pas dépendre du prochain rafraîchissement de positions. */
  private consumeFlyTo(vehicleId: string, positions = this.realtime.positionsList()): void {
    if (!this.map) return;
    const pos = positions.find((p) => p.vehicleId === vehicleId);
    if (pos) {
      this.followedVehicleId.set(vehicleId);
      this.map.flyTo({ center: [pos.lng, pos.lat], zoom: 16, duration: 800 });
      // Le véhicule est peut-être muet depuis des semaines : on l'affiche quand même
      // (rule : on DATE, on ne masque pas), mais on refuse de laisser croire que ce
      // point est du live. Seuil de COMPTAGE : ce n'est pas une commande, juste une
      // mise en garde d'affichage.
      const snap = this.realtime.snapshot().find((s) => s.vehicleId === vehicleId);
      if (snap && isVehicleDormant({ trackerId: snap.trackerId, lastSeenAt: snap.lastSeenAt }, Date.now(), DORMANT_STOP_COUNTING_MS)) {
        this.toast.show({
          kind: 'info',
          title: `${snap.plate} — dernière position connue`,
          message: `Ce véhicule est muet depuis ${formatSilenceLabel(snap.lastSeenAt) ?? 'longtemps'}.`,
          duration: 5000,
          dedupeKey: `map-flyto-dormant-${vehicleId}`,
        });
      }
    } else {
      // Course au démarrage : la carte est prête AVANT l'hydratation REST des positions.
      // On ne consomme pas la demande dans ce cas — l'effet la rejouera dès l'arrivée des
      // positions. Sans ça, un clic depuis le tableau de bord était perdu (et, pire, on
      // annoncerait « position inconnue » pour un véhicule parfaitement suivi.)
      if (!this.realtime.hydrated()) return;
      // Avant : demande avalée en silence — l'utilisateur cliquait sur un véhicule
      // (vignette tableau de bord, panneau Baanool) et il ne se passait RIEN.
      this.toast.show({
        kind: 'warning',
        title: 'Position inconnue',
        message: 'Aucune position connue pour ce véhicule : rien à centrer sur la carte.',
        duration: 5000,
        dedupeKey: `map-flyto-nopos-${vehicleId}`,
      });
    }
    this.mapBridge.flyToVehicleId.set(null);
  }

  ngAfterViewInit(): void {
    // Charger prefs map
    const prefs = this.preferences.prefs().map;
    this.currentStyle.set(prefs.style);
    this.cameraMode.set(prefs.cameraMode);
    this.showTrails.set(prefs.showTrails);
    this.showPlates.set(prefs.showPlates);
    this.compactMarkers.set(prefs.compactMarkers);

    setTimeout(() => this.initMap(), 0);

    // Hydratation : si snapshot deja la, pre-construire la metadata vehicule.
    const snap = this.realtime.snapshot();
    for (const v of snap) {
      // V1.15 — fleetId/imei/lastSeenAt deja dans VehicleSnapshotDto, on les
      // injecte dans la meta pour les exposer dans la card popup (badge SA).
      const snapMeta = v as unknown as {
        fleetId?: string | null;
        trackerImei?: string | null;
        lastSeenAt?: string | null;
        group?: { id: string; name: string } | null;
        brand?: string | null;
      };
      this.vehicleMeta.set(v.vehicleId, {
        type: v.type,
        plate: v.plate,
        brand: snapMeta.brand ?? null,
        fleetId: snapMeta.fleetId ?? null,
        imei: snapMeta.trackerImei ?? null,
        lastSeenAt: snapMeta.lastSeenAt ?? null,
        group: snapMeta.group ?? null,
      });
    }

    // Recupere aussi depuis /api/vehicles pour les types manquants (ex : si snapshot vide).
    firstValueFrom(this.vehiclesApi.list()).then((vehicles) => {
      this._accessibleIds.set(new Set(vehicles.map((v) => v.id)));
      vehicles.forEach((v) => {
        const cast = v as VehicleDetailDto & { type?: string };
        this.vehicleMeta.set(v.id, {
          type: cast.type ?? 'OTHER',
          plate: v.plate,
          brand: v.brand ?? null,
          fleetId: v.fleetId ?? null,
          imei: v.tracker?.imei ?? null,
          lastSeenAt: v.tracker?.lastSeenAt ?? null,
          group: v.group ?? null,
        });
      });
      // Re-render apres MAJ meta
      if (this.map) this.applyPositions(this.applyFilters(this.realtime.positionsList()));
    }).catch(() => { /* fallback to ALL */ });
  }

  private initMap(): void {
    const container = this.mapContainerRef().nativeElement;
    const prefs = this.preferences.prefs().map;

    this.map = this.mapSvc.createMap(container, {
      center: { lat: prefs.centerLat, lng: prefs.centerLng },
      zoom: prefs.zoom,
      style: prefs.style,
    });

    this.map.on('rotate', () => this.mapBearing.set(this.map!.getBearing()));
    this.map.on('pitch', () => this.mapPitch.set(this.map!.getPitch()));
    // Mémorisation de la dernière vue : on retrouve SA zone au retour, au lieu de repartir de la
    // vue par défaut. `moveend` ne se déclenche qu'en fin de geste — pas de flot d'écritures.
    this.map.on('moveend', () => this.persistLastView());

    // Quand l'utilisateur drag manuellement en mode follow, sortir du mode.
    // V1.12 — On en profite pour notifier les overlays (panel Baanool) qu'il
    // y a interaction map : 'dragstart' fire UNIQUEMENT sur drag user
    // (pas sur flyTo/easeTo programmatiques), donc safe sans filtre.
    this.map.on('dragstart', () => {
      if (this.cameraMode() !== 'free') {
        this.setCameraMode('free');
      }
      this.mapBridge.notifyMapInteraction();
    });

    // V1.12 — Zoom user : zoomstart avec originalEvent defined = vrai geste
    // (molette/pinch/double-click). Programmatique = pas d'originalEvent.
    this.map.on('zoomstart', (e) => {
      if (e.originalEvent) this.mapBridge.notifyMapInteraction();
    });

    // Right-click context menu.
    this.map.on('contextmenu', (e) => {
      const rect = container.getBoundingClientRect();
      this.contextMenu.set({
        x: e.point.x,
        y: e.point.y,
        lat: e.lngLat.lat,
        lng: e.lngLat.lng,
      });
      // Eviter que rect/scroll polluent — pas critique pour V1.
      void rect;
    });

    // Le canvas MapLibre ne doit PAS être capturé par le fallback cursor:pointer du
    // tracker (libellé générique + doublon des clics cluster/point tracés explicitement
    // ci-dessous). Les markers véhicule sont des éléments DOM frères → toujours capturés.
    this.map.getCanvas().setAttribute('data-no-track', '');

    // Setup sources/layers de base apres `load`.
    this.map.on('load', () => {
      this.setupGeofencesLayer();
      this.setupTrailsLayer();
      this.setupMiniReplayLayer();
      this.setupMeasureLayer();
      this.setupStopsLayer();
      this.setupHeatmapLayer();
      this.setupFuelStationsLayer();
      this.setupClusterLayer();
      this.loadGeofences();
      this.loadDeadZones().catch(() => { /* silent */ });
      this.loadFleetPlaces().catch(() => { /* silent */ });
      if (this.showFuelStations()) this.loadFuelStations().catch(() => { /* silent */ });
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
      this.applyClusterVisibility();
      this.restoreFromUrl();
      // Demande de centrage arrivée d'une AUTRE page (vignette dashboard) avant que la carte
      // n'existe : on la consomme dès que la carte est prête, sans attendre une nouvelle trame.
      const pendingVid = this.mapBridge.flyToVehicleId();
      if (pendingVid) this.consumeFlyTo(pendingVid);
    });

    // Sprint G.2 — refresh cluster visibility on zoom change.
    // 'zoom' au lieu de 'zoomend' pour que le toggle mini/full soit reactif
    // pendant le geste (pas d'attente de fin de zoom). Pas de drift car les
    // markers utilisent transform:scale (pas de reflow layout).
    // Les cluster GL layers n'ont plus besoin de cet event : leur opacite est
    // geree par des expressions zoom-dependent MapLibre (fade progressif).
    this.map.on('zoom', () => this.applyClusterVisibility());

    // Click pour la mesure de distance.
    this.map.on('click', (e) => {
      this.closeContextMenu();
      // V1.12 — Click sur le fond de map = aussi un signal d'interaction
      // pour fermer les overlays. movestart ne fire pas sur un simple tap.
      this.mapBridge.notifyMapInteraction();
      if (this.measureMode()) {
        const pts = [...this.measurePoints(), { lat: e.lngLat.lat, lng: e.lngLat.lng }];
        this.measurePoints.set(pts);
        this.refreshMeasureLayer();
        return;
      }
      // Lieux clés — mode « poser un lieu » : le clic capture le point, on demande ensuite
      // le nom + la nature dans un petit panneau (pas de création silencieuse).
      if (this.placeMode()) {
        this.pendingPlace.set({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(container);

    // Boucle d'animation pour l'interpolation des markers (Sprint C).
    this.startAnimLoop();

    // Géolocalisation utilisateur : on récupère la position (point bleu + bouton « Ma position »
    // actif) mais on NE DÉPLACE PLUS la caméra. Recentrer d'autorité sur l'utilisateur écrasait
    // la vue d'ensemble de la flotte à chaque ouverture — il fallait dézoomer systématiquement.
    // Le recentrage reste disponible à la demande via `centerOnUser()`.
    this.requestUserPosition(false);

    // Fix defensif iOS PWA standalone (icone ecran d'accueil) : Maplibre peut
    // initialiser son canvas a 0px si la chaine flexbox du shell ne s'est pas
    // resolue au moment du createMap() (bug specifique Safari standalone, OK en
    // browser/Android). Le ResizeObserver devrait detecter mais le timing est
    // instable sur cette plateforme. On force plusieurs map.resize() echelonnes
    // pour couvrir : 1er layout, animations CSS, resolution safe-area, etc.
    // map.resize() est idempotent — no-op si la taille est deja correcte.
    // Scope strict body.ios-pwa : zero impact desktop, browser, Android.
    if (typeof document !== 'undefined' && document.body.classList.contains('ios-pwa')) {
      [100, 500, 1500, 3000].forEach((ms) => {
        setTimeout(() => this.map?.resize(), ms);
      });
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.cinemaIntervalId) {
      clearInterval(this.cinemaIntervalId);
      this.cinemaIntervalId = null;
    }

    this.markers.forEach((m) => {
      m.abort.abort();
      m.marker.remove();
    });
    this.markers.clear();
    // V1.10 (Sprint 3 perf) — cleanup explicit des listeners cluster en plus
    // de map.remove() (qui est suppose les nettoyer, mais defense en profondeur).
    for (const off of this.clusterListenerCleanups) off();
    this.clusterListenerCleanups = [];
    this.trailPoints.clear();
    this.lastTruthPosition.clear();
    this.rejectStreak.clear();
    this.motion.clear();
    this.lastTickAt = null;
    this.lastMarkerData.clear();
    this.userMarker?.remove();
    this.userMarker = null;

    this.currentPopup?.remove();
    this.currentPopup = null;

    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  /**
   * Boucle d'animation : a chaque RAF, calcule la position cible de chaque
   * marker via extrapolation (truth + speed*dt selon heading), puis fait
   * converger `display` vers `target` via un filtre passe-bas exponentiel.
   *
   * Ainsi l'icone affiche le temps reel (et non la position d'il y a 30s) tant
   * que le vehicule roule en ligne droite, et corrige doucement quand la
   * trame suivante arrive avec un cap/vitesse different.
   *
   * V1.5 (Sprint H2) : skip total du travail si l'onglet est cache. Le RAF
   * reste enchaine pour pouvoir reprendre instantanement au retour, mais la
   * mutation des markers et le suivi camera sont court-circuites.
   */
  private startAnimLoop(): void {
    const tick = (now: number) => {
      this.animFrameId = requestAnimationFrame(tick);
      if (!this.visibility.isVisible()) {
        this.lastTickAt = null; // reset dt: le prochain tick ne doit pas faire un saut enorme
        return;
      }
      if (this.motion.size === 0) {
        this.lastTickAt = null;
        return;
      }

      const dtMs = this.lastTickAt === null
        ? 16
        : Math.min(MAX_FRAME_DT_MS, now - this.lastTickAt);
      this.lastTickAt = now;

      // Coefficients du filtre passe-bas exponentiel display → target.
      // alpha = 1 - exp(-dt/tau)  →  invariant au framerate.
      const alphaPos = 1 - Math.exp(-dtMs / SMOOTHING_TAU_MS);
      const alphaHead = 1 - Math.exp(-dtMs / HEADING_TAU_MS);

      const followedVid = this.followedVehicleId();
      const camMode = this.cameraMode();

      for (const [trackerId, st] of this.motion) {
        // 1. Cible = derniere verite + extrapolation. `extrapolate` projette en
        // ligne droite quand le cap est stable, mais sur un ARC borne quand le
        // vehicule tourne (yaw rate) → l'icone epouse le virage au lieu de partir
        // tangente puis de re-snapper. Au-dela de capSec (trame perdue) elle se fige.
        const ext = extrapolate(
          { lat: st.truthLat, lng: st.truthLng, headingDeg: st.truthHeading },
          st.truthSpeedMs,
          st.turnRateDegPerS,
          (now - st.truthAt) / 1000,
          (st.intervalMs * EXTRAPOLATION_CAP_FACTOR) / 1000,
        );
        const targetLat = ext.lat;
        const targetLng = ext.lng;
        const targetHeading = ext.headingDeg;

        // 2. Lissage display → target.
        st.displayLat = st.displayLat + (targetLat - st.displayLat) * alphaPos;
        st.displayLng = st.displayLng + (targetLng - st.displayLng) * alphaPos;
        st.displayHeading = lerpHeading(st.displayHeading, targetHeading, alphaHead);

        // 3. Push au marker — V1.10 (Sprint 3 perf) skip si delta negligeable.
        const entry = this.markers.get(trackerId);
        if (entry) {
          const latDiff = Math.abs(st.displayLat - (st.pushedLat ?? Number.POSITIVE_INFINITY));
          const lngDiff = Math.abs(st.displayLng - (st.pushedLng ?? Number.POSITIVE_INFINITY));
          const headingDiff = Math.abs(st.displayHeading - (st.pushedHeading ?? Number.POSITIVE_INFINITY));
          if (latDiff > PUSH_LATLNG_EPSILON || lngDiff > PUSH_LATLNG_EPSILON || headingDiff > PUSH_HEADING_EPSILON) {
            entry.marker.setLngLat([st.displayLng, st.displayLat]);
            const data = this.lastMarkerData.get(trackerId);
            if (data) {
              updateVehicleMarkerEl(entry.el, { ...data, heading: st.displayHeading });
            }
            st.pushedLat = st.displayLat;
            st.pushedLng = st.displayLng;
            st.pushedHeading = st.displayHeading;
          }
        }

        // 4. Camera follow : copie la position lissee directement.
        if (this.map && (camMode === 'follow' || camMode === 'heading-up' || camMode === 'chase')) {
          const data = this.lastMarkerData.get(trackerId);
          if (data && data.vehicleId === followedVid) {
            this.map.jumpTo({
              center: [st.displayLng, st.displayLat],
              bearing: (camMode === 'heading-up' || camMode === 'chase')
                ? st.displayHeading
                : this.map.getBearing(),
            });
          }
        }
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  /* --- Camera & view --- */

  /**
   * `lastSeenAt` (heure SERVEUR de la dernière trame) indexé par trackerId : les
   * marqueurs sont indexés par tracker, le snapshot par véhicule.
   *
   * Un tracker absent du snapshot renvoie `undefined`, et les prédicats de dormance
   * le déclarent alors NON dormant : on ne met jamais un véhicule de côté sur la foi
   * d'une donnée qu'on n'a pas.
   */
  private lastSeenByTrackerId(): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const s of this.realtime.snapshot()) {
      if (s.trackerId) map.set(s.trackerId, s.lastSeenAt);
    }
    return map;
  }

  /**
   * Vue d'ensemble.
   *
   * @param opts.announceSetAside  annonce les véhicules muets laissés hors cadrage.
   *   Faux pour le cadrage AUTOMATIQUE du premier rendu : l'utilisateur n'a rien
   *   demandé, un bandeau au démarrage à chaque session serait du bruit.
   */
  protected centerAll(opts: { announceSetAside?: boolean } = {}): void {
    const announceSetAside = opts.announceSetAside ?? true;
    // Vue d'ensemble = quitter cinema + camera libre + remettre pitch 0
    if (this.cinemaMode()) {
      this.cinemaMode.set(false);
      if (this.cinemaIntervalId) clearInterval(this.cinemaIntervalId);
      this.cinemaIntervalId = null;
    }
    if (this.cameraMode() !== 'free') {
      this.cameraMode.set('free');
      this.followedVehicleId.set(null);
      this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: 'free' } });
    }
    if (!this.map || this.markers.size === 0) return;
    this.map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
    const now = Date.now();
    const lastSeen = this.lastSeenByTrackerId();
    const all = Array.from(this.markers.entries()).map(([trackerId, m]) => {
      const ll = m.marker.getLngLat();
      return { trackerId, lat: ll.lat, lng: ll.lng };
    });
    // CADRAGE — on n'étire plus la vue d'ensemble sur des véhicules muets depuis plus
    // d'une semaine. Cas réel : deux boîtiers déposés (89 j et 52 j) figés loin du parc
    // exploité ; les inclure dézoomait la carte au point d'agglutiner les 37 véhicules
    // actifs en un seul pâté de pixels. Seuil de COMPTAGE (7 j) et non d'action : ce
    // n'est qu'un cadrage, on reste prudent pour ne pas écarter un véhicule simplement
    // garé une semaine. Les dormants restent DESSINÉS à leur dernière position connue —
    // ils sortent du cadrage, pas de la carte.
    const livePoints = all.filter(
      (p) => !isVehicleDormant({ trackerId: p.trackerId, lastSeenAt: lastSeen.get(p.trackerId) }, now, DORMANT_STOP_COUNTING_MS),
    );
    const setAside = all.length - livePoints.length;
    if (livePoints.length === 0) {
      // Repli EXPLIQUÉ : parc entièrement muet. On cadre quand même (sinon la carte
      // resterait où elle est, sans que rien ne dise pourquoi le bouton « ne marche
      // pas »), mais on annonce que ce qui est affiché n'est plus du live.
      this.toast.show({
        kind: 'warning',
        title: 'Aucun véhicule ne communique',
        message: 'Vue cadrée sur les dernières positions connues.',
        duration: 6000,
        dedupeKey: 'map-fit-all-dormant',
      });
    } else if (setAside > 0 && announceSetAside) {
      this.toast.show({
        kind: 'info',
        title: `${setAside} véhicule${setAside > 1 ? 's' : ''} muet${setAside > 1 ? 's' : ''} hors cadrage`,
        message: 'Silencieux depuis plus de 7 jours — toujours affichés à leur dernière position.',
        duration: 5000,
        dedupeKey: 'map-fit-dormant-set-aside',
      });
    }
    const points = livePoints.length > 0 ? livePoints : all;
    this.mapSvc.fitBounds(this.map, points, { padding: 70, maxZoom: 15 });
  }

  protected centerOnUser(): void {
    this.requestUserPosition(true);
  }

  /**
   * Enregistre la vue courante (centre + zoom) pour la restaurer à la prochaine ouverture.
   *
   * ⚠️ On ignore les déplacements que l'utilisateur n'a PAS demandés : en mode cinéma ou en
   * caméra suivie, la carte se déplace toute seule — mémoriser ces positions reviendrait à
   * enregistrer un véhicule au hasard comme « ma vue » (et à l'écraser toutes les 8 s).
   */
  private persistLastView(): void {
    if (!this.map || this.cinemaMode() || this.cameraMode() !== 'free') return;
    const c = this.map.getCenter();
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return;
    this.preferences.update({
      map: {
        ...this.preferences.prefs().map,
        centerLat: Math.round(c.lat * 1e5) / 1e5,
        centerLng: Math.round(c.lng * 1e5) / 1e5,
        zoom: Math.round(this.map.getZoom() * 10) / 10,
      },
    });
  }

  private requestUserPosition(centerMap: boolean): void {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this.userPosition.set(coords);
        this.updateUserMarker(coords);
        if (centerMap && this.map && !this.hasFittedBounds) {
          this.map.flyTo({ center: [coords.lng, coords.lat], zoom: 12, duration: 1000 });
        } else if (centerMap && this.map) {
          this.map.flyTo({ center: [coords.lng, coords.lat], zoom: 14, duration: 800 });
        }
      },
      () => { /* Permission refusée ou erreur — fallback silencieux */ },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }

  private updateUserMarker(coords: { lat: number; lng: number }): void {
    if (!this.map) return;
    if (this.userMarker) {
      this.userMarker.setLngLat([coords.lng, coords.lat]);
      return;
    }
    const el = document.createElement('div');
    Object.assign(el.style, { position: 'relative', width: '20px', height: '20px' });

    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'absolute', inset: '4px', borderRadius: '50%',
      background: '#3b82f6', border: '2.5px solid white',
      boxShadow: '0 1px 4px rgba(0,0,0,.3)', zIndex: '2',
    });

    const pulse = document.createElement('div');
    Object.assign(pulse.style, {
      position: 'absolute', inset: '-6px', borderRadius: '50%',
      background: 'rgba(59,130,246,.25)', zIndex: '1',
      animation: 'tracky-user-pulse 2s ease-out infinite',
    });

    // Injecter le keyframe globalement (une seule fois)
    if (!document.getElementById('tracky-user-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'tracky-user-pulse-style';
      style.textContent = '@keyframes tracky-user-pulse{0%{transform:scale(.5);opacity:1}100%{transform:scale(2.2);opacity:0}}';
      document.head.appendChild(style);
    }

    el.appendChild(pulse);
    el.appendChild(dot);
    this.userMarker = new maplibregl.Marker({ element: el })
      .setLngLat([coords.lng, coords.lat])
      .addTo(this.map);
  }

  protected setStyle(id: MapStyleId): void {
    if (!this.map) return;
    // V1.10 (Sprint 3 perf) — garde-fou anti-race : si un setStyle est encore
    // en cours de re-setup des sources, on ignore l'appel suivant. Sans ca,
    // un user qui clique 2 fois sur 2 styles dans la palette empilait des
    // setupClusterLayer concurrents, doublant les listeners et causant des
    // sources orphelines apres le second styledata.
    if (this.styleChangeInFlight) return;
    this.styleChangeInFlight = true;
    this.currentStyle.set(id);
    this.preferences.update({ map: { ...this.preferences.prefs().map, style: id } });
    this.mapSvc.setStyle(this.map, id);
    // Mobile : on ferme la sheet pour que l'utilisateur voit le résultat tout de suite.
    if (this.mobileSheetOpen() && window.matchMedia('(max-width: 767px)').matches) {
      this.mobileSheetOpen.set(false);
    }
    // Apres setStyle, les sources custom (geofences/trails) sont perdues — on les recree.
    this.map.once('styledata', () => {
      try {
        this.setupGeofencesLayer();
        this.setupTrailsLayer();
        this.setupMiniReplayLayer();
        this.setupMeasureLayer();
        this.setupStopsLayer();
        this.setupHeatmapLayer();
        this.setupFuelStationsLayer();
        this.setupClusterLayer();
        this.loadGeofences();
        this.applyPositions(this.applyFilters(this.realtime.positionsList()));
        this.applyClusterVisibility();
        // Mini-replay : si actif, recharger.
        const vid = this.miniReplayVehicleId();
        if (vid) this.loadMiniReplay(vid).catch(() => { /* silent */ });
        this.refreshMeasureLayer();
        if (this.showStops()) this.loadStops().catch(() => { /* silent */ });
        if (this.showFuelStations()) this.loadFuelStations().catch(() => { /* silent */ });
        this.loadDeadZones().catch(() => { /* silent */ });
      } finally {
        this.styleChangeInFlight = false;
      }
    });
  }

  /**
   * Sprint G.2 — bascule entre markers DOM riches (zoom eleve) et markers
   * compacts (zoom faible). Les markers restent TOUJOURS visibles : a zoom < 10
   * ils passent en mode mini (petit point colore) pour garder une vue d'ensemble.
   * Les clusters ne s'affichent que pour les groupes denses a faible zoom.
   *
   * V1.7 — hysteresis [9.5, 10.5] pour eviter le toggling autour de z=10
   * (ce qui causait des flickers visuels avec la transition CSS). En plus,
   * le toggle Calques `compactMarkers` permet de desactiver totalement le
   * mode mini (markers riches meme a faible zoom).
   */
  private applyClusterVisibility(): void {
    if (!this.map) return;
    const z = this.map.getZoom();

    // Hysteresis : pas de toggle si on est dans la zone tampon [9.5, 10.5].
    let mini: boolean;
    if (this.lastMiniState === null) {
      mini = z < 10;
    } else if (this.lastMiniState && z > MapComponent.ZOOM_MINI_EXIT) {
      mini = false;
    } else if (!this.lastMiniState && z < MapComponent.ZOOM_MINI_ENTER) {
      mini = true;
    } else {
      mini = this.lastMiniState;
    }

    // Toggle calques : si l'utilisateur a desactive le mode compact, on ne
    // passe jamais en mini meme a faible zoom (markers riches partout).
    const useMini = mini && this.compactMarkers();

    // Les layers cluster GL utilisent des expressions zoom-dependent pour
    // l'opacite (fade progressif entre ZOOM_MINI_ENTER et ZOOM_MINI_EXIT).
    // On ne toggle la visibility que pour le switch compactMarkers (desactive
    // totalement les clusters quand l'user prefere les markers riches partout).
    const showClusters = this.compactMarkers();
    this.setLayerVisibility('vehicles-cluster-bg', showClusters);
    this.setLayerVisibility('vehicles-cluster-count', showClusters);
    this.setLayerVisibility('vehicles-unclustered', showClusters);

    if (this.lastMiniState === mini) {
      for (const { el } of this.markers.values()) {
        el.classList.toggle('tracky-marker--mini', useMini);
      }
      return;
    }
    this.lastMiniState = mini;

    for (const { el } of this.markers.values()) {
      el.classList.toggle('tracky-marker--mini', useMini);
    }
  }

  /** V1.7 — toggle Calques : active/desactive le mode compact a faible zoom. */
  protected toggleCompactMarkers(): void {
    const v = !this.compactMarkers();
    this.compactMarkers.set(v);
    this.preferences.update({
      map: { ...this.preferences.prefs().map, compactMarkers: v },
    });
    // Force le recalcul (le state hysteresis ne change pas, mais useMini si).
    this.applyClusterVisibility();
  }

  /** Sprint D.2 — toggle l'affichage de la derniere heure pour un vehicule. */
  protected async toggleMiniReplay(vehicleId: string): Promise<void> {
    if (this.miniReplayVehicleId() === vehicleId) {
      this.miniReplayVehicleId.set(null);
      const src = this.map?.getSource('mini-replay') as GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    this.miniReplayVehicleId.set(vehicleId);
    await this.loadMiniReplay(vehicleId);
  }

  private async loadMiniReplay(vehicleId: string): Promise<void> {
    if (!this.map) return;
    try {
      const fromIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const res = await firstValueFrom(
        this.http.get<{ items: Array<{ lat: number; lng: number; timestamp: string; speedKmh: number }> }>(
          `/api/positions?vehicleId=${vehicleId}&from=${encodeURIComponent(fromIso)}&limit=500`,
        ),
      );
      // L'API trie DESC ; on inverse pour avoir un trace chronologique.
      const items = (res.items ?? []).slice().reverse();
      const cleaned = sanitizePositions(items.map((p) => ({
        lat: p.lat, lng: p.lng, timestamp: p.timestamp,
      })));
      if (cleaned.length < 2) {
        this.toast.show({ kind: 'info', title: 'Pas assez de positions sur la derniere heure', duration: 3000 });
        return;
      }
      const coords = cleaned.map((p) => [p.lng, p.lat] as [number, number]);
      const src = this.map.getSource('mini-replay') as GeoJSONSource | undefined;
      src?.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {},
      });
    } catch {
      this.toast.show({ kind: 'error', title: 'Echec du chargement de la derniere heure', duration: 3000 });
    }
  }

  /** Sprint D.4 — toggle l'outil de mesure de distance. */
  protected toggleMeasure(): void {
    const next = !this.measureMode();
    this.measureMode.set(next);
    if (!next) this.clearMeasure();
  }

  protected clearMeasure(): void {
    this.measurePoints.set([]);
    this.refreshMeasureLayer();
  }

  private refreshMeasureLayer(): void {
    const src = this.map?.getSource('measure') as GeoJSONSource | undefined;
    if (!src) return;
    const pts = this.measurePoints();
    const features: GeoJSON.Feature[] = pts.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {},
    }));
    if (pts.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) },
        properties: {},
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }

  /** Sprint D.5 — copie une URL avec la vue carte courante (lat/lng/zoom/bearing/pitch/style). */
  protected async shareUrl(): Promise<void> {
    if (!this.map) return;
    const c = this.map.getCenter();
    const params = new URLSearchParams({
      lat: c.lat.toFixed(6), lng: c.lng.toFixed(6),
      zoom: this.map.getZoom().toFixed(2),
      bearing: this.map.getBearing().toFixed(1),
      pitch: this.map.getPitch().toFixed(1),
      style: this.currentStyle(),
    });
    const url = `${window.location.origin}/map?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.show({ kind: 'info', title: 'URL de la vue copiee', message: url, duration: 4000 });
    } catch {
      this.toast.show({ kind: 'warning', title: url, duration: 6000 });
    }
  }

  private restoreFromUrl(): void {
    if (!this.map) return;
    const params = this.route.snapshot.queryParamMap;
    const lat = parseFloat(params.get('lat') ?? '');
    const lng = parseFloat(params.get('lng') ?? '');
    const zoom = parseFloat(params.get('zoom') ?? '');
    const bearing = parseFloat(params.get('bearing') ?? '');
    const pitch = parseFloat(params.get('pitch') ?? '');
    const style = params.get('style') as MapStyleId | null;

    if (style && this.styles.byId(style).id === style) {
      this.currentStyle.set(style);
      // Note : pas de re-setStyle car le map est deja initialise avec un style.
      // Le partage URL fonctionne mieux a partir du second load. V1.5 polish.
    }
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      this.map.jumpTo({
        center: [lng, lat],
        zoom: Number.isFinite(zoom) ? zoom : this.map.getZoom(),
        bearing: Number.isFinite(bearing) ? bearing : 0,
        pitch: Number.isFinite(pitch) ? pitch : 0,
      });
      this.hasFittedBounds = true;
    }
  }

  /** Sprint E.1 — mode Cinema : cycle 8s sur les vehicules. */
  protected toggleCinema(): void {
    if (this.cinemaMode()) {
      this.cinemaMode.set(false);
      if (this.cinemaIntervalId) clearInterval(this.cinemaIntervalId);
      this.cinemaIntervalId = null;
      return;
    }
    this.cinemaMode.set(true);
    this.cinemaIndex = 0;
    this.cinemaTick();
    this.cinemaIntervalId = setInterval(() => this.cinemaTick(), 8000);
  }

  private cinemaTick(): void {
    if (!this.map) return;
    const list = this.cinemaCandidates();
    if (list.length === 0) {
      // Tant qu'on n'a RIEN reçu (hydratation en cours, reconnexion WS), une liste vide ne
      // prouve pas que le parc est muet : on garde le mode armé et le prochain tick (8 s)
      // réessaiera. Sans ça, activer le cinéma juste après l'ouverture de la carte le tuait
      // aussitôt en accusant à tort les boîtiers.
      if (!this.realtime.hydrated()) { this.cinemaIndex = 0; return; }
      // Plus AUCUN véhicule à montrer (parc entièrement muet, ou tout masqué par les
      // calques) : on arrête le cinéma au lieu de tourner à vide toutes les 8 s sur une
      // carte immobile — et on dit pourquoi.
      this.cinemaIndex = 0;
      this.cinemaMode.set(false);
      if (this.cinemaIntervalId) clearInterval(this.cinemaIntervalId);
      this.cinemaIntervalId = null;
      this.toast.show({
        kind: 'info',
        title: 'Cinéma arrêté',
        message: 'Aucun véhicule à parcourir : rien ne communique (ou tout est masqué par les calques).',
        duration: 5000,
        dedupeKey: 'map-cinema-empty',
      });
      return;
    }
    const target = list[this.cinemaIndex % list.length]!;
    this.cinemaIndex++;
    this.followedVehicleId.set(target.vehicleId);
    this.map.flyTo({ center: [target.lng, target.lat], zoom: 16, duration: 1500 });
  }

  /**
   * Véhicules éligibles au mode cinéma. Corrige le bug « le cinéma jouait sur des véhicules
   * ÉTEINTS hors filtre » : on part de la MÊME liste que les marqueurs (périmètre d'accès +
   * filtres Calques actifs via `applyFilters`), puis on restreint aux véhicules EN MOUVEMENT
   * (intention d'origine du mode cinéma). Si aucun ne roule, on retombe sur la liste filtrée
   * pour que le cinéma reste utile (sinon écran figé), tout en respectant le filtre.
   */
  private cinemaCandidates(): PositionUpdateEvent[] {
    const all = this.realtime.positionsList();
    const ids = this._accessibleIds();
    const scoped = ids === 'ALL' ? all : all.filter((p) => (ids as Set<string>).has(p.vehicleId));
    const filtered = this.applyFilters(scoped);
    const now = Date.now();
    const lastSeen = this.lastSeenByTrackerId();
    // Fraîcheur lue sur `lastSeenAt` (horloge SERVEUR) et non sur `p.timestamp`
    // (horloge du boîtier, qui dérive) : « en mouvement » exige une trame de moins de
    // 5 min, un véhicule qui roule émettant toutes les ~30 s.
    const freshOf = (p: PositionUpdateEvent) => lastSeen.get(p.trackerId) ?? p.timestamp;
    const moving = filtered.filter(
      (p) => isTrackerOnline(freshOf(p), now, MOVING_FRESHNESS_MS) && p.ignition && p.speedKmh > 5,
    );
    if (moving.length) return moving;
    // Repli quand personne ne roule : on parcourt le parc EXPLOITÉ, jamais les muets.
    // Un carrousel qui s'arrête 8 s sur un véhicule figé depuis 89 jours laisse croire
    // à un plantage de la carte. Seuil de COMPTAGE (7 j) : c'est un vivier, pas une
    // commande. Si tout le parc est muet, on renvoie une liste vide et `cinemaTick`
    // arrête le mode en l'expliquant plutôt que de tourner dans le vide.
    return filtered.filter(
      (p) => !isVehicleDormant({ trackerId: p.trackerId, lastSeenAt: lastSeen.get(p.trackerId) }, now, DORMANT_STOP_COUNTING_MS),
    );
  }

  protected setCameraMode(mode: CameraMode): void {
    // Mode "Libre" = explore libre, pas de suivi, pitch/bearing reset
    if (mode === 'free') {
      this.cameraMode.set('free');
      this.followedVehicleId.set(null);
      this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: 'free' } });
      this.map?.easeTo({ pitch: 0, bearing: 0, duration: 400 });
      return;
    }

    // Mode "3D" = pitch 60° libre (pas de suivi de vehicule)
    if (mode === 'chase') {
      this.cameraMode.set('chase');
      this.followedVehicleId.set(null);
      this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: 'chase' } });
      this.map?.easeTo({ pitch: 60, duration: 600 });
      return;
    }

    // Mode "Suivre" ou "Sens" = exigent un vehicule.
    // Si aucun vehicule sélectionné, on ouvre le picker plutôt que d'auto-pick.
    if (mode === 'follow' || mode === 'heading-up') {
      const targetId = this.followedVehicleId();
      if (!targetId) {
        // Pas de véhicule choisi → on ouvre le picker dans la sheet
        this.pendingCameraMode.set(mode);
        this.vehiclePickerOpen.set(true);
        // Garder visuellement le mode "Libre" actif tant que rien n'est sélectionné
        return;
      }
      this.cameraMode.set(mode);
      this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: mode } });
      this.map?.easeTo({ pitch: 0, duration: 400 });
      this.applyCameraMode();
    }
  }

  /** Sélection d'un véhicule depuis le picker (pour Suivre/Sens). */
  protected pickVehicleForCamera(vehicleId: string): void {
    const picked = this.cameraPickerVehicles().find((v) => v.vehicleId === vehicleId);
    // ⚠️ Capturer le mode demandé AVANT de vider le signal : sinon « Sens » (heading-up)
    // retomberait silencieusement sur « Suivre ».
    const targetMode = this.pendingCameraMode() ?? 'follow';
    this.vehiclePickerOpen.set(false);
    this.pendingCameraMode.set(null);
    // Mobile : on ferme la sheet pour que l'utilisateur voit la carte
    if (window.matchMedia('(max-width: 767px)').matches) {
      this.mobileSheetOpen.set(false);
    }

    if (picked?.dormant) {
      // Muet depuis > 72 h : on l'emmène quand même à sa dernière position connue
      // (voir où le boîtier s'est arrêté est une demande légitime), mais on n'ARME PAS
      // le suivi. Verrouiller la caméra sur un point qui ne bougera plus afficherait
      // « Suivi : FV-941-LZ » sur une carte définitivement immobile, et l'exploitant
      // conclurait à un bug de la carte plutôt qu'à un boîtier muet. On le dit.
      //
      // ⚠️ Ne PAS se contenter de « ne pas armer » : le mode caméra courant peut DÉJÀ
      // être verrouillant. Le picker s'ouvre depuis `setCameraMode('follow'|'heading-up')`
      // SANS toucher `cameraMode`, et `cameraMode` est restauré des préférences au
      // démarrage (ngAfterViewInit) — il vaut donc couramment 'follow', 'heading-up' ou
      // 'chase' avec `followedVehicleId` à null. Renseigner `followedVehicleId` suffirait
      // alors à ce que la boucle d'animation ET `applyCameraMode` collent la caméra au
      // véhicule muet, et à ce que le HUD affiche « Suivi : … » : exactement ce que le
      // toast ci-dessous prétend ne PAS faire. On désarme donc explicitement.
      this.cameraMode.set('free');
      this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: 'free' } });
      // On garde le véhicule « actif » (marqueur mis en avant, on vient d'y voler) : en
      // caméra libre cela n'accroche rien et le HUD n'annonce aucun suivi.
      this.followedVehicleId.set(vehicleId);
      const moved = this.flyToVehicleLastKnown(vehicleId);
      this.toast.show({
        kind: 'warning',
        title: `${picked.plate} est muet depuis ${picked.silenceLabel ?? 'longtemps'}`,
        message: moved
          ? 'Dernière position connue affichée. Suivi caméra non activé : ce véhicule n\'émet plus.'
          : 'Aucune position connue pour ce véhicule. Suivi caméra non activé.',
        duration: 6000,
        dedupeKey: `map-follow-dormant-${vehicleId}`,
      });
      return;
    }

    this.followedVehicleId.set(vehicleId);
    this.cameraMode.set(targetMode);
    this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: targetMode } });
    this.applyCameraMode();
  }

  /**
   * Centre sur la dernière position connue d'un véhicule, sans rien verrouiller.
   * Renvoie false si on ne sait pas où il est — l'appelant doit alors le DIRE plutôt
   * que de laisser la carte immobile sans raison affichée.
   */
  private flyToVehicleLastKnown(vehicleId: string, zoom = 15): boolean {
    if (!this.map) return false;
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === vehicleId);
    if (!pos) return false;
    this.map.flyTo({ center: [pos.lng, pos.lat], zoom, duration: 800 });
    return true;
  }

  protected cancelVehiclePicker(): void {
    this.vehiclePickerOpen.set(false);
    this.pendingCameraMode.set(null);
  }

  /** Drag-to-dismiss : début du touch sur le handle. */
  protected onSheetTouchStart(e: TouchEvent): void {
    this.sheetTouchStartY = e.touches[0]?.clientY ?? 0;
    this.sheetDragY.set(0);
  }

  /** Drag-to-dismiss : suivi du déplacement. */
  protected onSheetTouchMove(e: TouchEvent): void {
    const y = e.touches[0]?.clientY ?? 0;
    const delta = Math.max(0, y - this.sheetTouchStartY);
    this.sheetDragY.set(delta);
  }

  /** Drag-to-dismiss : si tiré > 80px vers le bas, fermer. */
  protected onSheetTouchEnd(): void {
    if (this.sheetDragY() > 80) {
      this.mobileSheetOpen.set(false);
    }
    this.sheetDragY.set(0);
  }

  /** Applique le mode camera courant : si follow/heading-up, focus sur le suivi. */
  private applyCameraMode(): void {
    const mode = this.cameraMode();
    if (mode === 'free' || mode === 'chase' || !this.map) return;

    const id = this.followedVehicleId();
    if (!id) return;
    const positions = this.realtime.positionsList();
    const pos = positions.find((p) => p.vehicleId === id);
    if (!pos) {
      // ⚠️ « Je n'ai pas la position » ≠ « il n'y en a pas ». Cette méthode est appelée à
      // CHAQUE rendu de marqueurs : pendant l'hydratation, ou après une déconnexion WS qui
      // vide les positions, la liste est momentanément vide pour TOUT LE MONDE. Dégrader là
      // aurait affiché « Position inconnue » et réécrit en dur la préférence caméra de
      // l'utilisateur sur un simple aléa réseau. On ne conclut que sur des données reçues.
      if (!this.realtime.hydrated() || positions.length === 0) return;
      // Aucune position connue (véhicule sans boîtier type TEST-xxx, ou boîtier jamais
      // localisé) : on ne peut pas suivre. On repasse en caméra libre et on le DIT —
      // laisser le mode « Suivre » armé sur un véhicule introuvable donnait une carte
      // qui ne réagit plus, sans le moindre message.
      this.cameraMode.set('free');
      this.followedVehicleId.set(null);
      this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: 'free' } });
      this.toast.show({
        kind: 'warning',
        title: 'Position inconnue',
        message: 'Ce véhicule n\'a aucune position à suivre. Retour en caméra libre.',
        duration: 5000,
        dedupeKey: `map-follow-nopos-${id}`,
      });
      return;
    }

    this.map.easeTo({
      center: [pos.lng, pos.lat],
      zoom: Math.max(this.map.getZoom(), 14),
      bearing: mode === 'heading-up' ? pos.heading : this.map.getBearing(),
      pitch: 0,
      duration: 600,
    });
  }

  protected resetNorth(): void {
    if (!this.map) return;
    this.mapSvc.resetNorth(this.map);
  }

  /* --- Filtres --- */

  protected toggleFilter(key: 'moving' | 'idle' | 'off' | 'offline'): void {
    const cur = this.filters();
    this.filters.set({ ...cur, [key]: !cur[key] });
  }

  private applyFilters(positions: PositionUpdateEvent[]): PositionUpdateEvent[] {
    const f = this.filters();
    const now = Date.now();
    // Filtre société global (sélecteur super-admin). Lecture explicite du signal pour
    // que l'effet de rendu des markers se relance au changement de société (même si la
    // liste est momentanément vide → aucune position ne serait sinon lue).
    this.fleetFilter.selectedFleetId();
    const lastSeen = this.lastSeenByTrackerId();
    return positions
      .filter((p) => this.fleetFilter.matches(p.fleetId))
      .filter((p) => {
        // Hors-ligne = pas de signal frais (seuil online partagé, 15 min) — même
        // définition que la couleur grise du marqueur, pour rester cohérent. Donc
        // même SOURCE aussi : `lastSeenAt` (heure serveur), sinon un boîtier à
        // l'horloge décalée était grisé sur la carte mais compté « en mouvement »
        // par le filtre, et disparaissait quand on décochait « Hors-ligne ».
        if (!isTrackerOnline(lastSeen.get(p.trackerId) ?? p.timestamp, now)) return f.offline;
        if (!p.ignition) return f.off;
        if (p.speedKmh > 5) return f.moving;
        return f.idle;
      });
  }

  protected toggleGeofences(): void {
    const v = !this.showGeofences();
    this.showGeofences.set(v);
    this.setLayerVisibility('geofences-fill', v);
    this.setLayerVisibility('geofences-line', v);
  }

  protected toggleTrails(): void {
    const v = !this.showTrails();
    this.showTrails.set(v);
    this.preferences.update({ map: { ...this.preferences.prefs().map, showTrails: v } });
    this.setLayerVisibility('trails-line', v);
  }

  /** Sprint G.4 — toggle de la heatmap. */
  protected toggleHeatmap(): void {
    const v = !this.showHeatmap();
    this.showHeatmap.set(v);
    this.setLayerVisibility('positions-heatmap', v);
    if (v) this.loadHeatmap().catch(() => { /* silent */ });
  }

  /** Sprint G.4 — charge les positions des 24h pour densite. */
  private async loadHeatmap(): Promise<void> {
    if (!this.map) return;
    const fromIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ids = this._accessibleIds();
    const vehiclesToScan = ids === 'ALL'
      ? Array.from(this.vehicleMeta.keys())
      : Array.from(ids as Set<string>);

    const features: Array<GeoJSON.Feature<GeoJSON.Point>> = [];
    for (const vehicleId of vehiclesToScan) {
      try {
        const res = await firstValueFrom(
          this.http.get<{ items: Array<{ lat: number; lng: number }> }>(
            `/api/positions?vehicleId=${vehicleId}&from=${encodeURIComponent(fromIso)}&limit=500`,
          ),
        );
        for (const p of res.items ?? []) {
          features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} });
        }
      } catch { /* silent per vehicle */ }
    }
    const src = this.map.getSource('positions-heatmap') as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
  }

  /** Sprint G.5 — verrouille / deverrouille le pan de la carte. Zoom + rotation restent libres. */
  protected toggleLock(): void {
    if (!this.map) return;
    const next = !this.mapLocked();
    this.mapLocked.set(next);
    if (next) {
      this.map.dragPan.disable();
    } else {
      this.map.dragPan.enable();
    }
    this.toast.show({
      kind: 'info',
      title: next ? 'Carte verrouillee (pas de drag)' : 'Carte deverrouillee',
      duration: 2500,
    });
  }

  /** Sprint F.1 — toggle l'affichage des arrets > 5min (24h). */
  protected toggleStops(): void {
    const v = !this.showStops();
    this.showStops.set(v);
    this.setLayerVisibility('stops-cluster-bg', v);
    this.setLayerVisibility('stops-cluster-count', v);
    this.setLayerVisibility('stops-point', v);
    if (v) this.loadStops().catch(() => { /* silent */ });
    else this.stopPopup?.remove();
  }

  /**
   * Charge les positions des 24 dernieres heures de tous les vehicules accessibles
   * et detecte les "stop clusters" : groupes de positions consecutives avec
   * speedKmh ~= 0 separees de moins de 50m, durant >= 5min. Place un picto P
   * au centre de chaque cluster.
   */
  private async loadStops(): Promise<void> {
    if (!this.map) return;
    const STOP_MIN_DURATION_MS = 5 * 60 * 1000;
    const STOP_MAX_RADIUS_M = 50;
    const STOP_MAX_SPEED = 2; // km/h — bruit GPS tolere

    const fromIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const features: Array<GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>> = [];

    const ids = this._accessibleIds();
    const vehiclesToScan = ids === 'ALL'
      ? Array.from(this.vehicleMeta.keys())
      : Array.from(ids as Set<string>);

    for (const vehicleId of vehiclesToScan) {
      try {
        const res = await firstValueFrom(
          this.http.get<{ items: Array<{ lat: number; lng: number; speedKmh: number; timestamp: string }> }>(
            `/api/positions?vehicleId=${vehicleId}&from=${encodeURIComponent(fromIso)}&limit=500`,
          ),
        );
        const items = (res.items ?? []).slice().reverse(); // chronologique
        if (items.length < 2) continue;

        let clusterStart: typeof items[0] | null = null;
        let clusterCenterLat = 0, clusterCenterLng = 0, clusterCount = 0;

        for (let i = 0; i < items.length; i++) {
          const p = items[i]!;
          if (p.speedKmh <= STOP_MAX_SPEED) {
            if (!clusterStart) {
              clusterStart = p;
              clusterCenterLat = p.lat;
              clusterCenterLng = p.lng;
              clusterCount = 1;
              continue;
            }
            // Verifier si le point est dans le rayon du cluster
            const d = haversineMeters(clusterCenterLat, clusterCenterLng, p.lat, p.lng);
            if (d > STOP_MAX_RADIUS_M) {
              // Sortie du cluster — verifier sa duree
              this.maybePushStopFeature(features, clusterStart, items[i - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS, vehicleId);
              clusterStart = p;
              clusterCenterLat = p.lat;
              clusterCenterLng = p.lng;
              clusterCount = 1;
            } else {
              // Moyenne mobile pour le centre
              clusterCenterLat = (clusterCenterLat * clusterCount + p.lat) / (clusterCount + 1);
              clusterCenterLng = (clusterCenterLng * clusterCount + p.lng) / (clusterCount + 1);
              clusterCount++;
            }
          } else if (clusterStart) {
            // Mouvement detecte — fermer le cluster precedent
            this.maybePushStopFeature(features, clusterStart, items[i - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS, vehicleId);
            clusterStart = null;
            clusterCount = 0;
          }
        }
        // Cluster final
        if (clusterStart) {
          this.maybePushStopFeature(features, clusterStart, items[items.length - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS, vehicleId);
        }
      } catch { /* silent per vehicle */ }
    }

    const src = this.map.getSource('stops') as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
  }

  private maybePushStopFeature(
    features: Array<GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>>,
    start: { timestamp: string },
    end: { timestamp: string },
    lat: number,
    lng: number,
    minDurationMs: number,
    vehicleId: string,
  ): void {
    const dur = new Date(end.timestamp).getTime() - new Date(start.timestamp).getTime();
    if (dur < minDurationMs) return;
    const minutes = Math.round(dur / 60000);
    const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}min`;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      // vehicleId + plaque portés sur la feature → le clic peut dire QUI s'est arrêté.
      properties: { duration: label, startedAt: start.timestamp, vehicleId, plate: this.vehicleMeta.get(vehicleId)?.plate ?? '' },
    });
  }

  protected togglePlates(): void {
    const v = !this.showPlates();
    this.showPlates.set(v);
    this.preferences.update({ map: { ...this.preferences.prefs().map, showPlates: v } });
    // V1.10 (Sprint 3 perf) — itere sur this.markers (Set en memoire) au lieu
    // de scanner tout le DOM via querySelectorAll.
    for (const { el } of this.markers.values()) {
      el.classList.toggle('tracky-marker--no-plate', !v);
    }
  }

  private setLayerVisibility(layerId: string, visible: boolean): void {
    if (!this.map?.getLayer(layerId)) return;
    this.map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }

  /* --- Sources/layers --- */

  private setupGeofencesLayer(): void {
    if (!this.map || this.map.getSource('geofences')) return;
    this.map.addSource('geofences', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'geofences-fill',
      type: 'fill',
      source: 'geofences',
      paint: { 'fill-color': ['coalesce', ['get', 'color'], '#10e0a0'], 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: 'geofences-line',
      type: 'line',
      source: 'geofences',
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#10e0a0'],
        'line-width': 2,
        'line-opacity': 0.6,
      },
    });
  }

  private setupTrailsLayer(): void {
    if (!this.map || this.map.getSource('trails')) return;
    this.map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'trails-line',
      type: 'line',
      source: 'trails',
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#10e0a0'],
        'line-width': 4,
        'line-opacity': 0.6,
        'line-dasharray': [2, 1.5],
      },
    });
  }

  /** Sprint D.2 — setup layer pour la polyligne historique 1h (couleur bleue distincte du trail live). */
  private setupMiniReplayLayer(): void {
    if (!this.map || this.map.getSource('mini-replay')) return;
    this.map.addSource('mini-replay', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'mini-replay-line',
      type: 'line',
      source: 'mini-replay',
      paint: {
        'line-color': '#3b82f6',
        'line-width': 5,
        'line-opacity': 0.85,
      },
    });
  }

  /**
   * Sprint G.2 — cluster layer pour les markers vehicules.
   * Quand le zoom est < CLUSTER_ZOOM_THRESHOLD, les markers DOM sont caches
   * et un layer GeoJSON cluster prend le relais (badge avec compteur).
   * Au-dela, les markers DOM riches (heading, plaque, ACC) reapparaissent.
   */
  private setupClusterLayer(): void {
    if (!this.map || this.map.getSource('vehicles-cluster')) return;
    // V1.10 (Sprint 3 perf) — cleanup des listeners precedents avant re-setup
    // apres setStyle. Sans ca, chaque setStyle empilait 4 listeners residuels
    // sur des layers detruits (memory + comportement double-trigger occasionnel).
    for (const off of this.clusterListenerCleanups) off();
    this.clusterListenerCleanups = [];

    // Zoom thresholds pour le fade progressif des clusters — alignes avec
    // ZOOM_MINI_ENTER / ZOOM_MINI_EXIT. L'interpolation MapLibre gere le fade
    // en continu pendant le zoom (aucun event JS necessaire), ce qui supprime
    // l'effet "bloque" des clusters a faible zoom.
    const zFadeStart = MapComponent.ZOOM_MINI_ENTER;  // 9.5
    const zFadeEnd   = MapComponent.ZOOM_MINI_EXIT;   // 10.5

    this.map.addSource('vehicles-cluster', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterMaxZoom: 11,
      clusterRadius: 40,
    });
    this.map.addLayer({
      id: 'vehicles-cluster-bg',
      type: 'circle',
      source: 'vehicles-cluster',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#10E0A0',
        'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 50, 28],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], zFadeStart, 0.9, zFadeEnd, 0],
        'circle-stroke-width': 3,
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], zFadeStart, 1, zFadeEnd, 0],
      },
    });
    this.map.addLayer({
      id: 'vehicles-cluster-count',
      type: 'symbol',
      source: 'vehicles-cluster',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 13,
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': '#0a0a0a',
        'text-opacity': ['interpolate', ['linear'], ['zoom'], zFadeStart, 1, zFadeEnd, 0],
      },
    });
    // Layer pour les points individuels (non regroupes en cluster) — visible a faible zoom.
    this.map.addLayer({
      id: 'vehicles-unclustered',
      type: 'circle',
      source: 'vehicles-cluster',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#10E0A0',
        'circle-radius': 7,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], zFadeStart, 0.95, zFadeEnd, 0],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], zFadeStart, 1, zFadeEnd, 0],
      },
    });
    // V1.10 (Sprint 3 perf) — chaque listener est stocke avec son cleanup,
    // pour pouvoir les .off() avant le prochain setupClusterLayer (post-setStyle)
    // ou au ngOnDestroy.
    const clickClusterBg = (e: maplibregl.MapMouseEvent & maplibregl.MapLayerEventType['click']) => {
      if (!this.map) return;
      const feat = e.features?.[0];
      const clusterId = feat?.properties?.['cluster_id'];
      if (clusterId == null) return;
      // Clic canvas (pas un élément DOM) → trace explicite, sinon invisible sur tactile.
      this.activityTracker.trackClick('Carte · zoom cluster');
      const src = this.map.getSource('vehicles-cluster') as maplibregl.GeoJSONSource;
      Promise.resolve(src.getClusterExpansionZoom(clusterId)).then((zoom: number) => {
        if (!this.map) return;
        const geom = feat?.geometry as GeoJSON.Point | undefined;
        if (!geom) return;
        this.map.flyTo({ center: geom.coordinates as [number, number], zoom, speed: 1.4, curve: 1.4 });
      });
    };
    this.map.on('click', 'vehicles-cluster-bg', clickClusterBg);
    this.clusterListenerCleanups.push(() => this.map?.off('click', 'vehicles-cluster-bg', clickClusterBg));

    const clickUnclustered = (e: maplibregl.MapMouseEvent & maplibregl.MapLayerEventType['click']) => {
      if (!this.map) return;
      const feat = e.features?.[0];
      const geom = feat?.geometry as GeoJSON.Point | undefined;
      if (!geom) return;
      const plate = this.vehicleMeta.get(feat?.properties?.['vehicleId'] as string)?.plate;
      this.activityTracker.trackClick(`Carte · centrage véhicule${plate ? ` ${plate}` : ''}`);
      this.map.flyTo({ center: geom.coordinates as [number, number], zoom: 15, speed: 1.4, curve: 1.4 });
    };
    this.map.on('click', 'vehicles-unclustered', clickUnclustered);
    this.clusterListenerCleanups.push(() => this.map?.off('click', 'vehicles-unclustered', clickUnclustered));

    // Curseur pointer sur les points individuels et clusters.
    for (const layer of ['vehicles-cluster-bg', 'vehicles-unclustered']) {
      const onEnter = () => { if (this.map) this.map.getCanvas().style.cursor = 'pointer'; };
      const onLeave = () => { if (this.map) this.map.getCanvas().style.cursor = ''; };
      this.map.on('mouseenter', layer, onEnter);
      this.map.on('mouseleave', layer, onLeave);
      this.clusterListenerCleanups.push(() => this.map?.off('mouseenter', layer, onEnter));
      this.clusterListenerCleanups.push(() => this.map?.off('mouseleave', layer, onLeave));
    }
  }

  /** Sprint G.4 — setup layer heatmap des densites de positions sur 24h. */
  private setupHeatmapLayer(): void {
    if (!this.map || this.map.getSource('positions-heatmap')) return;
    this.map.addSource('positions-heatmap', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'positions-heatmap',
      type: 'heatmap',
      source: 'positions-heatmap',
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 14, 1.6],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)',
          0.2, '#10E0A0',
          0.5, '#F59E0B',
          0.8, '#EF4444',
        ],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 14, 30],
        'heatmap-opacity': 0.7,
      },
    });
  }

  /**
   * Sprint F.1 (refonte 2026-07) — calque des arrêts > 5min (24h). REGROUPÉS (clustering, comme
   * les véhicules) pour ne plus surcharger la carte, PETITS points (comme les stations), et CLIC →
   * quel véhicule + durée. L'ancien style (gros pictos « P » qui se chevauchaient) est remplacé.
   */
  private setupStopsLayer(): void {
    if (!this.map || this.map.getSource('stops')) return;
    for (const off of this.stopsListenerCleanups) off();
    this.stopsListenerCleanups = [];
    const vis: 'visible' | 'none' = this.showStops() ? 'visible' : 'none';
    this.map.addSource('stops', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterMaxZoom: 13,
      clusterRadius: 45,
    });
    // Amas d'arrêts (regroupés) — pastille ambre dont la taille croît avec le nombre.
    this.map.addLayer({
      id: 'stops-cluster-bg',
      type: 'circle',
      source: 'stops',
      filter: ['has', 'point_count'],
      layout: { visibility: vis },
      paint: {
        'circle-color': '#f59e0b',
        'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
        'circle-opacity': 0.85,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#78350f',
      },
    });
    this.map.addLayer({
      id: 'stops-cluster-count',
      type: 'symbol',
      source: 'stops',
      filter: ['has', 'point_count'],
      layout: { visibility: vis, 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' },
    });
    // Arrêt unique : petit point (comme les stations), sans label permanent (déclutter).
    this.map.addLayer({
      id: 'stops-point',
      type: 'circle',
      source: 'stops',
      filter: ['!', ['has', 'point_count']],
      layout: { visibility: vis },
      paint: {
        'circle-radius': 6,
        'circle-color': '#f59e0b',
        'circle-opacity': 0.9,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
      },
    });
    // Clic amas → zoom d'expansion (comme le cluster véhicules).
    const onClusterClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (!this.map) return;
      const feat = e.features?.[0];
      const clusterId = feat?.properties?.['cluster_id'];
      if (clusterId == null) return;
      const src = this.map.getSource('stops') as maplibregl.GeoJSONSource;
      Promise.resolve(src.getClusterExpansionZoom(clusterId)).then((zoom: number) => {
        if (!this.map) return;
        const geom = feat?.geometry as GeoJSON.Point | undefined;
        if (!geom) return;
        this.map.flyTo({ center: geom.coordinates as [number, number], zoom, speed: 1.4, curve: 1.4 });
      });
    };
    this.map.on('click', 'stops-cluster-bg', onClusterClick);
    this.stopsListenerCleanups.push(() => this.map?.off('click', 'stops-cluster-bg', onClusterClick));
    // Clic arrêt unique → popup (quel véhicule + durée).
    const onStop = (e: maplibregl.MapLayerMouseEvent) => this.onStopClick(e);
    this.map.on('click', 'stops-point', onStop);
    this.stopsListenerCleanups.push(() => this.map?.off('click', 'stops-point', onStop));
    for (const layer of ['stops-cluster-bg', 'stops-point']) {
      const onEnter = () => { if (this.map) this.map.getCanvas().style.cursor = 'pointer'; };
      const onLeave = () => { if (this.map) this.map.getCanvas().style.cursor = ''; };
      this.map.on('mouseenter', layer, onEnter);
      this.map.on('mouseleave', layer, onLeave);
      this.stopsListenerCleanups.push(() => this.map?.off('mouseenter', layer, onEnter));
      this.stopsListenerCleanups.push(() => this.map?.off('mouseleave', layer, onLeave));
    }
  }

  /** Popup d'un arrêt au clic : quel véhicule + durée + heure de début. */
  private onStopClick(e: maplibregl.MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f || !this.map) return;
    const p = f.properties ?? {};
    const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    const startedAt = p['startedAt'] ? new Date(String(p['startedAt'])) : null;
    const when = startedAt ? `${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}` : '';
    const html = `<div style="font-size:12px;line-height:1.55;min-width:150px">`
      + `<strong style="font-size:13px">${esc(p['plate']) || 'Véhicule'}</strong><br>`
      + `Arrêt de <b>${esc(p['duration'])}</b>${when ? ` · depuis ${when}` : ''}`
      + `</div>`;
    this.stopPopup?.remove();
    this.stopPopup = new maplibregl.Popup({ closeButton: true, offset: 12 }).setLngLat(coords).setHTML(html).addTo(this.map);
  }

  /**
   * Carburant — calque STATIONS-SERVICE fréquentées par la flotte. Cercle violet dont la TAILLE croît
   * avec la fréquence (nb de passages, affiché au centre) + CONTOUR ambre si récemment utilisée. Miroir
   * de setupStopsLayer (source/layers dédiés → zéro conflit avec les markers véhicule).
   */
  private setupFuelStationsLayer(): void {
    if (!this.map || this.map.getSource('fuel-stations')) return;
    this.map.addSource('fuel-stations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'fuel-stations-circle',
      type: 'circle',
      source: 'fuel-stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'visits'], 1, 9, 5, 15, 15, 22],
        'circle-color': '#A78BFA',
        'circle-opacity': 0.85,
        'circle-stroke-width': ['case', ['==', ['get', 'recent'], 1], 3, 1.5],
        'circle-stroke-color': ['case', ['==', ['get', 'recent'], 1], '#F59E0B', '#ffffff'],
      },
    });
    this.map.addLayer({
      id: 'fuel-stations-count',
      type: 'symbol',
      source: 'fuel-stations',
      layout: {
        'text-field': ['to-string', ['get', 'visits']],
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#6D28D9', 'text-halo-width': 1.2 },
    });
    // Clic → popup. Une seule liaison active : on retire l'ancienne avant de relier (le setup re-tourne
    // au changement de fond de carte). Les handlers de curseur ne sont liés qu'une fois.
    if (this.fuelClickHandler) this.map.off('click', 'fuel-stations-circle', this.fuelClickHandler);
    this.fuelClickHandler = (e) => this.onFuelStationClick(e);
    this.map.on('click', 'fuel-stations-circle', this.fuelClickHandler);
    if (!this.fuelCursorBound) {
      this.map.on('mouseenter', 'fuel-stations-circle', () => { if (this.map) this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', 'fuel-stations-circle', () => { if (this.map) this.map.getCanvas().style.cursor = ''; });
      this.fuelCursorBound = true;
    }
  }

  /** Charge les stations fréquentées (90 j) et alimente le calque. Best-effort (silencieux). */
  private async loadFuelStations(): Promise<void> {
    if (!this.map) return;
    try {
      const from = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const stations = await firstValueFrom(
        this.tripAnalysisApi.fuelStationsMap(from, undefined, this.fleetFilter.selectedFleetId() ?? undefined),
      );
      const now = Date.now();
      const RECENT_MS = 21 * 24 * 3600 * 1000;
      // Détail par véhicule (qui + combien de passages) indexé par stationId pour le popup :
      // les propriétés GeoJSON sont aplaties en primitives, on ne peut pas y stocker un tableau.
      this.fuelStationVehicles.clear();
      const features: GeoJSON.Feature[] = stations.map((s) => {
        this.fuelStationVehicles.set(s.stationId, s.vehicles ?? []);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: {
            stationId: s.stationId,
            brand: s.brand ?? '', city: s.city ?? '', address: s.address ?? '',
            visits: s.visits, distinctVehicles: s.distinctVehicles,
            lastPriceEur: s.lastPriceEur, lastVisitAt: s.lastVisitAt,
            recent: now - new Date(s.lastVisitAt).getTime() <= RECENT_MS ? 1 : 0,
          },
        };
      });
      const src = this.map.getSource('fuel-stations') as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features });
    } catch { /* silent */ }
  }

  /** Toggle du calque stations-service (charge à la 1re activation). */
  protected toggleFuelStations(): void {
    const v = !this.showFuelStations();
    this.showFuelStations.set(v);
    this.setLayerVisibility('fuel-stations-circle', v);
    this.setLayerVisibility('fuel-stations-count', v);
    if (v) this.loadFuelStations().catch(() => { /* silent */ });
    else if (this.placeCard()?.type === 'station') this.closePlaceCard();
  }

  /**
   * Clic sur une station DÉTECTÉE → ouvre la card carte stylée (détail par véhicule + action
   * « Ajouter aux lieux » si `places_manage`). Remplace l'ancien popup HTML brut, illisible et
   * incohérent avec le reste de l'app.
   */
  private onFuelStationClick(e: maplibregl.MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f || !this.map) return;
    const p = f.properties ?? {};
    const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    const stationId = String(p['stationId'] ?? '');
    // Une seule card à la fois : ouvrir un repère ferme la card véhicule.
    this.closeBaanoolCard();
    this.placeCard.set({
      type: 'station',
      stationId,
      title: String(p['brand'] ?? '') || 'Station-service',
      where: [p['address'], p['city']].filter(Boolean).map(String).join(', '),
      visits: Number(p['visits'] ?? 0),
      distinctVehicles: Number(p['distinctVehicles'] ?? 0),
      lastPriceEur: p['lastPriceEur'] != null && p['lastPriceEur'] !== '' ? Number(p['lastPriceEur']) : null,
      lastVisitAt: p['lastVisitAt'] ? String(p['lastVisitAt']) : null,
      lng: coords[0],
      lat: coords[1],
      vehicles: this.fuelStationVehicles.get(stationId) ?? [],
    });
  }

  /**
   * Zones mortes GPS (suivi FS-253) — parkings souterrains confirmés (bleu « P »), zones récurrentes
   * (ambre « P ») et suspectes/brouilleur (rouge « ! »).
   *
   * Rendus en MARQUEURS HTML (et NON en calque canvas) VOLONTAIREMENT : un calque MapLibre est dessiné
   * DANS le canvas, donc TOUJOURS sous les marqueurs véhicule (qui sont du DOM) — la voiture masquait
   * le parking et on ne comprenait pas qu'elle était DEDANS. En HTML on maîtrise le z-index : le pin
   * parking passe DEVANT le véhicule. Bonus : les marqueurs DOM survivent au changement de fond de carte.
   */
  private renderDeadZoneMarkers(): void {
    if (!this.map) return;
    const zones = this.showDeadZones() ? this.deadZonesData() : [];
    const seen = new Set<string>();
    for (const z of zones) {
      if (!Number.isFinite(z.centroidLat) || !Number.isFinite(z.centroidLng)) continue;
      seen.add(z.id);
      const existing = this.deadZoneMarkers.get(z.id);
      if (existing) {
        existing.setLngLat([z.centroidLng, z.centroidLat]);
        continue;
      }
      const marker = new maplibregl.Marker({ element: this.buildDeadZoneEl(z), anchor: 'center' })
        .setLngLat([z.centroidLng, z.centroidLat])
        .addTo(this.map);
      this.deadZoneMarkers.set(z.id, marker);
    }
    // Retire les pins dont la zone a disparu (ou quand le calque est masqué).
    for (const [id, marker] of this.deadZoneMarkers) {
      if (!seen.has(id)) {
        marker.remove();
        this.deadZoneMarkers.delete(id);
      }
    }
  }

  /** Élément DOM d'un pin de zone morte. z-index élevé → passe DEVANT le marqueur véhicule. */
  private buildDeadZoneEl(z: GpsDeadZoneMapDto): HTMLElement {
    const suspect = z.status === 'SUSPECT';
    const confirmed = z.status === 'CONFIRMED_BENIGN';
    const color = suspect ? '#ef4444' : confirmed ? '#0ea5e9' : '#f59e0b';
    const el = document.createElement('div');
    el.className = 'tracky-deadzone-marker';
    el.style.cssText =
      `z-index:900;width:26px;height:26px;border-radius:50%;background:${color};` +
      'border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;' +
      'justify-content:center;color:#fff;font-weight:800;font-size:13px;line-height:1;cursor:pointer';
    el.textContent = suspect ? '!' : 'P';
    el.setAttribute('aria-label', suspect ? 'Zone GPS suspecte' : 'Parking souterrain');
    el.title = `${z.plate ?? 'Véhicule'} — ${deadZoneNatureLabel(z)}`;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.openDeadZonePopup(z);
    });
    return el;
  }

  /** Charge les zones mortes de la flotte accessible (best-effort) : alimente le signal ET les pins. */
  private async loadDeadZones(): Promise<void> {
    if (!this.map) return;
    try {
      const zones = await firstValueFrom(this.deadZonesApi.listForMap(this.fleetFilter.selectedFleetId() ?? undefined));
      this.deadZonesData.set(zones);
      this.renderDeadZoneMarkers();
    } catch {
      /* best-effort : la carte reste fonctionnelle sans les pins parkings */
    }
  }

  /** Toggle des pins parkings souterrains / zones mortes. */
  protected toggleDeadZones(): void {
    const v = !this.showDeadZones();
    this.showDeadZones.set(v);
    this.renderDeadZoneMarkers();
    if (!v) this.deadZonePopup?.remove();
  }

  /** Popup d'une zone morte au clic (véhicule, nature, fréquence). */
  private openDeadZonePopup(z: GpsDeadZoneMapDto): void {
    if (!this.map) return;
    const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    const statusLabel = z.status === 'CONFIRMED_BENIGN'
      ? '🅿️ Parking souterrain confirmé'
      : z.status === 'SUSPECT'
        ? '⚠️ Zone suspecte (brouilleur ?)'
        : 'Perte GPS récurrente';
    const html = `<div style="font-size:12px;line-height:1.55;min-width:180px">`
      + `<strong style="font-size:13px">${esc(z.plate) || 'Véhicule'}</strong><br>`
      + (z.placeLabel ? `<span style="color:#9ca3af">${esc(z.placeLabel)}</span><br>` : '')
      + `<b>${esc(statusLabel)}</b><br>`
      + `${esc(deadZoneNatureLabel(z))} · perte GPS ${esc(z.occurrences)} fois ici`
      + `</div>`;
    this.deadZonePopup?.remove();
    this.deadZonePopup = new maplibregl.Popup({ closeButton: true, offset: 16 })
      .setLngLat([z.centroidLng, z.centroidLat])
      .setHTML(html)
      .addTo(this.map);
  }

  /**
   * Lieux clés (2026-07) — lieux VALIDÉS/CRÉÉS par la flotte : stations retenues (émeraude ⛽),
   * parkings & stationnements récurrents posés à la main (bleu « P »), dépôts (ambre « D »).
   * Distincts des stations simplement DÉTECTÉES (violet, calque `fuel-stations`) : c'est
   * exactement la différence de couleur « nouvelle station vs station validée » demandée.
   * Marqueurs HTML → passent devant les véhicules.
   */
  private async loadFleetPlaces(): Promise<void> {
    // Sans `places_view` : aucun appel réseau (l'API répondrait 403 de toute façon) et aucun repère.
    if (!this.map || !this.canViewPlaces()) return;
    try {
      const fleetId = this.fleetFilter.selectedFleetId() ?? undefined;
      const [places, ai] = await Promise.all([
        firstValueFrom(this.fleetPlacesApi.list(fleetId)),
        // Statut IA : fail-CLOSED, son échec n'empêche jamais l'affichage des lieux.
        firstValueFrom(this.fleetPlacesApi.aiStatus(fleetId)).catch(() => ({ enabled: false })),
      ]);
      this.fleetPlaces.set(places);
      this.placesAiEnabled.set(ai.enabled);
      this.renderFleetPlaceMarkers();
    } catch {
      /* best-effort : la carte reste utilisable sans les lieux de la flotte */
    }
  }

  private renderFleetPlaceMarkers(): void {
    if (!this.map) return;
    // Le droit de lecture prime sur le toggle : sans `places_view`, on ne dessine jamais de lieu.
    const places = this.canViewPlaces() && this.showFleetPlaces() ? this.fleetPlaces() : [];
    const seen = new Set<string>();
    for (const p of places) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      seen.add(p.id);
      const existing = this.fleetPlaceMarkers.get(p.id);
      if (existing) {
        existing.setLngLat([p.lng, p.lat]);
        continue;
      }
      // Glisser-déposer réservé à `places_manage` : on déplace le pin et on persiste au drop.
      const draggable = this.canManagePlaces();
      const marker = new maplibregl.Marker({ element: this.buildFleetPlaceEl(p), anchor: 'center', draggable })
        .setLngLat([p.lng, p.lat])
        .addTo(this.map);
      if (draggable) {
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          void this.persistPlaceMove(p.id, ll.lat, ll.lng);
        });
      }
      this.fleetPlaceMarkers.set(p.id, marker);
    }
    for (const [id, marker] of this.fleetPlaceMarkers) {
      if (!seen.has(id)) {
        marker.remove();
        this.fleetPlaceMarkers.delete(id);
      }
    }
  }

  /** Élément DOM d'un lieu de la flotte (couleur + glyphe par nature). */
  private buildFleetPlaceEl(p: FleetPlaceDto): HTMLElement {
    const { color, glyph } = fleetPlaceStyle(p.kind);
    const el = document.createElement('div');
    el.className = 'tracky-place-marker';
    el.style.cssText =
      `z-index:880;width:26px;height:26px;border-radius:8px;background:${color};` +
      'border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;' +
      'justify-content:center;color:#fff;font-weight:800;font-size:12px;line-height:1;cursor:pointer';
    el.textContent = glyph;
    el.setAttribute('aria-label', p.name);
    el.title = this.canManagePlaces() ? `${p.name} — glissez pour déplacer` : p.name;
    if (this.canManagePlaces()) el.style.cursor = 'grab';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.openPlaceCard(p);
    });
    return el;
  }

  /** Clic sur un lieu de la flotte → ouvre la card (renommage inline, retrait, déplacement). */
  private openPlaceCard(p: FleetPlaceDto): void {
    this.closeBaanoolCard();
    this.renamingPlaceId.set(null);
    this.placeCard.set({ type: 'place', place: p });
  }

  /** Ferme la card repère. */
  protected closePlaceCard(): void {
    this.placeCard.set(null);
    this.renamingPlaceId.set(null);
  }

  /**
   * Connexion card ↔ page : ouvre « Lieux clés » depuis la carte. Avec un `placeId`, la page
   * s'ouvre DÉPLIÉE sur ce lieu (infos + fiche IA) — sinon l'utilisateur devrait le retrouver
   * lui-même dans la liste.
   */
  protected goToPlaces(placeId?: string): void {
    void this.router.navigate(['/places'], placeId ? { queryParams: { place: placeId } } : undefined);
  }

  /** Libellé lisible de la nature d'un lieu. */
  protected placeKindLabel(kind: FleetPlaceKind): string {
    switch (kind) {
      case 'FUEL_STATION': return 'Station-service de la flotte';
      case 'PARKING': return 'Parking / stationnement';
      case 'DEPOT': return 'Dépôt / base';
      default: return 'Lieu';
    }
  }

  /** Valide la station de la card → elle devient un lieu de la flotte (couleur dédiée). */
  protected async validateStationFromCard(): Promise<void> {
    const c = this.placeCard();
    if (!c || c.type !== 'station' || this.placeCardSaving() || !this.canManagePlaces()) return;
    this.placeCardSaving.set(true);
    try {
      // Nom lisible : marque + ville quand on l'a (« TotalEnergies — Toulouse »).
      const city = c.where ? c.where.split(',').pop()?.trim() : '';
      const created = await firstValueFrom(
        this.fleetPlacesApi.create({
          name: [c.title, city].filter(Boolean).join(' — ').slice(0, 120),
          kind: 'FUEL_STATION',
          lat: c.lat,
          lng: c.lng,
          stationId: c.stationId,
          fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
        }),
      );
      this.fleetPlaces.update((list) => [...list, created]);
      this.renderFleetPlaceMarkers();
      this.toast.success('Station ajoutée aux lieux de la flotte', created.name);
    } catch {
      this.toast.error("Impossible d'ajouter cette station");
    } finally {
      this.placeCardSaving.set(false);
    }
  }

  /** Démarre le renommage inline du lieu affiché. */
  protected startRenamePlace(): void {
    const c = this.placeCard();
    if (!c || c.type !== 'place' || !this.canManagePlaces()) return;
    this.renameValue = c.place.name;
    this.renamingPlaceId.set(c.place.id);
  }

  protected cancelRenamePlace(): void {
    this.renamingPlaceId.set(null);
    this.renameValue = '';
  }

  /** Enregistre le nouveau nom (renommage inline depuis la card). */
  protected async confirmRenamePlace(): Promise<void> {
    const c = this.placeCard();
    const name = this.renameValue.trim();
    if (!c || c.type !== 'place' || !name || this.placeCardSaving()) return;
    if (name === c.place.name) { this.cancelRenamePlace(); return; }
    this.placeCardSaving.set(true);
    try {
      const updated = await firstValueFrom(this.fleetPlacesApi.update(c.place.id, { name }));
      this.applyPlaceUpdate(updated, { recreateMarker: true });
      this.cancelRenamePlace();
      this.toast.success('Lieu renommé', updated.name);
    } catch {
      this.toast.error('Renommage impossible');
    } finally {
      this.placeCardSaving.set(false);
    }
  }

  /** Retire le lieu affiché (dévalide une station, ou efface un parking). */
  protected async deletePlaceFromCard(): Promise<void> {
    const c = this.placeCard();
    if (!c || c.type !== 'place' || this.placeCardSaving() || !this.canManagePlaces()) return;
    this.placeCardSaving.set(true);
    try {
      await firstValueFrom(this.fleetPlacesApi.remove(c.place.id));
      this.fleetPlaces.update((list) => list.filter((x) => x.id !== c.place.id));
      this.renderFleetPlaceMarkers();
      this.closePlaceCard();
      this.toast.success('Lieu retiré');
    } catch {
      this.toast.error('Suppression impossible');
    } finally {
      this.placeCardSaving.set(false);
    }
  }

  /**
   * Persiste le déplacement d'un lieu (glisser-déposer du marqueur). En cas d'échec on RESYNCHRONISE
   * les marqueurs sur les coordonnées connues : sans ça le pin resterait là où l'utilisateur l'a
   * lâché alors que rien n'est enregistré (l'UI mentirait).
   */
  private async persistPlaceMove(id: string, lat: number, lng: number): Promise<void> {
    try {
      const updated = await firstValueFrom(this.fleetPlacesApi.update(id, { lat, lng }));
      this.applyPlaceUpdate(updated, { recreateMarker: false });
      this.toast.success('Lieu déplacé');
    } catch {
      this.toast.error('Déplacement non enregistré');
      this.renderFleetPlaceMarkers(); // remet le pin à sa position enregistrée
    }
  }

  /** Applique un lieu mis à jour partout : liste, card ouverte, et marqueur. */
  private applyPlaceUpdate(updated: FleetPlaceDto, opts: { recreateMarker: boolean }): void {
    this.fleetPlaces.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    const c = this.placeCard();
    if (c && c.type === 'place' && c.place.id === updated.id) {
      this.placeCard.set({ type: 'place', place: updated });
    }
    // Le nom est porté par le `title` du marqueur → on le recrée après un renommage.
    if (opts.recreateMarker) {
      const m = this.fleetPlaceMarkers.get(updated.id);
      if (m) {
        m.remove();
        this.fleetPlaceMarkers.delete(updated.id);
      }
    }
    this.renderFleetPlaceMarkers();
  }

  /** Toggle du calque « Lieux de la flotte ». */
  protected toggleFleetPlaces(): void {
    this.showFleetPlaces.set(!this.showFleetPlaces());
    this.renderFleetPlaceMarkers();
    // Masquer le calque doit fermer la card d'un lieu (sinon elle reste ouverte sans repère).
    if (!this.showFleetPlaces() && this.placeCard()?.type === 'place') this.closePlaceCard();
  }

  /** Active/désactive le mode « poser un lieu » (le prochain clic carte capture le point). */
  protected togglePlaceMode(): void {
    const next = !this.placeMode();
    this.placeMode.set(next);
    if (!next) this.cancelPendingPlace();
  }

  /** Abandonne le point en attente. */
  protected cancelPendingPlace(): void {
    this.pendingPlace.set(null);
    this.pendingPlaceName = '';
  }

  /** Enregistre le lieu posé (nom + nature) via l'API, puis l'affiche immédiatement. */
  protected async confirmPendingPlace(): Promise<void> {
    const pt = this.pendingPlace();
    const name = this.pendingPlaceName.trim();
    if (!pt || !name || this.placeSaving()) return;
    this.placeSaving.set(true);
    try {
      const created = await firstValueFrom(
        this.fleetPlacesApi.create({
          name,
          kind: this.pendingPlaceKind,
          lat: pt.lat,
          lng: pt.lng,
          fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
        }),
      );
      this.fleetPlaces.update((list) => [...list, created]);
      this.renderFleetPlaceMarkers();
      this.toast.success('Lieu enregistré', created.name);
      this.cancelPendingPlace();
      this.placeMode.set(false);
    } catch {
      this.toast.error("Impossible d'enregistrer ce lieu");
    } finally {
      this.placeSaving.set(false);
    }
  }

  /** Sprint D.4 — setup layer pour l'outil de mesure (ligne + points). */
  private setupMeasureLayer(): void {
    if (!this.map || this.map.getSource('measure')) return;
    this.map.addSource('measure', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'measure-line',
      type: 'line',
      source: 'measure',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#a855f7', 'line-width': 3, 'line-dasharray': [3, 2] },
    });
    this.map.addLayer({
      id: 'measure-points',
      type: 'circle',
      source: 'measure',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#a855f7', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
    });
  }

  private async loadGeofences(): Promise<void> {
    if (!this.map) return;
    try {
      const zones = await firstValueFrom(this.geofencesApi.list());
      const features: GeoJSON.Feature[] = [];
      for (const z of zones as GeofenceDto[]) {
        if (!z.active) continue;
        const props = { id: z.id, name: z.name, rule: z.rule, color: z.color ?? '#10e0a0' };
        if (z.type === 'POLYGON' && z.polygonPoints && z.polygonPoints.length >= 3) {
          features.push(polygonFeature(z.polygonPoints, props));
        } else if (z.centerLat != null && z.centerLng != null && z.radiusMeters != null) {
          features.push(circleFeature(z.centerLat, z.centerLng, z.radiusMeters, props));
        }
      }
      const src = this.map.getSource('geofences') as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features });
    } catch { /* silent */ }
  }

  /* --- Markers update --- */

  private applyPositions(positions: PositionUpdateEvent[]): void {
    if (!this.map) return;

    const nowMs = Date.now();
    const activeIds = new Set<string>();
    const trailFeatures: Array<GeoJSON.Feature<GeoJSON.LineString, { color: string; trackerId: string }>> = [];
    const followedId = this.followedVehicleId();
    const trailLength = this.preferences.prefs().map.trailLength;
    const showTrails = this.showTrails();
    const hydratedSet = this.realtime.hydratedTrackerIds();
    const showPlatesNow = this.showPlates();

    // Pre-calculer le map des engine command updates pour patcher les markers.
    const engineUpdates = this.realtime.engineCommandUpdates();
    // Incident FS-253 — snapshot par véhicule pour détecter GPS_LOST (lastNoFixAt/lastPositionAt).
    const snapByVehicle = new Map(this.realtime.snapshot().map((s) => [s.vehicleId, s]));

    for (const pos of positions) {
      const meta = this.vehicleMeta.get(pos.vehicleId) ?? { type: 'OTHER', plate: '' };
      // Patcher l'ignition du marker avec l'etat commande moteur (meme logique que popup).
      const patched = this.patchIgnitionFromCommands(pos);
      // GPS perdu : boîtier vivant mais dernière position GPS périmée (trames no_fix). Le marqueur
      // ne doit PAS rester vert « actif » à une position figée — on le passe en rouge estompé.
      const snap = snapByVehicle.get(pos.vehicleId);
      const gpsLost = !!snap && getVehicleConnectivityState({
        trackerId: snap.trackerId,
        lastSeenAt: snap.lastSeenAt,
        lastPositionAt: snap.lastPositionAt,
        lastNoFixAt: snap.lastNoFixAt,
        lastIgnition: snap.lastIgnition,
      }) === 'GPS_LOST';
      // Parking souterrain CONFIRMÉ : si GPS perdu ET la dernière position VALIDE (figée) tombe dans
      // une zone morte confirmée « normale » de CE véhicule, on l'affiche « à l'arrêt » (gris éteint)
      // et non « GPS perdu » (rouge) — la perte de GPS y est normale (véhicule garé sous terre). On
      // matche sur `snap.lastLat/lng` (dernier fix valide) et non `pos` (trame no_fix = coords dégradées).
      const zoneLat = snap?.lastLat ?? pos.lat;
      const zoneLng = snap?.lastLng ?? pos.lng;
      const parkedDeadZone = gpsLost && zoneLat != null && zoneLng != null && !!matchDeadZone(
        this.deadZonesData().filter((z) => z.vehicleId === pos.vehicleId && z.status === 'CONFIRMED_BENIGN'),
        zoneLat,
        zoneLng,
      );
      // FRAÎCHEUR — lue sur `lastSeenAt` (heure SERVEUR de la dernière trame), jamais sur
      // `pos.timestamp` qui est l'horloge DU BOÎTIER : un Coban qui repart après une coupure
      // d'alimentation renvoie une date fausse (souvent très en avance ou en 1970), ce qui
      // rendait « live » un boîtier mort — ou l'inverse. Repli sur `pos.timestamp` seulement
      // quand le snapshot ne dit rien (ligne absente ou `lastSeenAt` vide, course au premier
      // rendu) : on ne dégrade jamais l'affichage d'un véhicule sur une donnée manquante.
      const lastSeenAt = snap?.lastSeenAt ?? pos.timestamp;
      const live = isTrackerOnline(lastSeenAt, nowMs);
      // « EN MOUVEMENT MAINTENANT » exige beaucoup plus frais que « le boîtier parle » :
      // un véhicule qui roule émet toutes les ~30 s, donc au-delà de 5 min plus rien ne
      // prouve un déplacement en cours. C'est ce booléen qui coupe l'extrapolation.
      const movingFresh = isTrackerOnline(lastSeenAt, nowMs, MOVING_FRESHNESS_MS);
      const data: VehicleMarkerData = {
        trackerId: pos.trackerId,
        vehicleId: pos.vehicleId,
        type: meta.type,
        plate: meta.plate,
        brand: meta.brand ?? null,
        speedKmh: pos.speedKmh,
        heading: pos.heading,
        ignition: patched.ignition,
        active: pos.vehicleId === followedId,
        hydrated: hydratedSet.has(pos.trackerId),
        // Hors-ligne = dernier signal trop ancien (> seuil online partagé). Le
        // marqueur passe en gris/estompé au lieu de rester vert « actif » à sa
        // dernière position connue (cas boîtier débranché). Un véhicule muet depuis
        // des semaines est donc grisé — mais il RESTE affiché à sa dernière position.
        offline: !live,
        gpsLost,
        parkedDeadZone,
      };

      // GPS sanity (live) : rejette les fixes `valid: false` (broadcastes par le
      // backend uniquement pour propager l'ignition — lat/lng degradees) et les
      // sauts > 250 km/h depuis la derniere position fiable. Sans ce filtre,
      // l'icone saute et la trail dashed diverge en zigzag (regression visible
      // lors d'un demarrage a froid / tunnel / multipath urbain).
      const prevTruth = this.lastTruthPosition.get(pos.trackerId);
      let accepted = isAcceptableLiveFix(pos, prevTruth);
      const existingEntry = this.markers.get(pos.trackerId);

      // Resynchronisation anti-blocage : un fix rejete n'est pas forcement un
      // outlier. Si plusieurs trames rejetees de suite convergent vers la MEME
      // nouvelle zone, c'est un vrai deplacement (coupure GPRS, remorquage) → on
      // accepte et on snap. Un outlier transitoire, lui, revient vers l'ancre,
      // donc le compteur ne monte jamais.
      let forceSnap = false;
      if (!accepted) {
        const rs = this.rejectStreak.get(pos.trackerId);
        const consistent = rs
          ? haversineMeters(rs.lat, rs.lng, pos.lat, pos.lng) <= RESYNC_RADIUS_M
          : false;
        const n = consistent ? rs!.n + 1 : 1;
        if (n >= RESYNC_MIN_FRAMES) {
          accepted = true;
          forceSnap = true;
          this.rejectStreak.delete(pos.trackerId);
        } else {
          this.rejectStreak.set(pos.trackerId, { lat: pos.lat, lng: pos.lng, n });
        }
      } else {
        this.rejectStreak.delete(pos.trackerId);
      }

      if (!accepted) {
        // On garde le marker actif (sinon il serait supprime ci-dessous) mais on
        // ne bouge ni l'icone ni la trail. On rafraichit cependant les attributs
        // non-positionnels (ignition / ACC / plaque / followed) : c'est tout
        // l'interet du broadcast `valid:false` cote backend.
        if (existingEntry) {
          activeIds.add(pos.trackerId);
          const prevDisplay = this.motion.get(pos.trackerId);
          const lastData = this.lastMarkerData.get(pos.trackerId);
          updateVehicleMarkerEl(existingEntry.el, {
            ...data,
            heading: prevDisplay?.displayHeading ?? lastData?.heading ?? data.heading,
          });
          this.lastMarkerData.set(pos.trackerId, {
            ...data,
            heading: prevDisplay?.displayHeading ?? lastData?.heading ?? data.heading,
          });
          // Reconstruire le trail feature depuis les points existants pour que
          // setData() ne fasse pas disparaitre la trainee (regression : le
          // continue sautait la construction du feature → trail supprime a
          // chaque trame invalide car setData remplace tout le FeatureCollection).
          // GPS perdu → on NE reconstruit PAS la trainée (position figée : pas de trajet réel,
          // un trail vert laisserait croire qu'il roule). Elle disparaît proprement.
          if (showTrails && !gpsLost) {
            const pts = this.trailPoints.get(pos.trackerId);
            if (pts && pts.length >= 2) {
              const smoothPts = catmullRom(
                pts.map(([lng, lat]) => ({ lat, lng })),
                6,
              ).map((p) => [p.lng, p.lat] as [number, number]);
              trailFeatures.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: smoothPts },
                properties: { color: speedColor(lastData?.colorSpeedKmh ?? lastData?.speedKmh ?? 0), trackerId: pos.trackerId },
              });
            }
          }
        }
        // Pas de premier rendu sur fix invalide : on attend une trame fiable.
        continue;
      }

      activeIds.add(pos.trackerId);
      // Vitesse + cap + yaw rate ROBUSTES, derives du deplacement reel entre la
      // derniere verite et celle-ci. Le boitier Coban renvoie souvent speedKmh=0
      // et un heading fige MEME en roulant : sans ca l'icone passe en gris
      // (couleur vitesse 0) et l'extrapolation se coupe puis re-saute. Repli sur
      // les champs rapportes quand il n'y a pas de segment exploitable.
      const prevMotionState = this.motion.get(pos.trackerId);
      const derived = deriveMotion(
        prevTruth
          ? { lat: prevTruth.lat, lng: prevTruth.lng, timestamp: new Date(prevTruth.timestamp).getTime() }
          : null,
        {
          lat: pos.lat, lng: pos.lng,
          timestamp: new Date(pos.timestamp).getTime(),
          speedKmh: pos.speedKmh ?? 0,
          heading: pos.heading ?? 0,
        },
        prevMotionState?.truthHeading ?? null,
      );
      // Couleur du trail pour ce segment (defaut = rapporte ; robuste en MAJ normale).
      let trailColorKmh = Math.max(pos.speedKmh ?? 0, 0);
      let entry = existingEntry;
      if (!entry) {
        const el = buildVehicleMarkerEl(data);
        if (!showPlatesNow) el.classList.add('tracky-marker--no-plate');
        const marker = attachVehicleMarker(this.map, el, pos.lat, pos.lng);
        // V1.10 (Sprint 3 perf) — listeners attaches au AbortController dont
        // signal est abort() quand on retire le marker, garantissant zero fuite
        // memoire meme apres N filtres / disparitions de vehicules.
        const abort = new AbortController();
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // zone.run : le listener DOM natif tourne hors zone Angular, mais
          // openMarkerPopup peut setter des signals (baanoolCard) qui doivent
          // declencher un cycle CD pour rendre la bottom card immediatement.
          this.zone.run(() => this.openMarkerPopup(pos.trackerId));
        }, { signal: abort.signal });
        el.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          this.followedVehicleId.set(pos.vehicleId);
          if (this.cameraMode() === 'free') this.setCameraMode('follow');
          else this.applyCameraMode();
        }, { signal: abort.signal });
        entry = { marker, el, abort };
        this.markers.set(pos.trackerId, entry);
      } else {
        // Mise a jour de la verite. Le tick() loop fera converger display vers
        // (truth + extrapolation par speed/heading) via filtre passe-bas.
        // Resultat : icone collee au temps reel quand le vehicule roule droit,
        // correction douce sur virages/freinages quand la trame suivante arrive.
        const cur = entry.marker.getLngLat();
        const lastData = this.lastMarkerData.get(pos.trackerId);
        const isHydrated = data.hydrated === true;
        // VITESSE DE RÉFÉRENCE DE L'EXTRAPOLATION — nulle dès que le véhicule n'est plus live.
        //
        // Cas réel : au chargement de la carte, un véhicule muet depuis 89 jours est hydraté
        // avec sa DERNIÈRE trame connue — qui disait « 62 km/h, cap 210° ». `truthAt` valant
        // l'instant du rendu, la boucle d'animation le croyait en train de rouler MAINTENANT
        // et faisait glisser son marqueur sur ~600 m avant de le figer : un véhicule immobile
        // depuis des semaines « repartait » à chaque ouverture de la carte.
        // La position affichée n'est pas fausse — c'est la VITESSE qui n'est plus une preuve.
        const truthSpeedMs = movingFresh ? pos.speedKmh / 3.6 : 0;
        const nowPerf = performance.now();

        if (isHydrated || !lastData || forceSnap) {
          // Premier rendu (hydratation / nouveau tracker) ou resynchronisation
          // (vrai deplacement apres coupure) : snap sans anim, sur la vitesse
          // RAPPORTEE (la vitesse derivee sur le grand saut serait absurde).
          // Sur resync, on repart le trail a neuf : tirer un segment droit a
          // travers le trou (coupure GPRS) serait trompeur (chemin reel inconnu).
          if (forceSnap) this.trailPoints.delete(pos.trackerId);
          entry.marker.setLngLat([pos.lng, pos.lat]);
          updateVehicleMarkerEl(entry.el, data);
          this.motion.set(pos.trackerId, {
            truthLat: pos.lat, truthLng: pos.lng,
            truthHeading: pos.heading, truthSpeedMs,
            truthAt: nowPerf,
            turnRateDegPerS: 0,
            intervalMs: TYPICAL_INTERVAL_MS,
            displayLat: pos.lat, displayLng: pos.lng, displayHeading: pos.heading,
          });
        } else {
          const prev = this.motion.get(pos.trackerId);
          // EMA sur l'intervalle inter-trame observe (sert a borner l'extrapolation
          // pour ce tracker — un boitier qui emet souvent autorise plus de projection,
          // un boitier en STOPPED a 5min en autorise tres peu).
          let intervalMs = TYPICAL_INTERVAL_MS;
          if (prev) {
            const dtSinceLast = nowPerf - prev.truthAt;
            intervalMs = prev.intervalMs * (1 - INTERVAL_EMA_ALPHA) + dtSinceLast * INTERVAL_EMA_ALPHA;
            // Bornes [5s..120s] pour absorber les outliers (trame perdue, GPRS coupe).
            intervalMs = Math.max(5_000, Math.min(120_000, intervalMs));
          }
          // On ne touche PAS a display* : le tick() lissera depuis la position
          // courante du marker. Si pas d'etat precedent (re-entree), on part
          // de la position visible du marker.
          // Cap/vitesse/yaw ROBUSTES (derives du deplacement reel) → l'icone reste
          // coloree en roulant meme si Coban dit 0, et l'extrapolation epouse le virage.
          trailColorKmh = derived.effectiveSpeedKmh;
          data.colorSpeedKmh = Math.round(derived.effectiveSpeedKmh);
          this.motion.set(pos.trackerId, {
            truthLat: pos.lat, truthLng: pos.lng,
            truthHeading: derived.headingDeg,
            // Même règle que ci-dessus : sans trame fraîche, aucune vitesse ne peut
            // être affirmée, donc on ne projette rien (yaw remis à 0 par cohérence —
            // faire tourner l'icône d'un véhicule muet serait la même illusion).
            truthSpeedMs: movingFresh ? derived.speedMs : 0,
            truthAt: nowPerf,
            turnRateDegPerS: movingFresh ? derived.turnRateDegPerS : 0,
            intervalMs,
            displayLat: prev?.displayLat ?? cur.lat,
            displayLng: prev?.displayLng ?? cur.lng,
            displayHeading: prev?.displayHeading ?? lastData.heading,
          });
          // Update les attributs non-positionnels (couleur, ACC, plaque, active)
          // immediatement pour qu'ils refletent le nouvel etat sans attendre le tick.
          updateVehicleMarkerEl(entry.el, { ...data, heading: prev?.displayHeading ?? lastData.heading });
        }
      }
      this.lastMarkerData.set(pos.trackerId, data);
      // Memorise la verite courante : sert d'ancrage pour `isAcceptableLiveFix`
      // sur la prochaine trame (rejet des sauts > 250 km/h).
      this.lastTruthPosition.set(pos.trackerId, {
        lat: pos.lat,
        lng: pos.lng,
        timestamp: pos.timestamp,
        speedKmh: pos.speedKmh,
      });

      // Trail accumulation (en memoire, capee a trailLength).
      // V1.8 : dedupliquer — applyPositions est appele a chaque flush du buffer rAF
      // (donc tres souvent, meme quand un seul tracker a recu une trame). Sans
      // ce check, chaque tracker qui n'a PAS bouge voit son ancienne position
      // pushee a chaque appel, remplissant trailPoints de duplicats. Resultat :
      // le LineString degenere en N points superposes (segments de longueur 0)
      // → plus aucune trainee visible meme quand le vehicule bouge vraiment.
      // GPS perdu → pas de trainée (position figée). Cohérent avec la branche fix-invalide.
      if (showTrails && !gpsLost) {
        let pts = this.trailPoints.get(pos.trackerId);
        if (!pts) {
          pts = [];
          this.trailPoints.set(pos.trackerId, pts);
        }
        const last = pts[pts.length - 1];
        if (!last || last[0] !== pos.lng || last[1] !== pos.lat) {
          pts.push([pos.lng, pos.lat]);
          while (pts.length > trailLength) pts.shift();
        }

        if (pts.length >= 2) {
          // Lissage Catmull-Rom : insere des points intermediaires pour adoucir
          // les coins de virage (la trame Coban tous les 30s coupe les courbes).
          // 6 echantillons par segment garde un rendu fluide sans surcharger
          // (un trail de 20 points devient 19*6+20 = ~134 points GeoJSON).
          const smoothPts = catmullRom(
            pts.map(([lng, lat]) => ({ lat, lng })),
            6,
          ).map((p) => [p.lng, p.lat] as [number, number]);
          trailFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: smoothPts },
            properties: { color: speedColor(trailColorKmh), trackerId: pos.trackerId },
          });
        }
      }
    }

    // Remove disappeared markers.
    for (const [id, entry] of this.markers) {
      if (!activeIds.has(id)) {
        // V1.10 (Sprint 3 perf) — abort() detache les click/dblclick listeners
        // de l'element DOM avant que MapLibre ne le supprime, garantissant que
        // l'element peut etre garbage-collecte.
        entry.abort.abort();
        entry.marker.remove();
        this.markers.delete(id);
        this.trailPoints.delete(id);
        this.lastTruthPosition.delete(id);
        this.rejectStreak.delete(id);
        this.motion.delete(id);
      }
    }

    // Update trails source.
    const trailsSrc = this.map.getSource('trails') as maplibregl.GeoJSONSource | undefined;
    trailsSrc?.setData({ type: 'FeatureCollection', features: trailFeatures });

    // Sprint G.2 — alimente la source cluster.
    const clusterSrc = this.map.getSource('vehicles-cluster') as maplibregl.GeoJSONSource | undefined;
    clusterSrc?.setData({
      type: 'FeatureCollection',
      features: positions.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { vehicleId: p.vehicleId, trackerId: p.trackerId },
      })),
    });

    // Auto-fit la premiere fois qu'on a des markers.
    if (!this.hasFittedBounds && this.markers.size > 0) {
      this.hasFittedBounds = true;
      const mapPrefs = this.preferences.prefs().map;
      const defaults = this.preferences.getDefaults().map;
      const isDefaultCenter = mapPrefs.centerLat === defaults.centerLat && mapPrefs.centerLng === defaults.centerLng;
      // Cadrage automatique du premier rendu : muet (l'utilisateur n'a rien demandé).
      if (isDefaultCenter) this.centerAll({ announceSetAside: false });
    }

    // Camera follow sur le vehicule actif.
    if (this.cameraMode() !== 'free') {
      this.applyCameraMode();
    }

    // Update popover/card content si ouvert.
    if (this.activePopupTrackerId && this.activePopupVehicleId) {
      const pos = positions.find((p) => p.trackerId === this.activePopupTrackerId);
      if (pos) {
        // Baanool bottom card : mise a jour reactive via signal.
        // On ne set() que si les valeurs affichees ont change, pour eviter
        // des re-renders constants qui avalent les taps sur les boutons.
        const currentCard = this.baanoolCard();
        if (currentCard) {
          const patched = this.patchIgnitionFromCommands(pos);
          const cutActive = this.isCutActiveForTracker(pos.trackerId);
          const cutPending = this.isCutPendingForTracker(pos.trackerId);
          if (currentCard.speedKmh !== patched.speedKmh ||
              currentCard.ignition !== patched.ignition ||
              currentCard.cutActive !== cutActive ||
              currentCard.cutPending !== cutPending ||
              currentCard.lat !== pos.lat ||
              currentCard.lng !== pos.lng) {
            // Incident FS-253 — on SPREAD la card courante pour préserver lastNoFixAt /
            // lastSeenAt / fleetId / imei / group / privacyModeEnabled, et on rafraîchit
            // lastPositionAt avec la trame REÇUE (fraîche pour une voiture qui roule).
            // Sans ce spread, un littéral nu écrasait lastPositionAt → cardShowsLive()
            // masquait la vitesse/contact d'une voiture LIVE et le badge passait « Non
            // configuré ». (Revue adversariale 2026-07-09.)
            this.baanoolCard.set({
              ...currentCard,
              ignition: patched.ignition,
              speedKmh: patched.speedKmh,
              lat: pos.lat,
              lng: pos.lng,
              cutActive,
              cutPending,
              lastPositionAt: pos.timestamp ?? currentCard.lastPositionAt ?? null,
            });
          }
        }
      }
    }
  }

  /* --- Popover info marker --- */

  /**
   * V1.7 — Determine si une coupure moteur est en cours pour un tracker donne,
   * en se basant sur les commandes WS recentes (`realtime.engineCommandUpdates`).
   *
   * Source de verite UNIQUE pour le bouton CUT/RESTORE : on ne se fie plus a
   * `pos.ignition` qui peut etre faux quand le fil ACC n'est pas connecte
   * (mode degrade, ignition inferee depuis vitesse).
   *
   * Conservatif : retourne `true` UNIQUEMENT si la derniere update est une
   * CUT effective (SENT ou ACKNOWLEDGED). Sinon `false` (on propose Couper).
   * Le serveur rejettera le 2eme CUT si deja coupe (idempotent).
   */
  private isCutActiveForTracker(trackerId: string): boolean {
    return this.realtime.cutActiveTrackerIds().has(trackerId);
  }

  /** Sprint 2 (revue #2) — coupure commandée mais non encore confirmée (tri-état). */
  private isCutPendingForTracker(trackerId: string): boolean {
    return this.realtime.cutPendingTrackerIds().has(trackerId);
  }

  /**
   * Corrige l'ignition affichee en tenant compte des commandes moteur recentes.
   * Quand un CUT est SENT/ACKNOWLEDGED mais que l'ACC_OFF du tracker n'est pas
   * encore arrive, la position WS montre encore ignition=true. Ce helper
   * patche l'etat pour que le popup affiche le bon bouton immediatement.
   */
  private patchIgnitionFromCommands(pos: PositionUpdateEvent): PositionUpdateEvent {
    const update = this.realtime.engineCommandUpdates().get(pos.trackerId);
    if (!update) return pos;
    // Sprint 2 — plus de patch optimiste sur un simple SENT (c'etait un faux succes) :
    // on ne reflete l'etat que sur confirmation reelle (a ce stade la trame de
    // position porte deja le bon ignition). Source de verite = device.
    if (update.status === 'ACKNOWLEDGED') {
      if (update.action === 'CUT' && pos.ignition) {
        return { ...pos, ignition: false };
      }
      if (update.action === 'RESTORE' && !pos.ignition) {
        return { ...pos, ignition: true };
      }
    }
    return pos;
  }

  /**
   * Connectivité (tri-état partagé) du véhicule affiché dans la bottom card.
   * Sert à flaguer « Hors ligne / Non configuré » comme partout ailleurs.
   */
  protected cardConnectivity(): VehicleConnectivityState {
    const c = this.baanoolCard();
    return getVehicleConnectivityState({
      trackerId: c?.trackerId ?? null,
      lastSeenAt: c?.lastSeenAt ?? null,
      // Incident FS-253 — on passe lastPositionAt + lastNoFixAt pour détecter GPS_LOST :
      // boîtier vivant mais dont la position GPS est périmée (antenne / ciel).
      lastPositionAt: c?.lastPositionAt ?? null,
      lastNoFixAt: c?.lastNoFixAt ?? null,
      lastIgnition: c?.ignition ?? null,
    });
  }

  /**
   * Incident FS-253 — la card n'affiche la vitesse/contact « live » QUE si la DERNIÈRE
   * position GPS est FRAÎCHE (≤ 30 min). Basé sur l'âge RÉEL de la position, pas sur
   * l'état de connectivité (qui dépend des reconnexions) : une position vieille de 29 h
   * ne doit jamais s'afficher comme du direct. Une voiture qui roule a une position
   * fraîche → aucun changement pour le cas courant. Au-delà, on montre l'âge + le badge.
   */
  protected cardShowsLive(): boolean {
    const iso = this.baanoolCard()?.lastPositionAt;
    if (!iso) return false;
    const ageMs = Date.now() - new Date(iso).getTime();
    return Number.isFinite(ageMs) && ageMs <= GPS_FIX_STALE_THRESHOLD_MS;
  }

  /** Libellé « dernière position il y a Xmin/Xh/Xj » (null si inconnu). */
  protected cardLastFixLabel(): string | null {
    const iso = this.baanoolCard()?.lastPositionAt;
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const min = Math.floor(ms / 60000);
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `il y a ${h} h`;
    return `il y a ${Math.floor(h / 24)} j`;
  }

  private openMarkerPopup(trackerId: string): void {
    const pos = this.realtime.positionsList().find((p) => p.trackerId === trackerId);
    if (!pos || !this.map) return;

    // Bottom card pour tous les modes — remplace le popup MapLibre qui causait
    // des bugs de zoom/pan et des interactions cassees sur mobile.
    this.closePopup();
    // Une seule card à la fois : ouvrir un véhicule ferme la card repère (station / lieu).
    this.closePlaceCard();
    const patched = this.patchIgnitionFromCommands(pos);
    const meta = this.vehicleMeta.get(pos.vehicleId) ?? { type: 'OTHER', plate: '?' };
    // Incident FS-253 — on lit le snapshot pour la fraîcheur RÉELLE : lastPositionAt
    // (dernier fix GPS) et lastNoFixAt (dernière trame sans lock). Sans ça, la card
    // affichait la vitesse/contact de la dernière position même vieille de 29 h.
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === pos.vehicleId);
    this.baanoolCard.set({
      trackerId,
      vehicleId: pos.vehicleId,
      plate: meta.plate,
      type: meta.type,
      ignition: patched.ignition,
      speedKmh: patched.speedKmh,
      lat: pos.lat,
      lng: pos.lng,
      cutActive: this.isCutActiveForTracker(trackerId),
      cutPending: this.isCutPendingForTracker(trackerId),
      privacyModeEnabled: snap?.privacyModeEnabled ?? false,
      fleetId: meta.fleetId,
      imei: meta.imei,
      lastSeenAt: snap?.lastSeenAt ?? meta.lastSeenAt,
      lastPositionAt: snap?.lastPositionAt ?? pos.timestamp ?? null,
      lastNoFixAt: snap?.lastNoFixAt ?? null,
      group: meta.group ?? null,
    });
    this.activePopupTrackerId = trackerId;
    this.activePopupVehicleId = pos.vehicleId;

    // Zones mortes GPS (suivi FS-253) : si le boîtier est GPS_LOST, sa position affichée est FIGÉE
    // sur le dernier fix (= point d'entrée). Si ce point tombe dans une zone connue de CE véhicule,
    // on calme le message (« à l'arrêt · parking souterrain » si confirmé). Données déjà en mémoire
    // (chargées en continu), donc lookup synchrone — aucun appel réseau au clic.
    this.deadZoneHint.set(null);
    if (this.cardConnectivity() === 'GPS_LOST') {
      const zonesForVehicle = this.deadZonesData().filter((z) => z.vehicleId === pos.vehicleId);
      const z = matchDeadZone(zonesForVehicle, pos.lat, pos.lng);
      if (z) this.deadZoneHint.set({ label: deadZoneNatureLabel(z), benign: z.status === 'CONFIRMED_BENIGN' });
    }
  }

  private requestEngine(trackerId: string, action: 'CUT' | 'RESTORE'): void {
    const vehicleId = this.activePopupVehicleId;
    const snap = vehicleId ? this.realtime.snapshot().find((v) => v.vehicleId === vehicleId) : null;
    this.engineModalHasSchedule = !!(snap && (snap as any).scheduleEnabled);
    this.engineModalTrackerId = trackerId;
    this.engineModalOpen.set(action === 'CUT' ? 'cut' : 'restore');
  }

  protected onEngineModalConfirm(): void {
    const trackerId = this.engineModalTrackerId;
    const action = this.engineModalOpen() === 'cut' ? 'CUT' as const : 'RESTORE' as const;
    if (!trackerId) return;

    this.engineModalLoading.set(true);
    // V1.10 (Sprint 5 stabilite) — takeUntilDestroyed annule la souscription
    // si le composant est detruit avant la reponse (cas user qui change de
    // page entre le click et l'ack reseau). Evite le warning "callback on
    // destroyed component".
    // Refonte planning : une action manuelle NE désactive plus le mode horaire (elle le suspend
    // jusqu'à la prochaine bascule côté backend). On n'envoie donc plus `disableSchedule`.
    this.engineControl.requestCommand(trackerId, action, 'depuis carte').pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => {
        // Sprint 2 (revue #4) — PAS de faux succès : la commande est ENVOYÉE, pas
        // confirmée. L'état « coupé » ne basculera qu'à la chute d'ignition (le badge
        // carte est piloté par le WS). Toast neutre « envoyée » + attente de confirmation.
        this.toast.show({
          kind: 'info',
          title: action === 'CUT' ? 'Coupure envoyée' : 'Rallumage envoyé',
          message: action === 'CUT'
            ? 'En attente de confirmation du boîtier (chute d\'ignition)…'
            : 'Commande transmise au véhicule.',
          duration: 4000,
        });
        this.engineModalOpen.set(null);
        this.engineModalLoading.set(false);
        this.closePopup();
      },
      error: (err) => {
        // Sprint 2 (revue #4) — 409 = une coupure est déjà en attente (verrou anti
        // multi-clic). Message dédié, pas un « échec » générique trompeur.
        const is409 = err?.status === 409;
        this.toast.show({
          kind: 'error',
          title: is409 ? 'Commande déjà en cours' : 'Échec commande moteur',
          message: is409
            ? 'Une coupure est déjà en attente de confirmation sur ce véhicule.'
            : (err?.error?.error?.message ?? err?.error?.message ?? 'Erreur inconnue'),
          duration: 6000,
        });
        // Fermer la modal aussi sur erreur/409 (sinon elle reste ouverte et masque le toast). Cf smoke prod 2026-06-18.
        this.engineModalOpen.set(null);
        this.engineModalLoading.set(false);
      },
    });
  }

  private closePopup(): void {
    this.currentPopup?.remove();
    this.currentPopup = null;
    this.activePopupTrackerId = null;
    this.activePopupVehicleId = null;
    this.baanoolCard.set(null);
  }

  /* --- Baanool bottom card actions --- */

  protected closeBaanoolCard(): void {
    this.baanoolCard.set(null);
    this.deadZoneHint.set(null);
    this.activePopupTrackerId = null;
    this.activePopupVehicleId = null;
  }

  protected baanoolCardAction(action: string): void {
    const card = this.baanoolCard();
    if (!card) return;
    switch (action) {
      case 'follow':
        this.followedVehicleId.set(card.vehicleId);
        if (this.cameraMode() === 'free') this.setCameraMode('follow');
        else this.applyCameraMode();
        this.closeBaanoolCard();
        break;
      case 'detail':
        this.router.navigate(['/vehicles', card.vehicleId]);
        break;
      case 'replay1h':
        this.toggleMiniReplay(card.vehicleId);
        this.closeBaanoolCard();
        break;
      case 'navigate':
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${card.lat},${card.lng}`, '_blank');
        break;
      case 'gmaps':
        window.open(`https://www.google.com/maps?q=${card.lat},${card.lng}`, '_blank');
        break;
      case 'cut':
        this.requestEngine(card.trackerId, 'CUT');
        break;
      case 'restore':
        this.requestEngine(card.trackerId, 'RESTORE');
        break;
    }
  }

  /* --- Search Nominatim --- */

  protected onSearchInput(ev: Event): void {
    this.searchQuery.set((ev.target as HTMLInputElement).value);
  }

  /** Sprint G.1 — delai pour permettre au mousedown du dropdown de tirer avant le blur. */
  protected onSearchBlur(): void {
    setTimeout(() => this.searchFocused.set(false), 150);
  }

  /** Sprint G.1 — saut sur un vehicule depuis les suggestions. */
  protected jumpToVehicle(vehicleId: string): void {
    if (!this.map) return;
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === vehicleId);
    const snap = this.realtime.snapshot().find((s) => s.vehicleId === vehicleId);
    const lat = pos?.lat ?? snap?.lastLat;
    const lng = pos?.lng ?? snap?.lastLng;
    if (lat == null || lng == null) {
      this.toast.show({ kind: 'warning', title: 'Position inconnue', duration: 3000 });
      return;
    }
    this.mapSvc.flyTo(this.map, lat, lng, 16);
    this.searchQuery.set('');
    this.searchFocused.set(false);
  }

  protected async searchAddress(ev: Event): Promise<void> {
    ev.preventDefault();
    const q = this.searchQuery().trim();
    if (!q || !this.map) return;

    // Le champ accepte « plaque OU adresse » : si la saisie correspond à un véhicule, Entrée doit
    // y aller directement. Avant, Entrée partait TOUJOURS en géocodage — taper une plaque envoyait
    // donc chercher « GS-138-LT » chez Nominatim, qui ne trouve évidemment rien.
    const matches = this.vehicleMatches();
    if (matches.length > 0) {
      this.jumpToVehicle(matches[0]!.vehicleId);
      return;
    }

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
      const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      if (data.length === 0) {
        this.toast.show({ kind: 'warning', title: 'Adresse introuvable', duration: 4000 });
        return;
      }
      const hit = data[0]!;
      this.mapSvc.flyTo(this.map, parseFloat(hit.lat), parseFloat(hit.lon), 15);
    } catch (err) {
      this.toast.show({ kind: 'error', title: 'Recherche impossible', duration: 4000 });
      void err;
    }
  }

  /* --- Context menu --- */

  protected closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  protected copyCoords(): void {
    const ctx = this.contextMenu();
    if (!ctx) return;
    const text = `${ctx.lat.toFixed(6)}, ${ctx.lng.toFixed(6)}`;
    navigator.clipboard?.writeText(text).then(
      () => this.toast.show({ kind: 'info', title: 'Coordonnees copiees', message: text, duration: 3000 }),
      () => { /* noop */ },
    );
  }

  protected centerHere(): void {
    const ctx = this.contextMenu();
    if (!ctx || !this.map) return;
    this.mapSvc.flyTo(this.map, ctx.lat, ctx.lng);
  }

  /* --- Fullscreen & shortcuts --- */

  protected toggleFullscreen(): void {
    const el = this.mapContainerRef().nativeElement.parentElement ?? this.mapContainerRef().nativeElement;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.();
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(ev: KeyboardEvent): void {
    // Eviter les raccourcis quand on est dans un input.
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch (ev.key.toLowerCase()) {
      case 'f': ev.preventDefault(); this.toggleFullscreen(); break;
      case 'c': ev.preventDefault(); this.resetNorth(); break;
      case 'o': ev.preventDefault(); this.centerAll(); break;
      // « P » comme Position — la carte ne recentre plus d'office sur l'utilisateur, un raccourci
      // évite d'aller chercher le bouton. (`m` est déjà pris par le mode caméra.)
      case 'p': ev.preventDefault(); this.centerOnUser(); break;
      // Échap ferme ce qui est ouvert, du plus « au premier plan » au plus discret : on ne ferme
      // qu'UNE couche par appui, sinon un seul Échap balaierait tout l'écran par surprise.
      case 'escape': {
        if (this.contextMenu()) { this.closeContextMenu(); break; }
        if (this.placeCard()) { this.closePlaceCard(); break; }
        if (this.baanoolCard()) { this.baanoolCard.set(null); break; }
        if (this.mobileSheetOpen()) { this.mobileSheetOpen.set(false); break; }
        if (this.calquesPanelOpen()) { this.calquesPanelOpen.set(false); break; }
        break;
      }
      case 'm': {
        ev.preventDefault();
        const idx = this.cameraModes.findIndex((m) => m.id === this.cameraMode());
        const next = this.cameraModes[(idx + 1) % this.cameraModes.length]!;
        this.setCameraMode(next.id);
        break;
      }
    }
  }
}

/* --- Helpers --- */

/**
 * Construit un Polygon GeoJSON approximant un cercle (64 segments) autour
 * d'un centre lat/lng et rayon en metres. Utilise pour les geofences.
 */
/**
 * Lieux clés — couleur + glyphe d'un lieu de la flotte selon sa nature. L'émeraude des stations
 * VALIDÉES les distingue volontairement du violet des stations simplement DÉTECTÉES (calque
 * `fuel-stations`) : c'est la différence « nouvelle station vs station de la flotte ».
 */
function fleetPlaceStyle(kind: FleetPlaceKind): { color: string; glyph: string } {
  switch (kind) {
    case 'FUEL_STATION':
      return { color: '#10E0A0', glyph: '⛽' };
    case 'PARKING':
      return { color: '#0ea5e9', glyph: 'P' };
    case 'DEPOT':
      return { color: '#f59e0b', glyph: 'D' };
    default:
      return { color: '#94a3b8', glyph: '★' };
  }
}

/** Sprint F.2 — feature GeoJSON pour un polygone defini par ses sommets. */
function polygonFeature(
  points: Array<{ lat: number; lng: number }>,
  props: Record<string, unknown>,
): GeoJSON.Feature<GeoJSON.Polygon, Record<string, unknown>> {
  const ring: Array<[number, number]> = points.map((p) => [p.lng, p.lat]);
  // Fermer le polygone (premier == dernier).
  if (ring.length > 0 && (ring[0]![0] !== ring[ring.length - 1]![0] || ring[0]![1] !== ring[ring.length - 1]![1])) {
    ring.push(ring[0]!);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: props,
  };
}

function circleFeature(
  centerLat: number,
  centerLng: number,
  radiusM: number,
  props: Record<string, unknown>,
): GeoJSON.Feature<GeoJSON.Polygon, Record<string, unknown>> {
  const points = 64;
  const km = radiusM / 1000;
  const distanceX = km / (111.320 * Math.cos((centerLat * Math.PI) / 180));
  const distanceY = km / 110.574;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    const x = distanceX * Math.cos(theta);
    const y = distanceY * Math.sin(theta);
    ring.push([centerLng + x, centerLat + y]);
  }
  ring.push(ring[0]!);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: props,
  };
}
