/**
 * ══ PORTÉE « CONDUCTEUR, SINON GROUPE » ═══════════════════════════════════════════════
 *
 * Mesuré en production le 2026-09-05 : chez cdef31, 2 675 trajets sur 2 707 n'ont pas de
 * conducteur mais ont un groupe ; chez mh cars, 1 866 sur 1 886 n'ont ni l'un ni l'autre.
 * Les classements « Conducteurs » et « Groupes » existants ne répondaient pas à « qui
 * conduit comment ? ». Celui-ci impute chaque trajet au conducteur s'il est connu, sinon
 * au groupe du véhicule, sinon à une ligne « non attribué » comptée mais jamais classée.
 */
import { UserRole } from '@prisma/client';
import { DrivingScoreService } from './driving-score.service';

const FLEET = 'f1';
const T0 = new Date('2026-08-10T08:00:00.000Z');

/**
 * Quatre véhicules : un avec conducteur, un avec groupe seulement, un sans rien — et un
 * quatrième à groupe qui a ROULÉ sans être analysé (le cas qui piégeait la liste des véhicules).
 */
const V_COND = 'veh-cond', V_GRP = 'veh-grp', V_RIEN = 'veh-rien', V_GRP_SANS_ANALYSE = 'veh-grp2';
const CONDUCTEUR = { firstName: 'Sohaib', lastName: 'Hamanni', color: null };

