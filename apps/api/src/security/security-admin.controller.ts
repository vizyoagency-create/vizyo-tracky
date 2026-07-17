import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SecurityService } from './security.service';

/**
 * Vue admin sécurité (SUPER_ADMIN) : qui a activé le 2FA, dernière position de
 * connexion, et par utilisateur la carte de tous ses lieux de connexion. L'owner
 * caché reste masqué aux autres super-admins (req.user.isOwner).
 */
@Controller('admin/security')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SecurityAdminController {
  constructor(private readonly security: SecurityService) {}

  @Get('users')
  users(@Req() req: AuthenticatedRequest) {
    return this.security.adminUsersOverview(!!req.user.isOwner);
  }

  @Get('users/:id/locations')
  userLocations(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.security.adminUserLocations(id, !!req.user.isOwner);
  }
}
