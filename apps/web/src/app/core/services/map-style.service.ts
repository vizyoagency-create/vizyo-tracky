import { Injectable } from '@angular/core';

/**
 * Identifiant d'un fond de carte. Stocke dans `PreferencesService.prefs.map.style`.
 */
export type MapStyleId =
  | 'osm'
  | 'dark'
  | 'light'
  | 'satellite'
  | 'hybrid'
  | 'topo';

export interface MapStyleDef {
  id: MapStyleId;
  label: string;
  /** URL des tuiles raster, avec subdomain `{s}` ou `{a-c}` ou rien selon provider. */
  tilesUrl: string;
  /** Fournisseurs supplementaires pour overlay (hybride). */
  overlayUrl?: string;
  attribution: string;
  maxZoom: number;
  /** Pour les fonds sombres : forcer le mode dark de l'app. */
  darkUI?: boolean;
}

/**
 * Catalog des fonds de carte disponibles dans Tracky V1.4.
 * Tous gratuits, sans cle API. Chaque entree a une URL raster compatible MapLibre.
 */
@Injectable({ providedIn: 'root' })
export class MapStyleService {
  readonly catalog: ReadonlyArray<MapStyleDef> = [
    {
      id: 'osm',
      label: 'Plan',
      tilesUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    },
    {
      id: 'dark',
      label: 'Plan sombre',
      tilesUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      attribution: '&copy; OpenStreetMap, &copy; CARTO',
      maxZoom: 20,
      darkUI: true,
    },
    {
      id: 'light',
      label: 'Plan clair',
      tilesUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      attribution: '&copy; OpenStreetMap, &copy; CARTO',
      maxZoom: 20,
    },
    {
      id: 'satellite',
      label: 'Satellite',
      tilesUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19,
      darkUI: true,
    },
    {
      id: 'hybrid',
      label: 'Hybride',
      tilesUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      overlayUrl: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}@2x.png',
      attribution: 'Tiles &copy; Esri, Labels &copy; CARTO',
      maxZoom: 19,
      darkUI: true,
    },
    {
      id: 'topo',
      label: 'Topographique',
      tilesUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
    },
  ];

  byId(id: MapStyleId | undefined | null): MapStyleDef {
    return this.catalog.find((s) => s.id === id) ?? this.catalog[0]!;
  }

  /** URL prete a l'emploi pour MapLibre : remplace `{s}` par les sous-domaines. */
  expandSubdomains(url: string): string[] {
    if (!url.includes('{s}')) return [url];
    return ['a', 'b', 'c'].map((s) => url.replace('{s}', s));
  }
}
