import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type {
  AssistanceAdminDetailDto,
  AssistanceAdminListItemDto,
  AssistanceConversationDto,
  AssistanceGravite,
  AssistanceListItemDto,
  AssistanceRole,
  AssistanceStatus,
  ReviewAssistanceDto,
  SignalUrgenceWhatsappDto,
  UrgenceWhatsappEcran,
} from '@vizyo/tracky-shared';
import { URGENCE_WHATSAPP_ECRAN_LABELS, URGENCE_WHATSAPP_ECRAN_PAGES } from '@vizyo/tracky-shared';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveTenantScope } from '../common/tenant-scope';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { UserActivityService } from '../user-activity/user-activity.service';
import {
  AssistanceAiService,
  type AssistanceMessageEntree,
  type CauseTechniqueEscalade,
} from './assistance-ai.service';

const SOURCE = 'ASSISTANCE';
/** Réponses automatiques par conversation. Au-delà, on passe la main plutôt que de tourner en rond. */
const MAX_REPONSES_PAR_CONVERSATION = 10;
/** Réponses automatiques par personne et par jour — le plafond qui protège vraiment la facture. */
const MAX_REPONSES_PAR_JOUR = 30;
/** Longueur maximale d'un message accepté. */
const MESSAGE_MAX = 2000;
/** Messages remontés dans le détail d'une conversation. */
const MESSAGES_MAX = 100;

const MSG_QUOTA_CONVERSATION =
  'Cette conversation a atteint son nombre de réponses automatiques. Demandez un rappel : ' +
  'un conseiller reprendra le fil, avec tout l\'historique sous les yeux.';
const MSG_QUOTA_JOUR =
  'Vous avez atteint le nombre de réponses automatiques pour aujourd\'hui. Votre message est ' +
  'enregistré ; demandez un rappel si c\'est urgent.';

/** Où se trouve l'écran d'où l'on a ouvert la ligne d'urgence — `null` : l'écran de mise à jour couvre toutes les pages. */
const ROUTE_PAR_ECRAN: Record<UrgenceWhatsappEcran, string | null> = {
  assistance: '/assistance',
  vehicules: '/vehicles',
  'mise-a-jour': null,
};
/**
 * Sous une minute, un appui retransmis est dit « maintenant » : c'est le temps d'un aller-retour
 * vers WhatsApp, pas une panne — l'annoncer en retard ferait croire à un incident qui n'a pas eu lieu.
 */
const RETARD_SIGNIFICATIF_S = 60;
const FMT_HEURE_PARIS = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * Assistance IA — conversations, plafonds et archive.
 *
 * Ce service tient trois promesses :
 *   1. **Tout est conservé.** L'espace admin doit pouvoir relire une réponse des mois plus tard,
 *      la corriger et rappeler la personne. Rien n'est effacé au fil de l'eau.
 *   2. **Les plafonds sont ANNONCÉS, pas subis.** Le nombre de réponses restantes est renvoyé à
 *      chaque échange : arriver à zéro sans avertissement se lit comme une panne.
 *   3. **Une conversation appartient à son auteur.** Un identifiant volé ne donne rien : la
 *      lecture est filtrée sur le demandeur, et côté admin sur la société.
 */
@Injectable()
export class AssistanceService {
  private readonly logger = new Logger(AssistanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ia: AssistanceAiService,
    private readonly aiUsage: AiUsageService,
    private readonly systemActivity: SystemActivityService,
    private readonly errorLogger: ErrorLogger,
    private readonly notifications: NotificationDispatchService,
    private readonly userActivity: UserActivityService,
  ) {}

  // ─── Poser une question ────────────────────────────────────────────────────

