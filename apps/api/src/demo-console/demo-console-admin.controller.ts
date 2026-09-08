import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DemoBridgeService } from './demo-bridge.service';

/**
 * ═══ CONSOLE DE DÉMONSTRATION — L'ÉCRAN DE PRODUCTION ════════════════════════════════════════
 *
 * `/admin/demo-console/*`, SUPER_ADMIN seulement. Chaque route relaie vers l'API de la démo, qui
 * détient les données et applique ses propres règles. La production ne décide de rien ici : elle
 * n'est qu'un guichet, et c'est ce qui garantit qu'une invitation créée depuis cet écran est
 * exactement celle qu'on aurait créée depuis la démo.
 *
 * Le rôle est déjà filtré par `RolesGuard` ; le secret interne, lui, ne quitte jamais le serveur.
 */
@Controller('admin/demo-console')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class DemoConsoleAdminController {
  constructor(private readonly pont: DemoBridgeService) {}

  /** L'écran interroge d'abord ceci : sans configuration, il le DIT au lieu de rester vide. */
  @Get('etat')
  etat() {
    return this.pont.etat();
  }

  @Get('comptes')
  comptes() {
    return this.pont.lire('/comptes');
  }

  @Get('invitations')
  invitations() {
    return this.pont.lire('/invitations');
  }

  @Post('invitations')
  inviter(@Req() req: AuthenticatedRequest, @Body() body: { email?: string; role?: UserRole }) {
    return this.pont.ecrire('POST', '/invitations', {
      email: body?.email,
      role: body?.role,
      // Tracé dans le journal de la démo : qui, depuis la production, a invité ce prospect.
      demandeur: req.user.email,
    });
  }

  @Delete('invitations/:id')
  revoquer(@Param('id') id: string) {
    return this.pont.ecrire('DELETE', `/invitations/${encodeURIComponent(id)}`);
  }

  @Post('comptes/:id/blocage')
  blocage(@Param('id') id: string, @Body() body: { bloque?: boolean }) {
    return this.pont.ecrire('POST', `/comptes/${encodeURIComponent(id)}/blocage`, {
      bloque: body?.bloque !== false,
    });
  }

  /**
   * Le flux d'activité de la démo, dans la MÊME forme que celui de la production : c'est ce qui
   * permet à l'écran « Activité utilisateurs » de basculer de source sans changer d'affichage.
   */
  /** La présence suit la source : sinon « en ligne » resterait celle des clients de production. */
  @Get('en-ligne')
  enLigne() {
    return this.pont.lire('/en-ligne');
  }

  @Get('activite')
  activite(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('beforeId') beforeId?: string,
    @Query('type') type?: string,
    @Query('userId') userId?: string,
  ) {
    return this.pont.lire('/activite', { limit, before, beforeId, type, userId });
  }
}
