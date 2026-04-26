import { Injectable, NgZone, inject } from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, StyleSpecification } from 'maplibre-gl';
import { MapStyleService, type MapStyleDef, type MapStyleId } from './map-style.service';

/**
 * Map service Tracky : abstraction MapLibre GL JS adaptee au suivi flotte.
 *
 * Inspire de `MapService` de mahlem-now (`D:/www/mahlem-now/libs/platform/src/lib/map.service.ts`)
 * mais etendu pour :
 * - changement de style raster a chaud (multi-fonds)
 * - markers HTMLElement avec heading rotatif (rotationAlignment 'map')
 * - gestion polylignes / cercles geofences via sources GeoJSON
 *
 * Convention : API publique en `{ lat, lng }`. Conversion vers `[lng, lat]`
 * MapLibre faite en interne au moment des appels.
 */
export interface CreateMapOpts {
  center: { lat: number; lng: number };
  zoom: number;
  style: MapStyleId;
  bearing?: number;
  pitch?: number;
  withNavigationControl?: boolean;
  withGeolocateControl?: boolean;
  withScaleControl?: boolean;
}

@Injectable({ providedIn: 'root' })
export class MapService {
  private readonly zone = inject(NgZone);
  private readonly styles = inject(MapStyleService);

  /** Construit la spec de style MapLibre a partir d'un fond de carte du catalog. */
  buildStyleSpec(styleId: MapStyleId): StyleSpecification {
    const def = this.styles.byId(styleId);
    return this.buildStyleFromDef(def);
  }

  private buildStyleFromDef(def: MapStyleDef): StyleSpecification {
    const tiles = this.styles.expandSubdomains(def.tilesUrl);
    const sources: StyleSpecification['sources'] = {
      base: {
        type: 'raster',
        tiles,
        tileSize: 256,
        attribution: def.attribution,
        maxzoom: def.maxZoom,
      },
    };
    const layers: StyleSpecification['layers'] = [
      { id: 'base', type: 'raster', source: 'base' },
    ];
    if (def.overlayUrl) {
      const overlayTiles = this.styles.expandSubdomains(def.overlayUrl);
      sources['overlay'] = {
        type: 'raster',
        tiles: overlayTiles,
        tileSize: 256,
        maxzoom: def.maxZoom,
      };
      layers.push({ id: 'overlay', type: 'raster', source: 'overlay' });
    }
    return {
      version: 8,
      sources,
      layers,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    };
  }

  createMap(el: HTMLElement, opts: CreateMapOpts): MlMap {
    return this.zone.runOutsideAngular(() => {
      const map = new maplibregl.Map({
        container: el,
        style: this.buildStyleSpec(opts.style),
        center: [opts.center.lng, opts.center.lat],
        zoom: opts.zoom,
        bearing: opts.bearing ?? 0,
        pitch: opts.pitch ?? 0,
        dragRotate: true,
        touchPitch: true,
        touchZoomRotate: true,
        attributionControl: { compact: true },
      });

      if (opts.withNavigationControl !== false) {
        map.addControl(
          new maplibregl.NavigationControl({
            showCompass: true,
            showZoom: true,
            visualizePitch: true,
          }),
          'bottom-right',
        );
      }
      if (opts.withGeolocateControl !== false) {
        map.addControl(
          new maplibregl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true, timeout: 8_000 },
            trackUserLocation: false,
            showAccuracyCircle: true,
            showUserLocation: true,
          }),
          'bottom-right',
        );
      }
      if (opts.withScaleControl !== false) {
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      }

      return map;
    });
  }

  /** Change de fond a chaud sans recreer la carte ni perdre l'etat zoom/pitch/bearing. */
  setStyle(map: MlMap, styleId: MapStyleId): void {
    this.zone.runOutsideAngular(() => {
      map.setStyle(this.buildStyleSpec(styleId), { diff: false });
    });
  }

  flyTo(map: MlMap, lat: number, lng: number, zoom?: number): void {
    this.zone.runOutsideAngular(() => {
      map.flyTo({
        center: [lng, lat],
        zoom: zoom ?? map.getZoom(),
        speed: 1.4,
        curve: 1.4,
        essential: true,
      });
    });
  }

  panTo(map: MlMap, lat: number, lng: number, durationMs = 600): void {
    this.zone.runOutsideAngular(() => {
      map.easeTo({ center: [lng, lat], duration: durationMs });
    });
  }

  /** Reset bearing + pitch a 0, anime sur 400ms. */
  resetNorth(map: MlMap, durationMs = 400): void {
    this.zone.runOutsideAngular(() => {
      map.easeTo({ bearing: 0, pitch: 0, duration: durationMs });
    });
  }

  /** Aligne le bearing de la carte sur un heading vehicule (rotation cible 0deg = nord en haut). */
  setBearing(map: MlMap, heading: number, durationMs = 600): void {
    this.zone.runOutsideAngular(() => {
      map.easeTo({ bearing: heading, duration: durationMs });
    });
  }

  fitBounds(
    map: MlMap,
    points: Array<{ lat: number; lng: number }>,
    opts: { padding?: number; maxZoom?: number; animate?: boolean } = {},
  ): void {
    if (points.length === 0) return;
    this.zone.runOutsideAngular(() => {
      let west = points[0]!.lng,
        east = points[0]!.lng,
        south = points[0]!.lat,
        north = points[0]!.lat;
      for (const p of points) {
        if (p.lng < west) west = p.lng;
        if (p.lng > east) east = p.lng;
        if (p.lat < south) south = p.lat;
        if (p.lat > north) north = p.lat;
      }
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        {
          padding: opts.padding ?? 60,
          maxZoom: opts.maxZoom ?? 16,
          animate: opts.animate !== false,
          duration: 500,
        },
      );
    });
  }
}
