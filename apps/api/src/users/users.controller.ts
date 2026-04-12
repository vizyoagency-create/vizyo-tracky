import {
  Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus,
  NotFoundException, Param, Patch, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import { AccessType, UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { getDefaultPermissions } from './default-permissions';
import { CreateUserDto } from './dto/create-user.dto';
import { SetUserAccessDto } from './dto/set-access.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const PRIVILEGED_ROLES: UserRole[] = [UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN];

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
  ) {}

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async create(@Body() dto: CreateUserDto, @Req() req: AuthenticatedRequest) {
    // FLEET_ADMIN cannot create FLEET_ADMIN or SUPER_ADMIN
    if (req.user.role === UserRole.FLEET_ADMIN && PRIVILEGED_ROLES.includes(dto.role)) {
      throw new ForbiddenException('Cannot create users with this role');
    }

    const displayName = [dto.firstName, dto.lastName].filter(Boolean).join(' ') || undefined;

    const result = await this.authClient.register(
      dto.email,
      dto.password,
      displayName,
    );

    // Auth returns { id } for new users, or { ok: true } for existing users linked to a new app
    let authUserId: string = result.id ?? '';
    if (!authUserId) {
      // User already exists in Auth — login to get the authUserId from JWT
      const tokens = await this.authClient.login(dto.email, dto.password);
      const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64').toString()) as { sub: string };
      authUserId = payload.sub;
    }

    const fleetId = req.user.role === UserRole.SUPER_ADMIN && dto.fleetId
      ? dto.fleetId
      : req.user.fleetId;

    const user = await this.prisma.user.create({
      data: {
        authUserId,
        email: dto.email.toLowerCase(),
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role,
        permissions: getDefaultPermissions(dto.role),
        fleetId,
      },
    });

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      permissions: user.permissions,
      fleetId: user.fleetId,
    };
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async findAll(@Req() req: AuthenticatedRequest) {
    const where = req.user.role === UserRole.SUPER_ADMIN
      ? {}
      : { fleetId: req.user.fleetId };

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        permissions: true,
        fleetId: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return users;
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        permissions: true,
        fleetId: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user) return null;

    // Non-SUPER_ADMIN can only see users in their fleet
    if (req.user.role !== UserRole.SUPER_ADMIN && user.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    return user;
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    if (req.user.role !== UserRole.SUPER_ADMIN && user.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    // FLEET_ADMIN ne peut pas assigner FLEET_ADMIN ou SUPER_ADMIN
    if (dto.role && req.user.role === UserRole.FLEET_ADMIN && PRIVILEGED_ROLES.includes(dto.role)) {
      throw new ForbiddenException('Cannot assign this role');
    }

    // Si le rôle change, réinitialiser les permissions par défaut du nouveau rôle
    const roleChanged = dto.role !== undefined && dto.role !== user.role;

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(roleChanged ? { permissions: getDefaultPermissions(dto.role!) } : {}),
        ...(dto.permissions !== undefined && !roleChanged ? { permissions: dto.permissions } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, permissions: true, fleetId: true, isActive: true, createdAt: true },
    });

    return updated;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, authUserId: true, fleetId: true, role: true },
    });

    if (!user) return;

    // Non-SUPER_ADMIN can only delete users in their fleet
    if (req.user.role !== UserRole.SUPER_ADMIN && user.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    // Cannot delete yourself
    if (user.id === req.user.id) {
      throw new ForbiddenException('Cannot delete yourself');
    }

    await this.authClient.removeUserFromApp(user.authUserId);
    await this.prisma.user.delete({ where: { id } });
  }

  // ─── Vehicle Access ──────────────────────────────────────

  @Get(':id/access')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async getAccess(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (req.user.role !== UserRole.SUPER_ADMIN && user.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    const rules = await this.prisma.userVehicleAccess.findMany({
      where: { userId: id },
      select: { id: true, accessType: true, groupId: true, vehicleId: true },
    });

    const hasAll = rules.some((r) => r.accessType === AccessType.ALL);
    if (hasAll) return { type: 'ALL' as const, groupIds: [], vehicleIds: [] };

    return {
      type: 'CUSTOM' as const,
      groupIds: rules.filter((r) => r.accessType === AccessType.GROUP && r.groupId).map((r) => r.groupId!),
      vehicleIds: rules.filter((r) => r.accessType === AccessType.VEHICLE && r.vehicleId).map((r) => r.vehicleId!),
    };
  }

  @Put(':id/access')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async setAccess(@Param('id') id: string, @Body() dto: SetUserAccessDto, @Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (req.user.role !== UserRole.SUPER_ADMIN && user.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Access denied');
    }

    // Supprimer les règles existantes
    await this.prisma.userVehicleAccess.deleteMany({ where: { userId: id } });

    if (dto.type === 'ALL') {
      await this.prisma.userVehicleAccess.create({
        data: { userId: id, accessType: AccessType.ALL },
      });
      return { type: 'ALL', groupIds: [], vehicleIds: [] };
    }

    // Créer les règles CUSTOM
    const creates: { userId: string; accessType: AccessType; groupId?: string; vehicleId?: string }[] = [];

    for (const groupId of dto.groupIds ?? []) {
      creates.push({ userId: id, accessType: AccessType.GROUP, groupId });
    }
    for (const vehicleId of dto.vehicleIds ?? []) {
      creates.push({ userId: id, accessType: AccessType.VEHICLE, vehicleId });
    }

    if (creates.length > 0) {
      await this.prisma.userVehicleAccess.createMany({ data: creates });
    }

    return { type: 'CUSTOM', groupIds: dto.groupIds ?? [], vehicleIds: dto.vehicleIds ?? [] };
  }
}
