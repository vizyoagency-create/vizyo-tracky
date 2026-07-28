import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationCenterController } from './notification-center.controller';
import { NotificationCenterService } from './notification-center.service';
import { WebPushService } from './web-push.service';

/**
 * CENTRE DE NOTIFICATIONS — lot « API ».
 *
 * Ces tests cadrent ce qui doit rester vrai même sous stress de volume, parce que c'est
 * exactement là que le produit s'est déjà fait avoir :
 *
 *   - 330 POWER_CUT/jour + 164 OVERSPEED/jour mesurés en production : une lecture sans
 *     borne (période, taille de page, profondeur d'offset) est une panne différée. On
 *     vérifie donc les bornes AVANT le confort d'affichage.
 *   - Une notification RETENUE doit sortir avec sa raison en clair. Remplacer un silence
 *     invisible par un autre serait pire que le bug d'origine — d'où les tests sur
 *     `reasonLabel` et sur le taux de retenue.
 *   - Le compte owner doit rester masqué même quand l'appelant filtre explicitement
 *     dessus : c'est le cas qu'un `where` construit par étalement laisse passer.
 */
describe('NotificationCenterService', () => {
  let service: NotificationCenterService;
  let controller: NotificationCenterController;

  let deliveryCount: jest.Mock;
  let deliveryFindMany: jest.Mock;
  let deliveryGroupBy: jest.Mock;
  let deliveryFindFirst: jest.Mock;
  let userFindMany: jest.Mock;
  let userGroupBy: jest.Mock;
  let userCount: jest.Mock;
  let subGroupBy: jest.Mock;
  let fleetFindMany: jest.Mock;
  let userIdExclusion: jest.Mock;
  let hiddenIdsFor: jest.Mock;
  let vapidEnabled: boolean;
  let rollout: string;

  /** Ligne telle que Prisma la rend (dates en objets, sévérité en texte libre). */
  const delivery = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'd1',
    createdAt: new Date('2026-07-27T10:00:00.000Z'),
    alertId: 'a1',
    alertType: 'POWER_CUT',
    severity: 'CRITICAL',
    userId: 'u1',
    fleetId: 'f1',
    channel: 'WEB_PUSH',
    status: 'SENT',
    reason: null,
    title: 'Coupure d’alimentation',
    body: 'TE002ST — coupure détectée',
    deviceCount: 2,
    sentCount: 2,
    failedCount: 0,
    groupedCount: 0,
    user: { email: 'admin@vizyo.fr', firstName: 'Jean', lastName: 'Dupont', role: UserRole.SUPER_ADMIN },
    ...over,
  });

  const group = (fields: Record<string, unknown>, n: number) => ({ ...fields, _count: { _all: n } });

  beforeEach(async () => {
    vapidEnabled = true;
    rollout = 'SUPER_ADMIN_ONLY';

    deliveryCount = jest.fn().mockResolvedValue(0);
    deliveryFindMany = jest.fn().mockResolvedValue([]);
    deliveryGroupBy = jest.fn().mockResolvedValue([]);
    deliveryFindFirst = jest.fn().mockResolvedValue(null);
    userFindMany = jest.fn().mockResolvedValue([]);
    userGroupBy = jest.fn().mockResolvedValue([]);
    userCount = jest.fn().mockResolvedValue(0);
    subGroupBy = jest.fn().mockResolvedValue([]);
    fleetFindMany = jest.fn().mockResolvedValue([]);
    // Par défaut : viewer NON-owner, donc l'owner 'owner-1' est masqué.
    userIdExclusion = jest.fn().mockResolvedValue({ userId: { notIn: ['owner-1'] } });
    hiddenIdsFor = jest.fn().mockResolvedValue(['owner-1']);

    const prisma = {
      notificationDelivery: {
        count: deliveryCount,
        findMany: deliveryFindMany,
        groupBy: deliveryGroupBy,
        findFirst: deliveryFindFirst,
      },
      user: { findMany: userFindMany, groupBy: userGroupBy, count: userCount },
      pushSubscription: { groupBy: subGroupBy },
      fleet: { findMany: fleetFindMany },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationCenterController],
      providers: [
        NotificationCenterService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: OwnerVisibilityService,
          useValue: {
            userIdExclusion: (viewer: unknown, field?: string) => userIdExclusion(viewer, field),
            hiddenIdsFor: (viewer: unknown) => hiddenIdsFor(viewer),
          },
        },
        { provide: ConfigService, useValue: { get: () => rollout } },
        { provide: WebPushService, useValue: { isEnabled: () => vapidEnabled } },
      ],
    })
      // Les guards ne sont pas instanciés ici : on teste leur DÉCLARATION (métadonnées),
      // pas leur exécution, qui est déjà couverte par les tests d'auth.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    service = moduleRef.get(NotificationCenterService);
    controller = moduleRef.get(NotificationCenterController);
  });

  /** Dernier `where` passé au `findMany` du journal. */
  const lastWhere = () => deliveryFindMany.mock.calls.at(-1)?.[0]?.where ?? {};

  // ─── Périmètre : SUPER_ADMIN uniquement ──────────────────────────────────────────

  describe('périmètre d’accès', () => {
    it('n’est ouvert qu’aux SUPER_ADMIN, au niveau du contrôleur entier', () => {
      // Au niveau CLASSE, pas méthode par méthode : un endpoint ajouté plus tard doit
      // hériter de la protection au lieu de naître sans garde.
      const roles = Reflect.getMetadata(ROLES_KEY, NotificationCenterController);
      expect(roles).toEqual([UserRole.SUPER_ADMIN]);

      const guards = Reflect.getMetadata('__guards__', NotificationCenterController) ?? [];
      expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    });

    it('n’expose que des lectures (aucune route d’écriture sur le contrôleur)', () => {
      const proto = NotificationCenterController.prototype as unknown as Record<string, unknown>;
      const routes = Object.getOwnPropertyNames(proto).filter(
        (m) => m !== 'constructor' && Reflect.hasMetadata('path', proto[m] as object),
      );
      for (const route of routes) {
        // 0 = RequestMethod.GET
        expect(Reflect.getMetadata('method', proto[route] as object)).toBe(0);
      }
      expect(routes.sort()).toEqual(['deliveries', 'health', 'summary']);
    });
  });

  // ─── Bornes : la table est la plus volumineuse du produit après les positions ─────

  describe('bornes de lecture', () => {
    it('plafonne la taille de page demandée par le client', async () => {
      await service.deliveries({ pageSize: 5000 });
      expect(deliveryFindMany.mock.calls[0][0].take).toBe(200);
    });

    it('applique une taille de page par défaut quand rien n’est demandé', async () => {
      const page = await service.deliveries({});
      expect(deliveryFindMany.mock.calls[0][0].take).toBe(50);
      expect(page.pageSize).toBe(50);
      expect(page.page).toBe(1);
    });

    it('borne TOUJOURS la période, même sans from/to (jamais de scan intégral)', async () => {
      const page = await service.deliveries({});
      const created = lastWhere().createdAt;
      expect(created.gte).toBeInstanceOf(Date);
      expect(created.lte).toBeInstanceOf(Date);
      const spanDays = (created.lte.getTime() - created.gte.getTime()) / 86_400_000;
      expect(Math.round(spanDays)).toBe(7);
      // La fenêtre réellement appliquée est renvoyée : l'écran ne doit pas afficher une
      // période différente de celle qui a servi à compter.
      expect(page.from).toBe(created.gte.toISOString());
      expect(page.to).toBe(created.lte.toISOString());
    });

    it('ramène une période démesurée au maximum autorisé plutôt que de la refuser', async () => {
      await service.deliveries({ from: '2020-01-01T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' });
      const created = lastWhere().createdAt;
      const spanDays = (created.lte.getTime() - created.gte.getTime()) / 86_400_000;
      expect(Math.round(spanDays)).toBe(90);
    });

    it('retombe sur la fenêtre par défaut si les bornes sont inversées', async () => {
      // Renvoyer 0 ligne se lirait à tort comme « aucune notification » : le pire résultat
      // possible sur un écran dont le rôle est justement de prouver qu'il ne manque rien.
      await service.deliveries({ from: '2026-07-27T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' });
      const created = lastWhere().createdAt;
      expect(created.gte.getTime()).toBeLessThan(created.lte.getTime());
      const spanDays = (created.lte.getTime() - created.gte.getTime()) / 86_400_000;
      expect(Math.round(spanDays)).toBe(7);
    });

    it('refuse une pagination trop profonde au lieu de faire scanner la table', async () => {
      await expect(service.deliveries({ page: 5000, pageSize: 200 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(deliveryFindMany).not.toHaveBeenCalled();
    });

    it('ne laisse jamais un NaN atteindre le OFFSET SQL', async () => {
      const page = await service.deliveries({ page: Number.NaN, pageSize: Number.NaN });
      expect(page.page).toBe(1);
      expect(deliveryFindMany.mock.calls[0][0].skip).toBe(0);
      expect(Number.isNaN(deliveryFindMany.mock.calls[0][0].take)).toBe(false);
    });

    it('retombe sur la taille de page par DÉFAUT quand elle est illisible, pas sur 1 ligne', async () => {
      // Un `pageSize` illisible ramené au minimum afficherait une seule ligne sur un écran
      // dont tout le propos est de montrer le volume : « il n'y a presque rien » est la
      // conclusion exactement inverse de la réalité (330 POWER_CUT/jour).
      const page = await service.deliveries({ pageSize: Number.NaN });
      expect(page.pageSize).toBe(50);
      expect(deliveryFindMany.mock.calls[0][0].take).toBe(50);
    });

    it('refuse un statut inconnu au lieu d’ignorer le filtre en silence', async () => {
      // Un filtre silencieusement ignoré ferait croire à une liste exhaustive alors qu'elle
      // ne l'est pas — c'est la famille de bug que tout cet écran cherche à éliminer.
      await expect(service.deliveries({ status: 'PENDING' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuse une sévérité inconnue', async () => {
      await expect(service.deliveries({ severity: 'urgent' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // ─── Masquage de l'owner ─────────────────────────────────────────────────────────

  describe('masquage du compte owner', () => {
    it('exclut l’owner via AND, sans se laisser écraser par un filtre userId', async () => {
      await service.deliveries({ userId: 'owner-1' });
      const where = lastWhere();
      // Le filtre demandé est bien posé…
      expect(where.userId).toBe('owner-1');
      // …mais l'exclusion owner vit dans AND, donc elle s'ajoute au lieu d'être remplacée :
      // la requête ne peut renvoyer aucune ligne de l'owner.
      expect(where.AND).toEqual(expect.arrayContaining([{ userId: { notIn: ['owner-1'] } }]));
    });

    it('n’ajoute rien quand le viewer est lui-même owner', async () => {
      userIdExclusion.mockResolvedValue({});
      await service.deliveries({}, { isOwner: true });
      expect(lastWhere().AND).toBeUndefined();
    });

    it('retire les abonnements de l’owner des compteurs de santé', async () => {
      subGroupBy.mockResolvedValue([
        group({ userId: 'u1' }, 2),
        group({ userId: 'owner-1' }, 5),
      ]);
      userFindMany.mockResolvedValue([{ id: 'u1', role: UserRole.SUPER_ADMIN }]);

      const health = await service.health();
      // 5 appareils de l'owner ne doivent apparaître ni dans le total ni par rôle.
      expect(health.totalDevices).toBe(2);
      expect(health.usersWithDevice).toBe(1);
    });
  });

  // ─── Lisibilité d'une ligne : le cœur du lot ─────────────────────────────────────

  describe('lecture d’une ligne', () => {
    beforeEach(() => {
      fleetFindMany.mockResolvedValue([{ id: 'f1', name: 'Flotte Toulouse' }]);
    });

    it('traduit le motif d’une notification RETENUE en français', async () => {
      deliveryFindMany.mockResolvedValue([
        delivery({ status: 'SUPPRESSED', reason: 'preference_type_muted', sentCount: 0, deviceCount: 1 }),
      ]);
      deliveryCount.mockResolvedValue(1);

      const page = await service.deliveries({});
      const row = page.rows[0];
      expect(row.status).toBe('SUPPRESSED');
      expect(row.statusLabel).toBe('Retenue');
      // Le code brut reste exposé (filtrage/regroupement) ET le libellé lisible avec.
      expect(row.reason).toBe('preference_type_muted');
      expect(row.reasonLabel).toBe('Ce type est coupé dans ses réglages');
    });

    it('renvoie tel quel un motif inconnu plutôt que de le masquer', async () => {
      deliveryFindMany.mockResolvedValue([
        delivery({ status: 'FAILED', reason: 'endpoint 410 Gone', sentCount: 0, failedCount: 2 }),
      ]);
      deliveryCount.mockResolvedValue(1);

      const row = (await service.deliveries({})).rows[0];
      expect(row.reasonLabel).toBe('endpoint 410 Gone');
      expect(row.statusLabel).toBe('Échec d’envoi');
    });

    it('signale explicitement un non-envoi SANS motif (le trou à corriger)', async () => {
      deliveryFindMany.mockResolvedValue([delivery({ status: 'SUPPRESSED', reason: null })]);
      deliveryCount.mockResolvedValue(1);

      const row = (await service.deliveries({})).rows[0];
      // Une ligne retenue sans raison est une régression du journal : elle doit se voir,
      // pas se traduire par une cellule vide qu'on prendra pour un détail d'affichage.
      expect(row.reasonLabel).toBe('Motif non renseigné');
    });

    it('n’invente aucun motif pour une notification réellement partie', async () => {
      deliveryFindMany.mockResolvedValue([delivery()]);
      deliveryCount.mockResolvedValue(1);

      const row = (await service.deliveries({})).rows[0];
      expect(row.reasonLabel).toBeNull();
      expect(row.statusLabel).toBe('Envoyée');
    });

    it('rend le destinataire, la flotte et les compteurs lisibles sans requête supplémentaire', async () => {
      deliveryFindMany.mockResolvedValue([delivery({ groupedCount: 4 })]);
      deliveryCount.mockResolvedValue(1);

      const row = (await service.deliveries({})).rows[0];
      expect(row.userEmail).toBe('admin@vizyo.fr');
      expect(row.userName).toBe('Jean Dupont');
      expect(row.userRole).toBe('SUPER_ADMIN');
      expect(row.fleetName).toBe('Flotte Toulouse');
      expect(row.deviceCount).toBe(2);
      expect(row.groupedCount).toBe(4);
    });

    it('convertit la sévérité stockée en MAJUSCULES vers la forme du contrat client', async () => {
      deliveryFindMany.mockResolvedValue([delivery({ severity: 'CRITICAL' })]);
      deliveryCount.mockResolvedValue(1);

      // ⚠️ Le piège du produit : enum Prisma en MAJUSCULES, contrat partagé en minuscules.
      expect((await service.deliveries({})).rows[0].severity).toBe('critical');
    });

    it('accepte les deux casses de sévérité au filtrage (colonne en texte libre)', async () => {
      await service.deliveries({ severity: 'critical' });
      expect(lastWhere().severity).toEqual({ in: ['critical', 'CRITICAL'] });
    });

    it('cherche aussi sur l’e-mail du destinataire, pas seulement sur le texte', async () => {
      await service.deliveries({ search: 'dupont' });
      const or = (lastWhere().AND ?? []).flatMap((c: Record<string, unknown>) => c.OR ?? []);
      expect(or).toEqual(
        expect.arrayContaining([{ user: { email: { contains: 'dupont', mode: 'insensitive' } } }]),
      );
    });

    it('calcule hasMore à partir du total réel', async () => {
      deliveryFindMany.mockResolvedValue([delivery(), delivery({ id: 'd2' })]);
      deliveryCount.mockResolvedValue(120);

      const page = await service.deliveries({ pageSize: 2 });
      expect(page.total).toBe(120);
      expect(page.hasMore).toBe(true);
    });
  });

  // ─── Synthèse ────────────────────────────────────────────────────────────────────

  describe('synthèse', () => {
    /** Branche les 6 agrégats dans l'ordre où le service les demande. */
    const wireSummary = (opts: {
      status?: Record<string, number>;
      channel?: Record<string, number>;
      severity?: Record<string, number>;
      alertType?: Record<string, number>;
      reason?: Record<string, number>;
      recipients?: { userId: string; status: string; n: number }[];
    }) => {
      const toGroups = (field: string, rec: Record<string, number> = {}) =>
        Object.entries(rec).map(([k, n]) => group({ [field]: k }, n));
      deliveryGroupBy
        .mockResolvedValueOnce(toGroups('status', opts.status))
        .mockResolvedValueOnce(toGroups('channel', opts.channel))
        .mockResolvedValueOnce(toGroups('severity', opts.severity))
        .mockResolvedValueOnce(toGroups('alertType', opts.alertType))
        .mockResolvedValueOnce(toGroups('reason', opts.reason))
        .mockResolvedValueOnce(
          (opts.recipients ?? []).map((r) => group({ userId: r.userId, status: r.status }, r.n)),
        );
    };

    it('sépare les retenues volontaires des échecs techniques dans le taux', async () => {
      wireSummary({
        status: { SENT: 38, SUPPRESSED: 330, GROUPED: 44, FAILED: 10 },
        reason: { preference_type_muted: 330, cooldown: 44 },
      });

      const s = await service.summary({});
      expect(s.total).toBe(422);
      expect(s.sent).toBe(38);
      expect(s.failed).toBe(10);
      // ⚠️ FAILED est HORS du taux : une panne d'envoi ne doit pas se cacher derrière un
      // taux de suppression qui paraîtrait normal.
      expect(s.withheld).toBe(374);
      expect(s.suppressionRate).toBeCloseTo(374 / 422, 6);
    });

    it('classe les motifs de retenue et donne leur part', async () => {
      wireSummary({
        status: { SENT: 38, SUPPRESSED: 330, GROUPED: 44 },
        reason: { cooldown: 44, preference_type_muted: 330 },
      });

      const s = await service.summary({});
      expect(s.byReason[0]).toMatchObject({
        reason: 'preference_type_muted',
        label: 'Ce type est coupé dans ses réglages',
        count: 330,
      });
      expect(s.byReason[0].share).toBeCloseTo(330 / 374, 6);
      expect(s.byReason[1].reason).toBe('cooldown');
    });

    it('résume la période en une phrase lisible', async () => {
      wireSummary({
        status: { SENT: 38, SUPPRESSED: 330, GROUPED: 44 },
        reason: { preference_type_muted: 330, cooldown: 44 },
      });

      const s = await service.summary({});
      expect(s.headline).toBe(
        '412 notifications · 38 envoyées · 374 retenues (dont 330 — ce type est coupé dans ses réglages)',
      );
    });

    it('dit clairement qu’il n’y a rien plutôt que d’afficher des zéros', async () => {
      wireSummary({});
      const s = await service.summary({});
      expect(s.total).toBe(0);
      expect(s.suppressionRate).toBe(0);
      expect(s.headline).toBe('Aucune notification sur la période.');
    });

    it('fusionne les sévérités écrites dans des casses différentes', async () => {
      wireSummary({ status: { SENT: 3 }, severity: { CRITICAL: 2, critical: 1 } });
      const s = await service.summary({});
      expect(s.bySeverity).toEqual([{ key: 'critical', label: 'Critique', count: 3 }]);
    });

    it('renvoie des libellés en FRANÇAIS, jamais l’identifiant technique brut', async () => {
      // `label` est promis « prêt à afficher » par le contrat : s'il vaut la clé, l'écran
      // refait sa propre table de traduction — une seconde vérité qui finira par diverger.
      wireSummary({
        status: { SENT: 2, SUPPRESSED: 1 },
        channel: { WEB_PUSH: 3 },
        severity: { WARNING: 3 },
      });
      const s = await service.summary({});
      expect(s.byChannel).toEqual([{ key: 'WEB_PUSH', label: 'Push navigateur', count: 3 }]);
      expect(s.bySeverity[0].label).toBe('Avertissement');
      expect(s.byStatus.map((x) => x.label).sort()).toEqual(['Envoyée', 'Retenue']);
    });

    it('laisse passer BRUT un canal inconnu du contrat plutôt que de le masquer', async () => {
      wireSummary({ status: { SENT: 1 }, channel: { TELEGRAM: 1 } });
      const s = await service.summary({});
      expect(s.byChannel).toEqual([{ key: 'TELEGRAM', label: 'TELEGRAM', count: 1 }]);
    });

    it('fait ressortir les types les plus bruyants en tête', async () => {
      wireSummary({
        status: { SENT: 10 },
        alertType: { OVERSPEED: 164, POWER_CUT: 330, SOS: 1 },
      });
      const s = await service.summary({});
      expect(s.byAlertType.map((t) => t.key)).toEqual(['POWER_CUT', 'OVERSPEED', 'SOS']);
    });

    it('classe les destinataires et résout leur identité', async () => {
      wireSummary({
        status: { SENT: 12 },
        recipients: [
          { userId: 'u1', status: 'SENT', n: 4 },
          { userId: 'u1', status: 'SUPPRESSED', n: 300 },
          { userId: 'u2', status: 'SENT', n: 8 },
        ],
      });
      userFindMany.mockResolvedValue([
        { id: 'u1', email: 'noyé@vizyo.fr', firstName: 'Noé', lastName: null, role: UserRole.SUPER_ADMIN },
        { id: 'u2', email: 'calme@vizyo.fr', firstName: null, lastName: null, role: UserRole.FLEET_ADMIN },
      ]);

      const s = await service.summary({});
      // Le compte noyé sous le bruit doit sortir en tête : c'est lui qui coupera tout.
      expect(s.topRecipients[0]).toMatchObject({
        userId: 'u1',
        email: 'noyé@vizyo.fr',
        name: 'Noé',
        sent: 4,
        suppressed: 300,
        total: 304,
      });
      expect(s.topRecipients[1].userId).toBe('u2');
    });

    it('n’écrase pas les conditions existantes en ajoutant le filtre des retenues', async () => {
      wireSummary({ status: { SENT: 1 } });
      await service.summary({ fleetId: 'f1' });

      const reasonWhere = deliveryGroupBy.mock.calls[4][0].where;
      // Le filtre métier (flotte) ET le masquage owner ET la période doivent survivre à
      // l'ajout du « statut ∈ retenues » — un simple étalement d'objet les perdrait.
      expect(reasonWhere.fleetId).toBe('f1');
      expect(reasonWhere.createdAt).toBeDefined();
      expect(reasonWhere.AND).toEqual(
        expect.arrayContaining([
          { userId: { notIn: ['owner-1'] } },
          { status: { in: ['SUPPRESSED', 'GROUPED'] } },
        ]),
      );
    });
  });

  // ─── Santé de la chaîne ──────────────────────────────────────────────────────────

  describe('santé de la chaîne', () => {
    it('signale l’absence de clés VAPID : rien ne peut partir', async () => {
      vapidEnabled = false;
      const h = await service.health();
      expect(h.vapidConfigured).toBe(false);
      expect(h.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Clés VAPID absentes')]),
      );
    });

    it('rappelle le périmètre restreint en cours (l’état de la production)', async () => {
      const h = await service.health();
      expect(h.pushRollout).toBe('SUPER_ADMIN_ONLY');
      expect(h.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('PUSH_ROLLOUT=SUPER_ADMIN_ONLY')]),
      );
    });

    it('ne compte comme éligibles que les SUPER_ADMIN tant que le rollout est restreint', async () => {
      await service.health();
      expect(userCount.mock.calls[0][0].where).toMatchObject({
        isActive: true,
        role: UserRole.SUPER_ADMIN,
      });
    });

    it('compte tous les utilisateurs actifs quand le rollout est ouvert', async () => {
      rollout = 'ALL';
      await service.health();
      expect(userCount.mock.calls[0][0].where.role).toBeUndefined();
    });

    it('isole les éligibles SANS appareil — le trou qui fait croire qu’on est notifié', async () => {
      subGroupBy.mockResolvedValue([group({ userId: 'u1' }, 3)]);
      userFindMany
        .mockResolvedValueOnce([{ id: 'u1', role: UserRole.SUPER_ADMIN }]) // abonnés
        .mockResolvedValueOnce([
          { id: 'u2', email: 'sourd@vizyo.fr', firstName: 'Sam', lastName: null, role: UserRole.SUPER_ADMIN },
        ]); // échantillon injoignable
      userCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

      const h = await service.health();
      expect(h.eligibleUsers).toBe(2);
      expect(h.eligibleWithoutDevice).toBe(1);
      expect(h.unreachableUsers).toEqual([
        { userId: 'u2', email: 'sourd@vizyo.fr', name: 'Sam', role: 'SUPER_ADMIN' },
      ]);
      expect(h.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('sans aucun appareil abonné')]),
      );

      // L'exclusion des abonnés passe par AND : sinon elle écraserait le masquage owner,
      // qui occupe déjà la clé `id`.
      const withoutDeviceWhere = userCount.mock.calls[1][0].where;
      expect(withoutDeviceWhere.AND).toEqual([{ id: { notIn: ['u1'] } }]);
    });

    it('ne compte pas comme joignable l’appareil d’un compte DÉSACTIVÉ', async () => {
      // Les abonnements push ne sont jamais purgés à la désactivation d'un compte : celui
      // d'un ex-salarié reste en base. Le dispatch, lui, ne cible que des comptes actifs.
      // Les compter ici ferait taire l'avertissement « aucun appareil abonné » alors que
      // plus personne n'est réellement joignable — le faux vert qu'on cherche à éliminer.
      subGroupBy.mockResolvedValue([group({ userId: 'parti' }, 3)]);
      userFindMany.mockResolvedValueOnce([]); // `parti` est inactif : la requête ne le rend pas

      const h = await service.health();
      expect(userFindMany.mock.calls[0][0].where).toMatchObject({ isActive: true });
      expect(h.totalDevices).toBe(0);
      expect(h.usersWithDevice).toBe(0);
      expect(h.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Aucun appareil abonné')]),
      );
    });

    it('distingue « jamais rien envoyé » de « rien reçu »', async () => {
      deliveryFindFirst
        .mockResolvedValueOnce(null) // dernier SENT
        .mockResolvedValueOnce({ createdAt: new Date('2026-07-27T09:00:00.000Z') }); // dernière tentative

      const h = await service.health();
      expect(h.lastSuccessfulPushAt).toBeNull();
      expect(h.lastAttemptAt).toBe('2026-07-27T09:00:00.000Z');
      expect(h.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Aucun push accepté à ce jour')]),
      );
    });

    it('alerte quand le dernier push réussi date de plus d’une semaine', async () => {
      // 7 jours = exactement la durée pendant laquelle le bug d'origine est passé inaperçu.
      const old = new Date(Date.now() - 9 * 86_400_000);
      deliveryFindFirst.mockResolvedValue({ createdAt: old });

      const h = await service.health();
      expect(h.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Dernier push accepté il y a 9 jours')]),
      );
    });

    it('agrège la joignabilité par rôle', async () => {
      userGroupBy.mockResolvedValue([
        group({ role: UserRole.SUPER_ADMIN }, 4),
        group({ role: UserRole.FLEET_ADMIN }, 12),
      ]);
      subGroupBy.mockResolvedValue([group({ userId: 'u1' }, 2), group({ userId: 'u2' }, 1)]);
      userFindMany.mockResolvedValueOnce([
        { id: 'u1', role: UserRole.SUPER_ADMIN },
        { id: 'u2', role: UserRole.SUPER_ADMIN },
      ]);

      const h = await service.health();
      const sa = h.reachByRole.find((r) => r.role === 'SUPER_ADMIN');
      expect(sa).toEqual({ role: 'SUPER_ADMIN', users: 4, usersWithDevice: 2, devices: 3 });
      // 12 FLEET_ADMIN, aucun appareil : le chiffre qui dit « personne n'est joignable ».
      expect(h.reachByRole.find((r) => r.role === 'FLEET_ADMIN')).toEqual({
        role: 'FLEET_ADMIN',
        users: 12,
        usersWithDevice: 0,
        devices: 0,
      });
    });
  });

  // ─── Contrôleur : passage des paramètres ─────────────────────────────────────────

  describe('contrôleur', () => {
    const req = { user: { id: 'sa1', isOwner: false } } as unknown as AuthenticatedRequest;

    it('transmet les filtres et le viewer au service', async () => {
      const spy = jest.spyOn(service, 'deliveries').mockResolvedValue({} as never);
      await controller.deliveries(
        req,
        '2026-07-01T00:00:00.000Z',
        '2026-07-27T00:00:00.000Z',
        'SUPPRESSED',
        'WEB_PUSH',
        'POWER_CUT',
        'critical',
        'u1',
        'f1',
        'cooldown',
        'TE002ST',
        '2',
        '100',
      );
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUPPRESSED',
          channel: 'WEB_PUSH',
          alertType: 'POWER_CUT',
          severity: 'critical',
          reason: 'cooldown',
          search: 'TE002ST',
          page: 2,
          pageSize: 100,
        }),
        req.user,
      );
    });

    it('ignore une pagination illisible au lieu de renvoyer une erreur', async () => {
      const spy = jest.spyOn(service, 'deliveries').mockResolvedValue({} as never);
      await controller.deliveries(req, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, 'abc', '');
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ page: undefined, pageSize: undefined }),
        req.user,
      );
    });
  });
});
