import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { AccessType, Prisma, UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { InvitationsService } from '../invitations/invitations.service';
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
    private readonly invitations: InvitationsService,
  ) {}

  // ─── /me — current user (Sprint J) ────────────────────────────

  @Get('me')
  async getMe(@Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        phone: true, role: true, permissions: true, fleetId: true,
        isActive: true, onboardingCompletedAt: true,
        escalationContactUserId: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Patch('me')
  async updateMe(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { firstName?: string; lastName?: string; phone?: string | null; escalationContactUserId?: string | null },
  ) {
    if (dto.phone && !/^\+\d{6,15}$/.test(dto.phone)) {
      throw new BadRequestException('Numero de telephone doit etre au format E.164 (ex: +33612345678)');
    }
    if (dto.escalationContactUserId) {
      const target = await this.prisma.user.findUnique({
        where: { id: dto.escalationContactUserId },
        select: { id: true, fleetId: true },
      });
      if (!target) throw new NotFoundException('Contact d\'escalade introuvable');
      if (req.user.role !== UserRole.SUPER_ADMIN && target.fleetId !== req.user.fleetId) {
        throw new ForbiddenException('Le contact d\'escalade doit etre dans la meme flotte');
      }
      if (target.id === req.user.id) {
        throw new BadRequestException('Le contact d\'escalade ne peut pas etre vous-meme');
      }
    }
    return this.prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.escalationContactUserId !== undefined ? { escalationContactUserId: dto.escalationContactUserId } : {}),
      },
      select: {
        id: true, email: true, firstName: true, lastName: true, phone: true,
        role: true, fleetId: true, escalationContactUserId: true,
      },
    });
  }

  @Post('me/onboarding-complete')
  @HttpCode(HttpStatus.OK)
  async completeOnboarding(@Req() req: AuthenticatedRequest) {
    const updated = await this.prisma.user.update({
      where: { id: req.user.id },
      data: { onboardingCompletedAt: new Date() },
      select: { id: true, onboardingCompletedAt: true },
    });
    return updated;
  }

  // ─── /invitations — Sprint J ──────────────────────────────────

  @Post('invitations')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async invite(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { email: string; role: UserRole; fleetId?: string | null },
  ) {
    if (!dto.email || !dto.role) {
      throw new BadRequestException('email et role sont requis');
    }
    const fleetId = req.user.role === UserRole.SUPER_ADMIN
      ? (dto.fleetId ?? null)
      : req.user.fleetId;
    return this.invitations.create({
      email: dto.email,
      role: dto.role,
      fleetId,
      requestedByUserId: req.user.id,
    });
  }

  @Get('invitations')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async listInvitations(@Req() req: AuthenticatedRequest) {
    const items = await this.invitations.list({
      id: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
    return { items };
  }

  @Post('invitations/:id/revoke')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async revokeInvitation(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.revoke(id, {
      id: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

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
        permissions: getDefaultPermissions(dto.role) as unknown as Prisma.JsonObject,
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
        ...(roleChanged ? { permissions: getDefaultPermissions(dto.role!) as unknown as Prisma.JsonObject } : {}),
        ...(dto.permissions !== undefined && !roleChanged ? { permissions: dto.permissions as unknown as Prisma.JsonObject } : {}),
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