  async poser(user: AuthUser, message: string, conversationId?: string): Promise<AssistanceConversationDto> {
    const texte = (message ?? '').trim().slice(0, MESSAGE_MAX);
    if (!texte) throw new BadRequestException('Message vide.');

    const conv = conversationId
      ? await this.chargerAMoi(user, conversationId)
      : await this.prisma.assistanceConversation.create({
          data: {
            userId: user.id,
            // Société FIGÉE à la demande — l'archive doit rester lisible sous le périmètre qui
            // était celui de la personne au moment où elle a posé sa question.
            fleetId: user.fleetId,
            title: texte.slice(0, 80),
          },
        });

    // Le message de l'utilisateur est enregistré AVANT tout appel : s'il n'y a pas de réponse
    // (quota, panne), sa demande ne doit pas être perdue — c'est elle qu'un humain reprendra.
    await this.prisma.assistanceMessage.create({
      data: { conversationId: conv.id, role: 'user', content: texte },
    });

    // Prévenir les administrateurs de la société — à l'OUVERTURE seulement, jamais à chaque
    // message. Une conversation de dix échanges ne doit pas produire dix notifications : ce
    // qu'un exploitant a besoin de savoir, c'est qu'une demande existe.
    if (!conversationId) await this.prevenirAdmins(user, conv.id, texte);

    // Le geste au centre d'activité des utilisateurs — sans le CONTENU, qui reste à son auteur
    // (les admins de la société lisent aussi ce fil).
    await this.userActivity.recordServerEvent(user, {
      type: 'ASSISTANCE',
      target: conversationId ? 'Question — suite de la conversation' : 'Nouvelle question à l’assistance',
      route: '/assistance',
      routeLabel: 'Assistance',
    });

    // Les super-admins — c'est Vizyo qui répond (30/09). Lancé MAINTENANT, attendu à la fin : la
    // notification part pendant que l'IA rédige, et ne retarde pas la réponse. Elle ne rejette
    // jamais (best-effort), le `finally` ne peut donc pas masquer une vraie erreur.
    const avertissement = this.prevenirSuperAdmins(user, {
      kind: 'conversation',
      // UN tiroir d'anti-spam par conversation : la première question prévient, les suivantes
      // dans le quart d'heure se regroupent, la conversation qui reprend plus tard prévient à nouveau.
      subjectKey: conv.id,
      title: conversationId ? 'Assistance — nouveau message' : 'Nouvelle demande d’assistance',
      corps: (qui) => `${qui} : ${texte.slice(0, 120)}`,
      url: '/admin/assistance',
    });
    try {
      return await this.repondre(user, conv, texte);
    } finally {
      await avertissement;
    }
  }

