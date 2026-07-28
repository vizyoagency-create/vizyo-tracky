import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { defaultPushPreference } from './notification-preferences.service';
import { NotificationThrottleService } from './notification-throttle.service';
import { WebPushService } from './web-push.service';

/**
 * V1.15 — Canal SMS du dispatch d'alertes. Teste le chemin SMS via le point
 * d'entree public dispatchAlert() : une regle avec channel 'SMS' + un
 * destinataire avec phone => SmsGatewayService.send() avec context
 * source='alert-notification', plus le throttle anti-flood et le skip sans phone.
 */
describe('NotificationDispatchService — canal SMS (V1.15)', () => {
  let dispatch: NotificationDispatchService;
  let send: jest.Mock;
  let smsLogFindFirst: jest.Mock;
  let ruleFindMany: jest.Mock;
  let userFindMany: jest.Mock;

  const alert = {
    id: 'a1',
    fleetId: 'f1',
    vehicleId: 'v1',
    type: 'OVERSPEED',
    severity: 'CRITICAL',
    title: 'Exces de vitesse',
    message: 'V > 130 km/h',
    createdAt: new Date('2026-06-07T12:23:00Z'),
    acknowledgedAt: null,
    escalatedAt: null,
    vehicle: { plate: 'TE002ST' },
  };

  const recipient = {
    id: 'u1',
    email: 'admin@fleet.test',
    phone: '+33656691615',
    fleetId: 'f1',
    isActive: true,
    // ⚠️ Le rôle manquait à ce fixture. L'ancienne requête filtrait `role: FLEET_ADMIN`
    // côté serveur, ce qui masquait l'omission ; depuis que le destinataire est décidé
    // par `receivesFleetAlerts` (défaut dérivé du RÔLE), un utilisateur sans rôle n'est
    // plus destinataire — et un vrai utilisateur en a toujours un.
    role: 'FLEET_ADMIN',
  };

  beforeEach(async () => {
    send = jest.fn().mockResolvedValue({ ok: true });
    smsLogFindFirst = jest.fn().mockResolvedValue(null);
    ruleFindMany = jest.fn().mockResolvedValue([
      { id: 'r1', fleetId: 'f1', vehicleId: null, alertType: '*', enabled: true, channels: ['SMS'] },
    ]);
    userFindMany = jest.fn().mockResolvedValue([recipient]);

    const prisma = {
      alertRule: { findMany: ruleFindMany },
      user: { findMany: userFindMany },
      smsLog: { findFirst: smsLogFindFirst },
      surveillanceProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      // Correctif push : le dispatch lit desormais les preferences avant tout
      // envoi WEB_PUSH. Aucune ligne ici => defauts appliques.
      notificationPreference: { findMany: jest.fn().mockResolvedValue([]) },
      // Journal des issues de notification (garde-fous anti-spam) : muet ici, le SMS
      // n'est pas journalise — seul le PUSH l'est.
      notificationDelivery: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: WebPushService, useValue: { sendToUser: jest.fn() } },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: SmsGatewayService, useValue: { send } },
        // Anti-spam PUSH : jamais atteint ici (le rollout coupe le push pour ce
        // destinataire), mais le dispatch l'exige a la construction.
        { provide: NotificationThrottleService, useValue: { evaluate: jest.fn().mockResolvedValue(new Map()) } },
        // Remontée des échecs de notification au centre d'alerte : non exercée ici, mais le
        // service l'exige à la construction.
        { provide: ErrorLogger, useValue: { recordBackground: jest.fn(), record: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('SUPER_ADMIN_ONLY') } },
      ],
    }).compile();
    dispatch = moduleRef.get(NotificationDispatchService);
  });

  it('sends one SMS to a recipient with a phone, context source=alert-notification', async () => {
    await dispatch.dispatchAlert(alert as never);

    expect(send).toHaveBeenCalledTimes(1);
    const [to, body, ctx] = send.mock.calls[0];
    expect(to).toBe('+33656691615');
    expect(body).toContain('[Vizyo Tracky]');
    expect(body).toContain('CRITICAL');
    expect(body).toContain('TE002ST');
    expect(body.length).toBeLessThanOrEqual(160);
    expect(ctx).toMatchObject({
      source: 'alert-notification',
      userId: 'u1',
      alertId: 'a1',
      alertType: 'OVERSPEED',
    });
  });

  it('throttles: no SMS if a recent alert-notification SMS exists for (user, type)', async () => {
    smsLogFindFirst.mockResolvedValue({ id: 'recent' });
    await dispatch.dispatchAlert(alert as never);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips SMS when the recipient has no phone', async () => {
    userFindMany.mockResolvedValue([{ ...recipient, phone: null }]);
    await dispatch.dispatchAlert(alert as never);
    expect(send).not.toHaveBeenCalled();
  });

  it('escalation: ne notifie PAS une cible d escalade hors flotte (#14/#17)', async () => {
    // L'admin a un contact d'escalade, mais ce contact a ete reassigne a une AUTRE
    // flotte : le findFirst scope par fleetId ne le trouve donc pas -> 0 cible.
    userFindMany.mockResolvedValue([
      { id: 'admin1', fleetId: 'f1', role: 'FLEET_ADMIN', isActive: true, escalationContactUserId: 'contact-x' },
    ]);
    const userFindFirst = jest.fn().mockResolvedValue(null);
    (dispatch as unknown as { prisma: { user: { findFirst: jest.Mock } } }).prisma.user.findFirst = userFindFirst;

    await dispatch.dispatchEscalation(alert as never);

    // La cible d'escalade doit etre cherchee SCOPEE a la flotte de l'alerte.
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: 'f1', id: 'contact-x', isActive: true }) }),
    );
    // Cible hors flotte => aucune notification envoyee.
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * Correctif « le push n'arrive jamais » — l'AIGUILLAGE, pas l'envoi.
 *
 * Contexte reel : 582 alertes en 7 jours, ZERO push, alors que VAPID est
 * configure et que 14 appareils sont abonnes. Trois causes cumulees :
 *   #1 la seule AlertRule listait ["EMAIL","WHATSAPP"] — 'WEB_PUSH' absent ;
 *   #2 3 flottes sur 4 n'ont AUCUNE regle — defaut ['IN_APP'] seul ;
 *   #3 les SUPER_ADMIN ont fleetId = NULL et le filtre tenant les excluait.
 *
 * Chaque test ci-dessous rejoue une de ces situations telles qu'observees en
 * base, plus les garde-fous ajoutes (rollout, preferences, non-regression des
 * canaux payants).
 */
