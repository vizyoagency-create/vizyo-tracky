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

/** Motif de rejet d'une trame a l'ingestion (audit / log). */
export type IngestionRejectReason = 'stale_devicetime' | 'implausible_jump';

export interface IngestionFixVerdict {
  /** true = la trame fait autorite : persistance + denormalisation last-position. */
  authoritative: boolean;
  /** Motif quand `authoritative=false`, sinon null. */
  reason: IngestionRejectReason | null;
}

/**
 * Garde-fou d'INGESTION cote serveur (etage 1) : decide si une trame VALIDE fait
 * autorite pour la persistance (`positions`, trips) et la denormalisation de la
 * derniere position connue du tracker.
 *
 * Probleme cible : certains boitiers Coban rejouent leur buffer interne. Pour le
 * meme IMEI arrivent, entrelacees au flux temps reel, des trames au `deviceTime`
 * ANTERIEUR a la derniere verite et a une position distante de plusieurs km
 * (analyse prod HD-779-MA, nuit 2026-06-10/11). Persistees, elles polluent
 * `positions`, les trips et les rapports de distance.
 *
 * Deux signaux de rejet, du moins cher au plus cher :
 *  1. `deviceTime` non strictement croissant (<= dernier deviceTime valide) →
 *     trame REJOUEE. Meme invariant que `TripsService.processPosition` en aval.
 *  2. saut physiquement impossible : vitesse moyenne implicite > `maxKmh`
 *     (via {@link isPlausibleJump}). On utilise le `dt` PLEIN (non borne) : un
 *     grand `dt` legitime (rattrapage post-coupure GPRS, vehicule deplace
 *     hors-ligne) tolere une grande distance — on ne rejette que l'infaisable,
 *     pour ne jamais PERDRE une position reelle. C'est la difference avec
 *     {@link maxPlausibleJumpMeters} (dt borne a 60s), reserve au rendu LIVE ou
 *     droper une trame est cosmetique alors qu'a l'ingestion c'est une perte.
 *
 * `prev` = derniere position AUTORITAIRE connue (denormalisee sur Tracker).
 * Quand `prev` est absent (tracker neuf, jamais de fix), la trame est acceptee
 * faute de reference — elle etablit la baseline.
 */
export function evaluateIngestionFix(
  next: { lat: number; lng: number; deviceTime: Date | string | number },
  prev?:
    | { lat: number; lng: number; deviceTime: Date | string | number | null | undefined }
    | null,
  opts: { maxKmh?: number } = {},
): IngestionFixVerdict {
  if (!prev || prev.deviceTime == null) {
    return { authoritative: true, reason: null };
  }
  const dtSec = (toMs(next.deviceTime) - toMs(prev.deviceTime)) / 1000;
  // 1. deviceTime non strictement croissant → trame rejouee depuis le buffer.
  if (dtSec <= 0) {
    return { authoritative: false, reason: 'stale_devicetime' };
  }
  // 2. saut infaisable au dt reel (vitesse moyenne implicite > maxKmh).
  if (
    !isPlausibleJump(
      { lat: prev.lat, lng: prev.lng, timestamp: prev.deviceTime },
      { lat: next.lat, lng: next.lng, timestamp: next.deviceTime },
      opts.maxKmh ?? 250,
    )
  ) {
    return { authoritative: false, reason: 'implausible_jump' };
  }
  return { authoritative: true, reason: null };
}

// --- Garde-fous live (sauts) ---
// Plafond de securite absolu : deux fois la vitesse legale autoroute.
const LIVE_MAX_KMH = 250;
// Moteur coupe (ignition === false) : le vehicule ne peut PAS se deplacer ;
// tout ecart au-dela de ce rayon est du bruit GPS (multipath, demarrage a froid).
const ENGINE_OFF_JUMP_M = 150;
// Plancher de tolerance quand on dispose de la vitesse rapportee : absorbe le
// bruit GPS + une acceleration sur l'intervalle, meme a vitesse rapportee ~0.
const JUMP_FLOOR_M = 150;
// Marge appliquee a la vitesse rapportee (absorbe sous-estimation Coban +
// acceleration). Au-dela, le saut contredit la vitesse rapportee → outlier.
const JUMP_SPEED_SLACK = 2;
// Borne du dt utilise pour la tolerance. SANS ce cap, un vehicule a l'arret la
// nuit (boitier en STOPPED → trame toutes les 300s) donnerait une fenetre de
// 250 km/h x 300s ≈ 21 km : n'importe quel outlier GPS passerait → teleportation.
// Avec le cap a 60s, la tolerance vitesse ne depasse jamais ≈ 4,2 km.
const JUMP_DT_CAP_S = 60;

