import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AlertSeverity as PrismaAlertSeverity, UserRole } from '@prisma/client';
import type { AlertSeverity, AlertType } from '@vizyo/tracky-shared';
import { DEFAULT_MUTED_TYPES, shouldPushAlert } from '@vizyo/tracky-shared';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationPreferencesService,
  isPushRoleEligible,
  normalizeSeverity,
  toPrismaSeverity,
  toSharedSeverity,
} from './notification-preferences.service';
import { NotificationsController } from './notifications.controller';

/**
 * Preferences push — le lot « API ».
 *
 * Ces tests cadrent le bug reel : 582 alertes en 7 jours, zero push. La cause decisive
 * etait que les quatre SUPER_ADMIN de production, sans ligne de preference et sans
 * fleetId, ne pouvaient JAMAIS etre destinataires. On verifie donc en priorite le cas
 * qui etait casse (push tente pour un SUPER_ADMIN sans reglage), puis les trois portes
 * qui doivent rester fermees : preference coupee, seuil de severite, perimetre de
 * deploiement.
 */
describe('NotificationPreferencesService', () => {
  let service: NotificationPreferencesService;
  let prefFindUnique: jest.Mock;
  let prefFindMany: jest.Mock;
  let prefUpsert: jest.Mock;
  let subCount: jest.Mock;
  let rollout: string;

  /** Ligne de preference telle que Prisma la rend : severite en MAJUSCULES. */
  const row = (over: Partial<{
    userId: string;
    pushEnabled: boolean;
    minSeverity: PrismaAlertSeverity;
    mutedTypes: string[];
  }> = {}) => ({
    id: 'p1',
    userId: 'u1',
    pushEnabled: true,
    minSeverity: PrismaAlertSeverity.CRITICAL,
    mutedTypes: [] as string[],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    rollout = 'SUPER_ADMIN_ONLY';
    prefFindUnique = jest.fn().mockResolvedValue(null);
    prefFindMany = jest.fn().mockResolvedValue([]);
    prefUpsert = jest.fn().mockResolvedValue(row());
    subCount = jest.fn().mockResolvedValue(0);

    const prisma = {
      notificationPreference: {
        findUnique: prefFindUnique,
        findMany: prefFindMany,
        upsert: prefUpsert,
      },
      pushSubscription: { count: subCount },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationPreferencesService,
        { provide: PrismaService, useValue: prisma },
        // La valeur est relue a chaque appel : un test peut donc basculer le perimetre
        // en cours de route, comme le ferait un redemarrage avec un .env modifie.
        { provide: ConfigService, useValue: { get: () => rollout } },
      ],
    }).compile();
    service = moduleRef.get(NotificationPreferencesService);
  });

  // ─── La frontiere de types (MAJUSCULES en base / minuscules cote contrat) ───

  describe('conversion de severite aux frontieres', () => {
    it('convertit dans les deux sens sans perte', () => {
      expect(toSharedSeverity(PrismaAlertSeverity.INFO)).toBe('info');
      expect(toSharedSeverity(PrismaAlertSeverity.WARNING)).toBe('warning');
      expect(toSharedSeverity(PrismaAlertSeverity.CRITICAL)).toBe('critical');

      expect(toPrismaSeverity('info')).toBe(PrismaAlertSeverity.INFO);
      expect(toPrismaSeverity('warning')).toBe(PrismaAlertSeverity.WARNING);
      expect(toPrismaSeverity('critical')).toBe(PrismaAlertSeverity.CRITICAL);
    });

    it('aller-retour stable pour toutes les valeurs de l enum Prisma', () => {
      for (const s of Object.values(PrismaAlertSeverity)) {
        expect(toPrismaSeverity(toSharedSeverity(s))).toBe(s);
      }
    });

    it('normalise les deux formes vers celle du contrat partage', () => {
      expect(normalizeSeverity('CRITICAL')).toBe('critical');
      expect(normalizeSeverity('warning')).toBe('warning');
      // Valeur inconnue -> 'critical', le HAUT de l'echelle. Applique a la severite d'une
      // ALERTE, cela veut dire « on notifie » : une severite ajoutee a l'enum sans repasser
      // ici doit produire une notification de trop (visible, corrigible) plutot qu'une
      // alerte grave avalee en silence. C'est l'inverse du repli sur un SEUIL, ou
      // 'critical' est au contraire le reglage le plus strict (cf. toSharedSeverity).
      expect(normalizeSeverity('n_importe_quoi')).toBe('critical');
    });

    it('une severite d alerte inconnue N EST PAS avalee : elle passe le seuil par defaut', async () => {
      // Le pendant concret du commentaire ci-dessus, verifie sur l'aiguillage lui-meme.
      prefFindMany.mockResolvedValue([]);
      await expect(
        service.filterPushRecipients(
          [{ id: 'sa1', role: UserRole.SUPER_ADMIN }],
          { type: 'SOS', severity: 'SEVERITE_INVENTEE' },
        ),
      ).resolves.toEqual(['sa1']);
    });
  });

  // ─── Perimetre de deploiement ───────────────────────────────

  describe('PUSH_ROLLOUT', () => {
    it('SUPER_ADMIN_ONLY : seul le super-admin est eligible', () => {
      expect(isPushRoleEligible(UserRole.SUPER_ADMIN, 'SUPER_ADMIN_ONLY')).toBe(true);
      expect(isPushRoleEligible(UserRole.FLEET_ADMIN, 'SUPER_ADMIN_ONLY')).toBe(false);
      expect(isPushRoleEligible(UserRole.VIEWER, 'SUPER_ADMIN_ONLY')).toBe(false);
    });

    it('ALL : tous les roles sont eligibles', () => {
      expect(isPushRoleEligible(UserRole.FLEET_ADMIN, 'ALL')).toBe(true);
      expect(isPushRoleEligible(UserRole.DRIVER, 'ALL')).toBe(true);
    });

    it('une valeur absente ou mal ecrite N AJOUTE JAMAIS de destinataires', () => {
      // Le pire cas acceptable est le silence (visible, corrigible) — pas l'arrosage
      // de clients qui ne s'y attendent pas.
      for (const bad of [undefined, '', 'all', 'TOUS', 'SUPER_ADMIN', 'ALL ']) {
        expect(isPushRoleEligible(UserRole.FLEET_ADMIN, bad)).toBe(false);
      }
    });
  });

  // ─── Lecture ────────────────────────────────────────────────

  describe('get()', () => {
    it('sans ligne en base : defaut CALIBRE (warning + bruit coupe), isDefault=true', async () => {
      subCount.mockResolvedValue(3);
      const dto = await service.get('u1', UserRole.SUPER_ADMIN);

      expect(dto).toEqual({
        pushEnabled: true,
        // `warning` et non `critical` : POWER_CUT est CRITICAL (330/j) tandis que
        // LOW_BATTERY, que l'utilisateur veut pouvoir tester, est WARNING (4/an).
        // Le seuil seul ne trie donc rien d'utile — cf. le calcul du defaut.
        minSeverity: 'warning',
        mutedTypes: ['POWER_CUT', 'OVERSPEED'],
        isDefault: true,
        eligible: true,
        deviceCount: 3,
      });
    });

    it('le defaut expose est celui du contrat partage, pas une liste recopiee', async () => {
      // Si quelqu'un ajoute un type bruyant a DEFAULT_MUTED_TYPES, le defaut doit suivre
      // sans qu'on ait a repasser ici : une liste recopiee diverge en silence.
      const dto = await service.get('u1', UserRole.SUPER_ADMIN);
      expect(dto.mutedTypes).toEqual([...DEFAULT_MUTED_TYPES]);
    });

    it('le tableau renvoye est une COPIE : le muter ne contamine pas les autres utilisateurs', async () => {
      const first = await service.get('u1', UserRole.SUPER_ADMIN);
      first.mutedTypes.push('SOS');

      const second = await service.get('u2', UserRole.SUPER_ADMIN);
      expect(second.mutedTypes).toEqual([...DEFAULT_MUTED_TYPES]);
      expect(DEFAULT_MUTED_TYPES).toEqual(['POWER_CUT', 'OVERSPEED']);
    });

    it('LE PIEGE A EVITER : une ligne avec mutedTypes vide = TOUT rallume, defaut NON applique', async () => {
      // L'utilisateur a explicitement reactive POWER_CUT et OVERSPEED depuis l'ecran.
      // Superposer le defaut ici defait son choix sans le dire — exactement le genre de
      // silence invisible qu'on repare.
      prefFindUnique.mockResolvedValue(row({ mutedTypes: [] }));
      const dto = await service.get('u1', UserRole.SUPER_ADMIN);
      expect(dto.mutedTypes).toEqual([]);
      expect(dto.isDefault).toBe(false);
    });

    it('LOW_BATTERY et SOS passent le defaut ; POWER_CUT et OVERSPEED non', async () => {
      // La verification que l'utilisateur veut pouvoir faire (« est-ce que la batterie
      // faible marche ? ») doit aboutir SANS qu'il ait a toucher un reglage.
      const dto = await service.get('u1', UserRole.SUPER_ADMIN);
      const pass = (type: AlertType, severity: AlertSeverity) =>
        shouldPushAlert(dto, { type, severity });

      expect(pass('LOW_BATTERY', 'warning')).toBe(true);
      expect(pass('SOS', 'critical')).toBe(true);
      expect(pass('GEOFENCE_EXIT', 'warning')).toBe(true);
      expect(pass('GPS_LOST', 'warning')).toBe(true);

      expect(pass('POWER_CUT', 'critical')).toBe(false);
      expect(pass('OVERSPEED', 'warning')).toBe(false);
      // Les alertes de conduite (INFO) restent sous le seuil : volume non mesure.
      expect(pass('HARSH_BRAKING', 'info')).toBe(false);
    });

    it('avec ligne : severite convertie en minuscules pour le client', async () => {
      prefFindUnique.mockResolvedValue(
        row({ minSeverity: PrismaAlertSeverity.WARNING, mutedTypes: ['OVERSPEED'] }),
      );
      const dto = await service.get('u1', UserRole.SUPER_ADMIN);

      expect(dto.minSeverity).toBe('warning');
      expect(dto.mutedTypes).toEqual(['OVERSPEED']);
      expect(dto.isDefault).toBe(false);
    });

    it('ecarte silencieusement un type coupe devenu inconnu', async () => {
      // `mutedTypes` est stocke en texte : un type retire du code ne doit pas casser la
      // relecture d'une ligne existante.
      prefFindUnique.mockResolvedValue(row({ mutedTypes: ['OVERSPEED', 'TYPE_DISPARU'] }));
      const dto = await service.get('u1', UserRole.SUPER_ADMIN);
      expect(dto.mutedTypes).toEqual(['OVERSPEED']);
    });

    it('eligible reflete la REALITE du deploiement, pas le souhait de l utilisateur', async () => {
      // Perimetre restreint + role non concerne => l'ecran doit pouvoir dire
      // « pas encore actif pour votre role » au lieu de laisser croire a une panne.
      expect((await service.get('u2', UserRole.FLEET_ADMIN)).eligible).toBe(false);
      rollout = 'ALL';
      expect((await service.get('u2', UserRole.FLEET_ADMIN)).eligible).toBe(true);
    });

    it('ne lit que l utilisateur demande', async () => {
      await service.get('u1', UserRole.SUPER_ADMIN);
      expect(prefFindUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(subCount).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });
  });

  // ─── Ecriture ───────────────────────────────────────────────

  describe('update()', () => {
    it('ecrit la severite en MAJUSCULES en base', async () => {
      await service.update('u1', UserRole.SUPER_ADMIN, { minSeverity: 'warning' });

      const args = prefUpsert.mock.calls[0][0];
      expect(args.where).toEqual({ userId: 'u1' });
      expect(args.create.minSeverity).toBe(PrismaAlertSeverity.WARNING);
      expect(args.update.minSeverity).toBe(PrismaAlertSeverity.WARNING);
    });

    it('mise a jour PARTIELLE : un champ absent n est pas reecrit', async () => {
      await service.update('u1', UserRole.SUPER_ADMIN, { pushEnabled: false });

      const args = prefUpsert.mock.calls[0][0];
      expect(args.update).toEqual({ pushEnabled: false });
      // A la creation, les champs non fournis prennent le defaut CALIBRE.
      expect(args.create.minSeverity).toBe(PrismaAlertSeverity.WARNING);
      expect(args.create.mutedTypes).toEqual(['POWER_CUT', 'OVERSPEED']);
    });

    it('PREMIERE ECRITURE : ne fournir que le seuil ne RALLUME PAS le bruit coupe par defaut', async () => {
      // Scenario reel : l'utilisateur sans ligne voit l'ecran afficher POWER_CUT et
      // OVERSPEED coupes, puis ne touche QUE le seuil de gravite. Si la creation posait
      // `mutedTypes: []`, il repartirait avec 330 notifications/jour d'alimentation
      // coupee — l'inverse exact de ce que l'ecran lui montrait une seconde plus tot.
      await service.update('u1', UserRole.SUPER_ADMIN, { minSeverity: 'critical' });

      const args = prefUpsert.mock.calls[0][0];
      expect(args.create.mutedTypes).toEqual([...DEFAULT_MUTED_TYPES]);
      // La mise a jour, elle, reste strictement partielle : on ne reecrit pas les
      // coupures d'un utilisateur qui a DEJA une ligne.
      expect(args.update).toEqual({ minSeverity: PrismaAlertSeverity.CRITICAL });
    });

    it('rallumer explicitement TOUT est possible : mutedTypes vide est transmis tel quel', async () => {
      // Le pendant du test precedent : `[]` FOURNI est un choix, pas une absence.
      await service.update('u1', UserRole.SUPER_ADMIN, { mutedTypes: [] });

      const args = prefUpsert.mock.calls[0][0];
      expect(args.create.mutedTypes).toEqual([]);
      expect(args.update.mutedTypes).toEqual([]);
    });

    it('dedoublonne les types coupes', async () => {
      await service.update('u1', UserRole.SUPER_ADMIN, {
        mutedTypes: ['OVERSPEED', 'OVERSPEED', 'IDLE_TIME'],
      });
      expect(prefUpsert.mock.calls[0][0].update.mutedTypes).toEqual(['OVERSPEED', 'IDLE_TIME']);
    });

    it('refuse un type d alerte inconnu (un client bugue ne doit pas polluer la base)', async () => {
      await expect(
        service.update('u1', UserRole.SUPER_ADMIN, {
          mutedTypes: ['OVERSPEED', 'PAS_UN_TYPE'] as never,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prefUpsert).not.toHaveBeenCalled();
    });

    it('refuse une severite inconnue — y compris la forme MAJUSCULES de la base', async () => {
      // 'CRITICAL' est la forme Prisma : cote API publique, on n'accepte que le contrat
      // partage. Accepter les deux masquerait un client mal converti.
      await expect(
        service.update('u1', UserRole.SUPER_ADMIN, { minSeverity: 'CRITICAL' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update('u1', UserRole.SUPER_ADMIN, { minSeverity: 'urgent' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prefUpsert).not.toHaveBeenCalled();
    });

    it('refuse un pushEnabled non booleen', async () => {
      await expect(
        service.update('u1', UserRole.SUPER_ADMIN, { pushEnabled: 'oui' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un corps sans champ connu n ecrit RIEN (pas de ligne materialisee pour rien)', async () => {
      // Un PUT vide — ou ne contenant que des cles ignorees comme un userId glisse dans
      // la requete — ne doit pas creer une ligne aux valeurs par defaut : l'ecran dirait
      // ensuite « voici votre choix » alors que l'utilisateur n'a jamais rien choisi.
      const dto = await service.update('u1', UserRole.SUPER_ADMIN, {});
      expect(prefUpsert).not.toHaveBeenCalled();
      expect(dto.isDefault).toBe(true);
      expect(dto.minSeverity).toBe('warning');

      await service.update('u1', UserRole.SUPER_ADMIN, { userId: 'quelqu-un-dautre' } as never);
      expect(prefUpsert).not.toHaveBeenCalled();
    });

    it('relit l etat reel apres ecriture (deviceCount / eligible a jour)', async () => {
      subCount.mockResolvedValue(2);
      prefFindUnique.mockResolvedValue(row({ pushEnabled: false }));

      const dto = await service.update('u1', UserRole.SUPER_ADMIN, { pushEnabled: false });
      expect(dto.pushEnabled).toBe(false);
      expect(dto.isDefault).toBe(false);
      expect(dto.deviceCount).toBe(2);
    });
  });

  // ─── L aiguillage : le bug d origine ────────────────────────

  describe('filterPushRecipients()', () => {
    const superAdmin = { id: 'sa1', role: UserRole.SUPER_ADMIN };
    const fleetAdmin = { id: 'fa1', role: UserRole.FLEET_ADMIN };
    const critical = { type: 'SOS', severity: PrismaAlertSeverity.CRITICAL };

    it('LE CAS QUI ETAIT CASSE : un SUPER_ADMIN sans aucune ligne de preference recoit', async () => {
      // Les quatre SUPER_ADMIN de production n'ont ni fleetId ni preference. Si l'absence
      // de ligne valait silence, on aurait « repare » le push sans qu'il parte jamais.
      prefFindMany.mockResolvedValue([]);
      await expect(service.filterPushRecipients([superAdmin], critical)).resolves.toEqual(['sa1']);
    });

    it('preference coupee : l interrupteur MAITRE ferme tout', async () => {
      prefFindMany.mockResolvedValue([row({ userId: 'sa1', pushEnabled: false })]);
      await expect(service.filterPushRecipients([superAdmin], critical)).resolves.toEqual([]);
    });

    it('seuil de severite : une INFO ne passe pas le defaut warning', async () => {
      prefFindMany.mockResolvedValue([]);
      const info = { type: 'HARSH_BRAKING', severity: PrismaAlertSeverity.INFO };
      await expect(service.filterPushRecipients([superAdmin], info)).resolves.toEqual([]);

      // Le meme utilisateur qui abaisse son seuil la recoit.
      prefFindMany.mockResolvedValue([
        row({ userId: 'sa1', minSeverity: PrismaAlertSeverity.INFO }),
      ]);
      await expect(service.filterPushRecipients([superAdmin], info)).resolves.toEqual(['sa1']);
    });

    it('LE VOLUME : sans ligne, le bruit mesure est retenu et le rare passe', async () => {
      // Les quatre SUPER_ADMIN de production n'ont aucune ligne. Avec l'ancien defaut
      // (`critical`, rien de coupe), reparer le push leur envoyait les 330 POWER_CUT
      // quotidiens des le premier jour.
      prefFindMany.mockResolvedValue([]);

      const sent = (type: string, severity: PrismaAlertSeverity) =>
        service.filterPushRecipients([superAdmin], { type, severity });

      await expect(sent('POWER_CUT', PrismaAlertSeverity.CRITICAL)).resolves.toEqual([]);
      await expect(sent('OVERSPEED', PrismaAlertSeverity.WARNING)).resolves.toEqual([]);
      // Ce qui compte vraiment passe sans qu'aucun reglage n'ait ete touche.
      await expect(sent('SOS', PrismaAlertSeverity.CRITICAL)).resolves.toEqual(['sa1']);
      await expect(sent('LOW_BATTERY', PrismaAlertSeverity.WARNING)).resolves.toEqual(['sa1']);
    });

    it('une ligne avec mutedTypes vide rallume POWER_CUT : le defaut ne se superpose pas', async () => {
      prefFindMany.mockResolvedValue([
        row({ userId: 'sa1', minSeverity: PrismaAlertSeverity.CRITICAL, mutedTypes: [] }),
      ]);
      await expect(
        service.filterPushRecipients([superAdmin], {
          type: 'POWER_CUT',
          severity: PrismaAlertSeverity.CRITICAL,
        }),
      ).resolves.toEqual(['sa1']);
    });

    it('type coupe : l alerte ne produit pas de push, les autres types continuent', async () => {
      prefFindMany.mockResolvedValue([
        row({ userId: 'sa1', minSeverity: PrismaAlertSeverity.INFO, mutedTypes: ['OVERSPEED'] }),
      ]);
      const overspeed = { type: 'OVERSPEED', severity: PrismaAlertSeverity.WARNING };
      await expect(service.filterPushRecipients([superAdmin], overspeed)).resolves.toEqual([]);
      await expect(service.filterPushRecipients([superAdmin], critical)).resolves.toEqual(['sa1']);
    });

    it('bascule PUSH_ROLLOUT : un FLEET_ADMIN n entre qu en mode ALL', async () => {
      prefFindMany.mockResolvedValue([]);
      await expect(service.filterPushRecipients([fleetAdmin], critical)).resolves.toEqual([]);
      // En perimetre restreint, la base n'est meme pas interrogee : personne d'eligible.
      expect(prefFindMany).not.toHaveBeenCalled();

      rollout = 'ALL';
      await expect(service.filterPushRecipients([fleetAdmin], critical)).resolves.toEqual(['fa1']);
    });

    it('en perimetre restreint, ne garde que le super-admin d une liste mixte', async () => {
      prefFindMany.mockResolvedValue([]);
      const kept = await service.filterPushRecipients([fleetAdmin, superAdmin], critical);
      expect(kept).toEqual(['sa1']);
      // La requete ne porte que sur les candidats eligibles.
      expect(prefFindMany).toHaveBeenCalledWith({ where: { userId: { in: ['sa1'] } } });
    });

    it('accepte la severite dans les deux formes (base MAJUSCULES / contrat minuscules)', async () => {
      prefFindMany.mockResolvedValue([]);
      await expect(
        service.filterPushRecipients([superAdmin], { type: 'SOS', severity: 'critical' }),
      ).resolves.toEqual(['sa1']);
      await expect(
        service.filterPushRecipients([superAdmin], { type: 'SOS', severity: 'CRITICAL' }),
      ).resolves.toEqual(['sa1']);
    });

    it('un destinataire present deux fois ne produit qu un seul push', async () => {
      // Cas reel : le meme utilisateur est destinataire de sa flotte ET cible d'escalade
      // d'une regle. Deux entrees = deux notifications identiques sur le meme telephone.
      prefFindMany.mockResolvedValue([]);
      await expect(
        service.filterPushRecipients([superAdmin, superAdmin], critical),
      ).resolves.toEqual(['sa1']);
      expect(prefFindMany).toHaveBeenCalledWith({ where: { userId: { in: ['sa1'] } } });
    });

    it('liste vide : aucune requete', async () => {
      await expect(service.filterPushRecipients([], critical)).resolves.toEqual([]);
      expect(prefFindMany).not.toHaveBeenCalled();
    });
  });
});

/**
 * Les deux endpoints n'agissent QUE sur l'utilisateur du jeton.
 *
 * Le risque couvert n'est pas theorique : un identifiant accepte depuis l'URL ou le corps
 * de la requete ferait de cet ecran de reglages une porte pour lire — et modifier — les
 * preferences de notification d'autrui, qui renseignent sur les habitudes d'une personne.
 */
describe('NotificationsController — preferences', () => {
  const prefs = { get: jest.fn(), update: jest.fn() };
  const controller = new NotificationsController(
    {} as never, // WebPushService — non sollicite par ces deux routes
    {} as never, // AlertRulesService
    {} as never, // PrismaService
    {} as never, // OwnerVisibilityService
    prefs as unknown as NotificationPreferencesService,
  );

  const req = {
    user: { id: 'moi', role: UserRole.FLEET_ADMIN },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => jest.clearAllMocks());

  it('GET lit l identite depuis le jeton', async () => {
    await controller.getPreferences(req);
    expect(prefs.get).toHaveBeenCalledWith('moi', UserRole.FLEET_ADMIN);
  });

  it('PUT ignore un userId glisse dans le corps', async () => {
    await controller.updatePreferences(req, { pushEnabled: false, userId: 'quelqu-un-dautre' } as never);

    const [userId, role, body] = prefs.update.mock.calls[0];
    expect(userId).toBe('moi');
    expect(role).toBe(UserRole.FLEET_ADMIN);
    // Le corps est transmis tel quel : c'est le service qui ne retient que les champs
    // connus (`userId` n'en fait pas partie et n'atteint donc jamais la base).
    expect(body.pushEnabled).toBe(false);
  });

  it('PUT sans corps ne casse pas (client qui envoie un body vide)', async () => {
    await controller.updatePreferences(req, undefined as never);
    expect(prefs.update).toHaveBeenCalledWith('moi', UserRole.FLEET_ADMIN, {});
  });
});
