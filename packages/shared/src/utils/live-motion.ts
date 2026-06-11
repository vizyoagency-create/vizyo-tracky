/**
 * Moteur de mouvement live (pur, sans DOM ni rAF) — partage pour etre teste.
 *
 * Probleme resolu (carte temps reel) :
 *  1. Les boitiers Coban renvoient souvent `speedKmh = 0` et un `heading` fige
 *     ou bruite MEME en roulant. Resultat : l'icone passe en gris (couleur
 *     vitesse 0), l'extrapolation se coupe, puis re-saute a la trame suivante.
 *  2. L'extrapolation projetait en LIGNE DROITE selon le dernier cap. Dans un
 *     virage, l'icone partait tangente hors de la route puis corrigeait d'un
 *     coup → "relou".
 *
 * Solution :
 *  - `deriveMotion` : vitesse + cap DERIVES du deplacement reel entre deux
 *    verites (fiable), avec repli sur les champs rapportes. Donne aussi le taux
 *    de rotation (yaw rate) pour courber l'extrapolation.
 *  - `extrapolate` : projette sur un ARC borne (anti-spiral) qui epouse le
 *    virage ; se reduit exactement a la ligne droite quand le cap est stable.
 */

const EARTH_DEG_M = 111_111; // 1 deg de lat ≈ 111,111 km ; lng = idem * cos(lat)

/** Sous cette vitesse on considere le vehicule arrete (pas d'extrapolation). */
export const MIN_MOTION_SPEED_MS = 0.3; // ≈ 1,08 km/h
/** Deplacement minimal pour fier le cap au vecteur reel plutot qu'au champ Coban. */
export const MIN_HEADING_SEGMENT_M = 8;
/** Borne du taux de rotation extrapole (deg/s) — anti-spiral sur heading bruite. */
export const MAX_TURN_RATE_DPS = 12;
/** Rotation totale max pendant une fenetre d'extrapolation (deg) — anti-spiral. */
export const MAX_EXTRAP_ROTATION_DEG = 40;

