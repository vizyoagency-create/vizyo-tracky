import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { InternalSecretGuard } from '../internal/internal-secret.guard';
import { DemoConsoleService } from './demo-console.service';

/**
 * ═══ ROUTES INTERNES DE LA DÉMONSTRATION ═════════════════════════════════════════════════════
 *
 * Servies par l'API de DÉMO, appelées par l'API de PRODUCTION, jamais par un navigateur.
 * L'exploitant administre la démo depuis la console de production sans avoir à s'y connecter.
 *
 * DEUX VERROUS, et il en faut deux :
 *   1. `InternalSecretGuard` — l'appelant doit présenter `x-internal-secret`. Le secret de la
 *      démo diffère de celui de la production (vérifié le 2026-09-08) : la production doit
 *      donc porter CELUI DE LA DÉMO, et un secret de production volé n'ouvre pas la démo.
 *   2. `DEMO_MODE` — vérifié dans le SERVICE, pas ici. La même image sert les deux
 *      environnements : sans cette seconde garde, ces routes exposeraient les comptes et
 *      l'activité de la PRODUCTION derrière un simple secret partagé.
 *
 * Aucun `JwtAuthGuard` : il n'y a pas d'utilisateur, c'est un appel de service à service.
 */
@Controller('internal/demo')
@UseGuards(InternalSecretGuard)
export class DemoConsoleController {
  constructor(private readonly service: DemoConsoleService) {}

  @Get('comptes')
  comptes() {
    return this.service.comptes();
  }

  @Get('invitations')
  invitations() {
    return this.service.listerInvitations();
  }

  @Post('invitations')
  inviter(@Body() body: { email?: string; role?: UserRole; demandeur?: string }) {
    return this.service.inviter(
      String(body?.email ?? '').trim(),
      body?.role ?? UserRole.FLEET_ADMIN,
      String(body?.demandeur ?? 'console de production'),
    );
  }

  @Delete('invitations/:id')
  revoquer(@Param('id') id: string) {
    return this.service.revoquerInvitation(id);
  }

  @Post('comptes/:id/blocage')
  blocage(@Param('id') id: string, @Body() body: { bloque?: boolean }) {
    return this.service.definirBlocage(id, body?.bloque !== false);
  }

  @Get('activite')
  activite(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('beforeId') beforeId?: string,
    @Query('type') type?: string,
    @Query('userId') userId?: string,
  ) {
    return this.service.activite({
      limit: limit ? parseInt(limit, 10) || 50 : 50,
      before,
      beforeId,
      type,
      userId,
    });
  }
}
