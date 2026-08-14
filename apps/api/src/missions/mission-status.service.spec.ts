import { Test } from '@nestjs/testing';
import {
  MissionRequestStatus,
  MissionStatus,
  VehicleEventStatus,
  VehicleEventType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MissionShareService } from '../depot/mission-share.service';
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
  let partage: { fermerLiensDeMission: jest.Mock };
  let prisma: {
    mission: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    missionRequest: { findMany: jest.Mock; updateMany: jest.Mock };
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
      missionRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      vehicleEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
    partage = { fermerLiensDeMission: jest.fn().mockResolvedValue(0) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionStatusService,
        { provide: PrismaService, useValue: prisma },
        // Lot A3 — la cloture previent les depots par le salon `depot:mission:<id>`.
        // Un espion suffit : ce qui est teste ici est la BASCULE, pas la diffusion.
        { provide: RealtimeGateway, useValue: { emitDepotMissionEnded: jest.fn() } },
        // Lot A4 — la cloture ferme les liens publics de la mission. Un espion suffit :
        // ce qui est teste ici est la BASCULE, pas la fermeture (qui a ses propres tests).
        { provide: MissionShareService, useValue: partage },
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

  // ═══ LA MISSION QUI A ROULE ET N'EST JAMAIS REVENUE ════════════════════════
  //
  // `marquerLesRetards` fait IN_PROGRESS → LATE. Personne ne faisait LATE → DONE :
  // une mission qui avait roule et depasse son heure restait en retard
  // INDEFINIMENT. Constate en production le 2026-08-13 sur six missions de la
  // veille, avec deux consequences reelles — le vehicule restait immobilise dans
  // l'agenda et les reservations, et le depot continuait de voir sa position, la
  // fenetre censee se refermer ne se refermant jamais.
  describe('la mission en retard qui ne revient pas', () => {
    const enRetard = {
      id: 'm-3',
      ref: 'M-0003',
      status: MissionStatus.LATE,
      vehicle: { tracker: { lastPositionAt: new Date('2026-08-12T20:30:00Z') } },
    };

    it('est close apres un depassement prolonge', async () => {
      prisma.mission.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([enRetard]);
      await service.tick();
      expect(prisma.mission.update.mock.calls[0][0].data.status).toBe(MissionStatus.DONE);
    });

    it('recoit une heure d\'arrivee — sa derniere position connue', async () => {
      // C'est la seule heure d'arrivee dont on dispose. La laisser vide rendrait
      // l'historique du depot muet sur une mission qui a pourtant bien roule.
      prisma.mission.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([enRetard]);
      await service.tick();
      expect(prisma.mission.update.mock.calls[0][0].data.actualEndAt)
        .toEqual(enRetard.vehicle.tracker.lastPositionAt);
    });

    it('libere le vehicule et ferme les liens publics', async () => {
      prisma.mission.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([enRetard]);
      await service.tick();
      expect(prisma.vehicleEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: VehicleEventStatus.DONE } }),
      );
      expect(partage.fermerLiensDeMission).toHaveBeenCalledWith('m-3', 'DONE');
    });

    it('cherche bien les DEUX statuts, pas seulement les missions jamais parties', async () => {
      prisma.mission.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await service.tick();
      const where = prisma.mission.findMany.mock.calls[1][0].where;
      expect(where.status.in).toEqual(
        expect.arrayContaining([MissionStatus.PLANNED, MissionStatus.LATE]),
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

  /**
   * A6 § 6 — l'echeance du devis.
   *
   * Ce qui est protege : un devis perime ne reste pas ouvert. `quoteExpiresAt` etait
   * ecrit a la creation et personne ne le lisait — le depot voyait une date de validite
   * qui n'arrivait jamais, et pouvait accepter des semaines plus tard un prix calcule
   * sur une grille entre-temps revue.
   */
  describe('SUBMITTED ou NEGOTIATING → EXPIRED : l\'echeance du devis', () => {
    const echue = (id: string, ref: string) => ({ id, ref });

    it('fait expirer les demandes dont l\'echeance est passee', async () => {
      prisma.missionRequest.findMany.mockResolvedValueOnce([echue('r-1', 'D-0001')]);
      prisma.missionRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      await service.tick();
      expect(prisma.missionRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: MissionRequestStatus.EXPIRED },
        }),
      );
    });

    it('ne regarde que les demandes ENCORE VIVANTES', async () => {
      await service.tick();
      const where = prisma.missionRequest.findMany.mock.calls[0][0].where;
      // ACCEPTED a fige son montant, CONVERTED est une mission, REJECTED est close :
      // les faire expirer reecrirait une histoire deja terminee.
      expect(where.status).toEqual({
        in: [MissionRequestStatus.SUBMITTED, MissionRequestStatus.NEGOTIATING],
      });
    });

    it('ne selectionne que les echeances DEPASSEES', async () => {
      await service.tick();
      const where = prisma.missionRequest.findMany.mock.calls[0][0].where;
      expect(where.quoteExpiresAt.lt).toBeInstanceOf(Date);
      // Une demande sans echeance — grille absente a la creation — n'est pas perimee :
      // en SQL, `quoteExpiresAt < maintenant` est faux pour un NULL, et c'est voulu.
      expect(where.quoteExpiresAt).not.toHaveProperty('not');
    });

    it('repete le filtre de statut a l\'ECRITURE, contre l\'accord conclu entre-temps', async () => {
      prisma.missionRequest.findMany.mockResolvedValueOnce([echue('r-1', 'D-0001')]);
      await service.tick();
      const where = prisma.missionRequest.updateMany.mock.calls[0][0].where;
      // Entre la lecture et la mise a jour, une partie a pu accepter. Sans cette
      // garde, le tick ecraserait un accord conclu une seconde plus tot.
      expect(where.status).toEqual({
        in: [MissionRequestStatus.SUBMITTED, MissionRequestStatus.NEGOTIATING],
      });
      expect(where.id).toEqual({ in: ['r-1'] });
    });

    it('n\'ecrit rien quand aucune demande n\'est echue', async () => {
      await service.tick();
      expect(prisma.missionRequest.updateMany).not.toHaveBeenCalled();
    });

    it('borne le lot : un retard d\'ordonnanceur ne doit pas charger la base', async () => {
      await service.tick();
      expect(prisma.missionRequest.findMany.mock.calls[0][0].take).toBe(200);
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
