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
function setup(
  specs: Array<{
    id: string; plate: string; analyses: number; realTrips: number; score: number;
    /** Motif hors service — null (defaut) = vehicule en service. */
    horsService?: string | null;
  }>,
) {
  const vehicles = specs.map((s) => ({
    id: s.id,
    plate: s.plate,
    brand: 'X',
    model: 'Y',
    outOfServiceReason: s.horsService ?? null,
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

  it('⚠️ un véhicule HORS SERVICE sort du classement, sans attendre les 7 jours de dormance', async () => {
    /**
     * Un véhicule accidenté ou dont le boîtier est débranché au garage garde une note figée
     * qui continue de peser sur le rang des autres ET sur la moyenne de flotte. La dormance
     * finit par l'écarter — mais seulement après sept jours de silence. Le motif étant
     * DÉCLARÉ et non déduit, il n'y a rien à attendre : ici les deux véhicules ont un boîtier
     * qui a émis il y a une heure, donc aucun n'est dormant.
     */
    const { svc } = setup([
      { id: 'v-accidente', plate: 'KSR370', analyses: 40, realTrips: 40, score: 100, horsService: 'ACCIDENT' },
      { id: 'v-actif', plate: 'AL-927-QM', analyses: 40, realTrips: 40, score: 60 },
    ]);

    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows.map((r) => r.id)).toEqual(['v-actif']);
    // Et surtout : sa note de 100 ne tire plus la moyenne de flotte vers le haut.
    expect(res.rows[0]!.score).toBe(60);
  });

  it('… mais il ne DISPARAÎT pas : sa note reste consultable à part', async () => {
    // Ses trajets sont réels, sa note aussi. Ce qu'on lui retire est le rang et la
    // comparaison — pas l'historique. Un dossier d'assurance après accident en dépend.
    const { svc } = setup([
      { id: 'v-accidente', plate: 'KSR370', analyses: 40, realTrips: 40, score: 100, horsService: 'ACCIDENT' },
      { id: 'v-actif', plate: 'AL-927-QM', analyses: 40, realTrips: 40, score: 60 },
    ]);

    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    const ecarte = res.dormantRows?.find((r) => r.id === 'v-accidente');
    expect(ecarte).toBeDefined();
    expect(ecarte!.score).toBe(100);
  });

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

/**
 * ── ÉQUILIBRAGE DU CLASSEMENT (moyenne bayésienne) ───────────────────────────────────
 *
 * ⚠️ Le seuil de 20 écarte l'immesurable, mais laissait une injustice : un véhicule noté
 * sur 21 trajets n'a eu que 21 occasions de mal faire, là où un autre en a eu 200. Moins
 * on roule, moins on risque la faute — et le classement récompensait mécaniquement les
 * petits rouleurs.
 *
 *     score_classement = (n × observé + C × moyenne_flotte) / (n + C)
 *
 * Chaque entité part de la moyenne de flotte et gagne le droit de s'en écarter à mesure
 * qu'elle accumule des trajets.
 */
describe('DrivingScoreService — équilibrage par le nombre de trajets', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('à note ÉGALE, celui qui a le plus de trajets passe devant', async () => {
    const { svc } = setup([
      { id: 'v-peu', plate: 'PEU', analyses: 21, realTrips: 21, score: 95 },
      { id: 'v-beaucoup', plate: 'BEAUCOUP', analyses: 200, realTrips: 200, score: 95 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows.map((r) => r.id)).toEqual(['v-beaucoup', 'v-peu']);
    // ⚠️ La note AFFICHÉE reste la note observée : un conducteur doit reconnaître la
    // sienne. Seul l'ORDRE utilise le score pondéré.
    expect(res.rows.map((r) => r.score)).toEqual([95, 95]);
  });

  it('un PETIT avantage sur peu de trajets ne suffit plus à passer devant', async () => {
    /**
     * ⚠️ CE TEST A ÉTÉ ÉCRIT À L'ENVERS LA PREMIÈRE FOIS, et l'erreur mérite d'être notée.
     *
     * Il affirmait d'abord que 100/100 sur 21 trajets devait passer DERRIÈRE 96/100 sur
     * 300. La formule dit l'inverse (98,2 contre 96,0), et elle a raison : au-delà du
     * seuil de représentativité, quatre points d'écart sont un vrai signal de conduite,
     * pas un artefact d'échantillon. Corriger la constante pour faire passer ce test
     * aurait transformé le classement en compteur de kilomètres.
     *
     * La propriété réellement attendue est plus fine : un écart MINCE (ici 1 point) ne
     * survit pas à la pondération, alors qu'il décidait tout auparavant.
     */
    const { svc } = setup([
      { id: 'v-peu', plate: 'PEU', analyses: 21, realTrips: 21, score: 97 },
      { id: 'v-beaucoup', plate: 'BEAUCOUP', analyses: 300, realTrips: 300, score: 96 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    // Avant : 97 > 96, le petit échantillon gagnait. Maintenant, son point d'avance est
    // absorbé par le rappel vers la moyenne.
    expect(res.rows[0]!.id).toBe('v-beaucoup');
    expect(res.rows[1]!.id).toBe('v-peu');
    // …et les notes affichées, elles, n'ont pas bougé.
    expect(res.rows.map((r) => r.score)).toEqual([96, 97]);
  });

  it('mais un ÉCART RÉEL de conduite reste décisif — on n’écrase pas le signal', async () => {
    // ⚠️ Le garde-fou inverse : la pondération ne doit pas transformer le classement en
    // simple compteur de kilomètres. Un véhicule médiocre sur 300 trajets ne doit PAS
    // passer devant un très bon sur 60.
    const { svc } = setup([
      { id: 'v-bon', plate: 'BON', analyses: 60, realTrips: 60, score: 95 },
      { id: 'v-mediocre', plate: 'MEDIOCRE', analyses: 300, realTrips: 300, score: 70 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows[0]!.id).toBe('v-bon');
  });

  it('un véhicule SOUS la moyenne avec peu de trajets est remonté, pas enfoncé', async () => {
    // La pondération joue dans les DEUX sens : elle dit « on ne sait pas encore », pas
    // « il est mauvais ». Un petit échantillon médiocre est ramené vers la moyenne, donc
    // il passe devant un gros échantillon franchement pire.
    const { svc } = setup([
      { id: 'v-faible-peu', plate: 'FAIBLE', analyses: 21, realTrips: 21, score: 60 },
      { id: 'v-faible-beaucoup', plate: 'PIRE', analyses: 300, realTrips: 300, score: 55 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    expect(res.rows[0]!.id).toBe('v-faible-peu');
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
    // `gpsPoints` est un filtre de QUALITÉ de la donnée, pas de périmètre : il n'existe que
    // sur l'analyse (un trajet n'a pas cette colonne). Il est vérifié à part, juste après.
    for (const cle of Object.keys(whereAnalyses).filter((k) => k !== 'gpsPoints')) {
      expect(whereReal[cle]).toEqual(whereAnalyses[cle]);
    }
    // Une analyse sans aucune position vaut 100/100 par construction : la laisser entrer
    // dans la moyenne faisait monter au podium les véhicules les plus mal suivis.
    expect(whereAnalyses.gpsPoints).toEqual({ gt: 0 });
    // …et il ne compte que les trajets TERMINÉS, comme le reste des agrégats.
    expect(whereReal.endedAt).toEqual({ not: null });
  });
});
