import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MissionStatus, UserRole, VehicleEventType } from '@prisma/client';
import {
  effectiveBlockingEndMs,
  IMMOBILIZING_STATUSES,
  isImmobilizingEvent,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { MissionsService } from './missions.service';

/**
 * Espace depot — la creation d'une mission (A2 § 3 et § 4).
 *
 * Ce qui est protege ici : les QUATRE effets de bord et les SEPT validations. Creer
 * une mission n'ecrit pas seulement une ligne — c'est le coeur de la fonctionnalite,
 * et deux de ses effets sont invisibles si on ne les teste pas.
 */
describe('MissionsService — creation', () => {
  let service: MissionsService;
  let prisma: {
    vehicle: { findFirst: jest.Mock };
    user: { findFirst: jest.Mock };
    driver: { findFirst: jest.Mock };
    mission: { findFirst: jest.Mock; create: jest.Mock };
    vehicleEvent: { create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  const GESTIONNAIRE = { id: 'u-1', fleetId: 'f-1', role: UserRole.FLEET_MANAGER } as AuthUser;

  /** Un créneau valide : demain 08:15 → 11:40. */
  const demain = (h: number, m: number) => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setUTCHours(h, m, 0, 0);
    return d.toISOString();
  };
  const ENTREE = {
    originLabel: 'Fenouillet',
    destLabel: 'Muret',
    startAt: demain(8, 15),
    endAt: demain(11, 40),
    vehicleId: 'v-1',
  };

  beforeEach(async () => {
    prisma = {
      vehicle: { findFirst: jest.fn().mockResolvedValue({ id: 'v-1', plate: 'FR-482-BX', tracker: { id: 't-1' } }) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'depot-1' }) },
      driver: { findFirst: jest.fn().mockResolvedValue({ id: 'd-1' }) },
      mission: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm-1', ref: 'M-0001' }),
      },
      vehicleEvent: { create: jest.fn().mockResolvedValue({ id: 'ev-1' }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    // La transaction execute le callback avec un client qui porte les memes mocks.
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [MissionsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(MissionsService);
  });

  describe('les effets de bord', () => {
    it('pose un evenement d\'agenda de type MISSION', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.vehicleEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: VehicleEventType.MISSION }),
        }),
      );
    });

    it('rend le vehicule INDISPONIBLE via blocksVehicle — pas via un second mecanisme', async () => {
      // L'invariant d'A2 § 3.2 : « deux sources d'indisponibilite, une seule logique
      // de lecture ». `blocksVehicle` fait entrer l'evenement dans `findImmobilized`,
      // le chemin que les reservations empruntent deja. Si ce flag disparaissait, le
      // vehicule resterait reservable pendant sa mission — et un jour, quelqu'un le
      // reserverait.
      await service.creer(GESTIONNAIRE, ENTREE);
      const data = prisma.vehicleEvent.create.mock.calls[0][0].data;
      expect(data.blocksVehicle).toBe(true);
      expect(data.startAt).toEqual(new Date(ENTREE.startAt));
      expect(data.endAt).toEqual(new Date(ENTREE.endAt));
    });

    it('ecrit la mission ET son evenement dans la MEME transaction', async () => {
      // Une mission sans son evenement laisserait le vehicule reservable pendant son
      // creneau : les deux ecritures sont indissociables.
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('rattache l\'evenement a la mission par ses metadonnees', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      const data = prisma.vehicleEvent.create.mock.calls[0][0].data;
      expect(data.metadata).toEqual({ missionId: 'm-1', missionRef: 'M-0001' });
    });
  });

  describe('la reference', () => {
    it('est generee sous verrou de ligne, dans la transaction', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      const sql = prisma.$queryRaw.mock.calls[0][0].join('');
      // Sans FOR UPDATE, deux creations simultanees lisent le meme maximum et
      // produisent la meme reference.
      expect(sql).toMatch(/FOR UPDATE/);
    });

    it('demarre a M-0001 pour une flotte neuve', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.mission.create.mock.calls[0][0].data.ref).toBe('M-0001');
    });

    it('incremente la derniere reference de la flotte', async () => {
      prisma.$queryRaw.mockResolvedValue([{ ref: 'M-2480' }]);
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.mission.create.mock.calls[0][0].data.ref).toBe('M-2481');
    });

    it('resiste a une reference illisible en base', async () => {
      prisma.$queryRaw.mockResolvedValue([{ ref: 'CORROMPU' }]);
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.mission.create.mock.calls[0][0].data.ref).toBe('M-0001');
    });
  });

  describe('le conflit de creneau', () => {
    it('refuse un chevauchement avec 409 et le DETAIL du conflit', async () => {
      prisma.mission.findFirst.mockResolvedValue({
        ref: 'M-2482',
        startAt: new Date('2026-08-10T09:00:00Z'),
        endAt: new Date('2026-08-10T12:20:00Z'),
      });
      // Un « creneau indisponible » sans dire lequel oblige le gestionnaire a rouvrir
      // le formulaire cinq fois. Le detail permet a l'interface de proposer une sortie.
      await expect(service.creer(GESTIONNAIRE, ENTREE)).rejects.toMatchObject({
        response: {
          code: 'MISSION_SLOT_CONFLICT',
          vehiclePlate: 'FR-482-BX',
          conflictingMission: { ref: 'M-2482' },
        },
      });
    });

    it('ne compte QUE les missions qui occupent encore le vehicule', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      const where = prisma.mission.findFirst.mock.calls[0][0].where;
      expect(where.status.in).toEqual([
        MissionStatus.PLANNED,
        MissionStatus.IN_PROGRESS,
        MissionStatus.LATE,
      ]);
      // Une mission terminee ou annulee ne bloque plus rien.
      expect(where.status.in).not.toContain(MissionStatus.DONE);
      expect(where.status.in).not.toContain(MissionStatus.CANCELLED);
    });

    it('detecte le chevauchement par bornes strictes, pas par egalite', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      const where = prisma.mission.findFirst.mock.calls[0][0].where;
      // `startAt < fin` ET `endAt > debut` : deux missions qui se touchent bout a bout
      // (11:40 → 11:40) ne se chevauchent PAS.
      expect(where.startAt.lt).toEqual(new Date(ENTREE.endAt));
      expect(where.endAt.gt).toEqual(new Date(ENTREE.startAt));
    });

    it('n\'ecrit RIEN quand le creneau est occupe', async () => {
      prisma.mission.findFirst.mockResolvedValue({ ref: 'M-2482', startAt: new Date(), endAt: new Date() });
      await expect(service.creer(GESTIONNAIRE, ENTREE)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('les validations de creneau', () => {
    it.each([
      ['fin avant depart', demain(11, 0), demain(8, 0), /suivre l'heure de depart/],
      ['duree < 15 min', demain(8, 0), demain(8, 10), /au moins 15 minutes/],
      ['duree > 24 h', demain(8, 0), new Date(Date.now() + 60 * 3600_000).toISOString(), /plusieurs missions/],
    ])('refuse : %s', async (_cas, startAt, endAt, motif) => {
      await expect(service.creer(GESTIONNAIRE, { ...ENTREE, startAt, endAt })).rejects.toThrow(motif);
    });

    it('refuse au-dela de 90 jours', async () => {
      const loin = new Date(Date.now() + 120 * 24 * 3600_000);
      const fin = new Date(loin.getTime() + 3 * 3600_000);
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, startAt: loin.toISOString(), endAt: fin.toISOString() }),
      ).rejects.toThrow(/Trop loin dans le temps/);
    });

    it('refuse des dates illisibles', async () => {
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, startAt: 'pas-une-date', endAt: 'non plus' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('les validations de perimetre', () => {
    it('refuse un vehicule hors flotte — sans dire s\'il existe', async () => {
      prisma.vehicle.findFirst.mockResolvedValue(null);
      await expect(service.creer(GESTIONNAIRE, ENTREE)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cherche le vehicule DANS la flotte de l\'utilisateur', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.vehicle.findFirst.mock.calls[0][0].where).toEqual({ id: 'v-1', fleetId: 'f-1' });
    });

    it('refuse un destinataire qui n\'est pas un DEPOT de la flotte', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, depotUserId: 'pas-un-depot' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exige le role DEPOT ET la meme flotte', async () => {
      await service.creer(GESTIONNAIRE, { ...ENTREE, depotUserId: 'depot-1' });
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'depot-1',
        fleetId: 'f-1',
        role: UserRole.DEPOT,
      });
    });

    it('accepte une mission SANS depot — elle est interne', async () => {
      await expect(service.creer(GESTIONNAIRE, ENTREE)).resolves.toMatchObject({
        mission: { ref: 'M-0001' },
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('refuse un conducteur hors flotte', async () => {
      prisma.driver.findFirst.mockResolvedValue(null);
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, driverId: 'd-autre' }),
      ).rejects.toThrow(/Conducteur hors de votre flotte/);
    });

    it('refuse un utilisateur sans flotte', async () => {
      await expect(
        service.creer({ ...GESTIONNAIRE, fleetId: null } as AuthUser, ENTREE),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('le vehicule sans boitier — avertissement, pas refus', () => {
    it('cree la mission et previent', async () => {
      // On peut planifier une mission avant l'installation du boitier. Refuser
      // empecherait de preparer une tournee sur un vehicule en cours d'equipement.
      prisma.vehicle.findFirst.mockResolvedValue({ id: 'v-1', plate: 'FR-482-BX', tracker: null });
      const res = await service.creer(GESTIONNAIRE, ENTREE);
      expect(res.mission.ref).toBe('M-0001');
      expect(res.avertissements[0]).toMatch(/pas encore de boitier/);
    });

    it('n\'avertit pas quand le boitier est installe', async () => {
      const res = await service.creer(GESTIONNAIRE, ENTREE);
      expect(res.avertissements).toEqual([]);
    });
  });

  describe('le contrat d\'indisponibilite — critere de recette 2 et 3', () => {
    it('l\'evenement de mission est reconnu IMMOBILISANT par la source partagee', async () => {
      // Le test qui relie les deux moities de la fonctionnalite. Cote ecriture, on pose
      // un VehicleEvent{MISSION, blocksVehicle}. Cote lecture, `isImmobilizingEvent` —
      // la SOURCE UNIQUE partagee API ↔ web — decide qui est occupe. Si les deux ne se
      // rejoignent pas, l'interface montre « libre » la ou le serveur renvoie un 409.
      await service.creer(GESTIONNAIRE, ENTREE);
      const data = prisma.vehicleEvent.create.mock.calls[0][0].data;

      expect(
        isImmobilizingEvent({
          type: data.type as 'MISSION',
          status: data.status as 'PLANNED',
          blocksVehicle: data.blocksVehicle as boolean,
        }),
      ).toBe(true);
    });

    it('la fin d\'immobilisation est exactement endAt — une mission en a toujours un', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      const data = prisma.vehicleEvent.create.mock.calls[0][0].data;
      const fin = effectiveBlockingEndMs(
        data.type as 'MISSION',
        (data.startAt as Date).getTime(),
        (data.endAt as Date).getTime(),
      );
      // Ni l'infini d'un incident, ni les 24 h d'une maintenance sans fin : la fenetre
      // de la mission, au plus juste. Le vehicule redevient libre a 11:40 pile.
      expect(fin).toBe(new Date(ENTREE.endAt).getTime());
    });

    it('le statut pose est immobilisant, et le restera en cours de route', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      const data = prisma.vehicleEvent.create.mock.calls[0][0].data;
      expect(IMMOBILIZING_STATUSES).toContain(data.status);
      // IN_PROGRESS l'est aussi : le vehicule reste occupe pendant qu'il roule.
      expect(IMMOBILIZING_STATUSES).toContain('IN_PROGRESS');
    });

    it('l\'evenement n\'est PAS de type RESERVATION — sinon findImmobilized l\'ecarte', async () => {
      // `findImmobilized` exclut explicitement les reservations (`type: { not: RESERVATION }`),
      // qui ont leur propre chemin. Poser une mission comme reservation la rendrait
      // invisible a ce filtre.
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.vehicleEvent.create.mock.calls[0][0].data.type).not.toBe(
        VehicleEventType.RESERVATION,
      );
    });
  });

  describe('les notes restent internes', () => {
    it('sont enregistrees sur la mission, pas sur l\'evenement d\'agenda', async () => {
      await service.creer(GESTIONNAIRE, { ...ENTREE, notes: 'client difficile' });
      expect(prisma.mission.create.mock.calls[0][0].data.notes).toBe('client difficile');
      const evenement = prisma.vehicleEvent.create.mock.calls[0][0].data;
      expect(JSON.stringify(evenement)).not.toContain('client difficile');
    });
  });
});
