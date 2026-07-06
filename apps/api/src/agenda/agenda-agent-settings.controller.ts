import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SetAgendaAgentSettingsDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AgendaAgentSettingsService } from './agenda-agent-settings.service';

/**
 * Refonte agenda/IA (2026-07) — ⚙️ « Paramètres de l'agenda ». Lecture/écriture des réglages de
 * l'agent d'optimisation PAR FLOTTE. SUPER_ADMIN (choisit la flotte via ?fleetId=) + FLEET_ADMIN
 * (scopé à sa société par le service). Le scoping tenant est appliqué dans le service.
 */
@Controller('agenda/agent-settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgendaAgentSettingsController {
  constructor(private readonly svc: AgendaAgentSettingsService) {}

  /** GET /api/agenda/agent-settings — réglages courants (défauts si jamais configurés). */
  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  get(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.get(req.user, fleetId);
  }

  /** PUT /api/agenda/agent-settings — met à jour (partiel) les réglages de l'agent. */
  @Put()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  set(@Req() req: AuthenticatedRequest, @Body() dto: SetAgendaAgentSettingsDto) {
    return this.svc.set(req.user, dto ?? {});
  }
}
