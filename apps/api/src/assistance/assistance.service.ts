import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AssistanceAdminDetailDto,
  AssistanceAdminListItemDto,
  AssistanceConversationDto,
  AssistanceGravite,
  AssistanceListItemDto,
  AssistanceRole,
  AssistanceStatus,
  ReviewAssistanceDto,
} from '@vizyo/tracky-shared';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveTenantScope } from '../common/tenant-scope';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AssistanceAiService, type AssistanceMessageEntree } from './assistance-ai.service';

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

    if (r.escalade) await this.signalerReprise(user, conv.id, r.motifEscalade, r.gravite);

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
  ): Promise<void> {
    const niveau = urgent || gravite === 'CRITICAL' ? 'CRITICAL' : 'ERROR';
    await this.errorLogger
      .record(
        new Error(
          `${urgent ? 'RAPPEL URGENT' : 'Assistance à reprendre'} — ${user.email} : ${motif ?? 'sans motif'}`,
        ),
        SOURCE,
        { conversationId, userId: user.id, fleetId: user.fleetId ?? undefined, gravite },
        niveau,
      )
      .catch(() => {
        /* une alerte qui échoue ne doit pas faire échouer la demande d'aide */
      });
    this.systemActivity.record({
      category: 'INTERNAL',
      action: urgent ? 'assistance_rappel_urgent' : 'assistance_escalade',
      status: urgent ? 'FAILURE' : 'SUCCESS',
      actor: 'utilisateur',
      target: user.email,
      detail: motif ?? 'Reprise humaine demandée',
      fleetId: user.fleetId ?? null,
      triggeredByUserId: user.id,
      meta: { conversationId, gravite, urgent },
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
    await this.chargerScope(viewer, id);
    await this.prisma.assistanceMessage.create({ data: { conversationId: id, role: 'admin', content: texte } });
    await this.prisma.assistanceConversation.update({ where: { id }, data: { updatedAt: new Date() } });
    return this.adminDetail(viewer, id);
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