  /** La suite de `poser` : plafonds, appel IA, enregistrement de la réponse, escalade. */
  private async repondre(
    user: AuthUser,
    conv: { id: string; severity: string | null; escalatedAt: Date | null },
    texte: string,
  ): Promise<AssistanceConversationDto> {
    const [dejaRepondu, aujourdHui] = await Promise.all([
      this.prisma.assistanceMessage.count({ where: { conversationId: conv.id, role: 'assistant' } }),
      this.compterReponsesDuJour(user.id),
    ]);

    if (dejaRepondu >= MAX_REPONSES_PAR_CONVERSATION) {
      return this.repondreSansIa(conv.id, MSG_QUOTA_CONVERSATION, 'Plafond de la conversation atteint');
    }
    if (aujourdHui >= MAX_REPONSES_PAR_JOUR) {
      return this.repondreSansIa(conv.id, MSG_QUOTA_JOUR, 'Plafond quotidien atteint');
    }

    const historique = await this.historique(conv.id);
    const r = await this.ia.repondre(user, texte, historique);

    await this.prisma.assistanceMessage.create({
      data: {
        conversationId: conv.id,
        role: 'assistant',
        content: r.reponse,
        model: r.model,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs || null,
        contextUsed: r.contextUsed as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.assistanceConversation.update({
      where: { id: conv.id },
      data: {
        // Le titre du modèle remplace la troncature du premier message, une seule fois.
        ...(dejaRepondu === 0 && r.titre ? { title: r.titre.slice(0, 120) } : {}),
        severity: this.pireGravite(conv.severity as AssistanceGravite | null, r.gravite),
        ...(r.escalade
          ? {
              status: 'escalated',
              escalatedAt: conv.escalatedAt ?? new Date(),
              escalatedReason: (r.motifEscalade ?? 'Reprise humaine demandée par l\'assistant').slice(0, 400),
            }
          : {}),
      },
    });

    if (r.escalade) {
      // TRK-070 — la CAUSE voyage avec l'escalade : sans elle, un repli sur un incident déjà
      // consigné en `DEGRADATION` ressortait en `ERROR` et le recomptait comme un défaut.
      await this.signalerReprise(user, conv.id, r.motifEscalade, r.gravite, false, r.causeTechnique ?? null);
    }

    return this.toDto(conv.id, user);
  }

  /** Réponse SANS appel IA (quota) — enregistrée comme un vrai message, pas affichée puis perdue. */
  private async repondreSansIa(conversationId: string, texte: string, motif: string): Promise<AssistanceConversationDto> {
    await this.prisma.assistanceMessage.create({
      data: { conversationId, role: 'assistant', content: texte, costUsd: 0 },
    });
    await this.prisma.assistanceConversation.update({
      where: { id: conversationId },
      data: { status: 'escalated', escalatedAt: new Date(), escalatedReason: motif },
    });
    const conv = await this.prisma.assistanceConversation.findUnique({ where: { id: conversationId } });
    return this.toDtoDepuis(conv!, await this.messages(conversationId));
  }

  /**
   * Réponses automatiques servies à cette personne depuis minuit.
   *
   * Compté sur les MESSAGES et non sur les conversations : ouvrir une conversation neuve à chaque
   * question contournerait un plafond posé par conversation. C'est le plafond qui protège la
   * facture, l'autre ne protège que la pertinence.
   */
  private async compterReponsesDuJour(userId: string): Promise<number> {
    const minuit = new Date();
    minuit.setHours(0, 0, 0, 0);
    return this.prisma.assistanceMessage.count({
      where: { role: 'assistant', createdAt: { gte: minuit }, conversation: { userId } },
    });
  }

  // ─── Rappel urgent ─────────────────────────────────────────────────────────

  /**
   * Demande de rappel humain. Court-circuite l'IA : aucun appel, aucune rédaction.
   *
   * Le signalement passe par le CENTRE D'ALERTE en CRITICAL, qui est déjà le canal que les
   * administrateurs surveillent. Un bouton d'urgence qui ne réveille personne serait pire que pas
   * de bouton du tout : il donne l'impression d'avoir agi.
   */
  async rappelUrgent(user: AuthUser, conversationId: string, motif?: string): Promise<AssistanceConversationDto> {
    const conv = await this.chargerAMoi(user, conversationId);
    const raison = (motif ?? '').trim().slice(0, 400) || 'Rappel urgent demandé par l\'utilisateur';
    await this.prisma.assistanceConversation.update({
      where: { id: conv.id },
      data: {
        status: 'escalated',
        severity: this.pireGravite(conv.severity as AssistanceGravite | null, 'HIGH'),
        escalatedAt: conv.escalatedAt ?? new Date(),
        escalatedReason: raison,
      },
    });
    await this.prisma.assistanceMessage.create({
      data: { conversationId: conv.id, role: 'user', content: `[Rappel urgent] ${raison}` },
    });
    await this.userActivity.recordServerEvent(user, {
      type: 'ASSISTANCE',
      target: 'Rappel urgent demandé',
      route: '/assistance',
      routeLabel: 'Assistance',
    });
    await this.signalerReprise(user, conv.id, raison, 'HIGH', true);
    return this.toDto(conv.id, user);
  }

  /** Porte une reprise humaine au centre d'alerte + au journal système. Ne lève jamais. */
  private async signalerReprise(
    user: AuthUser,
    conversationId: string,
    motif: string | null,
    gravite: AssistanceGravite,
    urgent = false,
    // TRK-070 — présent quand l'escalade n'est qu'un REPLI sur un échec technique déjà journalisé.
    causeTechnique: CauseTechniqueEscalade | null = null,
  ): Promise<void> {
    // ── TRK-070 : le niveau suit la CAUSE, pas la gravité de la conversation ──────────────────
    //
    // La règle historique ne lisait que `gravite`, qui décrit l'URGENCE POUR L'UTILISATEUR. Elle
    // ne pouvait donc pas distinguer « quelqu'un a besoin d'un humain » de « l'IA est tombée et on
    // a rendu la main » : les deux sortaient en `ERROR`. Sur un compte fournisseur à sec, cela
    // produisait DEUX lignes pour un seul incident — `DEGRADATION` puis `ERROR` quatorze
    // millisecondes plus tard — et la seconde le recomptait comme un défaut à corriger.
    //
    // Quand l'escalade est un repli technique, on reprend le niveau DÉJÀ décidé pour l'incident
    // d'origine. Une escalade décidée sur le CONTENU garde `ERROR` : c'est un vrai signal produit.
    //
    // ⚠️ L'urgence prime sur tout : une situation critique décrite par l'utilisateur reste
    // `CRITICAL`, même si un appel IA a échoué en chemin.
    const niveau = urgent || gravite === 'CRITICAL' ? 'CRITICAL' : (causeTechnique?.niveau ?? 'ERROR');
    await this.errorLogger
      .record(
        new Error(
          `${urgent ? 'RAPPEL URGENT' : 'Assistance à reprendre'} — ${user.email} : ${motif ?? 'sans motif'}`,
        ),
        SOURCE,
        {
          conversationId,
          userId: user.id,
          fleetId: user.fleetId ?? undefined,
          gravite,
          // On déplace la preuve, on ne l'efface pas : la ligne reste diagnosticable.
          ...(causeTechnique ? { repliTechnique: true, kind: causeTechnique.kind } : {}),
        },
        niveau,
      )
      .catch(() => {
        /* une alerte qui échoue ne doit pas faire échouer la demande d'aide */
      });
    this.systemActivity.record({
      // ASSISTANCE depuis le 01/10/2026 : en INTERNAL, la ligne s'affichait « Provisioning interne ».
      category: 'ASSISTANCE',
      action: urgent ? 'assistance_rappel_urgent' : 'assistance_escalade',
      status: urgent ? 'FAILURE' : 'SUCCESS',
      actor: 'utilisateur',
      target: user.email,
      detail: motif ?? 'Reprise humaine demandée',
      fleetId: user.fleetId ?? null,
      triggeredByUserId: user.id,
      meta: { conversationId, gravite, urgent },
    });
    // Le centre d'alerte n'envoie AUCUN push : sans ceci, un rappel urgent attendait que quelqu'un
    // ouvre l'écran. Tiroir d'anti-spam DISTINCT de celui des questions — un rappel qui suit de
    // près une question déjà notifiée est un autre signal, il ne doit pas se regrouper avec elle.
    await this.prevenirSuperAdmins(user, {
      kind: urgent ? 'rappel-urgent' : 'escalade',
      subjectKey: conversationId,
      title: urgent ? 'RAPPEL URGENT demandé' : 'Assistance — un humain doit reprendre',
      corps: (qui) => `${qui} : ${(motif ?? 'sans motif').slice(0, 120)}`,
      url: '/admin/assistance',
    });
  }

  // ─── Lecture côté utilisateur ──────────────────────────────────────────────

  async mesConversations(user: AuthUser, limit = 20): Promise<AssistanceListItemDto[]> {
    const rows = await this.prisma.assistanceConversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      title: c.title,
      status: c.status as AssistanceStatus,
      apercu: (c.messages[0]?.content ?? '').slice(0, 140),
    }));
  }

