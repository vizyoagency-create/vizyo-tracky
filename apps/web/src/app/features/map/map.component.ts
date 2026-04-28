import {
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker, Popup, GeoJSONSource } from 'maplibre-gl';
import type { GeofenceDto, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { sanitizePositions } from '@vizyo/tracky-shared';

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
import { GeofencesApiService } from '../../core/services/geofences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { PreferencesService, type CameraMode } from '../../core/services/preferences.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { EngineControlService } from '../../core/services/engine-control.service';
import { VisibilityService } from '../../core/services/visibility.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { MapService } from '../../core/services/map.service';
import { MapStyleService, type MapStyleId } from '../../core/services/map-style.service';
import {
  attachVehicleMarker,
  buildVehicleMarkerEl,
  speedColor,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from '../../shared/utils/maplibre-markers';
import { catmullRom, lerp, lerpHeading } from '../../shared/utils/spline';

interface MarkerEntry {
  marker: MlMarker;
  el: HTMLElement;
}

interface VehicleMeta {
  type: string;
  plate: string;
}

/**
 * Etat d'interpolation d'un marker : entre deux trames Coban (~30s), on fait
 * glisser le marker de `from` vers `to` plutot que de teleporter. Cf. Sprint C.
 */
interface InterpState {
  fromLat: number;
  fromLng: number;
  fromHeading: number;
  toLat: number;
  toLng: number;
  toHeading: number;
  startedAt: number;
  durationMs: number;
}

const INTERP_DURATION_MS = 28_000; // legerement < 30s pour atteindre la cible avant la nouvelle trame

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [DecimalPipe],
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
    <div class="tracky-desktop-hud" style="position:absolute;top:16px;left:16px;z-index:1000">
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
            (click)="toggleFullscreen()"
            class="px-2 py-1.5 text-xs rounded-lg bg-bg-tertiary/60 border border-border-subtle
                   text-fg-secondary hover:text-fg-primary cursor-pointer"
            title="Plein ecran (F)">
            ⛶
          </button>
        </div>
        <div class="flex gap-1.5 mt-1.5 flex-wrap">
          <button
            (click)="toggleMeasure()"
            [class]="'flex-1 text-[10px] font-medium py-1.5 rounded-lg cursor-pointer transition-colors ' +
                     (measureMode()
                       ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
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
        </div>
        @if (measureMode()) {
          <div class="mt-2 px-2 py-1 rounded bg-purple-500/10 border border-purple-500/30
                      text-[10px] text-purple-300 flex items-center justify-between">
            <span>{{ measurePoints().length }} pts · {{ measureTotalKm() | number:'1.2-2' }} km</span>
            <button (click)="clearMeasure()" class="text-[10px] underline cursor-pointer">Effacer</button>
          </div>
        }
        @if (miniReplayVehicleId()) {
          <div class="mt-2 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30
                      text-[10px] text-blue-300 flex items-center justify-between">
            <span>Replay 1h actif</span>
            <button (click)="toggleMiniReplay(miniReplayVehicleId()!)" class="text-[10px] underline cursor-pointer">Fermer</button>
          </div>
        }
      </div>

      <!-- Smart search desktop -->
      <div class="mt-2 bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 min-w-[220px] relative">
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
          <div style="position:absolute;top:100%;left:0;right:0;z-index:1500"
               class="mt-1 bg-bg-secondary/95 backdrop-blur-md border border-border-subtle
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
    </div>

    <!-- Style picker top-right - DESKTOP ONLY (caché en mobile) -->
    <div class="tracky-style-picker tracky-desktop-hud"
         style="position:absolute;top:16px;right:16px;z-index:1000;max-width:calc(100% - 32px)">
      <div class="bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 flex gap-1 flex-wrap">
        @for (s of styles.catalog; track s.id) {
          <button
            (click)="setStyle(s.id)"
            [class]="'px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ' +
                     (currentStyle() === s.id
                       ? 'bg-tracky/20 text-tracky-light border border-tracky/30'
                       : 'text-fg-tertiary hover:text-fg-primary')"
            [title]="s.label">
            {{ s.label }}
          </button>
        }
      </div>

      <!-- Camera mode pills -->
      <div class="mt-2 bg-bg-secondary/85 backdrop-blur-md border border-border-subtle
                  rounded-[--radius-card] p-2 flex gap-1 flex-wrap">
        @for (m of cameraModes; track m.id) {
          <button
            (click)="setCameraMode(m.id)"
            [class]="'px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ' +
                     (cameraMode() === m.id
                       ? 'bg-tracky/20 text-tracky-light border border-tracky/30'
                       : 'text-fg-tertiary hover:text-fg-primary')"
            [title]="m.tooltip">
            {{ m.label }}
          </button>
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
              @if (realtime.snapshot().length === 0) {
                <p class="tracky-vehicle-picker-empty">Aucun véhicule disponible</p>
              } @else {
                @for (v of realtime.snapshot(); track v.vehicleId) {
                  <button (click)="pickVehicleForCamera(v.vehicleId)" class="tracky-vehicle-picker-item">
                    <span class="tracky-vehicle-picker-plate">{{ v.plate }}</span>
                    <span class="tracky-vehicle-picker-meta">{{ v.type }}</span>
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
              <span>Hors-ligne (>10min)</span>
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
      </div>
    </div>

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
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

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
      font-family: monospace;
      font-size: 13px;
      font-weight: 700;
    }
    .tracky-vehicle-picker-meta {
      font-size: 10px;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    /* Sheet overlay backdrop */
    .tracky-mobile-sheet-overlay { display: none; }

    /* ════════════════════════════════════════════════════════════
       MOBILE (< 768px) — toutes les overrides responsive
       ════════════════════════════════════════════════════════════ */
    @media (max-width: 767px) {
      /* Cacher les HUDs desktop */
      .tracky-desktop-hud { display: none !important; }

      /* Top bar mobile visible */
      .tracky-mobile-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        position: absolute;
        top: 12px; left: 12px; right: 12px;
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
        max-height: calc(85vh - env(safe-area-inset-bottom));
        z-index: 1700 !important;
      }
      .tracky-calques-panel.tracky-mobile-sheet--open {
        transform: translate3d(0, var(--sheet-drag-y, 0px), 0);
      }
      .tracky-calques-inner {
        border-radius: 20px 20px 0 0 !important;
        max-height: calc(85vh - env(safe-area-inset-bottom));
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
  `],
})
export class MapComponent implements AfterViewInit, OnDestroy {
  protected readonly realtime = inject(RealtimeService);
  protected readonly styles = inject(MapStyleService);
  private readonly geofencesApi = inject(GeofencesApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly preferences = inject(PreferencesService);
  private readonly mapSvc = inject(MapService);
  private readonly engineControl = inject(EngineControlService);
  private readonly visibility = inject(VisibilityService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);

  private readonly mapContainerRef = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');

  private map: MlMap | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private markers = new Map<string, MarkerEntry>();
  private vehicleMeta = new Map<string, VehicleMeta>();
  private trailPoints = new Map<string, Array<[number, number]>>();
  private hasFittedBounds = false;
  private currentPopup: Popup | null = null;
  private activePopupTrackerId: string | null = null;
  private activePopupVehicleId: string | null = null;

  /** Etat d'interpolation par trackerId : permet animation fluide entre 2 events WS. */
  private interp = new Map<string, InterpState>();
  /** Derniere data de marker connue (pour update du DOM pendant interpolation). */
  private lastMarkerData = new Map<string, VehicleMarkerData>();
  private animFrameId: number | null = null;

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
    const snap = this.realtime.snapshot();
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
  /** Mobile : overlay de recherche déployable depuis la top bar. */
  protected readonly mobileSearchOpen = signal(false);
  /** Picker véhicule pour les modes Suivre/Sens. */
  protected readonly vehiclePickerOpen = signal(false);
  /** Mode caméra cible en attente de sélection véhicule. */
  protected readonly pendingCameraMode = signal<CameraMode | null>(null);
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

  protected readonly filteredPositionCount = computed(() => {
    const ids = this._accessibleIds();
    return ids === 'ALL'
      ? this.realtime.positionsList().length
      : this.realtime.positionsList().filter((p) => (ids as Set<string>).has(p.vehicleId)).length;
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

  // Reagir aux events ENGINE_COMMAND_UPDATED (CUT/RESTORE via SMS, scheduler, etc.)
  // pour rafraichir le popup ouvert et mettre a jour l'etat ignition affiche.
  private engineCommandEffect = effect(() => {
    const updates = this.realtime.engineCommandUpdates();
    if (!this.activePopupTrackerId || !this.currentPopup) return;
    const update = updates.get(this.activePopupTrackerId);
    if (!update) return;
    const pos = this.realtime.positionsList().find((p) => p.trackerId === this.activePopupTrackerId);
    if (!pos) return;
    this.currentPopup.setHTML(this.buildPopupHtml(this.patchIgnitionFromCommands(pos)));
    setTimeout(() => this.wirePopupActions(this.activePopupTrackerId!, this.activePopupVehicleId!), 0);
  });

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
      this.vehicleMeta.set(v.vehicleId, { type: v.type, plate: v.plate });
    }

    // Recupere aussi depuis /api/vehicles pour les types manquants (ex : si snapshot vide).
    firstValueFrom(this.vehiclesApi.list()).then((vehicles) => {
      this._accessibleIds.set(new Set(vehicles.map((v) => v.id)));
      vehicles.forEach((v) => {
        const cast = v as VehicleDetailDto & { type?: string };
        this.vehicleMeta.set(v.id, { type: cast.type ?? 'OTHER', plate: v.plate });
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

    // Quand l'utilisateur drag manuellement en mode follow, sortir du mode.
    this.map.on('dragstart', () => {
      if (this.cameraMode() !== 'free') {
        this.setCameraMode('free');
      }
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

    // Setup sources/layers de base apres `load`.
    this.map.on('load', () => {
      this.setupGeofencesLayer();
      this.setupTrailsLayer();
      this.setupMiniReplayLayer();
      this.setupMeasureLayer();
      this.setupStopsLayer();
      this.setupHeatmapLayer();
      this.setupClusterLayer();
      this.loadGeofences();
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
      this.applyClusterVisibility();
      this.restoreFromUrl();
    });

    // Sprint G.2 — refresh cluster visibility on zoom change.
    // V1.7 : 'zoomend' au lieu de 'zoom' pour ne fire qu'une seule fois en
    // fin de geste (au lieu de 60Hz pendant le zoom utilisateur). Combine
    // a la transition CSS sur transform:scale (au lieu de width/height),
    // les markers ne derivent plus visuellement pendant le zoom.
    this.map.on('zoomend', () => this.applyClusterVisibility());

    // Click pour la mesure de distance.
    this.map.on('click', (e) => {
      this.closeContextMenu();
      if (this.measureMode()) {
        const pts = [...this.measurePoints(), { lat: e.lngLat.lat, lng: e.lngLat.lng }];
        this.measurePoints.set(pts);
        this.refreshMeasureLayer();
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(container);

    // Boucle d'animation pour l'interpolation des markers (Sprint C).
    this.startAnimLoop();
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

    this.markers.forEach((m) => m.marker.remove());
    this.markers.clear();
    this.trailPoints.clear();
    this.interp.clear();
    this.lastMarkerData.clear();

    this.currentPopup?.remove();
    this.currentPopup = null;

    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  /**
   * Boucle d'interpolation : a chaque RAF, fait avancer chaque marker en cours
   * d'interpolation. Une trame WS Coban arrive toutes les ~30s ; on glisse le
   * marker sur cette duree pour eviter les teleports.
   *
   * V1.5 (Sprint H2) : skip total du travail si l'onglet est cache. Le RAF
   * reste enchaine pour pouvoir reprendre instantanement au retour, mais la
   * mutation des markers et le suivi camera sont court-circuites.
   */
  private startAnimLoop(): void {
    const tick = (now: number) => {
      this.animFrameId = requestAnimationFrame(tick);
      if (!this.visibility.isVisible()) return;
      if (this.interp.size === 0) return;

      const followedVid = this.followedVehicleId();
      const camMode = this.cameraMode();

      for (const [trackerId, st] of this.interp) {
        const t = Math.min(1, (now - st.startedAt) / st.durationMs);
        const lat = lerp(st.fromLat, st.toLat, t);
        const lng = lerp(st.fromLng, st.toLng, t);
        const heading = lerpHeading(st.fromHeading, st.toHeading, t);

        const entry = this.markers.get(trackerId);
        if (entry) {
          entry.marker.setLngLat([lng, lat]);
          const data = this.lastMarkerData.get(trackerId);
          if (data) {
            updateVehicleMarkerEl(entry.el, { ...data, heading });
          }
        }

        // Si on suit ce vehicule, faire suivre la camera en douceur (sans animation
        // MapLibre supplementaire — on copie la position interpolee directement).
        if (this.map && (camMode === 'follow' || camMode === 'heading-up' || camMode === 'chase')) {
          const data = this.lastMarkerData.get(trackerId);
          if (data && data.vehicleId === followedVid) {
            this.map.jumpTo({
              center: [lng, lat],
              bearing: (camMode === 'heading-up' || camMode === 'chase') ? heading : this.map.getBearing(),
            });
          }
        }

        if (t >= 1) this.interp.delete(trackerId);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  /* --- Camera & view --- */

  protected centerAll(): void {
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
    const points = Array.from(this.markers.values()).map((m) => {
      const ll = m.marker.getLngLat();
      return { lat: ll.lat, lng: ll.lng };
    });
    this.mapSvc.fitBounds(this.map, points, { padding: 70, maxZoom: 15 });
  }

  protected setStyle(id: MapStyleId): void {
    if (!this.map) return;
    this.currentStyle.set(id);
    this.preferences.update({ map: { ...this.preferences.prefs().map, style: id } });
    this.mapSvc.setStyle(this.map, id);
    // Mobile : on ferme la sheet pour que l'utilisateur voit le résultat tout de suite.
    if (this.mobileSheetOpen() && window.matchMedia('(max-width: 767px)').matches) {
      this.mobileSheetOpen.set(false);
    }
    // Apres setStyle, les sources custom (geofences/trails) sont perdues — on les recree.
    this.map.once('styledata', () => {
      this.setupGeofencesLayer();
      this.setupTrailsLayer();
      this.setupMiniReplayLayer();
      this.setupMeasureLayer();
      this.setupStopsLayer();
      this.setupHeatmapLayer();
      this.setupClusterLayer();
      this.loadGeofences();
      this.applyPositions(this.applyFilters(this.realtime.positionsList()));
      this.applyClusterVisibility();
      // Mini-replay : si actif, recharger.
      const vid = this.miniReplayVehicleId();
      if (vid) this.loadMiniReplay(vid).catch(() => { /* silent */ });
      this.refreshMeasureLayer();
      if (this.showStops()) this.loadStops().catch(() => { /* silent */ });
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

    if (this.lastMiniState === mini) {
      // Pas de transition d'etat hysteresis, mais le toggle compactMarkers
      // peut avoir change : on s'assure que la classe DOM reflete useMini.
      document.querySelectorAll('.tracky-marker').forEach((el) => {
        (el as HTMLElement).classList.toggle('tracky-marker--mini', useMini);
      });
      this.setLayerVisibility('vehicles-cluster-bg', useMini);
      this.setLayerVisibility('vehicles-cluster-count', useMini);
      this.setLayerVisibility('vehicles-unclustered', useMini);
      return;
    }
    this.lastMiniState = mini;

    document.querySelectorAll('.tracky-marker').forEach((el) => {
      (el as HTMLElement).classList.toggle('tracky-marker--mini', useMini);
    });
    this.setLayerVisibility('vehicles-cluster-bg', useMini);
    this.setLayerVisibility('vehicles-cluster-count', useMini);
    this.setLayerVisibility('vehicles-unclustered', useMini);
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
    const list = this.realtime.positionsList();
    if (list.length === 0) return;
    const target = list[this.cinemaIndex % list.length]!;
    this.cinemaIndex++;
    this.followedVehicleId.set(target.vehicleId);
    this.map.flyTo({ center: [target.lng, target.lat], zoom: 16, duration: 1500 });
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
    this.followedVehicleId.set(vehicleId);
    const targetMode = this.pendingCameraMode() ?? 'follow';
    this.cameraMode.set(targetMode);
    this.preferences.update({ map: { ...this.preferences.prefs().map, cameraMode: targetMode } });
    this.vehiclePickerOpen.set(false);
    this.pendingCameraMode.set(null);
    this.applyCameraMode();
    // Mobile : on ferme la sheet pour que l'utilisateur voit la carte
    if (window.matchMedia('(max-width: 767px)').matches) {
      this.mobileSheetOpen.set(false);
    }
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
    const pos = this.realtime.positionsList().find((p) => p.vehicleId === id);
    if (!pos) return;

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
    return positions.filter((p) => {
      const ageMin = (now - new Date(p.timestamp).getTime()) / 60000;
      if (ageMin > 10) return f.offline;
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
    this.setLayerVisibility('stops-circle', v);
    this.setLayerVisibility('stops-label', v);
    if (v) this.loadStops().catch(() => { /* silent */ });
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
              this.maybePushStopFeature(features, clusterStart, items[i - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS);
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
            this.maybePushStopFeature(features, clusterStart, items[i - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS);
            clusterStart = null;
            clusterCount = 0;
          }
        }
        // Cluster final
        if (clusterStart) {
          this.maybePushStopFeature(features, clusterStart, items[items.length - 1]!, clusterCenterLat, clusterCenterLng, STOP_MIN_DURATION_MS);
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
  ): void {
    const dur = new Date(end.timestamp).getTime() - new Date(start.timestamp).getTime();
    if (dur < minDurationMs) return;
    const minutes = Math.round(dur / 60000);
    const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}min`;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { duration: label, startedAt: start.timestamp },
    });
  }

  protected togglePlates(): void {
    const v = !this.showPlates();
    this.showPlates.set(v);
    this.preferences.update({ map: { ...this.preferences.prefs().map, showPlates: v } });
    document.querySelectorAll('.tracky-marker').forEach((el) => {
      el.classList.toggle('tracky-marker--no-plate', !v);
    });
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
    this.map.addSource('vehicles-cluster', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterMaxZoom: 13,
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
        'circle-opacity': 0.9,
        'circle-stroke-width': 3,
        'circle-stroke-color': '#0a0a0a',
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
      paint: { 'text-color': '#0a0a0a' },
    });
    // Layer pour les points individuels (non regroupes en cluster) — visible a faible zoom.
    this.map.addLayer({
      id: 'vehicles-unclustered',
      type: 'circle',
      source: 'vehicles-cluster',
      filter: ['!', ['has', 'point_count']],
      layout: { visibility: 'none' },
      paint: {
        'circle-color': '#10E0A0',
        'circle-radius': 7,
        'circle-opacity': 0.95,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0a0a0a',
      },
    });
    // Click sur cluster = zoom in.
    this.map.on('click', 'vehicles-cluster-bg', (e) => {
      if (!this.map) return;
      const feat = e.features?.[0];
      const clusterId = feat?.properties?.['cluster_id'];
      if (clusterId == null) return;
      const src = this.map.getSource('vehicles-cluster') as maplibregl.GeoJSONSource;
      Promise.resolve(src.getClusterExpansionZoom(clusterId)).then((zoom: number) => {
        if (!this.map) return;
        const geom = feat?.geometry as GeoJSON.Point | undefined;
        if (!geom) return;
        this.map.flyTo({ center: geom.coordinates as [number, number], zoom, speed: 1.4, curve: 1.4 });
      });
    });
    // Click sur point individuel non-cluster = centrer et zoomer sur le vehicule.
    this.map.on('click', 'vehicles-unclustered', (e) => {
      if (!this.map) return;
      const feat = e.features?.[0];
      const geom = feat?.geometry as GeoJSON.Point | undefined;
      if (!geom) return;
      this.map.flyTo({ center: geom.coordinates as [number, number], zoom: 15, speed: 1.4, curve: 1.4 });
    });
    // Curseur pointer sur les points individuels et clusters.
    for (const layer of ['vehicles-cluster-bg', 'vehicles-unclustered']) {
      this.map.on('mouseenter', layer, () => { if (this.map) this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layer, () => { if (this.map) this.map.getCanvas().style.cursor = ''; });
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

  /** Sprint F.1 — setup layer pour les stop markers (pictos P aux arrets > 5min). */
  private setupStopsLayer(): void {
    if (!this.map || this.map.getSource('stops')) return;
    this.map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({
      id: 'stops-circle',
      type: 'circle',
      source: 'stops',
      paint: {
        'circle-radius': 14,
        'circle-color': '#1f2937',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fbbf24',
        'circle-opacity': 0.9,
      },
    });
    this.map.addLayer({
      id: 'stops-label',
      type: 'symbol',
      source: 'stops',
      layout: {
        'text-field': 'P',
        'text-size': 14,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#fbbf24',
        'text-halo-color': '#1f2937',
        'text-halo-width': 1,
      },
    });
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

    const activeIds = new Set<string>();
    const trailFeatures: Array<GeoJSON.Feature<GeoJSON.LineString, { color: string; trackerId: string }>> = [];
    const followedId = this.followedVehicleId();
    const trailLength = this.preferences.prefs().map.trailLength;
    const showTrails = this.showTrails();
    const hydratedSet = this.realtime.hydratedTrackerIds();
    const showPlatesNow = this.showPlates();

    // Pre-calculer le map des engine command updates pour patcher les markers.
    const engineUpdates = this.realtime.engineCommandUpdates();

    for (const pos of positions) {
      activeIds.add(pos.trackerId);
      const meta = this.vehicleMeta.get(pos.vehicleId) ?? { type: 'OTHER', plate: '' };
      // Patcher l'ignition du marker avec l'etat commande moteur (meme logique que popup).
      const patched = this.patchIgnitionFromCommands(pos);
      const data: VehicleMarkerData = {
        trackerId: pos.trackerId,
        vehicleId: pos.vehicleId,
        type: meta.type,
        plate: meta.plate,
        speedKmh: pos.speedKmh,
        heading: pos.heading,
        ignition: patched.ignition,
        active: pos.vehicleId === followedId,
        hydrated: hydratedSet.has(pos.trackerId),
      };

      let entry = this.markers.get(pos.trackerId);
      if (!entry) {
        const el = buildVehicleMarkerEl(data);
        if (!showPlatesNow) el.classList.add('tracky-marker--no-plate');
        const marker = attachVehicleMarker(this.map, el, pos.lat, pos.lng);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.openMarkerPopup(pos.trackerId);
        });
        el.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          this.followedVehicleId.set(pos.vehicleId);
          if (this.cameraMode() === 'free') this.setCameraMode('follow');
          else this.applyCameraMode();
        });
        entry = { marker, el };
        this.markers.set(pos.trackerId, entry);
      } else {
        // Demarrer une interpolation depuis la position courante (lue sur le marker)
        // vers la nouvelle position WS. Anime sur ~28s pour eviter les teleports
        // entre deux trames Coban (cf. spec Sprint C — chantier 3 du roadmap).
        const cur = entry.marker.getLngLat();
        const lastData = this.lastMarkerData.get(pos.trackerId);
        const fromHeading = lastData?.heading ?? pos.heading;
        const isHydrated = data.hydrated === true;
        if (isHydrated || !lastData) {
          // Premier rendu (hydratation ou nouveau tracker) : positionner direct, pas d'anim.
          entry.marker.setLngLat([pos.lng, pos.lat]);
          updateVehicleMarkerEl(entry.el, data);
        } else {
          this.interp.set(pos.trackerId, {
            fromLat: cur.lat, fromLng: cur.lng, fromHeading,
            toLat: pos.lat, toLng: pos.lng, toHeading: pos.heading,
            startedAt: performance.now(), durationMs: INTERP_DURATION_MS,
          });
          // Update les attributs non-positionnels (couleur, ACC, plaque, active)
          // immediatement pour qu'ils refletent le nouvel etat sans attendre l'anim.
          updateVehicleMarkerEl(entry.el, { ...data, heading: fromHeading });
        }
      }
      this.lastMarkerData.set(pos.trackerId, data);

      // Trail accumulation (en memoire, capee a trailLength).
      if (showTrails) {
        let pts = this.trailPoints.get(pos.trackerId);
        if (!pts) {
          pts = [];
          this.trailPoints.set(pos.trackerId, pts);
        }
        pts.push([pos.lng, pos.lat]);
        while (pts.length > trailLength) pts.shift();

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
            properties: { color: speedColor(pos.speedKmh), trackerId: pos.trackerId },
          });
        }
      }
    }

    // Remove disappeared markers.
    for (const [id, entry] of this.markers) {
      if (!activeIds.has(id)) {
        entry.marker.remove();
        this.markers.delete(id);
        this.trailPoints.delete(id);
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
      if (isDefaultCenter) this.centerAll();
    }

    // Camera follow sur le vehicule actif.
    if (this.cameraMode() !== 'free') {
      this.applyCameraMode();
    }

    // Update popover content si ouvert — re-wire les boutons apres remplacement DOM.
    if (this.activePopupTrackerId && this.activePopupVehicleId && this.currentPopup) {
      const pos = positions.find((p) => p.trackerId === this.activePopupTrackerId);
      if (pos) {
        this.currentPopup.setHTML(this.buildPopupHtml(this.patchIgnitionFromCommands(pos)));
        setTimeout(() => this.wirePopupActions(this.activePopupTrackerId!, this.activePopupVehicleId!), 0);
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
    const update = this.realtime.engineCommandUpdates().get(trackerId);
    if (!update) return false;
    if (update.action !== 'CUT') return false;
    return update.status === 'SENT' || update.status === 'ACKNOWLEDGED';
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
    if (update.status === 'ACKNOWLEDGED' || update.status === 'SENT') {
      if (update.action === 'CUT' && pos.ignition) {
        return { ...pos, ignition: false };
      }
      if (update.action === 'RESTORE' && !pos.ignition) {
        return { ...pos, ignition: true };
      }
    }
    return pos;
  }

  private openMarkerPopup(trackerId: string): void {
    const pos = this.realtime.positionsList().find((p) => p.trackerId === trackerId);
    if (!pos || !this.map) return;

    this.closePopup();
    const html = this.buildPopupHtml(this.patchIgnitionFromCommands(pos));
    this.currentPopup = new maplibregl.Popup({
      anchor: 'bottom',
      offset: 30,
      maxWidth: '320px',
      closeOnClick: false,
    })
      .setLngLat([pos.lng, pos.lat])
      .setHTML(html)
      .addTo(this.map);
    this.activePopupTrackerId = trackerId;
    this.activePopupVehicleId = pos.vehicleId;

    // Wire les boutons du popover (delegation event).
    setTimeout(() => this.wirePopupActions(trackerId, pos.vehicleId), 0);

    this.currentPopup.on('close', () => {
      this.activePopupTrackerId = null;
      this.activePopupVehicleId = null;
      this.currentPopup = null;
    });
  }

  private buildPopupHtml(pos: PositionUpdateEvent): string {
    const meta = this.vehicleMeta.get(pos.vehicleId) ?? { type: 'OTHER', plate: '?' };
    const ago = Math.round((Date.now() - new Date(pos.timestamp).getTime()) / 1000);
    const agoStr = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}min`;
    // V1.7 — Logique CUT/RESTORE basee sur l'etat des COMMANDES, plus sur
    // l'ignition. Raison : avec accConnected=false, l'ignition est inferee et
    // peut transitoirement etre fausse (vehicule a 0 km/h moteur encore tournant
    // pendant 5 min, ou trame ACC perdue). On propose "Rallumer" UNIQUEMENT
    // quand une CUT effective est en cours. Sinon on garde "Couper" (l'API
    // refusera si vitesse trop elevee, position stale, etc.).
    const cutActive = this.isCutActiveForTracker(pos.trackerId);
    const engineBtn = cutActive
      ? `<button data-action="restore" class="tk-popup-btn tk-popup-btn--success">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
           </svg>
           <span>Rallumer le moteur</span>
         </button>`
      : `<button data-action="cut" class="tk-popup-btn tk-popup-btn--danger">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
           </svg>
           <span>Couper le moteur</span>
         </button>`;

    // Couleur de la pastille vitesse selon le seuil
    const speedColor = pos.speedKmh > 90 ? '#ef4444' :
                       pos.speedKmh > 50 ? '#f59e0b' :
                       pos.speedKmh > 0  ? '#10E0A0' : 'var(--text-tertiary)';

    return `
      <div class="tk-popup">
        <div class="tk-popup-header">
          <div class="tk-popup-header-text">
            <div class="tk-popup-plate">${escapeHtml(meta.plate)}</div>
            <div class="tk-popup-meta">${escapeHtml(meta.type)} · il y a ${agoStr}</div>
          </div>
          <div class="tk-popup-status ${pos.ignition ? 'is-on' : 'is-off'}">
            <span class="tk-popup-status-dot"></span>
            ${pos.ignition ? 'Contact ON' : 'Contact OFF'}
          </div>
        </div>

        <div class="tk-popup-stats">
          <div class="tk-popup-stat">
            <span class="tk-popup-stat-label">Vitesse</span>
            <span class="tk-popup-stat-value" style="color:${speedColor}">${pos.speedKmh.toFixed(0)} <small>km/h</small></span>
          </div>
          <div class="tk-popup-stat">
            <span class="tk-popup-stat-label">Cap</span>
            <span class="tk-popup-stat-value">${Math.round(pos.heading)}°</span>
          </div>
        </div>

        <div class="tk-popup-coords">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          ${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}
        </div>

        <div class="tk-popup-actions">
          <button data-action="follow" class="tk-popup-btn tk-popup-btn--primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="3 11 22 2 13 21 11 13 3 11"/>
            </svg>
            <span>Suivre ce véhicule</span>
          </button>
          <button data-action="detail" class="tk-popup-btn tk-popup-btn--ghost">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span>Fiche détaillée</span>
          </button>
          <button data-action="replay1h" class="tk-popup-btn tk-popup-btn--info">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span>Voir la dernière heure</span>
          </button>
          ${engineBtn}
        </div>
      </div>
    `;
  }

  private wirePopupActions(trackerId: string, vehicleId: string): void {
    const root = this.currentPopup?.getElement();
    if (!root) return;
    root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
      const action = btn.dataset['action'];
      btn.addEventListener('click', () => {
        switch (action) {
          case 'follow':
            this.followedVehicleId.set(vehicleId);
            if (this.cameraMode() === 'free') this.setCameraMode('follow');
            else this.applyCameraMode();
            this.closePopup();
            break;
          case 'detail':
            this.router.navigate(['/vehicles', vehicleId]);
            break;
          case 'replay1h':
            this.toggleMiniReplay(vehicleId);
            this.closePopup();
            break;
          case 'cut':
            this.requestEngine(trackerId, 'CUT');
            break;
          case 'restore':
            this.requestEngine(trackerId, 'RESTORE');
            break;
        }
      });
    });
  }

  private requestEngine(trackerId: string, action: 'CUT' | 'RESTORE'): void {
    const verb = action === 'CUT' ? 'couper' : 'restaurer';
    const ok = window.confirm(
      `Confirmer ${verb} le moteur du vehicule ?\n\n` +
        'Cette action est tracee dans l\'audit trail. Annulez si pas certain.',
    );
    if (!ok) return;

    this.engineControl.requestCommand(trackerId, action, 'depuis carte').subscribe({
      next: () => {
        this.toast.show({
          kind: 'info',
          title: action === 'CUT' ? 'Coupure demandee' : 'Restauration demandee',
          message: `Commande ${action} envoyee.`,
          duration: 4000,
        });
        this.closePopup();
      },
      error: (err) => {
        this.toast.show({
          kind: 'error',
          title: 'Echec commande moteur',
          message: err?.error?.message ?? 'Erreur inconnue',
          duration: 6000,
        });
      },
    });
  }

  private closePopup(): void {
    this.currentPopup?.remove();
    this.currentPopup = null;
    this.activePopupTrackerId = null;
    this.activePopupVehicleId = null;
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;',
  );
}

/**
 * Construit un Polygon GeoJSON approximant un cercle (64 segments) autour
 * d'un centre lat/lng et rayon en metres. Utilise pour les geofences.
 */
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
