/**
 * Helpers purs et testables pour le module Rapports.
 *
 * Toutes ces fonctions sont :
 *   - sans dependance Angular (testable sans TestBed),
 *   - defensives par construction (clamp les valeurs aberrantes),
 *   - alignees sur le contrat backend (`apps/api/src/trips/trips.service.ts`)
 *     et le plafond de vitesse `TRIP_MAX_PLAUSIBLE_SPEED_KMH = 250 km/h`
 *     (cf. `packages/shared/src/utils/gps-sanity.ts`).
 *
 * Verrouilles par `reports.utils.spec.ts` — toute regression ramene des
 * "-11min" / "9999 km/h" dans le tableau rapports.
 */

/** Plafond defensif vitesse km/h (aligne sur backend). */
export const REPORT_MAX_PLAUSIBLE_SPEED_KMH = 250;

/** Clamp d'un nombre quelconque en >= 0 (tolere `null`, `undefined`, NaN). */
export function max0(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return n > 0 ? n : 0;
}

/** Clamp d'une vitesse en km/h dans [0, 250]. */
export function clampSpeed(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > REPORT_MAX_PLAUSIBLE_SPEED_KMH) return REPORT_MAX_PLAUSIBLE_SPEED_KMH;
  return n;
}

/**
 * Formate une duree en secondes vers "Xh00" / "Xmin".
 * Defensif : negatives, NaN, Infinity, null → "0min".
 */
