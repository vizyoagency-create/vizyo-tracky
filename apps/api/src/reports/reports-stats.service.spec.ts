/**
 * LOT « dénominateurs — rapports » : la moyenne kilométrique se calcule sur le
 * parc EXPLOITÉ, pas sur le parc entier.
 *
 * Cas réel qui a motivé ces tests (prod, 39 véhicules) : FV-941-LZ muet depuis
 * 89 j et FL-787-KV depuis 52 j — boîtiers déposés / batterie débranchée — étaient
 * comptés au dénominateur à 0 km garanti. La « distance moyenne par véhicule »
 * envoyée au client chaque semaine était donc mécaniquement sous-évaluée.
 *
 * Ce que ces tests verrouillent, dans l'ordre d'importance :
 *   1. un dormant (> 7 j de silence) sort du dénominateur ;
 *   2. un véhicule simplement silencieux 2 h (week-end, parking) N'EN SORT PAS ;
 *   3. un véhicule SANS boîtier n'est pas traité comme une panne ;
 *   4. la réintégration est automatique dès que `lastSeenAt` redevient frais ;
 *   5. rien ne baisse en silence : total du parc inchangé + mention chiffrée ;
 *   6. un parc 100 % dormant ne produit ni NaN ni Infinity.
 */
import { UserRole } from '@prisma/client';
import { parisDayStart } from '../common/utils/datetime';
import { buildExploitedScopeNotice, FleetStatsReport, ReportsStatsService } from './reports-stats.service';

const FLEET_ID = 'fleet-1';
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-06-30T23:59:59.000Z');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

interface VehicleFixture {
  id: string;
  plate: string;
  /** null = aucun boîtier affecté (véhicule de test / pas encore équipé). */
  trackerId: string | null;
  /** null = boîtier affecté qui n'a JAMAIS émis (provisionnement KO). */
  lastSeenAt: Date | null;
  km: number;
}

/**
 * Prisma minimal : seules les 6 requêtes réellement émises par `compute` sont
 * simulées. Les agrégats trips sont dérivés des fixtures pour que le total et le
 * détail par véhicule ne puissent pas diverger dans le test lui-même.
 */
function makePrisma(fixtures: VehicleFixture[]) {
  const vehicleRows = fixtures.map((f) => ({
    id: f.id,
    plate: f.plate,
    type: 'CAR',
    fuelConsumptionL100km: 7,
    calibratedConsumptionL100km: null,
    calibratedTanks: 0,
    groups: [],
    tracker: f.trackerId ? { id: f.trackerId, lastSeenAt: f.lastSeenAt } : null,
  }));
  const tripGroups = fixtures
    .filter((f) => f.km > 0)
    .map((f) => ({ vehicleId: f.id, _sum: { distanceKm: f.km }, _count: { _all: 1 } }));
  const totalKm = tripGroups.reduce((s, g) => s + g._sum.distanceKm, 0);

  return {
    fleet: {
      findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte test', fuelPriceEurL: 1.85 }),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue(vehicleRows) },
    trip: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: tripGroups.length },
        _sum: { distanceKm: totalKm, durationSeconds: 3600 * tripGroups.length },
        _avg: { avgSpeed: 42 },
        _max: { maxSpeed: 110 },
      }),
      groupBy: jest.fn().mockResolvedValue(tripGroups),
      findMany: jest.fn().mockResolvedValue([]),
    },
    alert: { groupBy: jest.fn().mockResolvedValue([]) },
    tripFuelStop: {
      aggregate: jest.fn().mockResolvedValue({ _avg: { unitPriceEur: null }, _count: { _all: 0 } }),
    },
    // Excès par véhicule (F06) : requête SQL brute sur le détail JSON des analyses.
    // ⚠️ Un simulacre qui l'omet décrit un client Prisma qui n'existe pas — et le service
    // échouerait ici pour une raison sans rapport avec ce que ces tests examinent.
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
}

const compute = (fixtures: VehicleFixture[]): Promise<FleetStatsReport> =>
  new ReportsStatsService(makePrisma(fixtures)).compute(FLEET_ID, FROM, TO, {
    role: UserRole.FLEET_ADMIN,
    fleetId: FLEET_ID,
    accessibleVehicleIds: 'ALL',
  });

/**
 * Parc de référence, calqué sur la prod :
 *  - 2 véhicules vivants (trame il y a quelques minutes) ;
 *  - 1 véhicule silencieux 2 h (garé, boîtier en veille) → DOIT rester compté ;
 *  - 1 dormant à 89 j qui a roulé EN DÉBUT de période puis s'est tu ;
 *  - 1 véhicule de test sans boîtier.
 */
const PARC: VehicleFixture[] = [
  { id: 'v-live-1', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(5 * 60 * 1000), km: 100 },
  { id: 'v-live-2', plate: 'AA-222-AA', trackerId: 't2', lastSeenAt: ago(30 * 60 * 1000), km: 50 },
  { id: 'v-parked', plate: 'AA-333-AA', trackerId: 't3', lastSeenAt: ago(2 * HOUR), km: 30 },
  { id: 'v-dormant', plate: 'FV-941-LZ', trackerId: 't4', lastSeenAt: ago(89 * DAY), km: 20 },
  { id: 'v-no-tracker', plate: 'TEST-001-XX', trackerId: null, lastSeenAt: null, km: 0 },
];

