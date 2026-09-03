import { DrivingScoreService } from './driving-score.service';

/**
 * DORMANCE dans le classement de conduite.
 *
 * Le cas réel : FV-941-LZ, boîtier muet depuis 89 jours, gardait sa note figée et continuait de
 * concourir (et de tirer la moyenne de flotte) comme s'il roulait encore. Ces tests verrouillent les
 * trois frontières faciles à franchir par erreur :
 *  - le silence NORMAL (véhicule garé quelques heures) ne doit rien exclure ;
 *  - « jamais connecté » (véhicule de test sans boîtier) n'est PAS « s'est tu » ;
 *  - surtout : l'exclusion ne touche QUE le classement des véhicules — retirer les trajets d'un
 *    véhicule dont le boîtier est tombé punirait le conducteur qui les a parfaitement conduits.
 */

const H = 3600 * 1000;
const DAY = 24 * H;
const NOW = new Date('2026-07-27T12:00:00.000Z').getTime();
const FROM = new Date(NOW - 30 * DAY).toISOString();
const TO = new Date(NOW).toISOString();

type TrackerStub = { id: string; lastSeenAt: Date | null } | null;

const G1 = { group: { id: 'g1', name: 'Toulouse' } };

function makeVehicles(dormantLastSeenAt: Date | null, dormantTracker: TrackerStub = { id: 'tk-dorm', lastSeenAt: dormantLastSeenAt }) {
  return [
    // Silencieux 2 h : un véhicule garé le temps d'un déjeuner. Doit rester classé.
    { id: 'v-live', plate: 'AA-111-AA', brand: 'Renault', model: 'Clio', tracker: { id: 'tk-live', lastSeenAt: new Date(NOW - 2 * H) }, groups: [G1] },
    // Le dormant de production (89 j).
    { id: 'v-dorm', plate: 'FV-941-LZ', brand: 'Peugeot', model: '208', tracker: dormantTracker, groups: [G1] },
    // Véhicule de test SANS boîtier : membre légitime du parc, jamais exclu.
    { id: 'v-nobox', plate: 'TEST-001-XX', brand: null, model: null, tracker: null, groups: [] },
    // Boîtier posé mais qui n'a JAMAIS émis (provisioning KO) : « jamais connecté » ≠ « s'est tu ».
    { id: 'v-never', plate: 'BB-222-BB', brand: null, model: null, tracker: { id: 'tk-never', lastSeenAt: null }, groups: [] },
  ];
}

/**
 * ⚠️ CHAQUE VÉHICULE A `REPS` TRAJETS, ET C'EST DÉLIBÉRÉ.
 *
 * Depuis le 2026-08-03, une entité doit compter au moins {@link MIN_ANALYSES_FOR_RANKING}
 * analyses pour figurer au classement — sinon un véhicule noté sur un seul trajet arrivait
 * 2ᵉ de la flotte avec 100/100.
 *
 * Ces tests-ci portent sur la DORMANCE. Avec une seule analyse par véhicule, ils seraient
 * devenus rouges pour une raison sans rapport avec leur sujet, et on aurait été tenté de
 * baisser le seuil pour les faire passer — c'est-à-dire d'affaiblir le produit pour
 * arranger un test. On donne donc à chaque véhicule de quoi être classable, et le seuil
 * garde ses propres tests, séparés.
 */
const REPS = 25;

const TRIP_TEMPLATES = [
  { vehicleId: 'v-live', driverId: 'd1', ago: 3 * DAY, driver: { firstName: 'Karim', lastName: 'B.', color: '#0f0' } },
  // ⚠️ MÊME conducteur que le précédent, mais sur le véhicule devenu dormant.
  { vehicleId: 'v-dorm', driverId: 'd1', ago: 20 * DAY, driver: { firstName: 'Karim', lastName: 'B.', color: '#0f0' } },
  { vehicleId: 'v-nobox', driverId: null, ago: 5 * DAY, driver: null },
  { vehicleId: 'v-never', driverId: 'd2', ago: 6 * DAY, driver: { firstName: 'Léa', lastName: 'M.', color: '#00f' } },
];