export function formatDuration(seconds: number | null | undefined): string {
  const s = (seconds != null && Number.isFinite(seconds) && seconds > 0)
    ? seconds
    : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}min`;
}

/**
 * Sous-ensemble du `TripDto` necessaire au calcul des KPI rapports.
 * On reste laxe sur les types pour pouvoir nourrir les tests avec des
 * objets minimaux sans devoir construire un `TripDto` complet.
 */
export interface TripKpiShape {
  durationSeconds: number;
  distanceMeters: number;
  maxSpeed: number;
}

export interface ReportsKpis {
  tripCount: number;
  totalDistance: number; // metres, >= 0
  totalDuration: number; // secondes, >= 0
  maxSpeed: number;      // km/h, [0, 250]
}

/**
 * Agregation defensive des KPI a partir d'une liste de trips.
 * Toutes les valeurs negatives ou aberrantes sont clampees AVANT l'agregation,
 * donc les totaux sont garantis >= 0 et coherents avec ce que la page
 * affiche cellule par cellule.
 */
/** Ligne d'agrégat journalier, telle que l'API la renvoie. */
export interface DailySummaryShape {
  tripCount: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  maxSpeed: number;
}

/**
 * KPI calculés depuis l'AGRÉGAT SERVEUR — la seule source complète.
 *
 * ══ Pourquoi cette fonction remplace `aggregateKpis` sur l'écran Rapports ═════════════
 *
 * Les KPI étaient calculés depuis `trips()`, la liste affichée dans le tableau. Or cette
 * liste est demandée avec `limit: '100'` : elle ne contient JAMAIS plus de cent trajets.
 *
 * Mesure en production (2026-08-03), sur SEPT jours :
 *
 *     cdef31 ....... 622 trajets      mh cars ...... 729      A2R .......... 425
 *
 * Les trois flottes dépassent le plafond, même sur la période la plus courte. Deux
 * conséquences, et la seconde est celle qui a été signalée :
 *
 *   1. les KPI étaient FAUX en permanence — « 100 trajets » au lieu de 622, distance
 *      totale divisée par six ;
 *   2. changer la période ne changeait RIEN à l'écran. De 7 à 30 jours, on retombait sur
 *      les mêmes cent trajets les plus récents, donc sur les mêmes chiffres. Le filtre
 *      paraissait cassé alors qu'il fonctionnait : c'est le plafond qui masquait son effet.
 *
 * L'agrégat journalier (`GET /trips/daily-summary`) est calculé côté serveur sans aucune
 * limite, sur exactement les mêmes filtres. C'est la bonne source, et elle existait déjà.
 *
 * ⚠️ `maxSpeed` est le MAXIMUM des maxima journaliers, pas leur somme — l'erreur classique
 * de ce type d'agrégation.
 */
export function aggregateKpisFromDaily(days: ReadonlyArray<DailySummaryShape>): ReportsKpis {
  let tripCount = 0;
  let totalDistance = 0;
  let totalDuration = 0;
  let maxSpeed = 0;
  for (const d of days) {
    tripCount += max0(d.tripCount);
    totalDistance += max0(d.totalDistanceMeters);
    totalDuration += max0(d.totalDurationSeconds);
    const spd = clampSpeed(d.maxSpeed);
    if (spd > maxSpeed) maxSpeed = spd;
  }
  return { tripCount, totalDistance, totalDuration, maxSpeed };
}

/**
 * ⚠️ CONSERVÉE, mais ne doit PLUS servir aux KPI de l'écran Rapports : elle agrège la
 * liste AFFICHÉE, qui est plafonnée. Utiliser `aggregateKpisFromDaily` pour tout total
 * de période. Celle-ci reste juste pour agréger un ensemble de trajets déjà complet.
 */
export function aggregateKpis(trips: ReadonlyArray<TripKpiShape>): ReportsKpis {
  let totalDistance = 0;
  let totalDuration = 0;
  let maxSpeed = 0;
  for (const t of trips) {
    totalDistance += max0(t.distanceMeters);
    totalDuration += max0(t.durationSeconds);
    const spd = clampSpeed(t.maxSpeed);
    if (spd > maxSpeed) maxSpeed = spd;
  }
  return {
    tripCount: trips.length,
    totalDistance,
    totalDuration,
    maxSpeed,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Sprint 5 — Helpers PÉRIODE (plage personnalisée).
 *
 * Centralise la logique date de la plage perso (objectif #2) en fonctions
 * pures testables. Toutes manipulent des dates « inclusives » au format
 * YYYY-MM-DD (ce que l'utilisateur saisit dans les deux inputs), AVANT la
 * conversion en `to` exclusif (+1 jour) faite cote composant.
 *
 * Regles :
 *   - auto-remplissage : `from` saisi + `to` vide  →  `to = aujourd'hui` (borne).
 *   - no-future : aucune date ne peut depasser aujourd'hui (clampee).
 *   - coherence : `from <= to <= aujourd'hui`. Si `from > to` (apres clamp),
 *     un message clair est renvoye (le composant n'applique pas la plage).
 *   - max 365 jours (aligne sur l'ancienne validation `applyCustomRange`).
 * ──────────────────────────────────────────────────────────────────────── */

const MS_PER_DAY = 86_400_000;
/** Plafond de plage en jours (aligne sur l'ancienne validation existante). */
export const REPORT_MAX_RANGE_DAYS = 365;

/** Vrai si la chaine est une date ISO calendaire stricte YYYY-MM-DD valide. */
export function isIsoDate(s: string | null | undefined): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  // Rejette les dates « overflow » (ex: 2024-02-31 → 2024-03-02).
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m! - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Aujourd'hui au format YYYY-MM-DD en HEURE LOCALE (pas UTC) — coherent avec
 * `ReportsComponent.localIso`. `toISOString()` decalerait d'un jour pres de
 * minuit pour un user a UTC+X.
 */
export function todayIsoLocal(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Borne une date ISO (YYYY-MM-DD) a `maxIso` : si elle est apres `maxIso`, on
 * la ramene a `maxIso`. Defensif : entrees invalides renvoyees telles quelles.
 * La comparaison lexicographique de chaines YYYY-MM-DD == comparaison de dates.
 */
export function clampDateToMax(iso: string, maxIso: string): string {
  if (!isIsoDate(iso) || !isIsoDate(maxIso)) return iso;
  return iso > maxIso ? maxIso : iso;
}

/** Nombre de jours (inclusifs) couverts par [from, to]. Suppose from <= to. */
export function inclusiveDaySpan(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

export interface NormalizedRange {
  /** Date de debut inclusive (YYYY-MM-DD), eventuellement clampee. */
  from: string;
  /** Date de fin inclusive (YYYY-MM-DD), auto-remplie / clampee. */
  to: string;
  /** Message d'erreur FR a afficher, ou '' si la plage est valide. */
  error: string;
  /**
   * Vrai si la plage est saisie et coherente (from & to valides, from <= to,
   * <= aujourd'hui, <= 365j) → le composant peut l'appliquer.
   */
  valid: boolean;
}

/**
 * Normalise la plage personnalisee saisie (objectif #2). C'est LE helper
 * testable qui porte toute la logique :
 *   1. auto-remplit `to = aujourd'hui` si `from` est saisi et `to` vide ;
 *   2. clampe `from` et `to` a aujourd'hui (no-future) ;
 *   3. verifie la coherence `from <= to <= aujourd'hui` (message si non) ;
 *   4. verifie le plafond de 365 jours.
 *
 * Ne mute rien ; renvoie une nouvelle plage + un eventuel message. Le `to`
 * reste INCLUSIF (la conversion en exclusif +1j est faite cote composant).
 */
export function normalizeCustomRange(
  input: { from: string; to: string },
  todayIso: string = todayIsoLocal(),
): NormalizedRange {
  const rawFrom = (input.from ?? '').trim();
  let rawTo = (input.to ?? '').trim();

  // (1) Auto-remplissage : "a partir de" saisi mais "jusqu'a" vide → aujourd'hui.
  if (rawFrom && !rawTo) {
    rawTo = todayIso;
  }

  // Plage encore incomplete : pas d'erreur (l'utilisateur n'a pas fini), juste
  // pas applicable.
  if (!rawFrom || !rawTo) {
    return { from: rawFrom, to: rawTo, error: '', valid: false };
  }

  if (!isIsoDate(rawFrom) || !isIsoDate(rawTo)) {
    return { from: rawFrom, to: rawTo, error: 'Date invalide.', valid: false };
  }

  // (2) No-future : on clampe les deux bornes a aujourd'hui.
  const from = clampDateToMax(rawFrom, todayIso);
  const to = clampDateToMax(rawTo, todayIso);

  // (3) Coherence from <= to (apres clamp).
  if (from > to) {
    return {
      from,
      to,
      error: 'La date de début doit être antérieure à la date de fin.',
      valid: false,
    };
  }

  // (4) Plafond 365 jours.
  if (inclusiveDaySpan(from, to) > REPORT_MAX_RANGE_DAYS) {
    return {
      from,
      to,
      error: `La plage ne peut pas dépasser ${REPORT_MAX_RANGE_DAYS} jours.`,
      valid: false,
    };
  }

  return { from, to, error: '', valid: true };
}

/* ────────────────────────────────────────────────────────────────────────
 * Sprint 5 — Helpers TRI du tableau (objectif #4, client-side).
 *
 * Le tri se fait en memoire sur les ~100 trajets deja charges → zero serveur.
 * `compareTrips` est un comparateur STABLE (depart croissant comme cle de
 * depart) pour des resultats deterministes. Le mapping KPI→colonne permet
 * a la carte « Vitesse max » de declencher le bon tri.
 * ──────────────────────────────────────────────────────────────────────── */

/** Colonnes triables du tableau rapports. */
export type TripSortColumn =
  | 'startedAt'
  | 'durationSeconds'
  | 'distanceMeters'
  | 'avgSpeed'
  | 'maxSpeed';

export type SortDirection = 'asc' | 'desc';

/** Sous-ensemble d'un trip suffisant pour le tri (laxe pour les tests). */
export interface TripSortShape {
  startedAt: string | null;
  durationSeconds: number;
  distanceMeters: number;
  avgSpeed: number;
  maxSpeed: number;
}

/** Valeur numerique comparable d'un trip pour une colonne donnee. */
function sortValue(t: TripSortShape, col: TripSortColumn): number {
  switch (col) {
    case 'startedAt':
      return t.startedAt ? Date.parse(t.startedAt) || 0 : 0;
    case 'durationSeconds':
      return max0(t.durationSeconds);
    case 'distanceMeters':
      return max0(t.distanceMeters);
    case 'avgSpeed':
      return clampSpeed(t.avgSpeed);
    case 'maxSpeed':
      return clampSpeed(t.maxSpeed);
  }
}

/**
 * Comparateur de deux trips sur une colonne + direction. Stable : en cas
 * d'egalite, on retombe sur la date de depart croissante (puis 0) pour un
 * ordre deterministe quelle que soit la direction demandee.
 */
export function compareTrips(
  a: TripSortShape,
  b: TripSortShape,
  col: TripSortColumn,
  dir: SortDirection,
): number {
  const va = sortValue(a, col);
  const vb = sortValue(b, col);
  const primary = va < vb ? -1 : va > vb ? 1 : 0;
  // La direction n'inverse QUE la comparaison principale. Le tie-break reste
  // toujours croissant (startedAt) → ordre STABLE et deterministe quelle que
  // soit la direction, y compris desc.
  const directed = dir === 'desc' ? -primary : primary;
  if (directed !== 0 || col === 'startedAt') return directed;
  const ta = a.startedAt ? Date.parse(a.startedAt) || 0 : 0;
  const tb = b.startedAt ? Date.parse(b.startedAt) || 0 : 0;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/**
 * Trie une copie de la liste (ne mute pas l'entree). Renvoie un NOUVEAU
 * tableau — important pour les signaux Angular (nouvelle reference = re-render).
 */
export function sortTrips<T extends TripSortShape>(
  trips: ReadonlyArray<T>,
  col: TripSortColumn,
  dir: SortDirection,
): T[] {
  return [...trips].sort((a, b) => compareTrips(a, b, col, dir));
}

/**
 * Mapping carte KPI → colonne de tri (objectif #4). Cliquer une carte KPI
 * trie le tableau sur la colonne correspondante (desc par defaut, defini
 * cote composant). `null` = carte non cliquable (pas de colonne mappee).
 */
export function kpiToSortColumn(
  kpi: 'tripCount' | 'totalDistance' | 'totalDuration' | 'maxSpeed',
): TripSortColumn | null {
  switch (kpi) {
    case 'totalDistance':
      return 'distanceMeters';
    case 'totalDuration':
      return 'durationSeconds';
    case 'maxSpeed':
      return 'maxSpeed';
    case 'tripCount':
      return null;
  }
}
