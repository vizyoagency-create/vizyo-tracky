import { MAX_VITESSE_ANNONCEE_KMH, vitesseEstCorroboree, vitesseObservee } from '@vizyo/tracky-shared';
import { haversineMeters } from '../agenda/trip-stop-detector.service';

/**
 * Traçabilité fine des trajets (Palier 2) — PRÉPROCESSEUR DÉTERMINISTE.
 *
 * Transforme les positions BRUTES d'un trajet en une analyse fiable et COMPACTE, sans aucun appel IA :
 * filtrage (positions muettes/invalides/impossibles), métriques (distance/durée/vitesses), arrêts,
 * qualité GPS, ANOMALIES (excès de vitesse vs limites OSM, accélérations/freinages brusques, ralenti),
 * éco-conduite (conso/CO₂ estimés) et tracé simplifié. C'est la SOURCE réutilisée partout (fiche
 * véhicule, rapports, replay) et le payload compact envoyé au LLM (Palier 3) — jamais les 10 000 points.
 */

/** Une position d'entrée (sous-ensemble du modèle Position, testable sans Prisma). */
export interface RawPosition {
  lat: number;
  lng: number;
  speedKmh: number;
  heading?: number | null;
  timestamp: Date;
  valid?: boolean;
  ignition?: boolean | null;
  satellites?: number | null;
}

/** Résout la limite de vitesse (km/h) d'un point, ou null si inconnue. Best-effort, injecté. */
export type LimitResolver = (lat: number, lng: number) => number | null;

export interface TripStopOut { lat: number; lng: number; arrivedAt: string; leftAt: string; durationMin: number; }
export interface SpeedingSegment { startAt: string; endAt: string; durationSec: number; maxSpeedKmh: number; limitKmh: number; overKmh: number; lat: number; lng: number; }
/**
 * Pointe que l'on refuse d'affirmer comme un excès, avec la raison du doute.
 *   · `limite-invraisemblable` : 102 km/h sur une voie à 30 — le point a été rattaché au pont
 *     qui franchit la rocade, pas à la rocade ;
 *   · `point-unique` : le dépassement n'a été vu que sur une seule position.
 */
export interface PointeAVerifier extends SpeedingSegment { motif: 'limite-invraisemblable' | 'point-unique'; }
export interface TrackPoint { lat: number; lng: number; t: string; speedKmh: number; }
/** Passage station-service (rempli par FuelStationService APRÈS le préprocesseur, jamais par la fonction pure). */
export interface FuelStopOut {
  stationId: string; brand: string | null; name: string | null; city: string | null; address: string | null;
  lat: number; lng: number; arrivedAt: string; durationSec: number; distanceM: number;
  fuelType: string | null; unitPriceEur: number | null;
}

export interface TripAnalysisResult {
  distanceKm: number;
  durationSec: number;
  movingSec: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  stopCount: number;
  idleSec: number;
  gpsPoints: number;
  gpsValidRatio: number;
  gpsLostCount: number;
  speedingCount: number;
  speedingSec: number;
  maxOverKmh: number;
  limitsKnown: boolean;
  harshAccel: number;
  harshBrake: number;
  ecoScore: number;
  fuelLiters: number | null;
  co2Kg: number | null;
  detail: {
    stops: TripStopOut[];
    speeding: SpeedingSegment[];
    gpsGaps: { atSec: number; gapSec: number }[];
    track: TrackPoint[];
    /**
     * Réserve sur la vitesse : la pointe BRUTE annoncée par le boîtier et le nombre de points
     * dont la trajectoire contredit la vitesse. Permet d'afficher « pointe non corroborée »
     * plutôt que de faire disparaître un chiffre sans explication.
     */
    vitesse?: { pointeBruteKmh: number; pointsEcartes: number };
    /** Pointes que l'on refuse d'affirmer, avec le motif du doute. */
    aVerifier?: PointeAVerifier[];
    /** Passages en station détectés — ajoutés par le service (le préprocesseur pur laisse ce champ absent). */
    fuelStops?: FuelStopOut[];
  };
}

/** Contexte véhicule pour la conso (énergie + L/100km si renseigné). */
export interface VehicleFuel {
  type?: string | null;   // VehicleType (défaut de conso si L/100 absent)
  energy?: string | null; // InstallationEnergy (facteur CO₂ + électrique = 0)
  fuelConsumptionL100km?: number | null;
}

