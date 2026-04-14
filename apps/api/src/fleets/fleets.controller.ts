import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FleetsService } from './fleets.service';

@Controller('fleets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FleetsController {
  constructor(private readonly fleets: FleetsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  list(@Req() req: AuthenticatedRequest) {
    return this.fleets.list(req.user.role, req.user.fleetId);
  }
}