describe('ReportsStatsService — parc exploité (dénominateur des moyennes)', () => {
  it('exclut le dormant (89 j) du dénominateur, garde le silencieux 2 h et le sans-boîtier à part', async () => {
    const report = await compute(PARC);

    expect(report.vehicles.total).toBe(5); // total contractuel : INCHANGÉ
    expect(report.vehicles.exploited).toBe(3); // 2 live + le garé depuis 2 h
    expect(report.vehicles.dormant).toBe(1);
    expect(report.vehicles.withoutTracker).toBe(1);
    expect(report.vehicles.dormantVehicles.map((v) => v.plate)).toEqual(['FV-941-LZ']);
  });

  it('divise par le parc exploité, pas par le parc entier (le chiffre client était faux)', async () => {
    const report = await compute(PARC);

    // Ancien calcul : 200 km / 5 véhicules = 40 km. Le dormant et le véhicule de
    // test tiraient la moyenne vers le bas sans jamais pouvoir rouler.
    expect(report.trips.avgKmBasisVehicles).toBe(3);
    expect(report.trips.avgKmBasisKm).toBe(180); // 100 + 50 + 30
    expect(report.trips.avgKmPerVehicle).toBe(60);
  });

  it('ne fait baisser AUCUN total : les km du dormant restent dans la distance totale', async () => {
    const report = await compute(PARC);

    // Le dormant a roulé 20 km en début de période : on l'écarte de la MOYENNE,
    // jamais de l'historique ni du total affiché.
    expect(report.trips.totalKm).toBe(200);
  });

  it("un véhicule silencieux 2 h reste dans le dénominateur (silence normal d'un véhicule garé)", async () => {
    const report = await compute([
      { id: 'v1', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(2 * HOUR), km: 40 },
    ]);

    expect(report.vehicles.exploited).toBe(1);
    expect(report.vehicles.dormant).toBe(0);
    expect(report.trips.avgKmPerVehicle).toBe(40);
    expect(buildExploitedScopeNotice(report)).toBeNull();
  });

  it("un véhicule silencieux 6 j reste compté ; à 8 j il sort (frontière des 7 j)", async () => {
    const before = await compute([
      { id: 'v1', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(6 * DAY), km: 10 },
    ]);
    expect(before.vehicles.exploited).toBe(1);
    expect(before.vehicles.dormant).toBe(0);

    const after = await compute([
      { id: 'v1', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(8 * DAY), km: 10 },
    ]);
    expect(after.vehicles.exploited).toBe(0);
    expect(after.vehicles.dormant).toBe(1);
  });

  it("un véhicule SANS boîtier n'est pas un dormant (il ne s'est pas tu, il n'a jamais parlé)", async () => {
    const report = await compute([
      { id: 'v-live', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(5 * 60 * 1000), km: 90 },
      { id: 'v-test', plate: 'TEST-001-XX', trackerId: null, lastSeenAt: null, km: 0 },
      // Boîtier affecté mais JAMAIS connecté (SIM/APN KO) : même traitement.
      { id: 'v-never', plate: 'TEST-002-XX', trackerId: 't9', lastSeenAt: null, km: 0 },
    ]);

    expect(report.vehicles.dormant).toBe(0);
    expect(report.vehicles.dormantVehicles).toEqual([]);
    expect(report.vehicles.withoutTracker).toBe(2);
    expect(report.trips.avgKmPerVehicle).toBe(90); // 90 km / 1 véhicule exploité
    // La mention ne parle pas de « signal perdu » pour ces deux-là.
    expect(buildExploitedScopeNotice(report)).not.toContain('sans signal');
    expect(buildExploitedScopeNotice(report)).toContain('2 véhicules sans boîtier');
  });

  it('réintègre automatiquement dès que lastSeenAt redevient frais (aucun bouton, aucun flag)', async () => {
    const reveille = PARC.map((v) =>
      v.id === 'v-dormant' ? { ...v, lastSeenAt: ago(3 * 60 * 1000) } : v,
    );
    const report = await compute(reveille);

    expect(report.vehicles.dormant).toBe(0);
    expect(report.vehicles.exploited).toBe(4);
    expect(report.trips.avgKmBasisVehicles).toBe(4);
    expect(report.trips.avgKmPerVehicle).toBe(50); // 200 km / 4
  });

  it('parc 100 % dormant : un chiffre, jamais NaN ni Infinity', async () => {
    const report = await compute([
      { id: 'v1', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(60 * DAY), km: 0 },
      { id: 'v2', plate: 'AA-222-AA', trackerId: 't2', lastSeenAt: ago(90 * DAY), km: 0 },
    ]);

    expect(report.vehicles.exploited).toBe(0);
    expect(Number.isFinite(report.trips.avgKmPerVehicle)).toBe(true);
    expect(report.trips.avgKmPerVehicle).toBe(0);
    expect(report.trips.avgKmBasisVehicles).toBe(2); // repli sur le parc entier
    expect(buildExploitedScopeNotice(report)).toContain('Aucun véhicule exploité');
  });

  it('flotte vide : aucune division, aucune mention', async () => {
    const report = await compute([]);

    expect(report.trips.avgKmPerVehicle).toBe(0);
    expect(Number.isFinite(report.trips.avgKmPerVehicle)).toBe(true);
    expect(buildExploitedScopeNotice(report)).toBeNull();
  });

  it('charge lastSeenAt via la requête véhicules DÉJÀ existante (pas de requête en plus)', async () => {
    const prisma = makePrisma(PARC);
    await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO);

    expect(prisma.vehicle.findMany).toHaveBeenCalledTimes(1);
    const select = prisma.vehicle.findMany.mock.calls[0][0].select;
    expect(select.tracker).toEqual({ select: { id: true, lastSeenAt: true } });
  });
});

