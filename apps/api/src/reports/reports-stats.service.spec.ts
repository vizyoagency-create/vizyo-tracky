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
});
