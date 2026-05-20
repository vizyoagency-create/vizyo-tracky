import {
  BadRequestException,
  Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus,
  NotFoundException, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
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

  /**
   * Charge un groupe en appliquant le filtre tenant dans le where (404 plutot
   * que 403 pour ne pas leak l'existence cross-fleet). Retourne null si le
   * groupe n'existe pas OU n'appartient pas a la flotte du caller — au caller
   * de decider entre 404 ou silent return.
   */
  private async findGroupInFleet(id: string, req: AuthenticatedRequest) {
    const where: Prisma.VehicleGroupWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) return null;
      where.fleetId = req.user.fleetId;
    }
    return this.prisma.vehicleGroup.findFirst({ where });
  }

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
    const group = await this.findGroupInFleet(id, req);
    if (!group) throw new NotFoundException('Group not found');

    return this.prisma.vehicleGroup.update({ where: { id }, data: { name: dto.name } });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const group = await this.findGroupInFleet(id, req);
    if (!group) return;

    await this.prisma.vehicleGroup.delete({ where: { id } });
  }

  @Post(':id/vehicles')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async addVehicle(@Param('id') id: string, @Body() dto: AddVehicleToGroupDto, @Req() req: AuthenticatedRequest) {
    const group = await this.findGroupInFleet(id, req);
    if (!group) throw new NotFoundException('Group not found');

    // Defense en profondeur : le vehicule doit appartenir a la meme flotte que
    // le groupe. Sans ce check, on pouvait ajouter un vehicule cross-flotte
    // a son groupe en connaissant les deux IDs.
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: dto.vehicleId, fleetId: group.fleetId },
      select: { id: true },
    });
    if (!vehicle) throw new BadRequestException('Vehicule introuvable dans cette flotte');

    return this.prisma.vehicleGroupAssignment.create({
      data: { vehicleId: dto.vehicleId, groupId: id },
    });
  }

  @Delete(':id/vehicles/:vehicleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async removeVehicle(@Param('id') id: string, @Param('vehicleId') vehicleId: string, @Req() req: AuthenticatedRequest) {
    const group = await this.findGroupInFleet(id, req);
    if (!group) return;

    await this.prisma.vehicleGroupAssignment.delete({
      where: { vehicleId_groupId: { vehicleId, groupId: id } },
    }).catch((e) => {
      // Prisma P2025 = record not found (already removed), ignore
      if ((e as any)?.code === 'P2025') return;
      throw e;
    });
  }
}
