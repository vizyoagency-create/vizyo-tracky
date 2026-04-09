import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AlertsService } from './alerts.service';
import { ListAlertsDto } from './dto/list-alerts.dto';

@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  list(@Req() req: AuthenticatedRequest, @Query() query: ListAlertsDto) {
    return this.alerts.list(
      { userId: req.user.sub, role: req.user.role as UserRole, fleetId: req.user.fleetId },
      query,
    );
  }

  @Get('unacknowledged/count')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  count(@Req() req: AuthenticatedRequest) {
    return this.alerts.countUnacknowledged({
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }

  @Post(':id/acknowledge')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  acknowledge(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.alerts.acknowledge(id, {
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }

  @Post('acknowledge-all')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  acknowledgeAll(@Req() req: AuthenticatedRequest) {
    return this.alerts.acknowledgeAll({
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }
}
