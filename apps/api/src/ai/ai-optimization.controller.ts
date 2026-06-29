import { Body, Controller, Get, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  AiCapacityApplyDto,
  AiCapacitySuggestRequestDto,
  AiPlacementSuggestRequestDto,
  SetFleetMetierDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AiOptimizationService } from './ai-optimization.service';

const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
  UserRole.NIGHT_WATCHMAN,
];

/**
 * Sprint 9 — Copilote IA d'optimisation. Tous les `suggest` sont des DRY-RUN
 * (aucune écriture). Garde par perm `ai_optimize` (défaut super+fleet admin,
 * accordable). L'APPLICATION d'une capacité passe par `vehicles_edit` (écriture
 * véhicule) ; l'application d'un placement passe par le flux de réservation S8.
 * @Roles ouvert à tous + perm = gate réel (cohérent avec ReservationsController).
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class AiOptimizationController {
  constructor(private readonly ai: AiOptimizationService) {}

  /** Propositions de capacité (places / places-enfant / équipements) — DRY-RUN. */
  @Post('capacity/suggest')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  suggestCapacity(@Req() req: AuthenticatedRequest, @Body() dto: AiCapacitySuggestRequestDto) {
    return this.ai.suggestCapacity(req.user, dto ?? {});
  }

  /** Application HUMAINE des propositions acceptées → écrit les véhicules. */
  @Post('capacity/apply')
  @Roles(...ALL_ROLES)
  @RequirePermissions('vehicles_edit')
  applyCapacity(@Req() req: AuthenticatedRequest, @Body() dto: AiCapacityApplyDto) {
    return this.ai.applyCapacity(req.user, dto);
  }

  /** Classement de placement raisonné parmi les véhicules disponibles — DRY-RUN. */
  @Post('placement/suggest')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  suggestPlacement(@Req() req: AuthenticatedRequest, @Body() dto: AiPlacementSuggestRequestDto) {
    return this.ai.suggestPlacement(req.user, dto);
  }

  /** Aperçu du payload capacité EXACT (dry-run, aucun appel Claude) — pour tester en Console. */
  @Post('capacity/preview')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  previewCapacity(@Req() req: AuthenticatedRequest, @Body() dto: AiCapacitySuggestRequestDto) {
    return this.ai.previewCapacity(req.user, dto ?? {});
  }

  /** Aperçu du payload placement EXACT (dry-run, aucun appel Claude) — pour tester en Console. */
  @Post('placement/preview')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  previewPlacement(@Req() req: AuthenticatedRequest, @Body() dto: AiPlacementSuggestRequestDto) {
    return this.ai.previewPlacement(req.user, dto);
  }

  /** Lire le métier de la flotte (conditionne l'objectif d'optimisation IA). */
  @Get('fleet-metier')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  getFleetMetier(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.ai.getFleetMetier(req.user, fleetId);
  }

  /** Régler le métier de la flotte (admins). */
  @Patch('fleet-metier')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('ai_optimize')
  setFleetMetier(@Req() req: AuthenticatedRequest, @Body() dto: SetFleetMetierDto) {
    return this.ai.setFleetMetier(req.user, dto);
  }
}
