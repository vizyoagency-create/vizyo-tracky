/**
 * Catmull-Rom spline pour adoucir une polyligne sans creer d'overshoot.
 * Insere `samplesPerSegment` points entre chaque paire de points originaux.
 *
 * Utilise pour les trails live : avec une trame Coban toutes les 30s, les
 * coins de virage sont coupes par des lignes droites. La spline fait passer
 * la courbe par tous les points GPS reels mais arrondit les angles.
 */
export function catmullRom<T extends { lat: number; lng: number }>(
  points: T[],
  samplesPerSegment: number = 6,
): Array<{ lat: number; lng: number }> {
  if (points.length < 2) return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  if (points.length === 2) {
    // Pas assez de points pour la spline, on retourne brut.
    return [points[0]!, points[1]!].map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  const out: Array<{ lat: number; lng: number }> = [];
  const n = points.length;

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(n - 1, i + 2)]!;

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      out.push(catmullRomPoint(p0, p1, p2, p3, t));
    }
  }
  // Dernier point original.
  out.push({ lat: points[n - 1]!.lat, lng: points[n - 1]!.lng });
  return out;
}

function catmullRomPoint(
  p0: { lat: number; lng: number },
  p1: { lat: number; lng: number },
  p2: { lat: number; lng: number },
  p3: { lat: number; lng: number },
  t: number,
): { lat: number; lng: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  // Coefficients standards Catmull-Rom (alpha = 0.5).
  const lat = 0.5 * (
    2 * p1.lat +
    (-p0.lat + p2.lat) * t +
    (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2 +
    (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3
  );
  const lng = 0.5 * (
    2 * p1.lng +
    (-p0.lng + p2.lng) * t +
    (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * t2 +
    (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * t3
  );
  return { lat, lng };
}

/**
 * Interpolation lineaire d'angle (heading), en gerant le wrap 360->0.
 * Retourne le heading interpole a t in [0, 1].
 */
export function lerpHeading(from: number, to: number, t: number): number {
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  const result = from + diff * t;
  return ((result % 360) + 360) % 360;
}

/** Interpolation lineaire d'un nombre. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}
