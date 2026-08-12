import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MissionStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MissionShareService } from '../depot/mission-share.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NO_FLEET } from '../common/tenant-scope';
import { MissionsService } from './missions.service';

/**
 * LE MODULE MISSIONS ETAIT FERME AUX SUPER-ADMINS.
 *
 * Releve le 2026-08-12, en production : les quatre comptes SUPER_ADMIN ont
 * `fleetId = NULL` — par construction, un super-admin n'appartient a aucune societe
 * et choisit la sienne dans le selecteur global. Or `fleetDe()` levait
 * « Aucune flotte associee » des que `user.fleetId` etait nul, et HUIT des neuf
 * methodes de ce service passaient par la : l'onglet Missions, le selecteur de
 * depot, le choix du vehicule, la creation, la modification, l'annulation, le
 * bandeau de la fiche vehicule, la colonne « Perimetre » de /users.
 *
 * Toute la fonctionnalite depot leur etait donc inaccessible — alors que tous les
 * AUTRES endpoints de /agenda acceptaient deja `?fleetId=`.
 *
 * Ce fichier fixe les trois regles de la correction :
 *   1. lecture  — borne a la societe demandee, ou aucune borne si le super-admin
 *                 est sur « Toutes les societes » ;
 *   2. ecriture — une societe est OBLIGATOIRE, avec un message qui dit quoi faire ;
 *   3. fail-closed — un non-super-admin sans flotte ne voit RIEN, jamais tout.
 */