describe('NotificationDispatchService — aiguillage du push (correctif)', () => {
  const superAdmin = {
    id: 'sa-0001',
    email: 'owner@vizyo.test',
    phone: '+33600000001',
    // LE point de la cause #3 : le super-admin n'appartient a aucune flotte.
    fleetId: null,
    role: UserRole.SUPER_ADMIN,
    isActive: true,
  };

  const fleetAdmin = {
    id: 'fa-0001',
    email: 'admin@mhcars.test',
    phone: '+33600000002',
    fleetId: 'f1',
    role: UserRole.FLEET_ADMIN,
    isActive: true,
  };

  interface SetupOpts {
    /**
     * Valeur BRUTE que `ConfigService.get('PUSH_ROLLOUT')` renverra.
     *
     * ⚠️ Lue via `'rollout' in opts` et NON par une valeur par defaut de
     * destructuration : `{ rollout: undefined }` doit rejouer « variable absente
     * du .env », pas retomber sur 'SUPER_ADMIN_ONLY' avant d'atteindre le
     * service. Avec un defaut de destructuration, le cas le plus important du
     * rollout (la variable oubliee) n'aurait jamais ete exerce — le test serait
     * passe en testant autre chose.
     */
    rollout?: unknown;
    /** `null` = aucune AlertRule (cas des 3 flottes sur 4). */
    ruleChannels?: string[] | null;
    fleetAdmins?: Array<Record<string, unknown>>;
    superAdmins?: Array<Record<string, unknown>>;
    preferences?: Array<Record<string, unknown>>;
    severity?: string;
    type?: string;
    /** Cible renvoyee par `user.findFirst` (recherche de contact d'escalade). */
    escalationTarget?: Record<string, unknown> | null;
  }

  function setup(opts: SetupOpts = {}) {
    const {
      ruleChannels = ['EMAIL', 'WHATSAPP'],
      fleetAdmins = [],
      superAdmins = [],
      preferences = [],
      severity = 'CRITICAL',
      // ⚠️ PAS 'OVERSPEED' : ce type (et 'POWER_CUT') est desormais coupe PAR DEFAUT,
      // faute de quoi le push vaudrait 494 notifications par jour. L'utiliser comme type
      // par defaut ici testerait le mutisme, pas l'AIGUILLAGE — et toute cette suite
      // deviendrait verte pour la mauvaise raison. 'LOW_BATTERY' (4 par AN) est
      // representatif d'une alerte qui doit passer.
      type = 'LOW_BATTERY',
      escalationTarget = null,
    } = opts;
    const rollout = 'rollout' in opts ? opts.rollout : 'SUPER_ADMIN_ONLY';

    const alert = {
      id: 'alert-1',
      fleetId: 'f1',
      vehicleId: 'v1',
      type,
      severity,
      title: 'Batterie faible',
      message: 'Tension < 11,5 V',
      createdAt: new Date('2026-07-27T12:23:00Z'),
      acknowledgedAt: null,
      escalatedAt: null,
      vehicle: { plate: 'TE002ST' },
    };

    const sendToUser = jest.fn().mockResolvedValue({ sent: 1, failed: 0, results: [] });
    const emailSend = jest.fn().mockResolvedValue(undefined);
    const smsSend = jest.fn().mockResolvedValue({ ok: true });
    const prefFindMany = jest.fn().mockResolvedValue(preferences);
    const userFindFirst = jest.fn().mockResolvedValue(escalationTarget);
    const deliveryCreate = jest.fn().mockResolvedValue({});
    const throttleEvaluate = jest.fn().mockResolvedValue(new Map());

    // Le service interroge `user.findMany` trois fois avec des `where` differents :
    //   1. les MEMBRES ACTIFS de la flotte (plus les FLEET_ADMIN en dur : depuis
    //      l'ouverture du reglage, c'est `receivesFleetAlerts` qui decide, avec un
    //      defaut par role qui reproduit l'ancien comportement) ;
    //   2. le filtre tenant strict sur les ids retenus ;
    //   3. les SUPER_ADMIN (cross-flotte).
    // On repond selon le `where` pour verifier que chaque liste reste bien separee.
    const userFindMany = jest.fn(async (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (where.role === UserRole.SUPER_ADMIN) return superAdmins;
      const ids = (where.id as { in?: string[] } | undefined)?.in ?? [];
      if (ids.length > 0) {
        // Filtre tenant strict reproduit fidelement : id ∈ liste ET meme flotte.
        return fleetAdmins.filter((u) => ids.includes(u.id as string) && u.fleetId === where.fleetId);
      }
      // Membres de la flotte : aucune preference en base ici, donc le defaut par role
      // s'applique — seuls les FLEET_ADMIN sont retenus, comme avant.
      return fleetAdmins.filter((u) => u.fleetId === where.fleetId);
    });

    const prisma = {
      alertRule: {
        findMany: jest.fn().mockResolvedValue(
          ruleChannels === null
            ? []
            : [{ id: 'r1', fleetId: 'f1', vehicleId: null, alertType: '*', enabled: true, channels: ruleChannels }],
        ),
      },
      user: { findMany: userFindMany, findFirst: userFindFirst },
      smsLog: { findFirst: jest.fn().mockResolvedValue(null) },
      surveillanceProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      notificationPreference: { findMany: prefFindMany },
      notificationDelivery: { create: deliveryCreate, findMany: jest.fn().mockResolvedValue([]) },
    };

    const build = async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          NotificationDispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: WebPushService, useValue: { sendToUser } },
          { provide: EmailService, useValue: { send: emailSend, buildAlertEmail: jest.fn().mockReturnValue('<html/>') } },
          { provide: SmsGatewayService, useValue: { send: smsSend } },
          { provide: ErrorLogger, useValue: { recordBackground: jest.fn(), record: jest.fn() } },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(rollout) } },
          // Anti-spam neutre par defaut (map vide = aucune retenue) : ces tests-la
          // portent sur l'AIGUILLAGE. Les garde-fous ont leur propre suite plus bas,
          // avec le vrai service branche.
          { provide: NotificationThrottleService, useValue: { evaluate: throttleEvaluate } },
        ],
      }).compile();
      return moduleRef.get(NotificationDispatchService);
    };

    return { alert, build, sendToUser, emailSend, smsSend, prefFindMany, userFindMany, userFindFirst, deliveryCreate, throttleEvaluate };
  }

  it('cause #1 + #3 — pousse au SUPER_ADMIN alors que la seule regle liste EMAIL/WHATSAPP', async () => {
    // Configuration EXACTE de la prod : une regle sans 'WEB_PUSH', et un
    // super-admin sans flotte. Avant le correctif : zero push.
    const t = setup({ ruleChannels: ['EMAIL', 'WHATSAPP'], superAdmins: [superAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.sendToUser.mock.calls[0][0]).toBe(superAdmin.id);
  });

  it('cause #3 — le controle de flotte est neutralise pour le SUPER_ADMIN (sinon WebPush le bloque)', async () => {
    // `sendToUser(userId, payload, expectedFleetId)` refuse l'envoi quand la
    // flotte de l'user differe. Un super-admin ayant fleetId = NULL, passer
    // alert.fleetId le ferait rejeter en « cross-tenant block » : le push
    // partirait du dispatch mais mourrait une couche plus bas.
    const t = setup({ superAdmins: [superAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser.mock.calls[0][2]).toBeNull();
  });

  it('cause #2 — aucune AlertRule : le push part, les canaux payants restent muets', async () => {
    // 3 flottes sur 4 sont dans ce cas. Le defaut doit reveiller le push SANS
    // declencher d'e-mail/WhatsApp/SMS non voulus a des clients.
    const t = setup({ ruleChannels: null, superAdmins: [superAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.emailSend).not.toHaveBeenCalled();
    expect(t.smsSend).not.toHaveBeenCalled();
  });

  it('le SUPER_ADMIN cross-flotte recoit le PUSH et rien d autre (pas d e-mail ni de SMS)', async () => {
    const t = setup({ ruleChannels: ['EMAIL', 'WHATSAPP', 'SMS'], superAdmins: [superAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.emailSend).not.toHaveBeenCalled();
    expect(t.smsSend).not.toHaveBeenCalled();
  });

  it('cas coupe — preference pushEnabled=false : aucun push', async () => {
    const t = setup({
      superAdmins: [superAdmin],
      preferences: [{ userId: superAdmin.id, pushEnabled: false, minSeverity: 'CRITICAL', mutedTypes: [] }],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
  });

  it('seuil de severite — une INFO est ignoree au defaut, sans ligne en base', async () => {
    // C'est CE filtre qui rend le push tenable : il retient les alertes de conduite
    // (freinage, acceleration, virage brusque, arret prolonge), dont le volume n'a
    // meme pas ete mesure sur 30 jours — et un volume inconnu n'a rien a faire dans
    // ce qui part vers un telephone.
    const t = setup({ superAdmins: [superAdmin], severity: 'INFO', preferences: [] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
  });

  it('INVARIANT — le defaut du dispatch est CELUI de l ecran de reglages, jamais une copie', async () => {
    // ⚠️ Le piege que ce test verrouille, et qu'aucun autre ne voit : le dispatch gardait
    // sa propre constante de defaut, qui avait deja derive du defaut servi par
    // `GET /notifications/preferences` (seuil `critical` cote envoi, `warning` cote ecran).
    // Resultat pour les 4 super-admin de production, tous SANS ligne de preference :
    // l'ecran annoncait « a partir de : avertissement », ils testaient une batterie faible
    // — WARNING, 4 par AN, exactement l'alerte qu'on veut voir arriver — et ne recevaient
    // rien. Un ecran qui promet une livraison que le serveur refuse, c'est-a-dire le bug
    // d'origine remis a l'envers, et invisible sans lire les deux fichiers cote a cote.
    const shown = defaultPushPreference();
    const t = setup({
      superAdmins: [superAdmin],
      type: 'LOW_BATTERY',
      severity: 'WARNING',
      preferences: [],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    // Le type n'est pas coupe par defaut et la severite atteint le seuil ANNONCE :
    // le push doit donc partir pour de vrai.
    expect(shown.mutedTypes).not.toContain('LOW_BATTERY');
    expect(shown.minSeverity).toBe('warning');
    expect(t.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('seuil de severite — la meme WARNING passe si l utilisateur abaisse son seuil', async () => {
    // Conversion MAJUSCULES (enum Prisma) -> minuscules (contrat partage) : si
    // elle manquait, la comparaison echouerait et ce test resterait rouge.
    const t = setup({
      superAdmins: [superAdmin],
      severity: 'WARNING',
      preferences: [{ userId: superAdmin.id, pushEnabled: true, minSeverity: 'WARNING', mutedTypes: [] }],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('type coupe — mutedTypes bloque le push meme pour une alerte CRITICAL', async () => {
    // Type volontairement HORS liste coupee par defaut : ce qui bloque ici doit etre le
    // choix explicite de l'utilisateur, pas le defaut — sinon le test passerait meme si
    // `mutedTypes` n'etait jamais lu.
    const t = setup({
      superAdmins: [superAdmin],
      type: 'LOW_BATTERY',
      preferences: [{ userId: superAdmin.id, pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: ['LOW_BATTERY'] }],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
  });

  it('PUSH_ROLLOUT=SUPER_ADMIN_ONLY — pas de push pour un FLEET_ADMIN, mais son e-mail part toujours', async () => {
    // Non-regression : le rollout coupe le PUSH, jamais les canaux existants.
    const t = setup({ rollout: 'SUPER_ADMIN_ONLY', ruleChannels: ['EMAIL'], fleetAdmins: [fleetAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.emailSend).toHaveBeenCalledTimes(1);
  });

  it('PUSH_ROLLOUT=ALL — le FLEET_ADMIN recoit le push, scope a SA flotte', async () => {
    const t = setup({ rollout: 'ALL', ruleChannels: ['EMAIL'], fleetAdmins: [fleetAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.sendToUser.mock.calls[0][0]).toBe(fleetAdmin.id);
    // Le garde-fou cross-tenant reste ARME pour tous les roles de flotte.
    expect(t.sendToUser.mock.calls[0][2]).toBe('f1');
  });

  it.each([[undefined], ['all'], ['SUPER_ADMIN'], ['']])(
    'PUSH_ROLLOUT invalide (%p) — traite comme SUPER_ADMIN_ONLY, jamais comme ALL',
    async (rollout) => {
      // Une variable absente ou mal orthographiee ne doit JAMAIS ajouter de
      // destinataires : le pire cas acceptable est le silence, pas l'envoi massif.
      const t = setup({ rollout, fleetAdmins: [fleetAdmin] });
      const dispatch = await t.build();

      await dispatch.dispatchAlert(t.alert as never);

      expect(t.sendToUser).not.toHaveBeenCalled();
    },
  );

  it('les preferences sont chargees en UNE seule requete pour tous les destinataires', async () => {
    // Le dispatch tourne sur chaque alerte (~580/semaine) : une requete par
    // destinataire serait un aller-retour DB gratuit a chaque envoi.
    const secondAdmin = { ...fleetAdmin, id: 'fa-0002', email: 'second@mhcars.test' };
    const t = setup({
      rollout: 'ALL',
      fleetAdmins: [fleetAdmin, secondAdmin],
      superAdmins: [superAdmin],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.prefFindMany).toHaveBeenCalledTimes(1);
    expect(t.prefFindMany.mock.calls[0][0].where.userId.in).toEqual(
      expect.arrayContaining([fleetAdmin.id, secondAdmin.id, superAdmin.id]),
    );
    expect(t.sendToUser).toHaveBeenCalledTimes(3);
  });

  it('aucune fuite inter-flotte — un FLEET_ADMIN d une AUTRE flotte n est jamais destinataire', async () => {
    const otherFleetAdmin = { ...fleetAdmin, id: 'fa-0003', email: 'admin@autre.test', fleetId: 'f2' };
    const t = setup({ rollout: 'ALL', fleetAdmins: [fleetAdmin, otherFleetAdmin] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.sendToUser.mock.calls[0][0]).toBe(fleetAdmin.id);
  });

  it('preferences illisibles (table absente) — on retombe sur le defaut au lieu de tout perdre', async () => {
    // Une panne de lecture des preferences ne doit pas emporter avec elle les
    // e-mails et les SMS, qui eux fonctionnent.
    const t = setup({ ruleChannels: ['EMAIL'], superAdmins: [superAdmin], fleetAdmins: [fleetAdmin] });
    t.prefFindMany.mockRejectedValue(new Error('relation "notification_preferences" does not exist'));
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    // Defaut applique : l'alerte est CRITICAL, le super-admin la recoit.
    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.sendToUser.mock.calls[0][0]).toBe(superAdmin.id);
    // Et le canal e-mail du FLEET_ADMIN n'a pas ete sacrifie.
    expect(t.emailSend).toHaveBeenCalledTimes(1);
  });

  it('un SUPER_ADMIN membre de la flotte garde son perimetre FLEET — il ne PERD pas son e-mail', async () => {
    // Non-regression sur la deduplication : le correctif ajoute les SUPER_ADMIN en
    // perimetre 'GLOBAL' (push seul). Si cet ajout ECRASAIT l'entree d'un super-admin
    // qui appartient VRAIMENT a la flotte, on lui retirerait en silence des e-mails
    // qu'il recoit aujourd'hui — une regression payante, invisible, et exactement le
    // genre de detail qu'aucun test ne rattrape apres coup.
    const memberSuperAdmin = {
      id: 'sa-0002',
      email: 'sa-membre@mhcars.test',
      phone: '+33600000003',
      fleetId: 'f1',
      role: UserRole.SUPER_ADMIN,
      isActive: true,
      // Choix EXPLICITE de recevoir les alertes de sa flotte. Sans lui, le défaut du
      // rôle SUPER_ADMIN vaut « non » — et c'était déjà le cas AVANT ce réglage, la
      // requête filtrant `role: FLEET_ADMIN`. L'ancien mock renvoyait pourtant ce
      // super-admin depuis cette requête : le test passait pour une mauvaise raison.
      // Il teste désormais la vraie capacité nouvelle — pouvoir être destinataire.
      notificationPreference: { receivesFleetAlerts: true },
    };
    const t = setup({
      ruleChannels: ['EMAIL'],
      fleetAdmins: [memberSuperAdmin],
      superAdmins: [memberSuperAdmin],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.emailSend).toHaveBeenCalledTimes(1);
    // Un seul push malgre sa presence dans les DEUX listes (pas de doublon sur son tel).
    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    // Et comme il est membre de la flotte, le garde-fou cross-tenant reste ARME.
    expect(t.sendToUser.mock.calls[0][2]).toBe('f1');
  });

  // ─── Escalade : la meme porte, sinon c'est un trou dans le rollout ─────────
  //
  // L'escalade rejoue un dispatch complet sur une alerte CRITICAL non acquittee.
  // Sans la meme porte push, elle pousserait a des roles hors perimetre et a des
  // utilisateurs ayant coupe leurs notifications — le rollout ne servirait plus a rien.

  const escalationAdmin = {
    id: 'fa-0010',
    email: 'admin@mhcars.test',
    fleetId: 'f1',
    role: UserRole.FLEET_ADMIN,
    isActive: true,
    escalationContactUserId: 'esc-1',
  };
  const escalationContact = {
    id: 'esc-1',
    email: 'contact@mhcars.test',
    phone: '+33600000009',
    fleetId: 'f1',
    role: UserRole.FLEET_MANAGER,
    isActive: true,
  };

  it('escalade — PUSH_ROLLOUT=SUPER_ADMIN_ONLY coupe le push d escalade, pas l e-mail d escalade', async () => {
    const t = setup({
      ruleChannels: ['EMAIL'],
      fleetAdmins: [escalationAdmin],
      escalationTarget: escalationContact,
    });
    const dispatch = await t.build();

    await dispatch.dispatchEscalation(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.emailSend).toHaveBeenCalledTimes(1);
  });

  it('escalade — PUSH_ROLLOUT=ALL : le push part, scope a la flotte de l alerte', async () => {
    const t = setup({
      rollout: 'ALL',
      ruleChannels: ['EMAIL'],
      fleetAdmins: [escalationAdmin],
      escalationTarget: escalationContact,
    });
    const dispatch = await t.build();

    await dispatch.dispatchEscalation(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.sendToUser.mock.calls[0][0]).toBe(escalationContact.id);
    // Cible d'escalade = membre de la flotte : le controle cross-tenant reste ARME.
    expect(t.sendToUser.mock.calls[0][2]).toBe('f1');
  });

  it('escalade — preference coupee : aucun push, mais l e-mail d escalade part toujours', async () => {
    const t = setup({
      rollout: 'ALL',
      ruleChannels: ['EMAIL'],
      fleetAdmins: [escalationAdmin],
      escalationTarget: escalationContact,
      preferences: [
        { userId: escalationContact.id, pushEnabled: false, minSeverity: 'CRITICAL', mutedTypes: [] },
      ],
    });
    const dispatch = await t.build();

    await dispatch.dispatchEscalation(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.emailSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * GARDE-FOUS ANTI-SPAM + TRACAGE — le vrai `NotificationThrottleService` est branche.
 *
 * Ces tests rejouent les volumes MESURES en production le 2026-07-27 (30 jours) :
 *   POWER_CUT 330/jour, OVERSPEED 164/jour, SOS 3 par AN.
 * Deux exigences se tiennent en tension et sont verifiees ensemble :
 *   1. le telephone ne doit pas vibrer 500 fois par jour ;
 *   2. RIEN ne doit disparaitre en silence — chaque retenue laisse une ligne avec sa
 *      raison, sinon on remplace le bug d'origine (un silence invisible) par un autre.
 */
describe('NotificationDispatchService — garde-fous anti-spam et tracage', () => {
  const superAdmin = {
    id: 'sa-0001',
    email: 'owner@vizyo.test',
    fleetId: null,
    role: UserRole.SUPER_ADMIN,
    isActive: true,
  };

  interface GuardOpts {
    type?: string;
    severity?: string;
    vehicleId?: string | null;
    preferences?: Array<Record<string, unknown>>;
    /** Lignes de `notification_deliveries` que la requete du throttle renverrait. */
    deliveries?: Array<{ userId: string; status: string; alertId: string | null; alertType: string; createdAt: Date }>;
    /** Vehicule de chaque alerte citee par ces lignes (le journal ne stocke pas le vehicule). */
    alertVehicles?: Record<string, string | null>;
    sendResult?: { sent: number; failed: number; results: Array<Record<string, unknown>> };
    sendThrows?: Error;
    recipients?: Array<Record<string, unknown>>;
    rollout?: string;
    ruleChannels?: string[];
  }

  function setup(opts: GuardOpts = {}) {
    const {
      type = 'POWER_CUT',
      severity = 'CRITICAL',
      vehicleId = 'v1',
      // Une ligne EXISTANTE qui rallume tout : sans elle, POWER_CUT serait coupe par
      // defaut et aucun garde-fou de debit ne serait jamais atteint.
      preferences = [{ userId: superAdmin.id, pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] }],
      deliveries = [],
      alertVehicles = {},
      sendResult = { sent: 1, failed: 0, results: [{ id: 's1', endpointHost: 'fcm.googleapis.com', statusCode: 201 }] },
      sendThrows,
      recipients = [superAdmin],
      rollout = 'SUPER_ADMIN_ONLY',
      ruleChannels = ['EMAIL'],
    } = opts;

    const alert = {
      id: 'alert-now',
      fleetId: 'f1',
      vehicleId,
      type,
      severity,
      title: 'Coupure d alimentation',
      message: 'Alimentation coupee',
      createdAt: new Date(),
      acknowledgedAt: null,
      escalatedAt: null,
      vehicle: { plate: 'TE002ST' },
    };

    const sendToUser = sendThrows
      ? jest.fn().mockRejectedValue(sendThrows)
      : jest.fn().mockResolvedValue(sendResult);
    const deliveryCreate = jest.fn().mockResolvedValue({});
    const deliveryFindMany = jest.fn().mockResolvedValue(deliveries);
    // Qualification du vehicule : reproduit fidelement le filtre SQL
    // `id IN (...) AND vehicleId = <celui de l'alerte>`.
    const alertFindMany = jest.fn(async (args: { where?: { id?: { in?: string[] }; vehicleId?: string | null } }) => {
      const ids = args?.where?.id?.in ?? [];
      const wanted = args?.where?.vehicleId ?? null;
      return ids.filter((id) => (alertVehicles[id] ?? null) === wanted).map((id) => ({ id }));
    });
    const emailSend = jest.fn().mockResolvedValue(undefined);

    const prisma = {
      alertRule: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', fleetId: 'f1', vehicleId: null, alertType: '*', enabled: true, channels: ruleChannels },
        ]),
      },
      user: {
        findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
          const where = args?.where ?? {};
          if (where.role === UserRole.SUPER_ADMIN) return recipients.filter((u) => u.role === UserRole.SUPER_ADMIN);
          // Membres ACTIFS de la flotte : le destinataire n'est plus décidé par un
          // `where role: FLEET_ADMIN` mais par `receivesFleetAlerts` (défaut par rôle).
          // On rend donc les membres de la flotte, et c'est le service qui trie.
          const ids0 = (where.id as { in?: string[] } | undefined)?.in ?? [];
          if (ids0.length === 0 && where.fleetId) {
            return recipients.filter((u) => u.fleetId === where.fleetId);
          }
          const ids = (where.id as { in?: string[] } | undefined)?.in ?? [];
          return recipients.filter((u) => ids.includes(u.id as string) && u.fleetId === where.fleetId);
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      smsLog: { findFirst: jest.fn().mockResolvedValue(null) },
      surveillanceProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      notificationPreference: { findMany: jest.fn().mockResolvedValue(preferences) },
      notificationDelivery: { create: deliveryCreate, findMany: deliveryFindMany },
      alert: { findMany: alertFindMany },
    };

    const build = async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          NotificationDispatchService,
          // Le VRAI service anti-spam : c'est la chaine complete (preferences ->
          // cooldown -> plafond -> journal) qu'on veut voir fonctionner, pas un mock
          // qui repondrait toujours oui.
          NotificationThrottleService,
          { provide: PrismaService, useValue: prisma },
          { provide: WebPushService, useValue: { sendToUser } },
          { provide: EmailService, useValue: { send: emailSend, buildAlertEmail: jest.fn().mockReturnValue('<html/>') } },
          { provide: SmsGatewayService, useValue: { send: jest.fn() } },
          { provide: ErrorLogger, useValue: { recordBackground: jest.fn(), record: jest.fn() } },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(rollout) } },
        ],
      }).compile();
      return moduleRef.get(NotificationDispatchService);
    };

    /** Lignes reellement ecrites en base, dans l'ordre. */
    const rows = () => deliveryCreate.mock.calls.map((c) => c[0].data as Record<string, unknown>);

    return { alert, build, sendToUser, emailSend, deliveryCreate, deliveryFindMany, alertFindMany, rows };
  }

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it('envoi normal — une ligne SENT reprenant les compteurs reels de WebPushService', async () => {
    // Le dispatch ne recompte rien : `SendResult` fait deja foi (il a purge les
    // abonnements morts en 410). Un second comptage local aurait diverge.
    const t = setup({
      sendResult: {
        sent: 2,
        failed: 1,
        results: [
          { id: 'a', endpointHost: 'fcm.googleapis.com', statusCode: 201 },
          { id: 'b', endpointHost: 'web.push.apple.com', statusCode: 201 },
          { id: 'c', endpointHost: 'fcm.googleapis.com', statusCode: 502, error: 'bad gateway' },
        ],
      },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({
      status: 'SENT',
      channel: 'WEB_PUSH',
      userId: superAdmin.id,
      alertType: 'POWER_CUT',
      severity: 'CRITICAL',
      deviceCount: 3,
      sentCount: 2,
      failedCount: 1,
      groupedCount: 0,
      // Envoi cross-flotte a un SUPER_ADMIN : la ligne n'appartient a aucune flotte.
      fleetId: null,
    });
    expect(t.rows()[0].title).toContain('TE002ST');
  });

  it('POWER_CUT sans ligne de preference — coupe PAR DEFAUT, et la retenue est TRACEE', async () => {
    // Le cas qui dicte tout ce lot : 9 903 POWER_CUT en 30 jours, tous CRITICAL, tous
    // issus d'une coupure de contact normale lue comme une alarme. Sans coupure par
    // defaut, le push repare devient 330 vibrations par jour.
    const t = setup({ type: 'POWER_CUT', preferences: [] });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({
      status: 'SUPPRESSED',
      reason: 'preference_type_muted',
      alertType: 'POWER_CUT',
    });
    // La ligne porte le contenu qui AURAIT ete pousse : l'ecran d'administration doit
    // pouvoir montrer ce que l'utilisateur n'a pas vu.
    expect(t.rows()[0].title).toContain('Coupure d alimentation');
  });

  it('mutedTypes: [] est un choix EXPLICITE — le defaut ne se re-applique pas par-dessus', async () => {
    // Piege du lot : appliquer DEFAULT_MUTED_TYPES a une ligne existante rendrait le
    // reglage « rallumer POWER_CUT » inoperant, sans aucun message d'erreur.
    const t = setup({
      type: 'POWER_CUT',
      preferences: [{ userId: superAdmin.id, pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] }],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('cooldown — un push recent sur le MEME type et le MEME vehicule replie l evenement', async () => {
    const t = setup({
      deliveries: [
        { userId: superAdmin.id, status: 'SENT', alertId: 'alert-old', alertType: 'POWER_CUT', createdAt: minutesAgo(3) },
      ],
      alertVehicles: { 'alert-old': 'v1' },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    // ⚠️ L'evenement n'est pas jete : il est COMPTE (rang 1 du repli en cours).
    expect(t.rows()[0]).toMatchObject({ status: 'GROUPED', reason: 'cooldown', groupedCount: 1 });
  });

  it('cooldown — le rang repart a 1 apres un envoi qui a solde les replis precedents', async () => {
    // ⚠️ Regression, cote journal cette fois : les GROUPED restent lisibles 15 minutes,
    // mais celui-la a deja ete annonce par le push d'il y a 2 minutes. La ligne ecrite doit
    // dire « 1 » (premier retenu depuis cet envoi), pas « 3 ».
    const t = setup({
      deliveries: [
        { userId: superAdmin.id, status: 'GROUPED', alertId: 'g1', alertType: 'POWER_CUT', createdAt: minutesAgo(9) },
        { userId: superAdmin.id, status: 'GROUPED', alertId: 'g2', alertType: 'POWER_CUT', createdAt: minutesAgo(5) },
        { userId: superAdmin.id, status: 'SENT', alertId: 'alert-sent', alertType: 'POWER_CUT', createdAt: minutesAgo(2) },
      ],
      alertVehicles: { g1: 'v1', g2: 'v1', 'alert-sent': 'v1' },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.rows()[0]).toMatchObject({ status: 'GROUPED', reason: 'cooldown', groupedCount: 1 });
  });

  it('cooldown — un push recent sur un AUTRE vehicule ne rend pas le second muet', async () => {
    // Sans la dimension vehicule, une coupure sur le camion A masquerait la meme coupure
    // sur le camion B pendant 15 minutes : le garde-fou detruirait de l'information au
    // lieu de la doser.
    const t = setup({
      vehicleId: 'v2',
      deliveries: [
        { userId: superAdmin.id, status: 'SENT', alertId: 'alert-old', alertType: 'POWER_CUT', createdAt: minutesAgo(3) },
      ],
      alertVehicles: { 'alert-old': 'v1' },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('cooldown expire — le push suivant SOLDE les evenements replies et l annonce « ×N »', async () => {
    // Le dernier envoi est hors fenetre (20 min) ; deux evenements ont ete replies
    // depuis. Le push qui part doit dire qu'il en represente trois.
    const t = setup({
      deliveries: [
        { userId: superAdmin.id, status: 'GROUPED', alertId: 'g1', alertType: 'POWER_CUT', createdAt: minutesAgo(9) },
        { userId: superAdmin.id, status: 'GROUPED', alertId: 'g2', alertType: 'POWER_CUT', createdAt: minutesAgo(4) },
      ],
      alertVehicles: { g1: 'v1', g2: 'v1' },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    const payload = t.sendToUser.mock.calls[0][1] as { title: string; body: string };
    expect(payload.title).toContain('×3');
    expect(payload.body).toContain('3 evenements');
    expect(t.rows()[0]).toMatchObject({ status: 'SENT', groupedCount: 2 });
  });

  it('plafond horaire — 12 push dans l heure : le 13e est retenu et trace', async () => {
    const t = setup({
      deliveries: Array.from({ length: 12 }, (_, i) => ({
        userId: superAdmin.id,
        status: 'SENT',
        alertId: `other-${i}`,
        // Types varies : le plafond est ABSOLU, tous types confondus.
        alertType: 'GEOFENCE_ENTER',
        createdAt: minutesAgo(50 - i),
      })),
      alertVehicles: {},
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.rows()[0]).toMatchObject({ status: 'SUPPRESSED', reason: 'hourly_cap' });
  });

  it('SOS traverse le plafond horaire — un appel au secours n est jamais avale par un compteur', async () => {
    // SOS : 3 par AN. Il ne genera jamais personne, et le jour ou il tombe, aucun
    // compteur ne doit avoir le dernier mot.
    const t = setup({
      type: 'SOS',
      deliveries: Array.from({ length: 20 }, (_, i) => ({
        userId: superAdmin.id,
        status: 'SENT',
        alertId: `other-${i}`,
        alertType: 'OVERSPEED',
        createdAt: minutesAgo(50 - i),
      })),
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.rows()[0]).toMatchObject({ status: 'SENT' });
  });

  it('SOS reste soumis au cooldown — un bouton bloque ne doit pas vibrer en boucle', async () => {
    // Contrepartie assumee du test precedent : le plafond est contourne, donc si le
    // cooldown l'etait aussi, un capteur en defaut aurait un chemin sans AUCUNE borne.
    const t = setup({
      type: 'SOS',
      deliveries: [
        { userId: superAdmin.id, status: 'SENT', alertId: 'sos-old', alertType: 'SOS', createdAt: minutesAgo(2) },
      ],
      alertVehicles: { 'sos-old': 'v1' },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.rows()[0]).toMatchObject({ status: 'GROUPED', reason: 'cooldown' });
  });

  it('escalade — ignore le cooldown : le signal existe justement parce que personne n a acquitte', async () => {
    const t = setup({
      recipients: [
        { id: 'fa-1', email: 'admin@f1.test', fleetId: 'f1', role: UserRole.FLEET_ADMIN, isActive: true, escalationContactUserId: 'esc-1' },
      ],
      rollout: 'ALL',
      preferences: [{ userId: 'esc-1', pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] }],
      deliveries: [
        { userId: 'esc-1', status: 'SENT', alertId: 'alert-old', alertType: 'POWER_CUT', createdAt: minutesAgo(2) },
      ],
      alertVehicles: { 'alert-old': 'v1' },
    });
    const dispatch = await t.build();
    (dispatch as unknown as { prisma: { user: { findFirst: jest.Mock } } }).prisma.user.findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'esc-1', email: 'contact@f1.test', fleetId: 'f1', role: UserRole.FLEET_MANAGER, isActive: true });

    await dispatch.dispatchEscalation(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
    expect(t.rows()[0]).toMatchObject({ status: 'SENT' });
  });

  it('aucun appareil abonne — SUPPRESSED/no_device, jamais range dans les echecs', async () => {
    // C'est la premiere chose a verifier quand quelqu'un dit « je ne recois rien ». La
    // compter comme une panne noierait les vraies pannes dans du bruit previsible.
    const t = setup({ sendResult: { sent: 0, failed: 0, results: [] } });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.rows()[0]).toMatchObject({ status: 'SUPPRESSED', reason: 'no_device', deviceCount: 0 });
  });

  it('tous les appareils en echec — FAILED avec le detail HTTP', async () => {
    const t = setup({
      sendResult: {
        sent: 0,
        failed: 1,
        results: [{ id: 'a', endpointHost: 'web.push.apple.com', statusCode: 403, error: 'VAPID mismatch' }],
      },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.rows()[0]).toMatchObject({ status: 'FAILED', deviceCount: 1, sentCount: 0, failedCount: 1 });
    expect(String(t.rows()[0].reason)).toContain('403');
  });

  it('envoi qui leve — la ligne FAILED est ecrite avant que l erreur ne remonte', async () => {
    const t = setup({ sendThrows: new Error('socket hang up') });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.rows()[0]).toMatchObject({ status: 'FAILED' });
    expect(String(t.rows()[0].reason)).toContain('socket hang up');
  });

  it('refus par rollout — pas de push, et AUCUNE ligne (volume : ce serait 10 000/mois d identiques)', async () => {
    const t = setup({
      rollout: 'SUPER_ADMIN_ONLY',
      recipients: [{ id: 'fa-1', email: 'admin@f1.test', fleetId: 'f1', role: UserRole.FLEET_ADMIN, isActive: true }],
      preferences: [],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    // L'etat « le push n'est pas ouvert a ce role » est global, statique et derivable de
    // PUSH_ROLLOUT : il se lit dans un bandeau, pas dans des dizaines de milliers de
    // lignes identiques qui noieraient les retenues informatives.
    expect(t.rows()).toHaveLength(0);
  });

  it('le controle anti-spam coute UNE lecture groupee, quel que soit le nombre de destinataires', async () => {
    // Le dispatch tourne sur CHAQUE alerte (~500/jour) : une requete par destinataire
    // serait un aller-retour DB gratuit multiplie par le nombre d'admins.
    const t = setup({
      rollout: 'ALL',
      recipients: [
        { id: 'fa-1', email: 'a@f1.test', fleetId: 'f1', role: UserRole.FLEET_ADMIN, isActive: true },
        { id: 'fa-2', email: 'b@f1.test', fleetId: 'f1', role: UserRole.FLEET_ADMIN, isActive: true },
        { id: 'fa-3', email: 'c@f1.test', fleetId: 'f1', role: UserRole.FLEET_ADMIN, isActive: true },
        superAdmin,
      ],
      preferences: [
        { userId: 'fa-1', pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] },
        { userId: 'fa-2', pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] },
        { userId: 'fa-3', pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] },
        { userId: superAdmin.id, pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] },
      ],
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(4);
    expect(t.deliveryFindMany).toHaveBeenCalledTimes(1);
    const where = t.deliveryFindMany.mock.calls[0][0].where as {
      userId: { in: string[] };
      channel: string;
      createdAt: { gte: Date };
    };
    expect(where.userId.in).toEqual(expect.arrayContaining(['fa-1', 'fa-2', 'fa-3', superAdmin.id]));
    expect(where.channel).toBe('WEB_PUSH');
    // Fenetre bornee dans le temps : la requete ne peut pas se mettre a scanner tout
    // l'historique le jour ou la table aura grossi.
    expect(Date.now() - where.createdAt.gte.getTime()).toBeLessThanOrEqual(60 * 60_000 + 5_000);
    // Une seule qualification de vehicule, pas une par destinataire.
    expect(t.alertFindMany.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('les canaux payants ne sont JAMAIS brides — cooldown actif, l e-mail part quand meme', async () => {
    // Regle non negociable : les garde-fous anti-spam s'appliquent au PUSH seul.
    const t = setup({
      rollout: 'ALL',
      ruleChannels: ['EMAIL'],
      recipients: [{ id: 'fa-1', email: 'admin@f1.test', fleetId: 'f1', role: UserRole.FLEET_ADMIN, isActive: true }],
      preferences: [{ userId: 'fa-1', pushEnabled: true, minSeverity: 'CRITICAL', mutedTypes: [] }],
      deliveries: [
        { userId: 'fa-1', status: 'SENT', alertId: 'alert-old', alertType: 'POWER_CUT', createdAt: minutesAgo(1) },
      ],
      alertVehicles: { 'alert-old': 'v1' },
    });
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).not.toHaveBeenCalled();
    expect(t.emailSend).toHaveBeenCalledTimes(1);
  });

  it('journal en panne — le push part quand meme (un garde-fou ne doit pas creer un nouveau silence)', async () => {
    const t = setup();
    t.deliveryCreate.mockRejectedValue(new Error('relation "notification_deliveries" does not exist'));
    const dispatch = await t.build();

    await dispatch.dispatchAlert(t.alert as never);

    expect(t.sendToUser).toHaveBeenCalledTimes(1);
  });

  /**
   * QUI EST PREVENU — le reglage qui n'existait pas.
   *
   * La liste des destinataires etait CODEE EN DUR : tous les FLEET_ADMIN, personne
   * d'autre. Constat prod 2026-07-28 : la flotte cdef31 comptait 6 utilisateurs actifs
   * et 1 seul destinataire — un responsable d'astreinte ou un veilleur de nuit ne
   * pouvait pas etre prevenu, et son administrateur n'y pouvait rien.
   *
   * Le premier test est le plus important : l'ouverture du reglage ne doit RIEN changer
   * tant que personne n'y touche.
   */
  describe('destinataires reglables', () => {
    it('⚠️ un SUPER_ADMIN garde son push GLOBAL par defaut (sinon on casse le deploiement en cours)', async () => {
      const t = setup({ rollout: 'SUPER_ADMIN_ONLY', recipients: [superAdmin] });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      expect(t.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('un SUPER_ADMIN qui se retire EXPLICITEMENT ne recoit plus rien', async () => {
      const t = setup({
        rollout: 'SUPER_ADMIN_ONLY',
        recipients: [{ ...superAdmin, notificationPreference: { receivesFleetAlerts: false } }],
      });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      // Sans ce test, l'interrupteur serait visible a l'ecran et sans aucun effet.
      expect(t.sendToUser).not.toHaveBeenCalled();
    });

    const membre = (over: Record<string, unknown>) => ({
      id: 'x', email: 'x@f1.test', fleetId: 'f1', isActive: true, ...over,
    });

    it('⚠️ SANS aucune preference, les destinataires sont EXACTEMENT ceux d avant', async () => {
      const t = setup({
        rollout: 'ALL',
        ruleChannels: ['EMAIL'],
        recipients: [
          membre({ id: 'fa', role: UserRole.FLEET_ADMIN }),
          membre({ id: 'fm', role: UserRole.FLEET_MANAGER }),
          membre({ id: 'nw', role: UserRole.NIGHT_WATCHMAN }),
          membre({ id: 'vw', role: UserRole.VIEWER }),
        ],
      });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      // Un seul e-mail : le FLEET_ADMIN. Les trois autres restent muets, comme avant.
      expect(t.emailSend).toHaveBeenCalledTimes(1);
    });

    it('un FLEET_MANAGER qui ACTIVE le reglage devient destinataire', async () => {
      const t = setup({
        rollout: 'ALL',
        ruleChannels: ['EMAIL'],
        recipients: [
          membre({ id: 'fa', role: UserRole.FLEET_ADMIN }),
          membre({ id: 'fm', role: UserRole.FLEET_MANAGER, notificationPreference: { receivesFleetAlerts: true } }),
        ],
      });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      expect(t.emailSend).toHaveBeenCalledTimes(2);
    });

    it('un FLEET_ADMIN qui SE RETIRE cesse d etre destinataire', async () => {
      const t = setup({
        rollout: 'ALL',
        ruleChannels: ['EMAIL'],
        recipients: [
          membre({ id: 'fa', role: UserRole.FLEET_ADMIN, notificationPreference: { receivesFleetAlerts: false } }),
        ],
      });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      expect(t.emailSend).not.toHaveBeenCalled();
    });

    it('⚠️ `null` signifie « selon mon role », PAS « non »', async () => {
      const t = setup({
        rollout: 'ALL',
        ruleChannels: ['EMAIL'],
        recipients: [
          membre({ id: 'fa', role: UserRole.FLEET_ADMIN, notificationPreference: { receivesFleetAlerts: null } }),
        ],
      });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      expect(t.emailSend).toHaveBeenCalledTimes(1);
    });

    it('⚠️ aucune fuite inter-flotte : un membre d une AUTRE flotte n est jamais retenu', async () => {
      const t = setup({
        rollout: 'ALL',
        ruleChannels: ['EMAIL'],
        recipients: [
          membre({ id: 'fa', role: UserRole.FLEET_ADMIN }),
          membre({ id: 'autre', role: UserRole.FLEET_ADMIN, fleetId: 'f2',
                   notificationPreference: { receivesFleetAlerts: true } }),
        ],
      });
      const dispatch = await t.build();
      await dispatch.dispatchAlert(t.alert as never);
      expect(t.emailSend).toHaveBeenCalledTimes(1);
    });
  });

});