  async maConversation(user: AuthUser, id: string): Promise<AssistanceConversationDto> {
    await this.chargerAMoi(user, id);
    return this.toDto(id, user);
  }

  /**
   * Charge une conversation en exigeant qu'elle appartienne au demandeur.
   *
   * `NotFoundException` et non `Forbidden` : distinguer « n'existe pas » de « pas à vous »
   * permettrait d'énumérer les identifiants valides en lisant le code de retour.
   */
  private async chargerAMoi(user: AuthUser, id: string) {
    const conv = await this.prisma.assistanceConversation.findFirst({ where: { id, userId: user.id } });
    if (!conv) throw new NotFoundException('Conversation introuvable.');
    return conv;
  }

  // ─── Lecture côté admin ────────────────────────────────────────────────────

  /**
   * Archive des conversations. Le périmètre suit la règle de l'app : un super-admin voit tout,
   * un admin de société voit la sienne, et un compte sans société ne voit RIEN (fail-closed).
   */
  async adminListe(viewer: AuthUser, limit = 50, statut?: string): Promise<AssistanceAdminListItemDto[]> {
    const scope = resolveTenantScope(viewer);
    if (scope.mode === 'DENY') return [];
    const rows = await this.prisma.assistanceConversation.findMany({
      where: {
        ...(scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {}),
        ...(statut ? { status: statut } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: {
        user: { select: { email: true } },
        messages: { select: { costUsd: true } },
      },
    });
    const fleetIds = [...new Set(rows.map((r) => r.fleetId).filter((x): x is string => !!x))];
    const fleets = fleetIds.length
      ? await this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } })
      : [];
    const nomFlotte = new Map(fleets.map((f) => [f.id, f.name]));
    const rate = this.aiUsage.eurRate();
    return rows.map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      title: c.title,
      status: c.status as AssistanceStatus,
      severity: (c.severity as AssistanceGravite | null) ?? null,
      userEmail: c.user?.email ?? null,
      fleetName: c.fleetId ? (nomFlotte.get(c.fleetId) ?? null) : null,
      messageCount: c.messages.length,
      escalatedAt: c.escalatedAt?.toISOString() ?? null,
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
      costEur: c.messages.reduce((s, m) => s + m.costUsd, 0) * rate,
    }));
  }

  async adminDetail(viewer: AuthUser, id: string): Promise<AssistanceAdminDetailDto> {
    const conv = await this.chargerScope(viewer, id);
    const [msgs, auteur, flotte, relecteur] = await Promise.all([
      this.messages(id),
      this.prisma.user.findUnique({ where: { id: conv.userId }, select: { email: true, role: true } }),
      conv.fleetId
        ? this.prisma.fleet.findUnique({ where: { id: conv.fleetId }, select: { name: true } })
        : Promise.resolve(null),
      conv.reviewedByUserId
        ? this.prisma.user.findUnique({ where: { id: conv.reviewedByUserId }, select: { email: true } })
        : Promise.resolve(null),
    ]);
    const rate = this.aiUsage.eurRate();
    return {
      id: conv.id,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      title: conv.title,
      status: conv.status as AssistanceStatus,
      severity: (conv.severity as AssistanceGravite | null) ?? null,
      userId: conv.userId,
      userEmail: auteur?.email ?? null,
      userRole: auteur?.role ?? null,
      fleetId: conv.fleetId,
      fleetName: flotte?.name ?? null,
      escalatedAt: conv.escalatedAt?.toISOString() ?? null,
      escalatedReason: conv.escalatedReason,
      reviewedAt: conv.reviewedAt?.toISOString() ?? null,
      reviewedByEmail: relecteur?.email ?? null,
      reviewNote: conv.reviewNote,
      costEur: msgs.reduce((s, m) => s + m.costUsd, 0) * rate,
      messages: msgs.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        role: m.role as AssistanceRole,
        content: m.content,
        model: m.model,
        costEur: m.costUsd * rate,
        latencyMs: m.latencyMs,
        contextUsed: (m.contextUsed as unknown as AssistanceAdminDetailDto['messages'][number]['contextUsed']) ?? null,
      })),
    };
  }

  /** Marque la conversation relue, avec la correction à retenir. C'est le but de l'archive. */
  async relire(viewer: AuthUser, id: string, dto: ReviewAssistanceDto): Promise<AssistanceAdminDetailDto> {
    await this.chargerScope(viewer, id);
    await this.prisma.assistanceConversation.update({
      where: { id },
      data: {
        reviewedAt: new Date(),
        reviewedByUserId: viewer.id,
        reviewNote: (dto.note ?? '').trim().slice(0, 2000) || null,
        ...(dto.clore ? { status: 'closed' } : {}),
      },
    });
    return this.adminDetail(viewer, id);
  }

  /** Réponse d'un conseiller humain, insérée dans le fil que l'utilisateur voit. */
  async repondreEnHumain(viewer: AuthUser, id: string, message: string): Promise<AssistanceAdminDetailDto> {
    const texte = (message ?? '').trim().slice(0, MESSAGE_MAX);
    if (!texte) throw new BadRequestException('Message vide.');
    const conv = await this.chargerScope(viewer, id);
    await this.prisma.assistanceMessage.create({ data: { conversationId: id, role: 'admin', content: texte } });
    await this.prisma.assistanceConversation.update({ where: { id }, data: { updatedAt: new Date() } });
    await this.prevenirDemandeur(conv, texte);
    return this.adminDetail(viewer, id);
  }

  /**
   * Prévient les administrateurs de la société qu'une demande d'aide vient d'être ouverte.
   *
   * L'AUTEUR est exclu : un administrateur qui pose lui-même une question n'a pas besoin qu'on
   * l'avertisse de l'avoir posée. Best-effort de bout en bout — une notification qui échoue ne
   * doit jamais empêcher quelqu'un de demander de l'aide.
   */
  private async prevenirAdmins(user: AuthUser, conversationId: string, question: string): Promise<void> {
    try {
      // Pas de société : personne à prévenir. Un super-admin sans société ne « relève » d'aucun
      // exploitant, et prévenir tous les admins de toutes les sociétés serait une fuite.
      if (!user.fleetId) return;
      const admins = await this.prisma.user.findMany({
        where: { fleetId: user.fleetId, role: UserRole.FLEET_ADMIN, isActive: true, id: { not: user.id } },
        select: { id: true },
      });
      if (admins.length === 0) return;
      await this.notifications.notifyUsers({
        userIds: admins.map((a) => a.id),
        category: 'ASSISTANCE',
        kind: 'nouvelle',
        // Cloisonne l'anti-spam PAR CONVERSATION : deux demandes différentes le même jour
        // doivent produire deux notifications, pas une.
        subjectKey: conversationId,
        title: 'Nouvelle demande d’assistance',
        body: `${user.firstName ?? user.email} : ${question.slice(0, 120)}`,
        url: '/admin/assistance',
        fleetId: user.fleetId,
      });
    } catch (e) {
      this.logger.warn(`Notification d'ouverture non envoyée : ${(e as Error)?.message ?? e}`);
    }
  }

  // ─── Ligne d'urgence WhatsApp ──────────────────────────────────────────────

  /**
   * Quelqu'un vient d'ouvrir la ligne d'urgence WhatsApp — le plus souvent un veilleur, la nuit,
   * devant un véhicule qui ne démarre pas.
   *
   * Trois traces, et chacune a son lecteur :
   *   - le CENTRE D'ACTIVITÉ des utilisateurs (`URGENCE_WHATSAPP`) : qui, quand, depuis quel écran,
   *     au milieu de ce que la personne faisait juste avant ;
   *   - le JOURNAL SYSTÈME (`ASSISTANCE`) : la preuve durable, filtrable avec les escalades ;
   *   - un PUSH aux super-admins : la personne d'astreinte apprend qu'un message arrive, avant
   *     même de regarder WhatsApp. Anti-spam par PERSONNE (15 min) : appuyer trois fois parce
   *     que WhatsApp tarde à s'ouvrir ne doit pas réveiller trois fois.
   *
   * Ne prouve pas qu'un message a été ENVOYÉ — WhatsApp est hors de l'application. D'où les mots :
   * « a ouvert WhatsApp », jamais « a écrit ».
   *
   * Un appui fait pendant une PANNE (écran « mise à jour en cours ») arrive en différé, avec son
   * âge (`retardS`) : chaque trace dit alors l'heure RÉELLE de l'appui, et qu'il a attendu le
   * retour de l'API. Sans cette mention, un super-admin lirait « maintenant » un appel à l'aide
   * vieux d'une demi-heure — et chercherait la personne au mauvais moment.
   */
  async signalerUrgenceWhatsapp(user: AuthUser, dto: SignalUrgenceWhatsappDto): Promise<void> {
    const plaque = dto.plaque?.trim().toUpperCase() || null;
    const depuis = URGENCE_WHATSAPP_ECRAN_LABELS[dto.ecran] ?? dto.ecran;
    const retardS = dto.retardS && dto.retardS >= RETARD_SIGNIFICATIF_S ? dto.retardS : 0;
    const appuiA = retardS ? FMT_HEURE_PARIS.format(new Date(Date.now() - retardS * 1000)) : null;
    const differe = appuiA ? ` (appui à ${appuiA}, transmis au retour de l’API)` : '';
    await this.userActivity.recordServerEvent(user, {
      type: 'URGENCE_WHATSAPP',
      target: `WhatsApp d’astreinte ouvert${plaque ? ` — ${plaque}` : ''}${differe}`,
      route: ROUTE_PAR_ECRAN[dto.ecran] ?? null,
      routeLabel: URGENCE_WHATSAPP_ECRAN_PAGES[dto.ecran] ?? null,
    });
    this.systemActivity.record({
      category: 'ASSISTANCE',
      action: 'assistance_urgence_whatsapp',
      status: 'SUCCESS',
      actor: 'utilisateur',
      target: user.email,
      detail: `Ligne d’urgence WhatsApp ouverte depuis ${depuis}${plaque ? ` — véhicule ${plaque}` : ''}${differe}`,
      fleetId: user.fleetId ?? null,
      triggeredByUserId: user.id,
      meta: { ecran: dto.ecran, plaque, ...(retardS ? { retardS } : {}) },
    });
    await this.prevenirSuperAdmins(user, {
      kind: 'urgence-whatsapp',
      subjectKey: `whatsapp:${user.id}`,
      title: 'Urgence véhicule — WhatsApp ouvert',
      corps: (qui) =>
        `${qui}${plaque ? ` · véhicule ${plaque}` : ''} · depuis ${depuis}${appuiA ? ` · appui à ${appuiA}` : ''}`,
      // Le centre d'activité : le geste y est en tête, avec ce que la personne faisait avant.
      url: '/admin/activity',
    });
  }

  /**
   * Prévient les SUPER-ADMINS — c'est Vizyo qui répond aux demandes d'assistance et tient la
   * ligne d'urgence (30/09/2026). Best-effort : ne rejette jamais.
   *
   * ⚠️ `fleetId: null`, et pas la société du demandeur : un super-admin n'a pas de société, et le
   * garde-fou anti cross-tenant de l'envoi (`WebPushService.sendToUser`) rejetterait EN SILENCE
   * tout push adressé à un compte dont la société diffère — exactement le piège qui a rendu le
   * push d'alerte muet en juillet (« un SUPER_ADMIN ne pouvait jamais être destinataire »).
   *
   * Ce que fait l'équipe elle-même (super-admin, propriétaire) ne prévient personne : un essai
   * de l'équipe s'écrit au journal, il n'a pas à sonner dans la poche des collègues.
   */
  private async prevenirSuperAdmins(
    user: AuthUser,
    n: { kind: string; subjectKey: string; title: string; corps: (qui: string) => string; url: string },
  ): Promise<void> {
    try {
      if (user.role === UserRole.SUPER_ADMIN || user.isOwner) return;
      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, isActive: true, id: { not: user.id } },
        select: { id: true },
      });
      if (admins.length === 0) return;
      await this.notifications.notifyUsers({
        userIds: admins.map((a) => a.id),
        category: 'ASSISTANCE',
        kind: n.kind,
        subjectKey: n.subjectKey,
        title: n.title,
        body: n.corps(await this.quiEtSociete(user)),
        url: n.url,
        fleetId: null,
      });
    } catch (e) {
      this.logger.warn(`Notification super-admin (${n.kind}) non envoyée : ${(e as Error)?.message ?? e}`);
    }
  }

  /** « Prénom Nom (Société) » — ce qu'un super-admin doit lire en premier, sur un écran verrouillé. */
  private async quiEtSociete(user: AuthUser): Promise<string> {
    const nom = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    if (!user.fleetId) return nom;
    const fleet = await this.prisma.fleet
      .findUnique({ where: { id: user.fleetId }, select: { name: true } })
      .catch(() => null);
    return fleet?.name ? `${nom} (${fleet.name})` : nom;
  }

  /**
   * Prévient l'AUTEUR de la demande qu'un humain lui a répondu.
   *
   * Le destinataire est le COMPTE qui a posé la question, pas sa société : la réponse le concerne
   * lui. Prévenir toute la flotte exposerait sa demande à des collègues qui n'ont pas à la lire.
   */
  private async prevenirDemandeur(
    conv: { id: string; userId: string; fleetId: string | null; title: string },
    reponse: string,
  ): Promise<void> {
    try {
      await this.notifications.notifyUsers({
        userIds: [conv.userId],
        category: 'ASSISTANCE',
        kind: 'reprise',
        subjectKey: conv.id,
        title: 'Un conseiller vous a répondu',
        body: reponse.slice(0, 140),
        url: `/assistance?conversation=${conv.id}`,
        // Garde anti cross-tenant du chemin d'envoi : la société figée sur la conversation.
        fleetId: conv.fleetId,
      });
    } catch (e) {
      this.logger.warn(`Notification de reprise non envoyée : ${(e as Error)?.message ?? e}`);
    }
  }

  private async chargerScope(viewer: AuthUser, id: string) {
    const scope = resolveTenantScope(viewer);
    if (scope.mode === 'DENY') throw new NotFoundException('Conversation introuvable.');
    const conv = await this.prisma.assistanceConversation.findFirst({
      where: { id, ...(scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {}) },
    });
    if (!conv) throw new NotFoundException('Conversation introuvable.');
    return conv;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private messages(conversationId: string) {
    return this.prisma.assistanceMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: MESSAGES_MAX,
    });
  }

  private async historique(conversationId: string): Promise<AssistanceMessageEntree[]> {
    const rows = await this.messages(conversationId);
    return rows.map((m) => ({ role: m.role as AssistanceMessageEntree['role'], content: m.content }));
  }

  private async toDto(conversationId: string, _user: AuthUser): Promise<AssistanceConversationDto> {
    const [conv, msgs] = await Promise.all([
      this.prisma.assistanceConversation.findUnique({ where: { id: conversationId } }),
      this.messages(conversationId),
    ]);
    if (!conv) throw new NotFoundException('Conversation introuvable.');
    return this.toDtoDepuis(conv, msgs);
  }

  private toDtoDepuis(
    conv: { id: string; createdAt: Date; updatedAt: Date; title: string; status: string; escalatedAt: Date | null },
    msgs: Array<{ id: string; createdAt: Date; role: string; content: string }>,
  ): AssistanceConversationDto {
    const repondus = msgs.filter((m) => m.role === 'assistant').length;
    return {
      id: conv.id,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      title: conv.title,
      status: conv.status as AssistanceStatus,
      escalatedAt: conv.escalatedAt?.toISOString() ?? null,
      // Annoncé, pas subi : arriver à zéro sans avertissement se lit comme une panne.
      reponsesRestantes: Math.max(0, MAX_REPONSES_PAR_CONVERSATION - repondus),
      messages: msgs.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        role: m.role as AssistanceRole,
        content: m.content,
      })),
    };
  }

  /** La gravité d'une conversation ne REDESCEND pas : elle retient le pire moment. */
  private pireGravite(actuelle: AssistanceGravite | null, nouvelle: AssistanceGravite): AssistanceGravite {
    const rang: Record<AssistanceGravite, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    if (!actuelle) return nouvelle;
    return rang[nouvelle] > rang[actuelle] ? nouvelle : actuelle;
  }
}
