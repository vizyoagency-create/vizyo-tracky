import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MissionStatus, UserRole, VehicleEventType } from '@prisma/client';
import {
  effectiveBlockingEndMs,
  IMMOBILIZING_STATUSES,
  isImmobilizingEvent,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MissionShareService } from '../depot/mission-share.service';
import { MissionPricingService } from './mission-pricing.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
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
    vehicle: { findFirst: jest.Mock; findMany: jest.Mock };
    user: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
    driver: { findFirst: jest.Mock };
    mission: { findFirst: jest.Mock; create: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    vehicleEvent: { create: jest.Mock; updateMany: jest.Mock };
    /** A6 / T8 — les arrets de la tournee. */
    missionStop: { createMany: jest.Mock; deleteMany: jest.Mock };
    /** A6 — le journal des tournees. */
    missionStopRevision: { create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let email: { buildMissionAssignedEmail: jest.Mock; buildMissionQuoteEmail: jest.Mock; send: jest.Mock };
  let pricing: { tarifPour: jest.Mock };

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
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'v-1', plate: 'FR-482-BX', tracker: { id: 't-1' } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'depot-1' }),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      driver: { findFirst: jest.fn().mockResolvedValue({ id: 'd-1' }) },
      mission: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm-1', ref: 'M-0001' }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      vehicleEvent: {
        create: jest.fn().mockResolvedValue({ id: 'ev-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // A6 / T8 — les arrets, ecrits dans la MEME transaction que la mission.
      missionStop: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      missionStopRevision: { create: jest.fn().mockResolvedValue({ id: 'rev-1' }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    // La transaction execute le callback avec un client qui porte les memes mocks.
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    email = {
      buildMissionAssignedEmail: jest.fn().mockReturnValue({ subject: 's', html: 'h', text: 't' }),
      buildMissionQuoteEmail: jest.fn().mockReturnValue({ subject: 's', html: 'h', text: 't' }),
      send: jest.fn().mockResolvedValue({ ok: true }),
    };
    pricing = {
      tarifPour: jest.fn().mockResolvedValue({
        statut: 'TARIF', trancheLibelle: '51 à 100 km', distanceKm: 62,
        htCents: 16900, tvaCents: 3380, ttcCents: 20280, lignes: [],
      }),
    };
    prisma.user.findUnique = jest.fn().mockResolvedValue({
      email: 'depot@exemple.fr',
      fleetId: 'f-1',
      fleet: { name: 'MH CARS' },
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: { get: () => 'https://app.exemple.fr' } },
        // Lot A3 — l'annulation previent les depots par le salon `depot:mission:<id>`.
        { provide: RealtimeGateway, useValue: { emitDepotMissionEnded: jest.fn() } },
        // Lot A4 — la cloture ferme les liens publics de la mission. Un espion suffit :
        // ce qui est teste ici est la BASCULE, pas la fermeture (qui a ses propres tests).
        { provide: MissionShareService, useValue: { fermerLiensDeMission: jest.fn().mockResolvedValue(0) } },
        // A6 — le recalcul du tarif quand la tournee change. Un espion suffit : la
        // grille a ses propres tests, ce qui est verifie ici c'est le JOURNAL.
        { provide: MissionPricingService, useValue: pricing },
      ],
    }).compile();
    service = moduleRef.get(MissionsService);
  });

  /**
   * A6 / T8 — les arrets multiples sur la mission (arbitrage A).
   *
   * ┌─ CE QUI EST PROTEGE ICI ──────────────────────────────────────────────────┐
   * │ 1. LE CHAMP EST OPTIONNEL, ET SON ABSENCE NE CHANGE RIEN. C'est ce qui     │
   * │    rend T8 deployable sans reprendre les cinq chemins de lecture           │
   * │    existants — API publique, scripts, agenda d'avant cette version.        │
   * │ 2. LES DEUX LIBELLES SUIVENT LES ARRETS, jamais l'inverse. Les arrets sont │
   * │    la source de verite, `originLabel`/`destLabel` en sont le resume (§ 4.1)│
   * │ 3. LES ARRETS SONT ECRITS DANS LA TRANSACTION DE LA MISSION. Une mission   │
   * │    sans ses arrets serait un trajet ampute que rien ne rattraperait.       │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  describe('les arrets multiples (T8)', () => {
    const TOURNEE = [
      { label: 'Entrepot Fenouillet' },
      { label: 'Client Blagnac' },
      { label: 'Client Muret' },
    ];

    it('sans `stops`, RIEN ne change : aucun arret ecrit', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      expect(prisma.missionStop.createMany).not.toHaveBeenCalled();
      expect(prisma.mission.create.mock.calls[0][0].data).toMatchObject({
        originLabel: 'Fenouillet',
        destLabel: 'Muret',
      });
    });

    it('ecrit les arrets dans l\'ordre, le premier en PICKUP', async () => {
      await service.creer(GESTIONNAIRE, { ...ENTREE, stops: TOURNEE });
      const data = prisma.missionStop.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(3);
      expect(data[0]).toMatchObject({ position: 0, kind: 'PICKUP', label: 'Entrepot Fenouillet' });
      expect(data[1]).toMatchObject({ position: 1, kind: 'DROPOFF', label: 'Client Blagnac' });
      expect(data[2]).toMatchObject({ position: 2, kind: 'DROPOFF', label: 'Client Muret' });
    });

    it('RECALCULE les deux libelles depuis le premier et le dernier arret', async () => {
      // Les libelles envoyes sont volontairement FAUX : ce sont les arrets qui font foi.
      await service.creer(GESTIONNAIRE, {
        ...ENTREE,
        originLabel: 'Perime',
        destLabel: 'Perime aussi',
        stops: TOURNEE,
      });
      expect(prisma.mission.create.mock.calls[0][0].data).toMatchObject({
        originLabel: 'Entrepot Fenouillet',
        destLabel: 'Client Muret',
      });
    });

    it('le titre de l\'evenement d\'agenda suit les libelles derives', async () => {
      // Sinon l'agenda afficherait un trajet que la fiche mission dement.
      await service.creer(GESTIONNAIRE, {
        ...ENTREE,
        originLabel: 'Perime',
        stops: TOURNEE,
      });
      expect(prisma.vehicleEvent.create.mock.calls[0][0].data.title).toContain('Entrepot Fenouillet');
      expect(prisma.vehicleEvent.create.mock.calls[0][0].data.title).not.toContain('Perime');
    });

    it('refuse un trajet a un seul arret : ce n\'est pas un trajet', async () => {
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, stops: [{ label: 'Fenouillet' }] }),
      ).rejects.toThrow(/au moins une adresse de chargement/);
      expect(prisma.mission.create).not.toHaveBeenCalled();
    });

    it('refuse un tableau vide : c\'est une saisie perdue, pas une intention', async () => {
      await expect(service.creer(GESTIONNAIRE, { ...ENTREE, stops: [] })).rejects.toThrow(
        /au moins une adresse de chargement/,
      );
    });

    it('refuse un arret sans libelle, en le NOMMANT', async () => {
      await expect(
        service.creer(GESTIONNAIRE, {
          ...ENTREE,
          stops: [{ label: 'Fenouillet' }, { label: '  ' }, { label: 'Muret' }],
        }),
      ).rejects.toThrow(/Arrêt 2/);
      expect(prisma.mission.create).not.toHaveBeenCalled();
    });

    it('valide AVANT toute ecriture — aucune mission orpheline', async () => {
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, stops: [{ label: 'seul' }] }),
      ).rejects.toThrow();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.vehicleEvent.create).not.toHaveBeenCalled();
    });
  });

  /**
   * A6 — MODIFIER LA TOURNEE, ET LAISSER UNE TRACE.
   *
   * ┌─ CE QUI EST PROTEGE ICI ──────────────────────────────────────────────────┐
   * │ 1. LE JOURNAL EST IMMUABLE ET COMPLET. Chaque modification ecrit une       │
   * │    revision de plus, jamais un champ ecrase : c'est ce qui permet de       │
   * │    repondre six mois plus tard a « pourquoi cette facture ».               │
   * │ 2. LE MOTIF EST OBLIGATOIRE. Une tournee qu'on change a une raison.        │
   * │ 3. LE PRIX CONVENU N'EST PAS REECRIT. On calcule ce que vaut la nouvelle   │
   * │    tournee, on l'inscrit, et on laisse les humains decider.                │
   * │ 4. UN DEPOT NE MODIFIE PAS UNE MISSION. C'est l'invariant du lot.          │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  describe('modifier la tournee, et la tracer', () => {
    const DEPOT = { id: 'depot-1', fleetId: 'f-1', role: UserRole.DEPOT } as AuthUser;
    const TOURNEE = [
      { label: 'Entrepot Fenouillet' },
      { label: 'Client Blagnac' },
      { label: 'Client Muret' },
    ];

    const missionEn = (over: Record<string, unknown> = {}) => ({
      id: 'm-1', ref: 'M-0001', fleetId: 'f-1', status: MissionStatus.PLANNED,
      depotUserId: 'depot-1', startAt: new Date(), endAt: new Date(),
      stopRevisions: [],
      ...over,
    });

    it('ecrit une revision, avec l\'auteur et le motif', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE,
        distanceKm: 62,
        reason: 'Le client a ajoute un point de livraison.',
      });
      const data = prisma.missionStopRevision.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        missionId: 'm-1',
        position: 0,
        authorRole: UserRole.FLEET_MANAGER,
        reason: 'Le client a ajoute un point de livraison.',
        distanceM: 62_000,
      });
      // Le nom est FIGE : un compte supprime ne doit pas effacer sa signature.
      expect(typeof data.authorName).toBe('string');
      expect(data.authorName.length).toBeGreaterThan(0);
    });

    it('range la revision APRES la precedente, jamais a sa place', async () => {
      prisma.mission.findFirst.mockResolvedValue(
        missionEn({ stopRevisions: [{ position: 3, amountCents: 7900 }] }),
      );
      await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: 62, reason: 'Motif suffisant.',
      });
      const data = prisma.missionStopRevision.create.mock.calls[0][0].data;
      expect(data.position).toBe(4);
      // Le tarif d'AVANT est recopie : relire l'ecart ne doit pas demander de
      // rejouer tout l'historique, ni la grille tarifaire de l'epoque.
      expect(data.previousAmountCents).toBe(7900);
    });

    it('RECALCULE le tarif sur la nouvelle distance', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      const r = await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: 62, reason: 'Motif suffisant.',
      });
      expect(pricing.tarifPour).toHaveBeenCalledWith('f-1', 62_000);
      expect(r.amountCents).toBe(16900);
    });

    it('n\'invente aucun montant sans distance', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      const r = await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: null, reason: 'Motif suffisant.',
      });
      expect(pricing.tarifPour).not.toHaveBeenCalled();
      expect(r.amountCents).toBeNull();
    });

    it('exige un motif — c\'est lui qu\'on relira', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      await expect(
        service.modifierTournee(GESTIONNAIRE, 'm-1', { stops: TOURNEE, reason: '' }),
      ).rejects.toThrow(/motif/i);
      expect(prisma.missionStopRevision.create).not.toHaveBeenCalled();
      expect(prisma.missionStop.deleteMany).not.toHaveBeenCalled();
    });

    it('UN DEPOT NE MODIFIE PAS UNE MISSION', async () => {
      // L'invariant du lot : un depot est un tiers en lecture seule sur une mission.
      // Il negocie une DEMANDE, pas un camion deja engage.
      await expect(
        service.modifierTournee(DEPOT, 'm-1', { stops: TOURNEE, reason: 'Motif suffisant.' }),
      ).rejects.toThrow(/dépôt ne modifie pas/i);
      expect(prisma.mission.findFirst).not.toHaveBeenCalled();
    });

    it('refuse une mission terminee ou annulee', async () => {
      for (const status of [MissionStatus.DONE, MissionStatus.CANCELLED]) {
        prisma.missionStopRevision.create.mockClear();
        prisma.mission.findFirst.mockResolvedValue(missionEn({ status }));
        await expect(
          service.modifierTournee(GESTIONNAIRE, 'm-1', { stops: TOURNEE, reason: 'Motif suffisant.' }),
        ).rejects.toThrow(/ne se modifie plus/);
        expect(prisma.missionStopRevision.create).not.toHaveBeenCalled();
      }
    });

    it('remplace les arrets EN BLOC et recompose les deux libelles', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: 62, reason: 'Motif suffisant.',
      });
      expect(prisma.missionStop.deleteMany).toHaveBeenCalledWith({ where: { missionId: 'm-1' } });
      expect(prisma.mission.update.mock.calls[0][0].data).toMatchObject({
        originLabel: 'Entrepot Fenouillet',
        destLabel: 'Client Muret',
      });
    });

    it('met l\'evenement d\'agenda a jour — sinon deux trajets pour une mission', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: 62, reason: 'Motif suffisant.',
      });
      const maj = prisma.vehicleEvent.updateMany.mock.calls[0][0];
      expect(maj.where.metadata).toEqual({ path: ['missionId'], equals: 'm-1' });
      expect(maj.data.title).toContain('Client Muret');
    });

    it('previent le depot : c\'est son camion, et sa facture', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn());
      await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: 62, reason: 'Deux points ajoutes.',
      });
      await new Promise((r) => setImmediate(r));
      expect(email.buildMissionQuoteEmail).toHaveBeenCalled();
      // Le motif part avec l'avis : c'est la seule phrase qui explique POURQUOI.
      expect(email.buildMissionQuoteEmail.mock.calls[0][0].message).toBe('Deux points ajoutes.');
      expect(email.send.mock.calls[0][0].template).toBe('mission_tournee_modifiee');
    });

    it('une mission sans depot ne declenche aucun avis', async () => {
      prisma.mission.findFirst.mockResolvedValue(missionEn({ depotUserId: null }));
      await service.modifierTournee(GESTIONNAIRE, 'm-1', {
        stops: TOURNEE, distanceKm: 62, reason: 'Motif suffisant.',
      });
      await new Promise((r) => setImmediate(r));
      expect(email.send).not.toHaveBeenCalled();
    });
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

  describe('effet 3 — la notification du depot', () => {
    /** L'envoi est en `void` : on laisse la micro-tache se vider avant d'observer. */
    const laisserPartirLEmail = () => new Promise((r) => setImmediate(r));

    it('envoie l\'e-mail quand un depot est designe', async () => {
      await service.creer(GESTIONNAIRE, { ...ENTREE, depotUserId: 'depot-1' });
      await laisserPartirLEmail();
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'depot@exemple.fr', template: 'mission_assigned' }),
      );
    });

    it('n\'envoie RIEN pour une mission interne', async () => {
      await service.creer(GESTIONNAIRE, ENTREE);
      await laisserPartirLEmail();
      expect(email.send).not.toHaveBeenCalled();
    });

    it('nomme le TRANSPORTEUR, pas Tracky', async () => {
      // Le depot ne connait pas notre marque : c'est de son transporteur qu'il attend
      // un e-mail (A0 § Marque).
      await service.creer(GESTIONNAIRE, { ...ENTREE, depotUserId: 'depot-1' });
      await laisserPartirLEmail();
      expect(email.buildMissionAssignedEmail.mock.calls[0][0].carrierName).toBe('MH CARS');
    });

    it('une panne d\'e-mail n\'annule PAS la mission', async () => {
      // Le gestionnaire a valide, le vehicule est bloque, la mission est ecrite. Faire
      // echouer la creation parce que Resend est tombe serait lui faire perdre sa saisie
      // — et le depot verrait la mission en se connectant de toute facon.
      email.send.mockRejectedValue(new Error('fournisseur indisponible'));
      await expect(
        service.creer(GESTIONNAIRE, { ...ENTREE, depotUserId: 'depot-1' }),
      ).resolves.toMatchObject({ mission: { ref: 'M-0001' } });
      await laisserPartirLEmail();
    });

    it('transmet le creneau et la plaque — pas les notes internes', async () => {
      await service.creer(GESTIONNAIRE, {
        ...ENTREE,
        depotUserId: 'depot-1',
        notes: 'client difficile',
      });
      await laisserPartirLEmail();
      const arg = email.buildMissionAssignedEmail.mock.calls[0][0];
      expect(arg.plate).toBe('FR-482-BX');
      expect(arg.ref).toBe('M-0001');
      expect(JSON.stringify(arg)).not.toContain('client difficile');
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

  describe('effet 4 — l\'obligation d\'information du conducteur', () => {
    beforeEach(() => {
      prisma.driver.findFirst.mockResolvedValue({ id: 'd-1' });
    });

    it('signale qu\'un tiers suit la position quand un depot est destinataire', async () => {
      prisma.mission.findMany.mockResolvedValue([
        {
          id: 'm-1', ref: 'M-0001', originLabel: 'A', destLabel: 'B',
          startAt: new Date(), endAt: new Date(), status: MissionStatus.IN_PROGRESS,
          depotUserId: 'depot-1', vehicle: { plate: 'FR-482-BX' },
        },
      ]);
      const res = await service.missionsDuConducteur({ id: 'u-driver' } as AuthUser);
      expect(res[0].depotWatching).toBe(true);
    });

    it('ne le signale PAS sur une mission interne', async () => {
      prisma.mission.findMany.mockResolvedValue([
        {
          id: 'm-1', ref: 'M-0001', originLabel: 'A', destLabel: 'B',
          startAt: new Date(), endAt: new Date(), status: MissionStatus.PLANNED,
          depotUserId: null, vehicle: { plate: 'FR-482-BX' },
        },
      ]);
      const res = await service.missionsDuConducteur({ id: 'u-driver' } as AuthUser);
      expect(res[0].depotWatching).toBe(false);
    });

    it('la mention est calculee COTE SERVEUR, pas laissee au client', async () => {
      // Une obligation legale ne doit pas dependre d'un `@if` qu'on peut supprimer par
      // megarde dans un template. Le champ arrive deja decide.
      prisma.mission.findMany.mockResolvedValue([
        {
          id: 'm-1', ref: 'M-0001', originLabel: 'A', destLabel: 'B',
          startAt: new Date(), endAt: new Date(), status: MissionStatus.IN_PROGRESS,
          depotUserId: 'depot-1', vehicle: { plate: 'FR-482-BX' },
        },
      ]);
      const res = await service.missionsDuConducteur({ id: 'u-driver' } as AuthUser);
      expect(res[0]).toHaveProperty('depotWatching');
      // …et l'identite du depot, elle, ne sort pas : le conducteur n'a pas a la connaitre.
      expect(res[0]).not.toHaveProperty('depotUserId');
    });

    it('ne renvoie QUE ses propres missions', async () => {
      await service.missionsDuConducteur({ id: 'u-driver' } as AuthUser);
      expect(prisma.mission.findMany.mock.calls[0][0].where.driverId).toBe('d-1');
    });

    it('renvoie une liste vide si le compte n\'est lie a aucun conducteur', async () => {
      prisma.driver.findFirst.mockResolvedValue(null);
      await expect(service.missionsDuConducteur({ id: 'u-x' } as AuthUser)).resolves.toEqual([]);
      expect(prisma.mission.findMany).not.toHaveBeenCalled();
    });
  });

  describe('la liste et ses 5 compteurs', () => {
    const ligne = (over: Record<string, unknown> = {}) => ({
      id: 'm-1', ref: 'M-0001', originLabel: 'A', destLabel: 'B',
      startAt: new Date(), endAt: new Date(), status: MissionStatus.IN_PROGRESS,
      vehicleId: 'v-1', vehicle: { plate: 'FR-1' }, driver: null, depotUser: null,
      // A6 / T8 — la selection charge TOUJOURS les arrets, meme vides. La ligne
      // simulee doit donc porter le tableau : le contraire ferait passer un test sur
      // une forme que Prisma ne rend jamais.
      stops: [],
      ...over,
    });

    it('compte les VEHICULES distincts, pas les missions', async () => {
      // Trois missions sur le meme camion n'immobilisent qu'un camion. Compter les
      // missions afficherait « 3 vehicules indisponibles » sur une flotte de 7, et le
      // gestionnaire chercherait longtemps les deux autres.
      prisma.mission.findMany.mockResolvedValue([
        ligne({ vehicleId: 'v-1' }),
        ligne({ id: 'm-2', vehicleId: 'v-1' }),
        ligne({ id: 'm-3', vehicleId: 'v-2' }),
      ]);
      const { compteurs } = await service.lister(GESTIONNAIRE, {});
      expect(compteurs.vehiculesIndisponibles).toBe(2);
    });

    it('n\'immobilise PAS sur une mission terminee ou annulee', async () => {
      prisma.mission.findMany.mockResolvedValue([
        ligne({ status: MissionStatus.DONE, vehicleId: 'v-1' }),
        ligne({ id: 'm-2', status: MissionStatus.CANCELLED, vehicleId: 'v-2' }),
      ]);
      const { compteurs } = await service.lister(GESTIONNAIRE, {});
      expect(compteurs.vehiculesIndisponibles).toBe(0);
    });

    it('compte les depots DISTINCTS', async () => {
      prisma.mission.findMany.mockResolvedValue([
        ligne({ depotUser: { id: 'd-1', firstName: 'Depot', lastName: 'A', email: 'a@x.fr' } }),
        ligne({ id: 'm-2', depotUser: { id: 'd-1', firstName: 'Depot', lastName: 'A', email: 'a@x.fr' } }),
        ligne({ id: 'm-3', depotUser: { id: 'd-2', firstName: 'Depot', lastName: 'B', email: 'b@x.fr' } }),
      ]);
      const { compteurs } = await service.lister(GESTIONNAIRE, {});
      expect(compteurs.depotsDestinataires).toBe(2);
    });

    it('ventile en cours / planifiees / en retard', async () => {
      prisma.mission.findMany.mockResolvedValue([
        ligne({ status: MissionStatus.IN_PROGRESS }),
        ligne({ id: 'm-2', status: MissionStatus.PLANNED }),
        ligne({ id: 'm-3', status: MissionStatus.LATE }),
        ligne({ id: 'm-4', status: MissionStatus.LATE }),
      ]);
      const { compteurs } = await service.lister(GESTIONNAIRE, {});
      expect(compteurs).toMatchObject({ enCours: 1, planifiees: 1, enRetard: 2 });
    });

    it('borne toujours a la flotte de l\'utilisateur', async () => {
      await service.lister(GESTIONNAIRE, {});
      expect(prisma.mission.findMany.mock.calls[0][0].where.fleetId).toBe('f-1');
    });

    it('nomme les missions internes plutot que de laisser un vide', async () => {
      prisma.mission.findMany.mockResolvedValue([ligne({ depotUser: null })]);
      const { missions } = await service.lister(GESTIONNAIRE, {});
      expect(missions[0].depotName).toBeNull();
      expect(missions[0].depotId).toBeNull();
    });
  });

  describe('la disponibilite affichee dans la modale', () => {
    beforeEach(() => {
      prisma.vehicle.findMany = jest.fn().mockResolvedValue([
        { id: 'v-1', plate: 'FR-1', brand: 'Renault', model: 'D 12 t' },
        { id: 'v-2', plate: 'FR-2', brand: null, model: null },
      ]);
    });

    const creneau = () => [new Date('2026-08-10T08:00:00Z'), new Date('2026-08-10T11:00:00Z')] as const;

    it('renvoie TOUS les vehicules, occupes compris', async () => {
      // Masquer les occupes ferait disparaitre le camion que le gestionnaire cherchait,
      // sans lui dire pourquoi — et il rouvrirait le formulaire cinq fois.
      prisma.mission.findMany.mockResolvedValue([
        { vehicleId: 'v-1', ref: 'M-2482', startAt: new Date('2026-08-10T09:00:00Z'), endAt: new Date('2026-08-10T12:20:00Z') },
      ]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, ...creneau());
      expect(res).toHaveLength(2);
      expect(res.map((v) => v.plate)).toEqual(['FR-1', 'FR-2']);
    });

    it('porte le MOTIF d\'occupation, redige cote serveur', async () => {
      prisma.mission.findMany.mockResolvedValue([
        { vehicleId: 'v-1', ref: 'M-2482', startAt: new Date('2026-08-10T09:00:00Z'), endAt: new Date('2026-08-10T12:20:00Z') },
      ]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, ...creneau());
      const occupe = res.find((v) => v.id === 'v-1')!;
      expect(occupe.available).toBe(false);
      expect(occupe.reason).toMatch(/Déjà en mission M-2482/);
    });

    it('laisse les vehicules libres sans motif', async () => {
      prisma.mission.findMany.mockResolvedValue([]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, ...creneau());
      expect(res.every((v) => v.available && v.reason === null)).toBe(true);
    });

    it('compose le libelle depuis marque + modele', async () => {
      prisma.mission.findMany.mockResolvedValue([]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, ...creneau());
      expect(res[0].label).toBe('Renault D 12 t');
      expect(res[1].label).toBeNull();
    });

    it('ne considere QUE les missions qui occupent encore', async () => {
      await service.disponibiliteVehicules(GESTIONNAIRE, ...creneau());
      const where = prisma.mission.findMany.mock.calls[0][0].where;
      expect(where.status.in).toEqual([
        MissionStatus.PLANNED,
        MissionStatus.IN_PROGRESS,
        MissionStatus.LATE,
      ]);
    });
  });

  describe('niveau 2 du conflit — le prochain creneau libre', () => {
    const T = (h: number) => new Date(`2026-08-10T${String(h).padStart(2, '0')}:00:00Z`);

    beforeEach(() => {
      // Un seul vehicule dans la flotte : garantit le cas « aucun libre ».
      prisma.vehicle.findMany = jest.fn().mockResolvedValue([
        { id: 'v-1', plate: 'FR-1', brand: null, model: null },
      ]);
    });

    it('ne calcule RIEN tant qu\'un vehicule reste libre', async () => {
      // Calculer pour rien couterait une requete par vehicule a chaque frappe dans
      // le formulaire. Tant qu'il reste un camion, la question ne se pose pas.
      prisma.vehicle.findMany.mockResolvedValue([
        { id: 'v-1', plate: 'FR-1', brand: null, model: null },
        { id: 'v-2', plate: 'FR-2', brand: null, model: null },
      ]);
      prisma.mission.findMany.mockResolvedValue([
        { vehicleId: 'v-1', ref: 'M-1', startAt: T(9), endAt: T(12) },
      ]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, T(8), T(11));
      expect(res.every((v) => v.nextFreeAt === null)).toBe(true);
      // Une seule requete missions : celle de l'occupation. Aucune de calcul.
      expect(prisma.mission.findMany).toHaveBeenCalledTimes(1);
    });

    it('propose la fin de la mission bloquante quand tout est pris', async () => {
      prisma.mission.findMany
        // 1er appel : les missions occupantes sur le creneau demande
        .mockResolvedValueOnce([{ vehicleId: 'v-1', ref: 'M-1', startAt: T(9), endAt: T(12) }])
        // 2e appel : le calcul du prochain creneau pour v-1
        .mockResolvedValueOnce([{ startAt: T(9), endAt: T(12) }]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, T(8), T(11));
      // Demande 08:00→11:00 (3 h). La mission tient 09:00→12:00 : le creneau candidat
      // est repousse a 12:00, ou plus rien ne gene.
      expect(res[0].nextFreeAt).toBe(T(12).toISOString());
    });

    it('trouve un trou ENTRE deux missions, sans sauter a la fin', async () => {
      // C'est le cas qui distingue un vrai calcul d'un « endAt de la derniere mission ».
      prisma.mission.findMany
        .mockResolvedValueOnce([{ vehicleId: 'v-1', ref: 'M-1', startAt: T(8), endAt: T(10) }])
        .mockResolvedValueOnce([
          { startAt: T(8), endAt: T(10) },
          { startAt: T(15), endAt: T(18) },
        ]);
      // Demande 08:00→09:00 (1 h). Apres la 1re mission, 10:00 laisse 5 h avant la 2e.
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, T(8), T(9));
      expect(res[0].nextFreeAt).toBe(T(10).toISOString());
    });

    it('enjambe plusieurs missions collees', async () => {
      prisma.mission.findMany
        .mockResolvedValueOnce([{ vehicleId: 'v-1', ref: 'M-1', startAt: T(8), endAt: T(10) }])
        .mockResolvedValueOnce([
          { startAt: T(8), endAt: T(10) },
          { startAt: T(10), endAt: T(13) },
          { startAt: T(13), endAt: T(16) },
        ]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, T(8), T(11));
      expect(res[0].nextFreeAt).toBe(T(16).toISOString());
    });

    it('rend le creneau demande lui-meme si rien ne gene apres verification', async () => {
      prisma.mission.findMany
        .mockResolvedValueOnce([{ vehicleId: 'v-1', ref: 'M-1', startAt: T(20), endAt: T(22) }])
        .mockResolvedValueOnce([]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, T(8), T(11));
      expect(res[0].nextFreeAt).toBe(T(8).toISOString());
    });

    it('renvoie null au-dela de l\'horizon — « libre dans 4 mois » n\'aide personne', async () => {
      const loin = new Date(T(8).getTime() + 60 * 24 * 3600_000);
      prisma.mission.findMany
        .mockResolvedValueOnce([{ vehicleId: 'v-1', ref: 'M-1', startAt: T(8), endAt: loin }])
        .mockResolvedValueOnce([{ startAt: T(8), endAt: loin }]);
      const res = await service.disponibiliteVehicules(GESTIONNAIRE, T(8), T(11));
      expect(res[0].nextFreeAt).toBeNull();
    });
  });

  describe('le bandeau « en mission » de la fiche vehicule', () => {
    const enCours = (over: Record<string, unknown> = {}) => ({
      id: 'm-1', ref: 'M-0001', originLabel: 'A', destLabel: 'B',
      startAt: new Date(), endAt: new Date(Date.now() + 3600_000),
      status: MissionStatus.IN_PROGRESS,
      depotUser: { firstName: 'Dépôt', lastName: 'Fenouillet', email: 'd@x.fr' },
      ...over,
    });

    it('signale qu\'un tiers regarde le camion EN CE MOMENT', async () => {
      // Un gestionnaire qui ouvre cette fiche pour couper le moteur doit le savoir
      // AVANT d'agir, pas apres.
      prisma.mission.findFirst.mockResolvedValue(enCours());
      const r = await service.missionEnCours(GESTIONNAIRE, 'v-1');
      expect(r).toMatchObject({ ref: 'M-0001', depotWatching: true, depotName: 'Dépôt Fenouillet' });
    });

    it('ne signale aucun tiers sur une mission interne', async () => {
      prisma.mission.findFirst.mockResolvedValue(enCours({ depotUser: null }));
      const r = await service.missionEnCours(GESTIONNAIRE, 'v-1');
      expect(r?.depotWatching).toBe(false);
      expect(r?.depotName).toBeNull();
    });

    it('ne retient QUE les statuts de suivi actif', async () => {
      prisma.mission.findFirst.mockResolvedValue(null);
      await service.missionEnCours(GESTIONNAIRE, 'v-1');
      const where = prisma.mission.findFirst.mock.calls[0][0].where;
      expect(where.status.in).toEqual([MissionStatus.IN_PROGRESS, MissionStatus.LATE]);
      // Une mission planifiee n'a pas commence : afficher « en mission » serait faux.
      expect(where.status.in).not.toContain(MissionStatus.PLANNED);
    });

    it('reste borne a la flotte de l\'utilisateur', async () => {
      prisma.mission.findFirst.mockResolvedValue(null);
      await service.missionEnCours(GESTIONNAIRE, 'v-1');
      expect(prisma.mission.findFirst.mock.calls[0][0].where.fleetId).toBe('f-1');
    });

    it('renvoie null quand le vehicule n\'est pas en mission', async () => {
      prisma.mission.findFirst.mockResolvedValue(null);
      await expect(service.missionEnCours(GESTIONNAIRE, 'v-1')).resolves.toBeNull();
    });
  });

  describe('le selecteur de depot', () => {
    it('ne liste que les comptes DEPOT actifs de la flotte', async () => {
      prisma.user.findMany = jest.fn().mockResolvedValue([]);
      await service.listerDepots(GESTIONNAIRE);
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
        fleetId: 'f-1',
        role: UserRole.DEPOT,
        isActive: true,
      });
    });

    it('retombe sur l\'e-mail quand le nom est vide', async () => {
      prisma.user.findMany = jest.fn().mockResolvedValue([
        { id: 'd-1', firstName: null, lastName: null, email: 'depot@exemple.fr' },
      ]);
      const res = await service.listerDepots(GESTIONNAIRE);
      expect(res[0].nom).toBe('depot@exemple.fr');
    });
  });

  describe('la modification — trois regimes selon le statut (A2 § 6)', () => {
    const missionEnBase = (statut: MissionStatus, over: Record<string, unknown> = {}) => ({
      id: 'm-1',
      ref: 'M-0001',
      status: statut,
      startAt: new Date('2026-08-10T08:00:00Z'),
      endAt: new Date('2026-08-10T11:00:00Z'),
      vehicleId: 'v-1',
      depotUserId: 'depot-1',
      vehicle: { plate: 'FR-482-BX' },
      ...over,
    });

    beforeEach(() => {
      prisma.mission.update = jest.fn().mockResolvedValue({});
      prisma.vehicleEvent.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    });

    it('PLANIFIEE : tout est modifiable', async () => {
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.PLANNED))
        .mockResolvedValueOnce(null); // pas de conflit
      await expect(
        service.modifier(GESTIONNAIRE, 'm-1', {
          originLabel: 'Ailleurs',
          startAt: '2026-08-10T09:00:00Z',
          endAt: '2026-08-10T12:00:00Z',
          notes: 'note',
        }),
      ).resolves.toBeDefined();
      expect(prisma.mission.update).toHaveBeenCalled();
    });

    it.each([
      [MissionStatus.IN_PROGRESS, 'vehicleId', 'v-2'],
      [MissionStatus.IN_PROGRESS, 'startAt', '2026-08-10T09:00:00Z'],
      [MissionStatus.IN_PROGRESS, 'depotUserId', 'depot-2'],
      [MissionStatus.LATE, 'originLabel', 'Ailleurs'],
      [MissionStatus.DONE, 'endAt', '2026-08-10T12:00:00Z'],
      [MissionStatus.CANCELLED, 'notes', 'trop tard'],
    ])('%s : le champ %s est REFUSE, pas ignore', async (statut, champ, valeur) => {
      // Ignorer en silence laisserait l'interface afficher une valeur que le serveur
      // n'a pas ecrite : le gestionnaire croirait avoir change le vehicule d'une
      // mission en cours, et decouvrirait le contraire en rouvrant la fiche.
      prisma.mission.findFirst.mockResolvedValue(missionEnBase(statut));
      await expect(
        service.modifier(GESTIONNAIRE, 'm-1', { [champ]: valeur } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.mission.update).not.toHaveBeenCalled();
    });

    it.each([
      [MissionStatus.IN_PROGRESS, 'endAt'],
      [MissionStatus.LATE, 'endAt'],
      [MissionStatus.DONE, 'notes'],
    ])('%s : le champ %s reste autorise', async (statut, champ) => {
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(statut))
        .mockResolvedValueOnce(null);
      const valeur = champ === 'endAt' ? '2026-08-10T12:00:00Z' : 'une note';
      await expect(
        service.modifier(GESTIONNAIRE, 'm-1', { [champ]: valeur } as never),
      ).resolves.toBeDefined();
    });

    it('LATE autorise endAt — c\'est le cas le plus frequent d\'un retard', async () => {
      // Repousser l'heure de fin d'une mission en retard est precisement ce qu'un
      // gestionnaire fait quand la livraison prend du retard.
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.LATE))
        .mockResolvedValueOnce(null);
      const r = await service.modifier(GESTIONNAIRE, 'm-1', { endAt: '2026-08-10T13:00:00Z' });
      expect(r.impactFenetre).toMatchObject({ sens: 'ETENDUE', minutes: 120 });
    });

    it('decrit l\'impact sur la fenetre du depot — etendue', async () => {
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.IN_PROGRESS))
        .mockResolvedValueOnce(null);
      const r = await service.modifier(GESTIONNAIRE, 'm-1', { endAt: '2026-08-10T11:40:00Z' });
      expect(r.impactFenetre).toEqual({
        sens: 'ETENDUE',
        minutes: 40,
        nouvelleFin: '2026-08-10T11:40:00.000Z',
      });
    });

    it('decrit l\'impact — reduite', async () => {
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.IN_PROGRESS))
        .mockResolvedValueOnce(null);
      const r = await service.modifier(GESTIONNAIRE, 'm-1', { endAt: '2026-08-10T10:30:00Z' });
      expect(r.impactFenetre).toMatchObject({ sens: 'REDUITE', minutes: 30 });
    });

    it('aucun impact a decrire sur une mission INTERNE', async () => {
      // Sans depot destinataire, aucun tiers n'est concerne : annoncer un impact
      // serait inventer une consequence qui n'existe pas.
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.IN_PROGRESS, { depotUserId: null }))
        .mockResolvedValueOnce(null);
      const r = await service.modifier(GESTIONNAIRE, 'm-1', { endAt: '2026-08-10T12:00:00Z' });
      expect(r.impactFenetre).toBeNull();
    });

    it('re-verifie le conflit quand le creneau bouge, EN S\'EXCLUANT elle-meme', async () => {
      // Sans l'exclusion, toute mission serait en conflit avec elle-meme et aucune
      // modification d'horaire ne passerait jamais.
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.PLANNED))
        .mockResolvedValueOnce(null);
      await service.modifier(GESTIONNAIRE, 'm-1', { endAt: '2026-08-10T12:00:00Z' });
      const whereConflit = prisma.mission.findFirst.mock.calls[1][0].where;
      expect(whereConflit.id).toEqual({ not: 'm-1' });
    });

    it('deplace l\'evenement d\'agenda avec le creneau', async () => {
      // Sans cette mise a jour, le camion resterait immobilise sur l'ANCIEN creneau —
      // et libre sur le nouveau.
      prisma.mission.findFirst
        .mockResolvedValueOnce(missionEnBase(MissionStatus.PLANNED))
        .mockResolvedValueOnce(null);
      await service.modifier(GESTIONNAIRE, 'm-1', { endAt: '2026-08-10T12:00:00Z' });
      expect(prisma.vehicleEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ endAt: new Date('2026-08-10T12:00:00Z') }),
        }),
      );
    });

    it('ne touche PAS l\'agenda quand seules les notes changent', async () => {
      prisma.mission.findFirst.mockResolvedValueOnce(missionEnBase(MissionStatus.DONE));
      await service.modifier(GESTIONNAIRE, 'm-1', { notes: 'rien de structurel' });
      expect(prisma.vehicleEvent.updateMany).not.toHaveBeenCalled();
    });

    it('une modification vide ne fait rien', async () => {
      prisma.mission.findFirst.mockResolvedValueOnce(missionEnBase(MissionStatus.PLANNED));
      const r = await service.modifier(GESTIONNAIRE, 'm-1', {});
      expect(r.impactFenetre).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuse une mission hors flotte', async () => {
      prisma.mission.findFirst.mockResolvedValue(null);
      await expect(
        service.modifier(GESTIONNAIRE, 'm-x', { notes: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('l\'annulation', () => {
    beforeEach(() => {
      prisma.mission.findFirst.mockResolvedValue({
        id: 'm-1', ref: 'M-0001', status: MissionStatus.PLANNED,
      });
      prisma.mission.update = jest.fn().mockResolvedValue({});
      prisma.vehicleEvent.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    });

    it('exige un motif', async () => {
      // Sans motif, la mention « Annulee par le transporteur » que lit le depot serait
      // muette — et il rappellerait pour demander pourquoi.
      await expect(service.annuler(GESTIONNAIRE, 'm-1', '  ')).rejects.toThrow(/motif/i);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('LIBERE le vehicule en passant l\'evenement d\'agenda en CANCELLED', async () => {
      // Sans cette mise a jour, l'evenement resterait immobilisant et le camion
      // demeurerait inreservable jusqu'a la fin du creneau annule.
      await service.annuler(GESTIONNAIRE, 'm-1', 'client absent');
      expect(prisma.vehicleEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
    });

    it('conserve le motif sur la mission', async () => {
      await service.annuler(GESTIONNAIRE, 'm-1', 'client absent');
      expect(prisma.mission.update.mock.calls[0][0].data).toMatchObject({
        status: MissionStatus.CANCELLED,
        cancelReason: 'client absent',
      });
    });

    it('refuse une mission deja terminee', async () => {
      prisma.mission.findFirst.mockResolvedValue({ id: 'm-1', ref: 'M', status: MissionStatus.DONE });
      await expect(service.annuler(GESTIONNAIRE, 'm-1', 'trop tard')).rejects.toThrow(/déjà terminée/);
    });

    it('refuse une mission hors flotte', async () => {
      prisma.mission.findFirst.mockResolvedValue(null);
      await expect(service.annuler(GESTIONNAIRE, 'm-x', 'motif')).rejects.toBeInstanceOf(
        ForbiddenException,
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