describe('buildExploitedScopeNotice — rien ne change en silence', () => {
  it('nomme les plaques, l’ancienneté, et promet la réintégration automatique', async () => {
    const report = await compute(PARC);
    const notice = buildExploitedScopeNotice(report)!;

    expect(notice).toContain('1 véhicule sans signal boîtier depuis plus de 7 j');
    expect(notice).toContain('FV-941-LZ');
    expect(notice).toContain('89 j');
    expect(notice).toContain('réintégré dès la première trame reçue');
    // La base de calcul est écrite noir sur blanc, et le parc facturé rappelé.
    expect(notice).toContain('3 véhicules exploités');
    expect(notice).toContain('parc total inchangé : 5');
  });

  it('quand la moyenne BAISSE, la mention est là aussi (le sens qui fâche)', async () => {
    // Contre-exemple volontaire : l'exclusion ne flatte pas toujours le chiffre.
    // Un véhicule qui a beaucoup roulé PUIS dont le boîtier est tombé sort du
    // numérateur ET du dénominateur — la moyenne s'effondre (255 km → 10 km).
    // C'est exactement le cas où le client doit lire POURQUOI, sinon il conclut
    // que son parc s'est arrêté de rouler.
    const report = await compute([
      { id: 'v-live', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(4 * 60 * 1000), km: 10 },
      { id: 'v-hs', plate: 'FL-787-KV', trackerId: 't2', lastSeenAt: ago(30 * DAY), km: 500 },
    ]);

    expect(report.trips.avgKmPerVehicle).toBe(10); // avant : 510 / 2 = 255
    expect(report.trips.totalKm).toBe(510); // le total, lui, ne bouge pas d'un km
    const notice = buildExploitedScopeNotice(report)!;
    expect(notice).not.toBeNull();
    expect(notice).toContain('FL-787-KV');
    expect(notice).toContain('parc total inchangé : 2');
  });

  it("date le silence à la GÉNÉRATION, pas à la période (un rapport de juin ré-édité ne ment pas)", async () => {
    // `lastSeenAt` est lu maintenant : la mention doit donc dire d'où vient le
    // « 89 j », sinon un rapport de juin ré-imprimé en octobre semble affirmer que
    // le boîtier était déjà muet en juin.
    const notice = buildExploitedScopeNotice(await compute(PARC))!;
    expect(notice).toContain('silence constaté à la date de génération');
  });

  it("ne dit jamais « sans boîtier » d'un boîtier posé mais jamais connecté", async () => {
    // Le compteur `withoutTracker` mélange « pas équipé » et « équipé mais jamais
    // vu » : écrire « sans boîtier » au gestionnaire qui vient de faire poser le
    // boîtier lui fait contester le rapport.
    const notice = buildExploitedScopeNotice(
      await compute([
        { id: 'v-live', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(60 * 1000), km: 10 },
        { id: 'v-never', plate: 'TEST-002-XX', trackerId: 't9', lastSeenAt: null, km: 0 },
      ]),
    )!;
    expect(notice).toContain('sans boîtier actif');
    expect(notice).toContain('boîtier jamais connecté');
  });

  /**
   * ⚠️ SOUS FILTRE CONDUCTEUR, LA DERNIÈRE PHRASE CHANGE DE SUJET (F13).
   *
   * « Distance moyenne calculée sur 3 véhicules exploités (180.0 km) » donne au lecteur les
   * deux moitiés d'une division — et l'invite à la refaire. Sous filtre, ces kilomètres sont
   * ceux d'UNE personne : la phrase affirmerait que le parc exploité a roulé 180 km. La base
   * ne se divise plus par le parc, et la mention doit le dire, sinon le document argumente
   * une base que son propre numérateur n'a plus.
   */
  it('sous filtre conducteur, la mention ne parle plus du parc exploité', async () => {
    const report = await compute(PARC);
    const notice = buildExploitedScopeNotice(report, { filtreConducteur: true })!;

    expect(notice).toContain('jamais par le parc');
    expect(notice).toContain('180.0 km sur 3 véhicules');
    expect(notice).toContain('Parc total inchangé : 5'); // le parc facturé, lui, ne bouge pas
    // La phrase de flotte, elle, a disparu — c'est elle qui affirmait un faux.
    expect(notice).not.toContain('véhicules exploités');
    // Les plaques et la réintégration automatique restent dites : le filtre n'efface pas
    // l'information de dormance, il ne change QUE la base annoncée.
    expect(notice).toContain('FV-941-LZ');
    expect(notice).toContain('réintégré dès la première trame reçue');
  });

  /**
   * ⚠️ BASE VIDE SOUS FILTRE : ATTEIGNABLE, ET LA PHRASE DOIT LE SUPPORTER.
   *
   * Un conducteur qui n'a pas roulé du mois (congés, arrêt) ne fait rouler aucun véhicule :
   * `avgKmBasisVehicles` vaut 0 et `avgKmPerVehicle` vaut 0 par garde. La phrase de base
   * écrirait alors « 0.0 km sur 0 véhicule » — une division par zéro mise en forme, dans un
   * document que le client relit des mois plus tard. On dit l'absence de base, pas son
   * calcul. Le reste de la mention (plaques, parc total) décrit le PARC : il ne bouge pas.
   */
  it('base vide sous filtre : la mention dit l’absence de base, pas « 0 km sur 0 véhicule »', async () => {
    const report = await compute(PARC);
    const sansTrajet: FleetStatsReport = {
      ...report,
      trips: { ...report.trips, avgKmBasisVehicles: 0, avgKmBasisKm: 0, avgKmPerVehicle: 0 },
    };
    const notice = buildExploitedScopeNotice(sansTrajet, { filtreConducteur: true })!;

    expect(notice).toContain('aucun trajet retenu par ce filtre sur la période');
    expect(notice).not.toContain('sur 0 véhicule');
    // Le parc facturé et les plaques dormantes restent dits : le filtre ne les efface pas.
    expect(notice).toContain('Parc total inchangé : 5');
    expect(notice).toContain('FV-941-LZ');
  });

  it('aucune mention sur un parc sain (pas de bruit permanent)', async () => {
    const report = await compute([
      { id: 'v1', plate: 'AA-111-AA', trackerId: 't1', lastSeenAt: ago(60 * 1000), km: 12 },
    ]);
    expect(buildExploitedScopeNotice(report)).toBeNull();
  });

  it('tronque la liste des plaques et annonce le reste (une flotte entière ne noie pas le rapport)', async () => {
    const fixtures: VehicleFixture[] = Array.from({ length: 9 }, (_, i) => ({
      id: `v${i}`,
      plate: `AA-00${i}-AA`,
      trackerId: `t${i}`,
      lastSeenAt: ago((30 + i) * DAY),
      km: 0,
    }));
    fixtures.push({ id: 'live', plate: 'ZZ-999-ZZ', trackerId: 'tz', lastSeenAt: ago(60 * 1000), km: 10 });

    const notice = buildExploitedScopeNotice(await compute(fixtures))!;
    expect(notice).toContain('9 véhicules sans signal boîtier');
    expect(notice).toContain('+3 autres');
    // Le plus ancien silence est nommé en premier (c'est le plus parlant).
    expect(notice.indexOf('AA-008-AA')).toBeLessThan(notice.indexOf('AA-003-AA'));
  });

  /**
   * ── LE PARC MASQUÉ OUVRE L'ENCART À LUI SEUL ────────────────────────────────────────
   *
   * Cas le plus fréquent une fois le mode vie privée utilisé : un parc PARFAITEMENT sain —
   * aucun dormant, aucun véhicule sans boîtier — dont deux véhicules sont masqués. L'encart
   * rendait `null`, et le PDF sortait avec un parc rétréci sans un mot d'explication. Le
   * client compte 5 véhicules, son rapport en annonce 3, et rien ne dit pourquoi.
   */
  it('un parc SAIN mais partiellement masqué ouvre quand même l’encart, et le dit en premier', () => {
    const base = {
      total: 3, activeDuringPeriod: 3, exploited: 3, dormant: 0, withoutTracker: 0,
      dormantVehicles: [], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 2,
    };
    const report = {
      vehicles: base,
      trips: { avgKmBasisVehicles: 3, avgKmBasisKm: 300 },
    } as unknown as FleetStatsReport;

    const notice = buildExploitedScopeNotice(report)!;

    expect(notice).not.toBeNull();
    expect(notice).toContain('2 véhicules en mode vie privée');
    expect(notice).toContain('y compris du parc total');
    // En PREMIER : c'est la ligne qui explique le total. Lue après les dormants, elle
    // arriverait trop tard — et ici il n'y a même pas de dormants pour la précéder.
    expect(notice.indexOf('vie privée')).toBeLessThan(notice.indexOf('Distance moyenne'));
  });

  it('parc sain et AUCUN masqué : l’encart reste absent (rien de neuf sur le chemin courant)', () => {
    // Le témoin. Sans lui, « ouvrir l'encart » pourrait vouloir dire « l'ouvrir toujours »,
    // et tous les rapports du parc gagneraient une mention qui ne les concerne pas.
    const report = {
      vehicles: {
        total: 3, activeDuringPeriod: 3, exploited: 3, dormant: 0, withoutTracker: 0,
        dormantVehicles: [], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
      },
      trips: { avgKmBasisVehicles: 3, avgKmBasisKm: 300 },
    } as unknown as FleetStatsReport;

    expect(buildExploitedScopeNotice(report)).toBeNull();
  });
});

