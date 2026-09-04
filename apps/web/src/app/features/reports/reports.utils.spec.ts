/**
 * Tests Jasmine des helpers du module Rapports.
 *
 * Verrouille les invariants visuels critiques :
 *   - jamais de "-11min" affiche (formatDuration clampe a 0),
 *   - jamais de "9999 km/h" (clampSpeed plafonne a 250),
 *   - les KPI totaux ne sommen jamais des valeurs negatives heritees.
 */
import {
  REPORT_MAX_PLAUSIBLE_SPEED_KMH,
  REPORT_MAX_RANGE_DAYS,
  aggregateKpis,
  clampDateToMax,
  clampSpeed,
  compareTrips,
  formatDuration,
  inclusiveDaySpan,
  isIsoDate,
  kpiToSortColumn,
  max0,
  normalizeCustomRange,
  sortTrips,
  todayIsoLocal,
  type TripSortShape,
  aggregateKpisFromDaily,
  type DailySummaryShape,
  estJourIso,
  ecartAvecPeriodePrecedente,
  periodePrecedente,
  libelleEcartPeriode,
} from './reports.utils';

describe('reports.utils — formatDuration', () => {
  it('formats a positive duration in minutes', () => {
    expect(formatDuration(0)).toBe('0min');
    expect(formatDuration(60)).toBe('1min');
    expect(formatDuration(599)).toBe('9min');
    expect(formatDuration(2700)).toBe('45min');
  });

  it('formats a positive duration in hours and minutes', () => {
    expect(formatDuration(3600)).toBe('1h00');
    expect(formatDuration(3661)).toBe('1h01');
    expect(formatDuration(7320)).toBe('2h02');
    expect(formatDuration(36_000)).toBe('10h00');
  });

  it('clamps NEGATIVE durations to "0min" (legacy bug fix)', () => {
    // Le bug prod : -660 secondes affichait "-11min" car
    // Math.floor(-660/60) === -11. Doit afficher "0min".
    expect(formatDuration(-660)).toBe('0min');
    expect(formatDuration(-1)).toBe('0min');
    expect(formatDuration(-999_999)).toBe('0min');
  });

  it('treats NaN / Infinity / null / undefined as 0', () => {
    expect(formatDuration(NaN)).toBe('0min');
    expect(formatDuration(Infinity)).toBe('0min');
    expect(formatDuration(-Infinity)).toBe('0min');
    expect(formatDuration(null)).toBe('0min');
    expect(formatDuration(undefined)).toBe('0min');
  });
});

describe('reports.utils — max0', () => {
  it('returns the value when positive', () => {
    expect(max0(0)).toBe(0);
    expect(max0(1)).toBe(1);
    expect(max0(99999)).toBe(99999);
  });

  it('clamps negatives to 0', () => {
    expect(max0(-1)).toBe(0);
    expect(max0(-1500)).toBe(0);
  });

  it('treats NaN / Infinity / null / undefined as 0', () => {
    expect(max0(NaN)).toBe(0);
    expect(max0(Infinity)).toBe(0);
    expect(max0(-Infinity)).toBe(0);
    expect(max0(null)).toBe(0);
    expect(max0(undefined)).toBe(0);
  });
});

describe('reports.utils — clampSpeed', () => {
  it('returns the value when in [0, 250]', () => {
    expect(clampSpeed(0)).toBe(0);
    expect(clampSpeed(50)).toBe(50);
    expect(clampSpeed(250)).toBe(250);
  });

  it('clamps negatives to 0', () => {
    expect(clampSpeed(-1)).toBe(0);
    expect(clampSpeed(-99)).toBe(0);
  });

  it('caps glitches above 250 km/h', () => {
    expect(clampSpeed(251)).toBe(REPORT_MAX_PLAUSIBLE_SPEED_KMH);
    expect(clampSpeed(9999)).toBe(REPORT_MAX_PLAUSIBLE_SPEED_KMH);
    expect(clampSpeed(Infinity)).toBe(0); // not finite → 0
  });

  it('treats NaN / null / undefined as 0', () => {
    expect(clampSpeed(NaN)).toBe(0);
    expect(clampSpeed(null)).toBe(0);
    expect(clampSpeed(undefined)).toBe(0);
  });
});

