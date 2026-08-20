import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { GpsZoneDiagnosticDto } from '@vizyo/tracky-shared';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GpsDiagnosticService } from './gps-diagnostic.service';

export class TraiterZoneBodyDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsBoolean() traite?: boolean;
}

/**
 * Diagnostics de qualite GPS — RESERVE AU SUPER-ADMIN pour l'instant.
 *
 * ⚠️ Restriction VOLONTAIRE et temporaire, meme logique que la sourdine des alertes
 *    d'alimentation : ces conclusions sont produites par un agent tout neuf. Tant qu'on n'a pas
 *    verifie sur plusieurs semaines qu'il ne se trompe pas, un client ne doit pas lire « votre
 *    boitier est defaillant » sur la foi d'un diagnostic non eprouve. Ouvrir aux admins de flotte
 *    se fera en ajoutant un role ici — une ligne, le jour ou on aura confiance.
 */
@Controller('gps-diagnostics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class GpsDiagnosticController {
  constructor(private readonly service: GpsDiagnosticService) {}

  @Get('zones')
  zones(
    @Query('fleetId') fleetId?: string,
    @Query('tous') tous?: string,
  ): Promise<GpsZoneDiagnosticDto[]> {
    return this.service.liste(fleetId, tous === 'true');
  }

  @Post('zones/:id/traiter')
  traiter(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TraiterZoneBodyDto,
  ): Promise<GpsZoneDiagnosticDto> {
    return this.service.traiter(req.user, id, dto);
  }
}
