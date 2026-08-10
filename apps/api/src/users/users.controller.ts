import { NO_FLEET, requiredFleetScope } from '../common/tenant-scope';
import { AuthAccountSyncService } from './auth-account-sync.service';
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus,
  Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessType, Prisma, UserRole } from '@prisma/client';
import { AuthClientService } from '../auth-client/auth-client.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { InvitationsService } from '../invitations/invitations.service';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { MissionShareService } from '../depot/mission-share.service';
import { PrismaService } from '../prisma/prisma.service';
import { clampPartialPermissions, clampPermissions, getDefaultPermissions } from './default-permissions';
// Espace dépôt (2026-08) — importé directement de la source de vérité, comme le
// demande l'en-tête de `default-permissions.ts` pour tout nouveau code.
import { permissionsForTargetRole } from '@vizyo/tracky-shared';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateUserDto } from './dto/create-user.dto';
import {
  AccessEntryDto,
  SetUserAccessDto,
  UpdateAccessEntryPermissionsDto,
} from './dto/set-access.dto';
import { UpdateInvitationDto } from './dto/update-invitation.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const PRIVILEGED_ROLES: UserRole[] = [UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN];

/** Compte « système » (seed) — sert de cible neutre quand on masque l'auteur owner. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authClient: AuthClientService,
    private readonly accountSync: AuthAccountSyncService,
    private readonly invitations: InvitationsService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService<Env, true>,
    private readonly ownerVis: OwnerVisibilityService,
    // Lot A4 — archiver un compte ferme aussi les liens publics qu'il a distribues.
    private readonly missionShare: MissionShareService,
  ) {}

  /**
   * Owner plateforme — un viewer NON-owner ne doit ni voir ni modifier un compte
   * owner. Lève le MÊME 404 qu'un id inexistant (aucun oracle d'existence).
   * No-op pour un viewer owner (il gère tout le monde) et pour une cible non-owner.
   */
  private async assertTargetVisible(id: string, req: AuthenticatedRequest): Promise<void> {
    if (!this.ownerVis.isMasked(req.user)) return;
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { isOwner: true },
    });
    if (target?.isOwner) throw new NotFoundException('User not found');
  }

  // ─── /me — current user (Sprint J) ────────────────────────────

  @Get('me')
  async getMe(@Req() req: AuthenticatedRequest) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        phone: true, role: true, permissions: true, fleetId: true,
        isActive: true, isOwner: true, onboardingCompletedAt: true,
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
      throw new BadRequestException('uiMode doit être "tracky" ou "baanool"');
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
      throw new BadRequestException('Numéro de téléphone doit être au format E.164 (ex: +33612345678)');
    }
    if (dto.escalationContactUserId) {
      const target = await this.prisma.user.findUnique({
        where: { id: dto.escalationContactUserId },
        select: { id: true, fleetId: true },
      });
      if (!target) throw new NotFoundException('Contact d\'escalade introuvable');
      if (req.user.role !== UserRole.SUPER_ADMIN && target.fleetId !== req.user.fleetId) {
        throw new ForbiddenException('Le contact d\'escalade doit être dans la même flotte');
      }
      if (target.id === req.user.id) {
        throw new BadRequestException('Le contact d\'escalade ne peut pas être vous-même');
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
  @RequirePermissions('users_manage')
  async invite(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateInvitationDto,
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
      accessScopes: dto.accessScopes ?? null,
    });
  }

  @Get('invitations')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('users_manage')
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
    // Owner plateforme — masque l'owner comme CRÉATEUR d'invitation (→ compte
    // système) pour un viewer non-owner, sans cacher l'invitation elle-même
    // (l'invité reste légitime et visible aux autres admins).
    if (this.ownerVis.isMasked(req.user)) {
      const ownerIds = await this.ownerVis.getOwnerIds();
      if (ownerIds.length) {
        for (const it of items) {
          if (ownerIds.includes(it.createdById)) it.createdById = SYSTEM_USER_ID;
        }
      }
    }
    return { items };
  }

  @Post('invitations/:id/resend')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('users_manage')
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

  @Patch('invitations/:id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async updateInvitation(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvitationDto,
  ) {
    return this.invitations.update(id, dto, {
      id: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post('invitations/:id/revoke')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('users_manage')
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
        // Sécurité — les permissions par défaut du rôle cible sont BORNÉES à l'autorité
        // du créateur (clampPermissions) : un granter ne peut jamais doter un nouvel
        // utilisateur d'une capacité qu'il ne possède pas lui-même. Aujourd'hui la route
        // est FLEET_ADMIN/SUPER_ADMIN-only (tous deux ADMIN_DEFAULTS → clamp = no-op), mais
        // ce clamp rend l'invariant robuste si @Roles était un jour élargi (pas de bug
        // silencieux d'escalade). Cf. clampPermissions + permissions.spec.
        // Espace dépôt (2026-08) — `permissionsForTargetRole` remplace `clampPermissions`
        // seul. Le clamp borne au GRANTER, pas à la CIBLE : un FLEET_ADMIN, qui détient
        // tout, pouvait donc doter un compte DEPOT de `vehicles_view` et franchir le clamp
        // sans encombre. Pour un rôle FERMÉ, la demande est désormais ignorée et on écrit
        // les défauts du rôle. Cf. A5 § 4 : « le périmètre d'un dépôt est fixé par ses
        // missions ».
        permissions: permissionsForTargetRole(
          dto.role,
          getDefaultPermissions(dto.role),
          req.user,
        ) as unknown as Prisma.JsonObject,
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
  @RequirePermissions('users_view')
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

    // Owner plateforme — invisible aux autres super-admins (un owner voit tout).
    if (this.ownerVis.isMasked(req.user)) where.isOwner = false;

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
          /**
           * ⚠️ STATUT CALCULÉ À LA LECTURE, et non lu tel quel en base.
           *
           * Constat du 2026-08-03 sur cdef31 : quatre invitations créées le 2 juillet,
           * valables 24 h, portaient encore `PENDING` un MOIS après leur expiration.
           * Rien ne fait jamais passer une invitation de `PENDING` à `EXPIRED` : ni cron,
           * ni tâche, ni relecture. Le statut en base est figé à la création.
           *
           * L'écran affichait donc « en attente » pour des liens morts depuis des
           * semaines. Le gestionnaire croyait que ces quatre collègues allaient finir par
           * se connecter — personne ne relançait, et personne ne comprenait pourquoi ils
           * n'avaient toujours pas accès.
           *
           * Comparer la date ICI plutôt que d'ajouter une tâche de nettoyage : une tâche
           * qui ne tourne pas laisse le défaut intact, et l'application en a déjà fait
           * l'expérience le jour même (l'automatisation des trajets était à l'arrêt
           * depuis cinq jours sans que rien ne le signale).
           */
          status: inv.status === 'PENDING' && inv.expiresAt.getTime() < Date.now()
            ? 'EXPIRED'
            : inv.status,
          permissions: inv.permissions,
          accessScopes: inv.accessScopes,
          expiresAt: inv.expiresAt.toISOString(),
          createdAt: inv.createdAt.toISOString(),
        })),
      };
    }

    return users;
  }

  // ─── Vue panorama permissions/groupes/users ─────────────────────

  @Get('panorama')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('users_view')
  async panorama(@Req() req: AuthenticatedRequest) {
    const fleetFilter: Prisma.UserWhereInput = {};
    const groupFilter: Prisma.VehicleGroupWhereInput = {};
    // ⚠️ La condition portait `&& req.user.fleetId` : sans societe, le bloc etait SAUTE
    // et le panorama renvoyait les e-mails, noms, roles et permissions de TOUS les clients.
    // `requiredFleetScope` retourne alors une flotte impossible : l'ecran se vide au lieu
    // de tout montrer.
    const scopedFleet = requiredFleetScope(req.user);
    if (scopedFleet) {
      fleetFilter.fleetId = scopedFleet;
      groupFilter.fleetId = scopedFleet;
    }
    // Owner plateforme — exclu de la vue panorama pour un viewer non-owner.
    if (this.ownerVis.isMasked(req.user)) fleetFilter.isOwner = false;

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

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('users_view')
  async findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.assertTargetVisible(id, req);
    // #33 — filtre tenant integre au where : un user d'une AUTRE flotte renvoie le
    // MEME 404 qu'un user inexistant. Avant : 200/null si inexistant mais 403 si
    // autre flotte -> oracle d'enumeration cross-fleet (existence distinguable).
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({
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
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: AuthenticatedRequest) {
    await this.assertTargetVisible(id, req);
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

    // ══ ESPACE DÉPÔT (2026-08) — LE CHANGEMENT DE RÔLE EST INTERDIT DANS LES DEUX SENS
    //
    // « Un dépôt ne devient pas gestionnaire, et l'inverse non plus » (A5 § 5).
    //
    // Le sens qui compte : passer un dépôt en gestionnaire lui donnerait accès à TOUTE
    // la flotte d'un clic, depuis un écran qui ne le dit pas. Un fleet-admin qui veut
    // « donner un peu plus de droits » à un dépôt ouvrirait sa flotte entière sans s'en
    // apercevoir.
    //
    // L'autre sens compte aussi : un gestionnaire basculé en dépôt garderait ses lignes
    // `UserVehicleAccess`, ce qu'A1 § 7 interdit — et son périmètre deviendrait
    // incohérent, mi-flotte mi-mission.
    //
    // Pour changer de rôle, on supprime le compte et on en crée un autre. C'est plus
    // lourd, et c'est le but : l'acte doit être délibéré.
    if (roleChanged && (user.role === UserRole.DEPOT || dto.role === UserRole.DEPOT)) {
      throw new ForbiddenException(
        'Le rôle « Dépôt » ne peut être ni attribué ni retiré à un compte existant. '
          + 'Son périmètre est calculé depuis ses missions : le convertir ouvrirait ou fermerait '
          + 'un accès sans que l\'écran le dise. Supprimez le compte et créez-en un autre.',
      );
    }

    // Only SUPER_ADMIN can reassign fleet
    const fleetIdUpdate = dto.fleetId !== undefined && req.user.role === UserRole.SUPER_ADMIN
      ? { fleetId: dto.fleetId }
      : {};

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        // Sécurité — au changement de rôle, on réinitialise sur les défauts du NOUVEAU
        // rôle, mais BORNÉS à l'autorité de l'éditeur (clampPermissions) : impossible de
        // promouvoir quelqu'un vers un rôle dont les défauts dépasseraient les capacités
        // de l'éditeur. No-op aujourd'hui (route admin-only) mais robuste à un futur
        // élargissement de @Roles — pas de bug silencieux d'escalade de privilèges.
        ...(roleChanged
          ? {
              permissions: clampPermissions(
                getDefaultPermissions(dto.role!),
                req.user,
                getDefaultPermissions(dto.role!),
              ) as unknown as Prisma.JsonObject,
            }
          : {}),
        ...(dto.permissions !== undefined && !roleChanged
          ? { permissions: clampPermissions(dto.permissions, req.user, getDefaultPermissions(user.role)) as unknown as Prisma.JsonObject }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...fleetIdUpdate,
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, permissions: true, fleetId: true, isActive: true, createdAt: true },
    });

    // ══ REACTIVATION / SUSPENSION — Vizyo Auth doit suivre ════════════════════════
    //
    // Le bouton « Desarchiver » de l'ecran Utilisateurs passe par ICI (`isActive: true`)
    // et n'appelait RIEN cote Vizyo Auth : `activateUser` existait dans le client mais
    // n'etait invoque nulle part dans le depot. Tant que `suspendUser` echouait en 403,
    // l'asymetrie ne se voyait pas — archiver ne suspendait rien, donc desarchiver
    // n'avait rien a defaire. Reparer l'appel (PR #51) a rendu l'archivage EFFECTIF, et
    // donc cette absence BLOQUANTE : le compte serait reste verrouille au login tout en
    // s'affichant actif.
    if (dto.isActive !== undefined) {
      await this.accountSync.applyStatus(user.authUserId, dto.isActive, `update:${user.email}`);
    }

    return updated;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async archive(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.assertTargetVisible(id, req);
    // Filtre tenant integre au where : 404 si user d'une autre flotte.
    const where: Prisma.UserWhereInput = { id };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('Utilisateur introuvable');
      where.fleetId = req.user.fleetId;
    }
    const user = await this.prisma.user.findFirst({
      where,
      // `email` sert au CONTEXTE journalise de la synchro : un identifiant tronque ne
      // permet pas de retrouver qui, dans le centre d'alerte.
      select: { id: true, authUserId: true, fleetId: true, role: true, email: true },
    });

    if (!user) throw new NotFoundException('Utilisateur introuvable');

    // FLEET_ADMIN ne peut pas etre archive (compte principal de la flotte)
    if (user.role === UserRole.FLEET_ADMIN) {
      throw new ForbiddenException('Impossible d\'archiver l\'administrateur de la flotte');
    }

    // Impossible de s'archiver soi-meme
    if (user.id === req.user.id) {
      throw new ForbiddenException('Impossible de s\'archiver soi-même');
    }

    // 1. Suspendre dans Vizyo Auth (plus de login possible)
    //
    // ⚠️ Ce bloc etait un `catch {}` VIDE. C'est ce silence qui a masque pendant des mois
    // un 403 systematique : l'interface annoncait « archive » alors que la personne
    // pouvait toujours se connecter. Le repli reste NON BLOQUANT (une panne Vizyo Auth ne
    // doit pas empecher d'archiver) mais il n'est plus MUET — l'echec part au centre
    // d'alerte, et l'ecart reste visible dans /admin/auth-sync.
    await this.accountSync.applyStatus(user.authUserId, false, `archive:${user.email}`);

    // 2. Detacher les acces vehicules
    await this.prisma.userVehicleAccess.deleteMany({ where: { userId: id } });

    // 3. Marquer comme inactif
    await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    // 4. Espace dépôt (2026-08), lot A4 — FERMER LES LIENS PUBLICS QU'IL A OUVERTS.
    //
    // Retirer l'accès au compte ne suffit pas : ce compte a distribué des URL qui,
    // elles, fonctionnent sans lui. Un dépôt archivé dont les liens restent actifs
    // continue de faire suivre les camions du transporteur par des tiers qu'il a
    // choisis — c'est exactement l'accès qu'on vient de retirer, par une autre porte.
    const fermes = await this.missionShare.fermerLiensDuCompte(id);
    if (fermes > 0) {
      this.logger.log(`${fermes} lien(s) de partage ferme(s) — compte ${user.email} archive`);
    }

    return { ok: true };
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async resetPassword(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.assertTargetVisible(id, req);
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

        await this.emailService.send({
          to: user.email,
          ...emailContent,
          template: 'password_reset',
          // Attribution journal Système : reset déclenché PAR un admin (≠ self-service).
          context: { requestedByUserId: req.user.id, fleetId: user.fleetId ?? undefined },
        });
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
    await this.assertTargetVisible(id, req);
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
  @RequirePermissions('users_manage')
  async setAccess(@Param('id') id: string, @Body() dto: SetUserAccessDto, @Req() req: AuthenticatedRequest) {
    await this.assertTargetVisible(id, req);
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

    // ══ ESPACE DÉPÔT (2026-08) — UN DEPOT N'A JAMAIS DE PÉRIMÈTRE VÉHICULE ═════
    //
    // Second verrou, après celui de l'acceptation d'invitation. Une ligne créée ici
    // par erreur (script, import, écran mal gardé) donnerait au dépôt un périmètre
    // résolu par `PermissionsResolverService`, en contournant entièrement
    // `DepotScopeService` — l'isolation du bloc A tomberait sans bruit.
    //
    // A5 § 4 : « Le périmètre d'un dépôt est fixé par ses missions. »
    if (user.role === UserRole.DEPOT) {
      throw new BadRequestException(
        'Un compte dépôt n\'a pas de périmètre véhicule : il voit les missions que vous lui '
          + 'assignez, pendant leur créneau, et rien d\'autre. Assignez-lui une mission depuis '
          + 'l\'agenda pour lui ouvrir un accès.',
      );
    }

    if (entries.length === 0) {
      throw new BadRequestException(
        'Au moins une entrée d\'accès requise (ALL, GROUP, ou VEHICLE)',
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
          permissions: (e.permissions
            ? clampPartialPermissions(e.permissions, req.user)
            : null) as unknown as Prisma.InputJsonValue,
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
  @RequirePermissions('users_manage')
  async updateAccessPermissions(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('accessId', ParseUUIDPipe) accessId: string,
    @Body() dto: UpdateAccessEntryPermissionsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.assertTargetVisible(userId, req);
    // 1. Vérifier que l'user cible est dans la fleet du caller (defense en profondeur)
    const userWhere: Prisma.UserWhereInput = { id: userId };
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!req.user.fleetId) throw new NotFoundException('User not found');
      userWhere.fleetId = req.user.fleetId;
    }
    const targetUser = await this.prisma.user.findFirst({ where: userWhere });
    if (!targetUser) throw new NotFoundException('User not found');

    // 2. Vérifier que la ligne d'acces appartient bien a ce user
    const entry = await this.prisma.userVehicleAccess.findFirst({
      where: { id: accessId, userId },
    });
    if (!entry) throw new NotFoundException('Access entry not found');

    // 3. Update permissions JSON
    const updated = await this.prisma.userVehicleAccess.update({
      where: { id: accessId },
      data: { permissions: clampPartialPermissions(dto.permissions, req.user) as unknown as Prisma.InputJsonValue },
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
  @RequirePermissions('users_manage')
  async deleteAccessEntry(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('accessId', ParseUUIDPipe) accessId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.assertTargetVisible(userId, req);
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
        'Impossible de supprimer la dernière entrée d\'accès. Utilisez d\'abord PUT /users/:id/access pour reconfigurer.',
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
        throw new BadRequestException('groupId requis pour une entrée type GROUP');
      }
      if (entry.type === 'VEHICLE' && !entry.vehicleId) {
        throw new BadRequestException('vehicleId requis pour une entrée type VEHICLE');
      }
    }

    const groupIds = entries.filter((e) => e.type === 'GROUP' && e.groupId).map((e) => e.groupId!);
    const vehicleIds = entries.filter((e) => e.type === 'VEHICLE' && e.vehicleId).map((e) => e.vehicleId!);

    if (groupIds.length > 0) {
      // ⚠️ `?? undefined` RENDAIT LA GARDE INERTE quand la societe est nulle : la clause
      // disparaissait du `where` et TOUS les groupes/vehicules de TOUTES les societes
      // passaient le controle. La garde cessait de garder exactement dans le cas ou elle
      // compte — un compte orphelin (societe supprimee, `Fleet.onDelete: SetNull`).
      // `NO_FLEET` est une societe IMPOSSIBLE : plus rien ne matche, l'operation echoue
      // franchement au lieu d'autoriser en silence.
      const found = await this.prisma.vehicleGroup.findMany({
        where: { id: { in: groupIds }, fleetId: targetUserFleetId ?? NO_FLEET },
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
        where: { id: { in: vehicleIds }, fleetId: targetUserFleetId ?? NO_FLEET },
        select: { id: true },
      });
      if (found.length !== vehicleIds.length) {
        throw new BadRequestException(
          'Un ou plusieurs véhicules n\'appartiennent pas a la flotte de cet utilisateur',
        );
      }
    }
  }

  // ─── SUPER_ADMIN : Sync Auth/Tracky ─────────────────────────────

  @Get('admin/auth-sync')
  @Roles(UserRole.SUPER_ADMIN)
  async authSync(@Req() req: AuthenticatedRequest) {
    // Query Vizyo Auth DB directly (same Docker network)
    const { Pool } = require('pg') as typeof import('pg');
    const authDbUrl = this.config.get('VIZYO_AUTH_DB_URL', { infer: true }) as string | undefined;
    let authUsers: Array<{ id: string; email: string; status: string; createdAt: string }> = [];
    // ⚠️ Distinguer « aucun compte » de « je n'ai pas pu lire ». Sans ce drapeau, une
    // liaison morte s'affiche comme un parc vide — et on conclut que tout va bien.
    let authUsersUnavailable = false;

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
        authUsersUnavailable = true;
        this.logger.warn(`Auth DB query failed: ${(err as Error).message}`);
      } finally {
        await pool.end();
      }
    }

    // Owner plateforme — masqué aux autres super-admins des DEUX côtés : on retire
    // les comptes owner du côté Auth (par email) ET du côté Tracky (isOwner), sinon
    // l'owner ressortirait en « onlyAuth » (présent en Auth, absent en Tracky).
    const ownerEmailsLower = this.ownerVis.isMasked(req.user)
      ? await this.ownerVis.getOwnerEmailsLower()
      : [];
    if (ownerEmailsLower.length) {
      authUsers = authUsers.filter((u) => !ownerEmailsLower.includes(u.email.toLowerCase()));
    }

    const trackyUsers = await this.prisma.user.findMany({
      where: this.ownerVis.isMasked(req.user) ? { isOwner: false } : {},
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
        // ══ LE DESACCORD, nomme ═══════════════════════════════════════════════════
        //
        // L'ecran affichait `authStatus` et `isActive` cote a cote sans jamais DIRE
        // qu'ils se contredisent. Or c'est exactement ce qu'on vient de vivre : un
        // compte « archive » dans Tracky restait `active` dans Vizyo Auth, donc capable
        // de se connecter, pendant des mois. Deux colonnes a lire soi-meme ne sont pas
        // un controle — c'est un test de vigilance qu'on finit toujours par rater.
        //
        // On compare donc ici, une fois, et on nomme les deux desaccords possibles :
        //   - `auth_ouvert`  : bloque dans Tracky, mais peut TOUJOURS se connecter. Le
        //                      plus grave — c'est une porte restee ouverte.
        //   - `auth_bloque`  : actif dans Tracky, mais rejete au login. Genant sans
        //                      etre dangereux : la personne appelle le support.
        const authActive = (au.status ?? 'active').toLowerCase() === 'active';
        const mismatch = tu.isActive === authActive
          ? null
          : tu.isActive ? 'auth_bloque' : 'auth_ouvert';
        synced.push({
          authId: au.id,
          email: au.email,
          authStatus: au.status,
          trackyId: tu.id,
          role: tu.role,
          fleetId: tu.fleetId,
          isActive: tu.isActive,
          authActive,
          mismatch,
          // `authUserId` absent = jamais rapproche par identifiant, seulement par e-mail.
          // Le rapprochement tient tant que l'e-mail ne change pas — fragile, donc dit.
          linkedById: tu.authUserId === au.id,
          createdAt: au.createdAt,
        });
      } else {
        onlyAuth.push({ authId: au.id, email: au.email, status: au.status, createdAt: au.createdAt });
      }
    }

    for (const tu of trackyUsers) {
      if (!authByEmail.has(tu.email.toLowerCase())) {
        onlyTracky.push({ trackyId: tu.id, email: tu.email, role: tu.role, fleetId: tu.fleetId, isActive: tu.isActive });
      }
    }

    const mismatched = synced.filter((u) => u.mismatch !== null);
    return {
      synced,
      onlyAuth,
      onlyTracky,
      totalAuth: authUsers.length,
      totalTracky: trackyUsers.length,
      // Compteurs prets a afficher : l'ecran ne doit pas avoir a les recalculer, sinon
      // sa definition du « desaccord » finira par diverger de celle du serveur.
      mismatchCount: mismatched.length,
      authOuvertCount: mismatched.filter((u) => u.mismatch === 'auth_ouvert').length,
      authBloqueCount: mismatched.filter((u) => u.mismatch === 'auth_bloque').length,
      // Vrai quand la base Vizyo Auth n'a pas pu etre lue : sans ce drapeau, l'ecran
      // afficherait « 0 compte Auth » — indiscernable de « la liaison est morte ».
      authUnavailable: !authDbUrl || authUsersUnavailable,
    };
  }

  /**
   * REALIGNE Vizyo Auth sur l'etat Tracky pour un compte.
   *
   * Tracky est la source de verite du statut : ce bouton pousse `isActive` vers Vizyo
   * Auth, il ne fait jamais l'inverse. Rapatrier le statut d'Auth vers Tracky pourrait
   * REOUVRIR un compte qu'un administrateur a volontairement archive.
   */
  @Post('admin/auth-sync/:trackyUserId/realign')
  @Roles(UserRole.SUPER_ADMIN)
  async realignAuth(@Param('trackyUserId') trackyUserId: string, @Req() req: AuthenticatedRequest) {
    await this.assertTargetVisible(trackyUserId, req);
    const user = await this.prisma.user.findUnique({
      where: { id: trackyUserId },
      select: { authUserId: true, email: true, isActive: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.authUserId) throw new BadRequestException('Ce compte n\'a pas d\'identifiant Vizyo Auth');

    const ok = await this.accountSync.applyStatus(user.authUserId, user.isActive, `realign:${user.email}`);
    if (!ok) {
      throw new BadRequestException(
        'Vizyo Auth a refusé la mise à jour. Le détail est dans le centre d\'alerte.',
      );
    }
    return { ok: true, applied: user.isActive ? 'active' : 'suspended' };
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
