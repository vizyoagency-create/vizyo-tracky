import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { EnvoisSocieteDto, ReglerEnvoisSocieteDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GardeFouEnvoisService } from '../email/garde-fou-envois.service';
import { FleetsService } from './fleets.service';

@Controller('fleets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FleetsController {
  constructor(
    private readonly fleets: FleetsService,
    private readonly garde: GardeFouEnvoisService,
  ) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  list(@Req() req: AuthenticatedRequest) {
    return this.fleets.list(req.user.role, req.user.fleetId);
  }

  /**
   * 30/09 — le MODE RECETTE de la société (avis de réservation et de mission retenus jusqu'à une
   * heure donnée) : lu par l'agenda de tous ses utilisateurs, pour un bandeau qui le dit.
   */
  @Get(':id/envois')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_ADMIN,
    UserRole.FLEET_MANAGER,
    UserRole.VIEWER,
    UserRole.NIGHT_WATCHMAN,
    UserRole.DRIVER,
  )
  envois(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<EnvoisSocieteDto> {
    return this.garde.etat(req.user, id);
  }

  /** Super-admin : `{ heures: 1…24 }` retient les avis de la société ; `{ heures: null }` les rétablit. */
  @Put(':id/envois')
  @Roles(UserRole.SUPER_ADMIN)
  reglerEnvois(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReglerEnvoisSocieteDto,
  ): Promise<EnvoisSocieteDto> {
    // Explicite : un corps sans `heures` n'est ni « retenir » ni « rétablir ».
    if (!body || !('heures' in body)) throw new BadRequestException('Préciser « heures » (1 à 24), ou null pour rétablir.');
    return this.garde.regler(req.user, id, body.heures);
  }
}
