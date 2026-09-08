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
 *
 * ⚠️ PLUS AUCUNE TUILE CARTO. Mesuré en production le 2026-09-08 : « Plan clair », « Plan
 * sombre » et les libellés de l'hybride venaient de basemaps.cartocdn.com, dont chaque tuile
 * porte désormais le filigrane « API KEY REQUIRED » en travers de la carte. Les fonds gris
 * d'Esri (Light / Dark Gray Canvas) rendent le même service — un plan neutre qui laisse les
 * véhicules au premier plan — sans clé, jusqu'au zoom 16 ; leur calque de référence apporte
 * les noms de villes et de rues. Vérifié tuile par tuile avant le remplacement.
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
      tilesUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      overlayUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
      maxZoom: 16,
      darkUI: true,
    },
    {
      id: 'light',
      label: 'Plan clair',
      tilesUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      overlayUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
      maxZoom: 16,
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
      overlayUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
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
