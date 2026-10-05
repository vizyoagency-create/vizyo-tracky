import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  AssistanceAdminDetailDto,
  AssistanceAdminListItemDto,
  AssistanceConversationDto,
  AssistanceListItemDto,
} from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DepotScopeGuard } from '../depot/depot-scope.guard';
import { AssistanceAiService } from './assistance-ai.service';
import { AssistanceService } from './assistance.service';
import {
  AdminReplyBodyDto,
  AskAssistanceBodyDto,
  RappelUrgentBodyDto,
  ReviewAssistanceBodyDto,
  SignalUrgenceWhatsappBodyDto,
} from './dto/assistance.dto';

/**
 * Assistance IA — surface HTTP.
 *
 * ── Qui peut y accéder ───────────────────────────────────────────────────────────────
 * TOUT utilisateur authentifié de l'application, quel que soit son rôle : c'est une aide, pas une
 * fonction d'administration. Aucune permission n'est exigée.
 *
 * SAUF le rôle DEPOT, écarté par `DepotScopeGuard` (qui refuse par défaut faute de déclaration de
 * périmètre). Un dépôt est un tiers externe qui voit UN camion pendant UNE mission : il n'utilise
 * pas l'application, il consulte un suivi. Lui ouvrir un assistant qui explique la gestion de
 * flotte serait hors de son périmètre, et c'est la décision déjà prise pour l'état IA.
 * (À rouvrir si le besoin apparaît : il suffira d'un décorateur de périmètre.)
 *
 * ── Ce que les routes ne font pas ────────────────────────────────────────────────────
 * Aucune ne modifie une donnée métier. L'assistance lit et répond ; les seules écritures sont ses
 * propres conversations. C'est vrai côté prompt ET côté surface : il n'existe aucune route qui
 * permettrait à l'agent d'agir, même si un jour il le demandait.
 */
@Controller('assistance')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
export class AssistanceController {
  constructor(
    private readonly assistance: AssistanceService,
    private readonly ia: AssistanceAiService,
  ) {}

  /**
   * L'assistance est-elle utilisable ? L'écran s'en sert pour ne pas proposer un chat mort.
   * Volontairement sans détail : « pourquoi » relève de l'exploitation, pas de l'utilisateur.
   */
  @Get('disponible')
  disponible(): { disponible: boolean } {
    return { disponible: this.ia.disponible() };
  }

  /** Poser une question — nouvelle conversation, ou suite d'une conversation existante. */
  @Post('ask')
  ask(@Req() req: AuthenticatedRequest, @Body() dto: AskAssistanceBodyDto): Promise<AssistanceConversationDto> {
    return this.assistance.poser(req.user, dto.message, dto.conversationId);
  }

  @Get('conversations')
  mesConversations(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<AssistanceListItemDto[]> {
    return this.assistance.mesConversations(req.user, limit ? parseInt(limit, 10) : undefined);
  }

  @Get('conversations/:id')
  maConversation(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistanceConversationDto> {
    return this.assistance.maConversation(req.user, id);
  }

  /**
   * Demande de rappel humain. Ne consomme AUCUN appel IA et n'est soumise à aucun plafond : le
   * jour où quelqu'un a vraiment besoin d'un humain est le pire jour pour lui opposer un quota.
   */
  @Post('conversations/:id/rappel')
  rappel(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RappelUrgentBodyDto,
  ): Promise<AssistanceConversationDto> {
    return this.assistance.rappelUrgent(req.user, id, dto.motif);
  }

  /**
   * Quelqu'un vient d'ouvrir la ligne d'urgence WhatsApp (01/10/2026).
   *
   * Appelée par le navigateur AU MOMENT de l'appui, sans attendre la réponse : WhatsApp s'ouvre
   * quoi qu'il arrive ici — jamais une urgence ne dépend de ce signalement. Il écrit le geste au
   * centre d'activité et prévient les super-admins (push, anti-spam du socle).
   *
   * AUCUN rôle exigé, et c'est voulu : le premier utilisateur de ce bouton est le VEILLEUR DE
   * NUIT, dont l'écran des véhicules porte le bandeau d'urgence. Lui fermer cette route, c'est
   * rendre muet le seul appui qui compte. Le dépôt reste écarté par `DepotScopeGuard`.
   */
  @Post('urgence/whatsapp')
  @HttpCode(204)
  signalerWhatsapp(@Req() req: AuthenticatedRequest, @Body() dto: SignalUrgenceWhatsappBodyDto): Promise<void> {
    return this.assistance.signalerUrgenceWhatsapp(req.user, dto);
  }

  // ─── Espace admin — archive, relecture, reprise ────────────────────────────

  /**
   * ⚠️ RÉSERVÉ AU SUPER-ADMIN DEPUIS LE 30/09/2026 (décision du propriétaire).
   *
   * Ces quatre routes acceptaient aussi `FLEET_ADMIN`. C'est désormais Vizyo, et Vizyo seul, qui
   * répond aux demandes d'assistance : l'écran a quitté la navbar de l'application pour le
   * panneau `/admin`, qui est super-admin.
   *
   * Le rôle est retiré ICI et pas seulement sur la route Angular. Une garde d'écran ne ferme
   * rien — elle cache un lien ; l'appel HTTP, lui, reste possible pour qui connaît l'URL. Ce
   * dépôt s'est déjà fait prendre plusieurs fois par des garde-fous qui ne gardaient rien.
   *
   * Le périmètre par société (`resolveTenantScope`) est CONSERVÉ tel quel : il n'est plus
   * exercé par aucun rôle admis, mais le retirer transformerait une défense en profondeur en
   * dette silencieuse le jour où un autre rôle sera rouvert.
   */
  @Get('admin/conversations')
  @Roles(UserRole.SUPER_ADMIN)
  adminListe(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('statut') statut?: string,
  ): Promise<AssistanceAdminListItemDto[]> {
    return this.assistance.adminListe(req.user, limit ? parseInt(limit, 10) : undefined, statut);
  }

  @Get('admin/conversations/:id')
  @Roles(UserRole.SUPER_ADMIN)
  adminDetail(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistanceAdminDetailDto> {
    return this.assistance.adminDetail(req.user, id);
  }

  /** Marquer relue + consigner la correction à retenir. C'est la raison d'être de l'archive. */
  @Post('admin/conversations/:id/review')
  @Roles(UserRole.SUPER_ADMIN)
  relire(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewAssistanceBodyDto,
  ): Promise<AssistanceAdminDetailDto> {
    return this.assistance.relire(req.user, id, dto);
  }

  /** Réponse d'un conseiller humain, insérée dans le fil que l'utilisateur voit. */
  @Post('admin/conversations/:id/reply')
  @Roles(UserRole.SUPER_ADMIN)
  repondre(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReplyBodyDto,
  ): Promise<AssistanceAdminDetailDto> {
    return this.assistance.repondreEnHumain(req.user, id, dto.message);
  }
}
