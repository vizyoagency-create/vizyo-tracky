import { Test } from '@nestjs/testing';
import { MissionStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DepotScopeService } from './depot-scope.service';

/**
 * Espace depot — le perimetre, teste au niveau du `where` Prisma.
 *
 * Ces tests ne verifient pas seulement le booleen renvoye : ils inspectent la
 * REQUETE construite. C'est deliberé — un service qui renverrait la bonne reponse
 * en chargeant tout puis en filtrant en memoire passerait un test de resultat, et
 * resterait une faille (A1 § 3, regle 1). Ce qu'on protege ici, c'est le `where`.
 */
describe('DepotScopeService', () => {
  let service: DepotScopeService;
  let mission: { findFirst: jest.Mock; findMany: jest.Mock };
  let trip: { findFirst: jest.Mock };
  let userVehicleAccess: { count: jest.Mock };

  const DEPOT_ID = 'depot-1';
  const VEHICULE_ID = 'vehicule-1';

  beforeEach(async () => {
    mission = { findFirst: jest.fn(), findMany: jest.fn() };
    trip = { findFirst: jest.fn() };
    userVehicleAccess = { count: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DepotScopeService,
        { provide: PrismaService, useValue: { mission, trip, userVehicleAccess } },
      ],
    }).compile();

    service = moduleRef.get(DepotScopeService);
  });

  describe('le `where` porte toujours depotUserId', () => {
    it('missionsFor filtre en requete, jamais en memoire', async () => {
      mission.findMany.mockResolvedValue([]);
      await service.missionsFor(DEPOT_ID);
      expect(mission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ depotUserId: DEPOT_ID }) }),
      );
    });

    it('canSeeLivePosition filtre en requete', async () => {
      mission.findFirst.mockResolvedValue(null);
      await service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID);
      const where = mission.findFirst.mock.calls[0][0].where;
      expect(where.depotUserId).toBe(DEPOT_ID);
      expect(where.vehicleId).toBe(VEHICULE_ID);
    });

    it('canSeeTrip remonte au depot par la mission rattachee', async () => {
      trip.findFirst.mockResolvedValue(null);
      await service.canSeeTrip(DEPOT_ID, 'trajet-1');
      expect(trip.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'trajet-1', mission: { depotUserId: DEPOT_ID } },
        }),
      );
    });

    it('canSeeMission filtre en requete', async () => {
      mission.findFirst.mockResolvedValue(null);
      await service.canSeeMission(DEPOT_ID, 'mission-1');
      expect(mission.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'mission-1', depotUserId: DEPOT_ID } }),
      );
    });
  });

  describe('la fenetre horaire — position live', () => {
    it('n\'accepte QUE les statuts IN_PROGRESS et LATE', async () => {
      mission.findFirst.mockResolvedValue(null);
      await service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID);
      const where = mission.findFirst.mock.calls[0][0].where;
      const statuts = where.OR.map((c: { status: MissionStatus }) => c.status);
      expect(statuts).toEqual([MissionStatus.IN_PROGRESS, MissionStatus.LATE]);
      // PLANNED n'apparait nulle part : une mission planifiee ne sert AUCUNE position,
      // meme si startAt est passe de deux minutes (A1 § 7, regle 3).
      expect(statuts).not.toContain(MissionStatus.PLANNED);
      expect(statuts).not.toContain(MissionStatus.DONE);
      expect(statuts).not.toContain(MissionStatus.CANCELLED);
    });

    it('borne le debut par startAt <= maintenant', async () => {
      mission.findFirst.mockResolvedValue(null);
      const avant = Date.now();
      await service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID);
      const where = mission.findFirst.mock.calls[0][0].where;
      expect(where.startAt.lte).toBeInstanceOf(Date);
      // L'heure employee est celle du SERVEUR, prise a l'instant de l'appel.
      expect(where.startAt.lte.getTime()).toBeGreaterThanOrEqual(avant);
      expect(where.startAt.lte.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('borne la fin par endAt >= maintenant pour IN_PROGRESS', async () => {
      mission.findFirst.mockResolvedValue(null);
      await service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID);
      const where = mission.findFirst.mock.calls[0][0].where;
      const enCours = where.OR.find(
        (c: { status: MissionStatus }) => c.status === MissionStatus.IN_PROGRESS,
      );
      expect(enCours.endAt.gte).toBeInstanceOf(Date);
    });

    it('N\'IMPOSE PAS endAt >= maintenant pour LATE — le suivi continue', async () => {
      // C'est l'invariant metier le plus contre-intuitif du lot : une mission en
      // retard a depasse son endAt, et c'est PRECISEMENT le moment ou le depot a le
      // plus besoin de voir le camion. Fermer la fenetre ici serait couper le suivi
      // au pire moment (A2 § 2).
      mission.findFirst.mockResolvedValue(null);
      await service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID);
      const where = mission.findFirst.mock.calls[0][0].where;
      const enRetard = where.OR.find(
        (c: { status: MissionStatus }) => c.status === MissionStatus.LATE,
      );
      expect(enRetard.endAt).toBeUndefined();
    });

    it('renvoie true quand une mission couvrante existe', async () => {
      mission.findFirst.mockResolvedValue({ id: 'mission-1' });
      await expect(service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID)).resolves.toBe(true);
    });

    it('renvoie false quand aucune mission ne couvre', async () => {
      mission.findFirst.mockResolvedValue(null);
      await expect(service.canSeeLivePosition(DEPOT_ID, VEHICULE_ID)).resolves.toBe(false);
    });
  });

  describe('l\'historique n\'a pas de borne horaire', () => {
    it('canSeeTrip ne pose aucune contrainte de date', async () => {
      trip.findFirst.mockResolvedValue({ id: 'trajet-1' });
      await service.canSeeTrip(DEPOT_ID, 'trajet-1');
      const where = trip.findFirst.mock.calls[0][0].where;
      // Une mission terminee reste consultable jusqu'a la fin de la conservation
      // (12 mois, A3 § 3). Ce qui compte est le rattachement, pas l'horloge.
      expect(JSON.stringify(where)).not.toMatch(/startAt|endAt|lte|gte/);
    });
  });

  describe('l\'heure vient du serveur, jamais du client', () => {
    it('missionsFor sans `at` ne pose aucune borne temporelle', async () => {
      mission.findMany.mockResolvedValue([]);
      await service.missionsFor(DEPOT_ID);
      const where = mission.findMany.mock.calls[0][0].where;
      expect(where.startAt).toBeUndefined();
      expect(where.endAt).toBeUndefined();
    });

    it('canSeeLivePosition n\'accepte AUCUN parametre de date', () => {
      // Signature verrouillee : deux arguments, tous deux des identifiants. Si une
      // date entrait ici, un depot pourrait demander « et a 23h hier ? ».
      expect(service.canSeeLivePosition.length).toBe(2);
    });
  });

  describe('invariant : un DEPOT n\'a jamais de UserVehicleAccess', () => {
    it('ne verifie rien pour les autres roles', async () => {
      await service.assertNoVehicleAccess('u1', UserRole.FLEET_MANAGER);
      expect(userVehicleAccess.count).not.toHaveBeenCalled();
    });

    it('passe quand le depot n\'a aucune ligne', async () => {
      userVehicleAccess.count.mockResolvedValue(0);
      await expect(service.assertNoVehicleAccess('u1', UserRole.DEPOT)).resolves.toBeUndefined();
    });

    it('leve quand une ligne existe — elle contournerait tout ce service', async () => {
      userVehicleAccess.count.mockResolvedValue(1);
      await expect(service.assertNoVehicleAccess('u1', UserRole.DEPOT)).rejects.toThrow(
        /Invariant viole/,
      );
    });
  });
});