/**
 * ══ LE PRIX CONSTATÉ EN STATION SOUS FILTRE CONDUCTEUR (F13) ════════════════════════════
 *
 * Un passage en station est un arrêt du VÉHICULE : `TripFuelStop` n'a pas de conducteur. Ce
 * chiffre reste donc calculé sur le périmètre véhicule même sous filtre — décision assumée,
 * écrite au-dessus de la requête, et dite au lecteur par les trois surfaces (l'écran et le PDF
 * le GARDENT en expliquant pourquoi, le classeur Excel le RETIRE et l'écrit).
 *
 * ⚠️ CES DEUX TESTS VERROUILLENT UNE DÉCISION, PAS UN CALCUL — c'est-à-dire exactement ce
 * qu'aucun test ne protégeait. Les deux « corrections » qu'on est tenté d'appliquer ici sont
 * l'une et l'autre des régressions, et chacune fait tomber un de ces tests :
 *   · neutraliser sous filtre (`observedPriceEurL` à `null`) ferait écrire à l'écran « Aucun
 *     prix relevé en station sur la période », ce qui est FAUX ;
 *   · ajouter le conducteur au `where` ne filtrerait rien du tout (la table n'a pas la
 *     colonne) ou fabriquerait un chiffre hybride sous un nom propre.
 */
