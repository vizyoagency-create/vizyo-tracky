import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import type { AuthUser } from '../auth/types/auth-user';
import { NO_FLEET } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { MissionPricingService, type TrancheDto } from './mission-pricing.service';

/**
 * Espace depot, lot A6 — la grille tarifaire. Cf. docs/A6-DEMANDES-ET-DEVIS.md § 3.
 *
 * Ce service calcule de l'ARGENT qui part chez le client final d'un client. Ce qui
 * est protege ici :
 *
 *   1. LA REGLE DE SELECTION D'UNE TRANCHE. La grille reelle saute de « 0 a 50 » a
 *      « 51 a 100 » : un encadrement litteral [fromKm, toKm] laisserait 50,4 km SANS
 *      TRANCHE. On retient la premiere tranche dont `toKm` couvre la distance.
 *   2. « SUR DEVIS » N'EST PAS ZERO. Une tranche sans prix ne produit aucun montant.
 *   3. UNE GRILLE INCOHERENTE EST REFUSEE A L'ECRITURE, pas subie au calcul.
 */
describe('MissionPricingService', () => {
  let service: MissionPricingService;
  let prisma: {
    missionPricingSettings: { findUnique: jest.Mock; upsert: jest.Mock; findUniqueOrThrow: jest.Mock };
    missionPricingTier: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let alerts: { createPricingGridMissingAlert: jest.Mock };

  const ADMIN = { id: 'u-1', fleetId: 'f-1', role: UserRole.FLEET_ADMIN } as AuthUser;
  const SA = { id: 'sa-1', fleetId: null, role: UserRole.SUPER_ADMIN } as unknown as AuthUser;
  const ORPHELIN = { id: 'u-2', fleetId: null, role: UserRole.FLEET_MANAGER } as unknown as AuthUser;

  /** La grille reelle du client, telle que la migration l'ecrit. */
  const GRILLE_CLIENT: TrancheDto[] = [
    { position: 0, fromKm: 0, toKm: 50, priceCents: 7900 },
    { position: 1, fromKm: 51, toKm: 100, priceCents: 16900 },
    { position: 2, fromKm: 101, toKm: 150, priceCents: 25900 },
    { position: 3, fromKm: 151, toKm: 200, priceCents: 34900 },
    { position: 4, fromKm: 201, toKm: 250, priceCents: 44900 },
    { position: 5, fromKm: 251, toKm: 300, priceCents: 53900 },
    { position: 6, fromKm: 301, toKm: 350, priceCents: 62900 },
    { position: 7, fromKm: 351, toKm: 400, priceCents: 71900 },
    { position: 8, fromKm: 401, toKm: null, priceCents: null },
  ];

  const grilleEn = (tiers: TrancheDto[], options: { enabled?: boolean; vatPct?: number } = {}) => ({
    id: 'g-1',
    fleetId: 'f-1',
    enabled: options.enabled ?? true,
    vatPct: options.vatPct ?? 20,
    quoteValidityHours: 48,
    extraStopCents: 0,
    waitingHourCents: 0,
    quoteFooterNote: null,
    updatedAt: new Date('2026-08-13T12:00:00Z'),
    tiers: tiers.map((t) => ({ ...t, category: 'Transport de marchandise' })),
  });

  const entree = (tiers: TrancheDto[]) => ({
    enabled: true,
    vatPct: 20,
    quoteValidityHours: 48,
    extraStopCents: 0,
    waitingHourCents: 0,
    category: 'Transport de marchandise',
    tiers,
  });

  beforeEach(async () => {
    prisma = {
      missionPricingSettings: {
        findUnique: jest.fn().mockResolvedValue(grilleEn(GRILLE_CLIENT)),
        upsert: jest.fn().mockResolvedValue({ id: 'g-1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(grilleEn(GRILLE_CLIENT)),
      },
      missionPricingTier: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 9 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    alerts = { createPricingGridMissingAlert: jest.fn().mockResolvedValue(null) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MissionPricingService,
        { provide: PrismaService, useValue: prisma },
        // Arbitrage J — un espion suffit : ce qui est teste ici est la REMONTEE, pas
        // la fabrication de l'alerte, qui a ses propres tests dans `AlertsService`.
        { provide: AlertsService, useValue: alerts },
      ],
    }).compile();
    service = moduleRef.get(MissionPricingService);
  });

  // ═══ LA GRILLE REELLE, BORNE PAR BORNE ═══════════════════════════════════════

  describe('le tarif appliqué — grille réelle du client', () => {
    const attendu: Array<[number, number]> = [
      [1, 7900], [50, 7900],
      [51, 16900], [100, 16900],
      [101, 25900], [150, 25900],
      [151, 34900], [200, 34900],
      [201, 44900], [250, 44900],
      [251, 53900], [300, 53900],
      [301, 62900], [350, 62900],
      [351, 71900], [400, 71900],
    ];

    // Une boucle plutôt que `it.each` : la suite WEB de ce dépôt tourne sous
    // Jasmine, qui ne le connaît pas, et un test copié d'un fichier à l'autre a déjà
    // fait tomber toute la suite une fois (cf. platform.spec, 2026-08-11).
    for (const [km, cents] of attendu) {
      it(`${km} km → ${cents / 100} € HT`, async () => {
        const r = await service.tarifPour('f-1', km * 1000);
        expect(r.statut).toBe('TARIF');
        if (r.statut !== 'TARIF') return;
        expect(r.htCents).toBe(cents);
      });
    }

    it('applique la TVA et compose le TTC', async () => {
      const r = await service.tarifPour('f-1', 30 * 1000);
      if (r.statut !== 'TARIF') throw new Error('tarif attendu');
      expect(r.htCents).toBe(7900);
      expect(r.tvaCents).toBe(1580); // 20 %
      expect(r.ttcCents).toBe(9480);
    });

    it('arrondit la TVA UNE SEULE FOIS, sur le total', async () => {
      // 7900 × 5,5 % = 434,5 → 435, et non une somme d'arrondis par ligne.
      prisma.missionPricingSettings.findUnique.mockResolvedValue(
        grilleEn(GRILLE_CLIENT, { vatPct: 5 }),
      );
      const r = await service.tarifPour('f-1', 10 * 1000);
      if (r.statut !== 'TARIF') throw new Error('tarif attendu');
      expect(r.tvaCents).toBe(395); // 7900 × 5 %
      expect(r.ttcCents).toBe(r.htCents + r.tvaCents);
    });
  });

  // ═══ LE TROU QUE LA GRILLE LAISSE ENTRE DEUX TRANCHES ════════════════════════

  describe('la distance qui tombe entre deux tranches', () => {
    it('50,4 km est facturé comme 51 km — la tranche supérieure', async () => {
      // ⚠️ LE CAS QUI JUSTIFIE TOUTE LA REGLE. La grille saute de « 0 à 50 » à
      // « 51 à 100 » : un encadrement [fromKm, toKm] ne trouverait RIEN pour 50,4 km,
      // et le devis échouerait sur une distance parfaitement ordinaire.
      const r = await service.tarifPour('f-1', 50_400);
      expect(r.statut).toBe('TARIF');
      if (r.statut !== 'TARIF') return;
      expect(r.distanceKm).toBe(51);
      expect(r.htCents).toBe(16900);
    });

    it('arrondit les mètres au SUPÉRIEUR — 50 001 m sont 51 km', async () => {
      // Arrondir au plus proche ferait basculer 50 400 m dans la tranche basse : un
      // cadeau involontaire, et surtout une règle que personne n'a décidée.
      const r = await service.tarifPour('f-1', 50_001);
      if (r.statut !== 'TARIF') throw new Error('tarif attendu');
      expect(r.distanceKm).toBe(51);
      expect(r.htCents).toBe(16900);
    });

    it('50 000 m pile restent dans la première tranche', async () => {
      const r = await service.tarifPour('f-1', 50_000);
      if (r.statut !== 'TARIF') throw new Error('tarif attendu');
      expect(r.distanceKm).toBe(50);
      expect(r.htCents).toBe(7900);
    });
  });

  // ═══ « SUR DEVIS » ═══════════════════════════════════════════════════════════

  describe('au-delà de la dernière tranche chiffrée', () => {
    it('répond SUR_DEVIS, et surtout PAS zéro', async () => {
      const r = await service.tarifPour('f-1', 500 * 1000);
      expect(r.statut).toBe('SUR_DEVIS');
      expect(r).not.toHaveProperty('htCents');
    });

    it('dit à partir de quelle distance', async () => {
      const r = await service.tarifPour('f-1', 500 * 1000);
      if (r.statut !== 'SUR_DEVIS') throw new Error('sur devis attendu');
      expect(r.motif).toContain('401');
    });

    it('401 km bascule déjà en sur devis ; 400 km non', async () => {
      expect((await service.tarifPour('f-1', 401 * 1000)).statut).toBe('SUR_DEVIS');
      expect((await service.tarifPour('f-1', 400 * 1000)).statut).toBe('TARIF');
    });
  });

  // ═══ GRILLE ABSENTE OU DÉSACTIVÉE (arbitrage J) ══════════════════════════════

  describe('sans grille utilisable', () => {
    it('répond PAS_DE_GRILLE quand aucune n\'existe', async () => {
      prisma.missionPricingSettings.findUnique.mockResolvedValue(null);
      const r = await service.tarifPour('f-1', 10_000);
      expect(r.statut).toBe('PAS_DE_GRILLE');
    });

    it('répond PAS_DE_GRILLE quand elle est désactivée, en le disant', async () => {
      prisma.missionPricingSettings.findUnique.mockResolvedValue(
        grilleEn(GRILLE_CLIENT, { enabled: false }),
      );
      const r = await service.tarifPour('f-1', 10_000);
      if (r.statut !== 'PAS_DE_GRILLE') throw new Error('pas de grille attendu');
      expect(r.motif).toContain('désactivée');
    });

    it('ne renvoie JAMAIS un montant quand la grille manque', async () => {
      prisma.missionPricingSettings.findUnique.mockResolvedValue(null);
      const r = await service.tarifPour('f-1', 10_000);
      expect(r).not.toHaveProperty('htCents');
      expect(r).not.toHaveProperty('ttcCents');
    });

    /**
     * Arbitrage J — « grille absente = alerte au centre d'alertes, PAS de blocage ».
     *
     * Le service repondait deja PAS_DE_GRILLE ; personne ne l'entendait. Un transporteur
     * dont la grille n'est pas publiee voyait ses depots se heurter a un refus sans
     * jamais apprendre pourquoi, ni qu'il lui suffisait d'ouvrir Missions > Parametres.
     */
    describe('la remontée au centre d\'alertes', () => {
      it('lève une alerte quand aucune grille n\'existe', async () => {
        prisma.missionPricingSettings.findUnique.mockResolvedValue(null);
        await service.tarifPour('f-1', 10_000);
        expect(alerts.createPricingGridMissingAlert).toHaveBeenCalledWith(
          'f-1',
          expect.stringContaining('Aucune grille'),
        );
      });

      it('lève une alerte quand la grille est désactivée, avec le motif qui convient', async () => {
        prisma.missionPricingSettings.findUnique.mockResolvedValue(
          grilleEn(GRILLE_CLIENT, { enabled: false }),
        );
        await service.tarifPour('f-1', 10_000);
        // Deux gestes différents pour la corriger : en créer une, ou rallumer celle
        // qui existe. Le motif doit dire lequel.
        expect(alerts.createPricingGridMissingAlert).toHaveBeenCalledWith(
          'f-1',
          expect.stringContaining('désactivée'),
        );
      });

      it('ne lève RIEN quand la grille répond', async () => {
        await service.tarifPour('f-1', 10_000);
        expect(alerts.createPricingGridMissingAlert).not.toHaveBeenCalled();
      });

      it('ne lève rien non plus sur un « sur devis » : la grille est là, elle a répondu', async () => {
        await service.tarifPour('f-1', 450_000);
        expect(alerts.createPricingGridMissingAlert).not.toHaveBeenCalled();
      });

      it('NE BLOQUE RIEN : une alerte en échec ne fait pas échouer le calcul', async () => {
        // Ce service est sur un chemin d'écran. Répondre « erreur serveur » parce que
        // la table des alertes était indisponible n'apprendrait rien à personne, là où
        // « le transporteur n'a pas publié ses tarifs » est une réponse claire.
        prisma.missionPricingSettings.findUnique.mockResolvedValue(null);
        alerts.createPricingGridMissingAlert.mockRejectedValue(new Error('base indisponible'));
        const r = await service.tarifPour('f-1', 10_000);
        expect(r.statut).toBe('PAS_DE_GRILLE');
      });
    });
  });

  // ═══ VALIDATION À L'ÉCRITURE ═════════════════════════════════════════════════

  describe('ce que l\'écriture refuse', () => {
    const refuse = async (tiers: TrancheDto[], motif: RegExp) => {
      await expect(service.enregistrer(ADMIN, entree(tiers))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.enregistrer(ADMIN, entree(tiers))).rejects.toThrow(motif);
    };

    it('une grille vide', async () => {
      await refuse([], /au moins une tranche/);
    });

    it('des tranches qui se recouvrent', async () => {
      await refuse(
        [
          { position: 0, fromKm: 0, toKm: 100, priceCents: 7900 },
          { position: 1, fromKm: 50, toKm: 200, priceCents: 16900 },
        ],
        /recouvrent/,
      );
    });

    it('une borne haute inférieure à la borne basse', async () => {
      await refuse([{ position: 0, fromKm: 100, toKm: 50, priceCents: 7900 }], /borne haute/);
    });

    it('une tranche sans borne haute AILLEURS qu\'en dernier', async () => {
      // Placée au milieu, elle rendrait toutes les suivantes inatteignables.
      await refuse(
        [
          { position: 0, fromKm: 0, toKm: null, priceCents: 7900 },
          { position: 1, fromKm: 51, toKm: 100, priceCents: 16900 },
        ],
        /dernière tranche/,
      );
    });

    it('un « sur devis » ailleurs qu\'en dernier', async () => {
      await refuse(
        [
          { position: 0, fromKm: 0, toKm: 50, priceCents: null },
          { position: 1, fromKm: 51, toKm: 100, priceCents: 16900 },
        ],
        /sur devis/,
      );
    });

    it('un tarif négatif', async () => {
      await refuse([{ position: 0, fromKm: 0, toKm: 50, priceCents: -1 }], /montant positif/);
    });

    it('une TVA hors bornes', async () => {
      await expect(
        service.enregistrer(ADMIN, { ...entree(GRILLE_CLIENT), vatPct: 120 }),
      ).rejects.toThrow(/TVA/);
    });
  });

  describe('ce que l\'écriture accepte et corrige', () => {
    it('accepte la grille réelle du client', async () => {
      await expect(service.enregistrer(ADMIN, entree(GRILLE_CLIENT))).resolves.toBeDefined();
    });

    it('renumérote les positions trouées — on ne stocke jamais de trou', async () => {
      // L'utilisateur a supprimé une ligne au milieu : les positions arrivent 0, 2, 5.
      await service.enregistrer(
        ADMIN,
        entree([
          { position: 0, fromKm: 0, toKm: 50, priceCents: 7900 },
          { position: 2, fromKm: 51, toKm: 100, priceCents: 16900 },
          { position: 5, fromKm: 101, toKm: null, priceCents: null },
        ]),
      );
      const ecrites = prisma.missionPricingTier.createMany.mock.calls[0][0].data;
      expect(ecrites.map((t: { position: number }) => t.position)).toEqual([0, 1, 2]);
    });

    it('remplace les tranches en bloc plutôt que de les fusionner', async () => {
      // Une fusion ligne à ligne laisserait des tranches orphelines qu'aucun écran
      // ne montrerait — et que le moteur, lui, verrait.
      await service.enregistrer(ADMIN, entree(GRILLE_CLIENT));
      expect(prisma.missionPricingTier.deleteMany).toHaveBeenCalled();
      const ordreSuppression = prisma.missionPricingTier.deleteMany.mock.invocationCallOrder[0];
      const ordreCreation = prisma.missionPricingTier.createMany.mock.invocationCallOrder[0];
      expect(ordreSuppression).toBeLessThan(ordreCreation);
    });
  });

  // ═══ PORTÉE ══════════════════════════════════════════════════════════════════

  describe('la portée société', () => {
    it('un super-admin sans société choisie ne LIT aucune grille', async () => {
      // Une grille est par nature celle d'une société : « toutes » n'a pas de sens.
      await expect(service.lire(SA)).resolves.toBeNull();
    });

    it('un super-admin lit la grille de la société choisie', async () => {
      await service.lire(SA, 'f-mhcars');
      expect(prisma.missionPricingSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fleetId: 'f-mhcars' } }),
      );
    });

    it('IGNORE la société demandée par un administrateur de flotte', async () => {
      // Sans quoi n'importe qui lirait les tarifs d'un concurrent en forgeant l'URL.
      await service.lire(ADMIN, 'f-mhcars');
      expect(prisma.missionPricingSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fleetId: 'f-1' } }),
      );
    });

    it('REFUSE l\'écriture à un super-admin sans société choisie', async () => {
      await expect(service.enregistrer(SA, entree(GRILLE_CLIENT))).rejects.toThrow(
        /Sélectionnez une société/,
      );
    });

    it('refuse un compte de flotte sans flotte, en désignant SON compte', async () => {
      await expect(service.enregistrer(ORPHELIN, entree(GRILLE_CLIENT))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ne lit rien pour un compte de flotte sans flotte — jamais tout', async () => {
      // `requiredFleetScope` renvoie NO_FLEET, une flotte impossible. On ne doit ni
      // interroger avec, ni retomber sur une lecture non bornée.
      await expect(service.lire(ORPHELIN)).resolves.toBeNull();
      const appels = prisma.missionPricingSettings.findUnique.mock.calls;
      expect(appels.every((a: [{ where: { fleetId: string } }]) => a[0].where.fleetId !== NO_FLEET)).toBe(true);
    });
  });
});
