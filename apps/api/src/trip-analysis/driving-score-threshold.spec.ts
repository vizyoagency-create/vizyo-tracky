import { DrivingScoreService } from './driving-score.service';

/**
 * ── SEUIL DE REPRÉSENTATIVITÉ ET TAUX D'ANALYSE ─────────────────────────────────────
 *
 * ⚠️ Constat relevé À L'ÉCRAN le 2026-08-03, sur le compte admin@cdef31.org :
 *
 *     🥇 HD-964-XY   100/100    2 trajets analysés  (sur 2 parcourus)
 *     🥈 HD-292-SH   100/100    1 trajet  analysé   (sur 75 parcourus)
 *     🥉 FR-629-AD    97/100   46 trajets analysés  (sur 104)
 *        AL-927-QM    96/100   99 trajets analysés  (sur 201)
 *
 * HD-292-SH avait roulé 75 fois. UN SEUL trajet avait été analysé — et il arrivait 2ᵉ de
 * la flotte. Le podium récompensait donc les véhicules les MOINS analysés, exactement
 * l'inverse de ce que l'écran promet.
 *
 * La note ne mesure pas la conduite : elle mesure un ÉCHANTILLON. Comparer une note issue
 * de 1 trajet à une note issue de 99 n'a aucun sens.
 *
 * Deux garanties sont verrouillées ici :
 *   1. sous le seuil, on n'est pas classé — mais on reste AFFICHÉ, à part ;
 *   2. le nombre de trajets réellement parcourus voyage, pour que l'écran puisse dire
 *      « 1 analysé sur 75 » au lieu d'un « 1 trajet » qui trompe.
 */

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-07-27T12:00:00.000Z').getTime();
const FROM = new Date(NOW - 90 * DAY).toISOString();
const TO = new Date(NOW).toISOString();
const USER = { id: 'u1', role: 'ADMIN' } as never;

/** Fabrique un parc : pour chaque véhicule, N analyses et M trajets réels. */
function setup(specs: Array<{ id: string; plate: string; analyses: number; realTrips: number; score: number }>) {
  const vehicles = specs.map((s) => ({
    id: s.id,
    plate: s.plate,
    brand: 'X',
    model: 'Y',
    tracker: { id: `tk-${s.id}`, lastSeenAt: new Date(NOW - 3600 * 1000) },
    groups: [],
  }));

  const trips = specs.flatMap((s) =>
    Array.from({ length: s.analyses }, (_, k) => ({
      id: `${s.id}-t${k}`,
      vehicleId: s.id,
      driverId: null,
      startedAt: new Date(NOW - DAY),
      driver: null,
    })),
  );

  const analyses = trips.map((t) => {
    const spec = specs.find((s) => s.id === t.vehicleId)!;
    return {
      tripId: t.id,
      vehicleId: t.vehicleId,
      ecoScore: spec.score,
      distanceKm: 10,
      speedingCount: 0,
      harshAccel: 0,
      harshBrake: 0,
      fuelLiters: 1,
      co2Kg: 2,
    };
  });

  const prisma = {
    tripAnalysis: { findMany: jest.fn().mockResolvedValue(analyses) },
    trip: {
      findMany: jest.fn().mockResolvedValue(trips),
      // Les trajets RÉELS, indépendants des analysés — c'est tout l'objet du taux.
      groupBy: jest.fn().mockResolvedValue(
        specs.map((s) => ({ vehicleId: s.id, driverId: null, _count: { _all: s.realTrips } })),
      ),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue(vehicles), findUnique: jest.fn().mockResolvedValue(null) },
  };
  const access = {
    getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL'),
    hasAccessToVehicle: jest.fn().mockResolvedValue(true),
  };
  return { svc: new DrivingScoreService(prisma as never, access as never), prisma };
}

