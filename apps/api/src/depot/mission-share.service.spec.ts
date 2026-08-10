import { BadRequestException, ForbiddenException, GoneException, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MissionStatus, ShareDuration, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { MissionShareService } from './mission-share.service';

/**
 * Lot A4 — les proprietes du lien public, protegees par des tests.
 *
 * ┌─ POURQUOI CE FICHIER EST PLUS FOURNI QUE LES AUTRES ──────────────────────┐
 * │ Partout ailleurs dans l'espace depot, une erreur se solde par un 403 : le   │
 * │ pire cas est un ecran vide, visible immediatement. Ici, le pire cas est un  │
 * │ LIEN PUBLIC QUI FUIT — une URL sans authentification, qui circule par SMS,  │
 * │ se transfere, et peut finir indexee.                                        │
 * │                                                                            │
 * │ Aucun de ces defauts ne se verrait a l'ecran : un lien qui expose la plaque │
 * │ affiche exactement la meme carte qu'un lien correct. C'est pourquoi le      │
 * │ contrat de fuite est teste CLE PAR CLE, et pas seulement « ca marche ».     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
describe('MissionShareService — le lien public', () => {
  let service: MissionShareService;
  let missionShareLink: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  let mission: { findFirst: jest.Mock };

  const DEPOT = { id: 'depot-1', role: UserRole.DEPOT as string, fleetId: 'fleet-1' };
  const GESTIONNAIRE = { id: 'gest-1', role: UserRole.FLEET_MANAGER as string, fleetId: 'fleet-1' };
  const MISSION_ID = 'mission-1';

  /** Une mission en cours, dans sa fenetre. */
  const missionEnCours = (surcharge: Record<string, unknown> = {}) => ({
    id: MISSION_ID,
    ref: 'M-0001',
    fleetId: 'fleet-1',
    endAt: new Date(Date.now() + 2 * 3600_000),
    status: MissionStatus.IN_PROGRESS,
    ...surcharge,
  });

  /** La forme que `suivrePublic` charge : mission + vehicule + boitier. */
  const lienValide = (surcharge: Record<string, unknown> = {}) => ({
    id: 'lien-1',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    revokedAt: null,
    mission: {
      status: MissionStatus.IN_PROGRESS,
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + 3600_000),
      actualEndAt: null,
      destLabel: 'Muret',
      fleet: { name: 'Transport Demo' },
      vehicle: {
        mixedUseEnabled: false,
        privacyModeEnabled: false,
        workOverrideUntil: null,
        workSchedule: null,
        tracker: { lastLat: 43.6, lastLng: 1.44, lastPositionAt: new Date() },
      },
    },
    ...surcharge,
  });

  beforeEach(async () => {
    missionShareLink = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    mission = { findFirst: jest.fn().mockResolvedValue(missionEnCours()) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionShareService,
        { provide: PrismaService, useValue: { missionShareLink, mission } },
        { provide: ConfigService, useValue: { get: () => 'https://app.exemple.fr' } },
        { provide: SystemActivityService, useValue: { record: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MissionShareService);
  });

  // ═══ LE CONTRAT DE FUITE ═══════════════════════════════════════════════════

  describe('ce que le lien public expose — et rien d\'autre', () => {
    it('sert EXACTEMENT les neuf cles du contrat, jamais une de plus', async () => {
      missionShareLink.findUnique.mockResolvedValue(lienValide());

      const dto = await service.suivrePublic('unToken');

      // Une cle ajoutee par inadvertance fait echouer ce test — c'est son seul but.
      expect(Object.keys(dto).sort()).toEqual([
        'carrierName',
        'destinationLabel',
        'etaAt',
        'expiresAt',
        'lastUpdateAt',
        'position',
        'positionUnavailableSince',
        'startAt',
        'status',
      ]);
    });

    it('ne laisse fuir ni plaque, ni conducteur, ni reference, ni origine, ni trace', async () => {
      missionShareLink.findUnique.mockResolvedValue(lienValide());

      const brut = JSON.stringify(await service.suivrePublic('unToken'));

      for (const interdit of ['plate', 'driver', 'phone', 'ref', 'origin', 'polyline', 'missionId', 'trackerId', 'vehicleId']) {
        expect(brut).not.toContain(interdit);
      }
    });

    it('sert UN POINT, jamais une ligne : la position n\'a que lat et lng', async () => {
      missionShareLink.findUnique.mockResolvedValue(lienValide());

      const dto = await service.suivrePublic('unToken');

      expect(Object.keys(dto.position ?? {}).sort()).toEqual(['lat', 'lng']);
    });
  });

  // ═══ LE 410 UNIFORME ═══════════════════════════════════════════════════════

  describe('les trois etats fermes sont indiscernables', () => {
    it('token inexistant → 410', async () => {
      missionShareLink.findUnique.mockResolvedValue(null);
      await expect(service.suivrePublic('inexistant')).rejects.toThrow(GoneException);
    });

    it('token revoque → 410', async () => {
      missionShareLink.findUnique.mockResolvedValue(lienValide({ revokedAt: new Date() }));
      await expect(service.suivrePublic('revoque')).rejects.toThrow(GoneException);
    });

    it('token expire → 410', async () => {
      missionShareLink.findUnique.mockResolvedValue(
        lienValide({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.suivrePublic('expire')).rejects.toThrow(GoneException);
    });

    it('les trois portent le MEME message — distinguer permettrait d\'enumerer', async () => {
      const messages: string[] = [];
      for (const cas of [null, lienValide({ revokedAt: new Date() }), lienValide({ expiresAt: new Date(Date.now() - 1) })]) {
        missionShareLink.findUnique.mockResolvedValue(cas);
        await service.suivrePublic('x').catch((e: Error) => messages.push(e.message));
      }
      expect(new Set(messages).size).toBe(1);
    });
  });

  // ═══ LA POSITION : quatre refus ════════════════════════════════════════════

  describe('quand la position n\'est PAS servie', () => {
    it('avant le depart (mission planifiee)', async () => {
      missionShareLink.findUnique.mockResolvedValue(
        lienValide({ mission: { ...lienValide().mission, status: MissionStatus.PLANNED } }),
      );
      const dto = await service.suivrePublic('x');
      expect(dto.position).toBeNull();
    });

    it('apres la livraison (mission terminee) — le camion repart ailleurs', async () => {
      missionShareLink.findUnique.mockResolvedValue(
        lienValide({
          mission: { ...lienValide().mission, status: MissionStatus.DONE, actualEndAt: new Date() },
        }),
      );
      const dto = await service.suivrePublic('x');
      expect(dto.position).toBeNull();
      expect(dto.status).toBe('DONE');
    });

    it('vehicule en mode vie privee — et SANS duree, qui trahirait le passage en prive', async () => {
      const base = lienValide().mission;
      missionShareLink.findUnique.mockResolvedValue(
        lienValide({
          mission: {
            ...base,
            vehicle: { ...base.vehicle, mixedUseEnabled: true, privacyModeEnabled: true },
          },
        }),
      );
      const dto = await service.suivrePublic('x');
      expect(dto.position).toBeNull();
      expect(dto.positionUnavailableSince).toBeNull();
    });

    it('position de plus de dix minutes — on sert l\'AGE, jamais le point perime', async () => {
      const base = lienValide().mission;
      missionShareLink.findUnique.mockResolvedValue(
        lienValide({
          mission: {
            ...base,
            vehicle: {
              ...base.vehicle,
              tracker: { lastLat: 43.6, lastLng: 1.44, lastPositionAt: new Date(Date.now() - 14 * 60_000) },
            },
          },
        }),
      );
      const dto = await service.suivrePublic('x');
      expect(dto.position).toBeNull();
      expect(dto.positionUnavailableSince).toBe(14);
    });
  });

  // ═══ L'EXPIRATION ══════════════════════════════════════════════════════════

  describe('le calcul de l\'expiration', () => {
    const capturerExpiration = async (duree: 'MIN_15' | 'HOUR_1' | 'UNTIL_MISSION_END', finMission: Date) => {
      mission.findFirst.mockResolvedValue(missionEnCours({ endAt: finMission }));
      missionShareLink.create.mockImplementation(({ data }: { data: { expiresAt: Date } }) =>
        Promise.resolve({
          id: 'l', token: 't', duration: ShareDuration.MIN_15, expiresAt: data.expiresAt,
          createdAt: new Date(), revokedAt: null, openCount: 0, lastOpenedAt: null,
        }),
      );
      const cree = await service.creer(DEPOT, MISSION_ID, duree);
      return new Date(cree.expiresAt).getTime() - Date.now();
    };

    it('MIN_15 → un quart d\'heure', async () => {
      const ms = await capturerExpiration('MIN_15', new Date(Date.now() + 3600_000));
      expect(ms).toBeGreaterThan(14 * 60_000);
      expect(ms).toBeLessThanOrEqual(15 * 60_000 + 1000);
    });

    it('HOUR_1 → une heure', async () => {
      const ms = await capturerExpiration('HOUR_1', new Date(Date.now() + 3600_000));
      expect(ms).toBeGreaterThan(59 * 60_000);
      expect(ms).toBeLessThanOrEqual(60 * 60_000 + 1000);
    });

    it('UNTIL_MISSION_END → fin annoncee + 30 min de marge', async () => {
      const ms = await capturerExpiration('UNTIL_MISSION_END', new Date(Date.now() + 60 * 60_000));
      // 60 min de mission + 30 min de marge.
      expect(ms).toBeGreaterThan(89 * 60_000);
      expect(ms).toBeLessThanOrEqual(90 * 60_000 + 1000);
    });

    it('UNTIL_MISSION_END sur une mission EN RETARD ne cree pas un lien mort-ne', async () => {
      // Le defaut qu'on protege : `endAt` est PASSE sur une mission en retard. Le calcul
      // litteral (`endAt + 30 min`) produisait un lien deja expire — precisement quand le
      // depot partage le suivi, parce que son client s'impatiente.
      const ms = await capturerExpiration('UNTIL_MISSION_END', new Date(Date.now() - 3 * 3600_000));
      expect(ms).toBeGreaterThan(29 * 60_000);
    });
  });

  // ═══ LES LIMITES ═══════════════════════════════════════════════════════════

  describe('les deux plafonds', () => {
    it('refuse le 4e lien actif sur une mission', async () => {
      // 1er appel : le quota horaire par compte (0). 2e : les liens actifs (3).
      missionShareLink.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
      await expect(service.creer(DEPOT, MISSION_ID, 'MIN_15')).rejects.toThrow(BadRequestException);
    });

    it('refuse la 21e creation de l\'heure, par COMPTE', async () => {
      missionShareLink.count.mockResolvedValueOnce(20);
      await expect(service.creer(DEPOT, MISSION_ID, 'MIN_15')).rejects.toThrow(HttpException);
    });

    it('compte le quota horaire sur le CREATEUR, pas sur l\'adresse IP', async () => {
      missionShareLink.count.mockResolvedValueOnce(20);
      await service.creer(DEPOT, MISSION_ID, 'MIN_15').catch(() => undefined);
      expect(missionShareLink.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdByUserId: DEPOT.id }),
        }),
      );
    });

    it('refuse de partager une mission terminee', async () => {
      mission.findFirst.mockResolvedValue(missionEnCours({ status: MissionStatus.DONE }));
      await expect(service.creer(DEPOT, MISSION_ID, 'MIN_15')).rejects.toThrow(BadRequestException);
    });
  });

  // ═══ LE PERIMETRE ══════════════════════════════════════════════════════════

  describe('qui peut creer et revoquer', () => {
    it('un DEPOT ne partage que SES missions — le where porte depotUserId', async () => {
      mission.findFirst.mockResolvedValue(null);
      await expect(service.creer(DEPOT, MISSION_ID, 'MIN_15')).rejects.toThrow(ForbiddenException);
      expect(mission.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ depotUserId: DEPOT.id }),
        }),
      );
    });

    it('un gestionnaire est borne a SA flotte, pas a un depot', async () => {
      mission.findFirst.mockResolvedValue(null);
      await expect(service.creer(GESTIONNAIRE, MISSION_ID, 'MIN_15')).rejects.toThrow(ForbiddenException);
      expect(mission.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ fleetId: GESTIONNAIRE.fleetId }),
        }),
      );
    });

    it('le transporteur revoque un lien cree par un depot — il porte la responsabilite', async () => {
      missionShareLink.findUnique.mockResolvedValue({
        id: 'lien-1',
        revokedAt: null,
        mission: { id: MISSION_ID, ref: 'M-0001', fleetId: 'fleet-1', depotUserId: 'depot-1', endAt: new Date() },
      });
      await expect(service.revoquer(GESTIONNAIRE, 'lien-1')).resolves.toBeUndefined();
      expect(missionShareLink.update).toHaveBeenCalled();
    });

    it('un depot ne revoque PAS le lien d\'un autre depot', async () => {
      missionShareLink.findUnique.mockResolvedValue({
        id: 'lien-1',
        revokedAt: null,
        mission: { id: MISSION_ID, ref: 'M-0001', fleetId: 'fleet-1', depotUserId: 'AUTRE-depot', endAt: new Date() },
      });
      await expect(service.revoquer(DEPOT, 'lien-1')).rejects.toThrow(ForbiddenException);
    });

    it('un lien inconnu donne le MEME refus qu\'un lien hors perimetre', async () => {
      missionShareLink.findUnique.mockResolvedValue(null);
      await expect(service.revoquer(DEPOT, 'inconnu')).rejects.toThrow(ForbiddenException);
    });
  });

  // ═══ LA FERMETURE EN CASCADE ═══════════════════════════════════════════════

  describe('la fin de mission ferme les liens', () => {
    it('RACCOURCIT l\'expiration, sans jamais la repousser', async () => {
      await service.fermerLiensDeMission(MISSION_ID, 'DONE');

      const appel = missionShareLink.updateMany.mock.calls[0][0];
      // Le `where` ne vise QUE les liens dont l'expiration est plus lointaine :
      // un lien qui expirait dans deux minutes continue d'expirer dans deux minutes.
      expect(appel.where).toMatchObject({ missionId: MISSION_ID, revokedAt: null });
      expect(appel.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(appel.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      // Et pas plus de cinq minutes : le temps de lire l'issue, pas de suivre la suite.
      expect(appel.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
    });

    it('la desactivation d\'un compte ferme les liens qu\'il a distribues', async () => {
      missionShareLink.updateMany.mockResolvedValue({ count: 2 });
      const n = await service.fermerLiensDuCompte('depot-1');
      expect(n).toBe(2);
      expect(missionShareLink.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdByUserId: 'depot-1', revokedAt: null },
        }),
      );
    });
  });

  // ═══ LE TOKEN ══════════════════════════════════════════════════════════════

  it('cree un token NEUF a chaque partage — sinon la revocation serait illusoire', async () => {
    const tokens: string[] = [];
    missionShareLink.create.mockImplementation(({ data }: { data: { token: string; expiresAt: Date } }) => {
      tokens.push(data.token);
      return Promise.resolve({
        id: 'l', token: data.token, duration: ShareDuration.MIN_15, expiresAt: data.expiresAt,
        createdAt: new Date(), revokedAt: null, openCount: 0, lastOpenedAt: null,
      });
    });

    await service.creer(DEPOT, MISSION_ID, 'MIN_15');
    await service.creer(DEPOT, MISSION_ID, 'MIN_15');

    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[0]).toMatch(/^[A-Za-z0-9]{22}$/);
  });

  it('la liste ne renvoie JAMAIS le token — il ne transite qu\'a la creation', async () => {
    missionShareLink.findMany.mockResolvedValue([
      {
        id: 'l1', token: 'SECRET_QUI_NE_DOIT_PAS', duration: ShareDuration.MIN_15,
        expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
        revokedAt: null, openCount: 3, lastOpenedAt: new Date(),
      },
    ]);

    const liens = await service.lister(DEPOT, MISSION_ID);

    expect(JSON.stringify(liens)).not.toContain('SECRET_QUI_NE_DOIT_PAS');
    expect(liens[0]).not.toHaveProperty('token');
    // L'usage, lui, est servi : c'est ce qui permet de revoquer en connaissance de cause.
    expect(liens[0]!.openCount).toBe(3);
  });
});