const ANALYSIS_TEMPLATES: Record<string, { ecoScore: number; distanceKm: number; speedingCount: number; harshAccel: number; harshBrake: number; fuelLiters: number; co2Kg: number }> = {
  'v-live': { ecoScore: 90, distanceKm: 100, speedingCount: 0, harshAccel: 0, harshBrake: 0, fuelLiters: 6, co2Kg: 15 },
  'v-dorm': { ecoScore: 50, distanceKm: 200, speedingCount: 1, harshAccel: 2, harshBrake: 1, fuelLiters: 14, co2Kg: 35 },
  'v-nobox': { ecoScore: 70, distanceKm: 50, speedingCount: 0, harshAccel: 0, harshBrake: 0, fuelLiters: 3, co2Kg: 8 },
  'v-never': { ecoScore: 60, distanceKm: 80, speedingCount: 0, harshAccel: 1, harshBrake: 0, fuelLiters: 5, co2Kg: 12 },
};

const TRIPS = TRIP_TEMPLATES.flatMap((t, i) =>
  Array.from({ length: REPS }, (_, k) => ({
    id: `t${i + 1}-${k}`,
    vehicleId: t.vehicleId,
    driverId: t.driverId,
    startedAt: new Date(NOW - t.ago),
    driver: t.driver,
  })),
);

const ANALYSES = TRIPS.map((t) => ({
  tripId: t.id,
  vehicleId: t.vehicleId,
  ...ANALYSIS_TEMPLATES[t.vehicleId]!,
}));

/**
 * `absent` = le véhicule que `findUnique` renverra pour une entité ABSENTE du classement (aucun
 * trajet dans la période) : c'est par là que passe la fiche d'un véhicule muet depuis 89 j.
 * `access` = réponse du contrôle d'accès véhicule (anti-IDOR) sur ce repli.
 */
function makeSvc(
  vehicles: ReturnType<typeof makeVehicles>,
  opts: { absent?: { tracker: TrackerStub } | null; access?: boolean } = {},
) {
  const prisma = {
    tripAnalysis: { findMany: jest.fn().mockResolvedValue(ANALYSES) },
    trip: {
      findMany: jest.fn().mockResolvedValue(TRIPS),
      // Comptage des trajets RÉELLEMENT parcourus (taux d'analyse). Dérivé de TRIPS pour
      // que le mock reste cohérent avec lui-même : un total inventé rendrait les tests
      // verts sur des ratios impossibles.
      groupBy: jest.fn().mockResolvedValue(
        Object.values(
          TRIPS.reduce<Record<string, { vehicleId: string; driverId: string | null; _count: { _all: number } }>>(
            (acc, t) => {
              const key = `${t.vehicleId}|${t.driverId ?? ''}`;
              acc[key] ??= { vehicleId: t.vehicleId, driverId: t.driverId ?? null, _count: { _all: 0 } };
              acc[key]._count._all += 1;
              return acc;
            },
            {},
          ),
        ),
      ),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue(vehicles),
      findUnique: jest.fn().mockResolvedValue(opts.absent ?? null),
    },
  };
  const access = {
    getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL'),
    hasAccessToVehicle: jest.fn().mockResolvedValue(opts.access ?? true),
  };
  return { svc: new DrivingScoreService(prisma as never, access as never), prisma, access };
}

const USER = { id: 'u1', role: 'ADMIN' } as never;

