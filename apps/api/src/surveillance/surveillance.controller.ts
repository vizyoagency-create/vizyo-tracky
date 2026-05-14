import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SurveillanceEventStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  AcknowledgeEventDto,
  UpdateSurveillanceProfileDto,
} from './surveillance.dto';
import { SurveillanceService } from './surveillance.service';

@Controller('surveillance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SurveillanceController {
  constructor(private readonly service: SurveillanceService) {}

  @Get('profiles/:vehicleId')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_ADMIN,
    UserRole.FLEET_MANAGER,
  )
  getProfile(
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.getOrCreateProfile(vehicleId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Put('profiles/:vehicleId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  updateProfile(
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Body() dto: UpdateSurveillanceProfileDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.updateProfile(vehicleId, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post('profiles/:vehicleId/arm')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  arm(
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.armNow(vehicleId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post('profiles/:vehicleId/disarm')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  disarm(
    @Param('vehicleId', new ParseUUIDPipe()) vehicleId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.disarmNow(vehicleId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get('events')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  listEvents(
    @Req() req: AuthenticatedRequest,
    @Query('vehicleId') vehicleId?: string,
    @Query('status') status?: SurveillanceEventStatus,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listEvents(
      {
        userId: req.user.id,
        role: req.user.role,
        fleetId: req.user.fleetId,
      },
      {
        vehicleId,
        status,
        limit: limit ? parseInt(limit, 10) : undefined,
        cursor,
      },
    );
  }

  @Post('events/:id/acknowledge')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  acknowledgeEvent(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AcknowledgeEventDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.acknowledgeEvent(id, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
