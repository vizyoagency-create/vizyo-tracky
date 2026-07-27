import { DORMANT_STOP_COUNTING_MS } from '@vizyo/tracky-shared';
import type { VehicleSnapshotDto } from '@vizyo/tracky-shared';
import { UserRole } from '@prisma/client';
import { FleetSchedulesService } from './fleet-schedules.service';
import type { RequestedBy } from '../vehicles/vehicles.service';

/**
 * Lot « dénominateurs — flotte » : ce que l'automatisation horaire couvre RÉELLEMENT.
 *
 * Cas réel du 27/07 : la page « Horaires » annonçait « 39 véhicules planifiés » alors que deux
 * d'entre eux (FV-941-LZ, muet depuis 89 j ; FL-787-KV, 52 j) n'ont plus de boîtier joignable —
 * leur coupe programmée ne partira jamais. Le chiffre décrivait une protection imaginaire.
 *
 * Ce que ces tests verrouillent :
 *   - le muet est NOMMÉ (`presence: 'DORMANT'` + ancienneté lisible) mais JAMAIS retiré de la liste ;
 *   - le nombre de planifiés reste inchangé, et le détail « dont N muets » est exposé à côté ;
 *   - un stationnement de 2 h, un pont de 6 j et un véhicule sans boîtier ne basculent PAS ;
 *   - la réintégration est automatique à la première trame reçue (aucun drapeau à lever).
 */

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const requestedBy: RequestedBy = {
  userId: '00000000-0000-0000-0000-000000000030',
  role: UserRole.FLEET_ADMIN,
  fleetId: FLEET_ID,
};

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

/** Ligne de snapshot minimale : seuls les champs lus par `listForFleet` sont renseignés. */
const snapRow = (over: Partial<VehicleSnapshotDto> & { vehicleId: string }): VehicleSnapshotDto =>
  ({
    fleetId: FLEET_ID,
    plate: over.vehicleId,
    type: 'CAR',
    brand: null,
    model: null,
    trackerId: `tr-${over.vehicleId}`,
    trackerImei: null,
    trackerStatus: null,
    lastSeenAt: iso(30_000),
    lastLat: null,
    lastLng: null,
    lastSpeedKmh: 0,
    lastHeading: null,
    lastIgnition: false,
    lastValid: null,
    lastPositionAt: iso(30_000),
    lastNoFixAt: null,
    accConnected: null,
    trackerCreatedAt: null,
    engineCutActive: false,
    engineCutState: 'normal',
    scheduleEnabled: true,
    privacyModeEnabled: false,
    privacyModeSince: null,
    group: null,
    ...over,
  }) as VehicleSnapshotDto;

/**
 * Planning ACTIVÉ mais avec un override en cours. L'override n'a rien à voir avec la dormance :
 * il évite juste que le test paie `computeNextTransition` (balayage minute par minute sur 8 jours)
 * — ce qui est testé ici, c'est le COMPTAGE, pas le compte-à-rebours.
 */
const scheduleRow = (vehicleId: string, enabled = true) => ({
  id: `sch-${vehicleId}`,
  vehicleId,
  enabled,
  timezone: 'Europe/Paris',
  countryCode: 'FR',
  cutOnHolidays: false,
  customDates: null,
  overrideUntil: new Date(Date.now() + HOUR),
  lastEvaluatedAt: null,
  lastEvaluatedState: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  mondayEnabled: true, tuesdayEnabled: true, wednesdayEnabled: true, thursdayEnabled: true,
  fridayEnabled: true, saturdayEnabled: true, sundayEnabled: true,
});