// ── Seuils (alignés sur les règles anti-bruit de l'app) ─────────────────────────────────
const STOP_SPEED_KMH = 4;            // sous ce seuil = à l'arrêt (bruit GPS)
/**
 * Au-dessus = trame corrompue → jetée.
 *
 * ⚠️ ALIGNÉ sur `MAX_VITESSE_ANNONCEE_KMH` (200), le plafond appliqué à l'ingestion. Trois
 * plafonds différents cohabitaient pour la même grandeur : 200 à l'ingestion, 220 ici, 250 sur
 * le trajet. Une vitesse de 210 était donc refusée à l'entrée, acceptée par l'analyse, et
 * conservée telle quelle par le trajet — trois écrans, trois vérités.
 */
const IMPOSSIBLE_SPEED_KMH = MAX_VITESSE_ANNONCEE_KMH;
const SPEED_TOLERANCE_KMH = 5;       // marge (bruit GPS + tolérance) avant de compter un excès

/**
 * ── UN DÉPASSEMENT ÉNORME EST UN RATTACHEMENT RATÉ, PAS UNE FAUTE ──────────────────────
 *
 * Constat du 2026-09-03 : « Limite 30 · dépassement +72 » sur la rocade toulousaine. Personne
 * ne roule à 102 km/h dans une rue à 30 : c'est le point qui a été rattaché au pont qui franchit
 * la rocade, pas le conducteur qui a fauté. Le malus de niveau (`malusVoie`) supprime la plupart
 * de ces cas à la source ; ce garde-fou attrape le reste, car aucune donnée cartographique n'est
 * parfaite.
 *
 * ⚠️ On ne remonte PAS la limite et on n'invente pas d'excès plus doux : on refuse seulement
 * d'affirmer. Le point sort des excès confirmés et rejoint les pointes à vérifier — le doute
 * doit se voir, pas disparaître.
 */
const LIMITE_LENTE_KMH = 50;         // au-delà, un gros écart reste plausible (90 sur une voie à 80)
const ECART_INVRAISEMBLABLE_KMH = 40; // sur une voie lente, +40 km/h ne s'explique plus par la conduite

/** Le couple (limite, vitesse) est-il crédible, ou trahit-il un mauvais rattachement ? */
function ecartCredible(limiteKmh: number, vitesseKmh: number): boolean {
  if (limiteKmh > LIMITE_LENTE_KMH) return true;
  return vitesseKmh - limiteKmh <= ECART_INVRAISEMBLABLE_KMH;
}

/**
 * Durée minimale d'un excès. Un segment bâti sur UN SEUL point ne prouve rien : une position
 * aberrante suffisait à produire un « excès confirmé ». On exige que le dépassement soit vu sur
 * au moins deux points, donc sur une durée non nulle.
 */
const EXCES_DUREE_MIN_SEC = 1;
const GPS_GAP_SEC = 300;             // > 5 min entre 2 points = perte de signal
const HARSH_ACCEL_MS2 = 2.5;         // accélération brusque
const HARSH_BRAKE_MS2 = 3.0;         // freinage brusque
const MIN_DT_S = 0.5;                // intervalle plausible min pour dériver une accélération
const MAX_DT_S = 12;                 // au-delà = trou, on ne dérive pas d'accélération
/** Consommation par défaut (L/100 km) selon le type de véhicule, si non renseignée. */
const DEFAULT_L100: Record<string, number> = { CAR: 7, TRUCK: 22, VAN: 10, MOTORCYCLE: 4, BUS: 28, BICYCLE: 0, OTHER: 8, CONSTRUCTION: 25 };
/** Facteur CO₂ (kg / litre) selon l'énergie. */
const CO2_PER_L: Record<string, number> = { DIESEL: 2.68, ESSENCE: 2.31, HYBRIDE: 2.0, AUTRE: 2.4 };

const iso = (d: Date) => d.toISOString();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Analyse déterministe d'un trajet. `limit` (best-effort) fournit la limite légale d'un point (OSM) ;
 * absente → excès non calculés (marqués « limites inconnues »).
 */