describe('DrivingScoreService — seuil de représentativité', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('LE CAS SIGNALÉ : 1 analyse sur 75 trajets ne peut plus être 2ᵉ de la flotte', async () => {
    const { svc } = setup([
      { id: 'v-un', plate: 'HD-292-SH', analyses: 1, realTrips: 75, score: 100 },
      { id: 'v-beaucoup', plate: 'AL-927-QM', analyses: 99, realTrips: 201, score: 96 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows.map((r) => r.id)).toEqual(['v-beaucoup']);
    expect(res.rows[0]!.score).toBe(96);
    // …et il n'a pas DISPARU : il est listé à part, avec sa note.
    expect(res.insufficientCount).toBe(1);
    expect(res.insufficientRows[0]).toMatchObject({ id: 'v-un', score: 100, tripCount: 1 });
  });

  it('le seuil est de 20 analyses — 19 hors classement, 20 dedans', async () => {
    const { svc } = setup([
      { id: 'v-19', plate: 'A', analyses: 19, realTrips: 19, score: 100 },
      { id: 'v-20', plate: 'B', analyses: 20, realTrips: 20, score: 80 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows.map((r) => r.id)).toEqual(['v-20']);
    expect(res.insufficientRows.map((r) => r.id)).toEqual(['v-19']);
    // Le seuil VOYAGE, pour que l'écran affiche le vrai chiffre au lieu d'en recopier un.
    expect(res.minAnalysesForRanking).toBe(20);
  });

  it('la MOYENNE de flotte ne compte que les lignes classées', async () => {
    // ⚠️ Sans ce recalcul, la note de 100/100 issue d'un seul trajet continuerait de tirer
    // la moyenne vers le haut alors qu'elle n'apparaît plus dans le tableau : le client
    // comparerait ses véhicules à une valeur ne correspondant à aucune ligne visible.
    const { svc } = setup([
      { id: 'v-un', plate: 'A', analyses: 1, realTrips: 75, score: 100 },
      { id: 'v-beaucoup', plate: 'B', analyses: 20, realTrips: 20, score: 60 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.overallScore).toBe(60);
    expect(res.totalTrips).toBe(20);
  });

  it('classement vide plutôt que faux quand personne n’atteint le seuil', async () => {
    const { svc } = setup([{ id: 'v-un', plate: 'A', analyses: 3, realTrips: 50, score: 100 }]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows).toEqual([]);
    expect(res.overallScore).toBeNull();
    // Mais la ligne reste visible : « on les nomme, on ne les cache pas ».
    expect(res.insufficientCount).toBe(1);
  });
});

describe('DrivingScoreService — taux d’analyse', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rend les trajets RÉELS à côté des analysés', async () => {
    const { svc } = setup([{ id: 'v1', plate: 'A', analyses: 46, realTrips: 104, score: 97 }]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows[0]).toMatchObject({ tripCount: 46, totalTripCount: 104 });
  });

  it('ne rend JAMAIS un total inférieur aux analyses', async () => {
    // Un total plus petit que le nombre d'analyses afficherait un taux supérieur à 100 %.
    // Le cas paraît impossible ; il survient dès qu'un trajet est supprimé après analyse.
    const { svc } = setup([{ id: 'v1', plate: 'A', analyses: 30, realTrips: 5, score: 90 }]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows[0]!.totalTripCount).toBe(30);
  });

  it('le comptage réel est borné au MÊME périmètre que les analyses', async () => {
    // ⚠️ Un filtre plus large ferait fuir un total inter-flottes dans un simple ratio.
    const { svc, prisma } = setup([{ id: 'v1', plate: 'A', analyses: 20, realTrips: 40, score: 90 }]);
    await svc.scores(USER, 'vehicle', FROM, TO);

    const whereAnalyses = prisma.tripAnalysis.findMany.mock.calls[0][0].where;
    const whereReal = prisma.trip.groupBy.mock.calls[0][0].where;
    for (const cle of Object.keys(whereAnalyses)) {
      expect(whereReal[cle]).toEqual(whereAnalyses[cle]);
    }
    // …et il ne compte que les trajets TERMINÉS, comme le reste des agrégats.
    expect(whereReal.endedAt).toEqual({ not: null });
  });
});
