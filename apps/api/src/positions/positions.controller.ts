import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { ListPositionsDto } from './dto/list-positions.dto';
import { PositionHistoryService } from './position-history.service';
import { PositionsService } from './positions.service';

@Controller('positions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PositionsController {
  constructor(
    private readonly positions: PositionsService,
    private readonly history: PositionHistoryService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  private async rb(req: AuthenticatedRequest) {
    // accessibleVehicleIds est requis pour que les VIEWER restreints a un groupe
    // ne voient pas les positions/historique des autres vehicules de la flotte.
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async list(@Req() req: AuthenticatedRequest, @Query() query: ListPositionsDto) {
    return this.positions.list(await this.rb(req), query);
  }

  /**
   * V1.5 (Sprint H4) — Historique avec compaction adaptative.
   * Query: ?trackerId=...&from=ISO&to=ISO&detail=auto|fine|compact
   */
  @Get('history')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async historyEndpoint(
    @Req() req: AuthenticatedRequest,
    @Query() query: {
      trackerId?: string;
      vehicleId?: string;
      from: string;
      to: string;
      detail?: 'auto' | 'fine' | 'compact';
    },
  ) {
    return this.history.history(await this.rb(req), query);
  }
}