/**
 * Distance maximale plausible (m) entre deux trames live consecutives.
 *
 * Le seuil de securite est une VITESSE (km/h), donc la distance toleree croit
 * avec `dt`. A l'arret nocturne le boitier emet toutes les 300s → la fenetre
 * explosait (~21 km) et laissait passer les outliers GPS. On borne donc le `dt`
 * et on resserre selon deux signaux physiques :
 *  - `ignition === false` : moteur coupe → aucun deplacement reel possible.
 *  - `speedKmh` rapporte : un saut qui implique une vitesse >> la vitesse
 *    rapportee est un outlier (la vitesse Doppler GPS est fiable a la hausse).
 *
 * On retourne le MIN des bornes applicables (la plus restrictive).
 */
export function maxPlausibleJumpMeters(opts: {
  dtSec: number;
  ignition?: boolean | null;
  speedKmh?: number | null;
  prevSpeedKmh?: number | null;
  maxKmh?: number;
}): number {
  const maxKmh = opts.maxKmh ?? LIVE_MAX_KMH;
  const dtEff = Math.min(Math.max(opts.dtSec, 0), JUMP_DT_CAP_S);
  // Plafond absolu (250 km/h, dt borne).
  let cap = (maxKmh / 3.6) * dtEff;
  // Moteur coupe : seul le bruit GPS est tolere.
  if (opts.ignition === false) {
    cap = Math.min(cap, ENGINE_OFF_JUMP_M);
  }
  // Coherence avec la vitesse : on prend la PLUS HAUTE des vitesses connues
  // (trame courante ET precedente). Apres une coupure GPRS, la trame qui
  // "rattrape" peut afficher une vitesse basse (le vehicule a ralenti en
  // arrivant) alors qu'il roulait vite juste avant — sans la vitesse precedente
  // on rejetterait a tort ce rattrapage legitime (cas observe en prod).
  const speeds = [opts.speedKmh, opts.prevSpeedKmh].filter(
    (s): s is number => s != null && Number.isFinite(s),
  );
  if (speeds.length > 0) {
    const refMs = Math.max(0, ...speeds) / 3.6;
    cap = Math.min(cap, JUMP_FLOOR_M + refMs * dtEff * JUMP_SPEED_SLACK);
  }
  return cap;
}

/**
 * Decide si une trame WS temps reel est exploitable pour le rendu carte (icone
 * vehicule + trail dashed). Equivalent ponctuel de `sanitizePositions` :
 *
 * - rejette les fixes `valid: false` (le backend les broadcast pour propager
 *   l'ignition, mais leurs lat/lng sont souvent degradees — tunnel, indoor,
 *   demarrage a froid). Sans ce filtre, l'icone saute et la trail diverge.
 * - rejette les coordonnees hors-bornes / Null Island.
 * - rejette les horodatages identiques ou inverses (`dt <= 0`).
 * - si `prev` fourni, rejette les sauts au-dela de `maxPlausibleJumpMeters`
 *   (vitesse-aware + ignition-aware + dt borne — voir cette fonction).
 *
 * `prev` peut etre omis (premier rendu) ou null/undefined.
 */
export function isAcceptableLiveFix(
  next: {
    lat: number;
    lng: number;
    valid?: boolean;
    timestamp?: Date | string | number;
    speedKmh?: number | null;
    ignition?: boolean | null;
  },
  prev?: {
    lat: number;
    lng: number;
    timestamp: Date | string | number;
    speedKmh?: number | null;
  } | null,
  opts: { maxKmh?: number } = {},
): boolean {
  if (next.valid === false) return false;
  if (!isValidLatLng(next.lat, next.lng)) return false;
  if (prev && next.timestamp !== undefined) {
    const dtSec = (toMs(next.timestamp) - toMs(prev.timestamp)) / 1000;
    // Horodatage identique ou remontee dans le temps : trame non exploitable.
    // C'est aussi ce qui rejette les trames REJOUEES depuis le buffer d'un
    // boitier (deviceTime anterieur a la derniere verite) — cause racine du
    // bug "double trace" observe en prod (flux live + replay entrelaces).
    if (dtSec <= 0) return false;
    const jumpM = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
    const maxM = maxPlausibleJumpMeters({
      dtSec,
      ignition: next.ignition,
      speedKmh: next.speedKmh,
      prevSpeedKmh: prev.speedKmh,
      maxKmh: opts.maxKmh,
    });
    if (jumpM > maxM) return false;
  }
  return true;
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