export function analyzeTrip(raw: RawPosition[], vehicle: VehicleFuel = {}, limit?: LimitResolver): TripAnalysisResult {
  const total = raw.length;
  // 1. Filtrage : valides, coordonnées présentes (≠ 0,0), vitesses possibles, triées, dé-dupliquées par timestamp.
  const seen = new Set<number>();
  const pts = raw
    .filter((p) => p.valid !== false && !(p.lat === 0 && p.lng === 0) && p.speedKmh <= IMPOSSIBLE_SPEED_KMH && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .filter((p) => { const t = p.timestamp.getTime(); if (seen.has(t)) return false; seen.add(t); return true; });

  if (pts.length === 0) return empty(total);

  // 2. Parcours segment par segment : distance, temps roulant, ralenti, accélérations, excès, trous GPS.
  let distanceM = 0;
  let movingSec = 0;
  let idleSec = 0;
  let maxSpeed = 0;
  /** Pointe brute annoncée par le boîtier, corroborée ou non : la réserve doit rester lisible. */
  let pointeBrute = 0;
  /** Points dont la vitesse annoncée n'était soutenue par aucun intervalle voisin exploitable. */
  let pointsVitesseEcartes = 0;
  let harshAccel = 0;
  let harshBrake = 0;
  const gpsGaps: { atSec: number; gapSec: number }[] = [];
  const t0 = pts[0].timestamp.getTime();

  // Excès : on regroupe les points consécutifs au-dessus de la limite en segments.
  let limitsKnown = false;
  const speeding: SpeedingSegment[] = [];
  /**
   * Pointes que l'on refuse d'affirmer : rattachement douteux ou observation trop courte.
   * Elles ne comptent ni dans `speedingCount` ni dans le score, mais restent visibles — un
   * doute effacé est un doute qu'on ne pourra jamais lever.
   */
  const aVerifier: PointeAVerifier[] = [];
  let cur: { startAt: Date; endAt: Date; maxSpeed: number; limit: number; over: number; lat: number; lng: number } | null = null;
  const flushSpeeding = () => {
    if (cur) {
      const durationSec = Math.round((cur.endAt.getTime() - cur.startAt.getTime()) / 1000);
      const segment: SpeedingSegment = { startAt: iso(cur.startAt), endAt: iso(cur.endAt), durationSec, maxSpeedKmh: Math.round(cur.maxSpeed), limitKmh: cur.limit, overKmh: Math.round(cur.over), lat: cur.lat, lng: cur.lng };
      // Un excès vu sur UN SEUL point ne prouve rien : une position aberrante suffisait à
      // produire un « excès confirmé ». Il rejoint les pointes à vérifier, il ne disparaît pas.
      if (durationSec >= EXCES_DUREE_MIN_SEC) speeding.push(segment);
      else aVerifier.push({ ...segment, motif: 'point-unique' });
      cur = null;
    }
  };

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];

    /**
     * ⚠️ UNE VITESSE QUE LA TRAJECTOIRE CONTREDIT N'EST PAS UNE VITESSE.
     *
     * Le champ vitesse du boîtier alimentait directement `maxSpeed`, et un excès s'appuyait
     * dessus sans qu'aucun contrôle ne le confronte au déplacement. Le 29 août, sur
     * EY-613-MF : 180 km/h annoncés pendant que le véhicule parcourait 727 m en vingt
     * secondes, soit 131 km/h. Le point écarté reste compté dans `pointeBrute` — on ne
     * dissimule rien, on refuse seulement de l'ériger en fait.
     */
    const corrobore = vitesseEstCorroboree(p.speedKmh, [
      i > 0 ? vitesseObservee(pts[i - 1], p) : null,
      i + 1 < pts.length ? vitesseObservee(p, pts[i + 1]) : null,
    ]);
    if (p.speedKmh > pointeBrute) pointeBrute = p.speedKmh;
    if (!corrobore) {
      pointsVitesseEcartes++;
      // Ni vitesse maximale, ni excès : ce point ne prouve rien. Il ferme le segment courant,
      // comme le ferait une limite inconnue.
      flushSpeeding();
      if (i === 0) continue;
      // On poursuit quand même la géométrie (distance, durée, à-coups) plus bas.
    } else {
      maxSpeed = Math.max(maxSpeed, p.speedKmh);
    }

    // Excès de vitesse (si limite connue à ce point ET vitesse corroborée).
    const lim = corrobore && limit ? limit(p.lat, p.lng) : null;
    if (lim != null) {
      limitsKnown = true;
      if (p.speedKmh > lim + SPEED_TOLERANCE_KMH) {
        const over = p.speedKmh - lim;
        if (!ecartCredible(lim, p.speedKmh)) {
          // Rattachement douteux : on ferme ce qui précède et on range la pointe à part.
          flushSpeeding();
          aVerifier.push({
            startAt: iso(p.timestamp), endAt: iso(p.timestamp), durationSec: 0,
            maxSpeedKmh: Math.round(p.speedKmh), limitKmh: lim, overKmh: Math.round(over),
            lat: p.lat, lng: p.lng, motif: 'limite-invraisemblable',
          });
        } else if (cur && cur.limit === lim) { cur.endAt = p.timestamp; cur.maxSpeed = Math.max(cur.maxSpeed, p.speedKmh); cur.over = Math.max(cur.over, over); }
        else { flushSpeeding(); cur = { startAt: p.timestamp, endAt: p.timestamp, maxSpeed: p.speedKmh, limit: lim, over, lat: p.lat, lng: p.lng }; }
      } else flushSpeeding();
    } else flushSpeeding();

    if (i === 0) continue;
    const prev = pts[i - 1];
    const dtS = (p.timestamp.getTime() - prev.timestamp.getTime()) / 1000;
    const dM = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
    distanceM += dM;

    if (dtS > GPS_GAP_SEC) gpsGaps.push({ atSec: Math.round((prev.timestamp.getTime() - t0) / 1000), gapSec: Math.round(dtS) });

    const moving = p.speedKmh > STOP_SPEED_KMH || prev.speedKmh > STOP_SPEED_KMH;
    if (dtS > 0 && dtS <= GPS_GAP_SEC) {
      if (moving) movingSec += dtS;
      else if (p.ignition === true) idleSec += dtS; // moteur tournant à l'arrêt = ralenti (gaspillage)
    }

    // Accélération / freinage brusque (dérivée de la vitesse sur un intervalle plausible).
    if (dtS >= MIN_DT_S && dtS <= MAX_DT_S) {
      const accelMs2 = ((p.speedKmh - prev.speedKmh) / 3.6) / dtS;
      if (accelMs2 >= HARSH_ACCEL_MS2) harshAccel++;
      else if (accelMs2 <= -HARSH_BRAKE_MS2) harshBrake++;
    }
  }
  flushSpeeding();

  const durationSec = Math.round((pts[pts.length - 1].timestamp.getTime() - t0) / 1000);
  const distanceKm = distanceM / 1000;
  const avgSpeedKmh = movingSec > 0 ? (distanceKm / (movingSec / 3600)) : 0;
  const speedingSec = speeding.reduce((s, x) => s + x.durationSec, 0);
  const maxOverKmh = speeding.reduce((m, x) => Math.max(m, x.overKmh), 0);

  // 3. Arrêts significatifs (regroupement stationnaire ≥ 4 min) — même logique que TripStopDetector.
  const stops = detectStops(pts);

  // 4. Éco-conduite : conso + CO₂ estimés + score 0..100 (pénalités anomalies).
  const l100 = vehicle.fuelConsumptionL100km && vehicle.fuelConsumptionL100km > 0
    ? vehicle.fuelConsumptionL100km
    : (DEFAULT_L100[vehicle.type ?? 'CAR'] ?? 7);
  const electric = (vehicle.energy ?? '').toUpperCase() === 'ELECTRIQUE';
  const fuelLiters = electric ? null : Math.round((distanceKm / 100) * l100 * 100) / 100;
  const co2Kg = fuelLiters == null ? null : Math.round(fuelLiters * (CO2_PER_L[(vehicle.energy ?? 'DIESEL').toUpperCase()] ?? 2.4) * 100) / 100;

  const per100 = distanceKm > 0 ? 100 / distanceKm : 0; // normalise les événements « aux 100 km »
  const idleMin = idleSec / 60;
  const ecoScore = clamp(Math.round(
    100
    - Math.min(30, (harshAccel + harshBrake) * per100 * 2)  // conduite nerveuse
    - Math.min(35, speeding.length * per100 * 3)             // excès de vitesse
    - Math.min(20, idleMin * 1.5),                           // ralenti (gaspillage)
  ), 0, 100);

  // 5. Tracé simplifié (Douglas-Peucker) — borne le payload (replay/LLM) sans perdre la forme.
  const track = simplify(pts, 60).map((p) => ({ lat: round(p.lat, 5), lng: round(p.lng, 5), t: iso(p.timestamp), speedKmh: Math.round(p.speedKmh) }));

  return {
    distanceKm: round(distanceKm, 2),
    durationSec,
    movingSec: Math.round(movingSec),
    avgSpeedKmh: round(avgSpeedKmh, 1),
    maxSpeedKmh: round(maxSpeed, 1),
    stopCount: stops.length,
    idleSec: Math.round(idleSec),
    gpsPoints: pts.length,
    gpsValidRatio: total > 0 ? round(pts.length / total, 3) : 1,
    gpsLostCount: gpsGaps.length,
    speedingCount: speeding.length,
    speedingSec,
    maxOverKmh: round(maxOverKmh, 1),
    limitsKnown,
    harshAccel,
    harshBrake,
    ecoScore,
    fuelLiters,
    co2Kg,
    detail: {
      stops, speeding, gpsGaps, track,
      // Réserve sur la vitesse : ce que le boîtier a annoncé, et combien de points la
      // trajectoire contredit. Écrire dans `detail` évite une migration et rend la réserve
      // affichable — effacer un chiffre sans le dire déplacerait simplement le mensonge.
      vitesse: {
        pointeBruteKmh: round(pointeBrute, 1),
        pointsEcartes: pointsVitesseEcartes,
      },
      // Pointes non affirmées : rattachement douteux ou dépassement vu sur un seul point.
      aVerifier,
    },
  };
}

