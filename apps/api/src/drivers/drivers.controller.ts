import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { DriversService } from './drivers.service';

@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  /** GET /drivers — liste fleet-scoped, ?includeArchived=true pour les archives. */
  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('drivers_view')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.drivers.list(this.rb(req), includeArchived === 'true');
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('drivers_view')
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.drivers.findOne(id, this.rb(req));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  create(@Body() dto: CreateDriverDto, @Req() req: AuthenticatedRequest) {
    return this.drivers.create(dto, this.rb(req));
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.update(id, dto, this.rb(req));
  }

  /** Soft-delete : isActive=false + retire le driver des Vehicle.currentDriverId. */
  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  archive(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.drivers.archive(id, this.rb(req));
  }

  private rb(req: AuthenticatedRequest) {
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId };
  }
}