function build(opts: { sansAnalyse?: boolean } = {}) {
  const analyses = opts.sansAnalyse ? [] : [
    { tripId: 't1', vehicleId: V_COND, ecoScore: 90, distanceKm: 40, harshAccel: 0, harshBrake: 0, fuelLiters: 2, co2Kg: 5 },
    { tripId: 't2', vehicleId: V_GRP, ecoScore: 70, distanceKm: 30, harshAccel: 1, harshBrake: 0, fuelLiters: 2, co2Kg: 5 },
    { tripId: 't3', vehicleId: V_GRP, ecoScore: 60, distanceKm: 20, harshAccel: 0, harshBrake: 1, fuelLiters: 1, co2Kg: 3 },
    { tripId: 't4', vehicleId: V_RIEN, ecoScore: 50, distanceKm: 25, harshAccel: 0, harshBrake: 0, fuelLiters: 1, co2Kg: 3 },
  ];
  const trips = [
    { id: 't1', vehicleId: V_COND, driverId: 'd1', startedAt: T0, driver: CONDUCTEUR },
    { id: 't2', vehicleId: V_GRP, driverId: null, startedAt: T0, driver: null },
    { id: 't3', vehicleId: V_GRP, driverId: null, startedAt: T0, driver: null },
    { id: 't4', vehicleId: V_RIEN, driverId: null, startedAt: T0, driver: null },
  ];
  const vehicles = [
    // ⚠️ Dans un groupe ET avec conducteur : son trajet doit aller au conducteur, jamais au groupe.
    { id: V_COND, plate: 'AA-111-AA', brand: 'R', model: 'Clio', groups: [{ group: { id: 'g1', name: 'Livraisons' } }], tracker: { id: 'k1', lastSeenAt: new Date() } },
    { id: V_GRP, plate: 'BB-222-BB', brand: 'R', model: 'Clio', groups: [{ group: { id: 'g1', name: 'Livraisons' } }], tracker: { id: 'k2', lastSeenAt: new Date() } },
    { id: V_RIEN, plate: 'CC-333-CC', brand: 'R', model: 'Clio', groups: [], tracker: { id: 'k3', lastSeenAt: new Date() } },
    { id: V_GRP_SANS_ANALYSE, plate: 'DD-444-DD', brand: 'R', model: 'Clio', groups: [{ group: { id: 'g2', name: 'Livraisons Nord' } }], tracker: { id: 'k4', lastSeenAt: new Date() } },
  ];
  const tripsFiltres = opts.sansAnalyse ? [] : trips;
  const prisma = {
    tripAnalysis: { findMany: jest.fn().mockResolvedValue(analyses) },
    trip: {
      findMany: jest.fn().mockResolvedValue(tripsFiltres),
      // Trajets RÉELS : le véhicule sans rien en a 6 (dont 5 non analysés) — le vrai trou.
      // Le véhicule à groupe SANS analyse en a 3 : ils doivent aller à son groupe, pas au trou.
      // ⚠️ PLUS de trajets réels que d'analyses sur chaque ligne classée : sinon le repli
      // `Math.max(réels, analyses)` de `toRow` satisferait le test sans que la clé soit juste.
      groupBy: jest.fn().mockResolvedValue([
        { vehicleId: V_COND, driverId: 'd1', _count: { _all: 4 }, _sum: { distanceKm: 160 } },
        { vehicleId: V_GRP, driverId: null, _count: { _all: 5 }, _sum: { distanceKm: 125 } },
        { vehicleId: V_RIEN, driverId: null, _count: { _all: 6 }, _sum: { distanceKm: 150 } },
        { vehicleId: V_GRP_SANS_ANALYSE, driverId: null, _count: { _all: 3 }, _sum: { distanceKm: 90 } },
      ]),
    },
    vehicle: {
      // ⚠️ Filtre sur `where.id.in` comme le vrai client : c'est LA liste dont dépend le groupe
      // d'un véhicule, et le défaut corrigé venait d'une liste trop courte.
      findMany: jest.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(vehicles.filter((v) => where.id.in.includes(v.id)))),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const access = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') };
  const user = { id: 'u', role: UserRole.FLEET_ADMIN, fleetId: FLEET } as never;
  return { svc: new DrivingScoreService(prisma as never, access as never), user };
}

const PERIODE = ['2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z'] as const;

describe('Classement — portée « conducteur, sinon groupe »', () => {
  it('impute au conducteur quand il est connu, sinon au groupe du véhicule', async () => {
    const { svc, user } = build();
    const res = await svc.scores(user, 'attribution', ...PERIODE, FLEET);
    const lignes = [...res.rows, ...res.insufficientRows];
    const libelles = lignes.map((l) => `${l.label} (${l.sublabel})`).sort();
    expect(libelles).toEqual(['Livraisons (groupe — trajets sans conducteur)', 'Sohaib Hamanni (conducteur)']);
    const groupe = lignes.find((l) => l.label === 'Livraisons')!;
    // 2 analyses, 5 trajets réels — et PAS 6 : le trajet du conducteur ne lui revient pas.
    expect(groupe.tripCount).toBe(2);
    expect(groupe.totalTripCount).toBe(5);
  });

  /**
   * ⚠️ On ne note pas « personne ». Le trajet sans conducteur ni groupe n'est PAS une ligne
   * du classement — il serait la pire note du tableau, attribuée à un vide.
   */
  it('ne classe PAS les trajets sans conducteur ni groupe', async () => {
    const { svc, user } = build();
    const res = await svc.scores(user, 'attribution', ...PERIODE, FLEET);
    const lignes = [...res.rows, ...res.insufficientRows];
    expect(lignes.some((l) => l.id === 'non-attribue' || l.label.toLowerCase().includes('attribu'))).toBe(false);
  });

  /**
   * Mais il les COMPTE, en trajets réels : c'est la mesure du trou de données, et c'est ce
   * que l'écran affiche en premier quand il domine.
   */
  it('compte les trajets non attribués à part, analysés ET non analysés, en trajets et en kilomètres RÉELS', async () => {
    const { svc, user } = build();
    const res = await svc.scores(user, 'attribution', ...PERIODE, FLEET);
    // 18 trajets réels sur la période (4 + 5 + 6 + 3) : c'est LE dénominateur, pas `totalTrips`.
    // 150 km : ceux des 6 trajets réels, pas les 25 km de la seule analyse.
    expect(res.unattributed).toEqual({ tripCount: 1, totalTripCount: 6, periodTripCount: 18, distanceKm: 150 });
  });

  /**
   * ⚠️ Le véhicule à groupe qui a roulé SANS être analysé : ses 3 trajets appartiennent à son
   * groupe. Une première version ne chargeait que les véhicules des analyses — il n'avait donc
   * « pas de groupe », et ses trajets grossissaient le trou de données. Ici, `totalTripCount`
   * du trou reste à 6, et le groupe g2 n'est pas une ligne (aucune analyse) — il n'a rien à
   * montrer, mais il n'a rien perdu non plus.
   */
  it('un véhicule à groupe sans analyse ne tombe PAS dans « non attribué »', async () => {
    const { svc, user } = build();
    const res = await svc.scores(user, 'attribution', ...PERIODE, FLEET);
    expect(res.unattributed!.totalTripCount).toBe(6);
    expect([...res.rows, ...res.insufficientRows].some((l) => l.label === 'Livraisons Nord')).toBe(false);
  });

  /** Une société qui démarre : des trajets, aucune analyse. L'encart doit quand même savoir compter. */
  it('sans aucune analyse, compte encore les trajets réels non attribués', async () => {
    const { svc, user } = build({ sansAnalyse: true });
    const res = await svc.scores(user, 'attribution', ...PERIODE, FLEET);
    expect(res.rows).toEqual([]);
    expect(res.unattributed).toEqual({ tripCount: 0, totalTripCount: 6, periodTripCount: 18, distanceKm: 150 });
  });

  it('ne renvoie rien de tel pour les autres portées', async () => {
    const { svc, user } = build();
    const res = await svc.scores(user, 'vehicle', ...PERIODE, FLEET);
    expect(res.unattributed).toBeNull();
  });

  /**
   * ⚠️ Le dénominateur (trajets réels) suit la MÊME clé que la note : un groupe noté sur 2
   * trajets doit annoncer « 2 sur 2 », pas « 2 sur 8 » parce qu'un autre calcul aurait
   * rattaché au groupe les trajets d'un véhicule sans groupe.
   */
  it('le taux d’analyse d’une ligne ne mélange pas les trajets des autres', async () => {
    const { svc, user } = build();
    const res = await svc.scores(user, 'attribution', ...PERIODE, FLEET);
    const cond = [...res.rows, ...res.insufficientRows].find((l) => l.label === 'Sohaib Hamanni')!;
    // 1 analyse, 4 trajets réels : le dénominateur vient de la clé `driver:d1`, pas du repli.
    expect(cond.tripCount).toBe(1);
    expect(cond.totalTripCount).toBe(4);
  });
});