describe('DrivingScoreService — dormance (seuil « arrêter de compter », 7 j)', () => {
  beforeEach(() => {
    // Horloge figée : la dormance est dérivée au read-time, tout dépend de « maintenant ».
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('classement VÉHICULE : le dormant sort du classement ET de la moyenne, mais reste listé à part', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.scores(USER, 'vehicle', FROM, TO);

    // (a) exclu du classement
    expect(res.rows.map((r) => r.id)).toEqual(['v-live', 'v-nobox', 'v-never']);
    expect(res.rankedCount).toBe(3);
    // …mais PAS disparu de l'écran : listé à part, avec la raison chiffrée.
    expect(res.dormantExcludedCount).toBe(1);
    expect(res.dormantExcludedTrips).toBe(REPS);
    expect(res.dormantRows).toHaveLength(1);
    expect(res.dormantRows[0]).toMatchObject({ id: 'v-dorm', label: 'FV-941-LZ', score: 50, silenceLabel: '89 j' });
    expect(res.dormantRows[0].lastSeenAt).toBe(new Date(NOW - 89 * DAY).toISOString());
    // La moyenne affichée ne doit contenir QUE les lignes visibles : (90+70+60)/3.
    // Moyenne pondérée par les KILOMÈTRES depuis le 3 septembre :
    // (90×100 + 70×50 + 60×80) / 230 km = 75,2. En moyenne simple, elle valait 73 — et un
    // aller-retour de 2 km y pesait autant que 300 km d'autoroute.
    expect(res.overallScore).toBe(75);
    expect(res.totalTrips).toBe(3 * REPS);
  });

  it('(b) un véhicule silencieux 2 h reste classé — un stationnement n\'est pas une dormance', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.scores(USER, 'vehicle', FROM, TO);
    expect(res.rows.some((r) => r.id === 'v-live')).toBe(true);
    expect(res.dormantRows.some((r) => r.id === 'v-live')).toBe(false);
  });

  it('(b bis) 6 j de silence : encore sous le seuil de 7 j, toujours classé', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 6 * DAY)));
    const res = await svc.scores(USER, 'vehicle', FROM, TO);
    expect(res.rows.map((r) => r.id)).toContain('v-dorm');
    expect(res.dormantExcludedCount).toBe(0);
  });

  it('(c) véhicule SANS boîtier et boîtier n\'ayant JAMAIS émis : ni l\'un ni l\'autre n\'est dormant', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.scores(USER, 'vehicle', FROM, TO);
    expect(res.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['v-nobox', 'v-never']));
    expect(res.dormantRows.map((r) => r.id)).not.toEqual(expect.arrayContaining(['v-nobox', 'v-never']));
  });

  it('(d) réintégration : dès que le boîtier ré-émet, le véhicule reprend sa place sans aucune action', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 10 * 60 * 1000)));
    const res = await svc.scores(USER, 'vehicle', FROM, TO);
    expect(res.rows.map((r) => r.id)).toEqual(['v-live', 'v-nobox', 'v-never', 'v-dorm']);
    expect(res.dormantExcludedCount).toBe(0);
    expect(res.dormantRows).toEqual([]);
    expect(res.totalTrips).toBe(4 * REPS);
    // Pondérée : (90×100 + 70×50 + 60×80 + 50×200) / 430 km = 63,5. En moyenne simple : 68.
    expect(res.overallScore).toBe(63);
  });

  it('PIÈGE — classement CONDUCTEUR : les trajets du véhicule dormant restent comptés (le boîtier est tombé, pas le conducteur)', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.scores(USER, 'driver', FROM, TO);

    const karim = res.rows.find((r) => r.id === 'd1');
    expect(karim).toBeDefined();
    // Ses DEUX trajets comptent, dont celui fait sur FV-941-LZ avant la panne du boîtier.
    expect(karim!.tripCount).toBe(2 * REPS);
    // Pondérée : (90×100 + 50×200) / 300 km = 63,3. En moyenne simple : 70 — le trajet de
    // 200 km comptait autant que celui de 100.
    expect(karim!.score).toBe(63);
    // Rien n'est jamais écarté hors du scope « vehicle ».
    expect(res.dormantExcludedCount).toBe(0);
    expect(res.dormantRows).toEqual([]);
    expect(res.totalTrips).toBe(3 * REPS); // t1 + t2 + t4 (t3 sans conducteur, exclusion préexistante)
  });

  it('PIÈGE — classement GROUPE : idem, un groupe ne paie pas la panne matérielle d\'un de ses véhicules', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.scores(USER, 'group', FROM, TO);

    const g1 = res.rows.find((r) => r.id === 'g1');
    expect(g1).toBeDefined();
    expect(g1!.tripCount).toBe(2 * REPS);
    // Pondérée : (90×100 + 50×200) / 300 km = 63,3. En moyenne simple : 70.
    expect(g1!.score).toBe(63);
    expect(res.dormantExcludedCount).toBe(0);
    expect(res.totalTrips).toBe(2 * REPS);
  });

  it('période PASSÉE : un véhicule vivant à l\'époque reste classé, on ne réécrit pas l\'histoire', async () => {
    // Boîtier tombé il y a 20 j ; on demande un rapport qui s'arrête il y a 40 j : à cette date le
    // véhicule roulait encore, il doit figurer normalement dans le classement de cette période.
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 20 * DAY)));
    const res = await svc.scores(USER, 'vehicle', new Date(NOW - 70 * DAY).toISOString(), new Date(NOW - 40 * DAY).toISOString());
    expect(res.rows.map((r) => r.id)).toContain('v-dorm');
    expect(res.dormantExcludedCount).toBe(0);
  });

  it('la dormance ne coûte AUCUNE requête : `tracker` est joint à la requête véhicules existante', async () => {
    const { svc, prisma } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    await svc.scores(USER, 'vehicle', FROM, TO);
    expect(prisma.vehicle.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.findMany.mock.calls[0][0].select.tracker).toEqual({ select: { id: true, lastSeenAt: true } });
  });

  it('entityScore d\'un dormant : la fiche garde sa note et explique l\'absence de rang (pas d\'écran vide)', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.entityScore(USER, 'vehicle', 'v-dorm', FROM, TO);
    expect(res.row).not.toBeNull();
    expect(res.row!.score).toBe(50);
    expect(res.dormant).toBe(true);
    expect(res.silenceLabel).toBe('89 j');
    expect(res.rank).toBeNull(); // il ne concourt plus
    expect(res.vsOverall).toBeNull(); // ni ne compose la moyenne à laquelle on le comparerait
  });

  it('entityScore d\'un véhicule vivant : inchangé (rang + écart à la moyenne)', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.entityScore(USER, 'vehicle', 'v-live', FROM, TO);
    expect(res.dormant).toBe(false);
    expect(res.rank).toBe(1);
    // La moyenne de flotte est pondérée par les kilomètres depuis le 3 septembre : 75, et non
    // plus 73. L'écart du véhicule à cette moyenne suit.
    expect(res.vsOverall).toBe(90 - 75);
  });

  it('le « / N » de la fiche rétrécit AVEC son explication (nb d\'écartés)', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    const res = await svc.entityScore(USER, 'vehicle', 'v-live', FROM, TO);
    // 3 classés au lieu de 4 : le chiffre baisse, mais jamais en silence.
    expect(res.total).toBe(3);
    expect(res.dormantExcludedCount).toBe(1);
  });

  /**
   * LE cas de production, et le seul qui compte vraiment : un boîtier muet depuis 89 j n'a produit
   * AUCUN trajet dans la période de 30 j affichée par défaut. Le véhicule est donc absent du
   * classement ET de la liste des écartés (qui se construit à partir des trajets). Sans repli, sa
   * fiche restait l'écran vide qu'on prétendait supprimer.
   */
  it('fiche d\'un dormant SANS AUCUN trajet dans la période : dit pourquoi, au lieu de rester muette', async () => {
    const { svc, prisma } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)), {
      absent: { tracker: { id: 'tk-abs', lastSeenAt: new Date(NOW - 89 * DAY) } },
    });
    const res = await svc.entityScore(USER, 'vehicle', 'v-absent', FROM, TO);
    expect(res.row).toBeNull(); // aucun trajet à noter : c'est un fait, on ne l'invente pas
    expect(res.dormant).toBe(true);
    expect(res.silenceLabel).toBe('89 j');
    expect(prisma.vehicle.findUnique).toHaveBeenCalledTimes(1);
  });

  it('même fiche, mais le véhicule vient de se réveiller : plus rien à signaler', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)), {
      absent: { tracker: { id: 'tk-abs', lastSeenAt: new Date(NOW - 3 * 60 * 1000) } },
    });
    const res = await svc.entityScore(USER, 'vehicle', 'v-absent', FROM, TO);
    expect(res.dormant).toBe(false);
    expect(res.silenceLabel).toBeNull();
  });

  it('fiche d\'un véhicule SANS boîtier et sans trajet : silencieuse, mais surtout pas « dormante »', async () => {
    const { svc } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)), { absent: { tracker: null } });
    const res = await svc.entityScore(USER, 'vehicle', 'v-absent', FROM, TO);
    expect(res.dormant).toBe(false);
    expect(res.silenceLabel).toBeNull();
  });

  it('ANTI-IDOR : hors périmètre, on ne lit même pas le boîtier (pas de fuite d\'ancienneté)', async () => {
    const { svc, prisma, access } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)), {
      absent: { tracker: { id: 'tk-abs', lastSeenAt: new Date(NOW - 89 * DAY) } },
      access: false,
    });
    const res = await svc.entityScore(USER, 'vehicle', 'v-autre-flotte', FROM, TO);
    expect(access.hasAccessToVehicle).toHaveBeenCalledWith(USER, 'v-autre-flotte');
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    expect(res.dormant).toBe(false);
  });

  it('un id qui n\'est pas un UUID ne doit pas transformer une fiche vide en erreur 500', async () => {
    const { svc, prisma } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    prisma.vehicle.findUnique.mockRejectedValue(new Error('Malformed UUID'));
    const res = await svc.entityScore(USER, 'vehicle', 'pas-un-uuid', FROM, TO);
    expect(res.row).toBeNull();
    expect(res.dormant).toBe(false);
  });

  it('scopes conducteur/groupe : aucune lecture de boîtier (la dormance n\'y a pas cours)', async () => {
    const { svc, prisma } = makeSvc(makeVehicles(new Date(NOW - 89 * DAY)));
    await svc.entityScore(USER, 'driver', 'd-inconnu', FROM, TO);
    await svc.entityScore(USER, 'group', 'g-inconnu', FROM, TO);
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
  });
});
