import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TrackerCommandStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateTrackerCommandDto } from './dto/create-tracker-command.dto';
import { TrackerCommandsService } from './tracker-commands.service';

@Controller('tracker-commands')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrackerCommandsController {
  constructor(private readonly service: TrackerCommandsService) {}

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  create(@Body() dto: CreateTrackerCommandDto, @Req() req: AuthenticatedRequest) {
    return this.service.request(
      dto.trackerId,
      dto.templateId,
      dto.params ?? {},
      dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
    );
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  list(
    @Req() req: AuthenticatedRequest,
    @Query('trackerId') trackerId?: string,
    @Query('status') status?: TrackerCommandStatus,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list(
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
      { trackerId, status, category, limit: limit ? parseInt(limit, 10) : undefined },
    );
  }

  @Get('catalog')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  catalog(@Req() req: AuthenticatedRequest) {
    return this.service.getCatalog(req.user.role);
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.service.getCommand(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Delete(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  cancel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.service.cancel(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
