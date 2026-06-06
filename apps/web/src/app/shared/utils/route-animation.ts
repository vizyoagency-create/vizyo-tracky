/**
 * Interpolation d'un point le long d'une polyligne en boucle (anim décorative
 * de la carte de login).
 *
 * Robustesse : `phase` peut être négatif ou > 1 — typiquement quand le timestamp
 * `requestAnimationFrame` précède le `performance.now()` capturé au démarrage
 * (clock skew / précision rAF clampée pour la privacy, surtout 1ère frame ou
 * retour de background). On wrappe donc `phase` dans [0,1) et on clampe l'index
 * sur les DEUX bornes (le bug d'origine ne bornait que le haut → segIdx=-1 →
 * `segments[-1]` undefined → crash de déstructuration à chaque frame).
 */
export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface RouteSegment {
  a: RoutePoint;
  b: RoutePoint;
}

export interface RouteAnimationState {
  lat: number;
  lng: number;
  /** true si le segment va vers l'est (b.lng >= a.lng) — sert au flip horizontal du SVG. */
  facingRight: boolean;
}

/** Wrappe un nombre dans [0,1) (gère les valeurs négatives et > 1). */
export function wrapPhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  const t = phase % 1;
  return t < 0 ? t + 1 : t;
}

/**
 * Position interpolée (easing in-out cubic) sur `segments` pour une phase donnée.
 * Retourne `null` si aucun segment (l'appelant skippe alors la frame sans crash).
 */
export function routeAnimationState(
  segments: readonly RouteSegment[],
  phase: number,
): RouteAnimationState | null {
  const n = segments.length;
  if (n === 0) return null;

  const t = wrapPhase(phase);
  const segLen = 1 / n;
  // Clamp bas ET haut : t ∈ [0,1) donc segIdx ∈ [0, n-1], mais on blinde.
  let segIdx = Math.floor(t / segLen);
  if (segIdx < 0) segIdx = 0;
  else if (segIdx > n - 1) segIdx = n - 1;

  const seg = segments[segIdx];
  if (!seg) return null;

  const localT = (t - segIdx * segLen) / segLen;
  // Easing in-out cubic : décollage/freinage doux près de chaque ville.
  const eased =
    localT < 0.5
      ? 4 * localT * localT * localT
      : 1 - Math.pow(-2 * localT + 2, 3) / 2;

  return {
    lat: seg.a.lat + (seg.b.lat - seg.a.lat) * eased,
    lng: seg.a.lng + (seg.b.lng - seg.a.lng) * eased,
    facingRight: seg.b.lng >= seg.a.lng,
  };
}
