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
import {
  AccessEntryDto,
  SetUserAccessDto,
  UpdateAccessEntryPermissionsDto,
} from './dto/set-access.dto';
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
        preferences: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * V1.12 — Preferences UI per-user (notamment uiMode: tracky | baanool).
   * Merge partiel : seules les cles fournies dans le body sont mises a jour,
   * le reste des preferences est preserve.
   */
  @Patch('me/preferences')
  async updateMyPreferences(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { uiMode?: 'tracky' | 'baanool' },
  ) {
    if (dto.uiMode !== undefined && dto.uiMode !== 'tracky' && dto.uiMode !== 'baanool') {
      throw new BadRequestException('uiMode doit etre "tracky" ou "baanool"');
    }
    const current = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { preferences: true },
    });
    const merged = {
      ...((current?.preferences as Record<string, unknown>) ?? {}),
      ...dto,
    };
    return this.prisma.user.update({
      where: { id: req.user.id },
      data: { preferences: merged },
      select: { id: true, preferences: true },
    });
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

  /**
   * V1.11 Phase 1 — Le current user lit ses propres lignes d'acces resolues.
   * Utilise par le frontend pour caster `can(perm, vehicleId)` cote client
   * (resolution per-vehicle miroir du backend).
   */
  @Get('me/access')
  async getMyAccess(@Req() req: AuthenticatedRequest) {
    const rules = await this.prisma.userVehicleAccess.findMany({
      where: { userId: req.user.id },
      select: {
        id: true, accessType: true, groupId: true, vehicleId: true,
        permissions: true, createdAt: true, updatedAt: true,
        group: {
          select: {
            id: true, name: true,
            vehicles: { select: { vehicleId: true } },
          },
        },
        vehicle: { select: { id: true, plate: true } },
      },
    });
    return { entries: rules };
  }

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
      select: {
        id: true, accessType: true, groupId: true, vehicleId: true,
        permissions: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const hasAll = rules.some((r) => r.accessType === AccessType.ALL);

    // Nouveau format avec entries[] + format legacy en parallele (UI en transition).
    return {
      entries: rules,
      // Format legacy (pour compat front non migre)
      type: hasAll ? 'ALL' : 'CUSTOM',
      groupIds: rules
        .filter((r) => r.accessType === AccessType.GROUP && r.groupId)
        .map((r) => r.groupId!),
      vehicleIds: rules
        .filter((r) => r.accessType === AccessType.VEHICLE && r.vehicleId)
        .map((r) => r.vehicleId!),
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

    // Normalise les 2 formats (nouveau entries[] OU legacy type+groupIds+vehicleIds)
    // en une liste unique d'entries a creer.
    const entries: AccessEntryDto[] = dto.entries
      ? dto.entries
      : this.legacyToEntries(dto);

    if (entries.length === 0) {
      throw new BadRequestException(
        'Au moins une entree d\'acces requise (ALL, GROUP, ou VEHICLE)',
      );
    }

    // Validation multi-flotte : chaque group/vehicle doit appartenir a la fleet
    // de l'utilisateur edite. Pattern Sprint 6 — defense en profondeur.
    await this.validateAccessEntriesScope(entries, user.fleetId);

    // Replace atomique : on supprime tout puis on recree.
    await this.prisma.$transaction([
      this.prisma.userVehicleAccess.deleteMany({ where: { userId: id } }),
      this.prisma.userVehicleAccess.createMany({
        data: entries.map((e) => ({
          userId: id,
          accessType: e.type as AccessType,
          groupId: e.type === 'GROUP' ? e.groupId : null,
          vehicleId: e.type === 'VEHICLE' ? e.vehicleId : null,
          permissions: (e.permissions ?? null) as unknown as Prisma.InputJsonValue,
        })),
      }),
    ]);

    // Retour : nouveau format + legacy pour compat
    const refreshed = await this.prisma.userVehicleAccess.findMany({
      where: { userId: id },
      select: {
        id: true, accessType: true, groupId: true, vehicleId: true,
        permissions: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const hasAll = refreshed.some((r) => r.accessType === AccessType.ALL);
    return {
      entries: refreshed,
      type: hasAll ? 'ALL' : 'CUSTOM',
      groupIds: refreshed
        .filter((r) => r.accessType === AccessType.GROUP && r.groupId)
        .map((r) => r.groupId!),
      vehicleIds: refreshed
        .filter((r) => r.accessType === AccessType.VEHICLE && r.vehicleId)
        .map((r) => r.vehicleId!),
    };
  }

  /**
   * V1.11 Phase 1 — Toggle d'une case dans la matrice 2D. Modifie les
   * permissions d'UNE seule ligne d'acces, sans toucher aux autres lignes.
   */
  @Patch(':userId/access/:accessId')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async updateAccessPermissions(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('accessId', ParseUUIDPipe) accessId: string,
    @Body() dto: UpdateAccessEntryPermissionsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // 1. Verifier que l'user cible est dans la fleet du caller (defense en profondeur)
    const userWhere: Prisma.UserWhereInput = { id: userId };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      userWhere.fleetId = req.user.fleetId;
    }
    const targetUser = await this.prisma.user.findFirst({ where: userWhere });
    if (!targetUser) throw new NotFoundException('User not found');

    // 2. Verifier que la ligne d'acces appartient bien a ce user
    const entry = await this.prisma.userVehicleAccess.findFirst({
      where: { id: accessId, userId },
    });
    if (!entry) throw new NotFoundException('Access entry not found');

    // 3. Update permissions JSON
    const updated = await this.prisma.userVehicleAccess.update({
      where: { id: accessId },
      data: { permissions: dto.permissions as unknown as Prisma.InputJsonValue },
      select: {
        id: true, accessType: true, groupId: true, vehicleId: true,
        permissions: true, createdAt: true, updatedAt: true,
      },
    });
    return updated;
  }

  /**
   * V1.11 Phase 1 — Supprimer une ligne d'acces (retirer un scope a un user).
   * Refus si c'est la derniere ligne, sinon le user n'aurait plus aucun acces.
   */
  @Delete(':userId/access/:accessId')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async deleteAccessEntry(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('accessId', ParseUUIDPipe) accessId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userWhere: Prisma.UserWhereInput = { id: userId };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      userWhere.fleetId = req.user.fleetId;
    }
    const targetUser = await this.prisma.user.findFirst({ where: userWhere });
    if (!targetUser) throw new NotFoundException('User not found');

    const entry = await this.prisma.userVehicleAccess.findFirst({
      where: { id: accessId, userId },
    });
    if (!entry) throw new NotFoundException('Access entry not found');

    const totalEntries = await this.prisma.userVehicleAccess.count({ where: { userId } });
    if (totalEntries <= 1) {
      throw new BadRequestException(
        'Impossible de supprimer la derniere entree d\'acces. Utilisez d\'abord PUT /users/:id/access pour reconfigurer.',
      );
    }

    await this.prisma.userVehicleAccess.delete({ where: { id: accessId } });
    return { ok: true };
  }

  // ─── Internals (vehicle access) ──────────────────────────

  private legacyToEntries(dto: SetUserAccessDto): AccessEntryDto[] {
    if (dto.type === 'ALL') {
      return [Object.assign(new AccessEntryDto(), { type: 'ALL' as const })];
    }
    const entries: AccessEntryDto[] = [];
    for (const groupId of dto.groupIds ?? []) {
      entries.push(Object.assign(new AccessEntryDto(), { type: 'GROUP' as const, groupId }));
    }
    for (const vehicleId of dto.vehicleIds ?? []) {
      entries.push(Object.assign(new AccessEntryDto(), { type: 'VEHICLE' as const, vehicleId }));
    }
    return entries;
  }

  /**
   * Verifie que chaque entry GROUP/VEHICLE pointe vers une ressource de la
   * meme flotte que l'utilisateur edite. Empeche un FLEET_ADMIN flotte A
   * d'attribuer un groupe de la flotte B (et idem pour SUPER_ADMIN qui doit
   * utiliser le fleetId du user edite, pas le sien).
   */
  private async validateAccessEntriesScope(
    entries: AccessEntryDto[],
    targetUserFleetId: string | null,
  ): Promise<void> {
    // Validation structurelle : GROUP requiert groupId, VEHICLE requiert vehicleId
    for (const entry of entries) {
      if (entry.type === 'GROUP' && !entry.groupId) {
        throw new BadRequestException('groupId requis pour une entree type GROUP');
      }
      if (entry.type === 'VEHICLE' && !entry.vehicleId) {
        throw new BadRequestException('vehicleId requis pour une entree type VEHICLE');
      }
    }

    const groupIds = entries.filter((e) => e.type === 'GROUP' && e.groupId).map((e) => e.groupId!);
    const vehicleIds = entries.filter((e) => e.type === 'VEHICLE' && e.vehicleId).map((e) => e.vehicleId!);

    if (groupIds.length > 0) {
      const found = await this.prisma.vehicleGroup.findMany({
        where: { id: { in: groupIds }, fleetId: targetUserFleetId ?? undefined },
        select: { id: true },
      });
      if (found.length !== groupIds.length) {
        throw new BadRequestException(
          'Un ou plusieurs groupes n\'appartiennent pas a la flotte de cet utilisateur',
        );
      }
    }

    if (vehicleIds.length > 0) {
      const found = await this.prisma.vehicle.findMany({
        where: { id: { in: vehicleIds }, fleetId: targetUserFleetId ?? undefined },
        select: { id: true },
      });
      if (found.length !== vehicleIds.length) {
        throw new BadRequestException(
          'Un ou plusieurs vehicules n\'appartiennent pas a la flotte de cet utilisateur',
        );
      }
    }
  }

  // ─── SUPER_ADMIN : Sync Auth/Tracky ─────────────────────────────

  @Get('admin/auth-sync')
  @Roles(UserRole.SUPER_ADMIN)
  async authSync() {
    // Query Vizyo Auth DB directly (same Docker network)
    const { Pool } = require('pg') as typeof import('pg');
    const authDbUrl = this.config.get('VIZYO_AUTH_DB_URL', { infer: true }) as string | undefined;
    let authUsers: Array<{ id: string; email: string; status: string; createdAt: string }> = [];

    if (authDbUrl) {
      const pool = new Pool({ connectionString: authDbUrl, max: 2 });
      try {
        const appInternalId = this.config.get('VIZYO_AUTH_APP_INTERNAL_ID', { infer: true });
        const result = await pool.query(
          `SELECT u.id, u.email, ua.status, u."createdAt"
           FROM "User" u
           JOIN "UserApp" ua ON ua."userId" = u.id
           WHERE ua."appId" = $1
           ORDER BY u.email`,
          [appInternalId],
        );
        authUsers = result.rows.map((r: any) => ({
          id: r.id,
          email: r.email,
          status: r.status ?? 'active',
          createdAt: r.createdAt?.toISOString() ?? '',
        }));
      } catch (err) {
        this.logger.warn(`Auth DB query failed: ${(err as Error).message}`);
      } finally {
        await pool.end();
      }
    }

    const trackyUsers = await this.prisma.user.findMany({
      select: { id: true, authUserId: true, email: true, role: true, fleetId: true, isActive: true, createdAt: true },
      orderBy: { email: 'asc' },
    });

    const trackyByAuthId = new Map(trackyUsers.filter((u) => u.authUserId).map((u) => [u.authUserId, u]));
    const trackyByEmail = new Map(trackyUsers.map((u) => [u.email.toLowerCase(), u]));
    const authByEmail = new Map(authUsers.map((u) => [u.email.toLowerCase(), u]));

    const synced: any[] = [];
    const onlyAuth: any[] = [];
    const onlyTracky: any[] = [];

    for (const au of authUsers) {
      const tu = trackyByAuthId.get(au.id) ?? trackyByEmail.get(au.email.toLowerCase());
      if (tu) {
        synced.push({ authId: au.id, email: au.email, authStatus: au.status, trackyId: tu.id, role: tu.role, fleetId: tu.fleetId, isActive: tu.isActive });
      } else {
        onlyAuth.push({ authId: au.id, email: au.email, status: au.status, createdAt: au.createdAt });
      }
    }

    for (const tu of trackyUsers) {
      if (!authByEmail.has(tu.email.toLowerCase())) {
        onlyTracky.push({ trackyId: tu.id, email: tu.email, role: tu.role, fleetId: tu.fleetId, isActive: tu.isActive });
      }
    }

    return { synced, onlyAuth, onlyTracky, totalAuth: authUsers.length, totalTracky: trackyUsers.length };
  }

  // ─── Vue panorama permissions/groupes/users ─────────────────────

  @Get('panorama')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async panorama(@Req() req: AuthenticatedRequest) {
    const fleetFilter: Prisma.UserWhereInput = {};
    const groupFilter: Prisma.VehicleGroupWhereInput = {};
    if (req.user.role !== UserRole.SUPER_ADMIN && req.user.fleetId) {
      fleetFilter.fleetId = req.user.fleetId;
      groupFilter.fleetId = req.user.fleetId;
    }

    const [users, groups] = await Promise.all([
      this.prisma.user.findMany({
        where: { ...fleetFilter, isActive: true },
        select: {
          id: true, email: true, firstName: true, lastName: true, role: true,
          fleetId: true, permissions: true,
          vehicleAccess: {
            select: {
              id: true, accessType: true, permissions: true,
              group: { select: { id: true, name: true } },
              vehicle: { select: { id: true, plate: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { email: 'asc' },
      }),
      this.prisma.vehicleGroup.findMany({
        where: groupFilter,
        select: {
          id: true, name: true, fleetId: true,
          vehicles: { select: { vehicle: { select: { id: true, plate: true } } } },
          users: { select: { userId: true } },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    return { users, groups };
  }

  @Delete('admin/auth-sync/tracky/:trackyUserId')
  @Roles(UserRole.SUPER_ADMIN)
  async removeFromTracky(@Param('trackyUserId') trackyUserId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: trackyUserId }, select: { role: true, email: true } });
    if (!user) return { ok: true };
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Impossible de supprimer un compte SUPER_ADMIN');
    }
    await this.prisma.userVehicleAccess.deleteMany({ where: { userId: trackyUserId } });
    await this.prisma.user.delete({ where: { id: trackyUserId } });
    return { ok: true };
  }

  @Delete('admin/auth-sync/:authUserId')
  @Roles(UserRole.SUPER_ADMIN)
  async removeFromAuth(@Param('authUserId') authUserId: string) {
    const authDbUrl = this.config.get('VIZYO_AUTH_DB_URL', { infer: true }) as string | undefined;
    if (!authDbUrl) throw new BadRequestException('VIZYO_AUTH_DB_URL not configured');

    const { Pool } = require('pg') as typeof import('pg');
    const pool = new Pool({ connectionString: authDbUrl, max: 2 });
    try {
      const appInternalId = this.config.get('VIZYO_AUTH_APP_INTERNAL_ID', { infer: true });
      // Remove UserApp entry (detach from this app)
      await pool.query(
        `DELETE FROM "UserApp" WHERE "userId" = $1 AND "appId" = $2`,
        [authUserId, appInternalId],
      );
      // Remove sessions for this app
      await pool.query(
        `DELETE FROM "Session" WHERE "userId" = $1 AND "appId" = $2`,
        [authUserId, appInternalId],
      );
      // If user has no other apps, delete entirely
      const remaining = await pool.query(
        `SELECT COUNT(*) as c FROM "UserApp" WHERE "userId" = $1`,
        [authUserId],
      );
      if (parseInt(remaining.rows[0].c) === 0) {
        await pool.query(`DELETE FROM "Credential" WHERE "userId" = $1`, [authUserId]);
        await pool.query(`DELETE FROM "User" WHERE id = $1`, [authUserId]);
      }
    } finally {
      await pool.end();
    }
    return { ok: true };
  }
}