describe('ReportsStatsService — prix constaté en station et filtre conducteur', () => {
  const SOHAIB = 'aaaa1111-1111-4111-8111-111111111111';

  /** Le parc de référence, avec des passages en station RÉELLEMENT captés sur la période. */
  const prismaAvecPassages = () => {
    const prisma = makePrisma(PARC);
    prisma.tripFuelStop.aggregate.mockResolvedValue({
      _avg: { unitPriceEur: 1.7123 },
      _count: { _all: 12 },
    });
    return prisma;
  };

  const computeAvecFiltre = (prisma: ReturnType<typeof makePrisma>, driverId?: string) =>
    new ReportsStatsService(prisma).compute(
      FLEET_ID,
      FROM,
      TO,
      { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: 'ALL' },
      driverId ? { driverId } : undefined,
    );

  it('garde le prix et le nombre de passages sous filtre : ils existent, ils ne sont pas imputables', async () => {
    const prisma = prismaAvecPassages();
    const report = await computeAvecFiltre(prisma, SOHAIB);

    // Le chiffre est SERVI, pas escamoté : c'est la condition pour que l'écran puisse dire
    // « ce prix ne suit pas le filtre » au lieu de « aucun prix relevé ».
    expect(report.consumption.observedPriceEurL).toBe(1.712);
    expect(report.consumption.observedSampleCount).toBe(12);
    // Et le coût au prix constaté reste calculable : litres DU FILTRE × prix DU PARC.
    expect(report.consumption.estimatedCostAtObservedEur).not.toBeNull();
  });

  it('ne pose AUCUNE clause conducteur sur les passages en station', async () => {
    const prisma = prismaAvecPassages();
    await computeAvecFiltre(prisma, SOHAIB);

    expect(prisma.tripFuelStop.aggregate).toHaveBeenCalledTimes(1);
    const where = prisma.tripFuelStop.aggregate.mock.calls[0][0].where;
    // Ni `driverId`, ni jointure `trip: { driverId }` : la table n'a pas cette colonne, et
    // passer par les trajets rendrait les pleins faits par d'autres sur les mêmes véhicules.
    expect(JSON.stringify(where)).not.toContain('driver');
    expect(where.fleetId).toBe(FLEET_ID);

    // TÉMOIN : sans filtre, la MÊME requête. Le filtre ne touche pas cet agrégat, dans un
    // sens comme dans l'autre.
    const sansFiltre = prismaAvecPassages();
    await computeAvecFiltre(sansFiltre);
    expect(sansFiltre.tripFuelStop.aggregate.mock.calls[0][0].where).toEqual(where);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * MODE VIE PRIVÉE (RGPD) — LES PASSAGES EN STATION D'UN VÉHICULE MASQUÉ N'ABONDENT RIEN
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ NE PAS CONFONDRE AVEC LA DÉCISION DU BLOC PRÉCÉDENT. Que le prix constaté ne suive pas
 * le FILTRE CONDUCTEUR est un arbitrage assumé (un passage est un arrêt du véhicule). Qu'il
 * compte des véhicules sous VIE PRIVÉE n'en est pas un : là, le client a retiré le véhicule
 * du périmètre lui-même, et TOUTES les autres surfaces le retirent — les trajets et les
 * alertes par `privacyExclude`, les deux requêtes brutes par leur jointure
 * `v."privacyModeEnabled" IS NOT TRUE`, le classeur Excel en refusant net un véhicule privé.
 *
 * L'agrégat des passages était le dernier survivant du défaut relevé le 2026-09-05, et pour
 * la même raison que les deux requêtes brutes de l'époque : `TripFuelStop` porte `vehicleId`
 * en scalaire, SANS relation `vehicle` déclarée. `NOT: { vehicle: { privacyModeEnabled } }`
 * n'y compile pas — une borne qui ne s'écrit pas comme les autres est une borne qu'on oublie.
 *
 * Ce que le défaut coûtait, mesuré : 8 des 12 passages venaient du véhicule masqué, le prix
 * passait de 1,60 à 1,72 EUR/L, et le PDF du lundi — envoyé automatiquement à toutes les
 * sociétés — imprimait « 12 passages station » sous une phrase affirmant qu'ils portent sur
 * les véhicules du périmètre. Le classeur Excel de la même société, la même semaine, en
 * annonçait 4 : c'est le document qui voyage par courriel qui avait tort.
 *
 * Le simulacre ci-dessous ÉVALUE le `where` reçu contre une table en mémoire (il honore
 * `vehicleId.in`, `vehicleId.notIn`, et les deux formes de borne haute). Un faux qui rendrait
 * un compte figé ne prouverait rien de la clause produite par le service : c'est la clause
 * qu'on éprouve ici, pas le simulacre.
 */
const V_PUB_1 = 'v-station-pub-1';
const V_PUB_2 = 'v-station-pub-2';
const V_PRIVE = 'v-station-prive';

interface PassageStation {
  vehicleId: string;
  arrivedAt: Date;
  prix: number;
}

/** Borne de période telle que le service l'écrit : `gte` obligatoire, `lt` OU `lte`. */
interface BorneArrivee {
  gte: Date;
  lt?: Date;
  lte?: Date;
}

interface WhereStations {
  fleetId?: string;
  vehicleId?: { in?: string[]; notIn?: string[] };
  arrivedAt: BorneArrivee;
}

function bancStations(passages: PassageStation[], prives: string[] = []) {
  const vehicleRows = [V_PUB_1, V_PUB_2, V_PRIVE].map((id, i) => ({
    id,
    plate: `ST-00${i + 1}-ST`,
    type: 'CAR',
    fuelConsumptionL100km: 10,
    energy: 'DIESEL',
    calibratedConsumptionL100km: null,
    calibratedTanks: 0,
    privacyModeEnabled: prives.includes(id),
    tracker: { id: `t-${id}`, lastSeenAt: new Date() },
    groups: [] as unknown[],
  }));

  /** Les passages que la clause reçue laisse VRAIMENT passer. */
  const retenus = (where: WhereStations): PassageStation[] =>
    passages.filter((p) => {
      const borne = where.vehicleId;
      if (borne?.in && !borne.in.includes(p.vehicleId)) return false;
      if (borne?.notIn && borne.notIn.includes(p.vehicleId)) return false;
      const q = where.arrivedAt;
      if (p.arrivedAt.getTime() < q.gte.getTime()) return false;
      if (q.lt && p.arrivedAt.getTime() >= q.lt.getTime()) return false;
      if (q.lte && p.arrivedAt.getTime() > q.lte.getTime()) return false;
      return true;
    });

  const prisma = {
    fleet: {
      findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte test', fuelPriceEurL: 1.85 }),
    },
    vehicle: {
      // Honore `id: { in: [...] }` : sous périmètre restreint, le service ne charge que les
      // véhicules permis — et c'est de CETTE liste que sort l'exclusion des privés.
      findMany: jest.fn(async ({ where }: { where: { id?: { in?: string[] } } }) => {
        const permis = where?.id?.in;
        return Array.isArray(permis) ? vehicleRows.filter((v) => permis.includes(v.id)) : vehicleRows;
      }),
    },
    trip: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 2 },
        _sum: { distanceKm: 100, durationSeconds: 7200 },
        _avg: { avgSpeed: 42 },
        _max: { maxSpeed: 110 },
      }),
      // Les trajets du véhicule masqué sont DÉJÀ exclus en amont (`privacyExclude`) : seuls
      // les deux véhicules publics ont roulé, 50 km chacun.
      groupBy: jest.fn().mockResolvedValue([
        { vehicleId: V_PUB_1, driverId: null, _sum: { distanceKm: 50, durationSeconds: 3600 }, _count: { _all: 1 } },
        { vehicleId: V_PUB_2, driverId: null, _sum: { distanceKm: 50, durationSeconds: 3600 }, _count: { _all: 1 } },
      ]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    alert: { groupBy: jest.fn().mockResolvedValue([]) },
    tripFuelStop: {
      aggregate: jest.fn(async ({ where }: { where: WhereStations }) => {
        const lignes = retenus(where);
        return {
          _avg: {
            unitPriceEur: lignes.length > 0
              ? lignes.reduce((s, p) => s + p.prix, 0) / lignes.length
              : null,
          },
          _count: { _all: lignes.length },
        };
      }),
    },
    driver: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };

  /** Le `where` que le service a posé sur l'agrégat des passages. */
  const whereStations = (): WhereStations =>
    prisma.tripFuelStop.aggregate.mock.calls[0]![0].where as WhereStations;

  const calculer = (perimetre?: string[], bornes?: { from: Date; to: Date }) =>
    new ReportsStatsService(prisma as never).compute(
      FLEET_ID,
      bornes?.from ?? FROM,
      bornes?.to ?? TO,
      perimetre
        ? { role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: perimetre }
        : { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: 'ALL' },
    );

  return { prisma, calculer, whereStations };
}

/** 4 passages publics à 1,60 et 8 passages du véhicule masqué à 1,78 — 12 en tout. */
const PASSAGES_MELANGES: PassageStation[] = [
  ...Array.from({ length: 4 }, (_, i) => ({
    vehicleId: i % 2 === 0 ? V_PUB_1 : V_PUB_2,
    arrivedAt: new Date('2026-06-10T09:00:00.000Z'),
    prix: 1.6,
  })),
  ...Array.from({ length: 8 }, () => ({
    vehicleId: V_PRIVE,
    arrivedAt: new Date('2026-06-11T09:00:00.000Z'),
    prix: 1.78,
  })),
];

describe('ReportsStatsService — vie privée et passages en station', () => {
  it('parc entier : les passages du véhicule masqué sortent du compte, du prix et du coût', async () => {
    const { prisma, calculer, whereStations } = bancStations(PASSAGES_MELANGES, [V_PRIVE]);

    const r = await calculer();

    /**
     * ⚠️ LE DRAPEAU DOIT ÊTRE CHARGÉ, ET C'EST ASSERTÉ À PART. Ce simulacre rend
     * `privacyModeEnabled` quoi qu'il arrive ; Prisma, lui, ne rend QUE ce que le `select`
     * demande. Sans cette ligne, retirer `privacyModeEnabled` du `select` de
     * `vehicle.findMany` laisserait ce fichier entièrement vert pendant que la fuite se
     * rouvrirait en production — le simulacre est plus généreux que la base.
     */
    const selectVehicules = (prisma.vehicle.findMany.mock.calls[0]![0] as unknown as {
      select: Record<string, unknown>;
    }).select;
    expect(selectVehicules['privacyModeEnabled']).toBe(true);

    // 12 passages en base, 4 dans le périmètre du rapport. Le compte imprimé par le PDF et
    // affiché par l'écran ne peut plus contenir le véhicule que le client a masqué.
    expect(r.consumption.observedSampleCount).toBe(4);
    expect(r.consumption.observedPriceEurL).toBe(1.6);
    // Le coût suit : 100 km × 10 L/100 km = 10 L, au prix du périmètre et pas à 1,72.
    expect(r.consumption.estimatedCostAtObservedEur).toBe(16);
    // Et la clause elle-même nomme l'exclusion : sans elle, les trois chiffres ci-dessus
    // seraient justes par accident de simulacre.
    expect(whereStations().vehicleId).toEqual({ notIn: [V_PRIVE] });
  });

  it('périmètre restreint : le véhicule masqué n’entre pas non plus dans la liste permise', async () => {
    const { calculer, whereStations } = bancStations(PASSAGES_MELANGES, [V_PRIVE]);

    // Un VIEWER dont le groupe CONTIENT le véhicule masqué : la branche restreinte du
    // `where` est celle que le drapeau ne pouvait pas filtrer avant, faute d'être chargé.
    const r = await calculer([V_PUB_1, V_PUB_2, V_PRIVE]);

    expect(r.consumption.observedSampleCount).toBe(4);
    expect(r.consumption.observedPriceEurL).toBe(1.6);
    const borne = whereStations().vehicleId!;
    expect(borne.in).toEqual([V_PUB_1, V_PUB_2]);
    expect(borne.in).not.toContain(V_PRIVE);
  });

  it('parc SAIN : aucune clé n’est ajoutée au where (le chemin courant ne change pas)', async () => {
    const { calculer, whereStations } = bancStations(PASSAGES_MELANGES);

    const r = await calculer();

    // Aucun véhicule masqué : les 12 passages restent, et le `where` est celui d'avant —
    // `fleetId` seul, sans la moindre borne véhicule.
    expect(r.consumption.observedSampleCount).toBe(12);
    expect(whereStations().fleetId).toBe(FLEET_ID);
    expect(whereStations()).not.toHaveProperty('vehicleId');
  });

  /**
   * ── LE RECENSEMENT, QUATRIÈME ENDROIT OÙ CE GARDE LÂCHAIT ────────────────────────────
   *
   * Les trois premiers fuyaient des DONNÉES (les excès et le ralenti le 5 septembre, puis
   * les passages en station). Celui-ci n'en fuit aucune — et c'est pour ça qu'il a survécu
   * trois relectures : il fait simplement ÉCRIRE UN MENSONGE. Un véhicule masqué n'a, par
   * construction, aucun trajet dans ce rapport ; il tombait donc dans la liste des
   * immobiles, PLAQUE NOMMÉE, sous « n'a fait aucun trajet ». C'est l'information qui
   * décide d'une restitution : le client aurait rendu un véhicule qui roule, sur la foi de
   * son propre réglage de confidentialité.
   */
  it('le véhicule masqué n’est ni compté au parc, ni accusé de n’avoir pas roulé', async () => {
    // ST-003-ST est le véhicule masqué du banc, et il n'a aucun trajet (le banc n'en
    // fabrique pour aucun des trois) : sans le correctif il serait donc listé immobile.
    const { calculer } = bancStations(PASSAGES_MELANGES, [V_PRIVE]);

    const r = await calculer();

    expect(r.vehicles.total).toBe(2);
    expect(r.vehicles.hiddenByPrivacy).toBe(1);
    // Les DEUX véhicules visibles ont roulé : la liste des immobiles est donc VIDE. Sans le
    // correctif elle contenait une ligne, et cette ligne était la plaque du véhicule masqué
    // — c'est exactement ce que le témoin ci-dessous démontre a contrario.
    const plaques = r.vehicles.idleVehicles.map((v) => v.plate);
    expect(plaques).not.toContain('ST-003-ST');
    expect(r.vehicles.idleTotal).toBe(0);
    // Les dormants aussi : la mention « boîtier muet depuis 89 j » est publique, elle ne
    // doit pas nommer un véhicule que le client a soustrait au regard.
    expect(r.vehicles.dormantVehicles.map((d) => d.plate)).not.toContain('ST-003-ST');
  });

  it('parc SAIN : le recensement est celui d’avant, et c’est BIEN ce véhicule qu’on masquait', async () => {
    // Double emploi, et c'est voulu. (a) Le témoin qui interdit de « corriger » en
    // rétrécissant le parc de tout le monde. (b) La preuve que le test précédent ne passe
    // pas par accident : sans mode vie privée, ST-003-ST EST la ligne immobile. C'est donc
    // bien elle que le correctif retire, et pas une liste vide par construction.
    const { calculer } = bancStations(PASSAGES_MELANGES);

    const r = await calculer();

    expect(r.vehicles.total).toBe(3);
    expect(r.vehicles.hiddenByPrivacy).toBe(0);
    expect(r.vehicles.idleTotal).toBe(1);
    expect(r.vehicles.idleVehicles.map((v) => v.plate)).toEqual(['ST-003-ST']);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA BORNE HAUTE DES PASSAGES EST EXCLUSIVE, COMME TOUT LE RESTE DU RAPPORT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `to` est le LENDEMAIN minuit : `tripWhere` (`lt`), `alertWhere` (`lt`) et les deux requêtes
 * brutes (`t."startedAt" < ${to}`) le traitent en borne exclusive. L'agrégat des passages
 * était le seul à écrire `lte` — un passage horodaté à minuit pile entrait donc dans DEUX
 * rapports voisins, et pesait dans les deux moyennes que le client compare d'un mois sur
 * l'autre. L'instant de collision n'a rien de rare : les horodatages des boîtiers sont à la
 * seconde (la milliseconde vaut toujours zéro), et le rapport hebdomadaire du lundi produit
 * chaque semaine, pour toutes les sociétés, deux fenêtres dont la borne est le MÊME instant.
 *
 * ⚠️ L'assertion porte sur la SOMME des deux périodes, pas seulement sur chacune : deux
 * bornes qui ouvriraient pareil se satisferaient l'une l'autre. Le prix d'août est asserté
 * pour la même raison — c'est lui que la pollution déplaçait.
 */
describe('ReportsStatsService — la borne haute des passages en station', () => {
  const AOUT = { from: parisDayStart('2026-08-01'), to: parisDayStart('2026-09-01') };
  const SEPTEMBRE = { from: parisDayStart('2026-09-01'), to: parisDayStart('2026-10-01') };

  /** Trois passages réels, dont UN calé exactement sur l'instant de bascule. */
  const TROIS_PASSAGES: PassageStation[] = [
    { vehicleId: V_PUB_1, arrivedAt: new Date('2026-08-15T09:00:00.000Z'), prix: 1 },
    { vehicleId: V_PUB_1, arrivedAt: parisDayStart('2026-09-01'), prix: 2 },
    { vehicleId: V_PUB_2, arrivedAt: new Date('2026-09-15T09:00:00.000Z'), prix: 1.5 },
  ];

  it('un passage à minuit pile n’appartient qu’à UNE des deux périodes voisines', async () => {
    const aout = await bancStations(TROIS_PASSAGES).calculer(undefined, AOUT);
    const septembre = await bancStations(TROIS_PASSAGES).calculer(undefined, SEPTEMBRE);

    // La somme est le test : avec une borne inclusive, deux rapports adjacents comptaient
    // quatre passages pour trois réels.
    expect(aout.consumption.observedSampleCount + septembre.consumption.observedSampleCount).toBe(3);
    // Et il tombe du côté de la période qui COMMENCE à cet instant, jamais de celle qui s'y
    // termine — sans quoi le prix du mois clos bougerait après coup.
    expect(aout.consumption.observedSampleCount).toBe(1);
    expect(aout.consumption.observedPriceEurL).toBe(1);
    expect(septembre.consumption.observedSampleCount).toBe(2);
  });
});
