/**
 * Garde-fous GPS partages entre backend et frontend.
 *
 * Objectif : detecter les positions douteuses qui produisent
 * - des distances negatives ou aberrantes en rapports,
 * - des polylignes triangulaires en replays,
 * - des sauts brusques (teleportation) en live.
 *
 * Applique a 4 etages :
 * 1. ingestion (PositionsService.ingest)
 * 2. accumulation polypoint (TripsService.processPosition)
 * 3. segmenter recompute (TripSegmenterService.segmentPositions)
 * 4. rendu replay (TripReplayComponent.initReplay)
 */

const R_EARTH = 6371000;

/**
 * Distance haversine en metres entre deux points (lat, lng).
 * Toujours positive ; retourne 0 si les coordonnees sont identiques.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Verifie qu'une coordonnee (lat, lng) est dans les bornes geographiques valides
 * et n'est pas a Null Island (0, 0) — placeholder typique d'un fix GPS degrade.
 */
export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)
  );
}

/**
 * Verifie que le passage d'un point a un autre est plausible compte tenu du
 * delta de temps : la vitesse moyenne implicite ne doit pas depasser un seuil
 * (par defaut 250 km/h, soit deux fois la vitesse legale autoroute).
 *
 * Si dt <= 0 (timestamps identiques ou inverses) -> false.
 */
export function isPlausibleJump(
  prev: { lat: number; lng: number; timestamp: Date | string | number },
  next: { lat: number; lng: number; timestamp: Date | string | number },
  maxKmh: number = 250,
): boolean {
  const t1 = toMs(prev.timestamp);
  const t2 = toMs(next.timestamp);
  const dtSec = (t2 - t1) / 1000;
  if (dtSec <= 0) return false;

  const dKm = haversineMeters(prev.lat, prev.lng, next.lat, next.lng) / 1000;
  const kmh = (dKm / dtSec) * 3600;
  return kmh < maxKmh;
}

/**
 * Filtre defensif applique a une suite de positions ordonnees.
 * Garantit :
 * - pas de doublon de timestamp consecutif
 * - lat/lng valides (en bornes, hors Null Island)
 * - pas de saut > maxKmh entre deux points consecutifs
 */
export function sanitizePositions<
  T extends { lat: number; lng: number; timestamp: Date | string | number },
>(positions: T[], opts: { maxKmh?: number } = {}): T[] {
  const maxKmh = opts.maxKmh ?? 250;
  const out: T[] = [];

  for (const p of positions) {
    if (!isValidLatLng(p.lat, p.lng)) continue;

    const last = out[out.length - 1];
    if (last) {
      const lastMs = toMs(last.timestamp);
      const curMs = toMs(p.timestamp);
      if (curMs <= lastMs) continue;
      if (!isPlausibleJump(last, p, maxKmh)) continue;
    }

    out.push(p);
  }

  return out;
}

/**
 * Simplification Douglas-Peucker d'une polyligne.
 * Conserve la forme generale tout en supprimant les points superflus.
 *
 * @param points     liste de points
 * @param toleranceM tolerance en metres (par defaut 5 m)
 */
export function douglasPeucker<T extends { lat: number; lng: number }>(
  points: T[],
  toleranceM: number = 5,
): T[] {
  if (points.length < 3) return points.slice();

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;

    const a = points[start]!;
    const b = points[end]!;

    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceM(points[i]!, a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }

    if (index !== -1 && maxDist > toleranceM) {
      keep[index] = true;
      stack.push([start, index]);
      stack.push([index, end]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/* --- Helpers internes --- */

function toMs(t: Date | string | number): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  return new Date(t).getTime();
}

/**
 * Distance perpendiculaire approximative (en metres) entre un point et le
 * segment forme par deux autres points. Suffisant pour Douglas-Peucker a
 * l'echelle d'un trajet vehicule (< 1000 km).
 */
function perpendicularDistanceM<T extends { lat: number; lng: number }>(
  p: T,
  a: T,
  b: T,
): number {
  const aDist = haversineMeters(a.lat, a.lng, p.lat, p.lng);
  const bDist = haversineMeters(b.lat, b.lng, p.lat, p.lng);
  const abDist = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  if (abDist === 0) return aDist;

  // Heron's formula pour l'aire du triangle, puis hauteur = 2 * aire / base.
  const s = (aDist + bDist + abDist) / 2;
  const areaSq = Math.max(0, s * (s - aDist) * (s - bDist) * (s - abDist));
  const area = Math.sqrt(areaSq);
  return (2 * area) / abDist;
}
