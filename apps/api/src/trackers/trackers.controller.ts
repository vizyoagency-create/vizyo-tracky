import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AssignTrackerDto } from './dto/assign-tracker.dto';
import { CreateTrackerDto } from './dto/create-tracker.dto';
import { UpdateTrackerDto } from './dto/update-tracker.dto';
import { TrackersService } from './trackers.service';

@Controller('trackers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrackersController {
  constructor(private readonly trackers: TrackersService) {}

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  create(@Body() dto: CreateTrackerDto, @Req() req: AuthenticatedRequest) {
    return this.trackers.create(dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('unassigned') unassigned?: string,
    @Query('limit') limit?: string,
  ) {
    return this.trackers.findAll(
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
      { status, unassigned, limit: limit ? parseInt(limit, 10) : undefined },
    );
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.trackers.findOne(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateTrackerDto, @Req() req: AuthenticatedRequest) {
    return this.trackers.update(id, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.trackers.remove(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post(':trackerId/assign')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  assign(
    @Param('trackerId') trackerId: string,
    @Body() dto: AssignTrackerDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.trackers.assign(trackerId, dto.vehicleId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post(':trackerId/unassign')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  unassign(@Param('trackerId') trackerId: string, @Req() req: AuthenticatedRequest) {
    return this.trackers.unassign(trackerId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