describe('reports.utils — aggregateKpis', () => {
  it('returns zeroed KPI for empty list', () => {
    expect(aggregateKpis([])).toEqual({
      tripCount: 0,
      totalDistance: 0,
      totalDuration: 0,
      maxSpeed: 0,
    });
  });

  it('sums healthy trips correctly', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
      { durationSeconds: 300, distanceMeters: 2000, maxSpeed: 110 },
      { durationSeconds: 900, distanceMeters: 8000, maxSpeed: 95 },
    ]);
    expect(kpis.tripCount).toBe(3);
    expect(kpis.totalDistance).toBe(15_000);
    expect(kpis.totalDuration).toBe(1800);
    expect(kpis.maxSpeed).toBe(110);
  });

  it('IGNORES legacy trips with negative duration in totals (bug fix)', () => {
    const kpis = aggregateKpis([
      { durationSeconds: -660, distanceMeters: 24_500, maxSpeed: 133 }, // bug prod
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
    ]);
    // -660 NE doit PAS retrancher du total. Total = 0 + 600 = 600.
    expect(kpis.totalDuration).toBe(600);
    // Distance non-impactee.
    expect(kpis.totalDistance).toBe(24_500 + 5000);
  });

  it('ignores negative distances in totals', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: -1500, maxSpeed: 80 },
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
    ]);
    expect(kpis.totalDistance).toBe(5000);
  });

  it('caps glitch maxSpeed at 250 km/h', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 9999 },
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
    ]);
    expect(kpis.maxSpeed).toBe(250);
  });

  it('keeps maxSpeed correct when only negative speeds exist', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: -50 },
    ]);
    expect(kpis.maxSpeed).toBe(0);
  });
});

/* ─── Sprint 5 — PÉRIODE (objectif #2) ─── */

