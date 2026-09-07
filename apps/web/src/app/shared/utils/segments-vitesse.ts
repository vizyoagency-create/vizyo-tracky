import { couleurVitesse } from './couleurs-carte';

/**
 * Un tracé coloré PAR LA VITESSE, pour toutes les cartes qui rejouent un trajet.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI DES SEGMENTS, ET POURQUOI FUSIONNÉS                               │
 * │                                                                            │
 * │ MapLibre colore une couche `line` par expression, pas par point : une      │
 * │ seule `LineString` ne peut avoir qu'une couleur. Le tracé devient donc     │
 * │ une collection de tronçons, chacun portant `properties.color`, et la       │
 * │ couche lit `['get', 'color']`.                                             │
 * │                                                                            │
 * │ Un tronçon par PAIRE de points ferait 1 500 entités sur un trajet écrêté   │
 * │ (`trip-share.service.ts` écrête à 1 500) — pour rien : deux tronçons de la │
 * │ même bande se dessinent pareil. On fusionne donc les points consécutifs de │
 * │ même bande en une seule `LineString`, et chaque changement de bande        │
 * │ RÉPÈTE le point frontière, sinon la ligne aurait un trou à chaque          │
 * │ changement de couleur.                                                     │
 * │                                                                            │
 * │ La vitesse d'un tronçon est celle de son point d'ARRIVÉE : une trame GPS   │
 * │ porte la vitesse mesurée au moment du relevé, c'est-à-dire celle du        │
 * │ mouvement qui y a mené.                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Les types sont écrits ici plutôt qu'importés de `geojson` : ce que MapLibre attend
 * (`setData`) est structurel, et l'application n'a nulle part ailleurs de dépendance
 * sur ce paquet de types.
 */
export interface PointVitesse {
  readonly lng: number;
  readonly lat: number;
  /** Vitesse instantanée en km/h. Absente ou invalide : le tronçon est « à l'arrêt ». */
  readonly speedKmh: number;
}

export interface SegmentColore {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'LineString'; readonly coordinates: [number, number][] };
  readonly properties: { readonly color: string };
}

export interface SegmentsColores {
  readonly type: 'FeatureCollection';
  readonly features: SegmentColore[];
}

/** Ce que doit poser la couche : la couleur est SUR le tronçon, et rien d'autre ne la décide. */
export const LINE_COLOR_SEGMENTS: ['get', 'color'] = ['get', 'color'];

export function segmentsColores(points: readonly PointVitesse[]): SegmentsColores {
  const features: SegmentColore[] = [];
  if (points.length < 2) return { type: 'FeatureCollection', features };

  let couleur = couleurVitesse(points[1].speedKmh);
  let coords: [number, number][] = [
    [points[0].lng, points[0].lat],
    [points[1].lng, points[1].lat],
  ];

  for (let i = 2; i < points.length; i++) {
    const c = couleurVitesse(points[i].speedKmh);
    const p: [number, number] = [points[i].lng, points[i].lat];
    if (c === couleur) {
      coords.push(p);
      continue;
    }
    features.push(troncon(coords, couleur));
    couleur = c;
    // Le point frontière appartient aux deux tronçons : pas de trou entre deux couleurs.
    coords = [coords[coords.length - 1], p];
  }
  features.push(troncon(coords, couleur));
  return { type: 'FeatureCollection', features };
}

function troncon(coordinates: [number, number][], color: string): SegmentColore {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { color } };
}
