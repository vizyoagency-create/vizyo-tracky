import { Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DemoAdminService } from './demo-admin.service';

/**
 * Administration de l'environnement de démonstration — SUPER_ADMIN seulement.
 *
 * En production ces routes existent aussi : `status` répond `{ demo: false }`, et
 * `refresh-request` répond 404. Un prospect n'a jamais le rôle SUPER_ADMIN.
 */
@Controller('admin/demo')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class DemoController {
  constructor(private readonly service: DemoAdminService) {}

  @Get('status')
  statut() {
    return this.service.statut();
  }

  @Post('refresh-request')
  @HttpCode(HttpStatus.ACCEPTED)
  demander(@Req() req: AuthenticatedRequest) {
    return this.service.demanderRafraichissement({ id: req.user.id, email: req.user.email });
  }
}