describe('FleetSchedulesService — dormance (seuil COMPTAGE, 7 j)', () => {
  let service: FleetSchedulesService;
  let prisma: {
    vehicleSchedule: { findMany: jest.Mock };
    fleet: { findMany: jest.Mock };
    position: { findFirst: jest.Mock };
  };
  let vehicles: { snapshot: jest.Mock };

  /** Parc de référence : 1 vivant, 1 garé depuis 2 h, 1 muet depuis 89 j, 1 sans boîtier. */
  const parcReel = (silenceDuMuet = 89 * DAY): VehicleSnapshotDto[] => [
    snapRow({ vehicleId: 'v-vivant' }),
    snapRow({ vehicleId: 'v-gare', lastSeenAt: iso(2 * HOUR), lastPositionAt: iso(2 * HOUR) }),
    snapRow({
      vehicleId: 'FV-941-LZ',
      lastSeenAt: iso(silenceDuMuet),
      lastPositionAt: iso(silenceDuMuet),
    }),
    snapRow({ vehicleId: 'TEST-001-XX', trackerId: null, lastSeenAt: null, lastPositionAt: null }),
  ];

  beforeEach(() => {
    prisma = {
      vehicleSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      fleet: { findMany: jest.fn().mockResolvedValue([{ id: FLEET_ID, name: 'CDEF' }]) },
      // Aucun scan « dernier mouvement » attendu ici (overrides actifs) — mock défensif.
      position: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    vehicles = { snapshot: jest.fn().mockResolvedValue([]) };
    service = new FleetSchedulesService(
      prisma as never,
      vehicles as never,
      { upsert: jest.fn() } as never,
      { resolveForVehicles: jest.fn() } as never,
      { getAccessibleVehicleIds: jest.fn() } as never,
    );
  });

  const withSchedules = (snap: VehicleSnapshotDto[], enabledFor: string[]): void => {
    vehicles.snapshot.mockResolvedValue(snap);
    prisma.vehicleSchedule.findMany.mockResolvedValue(
      snap.map((s) => scheduleRow(s.vehicleId, enabledFor.includes(s.vehicleId))),
    );
  };

  it('(a) le muet est signalé DORMANT avec son ancienneté — et RESTE dans la liste', async () => {
    withSchedules(parcReel(), ['v-vivant', 'v-gare', 'FV-941-LZ', 'TEST-001-XX']);

    const res = await service.listForFleet(requestedBy);
    const byId = new Map(res.items.map((r) => [r.vehicleId, r]));

    // Règle absolue : on ne masque jamais un véhicule, on ne fait que le qualifier.
    expect(res.items).toHaveLength(4);
    expect(byId.get('FV-941-LZ')!.presence).toBe('DORMANT');
    expect(byId.get('FV-941-LZ')!.silenceLabel).toBe('89 j');
    // `connectivity` n'est PAS écrasé : les switch existants côté UI continuent de fonctionner.
    expect(byId.get('FV-941-LZ')!.connectivity).toBe('PARKED');
  });

  it('(a bis) « planifiés » n\'est pas rogné en silence : le détail « dont N muets » est exposé à côté', async () => {
    withSchedules(parcReel(), ['v-vivant', 'v-gare', 'FV-941-LZ', 'TEST-001-XX']);

    const res = await service.listForFleet(requestedBy);

    // Le chiffre déjà affiché au client ne bouge pas…
    expect(res.holidayForecast.scheduledCount).toBe(4);
    // …mais on peut désormais écrire « 4 planifiés · dont 1 muet · dont 1 sans boîtier ».
    expect(res.dormancy.dormantCount).toBe(1);
    expect(res.dormancy.scheduledDormantCount).toBe(1);
    // TEST-001-XX a bien un planning activé (bulkApply n'exige aucun boîtier) mais sa coupe n'a
    // aucun destinataire : il ne doit PAS gonfler la couverture annoncée.
    expect(res.dormancy.scheduledWithoutTrackerCount).toBe(1);
    expect(res.dormancy.scheduledReachableCount).toBe(2);
    expect(
      res.dormancy.scheduledDormantCount +
        res.dormancy.scheduledWithoutTrackerCount +
        res.dormancy.scheduledReachableCount,
    ).toBe(res.holidayForecast.scheduledCount);
    expect(res.dormancy.thresholdMs).toBe(DORMANT_STOP_COUNTING_MS);
  });

  it('(b) un véhicule silencieux 2 h n\'est pas muet — c\'est un stationnement normal', async () => {
    withSchedules([snapRow({ vehicleId: 'v-gare', lastSeenAt: iso(2 * HOUR), lastPositionAt: iso(2 * HOUR) })], ['v-gare']);

    const res = await service.listForFleet(requestedBy);

    expect(res.items[0]!.presence).toBe('PARKED');
    expect(res.dormancy.dormantCount).toBe(0);
    expect(res.dormancy.scheduledReachableCount).toBe(1);
  });

  it('(b bis) un pont de 6 jours ne bascule pas encore (le seuil de comptage est prudent)', async () => {
    withSchedules([snapRow({ vehicleId: 'v-pont', lastSeenAt: iso(6 * DAY), lastPositionAt: iso(6 * DAY) })], ['v-pont']);

    const res = await service.listForFleet(requestedBy);

    expect(res.dormancy.dormantCount).toBe(0);
  });

  it('(c) un véhicule SANS boîtier n\'est jamais muet — il reste planifiable', async () => {
    withSchedules(
      [snapRow({ vehicleId: 'TEST-001-XX', trackerId: null, lastSeenAt: null, lastPositionAt: null })],
      ['TEST-001-XX'],
    );

    const res = await service.listForFleet(requestedBy);

    expect(res.items[0]!.presence).toBe('NOT_CONFIGURED');
    expect(res.items[0]!.silenceLabel).toBeNull();
    expect(res.dormancy.dormantCount).toBe(0);
    // Ni muet (il n'a jamais parlé) NI couvert (aucune coupe ne peut lui parvenir) : sa propre
    // case. Le geste attendu est « poser un boîtier », pas « aller voir pourquoi il se tait ».
    expect(res.dormancy.scheduledWithoutTrackerCount).toBe(1);
    expect(res.dormancy.scheduledReachableCount).toBe(0);
  });

  it('(d) réintégration : une seule trame fraîche suffit, sans aucune action manuelle', async () => {
    withSchedules(parcReel(), ['v-vivant', 'v-gare', 'FV-941-LZ', 'TEST-001-XX']);
    expect((await service.listForFleet(requestedBy)).dormancy.dormantCount).toBe(1);

    withSchedules(parcReel(45 * MIN), ['v-vivant', 'v-gare', 'FV-941-LZ', 'TEST-001-XX']);
    const apres = await service.listForFleet(requestedBy);

    expect(apres.dormancy.dormantCount).toBe(0);
    expect(apres.dormancy.scheduledDormantCount).toBe(0);
    // 3 joignables + TEST-001-XX qui reste dans sa case « sans boîtier » : la réintégration du
    // muet ne doit pas non plus faire remonter d'un cran un véhicule qui n'a jamais été équipé.
    expect(apres.dormancy.scheduledReachableCount).toBe(3);
    expect(apres.dormancy.scheduledWithoutTrackerCount).toBe(1);
  });

  it('un muet SANS planning activé compte dans les muets, pas dans les planifiés muets', async () => {
    withSchedules(parcReel(), ['v-vivant']);

    const res = await service.listForFleet(requestedBy);

    expect(res.dormancy.dormantCount).toBe(1);
    expect(res.dormancy.scheduledDormantCount).toBe(0);
    expect(res.dormancy.scheduledReachableCount).toBe(1);
    expect(res.holidayForecast.scheduledCount).toBe(1);
  });
});
