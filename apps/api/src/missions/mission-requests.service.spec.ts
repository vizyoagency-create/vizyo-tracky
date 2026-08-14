import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MissionRequestStatus, QuoteRoundAuthor, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { MissionPricingService } from './mission-pricing.service';
import { MissionRequestsService } from './mission-requests.service';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { MissionsService } from './missions.service';

/**
 * Espace depot, lot A6 — les demandes de mission et leur negociation.
 *
 * CE QUI EST PROTEGE ICI, dans l'ordre d'importance :
 *
 *   1. UNE DEMANDE N'EST PAS UNE MISSION. Aucun vehicule immobilise, aucun evenement
 *      d'agenda, aucun acces a une position. Si un jour ce service touche
 *      `vehicleEvent` ou `mission`, c'est ici que ca doit tomber.
 *   2. UN DEPOT NE VOIT QUE LES SIENNES. Verifie a chaque requete.
 *   3. LA NEGOCIATION A DEUX CAMPS. On ne repond pas a soi-meme, on n'accepte pas sa
 *      propre offre.
 */
describe('MissionRequestsService', () => {
  let service: MissionRequestsService;
  let prisma: {
    missionRequest: { create: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
    user: { findMany: jest.Mock };
    missionQuoteRound: { create: jest.Mock };
    missionStop: { deleteMany: jest.Mock; createMany: jest.Mock };
    missionPricingSettings: { findUnique: jest.Mock };
    vehicleEvent: { create: jest.Mock; updateMany: jest.Mock };
    mission: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let pricing: { tarifPour: jest.Mock };
  let missions: { creer: jest.Mock };

  const DEPOT = { id: 'depot-1', fleetId: 'f-1', role: UserRole.DEPOT } as AuthUser;
  const AUTRE_DEPOT = { id: 'depot-2', fleetId: 'f-1', role: UserRole.DEPOT } as AuthUser;
  const TRANSPORTEUR = { id: 'u-1', fleetId: 'f-1', role: UserRole.FLEET_MANAGER } as AuthUser;

  const demain = (h: number) => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString();
  };

  const ENTREE = {
    stops: [{ label: 'Entrepôt Toulouse' }, { label: 'Client Blagnac' }],
    wantedStartAt: demain(8),
    wantedEndAt: demain(11),
    declaredDistanceKm: 43,
  };

  const demandeEn = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'r-1',
    ref: 'D-0001',
    fleetId: 'f-1',
    depotUserId: 'depot-1',
    status: MissionRequestStatus.SUBMITTED,
    wantedStartAt: new Date(demain(8)),
    wantedEndAt: new Date(demain(11)),
    goodsDescription: null,
    weightKg: null,
    declaredDistanceM: 43_000,
    usedDistanceM: 43_000,
    agreedAmountCents: null,
    quoteExpiresAt: null,
    rejectedReason: null,
    missionId: null,
    createdAt: new Date(),
    stops: [
      { position: 0, kind: 'PICKUP', label: 'Entrepôt Toulouse', wantedAt: null, note: null },
      { position: 1, kind: 'DROPOFF', label: 'Client Blagnac', wantedAt: null, note: null },
    ],
    rounds: [
      {
        position: 0, author: QuoteRoundAuthor.SYSTEM, amountCents: 7900,
        breakdown: {}, message: null, createdAt: new Date(),
      },
    ],
    ...over,
  });

  beforeEach(async () => {
    prisma = {
      missionRequest: {
        create: jest.fn().mockResolvedValue(demandeEn()),
        findFirst: jest.fn().mockResolvedValue(demandeEn()),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue(demandeEn()),
        update: jest.fn().mockResolvedValue(demandeEn()),
      },
      missionQuoteRound: { create: jest.fn().mockResolvedValue({}) },
      missionStop: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) },
      missionPricingSettings: { findUnique: jest.fn().mockResolvedValue({ quoteValidityHours: 48 }) },
      // Presents UNIQUEMENT pour prouver qu'on n'y touche pas.
      vehicleEvent: { create: jest.fn(), updateMany: jest.fn() },
      mission: { create: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
    pricing = {
      tarifPour: jest.fn().mockResolvedValue({
        statut: 'TARIF', trancheLibelle: '0 à 50 km', distanceKm: 43,
        htCents: 7900, tvaCents: 1580, ttcCents: 9480,
        lignes: [{ libelle: 'Transport', montantCents: 7900 }],
      }),
    };

    // ⚠️ La conversion passe par le service des MISSIONS, jamais par un
    // `mission.create` maison : ses sept validations sont exactement celles qu'une
    // demande negociee doit encore franchir. L'espion sert a le prouver.
    missions = {
      creer: jest.fn().mockResolvedValue({
        mission: { id: 'm-9', ref: 'M-0042' },
        avertissements: [],
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MissionPricingService, useValue: pricing },
        { provide: MissionsService, useValue: missions },
        // Les notifications sont HORS transaction : un e-mail qui echoue ne doit pas
        // annuler une negociation deja ecrite. L'espion suffit ici.
        { provide: EmailService, useValue: { buildMissionQuoteEmail: jest.fn().mockReturnValue({ subject: 's', html: 'h', text: 't' }), send: jest.fn().mockResolvedValue({ ok: true }) } },
        { provide: ConfigService, useValue: { get: () => 'https://app.exemple.fr' } },
      ],
    }).compile();
    service = moduleRef.get(MissionRequestsService);
  });

  // ═══ L'INVARIANT CENTRAL ═════════════════════════════════════════════════════

  describe('une demande n\'est PAS une mission', () => {
    it('n\'immobilise aucun véhicule et ne pose aucun événement d\'agenda', async () => {
      await service.creer(DEPOT, ENTREE);
      expect(prisma.vehicleEvent.create).not.toHaveBeenCalled();
      expect(prisma.vehicleEvent.updateMany).not.toHaveBeenCalled();
    });

    it('ne crée aucune mission', async () => {
      await service.creer(DEPOT, ENTREE);
      expect(prisma.mission.create).not.toHaveBeenCalled();
    });
  });

  // ═══ LE DEVIS DÈS LA DEMANDE (arbitrage D) ═══════════════════════════════════

  describe('le devis, dès la demande', () => {
    it('écrit un tour 0 automatique, auteur SYSTEM', async () => {
      await service.creer(DEPOT, ENTREE);
      const tour = prisma.missionQuoteRound.create.mock.calls[0][0].data;
      expect(tour.position).toBe(0);
      expect(tour.author).toBe(QuoteRoundAuthor.SYSTEM);
      expect(tour.amountCents).toBe(7900);
    });

    it('fige le détail du calcul dans le tour', async () => {
      // Une grille modifiée demain ne doit pas réécrire une offre déjà lue.
      await service.creer(DEPOT, ENTREE);
      const tour = prisma.missionQuoteRound.create.mock.calls[0][0].data;
      expect(tour.breakdown).toMatchObject({ statut: 'TARIF', htCents: 7900 });
    });

    it('fige aussi les CONDITIONS — accepter, c\'est accepter une version précise', async () => {
      await service.creer(DEPOT, ENTREE);
      const tour = prisma.missionQuoteRound.create.mock.calls[0][0].data;
      expect(tour.terms).toMatchObject({ usedDistanceKm: 43 });
      expect(tour.terms.stops).toHaveLength(2);
    });

    it('« sur devis » écrit un tour SANS montant, pas un tour à zéro', async () => {
      pricing.tarifPour.mockResolvedValue({
        statut: 'SUR_DEVIS', distanceKm: 500, motif: 'Au-delà de 401 km…',
      });
      await service.creer(DEPOT, { ...ENTREE, declaredDistanceKm: 500 });
      const tour = prisma.missionQuoteRound.create.mock.calls[0][0].data;
      expect(tour.amountCents).toBeNull();
      expect(tour.amountCents).not.toBe(0);
    });

    it('REFUSE la demande quand le transporteur n\'a pas de grille (arbitrage J)', async () => {
      // Sans tarif, il n'y a rien à présenter au dépôt : on refuse ici plutôt que de
      // le laisser saisir dix adresses pour rien.
      pricing.tarifPour.mockResolvedValue({ statut: 'PAS_DE_GRILLE', motif: 'aucune grille' });
      await expect(service.creer(DEPOT, ENTREE)).rejects.toThrow(/tarifs/);
      expect(prisma.missionRequest.create).not.toHaveBeenCalled();
    });
  });

  // ═══ LES ARRÊTS (arbitrages A, B, H) ═════════════════════════════════════════

  describe('les arrêts', () => {
    it('le premier est le CHARGEMENT, les suivants des livraisons', async () => {
      await service.creer(DEPOT, {
        ...ENTREE,
        stops: [{ label: 'Dépôt' }, { label: 'Client A' }, { label: 'Client B' }],
      });
      const arrets = prisma.missionRequest.create.mock.calls[0][0].data.stops.create;
      expect(arrets[0].kind).toBe('PICKUP');
      expect(arrets[1].kind).toBe('DROPOFF');
      expect(arrets[2].kind).toBe('DROPOFF');
    });

    it('accepte autant de livraisons qu\'on veut — pas de maximum', async () => {
      const stops = [{ label: 'Dépôt' }, ...Array.from({ length: 12 }, (_, i) => ({ label: `Client ${i}` }))];
      await expect(service.creer(DEPOT, { ...ENTREE, stops })).resolves.toBeDefined();
    });

    it('n\'ajoute JAMAIS un retour d\'office (arbitrage H)', async () => {
      // Le retour est une livraison comme une autre : si le dépôt ne l'ajoute pas,
      // il n'existe pas — et il n'est donc pas facturé.
      await service.creer(DEPOT, ENTREE);
      const arrets = prisma.missionRequest.create.mock.calls[0][0].data.stops.create;
      expect(arrets).toHaveLength(2);
    });

    it('refuse une demande sans livraison', async () => {
      await expect(
        service.creer(DEPOT, { ...ENTREE, stops: [{ label: 'Dépôt' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse une adresse vide', async () => {
      await expect(
        service.creer(DEPOT, { ...ENTREE, stops: [{ label: 'Dépôt' }, { label: '  ' }] }),
      ).rejects.toThrow(/libellé/);
    });
  });

  // ═══ ISOLATION ═══════════════════════════════════════════════════════════════

  describe('un dépôt ne voit que les siennes', () => {
    it('borne la liste sur SON identifiant, jamais sur la flotte', async () => {
      await service.lister(DEPOT);
      expect(prisma.missionRequest.findMany.mock.calls[0][0].where).toMatchObject({
        depotUserId: 'depot-1',
      });
    });

    it('le transporteur, lui, voit toute sa société', async () => {
      await service.lister(TRANSPORTEUR);
      const where = prisma.missionRequest.findMany.mock.calls[0][0].where;
      expect(where.fleetId).toBe('f-1');
      expect(where.depotUserId).toBeUndefined();
    });

    it('un dépôt qui ouvre la demande d\'un autre reçoit « introuvable »', async () => {
      // Le même message que pour une demande inexistante : distinguer les deux
      // permettrait de sonder l'existence d'une demande par son identifiant.
      prisma.missionRequest.findFirst.mockResolvedValue(null);
      await expect(service.detailPour(AUTRE_DEPOT, 'r-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('la lecture d\'un dépôt porte SON identifiant dans le where', async () => {
      await service.detailPour(DEPOT, 'r-1');
      expect(prisma.missionRequest.findFirst.mock.calls[0][0].where).toMatchObject({
        depotUserId: 'depot-1',
      });
    });
  });

  // ═══ LA NÉGOCIATION A DEUX CAMPS ═════════════════════════════════════════════

  describe('la négociation', () => {
    it('le dépôt ne peut pas enchaîner deux offres', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({
          rounds: [{ position: 0, author: QuoteRoundAuthor.DEPOT, amountCents: 7000, breakdown: {}, message: null, createdAt: new Date() }],
        }),
      );
      await expect(service.contreProposer(DEPOT, 'r-1', { amountCents: 6500 })).rejects.toThrow(
        /déjà la main/,
      );
    });

    it('le transporteur répond après le dépôt', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({
          rounds: [{ position: 0, author: QuoteRoundAuthor.DEPOT, amountCents: 7000, breakdown: {}, message: null, createdAt: new Date() }],
        }),
      );
      await service.contreProposer(TRANSPORTEUR, 'r-1', { amountCents: 7500 });
      const tour = prisma.missionQuoteRound.create.mock.calls[0][0].data;
      expect(tour.author).toBe(QuoteRoundAuthor.CARRIER);
      expect(tour.amountCents).toBe(7500);
    });

    it('un tour porte ses CONDITIONS, même quand elles ne changent pas', async () => {
      await service.contreProposer(TRANSPORTEUR, 'r-1', { amountCents: 8000 });
      const tour = prisma.missionQuoteRound.create.mock.calls[0][0].data;
      expect(tour.terms).toHaveProperty('stops');
      expect(tour.terms).toHaveProperty('wantedStartAt');
    });

    it('recalcule le prix quand la distance change, mais laisse ajuster', async () => {
      // Arbitrage I : le système repropose, l'humain garde la main.
      pricing.tarifPour.mockResolvedValue({
        statut: 'TARIF', trancheLibelle: '51 à 100 km', distanceKm: 87,
        htCents: 16900, tvaCents: 3380, ttcCents: 20280, lignes: [],
      });
      await service.contreProposer(TRANSPORTEUR, 'r-1', { usedDistanceKm: 87 });
      expect(prisma.missionQuoteRound.create.mock.calls[0][0].data.amountCents).toBe(16900);

      prisma.missionQuoteRound.create.mockClear();
      await service.contreProposer(TRANSPORTEUR, 'r-1', { usedDistanceKm: 87, amountCents: 15000 });
      expect(prisma.missionQuoteRound.create.mock.calls[0][0].data.amountCents).toBe(15000);
    });

    it('remplace les arrêts quand ils changent', async () => {
      await service.contreProposer(TRANSPORTEUR, 'r-1', {
        stops: [{ label: 'Dépôt' }, { label: 'Autre client' }],
      });
      expect(prisma.missionStop.deleteMany).toHaveBeenCalledWith({ where: { requestId: 'r-1' } });
      expect(prisma.missionStop.createMany).toHaveBeenCalled();
    });

    it('refuse un montant négatif', async () => {
      await expect(
        service.contreProposer(TRANSPORTEUR, 'r-1', { amountCents: -100 }),
      ).rejects.toThrow(/négatif/);
    });
  });

  describe('accepter', () => {
    it('le transporteur accepte l\'offre du système', async () => {
      await service.accepter(TRANSPORTEUR, 'r-1');
      expect(prisma.missionRequest.update.mock.calls[0][0].data).toMatchObject({
        status: MissionRequestStatus.ACCEPTED,
        agreedAmountCents: 7900,
      });
    });

    it('on N\'ACCEPTE PAS sa propre offre — un accord a deux signatures', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({
          rounds: [{ position: 0, author: QuoteRoundAuthor.CARRIER, amountCents: 8000, breakdown: {}, message: null, createdAt: new Date() }],
        }),
      );
      await expect(service.accepter(TRANSPORTEUR, 'r-1')).rejects.toThrow(/votre propre/);
    });

    it('on n\'accepte pas une offre « sur devis » — il n\'y a rien à accepter', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({
          rounds: [{ position: 0, author: QuoteRoundAuthor.SYSTEM, amountCents: null, breakdown: {}, message: null, createdAt: new Date() }],
        }),
      );
      await expect(service.accepter(TRANSPORTEUR, 'r-1')).rejects.toThrow(/sur devis/);
    });

    it('une demande déjà acceptée ne se renégocie plus', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({ status: MissionRequestStatus.ACCEPTED }),
      );
      await expect(service.contreProposer(DEPOT, 'r-1', { amountCents: 1 })).rejects.toThrow(
        /ne se négocie plus/,
      );
    });
  });

  describe('refuser', () => {
    it('exige un motif — sans lui, l\'autre partie repose la même demande', async () => {
      await expect(service.refuser(TRANSPORTEUR, 'r-1', '')).rejects.toThrow(/motif/);
      await expect(service.refuser(TRANSPORTEUR, 'r-1', 'ok')).rejects.toThrow(/motif/);
    });

    it('enregistre le motif et le camp qui refuse', async () => {
      await service.refuser(TRANSPORTEUR, 'r-1', 'Aucun camion disponible ce jour-là.');
      expect(prisma.missionRequest.update.mock.calls[0][0].data).toMatchObject({
        status: MissionRequestStatus.REJECTED,
        rejectedBy: QuoteRoundAuthor.CARRIER,
      });
    });
  });

  // ═══ AFFECTATION ET CONVERSION (T7) ══════════════════════════════════════════

  describe('affecter — c\'est ici que l\'exploitation commence', () => {
    const ACCEPTEE = () => demandeEn({ status: MissionRequestStatus.ACCEPTED, agreedAmountCents: 7900 });

    it('passe par MissionsService.creer, jamais par un mission.create maison', async () => {
      // Ses sept validations sont exactement celles qu'une demande négociée doit
      // encore franchir : le camion choisi peut avoir été pris entre-temps.
      prisma.missionRequest.findFirst.mockResolvedValue(ACCEPTEE());
      await service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1', driverId: 'd-1' });
      expect(missions.creer).toHaveBeenCalled();
      expect(prisma.mission.create).not.toHaveBeenCalled();
    });

    it('compose les deux libellés depuis le PREMIER et le DERNIER arrêt', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({
          status: MissionRequestStatus.ACCEPTED,
          stops: [
            { position: 0, kind: 'PICKUP', label: 'Entrepôt', wantedAt: null, note: null },
            { position: 1, kind: 'DROPOFF', label: 'Client A', wantedAt: null, note: null },
            { position: 2, kind: 'DROPOFF', label: 'Client B', wantedAt: null, note: null },
          ],
        }),
      );
      await service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1' });
      expect(missions.creer.mock.calls[0][1]).toMatchObject({
        originLabel: 'Entrepôt',
        destLabel: 'Client B',
      });
    });

    it('COPIE les arrêts sur la mission — la demande garde les siens', async () => {
      // Les déplacer rendrait l'historique de négociation illisible : on ne saurait
      // plus sur quel trajet les parties se sont accordées.
      prisma.missionRequest.findFirst.mockResolvedValue(ACCEPTEE());
      await service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1' });
      const copies = prisma.missionStop.createMany.mock.calls[0][0].data;
      expect(copies).toHaveLength(2);
      expect(copies[0].missionId).toBe('m-9');
      expect(prisma.missionStop.deleteMany).not.toHaveBeenCalled();
    });

    it('marque la demande CONVERTED et la relie à sa mission', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(ACCEPTEE());
      await service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1' });
      expect(prisma.missionRequest.update.mock.calls[0][0].data).toMatchObject({
        status: MissionRequestStatus.CONVERTED,
        missionId: 'm-9',
      });
    });

    it('un DÉPÔT ne peut pas affecter — ce n\'est pas son parc', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(ACCEPTEE());
      await expect(
        service.affecter(DEPOT, 'r-1', { vehicleId: 'v-1' }),
      ).rejects.toThrow(/transporteur/);
      expect(missions.creer).not.toHaveBeenCalled();
    });

    it('refuse d\'affecter une demande non acceptée', async () => {
      // Tant que les deux parties ne se sont pas accordées, rien ne doit exister
      // côté exploitation.
      prisma.missionRequest.findFirst.mockResolvedValue(demandeEn({ status: MissionRequestStatus.NEGOTIATING }));
      await expect(service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1' })).rejects.toThrow(
        /accordées/,
      );
      expect(missions.creer).not.toHaveBeenCalled();
    });

    it('refuse une deuxième conversion', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(
        demandeEn({ status: MissionRequestStatus.ACCEPTED, missionId: 'm-1' }),
      );
      await expect(service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1' })).rejects.toThrow(
        /déjà donné lieu/,
      );
    });

    it('exige un véhicule', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(ACCEPTEE());
      await expect(
        service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: '' }),
      ).rejects.toThrow(/véhicule/);
    });

    it('transmet le dépôt destinataire à la mission — c\'est lui qui verra le camion', async () => {
      prisma.missionRequest.findFirst.mockResolvedValue(ACCEPTEE());
      await service.affecter(TRANSPORTEUR, 'r-1', { vehicleId: 'v-1' });
      expect(missions.creer.mock.calls[0][1]).toMatchObject({ depotUserId: 'depot-1' });
    });
  });

  // ═══ LE DTO ══════════════════════════════════════════════════════════════════

  describe('ce que l\'écran reçoit', () => {
    it('le montant courant est le DERNIER tour', async () => {
      prisma.missionRequest.findUniqueOrThrow.mockResolvedValue(
        demandeEn({
          rounds: [
            { position: 0, author: QuoteRoundAuthor.SYSTEM, amountCents: 7900, breakdown: {}, message: null, createdAt: new Date() },
            { position: 1, author: QuoteRoundAuthor.DEPOT, amountCents: 7000, breakdown: {}, message: null, createdAt: new Date() },
          ],
        }),
      );
      const dto = await service.detailComplet('r-1');
      expect(dto.currentAmountCents).toBe(7000);
    });

    it('dit QUI doit répondre', async () => {
      prisma.missionRequest.findUniqueOrThrow.mockResolvedValue(
        demandeEn({
          rounds: [{ position: 0, author: QuoteRoundAuthor.DEPOT, amountCents: 7000, breakdown: {}, message: null, createdAt: new Date() }],
        }),
      );
      expect((await service.detailComplet('r-1')).awaiting).toBe('CARRIER');
    });

    it('rend les distances en kilomètres — les mètres restent en base', async () => {
      const dto = await service.detailComplet('r-1');
      expect(dto.declaredDistanceKm).toBe(43);
    });
  });
});
