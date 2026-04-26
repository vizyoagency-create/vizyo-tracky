import {
  Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus,
  NotFoundException, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AddVehicleToGroupDto, CreateVehicleGroupDto, RenameVehicleGroupDto } from './dto/vehicle-group.dto';

@Controller('vehicle-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehicleGroupsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async create(@Body() dto: CreateVehicleGroupDto, @Req() req: AuthenticatedRequest) {
    const fleetId = req.user.fleetId;
    if (!fleetId) throw new ForbiddenException('No fleet assigned');

    return this.prisma.vehicleGroup.create({
      data: { name: dto.name, fleetId },
    });
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async findAll(@Req() req: AuthenticatedRequest) {
    const where = req.user.role === UserRole.SUPER_ADMIN
      ? {}
      : { fleetId: req.user.fleetId ?? undefined };

    return this.prisma.vehicleGroup.findMany({
      where,
      include: {
        vehicles: { select: { vehicleId: true } },
        _count: { select: { vehicles: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async rename(@Param('id') id: string, @Body() dto: RenameVehicleGroupDto, @Req() req: AuthenticatedRequest) {
    const group = await this.prisma.vehicleGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    if (req.user.role !== UserRole.SUPER_ADMIN && group.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    return this.prisma.vehicleGroup.update({ where: { id }, data: { name: dto.name } });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const group = await this.prisma.vehicleGroup.findUnique({ where: { id } });
    if (!group) return;
    if (req.user.role !== UserRole.SUPER_ADMIN && group.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.vehicleGroup.delete({ where: { id } });
  }

  @Post(':id/vehicles')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async addVehicle(@Param('id') id: string, @Body() dto: AddVehicleToGroupDto, @Req() req: AuthenticatedRequest) {
    const group = await this.prisma.vehicleGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    if (req.user.role !== UserRole.SUPER_ADMIN && group.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    return this.prisma.vehicleGroupAssignment.create({
      data: { vehicleId: dto.vehicleId, groupId: id },
    });
  }

  @Delete(':id/vehicles/:vehicleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async removeVehicle(@Param('id') id: string, @Param('vehicleId') vehicleId: string, @Req() req: AuthenticatedRequest) {
    const group = await this.prisma.vehicleGroup.findUnique({ where: { id } });
    if (!group) return;
    if (req.user.role !== UserRole.SUPER_ADMIN && group.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.vehicleGroupAssignment.delete({
      where: { vehicleId_groupId: { vehicleId, groupId: id } },
    }).catch((e) => {
      // Prisma P2025 = record not found (already removed), ignore
      if ((e as any)?.code === 'P2025') return;
      throw e;
    });
  }
}
