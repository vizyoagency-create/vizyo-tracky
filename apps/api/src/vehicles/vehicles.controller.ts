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
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  create(@Body() dto: CreateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.create(dto, {
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('hasTracker') hasTracker?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.vehicles.findAll(
      { userId: req.user.sub, role: req.user.role as UserRole, fleetId: req.user.fleetId },
      { search, hasTracker, limit: limit ? parseInt(limit, 10) : undefined, cursor },
    );
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.findOne(id, {
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.update(id, dto, {
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.remove(id, {
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }
}