describe('reports.utils — isIsoDate', () => {
  it('accepte une date calendaire valide', () => {
    expect(isIsoDate('2026-06-27')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true); // annee bissextile
  });

  it('rejette format invalide ou date overflow', () => {
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate('2026-6-7')).toBe(false);
    expect(isIsoDate('27/06/2026')).toBe(false);
    expect(isIsoDate('2026-02-31')).toBe(false); // overflow → rejete
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
});

describe('reports.utils — clampDateToMax / inclusiveDaySpan', () => {
  it('clampe une date au-dela du max', () => {
    expect(clampDateToMax('2026-12-31', '2026-06-27')).toBe('2026-06-27');
    expect(clampDateToMax('2026-01-01', '2026-06-27')).toBe('2026-01-01');
    expect(clampDateToMax('2026-06-27', '2026-06-27')).toBe('2026-06-27');
  });

  it('compte les jours inclusifs', () => {
    expect(inclusiveDaySpan('2026-06-27', '2026-06-27')).toBe(1);
    expect(inclusiveDaySpan('2026-06-01', '2026-06-30')).toBe(30);
    expect(inclusiveDaySpan('2026-01-01', '2026-12-31')).toBe(365);
  });
});

describe('reports.utils — todayIsoLocal', () => {
  it('formate aujourd\'hui en YYYY-MM-DD heure LOCALE (pas UTC)', () => {
    // 7 juin 2026 23h30 heure locale → doit rester le 07, pas basculer le 08.
    const d = new Date(2026, 5, 7, 23, 30);
    expect(todayIsoLocal(d)).toBe('2026-06-07');
  });
});

describe('reports.utils — normalizeCustomRange (auto-fill + cohérence)', () => {
  const TODAY = '2026-06-27';

  it('auto-remplit « jusqu\'a » = aujourd\'hui quand from saisi et to vide', () => {
    const r = normalizeCustomRange({ from: '2026-06-01', to: '' }, TODAY);
    expect(r.from).toBe('2026-06-01');
    expect(r.to).toBe(TODAY);
    expect(r.error).toBe('');
    expect(r.valid).toBe(true);
  });

  it('pas d\'erreur tant que les deux champs sont vides (saisie en cours)', () => {
    const r = normalizeCustomRange({ from: '', to: '' }, TODAY);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('');
  });

  it('clampe une date de fin future a aujourd\'hui (no-future)', () => {
    const r = normalizeCustomRange({ from: '2026-06-01', to: '2099-01-01' }, TODAY);
    expect(r.to).toBe(TODAY);
    expect(r.valid).toBe(true);
  });

  it('clampe une date de debut future → from = today', () => {
    const r = normalizeCustomRange({ from: '2099-01-01', to: '2099-02-01' }, TODAY);
    expect(r.from).toBe(TODAY);
    expect(r.to).toBe(TODAY);
    expect(r.valid).toBe(true);
  });

  it('renvoie un message clair quand from > to', () => {
    const r = normalizeCustomRange({ from: '2026-06-20', to: '2026-06-10' }, TODAY);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('antérieure');
  });

  it('refuse une plage > 365 jours', () => {
    const r = normalizeCustomRange({ from: '2024-01-01', to: '2026-06-27' }, TODAY);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(String(REPORT_MAX_RANGE_DAYS));
  });

  it('accepte une plage de 365 jours exactement', () => {
    const r = normalizeCustomRange({ from: '2025-06-28', to: '2026-06-27' }, TODAY);
    expect(inclusiveDaySpan(r.from, r.to)).toBe(365);
    expect(r.valid).toBe(true);
    expect(r.error).toBe('');
  });

  it('signale une date invalide', () => {
    const r = normalizeCustomRange({ from: 'pas-une-date', to: '2026-06-27' }, TODAY);
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Date invalide.');
  });

  it('garde le « to » INCLUSIF (le +1 jour exclusif est fait par le composant)', () => {
    const r = normalizeCustomRange({ from: '2026-06-10', to: '2026-06-15' }, TODAY);
    expect(r.to).toBe('2026-06-15');
  });
});

/* ─── Sprint 5 — TRI du tableau + mapping KPI (objectif #4) ─── */

describe('reports.utils — tri du tableau', () => {
  const trip = (over: Partial<TripSortShape>): TripSortShape => ({
    startedAt: '2026-06-10T08:00:00.000Z',
    durationSeconds: 600,
    distanceMeters: 5000,
    avgSpeed: 40,
    maxSpeed: 80,
    ...over,
  });

  it('compareTrips trie par maxSpeed desc (le plus rapide en premier)', () => {
    const a = trip({ maxSpeed: 50 });
    const b = trip({ maxSpeed: 120 });
    expect(compareTrips(a, b, 'maxSpeed', 'desc')).toBeGreaterThan(0);
    expect(compareTrips(b, a, 'maxSpeed', 'desc')).toBeLessThan(0);
  });

  it('compareTrips trie par distance asc', () => {
    const a = trip({ distanceMeters: 1000 });
    const b = trip({ distanceMeters: 9000 });
    expect(compareTrips(a, b, 'distanceMeters', 'asc')).toBeLessThan(0);
  });

  it('sortTrips ne mute pas l\'entree et renvoie une nouvelle reference', () => {
    const input = [trip({ maxSpeed: 30 }), trip({ maxSpeed: 90 }), trip({ maxSpeed: 60 })];
    const snapshot = input.map((t) => t.maxSpeed);
    const out = sortTrips(input, 'maxSpeed', 'desc');
    expect(out).not.toBe(input);
    expect(input.map((t) => t.maxSpeed)).toEqual(snapshot);
    expect(out.map((t) => t.maxSpeed)).toEqual([90, 60, 30]);
  });

  it('sortTrips maxSpeed desc — la 1ere ligne est le trajet le plus rapide', () => {
    const out = sortTrips(
      [trip({ maxSpeed: 70 }), trip({ maxSpeed: 142 }), trip({ maxSpeed: 30 })],
      'maxSpeed',
      'desc',
    );
    expect(out[0]!.maxSpeed).toBe(142);
  });

  it('tri STABLE : a vitesse egale, tie-break sur startedAt croissant', () => {
    const t1 = trip({ maxSpeed: 100, startedAt: '2026-06-10T10:00:00.000Z' });
    const t2 = trip({ maxSpeed: 100, startedAt: '2026-06-10T08:00:00.000Z' });
    const t3 = trip({ maxSpeed: 100, startedAt: '2026-06-10T09:00:00.000Z' });
    const desc = sortTrips([t1, t2, t3], 'maxSpeed', 'desc');
    expect(desc.map((t) => t.startedAt)).toEqual([
      '2026-06-10T08:00:00.000Z',
      '2026-06-10T09:00:00.000Z',
      '2026-06-10T10:00:00.000Z',
    ]);
  });

  it('clampe les valeurs aberrantes avant tri (9999 km/h ~ 250)', () => {
    const out = sortTrips(
      [trip({ maxSpeed: 9999 }), trip({ maxSpeed: 200 })],
      'maxSpeed',
      'desc',
    );
    expect(clampSpeed(out[0]!.maxSpeed)).toBe(250);
  });

  it('tri par startedAt dans les deux sens', () => {
    const early = trip({ startedAt: '2026-06-01T00:00:00.000Z' });
    const late = trip({ startedAt: '2026-06-20T00:00:00.000Z' });
    expect(compareTrips(early, late, 'startedAt', 'asc')).toBeLessThan(0);
    expect(compareTrips(early, late, 'startedAt', 'desc')).toBeGreaterThan(0);
  });
});

describe('reports.utils — kpiToSortColumn (mapping KPI→colonne)', () => {
  it('Vitesse max → maxSpeed', () => {
    expect(kpiToSortColumn('maxSpeed')).toBe('maxSpeed');
  });
  it('Distance → distanceMeters', () => {
    expect(kpiToSortColumn('totalDistance')).toBe('distanceMeters');
  });
  it('Duree → durationSeconds', () => {
    expect(kpiToSortColumn('totalDuration')).toBe('durationSeconds');
  });
  /**
   * ⚠️ ATTENTE INVERSÉE LE 2026-09-04 (F18).
   *
   * `null` faisait de la carte « Trajets » une IMPASSE : trois cartes sur quatre affichaient
   * un nombre et n'offraient rien à en faire. Un compte n'a certes pas de colonne à trier —
   * mais il a une destination : la liste des trajets, dans son ordre naturel.
   */
  it('Trajets → startedAt (la liste, dans son ordre naturel)', () => {
    expect(kpiToSortColumn('tripCount')).toBe('startedAt');
  });
});

/**
 * ── KPI DE PÉRIODE : l'agrégat SERVEUR, jamais la liste affichée ─────────────────────
 *
 * ⚠️ INCIDENT DU 2026-08-03, signalé par le client : « les KPI ne changent pas quand je
 * modifie le filtre date ».
 *
 * Les KPI étaient calculés depuis `trips()`, la liste du tableau, demandée avec
 * `limit: '100'`. Or les trois flottes de production dépassent 100 trajets même sur SEPT
 * jours (622 / 729 / 425). Conséquences :
 *
 *   - les totaux étaient faux en permanence (100 au lieu de 622) ;
 *   - et surtout IDENTIQUES d'une période à l'autre, puisqu'on retombait toujours sur les
 *     cent derniers trajets. Le filtre semblait cassé alors qu'il fonctionnait.
 */
describe('aggregateKpisFromDaily — les KPI portent sur la période ENTIÈRE', () => {
  const jour = (over: Partial<DailySummaryShape> = {}): DailySummaryShape => ({
    tripCount: 10,
    totalDistanceMeters: 1000,
    totalDurationSeconds: 600,
    maxSpeed: 90,
    ...over,
  });

  it('somme les compteurs journaliers, sans aucun plafond', () => {
    // 70 jours × 10 trajets = 700, très au-dessus des 100 que le tableau peut afficher.
    const k = aggregateKpisFromDaily(Array.from({ length: 70 }, () => jour()));
    expect(k.tripCount).toBe(700);
    expect(k.totalDistance).toBe(70_000);
    expect(k.totalDuration).toBe(42_000);
  });

  it('prend le MAXIMUM des vitesses, jamais leur somme', () => {
    // L'erreur classique de ce type d'agrégation : une vitesse max de 260 km/h sur un
    // écran de gestion de flotte se remarque, mais seulement si quelqu'un regarde.
    const k = aggregateKpisFromDaily([jour({ maxSpeed: 80 }), jour({ maxSpeed: 130 }), jour({ maxSpeed: 95 })]);
    expect(k.maxSpeed).toBe(130);
  });

  it('ELARGIR LA PÉRIODE CHANGE LES CHIFFRES — le défaut signalé', () => {
    const sept = Array.from({ length: 7 }, () => jour({ tripCount: 89 }));   // 623
    const trente = Array.from({ length: 30 }, () => jour({ tripCount: 89 })); // 2670

    const k7 = aggregateKpisFromDaily(sept);
    const k30 = aggregateKpisFromDaily(trente);

    // ⚠️ C'est CETTE assertion qui aurait attrapé le bug : avec l'ancien calcul, les deux
    // périodes rendaient exactement 100 trajets, donc des KPI identiques.
    expect(k7.tripCount).toBe(623);
    expect(k30.tripCount).toBe(2670);
    expect(k30.tripCount).toBeGreaterThan(k7.tripCount);
    expect(k30.totalDistance).toBeGreaterThan(k7.totalDistance);
  });

  it('une période vide rend des zéros, pas des NaN', () => {
    expect(aggregateKpisFromDaily([])).toEqual({
      tripCount: 0,
      totalDistance: 0,
      totalDuration: 0,
      maxSpeed: 0,
    });
  });

  it('ignore les valeurs négatives héritées au lieu de fausser le total', () => {
    const k = aggregateKpisFromDaily([jour({ totalDistanceMeters: -500, tripCount: -3 })]);
    expect(k.totalDistance).toBe(0);
    expect(k.tripCount).toBe(0);
  });
});

/**
 * ── LA PÉRIODE ARRIVE MAINTENANT PAR L'URL, ET L'URL SE BRICOLE ─────────────────────
 *
 * Depuis le 2026-09-04, la page Rapports lit `?from=…&to=…` au démarrage. Un lien tronqué
 * dans un courriel, un copier-coller de travers ou un paramètre tapé à la main doivent être
 * IGNORÉS — pas interprétés de travers. Une période fausse ne se voit pas : l'écran affiche
 * des chiffres parfaitement crédibles pour des dates que personne n'a demandées.
 */
describe('estJourIso — ce qu’on accepte de lire dans une URL', () => {
  it('accepte un jour civil réel', () => {
    expect(estJourIso('2026-09-04')).toBe(true);
    expect(estJourIso('2028-02-29')).toBe(true); // année bissextile
  });

  it('refuse ce qui n’a pas la forme d’un jour civil', () => {
    expect(estJourIso(null)).toBe(false);
    expect(estJourIso('')).toBe(false);
    expect(estJourIso('2026-9-4')).toBe(false);
    expect(estJourIso('04/09/2026')).toBe(false);
    expect(estJourIso('2026-09-04T12:00:00Z')).toBe(false);
    expect(estJourIso('hier')).toBe(false);
  });

  /**
   * ⚠️ LE CŒUR DE LA VÉRIFICATION. Ces trois chaînes passent l'expression régulière et
   * donnent une date VALIDE, mais pas celle qui est écrite : `new Date('2026-02-31')` rend
   * un 3 mars. Sans ce contrôle, un rapport « du 31 février » s'affichait sur mars.
   */
  it('refuse une date bien formée mais inexistante', () => {
    expect(estJourIso('2026-02-31')).toBe(false);
    expect(estJourIso('2026-02-30')).toBe(false);
    expect(estJourIso('2027-02-29')).toBe(false); // 2027 n'est pas bissextile
    expect(estJourIso('2026-13-01')).toBe(false);
    expect(estJourIso('2026-04-31')).toBe(false);
  });
});

/**
 * ── LA COMPARAISON AVEC LA PÉRIODE PRÉCÉDENTE (F03) ────────────────────────────────
 *
 * Deux pièges, et ils sont tous les deux silencieux : le pourcentage calculé depuis zéro,
 * et la fenêtre précédente calculée en millisecondes.
 */
describe('ecartAvecPeriodePrecedente — le zéro n’est pas un point de départ', () => {
  it('calcule une hausse et une baisse', () => {
    expect(ecartAvecPeriodePrecedente(112, 100)).toEqual({ pourcent: 12, absolu: 12, precedentVide: false });
    expect(ecartAvecPeriodePrecedente(80, 100)).toEqual({ pourcent: -20, absolu: -20, precedentVide: false });
  });

  it('rend un écart NUL quand rien ne bouge', () => {
    expect(ecartAvecPeriodePrecedente(100, 100).pourcent).toBe(0);
  });

  /**
   * ⚠️ 0 → 65 n'est pas « +6 500 % » ni « +∞ % » : c'est une variation dont le pourcentage
   * n'a aucun sens. On rend `null` et l'écran écrit la phrase.
   */
  it('refuse de calculer un pourcentage depuis zéro', () => {
    const e = ecartAvecPeriodePrecedente(65, 0);
    expect(e.pourcent).toBeNull();
    expect(e.precedentVide).toBe(true);
    expect(e.absolu).toBe(65);
  });

  it('rend zéro sur zéro sans exploser', () => {
    const e = ecartAvecPeriodePrecedente(0, 0);
    expect(e.pourcent).toBeNull();
    expect(e.absolu).toBe(0);
  });
});

describe('periodePrecedente — la fenêtre d’avant, en jours civils', () => {
  it('recule d’exactement la durée de la période', () => {
    // Du 1er au 8 (borne haute exclusive) = 7 jours → la précédente va du 25 au 1er.
    expect(periodePrecedente('2026-08-01', '2026-08-08')).toEqual({ from: '2026-07-25', to: '2026-08-01' });
  });

  it('la borne haute de la période précédente EST la borne basse de l’actuelle', () => {
    // Sans quoi un jour serait compté deux fois, ou aucune fois.
    const p = periodePrecedente('2026-09-01', '2026-10-01');
    expect(p?.to).toBe('2026-09-01');
    expect(p?.from).toBe('2026-08-02');
  });

  it('traverse un changement d’heure sans perdre ni gagner un jour', () => {
    // La bascule vers l'heure d'été a lieu le 29 mars 2026 : la journée dure 23 h.
    expect(periodePrecedente('2026-04-01', '2026-04-08')).toEqual({ from: '2026-03-25', to: '2026-04-01' });
    // Retour à l'heure d'hiver le 25 octobre : la journée dure 25 h.
    expect(periodePrecedente('2026-10-26', '2026-11-02')).toEqual({ from: '2026-10-19', to: '2026-10-26' });
  });

  it('refuse une période mal formée plutôt que d’en inventer une', () => {
    expect(periodePrecedente('', '2026-09-01')).toBeNull();
    expect(periodePrecedente('2026-09-01', '2026-09-01')).toBeNull();
    expect(periodePrecedente('2026-09-08', '2026-09-01')).toBeNull();
    expect(periodePrecedente('2026-02-31', '2026-03-08')).toBeNull();
  });
});

/**
 * ── « +11 925 % » N'EST PAS UNE MESURE ──────────────────────────────────────────────
 *
 * Constaté en recette le 2026-09-04 sous le nombre de trajets. Arithmétiquement exact,
 * pratiquement illisible : personne ne se représente onze mille pour cent, et le chiffre
 * occupe la place d'une information.
 */
describe('libelleEcartPeriode — la forme qui se lit', () => {
  it('garde le pourcentage tant qu’il reste lisible', () => {
    expect(libelleEcartPeriode(112, 100)).toBe('+12 % vs période précédente');
    expect(libelleEcartPeriode(80, 100)).toBe('−20 % vs période précédente');
    expect(libelleEcartPeriode(100, 100)).toBe('stable vs période précédente');
    // Juste sous le seuil : encore un pourcentage.
    expect(libelleEcartPeriode(299, 100)).toBe('+199 % vs période précédente');
  });

  it('passe au MULTIPLE à partir du triplement', () => {
    // ×2,4 (+140 %) reste en dessous du seuil : le pourcentage s'y lit encore très bien.
    expect(libelleEcartPeriode(240, 100)).toBe('+140 % vs période précédente');
    expect(libelleEcartPeriode(300, 100)).toBe('×3,0 vs période précédente');
    // Le cas de la recette : 481 trajets contre 4, soit « +11 925 % » avant correction.
    expect(libelleEcartPeriode(481, 4)).toBe('×120 vs période précédente');
  });

  it('refuse toujours de comparer à zéro', () => {
    expect(libelleEcartPeriode(65, 0)).toBeNull();
    expect(libelleEcartPeriode(0, 0)).toBeNull();
  });

  /** Une baisse ne dépasse jamais −100 % : le pourcentage y reste la forme juste. */
  it('laisse les baisses en pourcentage', () => {
    expect(libelleEcartPeriode(1, 1000)).toBe('−100 % vs période précédente');
  });
});
