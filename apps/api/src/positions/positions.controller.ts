import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListPositionsDto } from './dto/list-positions.dto';
import { PositionHistoryService } from './position-history.service';
import { PositionsService } from './positions.service';

@Controller('positions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PositionsController {
  constructor(
    private readonly positions: PositionsService,
    private readonly history: PositionHistoryService,
  ) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  list(@Req() req: AuthenticatedRequest, @Query() query: ListPositionsDto) {
    return this.positions.list(
      { role: req.user.role, fleetId: req.user.fleetId },
      query,
    );
  }

  /**
   * V1.5 (Sprint H4) — Historique avec compaction adaptative.
   * Query: ?trackerId=...&from=ISO&to=ISO&detail=auto|fine|compact
   */
  @Get('history')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  historyEndpoint(
    @Req() req: AuthenticatedRequest,
    @Query() query: {
      trackerId?: string;
      vehicleId?: string;
      from: string;
      to: string;
      detail?: 'auto' | 'fine' | 'compact';
    },
  ) {
    return this.history.history(
      { role: req.user.role, fleetId: req.user.fleetId },
      query,
    );
  }
}
