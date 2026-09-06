import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { AssistanceService } from './assistance.service';

/**
 * Assistance — conversations, plafonds et archive.
 *
 * Trois propriétés y sont verrouillées, dans cet ordre d'importance :
 *   1. une conversation appartient à son auteur — un identifiant volé ne donne rien ;
 *   2. le message de l'utilisateur est enregistré AVANT tout appel : une panne ou un quota ne
 *      doit jamais faire perdre la demande, c'est elle qu'un humain reprendra ;
 *   3. les plafonds sont ANNONCÉS, pas subis.
 */
describe('AssistanceService', () => {
  const MOI = 'user-moi';

  function build(opts: {
    conv?: Record<string, unknown> | null;
    reponsesConversation?: number;
    reponsesJour?: number;
    ia?: Record<string, unknown>;
    role?: UserRole;
    fleetId?: string | null;
  } = {}) {
    const conv = opts.conv === null ? null : {
      id: 'c1', userId: MOI, fleetId: 'f1', title: 'Titre', status: 'open',
      severity: null, escalatedAt: null, createdAt: new Date(), updatedAt: new Date(),
      ...opts.conv,
    };
    let compte = 0;
    const prisma = {
      assistanceConversation: {
        create: jest.fn().mockResolvedValue(conv),
        findFirst: jest.fn().mockResolvedValue(conv),
        findUnique: jest.fn().mockResolvedValue(conv),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(conv),
      },
      assistanceMessage: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        // 1er appel = réponses de CETTE conversation, 2e = réponses du jour.
        count: jest.fn().mockImplementation(() => Promise.resolve(compte++ === 0 ? (opts.reponsesConversation ?? 0) : (opts.reponsesJour ?? 0))),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ email: 'x@y.fr', role: 'VIEWER' }),
        // Destinataires de la notification d'ouverture : les admins de la société.
        findMany: jest.fn().mockResolvedValue([]),
      },
      fleet: { findUnique: jest.fn().mockResolvedValue({ name: 'Flotte' }), findMany: jest.fn().mockResolvedValue([]) },
    };
    const ia = {
      repondre: jest.fn().mockResolvedValue({
        reponse: 'Voici la reponse.', escalade: false, motifEscalade: null, gravite: 'LOW',
        titre: 'Titre deduit', sujets: ['trajets'], contextUsed: [{ key: 'erreurs', volume: 2, refuse: false }],
        model: 'm', costUsd: 0.001, latencyMs: 800, sansIa: false,
        ...opts.ia,
      }),
    };
    const aiUsage = { eurRate: jest.fn().mockReturnValue(0.92) };
    const systemActivity = { record: jest.fn() };
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const notifications = { notifyUsers: jest.fn().mockResolvedValue(1) };
    const svc = new AssistanceService(
      prisma as never, ia as never, aiUsage as never, systemActivity as never,
      errorLogger as never, notifications as never,
    );
    const user: AuthUser = {
      id: MOI, authUserId: 'a', email: 'moi@x.fr', firstName: null, lastName: null,
      role: opts.role ?? UserRole.FLEET_MANAGER, isOwner: false,
      fleetId: opts.fleetId === undefined ? 'f1' : opts.fleetId, isActive: true, permissions: null,
    };
    return { svc, prisma, ia, systemActivity, errorLogger, notifications, user };
  }

  // ─── Propriété : la demande n'est jamais perdue ────────────────────────────

  it('enregistre le message de l\'utilisateur AVANT d\'appeler l\'IA', async () => {
    const { svc, prisma, ia, user } = build();
    const ordre: string[] = [];
    prisma.assistanceMessage.create.mockImplementation(async (a: { data: { role: string } }) => {
      ordre.push(`ecrit:${a.data.role}`);
      return {};
    });
    ia.repondre.mockImplementation(async () => {
      ordre.push('ia');
      return { reponse: 'ok', escalade: false, motifEscalade: null, gravite: 'LOW', titre: 't', sujets: [], contextUsed: [], model: 'm', costUsd: 0, latencyMs: 1, sansIa: false };
    });
    await svc.poser(user, 'ma question');
    // Si l'IA tombe, la question est déjà en base : c'est elle qu'un humain reprendra.
    expect(ordre).toEqual(['ecrit:user', 'ia', 'ecrit:assistant']);
  });

  it('refuse un message vide sans rien écrire', async () => {
    const { svc, prisma, user } = build();
    await expect(svc.poser(user, '   ')).rejects.toThrow();
    expect(prisma.assistanceMessage.create).not.toHaveBeenCalled();
  });

  it('fige la société du demandeur à la création', async () => {
    const { svc, prisma, user } = build();
    await svc.poser(user, 'question');
    expect(prisma.assistanceConversation.create.mock.calls[0][0].data).toMatchObject({ userId: MOI, fleetId: 'f1' });
  });

  // ─── Propriété : une conversation appartient à son auteur ──────────────────

  it('une conversation qui n\'est pas la mienne est INTROUVABLE (pas « interdite »)', async () => {
    const { svc, prisma, user } = build({ conv: null });
    // 404 et non 403 : distinguer les deux permettrait d'énumérer les identifiants valides.
    await expect(svc.maConversation(user, 'c-inconnue')).rejects.toThrow(/introuvable/i);
    expect(prisma.assistanceConversation.findFirst.mock.calls[0][0].where).toMatchObject({ userId: MOI });
  });

  it('la suite d\'une conversation vérifie la propriété avant d\'écrire', async () => {
    const { svc, prisma, user } = build({ conv: null });
    await expect(svc.poser(user, 'suite', 'c-volee')).rejects.toThrow(/introuvable/i);
    expect(prisma.assistanceMessage.create).not.toHaveBeenCalled();
  });

  // ─── Propriété : les plafonds sont annoncés ────────────────────────────────

  it('plafond de la conversation atteint : aucun appel IA, message explicite, escalade', async () => {
    const { svc, ia, prisma, user } = build({ reponsesConversation: 10 });
    const r = await svc.poser(user, 'encore une question');
    expect(ia.repondre).not.toHaveBeenCalled();
    expect(r.messages).toBeDefined();
    // La réponse de quota est enregistrée comme un vrai message : affichée puis perdue, elle
    // laisserait l'utilisateur sans trace de ce qu'on lui a dit.
    expect(prisma.assistanceMessage.create).toHaveBeenCalledTimes(2);
    expect(prisma.assistanceConversation.update.mock.calls[0][0].data.status).toBe('escalated');
  });

  it('plafond du JOUR atteint : aucun appel IA', async () => {
    const { svc, ia, user } = build({ reponsesConversation: 0, reponsesJour: 30 });
    await svc.poser(user, 'question');
    expect(ia.repondre).not.toHaveBeenCalled();
  });

  it('le plafond quotidien se compte sur les MESSAGES, pas sur les conversations', async () => {
    const { svc, prisma, user } = build();
    await svc.poser(user, 'question');
    const appelJour = prisma.assistanceMessage.count.mock.calls[1][0];
    // Sinon, ouvrir une conversation neuve à chaque question contournerait le plafond.
    expect(appelJour.where).toMatchObject({ role: 'assistant', conversation: { userId: MOI } });
  });

  it('annonce le nombre de réponses restantes', async () => {
    const { svc, prisma, user } = build();
    prisma.assistanceMessage.findMany.mockResolvedValue([
      { id: 'm1', createdAt: new Date(), role: 'user', content: 'q', costUsd: 0 },
      { id: 'm2', createdAt: new Date(), role: 'assistant', content: 'r', costUsd: 0 },
    ]);
    const r = await svc.poser(user, 'question');
    // Arriver à zéro sans avertissement se lit comme une panne.
    expect(r.reponsesRestantes).toBe(9);
  });

  // ─── Escalade et rappel urgent ─────────────────────────────────────────────

  it('une escalade de l\'agent est portée au centre d\'alerte', async () => {
    const { svc, errorLogger, user } = build({ ia: { escalade: true, motifEscalade: 'hors connaissance' } });
    await svc.poser(user, 'question');
    expect(errorLogger.record).toHaveBeenCalled();
  });

  // ─── TRK-070 : le niveau de l'escalade suit la CAUSE, pas la gravite ──────
  //
  // Un compte fournisseur a sec produisait DEUX lignes pour un seul incident : `DEGRADATION`
  // (l'incident, correctement classe depuis TRK-061) puis `ERROR` quatorze millisecondes plus
  // tard (l'escalade) — qui le recomptait comme un defaut. La regle de niveau ne lisait que la
  // gravite de la CONVERSATION, et ne pouvait donc pas distinguer les deux natures d'escalade.

  it('un REPLI sur un echec technique est classe au niveau de l\'incident, pas en ERROR', async () => {
    const { svc, errorLogger, user } = build({
      ia: {
        escalade: true,
        motifEscalade: 'Classement indisponible',
        gravite: 'LOW',
        causeTechnique: { niveau: 'DEGRADATION', kind: 'provider_unfunded' },
      },
    });
    await svc.poser(user, 'question');
    const [, , contexte, niveau] = errorLogger.record.mock.calls[0];
    expect(niveau).toBe('DEGRADATION');
    // La preuve est DEPLACEE, pas effacee : la ligne reste diagnosticable.
    expect(contexte).toMatchObject({ repliTechnique: true, kind: 'provider_unfunded' });
  });

  it('une escalade decidee sur le CONTENU garde ERROR — vrai signal produit', async () => {
    const { svc, errorLogger, user } = build({
      ia: { escalade: true, motifEscalade: 'hors connaissance', gravite: 'LOW' },
    });
    await svc.poser(user, 'question');
    expect(errorLogger.record.mock.calls[0][3]).toBe('ERROR');
    // Sans cause technique, rien ne doit laisser croire a un repli.
    expect(errorLogger.record.mock.calls[0][2]).not.toHaveProperty('repliTechnique');
  });

  it('DOUBLE CONDITION — la ligne d\'escalade et sa trace systeme EXISTENT toujours', async () => {
    // Si les deux disparaissaient, on aurait supprime la trace de l'escalade au lieu de la
    // classer : le compteur tomberait pour la mauvaise raison.
    const { svc, errorLogger, systemActivity, user } = build({
      ia: {
        escalade: true,
        motifEscalade: 'Redaction indisponible',
        gravite: 'LOW',
        causeTechnique: { niveau: 'DEGRADATION', kind: 'provider_unfunded' },
      },
    });
    await svc.poser(user, 'question');
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'assistance_escalade' }),
    );
  });

  it('une URGENCE reste CRITICAL meme si un appel IA a echoue en chemin', async () => {
    // L'urgence decrit le besoin de l'utilisateur ; elle prime sur la cause technique.
    const { svc, errorLogger, user } = build({
      ia: {
        escalade: true,
        motifEscalade: 'Situation critique',
        gravite: 'CRITICAL',
        causeTechnique: { niveau: 'DEGRADATION', kind: 'provider_unfunded' },
      },
    });
    await svc.poser(user, 'question');
    expect(errorLogger.record.mock.calls[0][3]).toBe('CRITICAL');
  });

  it('le rappel urgent n\'appelle PAS l\'IA et alerte en CRITICAL', async () => {
    const { svc, ia, errorLogger, systemActivity, user } = build();
    await svc.rappelUrgent(user, 'c1', 'camion vole');
    // Le jour où quelqu'un a vraiment besoin d'un humain est le pire jour pour lui opposer un quota.
    expect(ia.repondre).not.toHaveBeenCalled();
    expect(errorLogger.record.mock.calls[0][3]).toBe('CRITICAL');
    expect(systemActivity.record.mock.calls[0][0].action).toBe('assistance_rappel_urgent');
  });

  // ─── Notifications ─────────────────────────────────────────────────────────

  describe('notifications', () => {
    it('prévient les admins de la société à l’OUVERTURE, pas à chaque message', async () => {
      const { svc, prisma, notifications, user } = build();
      prisma.user.findMany = jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

      await svc.poser(user, 'premiere question');
      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUsers.mock.calls[0][0]).toMatchObject({
        userIds: ['admin-1', 'admin-2'], category: 'ASSISTANCE', kind: 'nouvelle', fleetId: 'f1',
      });

      notifications.notifyUsers.mockClear();
      await svc.poser(user, 'question de suite', 'c1');
      // Une conversation de dix échanges ne doit pas produire dix notifications.
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('n’avertit jamais l’auteur de sa propre demande', async () => {
      const { svc, prisma, user } = build();
      prisma.user.findMany = jest.fn().mockResolvedValue([]);
      await svc.poser(user, 'question');
      expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ id: { not: MOI } });
    });

    it('sans société, ne prévient PERSONNE (prévenir tous les admins serait une fuite)', async () => {
      const { svc, notifications, user } = build({ fleetId: null });
      await svc.poser(user, 'question');
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('l’anti-spam est cloisonné par conversation', async () => {
      const { svc, prisma, notifications, user } = build();
      prisma.user.findMany = jest.fn().mockResolvedValue([{ id: 'admin-1' }]);
      await svc.poser(user, 'question');
      // Deux demandes différentes le même jour doivent produire deux notifications.
      expect(notifications.notifyUsers.mock.calls[0][0].subjectKey).toBe('c1');
    });

    it('quand un humain répond, c’est l’AUTEUR qui est prévenu — pas la flotte', async () => {
      const { svc, notifications, user } = build({ role: UserRole.FLEET_ADMIN });
      await svc.repondreEnHumain(user, 'c1', 'Bonjour, je reprends votre demande.');
      expect(notifications.notifyUsers.mock.calls[0][0]).toMatchObject({
        userIds: [MOI], category: 'ASSISTANCE', kind: 'reprise', fleetId: 'f1',
      });
    });

    it('une notification en échec n’empêche pas de demander de l’aide', async () => {
      const { svc, prisma, notifications, user } = build();
      prisma.user.findMany = jest.fn().mockResolvedValue([{ id: 'admin-1' }]);
      notifications.notifyUsers.mockRejectedValue(new Error('push casse'));
      // Best-effort de bout en bout : le canal d'aide ne dépend pas du canal d'avertissement.
      await expect(svc.poser(user, 'question')).resolves.toBeDefined();
    });
  });

  // ─── Archive admin ─────────────────────────────────────────────────────────

  it('un admin de société ne voit que sa société', async () => {
    const { svc, prisma, user } = build({ role: UserRole.FLEET_ADMIN });
    await svc.adminListe(user);
    expect(prisma.assistanceConversation.findMany.mock.calls[0][0].where).toMatchObject({ fleetId: 'f1' });
  });

  it('un super-admin voit toutes les sociétés', async () => {
    const { svc, prisma, user } = build({ role: UserRole.SUPER_ADMIN, fleetId: null });
    await svc.adminListe(user);
    expect(prisma.assistanceConversation.findMany.mock.calls[0][0].where.fleetId).toBeUndefined();
  });

  it('un compte sans société ne voit RIEN (fail-closed)', async () => {
    const { svc, prisma, user } = build({ role: UserRole.FLEET_ADMIN, fleetId: null });
    expect(await svc.adminListe(user)).toEqual([]);
    expect(prisma.assistanceConversation.findMany).not.toHaveBeenCalled();
  });
});
