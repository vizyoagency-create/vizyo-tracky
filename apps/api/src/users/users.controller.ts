import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus,
  Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessType, Prisma, UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
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
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
    private readonly invitations: InvitationsService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService<Env, true>,
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
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async invite(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { email: string; role: UserRole; fleetId?: string | null; permissions?: Record<string, boolean> },
  ) {
    if (!dto.email || !dto.role) {
      throw new BadRequestException('email et role sont requis');
    }
    // FLEET_MANAGER: check users_manage permission (RBAC verifie aussi dans le service)
    if (req.user.role === UserRole.FLEET_MANAGER) {
      const perms = req.user.permissions as Record<string, boolean> | null;
      if (!perms?.users_manage) throw new ForbiddenException('Permission insuffisante');
    }
    const fleetId = req.user.role === UserRole.SUPER_ADMIN
      ? (dto.fleetId ?? null)
      : req.user.fleetId;
    return this.invitations.create({
      email: dto.email,
      role: dto.role,
      fleetId,
      requestedByUserId: req.user.id,
      permissions: dto.permissions ?? null,
    });
  }

  @Get('invitations')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async listInvitations(@Req() req: AuthenticatedRequest) {
    if (req.user.role === UserRole.FLEET_MANAGER) {
      const perms = req.user.permissions as Record<string, boolean> | null;
      if (!perms?.users_manage) throw new ForbiddenException('Permission insuffisante');
    }
    const items = await this.invitations.list({
      id: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
    return { items };
  }

  @Post('invitations/:id/resend')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async resendInvitation(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (req.user.role === UserRole.FLEET_MANAGER) {
      const perms = req.user.permissions as Record<string, boolean> | null;
      if (!perms?.users_manage) throw new ForbiddenException('Permission insuffisante');
    }
    return this.invitations.resend(id, {
      id: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post('invitations/:id/revoke')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async revokeInvitation(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (req.user.role === UserRole.FLEET_MANAGER) {
      const perms = req.user.permissions as Record<string, boolean> | null;
      if (!perms?.users_manage) throw new ForbiddenException('Permission insuffisante');
    }
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
  async findAll(
    @Req() req: AuthenticatedRequest,
    @Query('includeArchived') includeArchived?: string,
    @Query('includePending') includePending?: string,
  ) {
    const where: Prisma.UserWhereInput = req.user.role === UserRole.SUPER_ADMIN
      ? {}
      : { fleetId: req.user.fleetId };

    // Par defaut, on ne retourne que les utilisateurs actifs
    if (includeArchived !== 'true') {
      where.isActive = true;
    }

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

    if (includePending === 'true') {
      const invWhere: Prisma.InvitationWhereInput = {
        status: { in: ['PENDING', 'EXPIRED'] },
      };
      if (req.user.role !== UserRole.SUPER_ADMIN) {
        invWhere.fleetId = req.user.fleetId;
      }
      const invitations = await this.prisma.invitation.findMany({
        where: invWhere,
        orderBy: { createdAt: 'desc' },
      });
      return {
        users,
        pendingInvitations: invitations.map((inv) => ({
          id: inv.id,
          email: inv.email,
          role: inv.role,
          fleetId: inv.fleetId,
          status: inv.status,
          permissions: inv.permissions,
          expiresAt: inv.expiresAt.toISOString(),
          createdAt: inv.createdAt.toISOString(),
        })),
      };
    }

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
    // Filtre tenant integre au where : 404 si user d'une autre flotte.
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({ where });
    if (!user) throw new NotFoundException('User not found');

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
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async archive(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    // Filtre tenant integre au where : 404 si user d'une autre flotte.
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('Utilisateur introuvable');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({
      where,
      select: { id: true, authUserId: true, fleetId: true, role: true },
    });

    if (!user) throw new NotFoundException('Utilisateur introuvable');

    // FLEET_ADMIN ne peut pas etre archive (compte principal de la flotte)
    if (user.role === UserRole.FLEET_ADMIN) {
      throw new ForbiddenException('Impossible d\'archiver l\'administrateur de la flotte');
    }

    // Impossible de s'archiver soi-meme
    if (user.id === req.user.id) {
      throw new ForbiddenException('Impossible de s\'archiver soi-meme');
    }

    // 1. Suspendre dans Vizyo Auth (plus de login possible)
    try {
      await this.authClient.suspendUser(user.authUserId);
    } catch {
      // Non-bloquant si Vizyo Auth est down
    }

    // 2. Detacher les acces vehicules
    await this.prisma.userVehicleAccess.deleteMany({ where: { userId: id } });

    // 3. Marquer comme inactif
    await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    return { ok: true };
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async resetPassword(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    // Filtre tenant integre au where : 404 si user d'une autre flotte.
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('Utilisateur introuvable');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({
      where,
      select: { id: true, email: true, firstName: true, lastName: true, fleetId: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    // Meme flow que forgot-password
    try {
      const result = await this.authClient.requestPasswordReset(user.email);
      if (result.token) {
        const vizAuthWebUrl = this.config.get('VIZYO_AUTH_WEB_URL', { infer: true });
        const appBaseUrl = this.config.get('APP_BASE_URL', { infer: true });
        const redirectUrl = `${appBaseUrl}/login?email=${encodeURIComponent(user.email)}`;
        const resetUrl = `${vizAuthWebUrl}/reset-password?token=${result.token}&redirect=${encodeURIComponent(redirectUrl)}`;

        const emailContent = this.emailService.buildPasswordResetEmail({
          recipientName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
          resetUrl,
          expiresInMinutes: 60,
        });

        await this.emailService.send({ to: user.email, ...emailContent });
      }
    } catch (err) {
      this.logger.warn({ userId: id, error: (err as Error).message }, 'Admin password reset email failed');
    }
    return { ok: true };
  }

  // ─── Vehicle Access ──────────────────────────────────────

  @Get(':id/access')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async getAccess(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    // Filtre tenant integre au where : 404 si user d'une autre flotte.
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({ where });
    if (!user) throw new NotFoundException('User not found');

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
    // Filtre tenant integre au where : 404 si user d'une autre flotte.
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({ where });
    if (!user) throw new NotFoundException('User not found');

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