const toRad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Normalise un angle dans [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Plus petite difference signee b - a, dans (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Cap (0 = Nord, sens horaire) du segment (lat1,lng1) -> (lat2,lng2). */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lng2 - lng1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
}

/** Haversine (m) — duplique localement pour garder ce module autonome. */
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface TruthSample {
  lat: number;
  lng: number;
  /** ms epoch (deviceTime). */
  timestamp: number;
  /** Vitesse rapportee par le boitier (km/h) — souvent peu fiable. */
  speedKmh: number;
  /** Cap rapporte par le boitier (deg) — souvent fige/bruite. */
  heading: number;
}

export interface DerivedMotion {
  /** Vitesse robuste (m/s) = max(rapportee, derivee du deplacement). */
  speedMs: number;
  /** Cap robuste (deg) : vecteur reel si deplacement significatif, sinon rapporte. */
  headingDeg: number;
  /** Taux de rotation du cap (deg/s) entre l'ancien cap utilise et le nouveau. */
  turnRateDegPerS: number;
  /** Vitesse robuste exprimee en km/h (pour la couleur du marker/trail). */
  effectiveSpeedKmh: number;
}

/**
 * Derive vitesse + cap + yaw-rate robustes a partir du deplacement reel.
 *
 * @param prev               derniere verite acceptee (ou null au premier rendu)
 * @param next               nouvelle verite
 * @param prevUsedHeadingDeg cap robuste calcule au cycle precedent (pour le yaw rate)
 */
export function deriveMotion(
  prev: { lat: number; lng: number; timestamp: number } | null | undefined,
  next: TruthSample,
  prevUsedHeadingDeg?: number | null,
): DerivedMotion {
  const reportedKmh = Math.max(next.speedKmh || 0, 0);
  const reportedMs = reportedKmh / 3.6;
  const reportedHeading = normalizeDeg(next.heading || 0);

  if (!prev) {
    return {
      speedMs: reportedMs,
      headingDeg: reportedHeading,
      turnRateDegPerS: 0,
      effectiveSpeedKmh: reportedKmh,
    };
  }

  const dtSec = (next.timestamp - prev.timestamp) / 1000;
  if (!(dtSec > 0)) {
    return {
      speedMs: reportedMs,
      headingDeg: reportedHeading,
      turnRateDegPerS: 0,
      effectiveSpeedKmh: reportedKmh,
    };
  }

  const dist = distanceM(prev.lat, prev.lng, next.lat, next.lng);
  const derivedMs = dist / dtSec;
  // Vitesse robuste : le boitier peut sous-estimer (0 en roulant), jamais
  // sur-estimer au point de creer un faux deplacement (le deplacement est reel).
  const speedMs = Math.max(reportedMs, derivedMs);

  // Cap : si le segment est assez long, le vecteur reel est plus fiable que le
  // champ Coban. Sinon (quasi immobile) on gardre le cap rapporte / precedent.
  const movedEnough = dist >= MIN_HEADING_SEGMENT_M;
  const headingDeg = movedEnough
    ? bearingDeg(prev.lat, prev.lng, next.lat, next.lng)
    : reportedHeading || normalizeDeg(prevUsedHeadingDeg ?? 0);

  let turnRateDegPerS = 0;
  if (prevUsedHeadingDeg != null && movedEnough) {
    turnRateDegPerS = angleDiffDeg(normalizeDeg(prevUsedHeadingDeg), headingDeg) / dtSec;
  }

  return {
    speedMs,
    headingDeg,
    turnRateDegPerS,
    effectiveSpeedKmh: speedMs * 3.6,
  };
}

/**
 * Projette la position d'un marker entre deux trames.
 *
 * - Vitesse nulle → reste sur place (pas d'extrapolation, evite la derive).
 * - Cap stable (yaw ≈ 0) → ligne droite (comportement historique exact).
 * - Cap qui tourne → ARC de cercle borne (epouse le virage). La rotation totale
 *   est plafonnee a `MAX_EXTRAP_ROTATION_DEG` pour ne jamais partir en spirale
 *   si le yaw rate est bruite.
 *
 * @param origin  derniere verite (lat/lng/cap)
 * @param speedMs vitesse robuste (m/s)
 * @param turnRateDegPerS yaw rate (deg/s)
 * @param ageSec  temps ecoule depuis `origin` (s)
 * @param capSec  borne haute d'extrapolation (s) — au-dela, l'icone se fige
 */
export function extrapolate(
  origin: { lat: number; lng: number; headingDeg: number },
  speedMs: number,
  turnRateDegPerS: number,
  ageSec: number,
  capSec: number,
): { lat: number; lng: number; headingDeg: number } {
  const baseHeading = normalizeDeg(origin.headingDeg);
  if (speedMs < MIN_MOTION_SPEED_MS) {
    return { lat: origin.lat, lng: origin.lng, headingDeg: baseHeading };
  }

  const tEff = clamp(ageSec, 0, Math.max(capSec, 0));
  if (tEff <= 0) {
    return { lat: origin.lat, lng: origin.lng, headingDeg: baseHeading };
  }

  // Borne le yaw rate, puis borne la rotation TOTALE sur la fenetre (anti-spiral).
  let omegaDps = clamp(turnRateDegPerS, -MAX_TURN_RATE_DPS, MAX_TURN_RATE_DPS);
  const maxOmega = MAX_EXTRAP_ROTATION_DEG / tEff;
  omegaDps = clamp(omegaDps, -maxOmega, maxOmega);

  const theta0 = toRad(baseHeading);
  const omegaRad = toRad(omegaDps); // rad/s

  let dE: number;
  let dN: number;
  if (Math.abs(omegaRad) < 1e-6) {
    // Ligne droite : composante Est = sin(cap), Nord = cos(cap).
    dE = speedMs * tEff * Math.sin(theta0);
    dN = speedMs * tEff * Math.cos(theta0);
  } else {
    // Arc a vitesse + yaw constants : integrale du vecteur vitesse tournant.
    const radius = speedMs / omegaRad;
    const theta1 = theta0 + omegaRad * tEff;
    dE = radius * (Math.cos(theta0) - Math.cos(theta1));
    dN = radius * (Math.sin(theta1) - Math.sin(theta0));
  }

  const cosLat = Math.cos(toRad(origin.lat)) || 1;
  return {
    lat: origin.lat + dN / EARTH_DEG_M,
    lng: origin.lng + dE / (EARTH_DEG_M * cosLat),
    headingDeg: normalizeDeg(baseHeading + omegaDps * tEff),
  };
}