describe('MissionsService — la portee du SUPER_ADMIN', () => {
  let service: MissionsService;
  let prisma: {
    vehicle: { findFirst: jest.Mock; findMany: jest.Mock };
    user: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
    driver: { findFirst: jest.Mock };
    mission: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      groupBy: jest.Mock;
    };
    vehicleEvent: { create: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  /** Un super-admin : aucune flotte, par construction. */
  const SA = { id: 'sa-1', fleetId: null, role: UserRole.SUPER_ADMIN } as unknown as AuthUser;
  /** Un gestionnaire ordinaire, rattache a sa societe. */
  const GESTIONNAIRE = { id: 'u-1', fleetId: 'f-1', role: UserRole.FLEET_MANAGER } as AuthUser;
  /** Un compte mal provisionne : role de flotte, mais aucune flotte. */
  const ORPHELIN = {
    id: 'u-2',
    fleetId: null,
    role: UserRole.FLEET_MANAGER,
  } as unknown as AuthUser;

  const MH_CARS = 'f-mhcars';

  const demain = (h: number) => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const ENTREE = {
    originLabel: 'Toulouse',
    destLabel: 'Blagnac',
    startAt: demain(8),
    endAt: demain(10),
    vehicleId: 'v-1',
  };

  /** Le `where` de la Nieme requete missions.findMany. */
  const whereListe = (n = 0) => prisma.mission.findMany.mock.calls[n][0].where;

  beforeEach(async () => {
    prisma = {
      vehicle: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'v-1', plate: 'EP-047-TY', tracker: { id: 't-1' } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'depot-1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      driver: { findFirst: jest.fn().mockResolvedValue({ id: 'd-1' }) },
      mission: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm-1', ref: 'M-0001' }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      vehicleEvent: {
        create: jest.fn().mockResolvedValue({ id: 'ev-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EmailService,
          useValue: {
            buildMissionAssignedEmail: jest.fn().mockReturnValue({ subject: 's', html: 'h', text: 't' }),
            send: jest.fn().mockResolvedValue({ ok: true }),
          },
        },
        { provide: ConfigService, useValue: { get: () => 'https://app.exemple.fr' } },
        { provide: RealtimeGateway, useValue: { emitDepotMissionEnded: jest.fn() } },
        {
          provide: MissionShareService,
          useValue: { fermerLiensDeMission: jest.fn().mockResolvedValue(0) },
        },
      ],
    }).compile();
    service = moduleRef.get(MissionsService);
  });

  describe('lire — l’onglet Missions', () => {
    it('ne repond plus « Aucune flotte associee » a un super-admin', async () => {
      // LE CAS D'ORIGINE. Avant, cet appel levait une ForbiddenException.
      await expect(service.lister(SA, {})).resolves.toBeDefined();
    });

    it('borne a la societe choisie dans le selecteur global', async () => {
      await service.lister(SA, { fleetId: MH_CARS });
      expect(whereListe().fleetId).toBe(MH_CARS);
    });

    it('ne pose AUCUNE borne quand le super-admin est sur « Toutes les societes »', async () => {
      await service.lister(SA, {});
      // Pas de cle `fleetId` du tout — et surtout pas `fleetId: undefined`, que Prisma
      // traiterait pareil mais qui masquerait l'intention a la relecture.
      expect('fleetId' in whereListe()).toBe(false);
    });

    it('IGNORE la societe demandee par un gestionnaire — il reste dans la sienne', async () => {
      // Sans quoi n'importe qui lirait une autre societe en forgeant `?fleetId=`.
      await service.lister(GESTIONNAIRE, { fleetId: MH_CARS });
      expect(whereListe().fleetId).toBe('f-1');
    });

    it('ne montre RIEN a un compte de flotte sans flotte — jamais tout', async () => {
      await service.lister(ORPHELIN, {});
      expect(whereListe().fleetId).toBe(NO_FLEET);
    });
  });

  describe('ecrire — la creation', () => {
    it('cree dans la societe choisie', async () => {
      await service.creer(SA, { ...ENTREE, fleetId: MH_CARS });
      expect(prisma.mission.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ fleetId: MH_CARS }) }),
      );
    });

    it('REFUSE un super-admin sans societe choisie, en disant quoi faire', async () => {
      // « Toutes les societes » n'a pas de sens pour une ecriture : il faut une flotte,
      // et une seule. Le dire ici plutot que d'echouer plus loin sur le vehicule.
      await expect(service.creer(SA, ENTREE)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.creer(SA, ENTREE)).rejects.toThrow(/Sélectionnez une société/);
      expect(prisma.mission.create).not.toHaveBeenCalled();
    });

    it('ignore la societe demandee par un gestionnaire', async () => {
      await service.creer(GESTIONNAIRE, { ...ENTREE, fleetId: MH_CARS });
      expect(prisma.mission.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ fleetId: 'f-1' }) }),
      );
    });

    it('dit a un compte sans flotte que SON compte est en cause', async () => {
      // NO_FLEET produirait sinon un « Véhicule hors de votre flotte » trompeur.
      await expect(service.creer(ORPHELIN, ENTREE)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('les listes qui alimentent le formulaire', () => {
    it('exige une societe pour proposer des comptes depot', async () => {
      // Proposer les depots de toutes les societes ferait choisir un destinataire que
      // `validerDepot` refuserait ensuite.
      await expect(service.listerDepots(SA)).rejects.toThrow(/Sélectionnez une société/);
      await service.listerDepots(SA, MH_CARS);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: MH_CARS }) }),
      );
    });

    it('exige une societe pour proposer des vehicules', async () => {
      await expect(
        service.disponibiliteVehicules(SA, new Date(), new Date(Date.now() + 3600_000)),
      ).rejects.toThrow(/Sélectionnez une société/);
    });
  });

  describe('modifier — la flotte vient de la MISSION, pas de la portee', () => {
    it('n’accepte pas un vehicule d’une AUTRE societe pour un super-admin sans selection', async () => {
      // ⚠️ LE PIEGE. La portee vaut `undefined` ici. Si elle servait aux validations
      // qui suivent, `where: { id, fleetId: undefined }` supprimerait le filtre et
      // Prisma accepterait un vehicule de n'importe quelle societe : un fail-open.
      // La flotte de reference doit etre celle de la mission chargee.
      prisma.mission.findFirst.mockResolvedValue({
        id: 'm-1',
        ref: 'M-0001',
        status: MissionStatus.PLANNED,
        startAt: new Date(Date.now() + 3 * 3600_000),
        endAt: new Date(Date.now() + 5 * 3600_000),
        fleetId: MH_CARS,
        vehicleId: 'v-1',
        depotUserId: null,
        vehicle: { plate: 'EP-047-TY' },
      });
      prisma.vehicle.findFirst.mockResolvedValue(null); // hors de la flotte de la mission

      await expect(service.modifier(SA, 'm-1', { vehicleId: 'v-autre' })).rejects.toBeDefined();
      expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: MH_CARS }) }),
      );
    });

    it('cherche la mission sans borne pour un super-admin sur « Toutes les societes »', async () => {
      await expect(service.modifier(SA, 'm-inconnue', { notes: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect('fleetId' in prisma.mission.findFirst.mock.calls[0][0].where).toBe(false);
    });
  });

  describe('l’activite des depots — colonne « Perimetre » de /users', () => {
    it('repond a un super-admin au lieu d’un 403 muet', async () => {
      await expect(service.activiteDesDepots(SA)).resolves.toEqual({});
      await service.activiteDesDepots(SA, MH_CARS);
      expect(prisma.mission.groupBy).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: MH_CARS }) }),
      );
    });
  });
});
