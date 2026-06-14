import { distanceMeters } from '../common/utils/haversine';

/**
 * V1.5 (Sprint N) — Geometry pour les geofences CORRIDOR.
 *
 * Un corridor = polyligne ordonnee + largeur (buffer perpendiculaire).
 * Le test "point dans corridor" se ramene a "min(distance perpendiculaire
 * a chaque segment) < widthM/2" — le corridor est symetrique de part et d'autre
 * de la polyligne.
 *
 * Implementation : projection scalaire sur chaque segment, clamp [0,1], puis
 * distance haversine entre le point et la projection. On reste dans le repere
 * lat/lng (projection equirectangulaire approximee), ce qui est suffisant
 * tant que le corridor fait < 200km de long.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Returns true if `point` is within `widthM / 2` meters of any segment of the
 * polyline `points`.
 */
export function isInsideCorridor(
  point: LatLng,
  points: LatLng[],
  widthM: number,
): boolean {
  if (points.length < 2 || widthM <= 0) return false;
  const halfWidth = widthM / 2;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distancePointToSegment(point, points[i]!, points[i + 1]!);
    if (d < min) min = d;
    if (min < halfWidth) return true;
  }
  return min < halfWidth;
}

/**
 * Closest distance (meters) from `p` to the segment [a, b].
 * Uses local equirectangular projection — accurate to ~0.5% at <200km, more
 * than enough for fleet corridor tolerance (typical width 50-300m).
 */
export function distancePointToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  // Convert to a flat 2D plane centered at `a`. 1 deg lat = 111_320 m,
  // 1 deg lng depends on cos(lat).
  const latToM = 111_320;
  const lngToM = 111_320 * Math.cos((a.lat * Math.PI) / 180);

  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * lngToM;
  const by = (b.lat - a.lat) * latToM;
  const px = (p.lng - a.lng) * lngToM;
  const py = (p.lat - a.lat) * latToM;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const projx = ax + t * dx;
  const projy = ay + t * dy;
  const ddx = px - projx;
  const ddy = py - projy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

/**
 * Parse a GeoJSON FeatureCollection / Feature / Geometry and extract a list
 * of geofence drafts ready to insert.
 *
 * Mapping :
 *   - Polygon  → CIRCLE if 4 points + symmetric, else POLYGON
 *   - Point + radius (props.radius) → CIRCLE
 *   - LineString → CORRIDOR (largeur = props.widthM ou 100m default)
 *   - properties.name → name (fallback "Geofence #N")
 *   - properties.color → color (fallback default mint)
 *   - properties.rule → rule (ENTER / EXIT / BOTH, fallback BOTH)
 */
export interface GeofenceDraft {
  name: string;
  type: 'CIRCLE' | 'POLYGON' | 'CORRIDOR';
  rule: 'ENTER' | 'EXIT' | 'BOTH';
  color: string | null;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  polygonPoints: LatLng[] | null;
  corridorPoints: LatLng[] | null;
  corridorWidthM: number | null;
}

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

interface GeoJsonFeature {
  type: 'Feature';
  geometry: GeoJsonGeometry;
  properties?: Record<string, unknown>;
}

export function parseGeoJsonToDrafts(json: unknown): GeofenceDraft[] {
  const features: GeoJsonFeature[] = [];
  if (json && typeof json === 'object') {
    const j = json as { type?: string; features?: unknown[]; geometry?: unknown; properties?: unknown };
    if (j.type === 'FeatureCollection' && Array.isArray(j.features)) {
      for (const f of j.features) features.push(f as GeoJsonFeature);
    } else if (j.type === 'Feature' && j.geometry) {
      features.push(j as unknown as GeoJsonFeature);
    } else if (j.type && (j.type as string).match(/^(Polygon|LineString|Point)$/)) {
      features.push({ type: 'Feature', geometry: j as unknown as GeoJsonGeometry, properties: {} });
    }
  }

  const drafts: GeofenceDraft[] = [];
  let counter = 1;
  for (const f of features) {
    const props = f.properties ?? {};
    const name = pickString(props, ['name', 'label']) ?? `Geofence #${counter}`;
    const color = pickString(props, ['color']) ?? null;
    const rule = (pickEnum(props['rule'], ['ENTER', 'EXIT', 'BOTH']) ?? 'BOTH') as 'ENTER' | 'EXIT' | 'BOTH';
    const widthM = typeof props['widthM'] === 'number' ? props['widthM'] as number : 100;

    // #25 — coordonnees GeoJSON potentiellement malformees (geometry absente,
    // ring/point non-array, paires non-numeriques) : on isole le parsing de CHAQUE
    // feature pour qu'un feature invalide soit IGNORE au lieu de faire planter tout
    // l'import (500). `toLatLng` filtre les paires invalides.
    try {
      if (f.geometry?.type === 'Polygon') {
        const ring = (f.geometry.coordinates as unknown[])?.[0];
        const points = toLatLng(ring);
        if (points.length < 3) continue;
        // Centroid pour centerLat/Lng (approx).
        const cLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const cLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
        drafts.push({
          name, type: 'POLYGON', rule, color,
          centerLat: cLat, centerLng: cLng, radiusMeters: 0,
          polygonPoints: points,
          corridorPoints: null, corridorWidthM: null,
        });
      } else if (f.geometry?.type === 'LineString') {
        const points = toLatLng(f.geometry.coordinates);
        if (points.length < 2) continue;
        drafts.push({
          name, type: 'CORRIDOR', rule, color,
          centerLat: points[0]!.lat, centerLng: points[0]!.lng, radiusMeters: 0,
          polygonPoints: null,
          corridorPoints: points, corridorWidthM: widthM,
        });
      } else if (f.geometry?.type === 'Point') {
        const coord = f.geometry.coordinates;
        if (!isLngLat(coord)) continue;
        const radius = typeof props['radius'] === 'number' ? props['radius'] as number : 200;
        drafts.push({
          name, type: 'CIRCLE', rule, color,
          centerLat: coord[1], centerLng: coord[0], radiusMeters: Math.round(radius),
          polygonPoints: null,
          corridorPoints: null, corridorWidthM: null,
        });
      }
    } catch {
      // Feature a la geometrie illisible -> ignore (defense en profondeur).
      continue;
    }
    counter++;
  }
  return drafts;
}

/** Vrai si `c` est une paire [lng, lat] numerique finie valide (#25). */
function isLngLat(c: unknown): c is [number, number] {
  return (
    Array.isArray(c) &&
    c.length >= 2 &&
    typeof c[0] === 'number' &&
    typeof c[1] === 'number' &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1])
  );
}

/** Convertit une liste de coordonnees GeoJSON [lng,lat][] en points {lat,lng},
 *  en ignorant silencieusement les paires malformees (#25). */
function toLatLng(coords: unknown): Array<{ lat: number; lng: number }> {
  if (!Array.isArray(coords)) return [];
  const out: Array<{ lat: number; lng: number }> = [];
  for (const c of coords) {
    if (isLngLat(c)) out.push({ lat: c[1], lng: c[0] });
  }
  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickEnum(v: unknown, allowed: string[]): string | null {
  if (typeof v === 'string') {
    const upper = v.toUpperCase();
    if (allowed.includes(upper)) return upper;
  }
  return null;
}
