import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ConsentService } from './consent.service';

/**
 * Lecture admin (SUPER_ADMIN) des consentements RGPD — APP (par utilisateur, avec
 * date + IP d'acceptation) et LP (visiteurs anonymes, avec IP). Même garde que les
 * autres vues super-admin (JwtAuthGuard + RolesGuard + @Roles).
 */
@Controller('admin/consent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class ConsentAdminController {
  constructor(private readonly consent: ConsentService) {}

  /** Statut de consentement app par utilisateur. */
  @Get('users')
  users(@Req() req: AuthenticatedRequest) {
    return this.consent.adminUsersOverview(!!req.user.isOwner);
  }

  /** Derniers consentements de visiteurs LP (avec IP). */
  @Get('lp')
  lp(@Query('limit') limit?: string) {
    return this.consent.adminLpConsents(limit ? Number.parseInt(limit, 10) || 100 : 100);
  }
}