function empty(total: number): TripAnalysisResult {
  return {
    distanceKm: 0, durationSec: 0, movingSec: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, stopCount: 0, idleSec: 0,
    gpsPoints: 0, gpsValidRatio: 0, gpsLostCount: 0, speedingCount: 0, speedingSec: 0, maxOverKmh: 0, limitsKnown: false,
    harshAccel: 0, harshBrake: 0, ecoScore: 100, fuelLiters: null, co2Kg: null,
    detail: { stops: [], speeding: [], gpsGaps: [], track: [] },
  };
}

// ── Arrêts (regroupement stationnaire ≥ 4 min dans un rayon), aligné sur TripStopDetectorService ──
const STOP_RADIUS_M = 130;
const STOP_MIN_MS = 4 * 60 * 1000;
function detectStops(pts: RawPosition[]): TripStopOut[] {
  const out: TripStopOut[] = [];
  let run: RawPosition[] = [];
  let cLat = 0, cLng = 0;
  const flush = () => {
    if (run.length === 0) return;
    const arrived = run[0].timestamp, left = run[run.length - 1].timestamp;
    if (left.getTime() - arrived.getTime() >= STOP_MIN_MS) {
      out.push({ lat: round(cLat, 5), lng: round(cLng, 5), arrivedAt: iso(arrived), leftAt: iso(left), durationMin: Math.round((left.getTime() - arrived.getTime()) / 60000) });
    }
    run = [];
  };
  for (const p of pts) {
    if (run.length === 0) { run = [p]; cLat = p.lat; cLng = p.lng; continue; }
    const moving = p.speedKmh > STOP_SPEED_KMH;
    if (!moving && haversineMeters(cLat, cLng, p.lat, p.lng) <= STOP_RADIUS_M) {
      run.push(p); cLat += (p.lat - cLat) / run.length; cLng += (p.lng - cLng) / run.length;
    } else { flush(); run = [p]; cLat = p.lat; cLng = p.lng; }
  }
  flush();
  return out;
}

// ── Simplification de tracé (Douglas-Peucker) bornée à ~maxPoints ──
function simplify(pts: RawPosition[], maxPoints: number): RawPosition[] {
  if (pts.length <= maxPoints) return pts;
  // Tolérance croissante jusqu'à passer sous maxPoints (borne le nb d'itérations).
  let eps = 0.00005; // ~5 m
  let out = pts;
  for (let k = 0; k < 12 && out.length > maxPoints; k++) { out = rdp(pts, eps); eps *= 1.8; }
  return out.length > maxPoints ? everyNth(pts, Math.ceil(pts.length / maxPoints)) : out;
}
function rdp(pts: RawPosition[], eps: number): RawPosition[] {
  if (pts.length < 3) return pts;
  let idx = -1, dMax = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > dMax) { dMax = d; idx = i; }
  }
  if (dMax > eps && idx > 0) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function perpDist(p: RawPosition, a: RawPosition, b: RawPosition): number {
  const dx = b.lng - a.lng, dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy) || 1e-9;
  return Math.abs((p.lng - a.lng) * dy - (p.lat - a.lat) * dx) / len;
}
function everyNth<T>(arr: T[], n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}
function round(v: number, d: number): number { const f = 10 ** d; return Math.round(v * f) / f; }
