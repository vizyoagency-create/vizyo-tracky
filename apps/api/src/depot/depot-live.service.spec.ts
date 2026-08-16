import { Test } from '@nestjs/testing';
import { MissionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DepotLiveService } from './depot-live.service';
import { DepotService } from './depot.service';

/**
 * Espace depot (lot A3) — ce que la carte live sert, et ce qu'elle REFUSE de servir.
 *
 * ┌─ LA REGRESSION QUE CES TESTS EMPECHENT ───────────────────────────────────┐
 * │ La carte du depot lit `Tracker.lastLat/lastLng`, denormalise sur le boitier.│
 * │ Ce chemin COURT-CIRCUITE le masquage que `positions.service` applique a la  │
 * │ lecture : sans le test de vie privee, un vehicule masque a son propre       │
 * │ gestionnaire serait servi a un TIERS.                                       │
 * │                                                                            │
 * │ La faille ne se voit pas a l'ecran — la carte affiche un camion, ce qu'on   │
 * │ attend d'elle. Elle ne se voit que si on la cherche. D'ou ces tests.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
describe('DepotLiveService — ce que la carte refuse de servir', () => {
  let service: DepotLiveService;
  let mission: { findMany: jest.Mock };
  let vehicle: { findMany: jest.Mock; count: jest.Mock };
  let user: { findUnique: jest.Mock };
  let fleetPlace: { findMany: jest.Mock };

  const DEPOT_ID = 'depot-1';
  const MISSION_ID = 'mission-1';
  const VEHICULE_ID = 'vehicule-1';

  /** Une mission EN COURS, dans sa fenetre : le cas ou la position est servie. */
  const missionEnCours = () => ({
    id: MISSION_ID,
    ref: 'M-0001',
    originLabel: 'Fenouillet',
    destLabel: 'Muret',
    startAt: new Date(Date.now() - 3600_000),
    endAt: new Date(Date.now() + 3600_000),
    status: MissionStatus.IN_PROGRESS,
    actualEndAt: null,
    vehicleId: VEHICULE_ID,
    destPlaceId: null,
    vehicle: { plate: 'FR-482-BX', brand: 'Renault', model: 'D 12 t' },
    driver: null,
    fleet: { name: 'Transport Demo' },
  });

  /** Un vehicule avec une position FRAICHE, et le reglage de vie privee demande. */
  const vehiculeAvecPosition = (viePrivee: boolean) => ({
    id: VEHICULE_ID,
    mixedUseEnabled: viePrivee,
    privacyModeEnabled: viePrivee,
    workOverrideUntil: null,
    workSchedule: null,
    tracker: {
      lastLat: 43.6,
      lastLng: 1.44,
      lastSpeedKmh: 52,
      lastPositionAt: new Date(),
    },
  });

  beforeEach(async () => {
    mission = { findMany: jest.fn() };
    vehicle = { findMany: jest.fn(), count: jest.fn().mockResolvedValue(7) };
    user = {
      findUnique: jest.fn().mockResolvedValue({
        firstName: 'Dépôt',
        lastName: 'Fenouillet',
        fleetId: 'fleet-1',
        fleet: { name: 'Transport Demo' },
      }),
    };
    fleetPlace = { findMany: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DepotLiveService,
        { provide: PrismaService, useValue: { mission, vehicle, user, fleetPlace } },
        {
          provide: DepotService,
          // On ne teste pas la mise en forme du DTO ici : elle a ses propres tests.
          useValue: { versDtoPublic: (m: { id: string; ref: string }) => ({ id: m.id, ref: m.ref }) },
        },
      ],
    }).compile();
    service = moduleRef.get(DepotLiveService);
  });

  it('sert la position quand le suivi est actif et le vehicule non prive', async () => {
    mission.findMany.mockResolvedValue([missionEnCours()]);
    vehicle.findMany.mockResolvedValue([vehiculeAvecPosition(false)]);

    const live = await service.live(DEPOT_ID, false);

    expect(live.positions).toHaveLength(1);
    expect(live.positions[0]).toMatchObject({ missionId: MISSION_ID, lat: 43.6, lng: 1.44 });
    expect(live.unavailable).toHaveLength(0);
  });

  it('NE SERT PAS la position d\'un vehicule en vie privee, meme pendant la mission', async () => {
    mission.findMany.mockResolvedValue([missionEnCours()]);
    vehicle.findMany.mockResolvedValue([vehiculeAvecPosition(true)]);

    const live = await service.live(DEPOT_ID, false);

    // Aucune coordonnee ne sort, alors que la mission est bien en cours.
    expect(live.positions).toHaveLength(0);
    expect(JSON.stringify(live)).not.toContain('43.6');
  });

  it('annonce « suspendu » sans duree : la raison appartient au conducteur', async () => {
    mission.findMany.mockResolvedValue([missionEnCours()]);
    vehicle.findMany.mockResolvedValue([vehiculeAvecPosition(true)]);

    const live = await service.live(DEPOT_ID, false);

    expect(live.unavailable).toEqual([
      { missionId: MISSION_ID, unavailableSince: 0, reason: 'SUSPENDED' },
    ]);
  });

  it('distingue un boitier MUET d\'un suivi SUSPENDU', async () => {
    mission.findMany.mockResolvedValue([missionEnCours()]);
    vehicle.findMany.mockResolvedValue([
      { ...vehiculeAvecPosition(false), tracker: null },
    ]);

    const live = await service.live(DEPOT_ID, false);

    expect(live.unavailable[0]!.reason).toBe('UNAVAILABLE');
  });

  it('declare INDISPONIBLE une position de plus de dix minutes, jamais actuelle', async () => {
    mission.findMany.mockResolvedValue([missionEnCours()]);
    vehicle.findMany.mockResolvedValue([
      {
        ...vehiculeAvecPosition(false),
        tracker: {
          lastLat: 43.6,
          lastLng: 1.44,
          lastSpeedKmh: 0,
          lastPositionAt: new Date(Date.now() - 14 * 60_000),
        },
      },
    ]);

    const live = await service.live(DEPOT_ID, false);

    expect(live.positions).toHaveLength(0);
    expect(live.unavailable[0]).toMatchObject({ reason: 'UNAVAILABLE', unavailableSince: 14 });
  });

  it('ne sert aucune position pour une mission PLANIFIEE', async () => {
    mission.findMany.mockResolvedValue([
      {
        ...missionEnCours(),
        status: MissionStatus.PLANNED,
        startAt: new Date(Date.now() + 3600_000),
      },
    ]);
    vehicle.findMany.mockResolvedValue([vehiculeAvecPosition(false)]);

    const live = await service.live(DEPOT_ID, false);

    expect(live.positions).toHaveLength(0);
    expect(live.unavailable).toHaveLength(0);
  });

  it('borne la requete des missions sur depotUserId — jamais un filtrage en memoire', async () => {
    mission.findMany.mockResolvedValue([]);
    vehicle.findMany.mockResolvedValue([]);

    await service.live(DEPOT_ID, false);

    expect(mission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ depotUserId: DEPOT_ID }),
      }),
    );
  });

  it('compte les autres camions du transporteur pour l\'encart qui nomme l\'absence', async () => {
    mission.findMany.mockResolvedValue([missionEnCours()]);
    vehicle.findMany.mockResolvedValue([vehiculeAvecPosition(false)]);

    const live = await service.live(DEPOT_ID, false);

    // 7 camions dans la flotte, 1 seul sur mes missions → 6 autres.
    expect(live.otherVehiclesCount).toBe(6);
  });
});
