import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApiTrafficService } from './api-traffic.service';

/**
 * Lecture admin (SUPER_ADMIN uniquement) de l'observabilité du trafic API.
 * Même garde que les autres vues super-admin (JwtAuthGuard + RolesGuard + @Roles).
 * L'owner plateforme est masqué aux autres super-admins (géré dans le service).
 */
@Controller('admin/api-traffic')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class ApiTrafficAdminController {
  constructor(private readonly traffic: ApiTrafficService) {}

  /** Feed du trafic (curseur createdAt+id). */
  @Get()
  feed(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('beforeId') beforeId?: string,
    @Query('source') source?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('ipKnown') ipKnown?: string,
  ) {
    return this.traffic.getFeed(
      {
        limit: limit ? Number.parseInt(limit, 10) || 60 : 60,
        before,
        beforeId,
        source,
        kind,
        status,
        ipKnown: this.parseBool(ipKnown),
      },
      req.user,
    );
  }

  /** Intelligence IP : agrégat par IP (fréquence, connu/inconnu, origines, statuts…). */
  @Get('ips')
  ips(@Req() req: AuthenticatedRequest, @Query('windowDays') windowDays?: string) {
    return this.traffic.getIpIntelligence(
      { windowDays: windowDays ? Number.parseInt(windowDays, 10) || 7 : 7 },
      req.user,
    );
  }

  /** Synthèse chiffrée du trafic sur la fenêtre. */
  @Get('summary')
  summary(@Req() req: AuthenticatedRequest, @Query('windowDays') windowDays?: string) {
    return this.traffic.getSummary(
      { windowDays: windowDays ? Number.parseInt(windowDays, 10) || 7 : 7 },
      req.user,
    );
  }

  private parseBool(v?: string): boolean | undefined {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  }
}
