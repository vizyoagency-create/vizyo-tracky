import { Test } from '@nestjs/testing';
import { MissionStatus, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MissionStatusService, STATUT_EVENEMENT } from './mission-status.service';

/**
 * Espace depot — la bascule des statuts (A2 § 2).
 *
 * Ce qui est protege : le statut suit LE TERRAIN, jamais l'horloge seule. Un statut
 * qui ment (« en cours » sur une mission jamais partie) fait perdre au depot confiance
 * dans tout l'outil.
 */
describe('MissionStatusService', () => {
  let service: MissionStatusService;
  let prisma: {
    mission: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    vehicleEvent: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const missionPlanifiee = (lastPositionAt: Date | null, startAt = new Date()) => ({
    id: 'm-1',
    ref: 'M-0001',
    startAt,
    vehicle: { tracker: lastPositionAt ? { lastPositionAt } : null },
  });

  beforeEach(async () => {
    prisma = {
      mission: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      vehicleEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionStatusService,
        { provide: PrismaService, useValue: prisma },
        // Lot A3 — la cloture previent les depots par le salon `depot:mission:<id>`.
        // Un espion suffit : ce qui est teste ici est la BASCULE, pas la diffusion.
        { provide: RealtimeGateway, useValue: { emitDepotMissionEnded: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MissionStatusService);
  });

  describe('PLANNED → IN_PROGRESS : c\'est la position qui demarre, pas l\'horloge', () => {
    it('demarre quand une position est arrivee apres startAt − 15 min', async () => {
      const debut = new Date();
      prisma.mission.findMany.mockResolvedValueOnce([
        missionPlanifiee(new Date(debut.getTime() - 5 * 60_000), debut),
      ]);
      await service.tick();
      expect(prisma.mission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MissionStatus.IN_PROGRESS }),
        }),
      );
    });

    it('NE demarre PAS sur une position anterieure a la tolerance', async () => {
      // Une derniere position datant d'hier ne demarre rien : ce serait confondre
      // « le camion est parti » avec « le camion existe ».
      const debut = new Date();
      prisma.mission.findMany.mockResolvedValueOnce([
        missionPlanifiee(new Date(debut.getTime() - 3 * 3600_000), debut),
      ]);
      await service.tick();
      expect(prisma.mission.update).not.toHaveBeenCalled();
    });

    it('NE demarre PAS sans boitier — la mission attend', async () => {
      prisma.mission.findMany.mockResolvedValueOnce([missionPlanifiee(null)]);
      await service.tick();
      expect(prisma.mission.update).not.toHaveBeenCalled();
    });

    it('horodate le depart REEL, pas l\'heure prevue', async () => {
      const debut = new Date();
      const vueA = new Date(debut.getTime() - 2 * 60_000);
      prisma.mission.findMany.mockResolvedValueOnce([missionPlanifiee(vueA, debut)]);
      await service.tick();
      expect(prisma.mission.update.mock.calls[0][0].data.actualStartAt).toEqual(vueA);
    });

    it('lit le boitier DENORMALISE, jamais la table des positions', async () => {
      // Un scan de `positions` par mission et par minute mettrait le VPS a genoux.
      prisma.mission.findMany.mockResolvedValueOnce([]);
      await service.tick();
      const select = prisma.mission.findMany.mock.calls[0][0].select;
      expect(select.vehicle.select.tracker.select.lastPositionAt).toBe(true);
      expect(prisma).not.toHaveProperty('position');
    });
  });

  describe('IN_PROGRESS → LATE : le suivi CONTINUE', () => {
    it('bascule les missions dont l\'heure de fin est passee', async () => {
      await service.tick();
      const appel = prisma.mission.updateMany.mock.calls[0][0];
      expect(appel.where.status).toBe(MissionStatus.IN_PROGRESS);
      expect(appel.data.status).toBe(MissionStatus.LATE);
    });

    it('LATE reste IMMOBILISANT dans l\'agenda — le camion roule encore', () => {
      // Le mapper sur DONE libererait le vehicule alors qu'il est toujours en route,
      // et un gestionnaire pourrait le reserver.
      expect(STATUT_EVENEMENT[MissionStatus.LATE]).toBe(VehicleEventStatus.IN_PROGRESS);
      expect(STATUT_EVENEMENT[MissionStatus.LATE]).not.toBe(VehicleEventStatus.DONE);
    });

    it('ne stocke AUCUN retard en minutes', async () => {
      // Il change a chaque minute : une valeur figee serait fausse des la suivante.
      await service.tick();
      const data = prisma.mission.updateMany.mock.calls[0][0].data;
      expect(Object.keys(data)).toEqual(['status']);
    });
  });

  describe('la mission jamais partie', () => {
    it('est close 4 h apres sa fin, avec actualStartAt a null', async () => {
      prisma.mission.findMany
        .mockResolvedValueOnce([]) // demarrage
        .mockResolvedValueOnce([{ id: 'm-2', ref: 'M-0002' }]); // abandon
      await service.tick();
      const appel = prisma.mission.update.mock.calls[0][0];
      expect(appel.data.status).toBe(MissionStatus.DONE);
      // `actualStartAt` reste null : c'est ce qui distingue « livree » de
      // « jamais partie » dans l'historique du depot.
      expect(appel.data.actualStartAt).toBeUndefined();
    });

    it('libere le vehicule — sinon une mission fantome le bloquerait indefiniment', async () => {
      prisma.mission.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'm-2', ref: 'M-0002' }]);
      await service.tick();
      expect(prisma.vehicleEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: VehicleEventStatus.DONE } }),
      );
    });
  });

  describe('la synchronisation avec l\'agenda', () => {
    it('bascule la mission ET son evenement dans la MEME transaction', async () => {
      prisma.mission.findMany.mockResolvedValueOnce([
        missionPlanifiee(new Date(), new Date()),
      ]);
      await service.tick();
      // Sans cette synchronisation, l'evenement resterait PLANNED : le vehicule
      // apparaitrait indisponible bien apres la fin de sa mission.
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.vehicleEvent.updateMany).toHaveBeenCalled();
    });

    it('cible l\'evenement par le missionId porte dans ses metadonnees', async () => {
      prisma.mission.findMany.mockResolvedValueOnce([
        missionPlanifiee(new Date(), new Date()),
      ]);
      await service.tick();
      const where = prisma.vehicleEvent.updateMany.mock.calls[0][0].where;
      expect(where.type).toBe(VehicleEventType.MISSION);
      expect(where.metadata).toEqual({ path: ['missionId'], equals: 'm-1' });
    });

    it('couvre les 5 statuts — aucun ne doit rester sans correspondance', () => {
      for (const s of Object.values(MissionStatus)) {
        expect(STATUT_EVENEMENT[s]).toBeDefined();
      }
    });
  });

  describe('robustesse de la tache de fond', () => {
    it('n\'explose pas quand la base repond mal', async () => {
      // Une tache de fond qui leve tue l'ordonnanceur pour toutes les suivantes.
      prisma.mission.findMany.mockRejectedValue(new Error('base indisponible'));
      await expect(service.tick()).resolves.toBeUndefined();
    });

    it('ne se chevauche pas avec lui-meme', async () => {
      let resoudre: (v: unknown) => void = () => {};
      prisma.mission.findMany.mockReturnValueOnce(new Promise((r) => { resoudre = r; }));
      const premier = service.tick();
      await service.tick(); // doit sortir immediatement
      resoudre([]);
      await premier;
      // Un seul cycle a interroge la base.
      expect(prisma.mission.findMany).toHaveBeenCalledTimes(2); // demarrage + abandon
    });
  });
});
