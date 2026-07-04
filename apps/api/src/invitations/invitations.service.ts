import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessType, Prisma, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { AuthClientService } from '../auth-client/auth-client.service';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { clampPartialPermissions, clampPermissions, getDefaultPermissions } from '../users/default-permissions';

/**
 * V1.5 (Sprint J) — Workflow d'invitation utilisateur.
 *
 * Flow :
 *   1. Un FLEET_ADMIN ou SUPER_ADMIN appelle `create()` avec email + role + fleetId.
 *   2. On genere un token aleatoire (32 bytes hex), on persiste son hash dans
 *      la table `invitations` avec une expiration de 24h.
 *   3. On signe un JWT contenant l'invitation id + le token, qui sera mis dans
 *      le lien de l'email. Ainsi, meme si la DB est dump, le hash ne sert a rien
 *      sans le secret JWT.
 *   4. L'email Resend est envoye via EmailService (no-op si pas de cle).
 *   5. L'utilisateur clique → frontend POST /api/auth/accept-invitation avec le
 *      JWT + son password choisi → on appelle `accept()`.
 *   6. `accept()` decode le JWT, retrouve l'invitation, verifie le token, register
 *      le user dans Vizyo Auth, cree le User Tracky local lie au fleetId/role.
 *   7. Marque l'invitation ACCEPTED + retourne les credentials de session.
 */

const TOKEN_BYTES = 32;
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Un scope d'accès porté par l'invitation (miroir de UserVehicleAccess). */
export interface InvitationAccessScope {
  type: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId?: string | null;
  vehicleId?: string | null;
  permissions?: Record<string, boolean> | null;
}

interface CreateInvitationParams {
  email: string;
  role: UserRole;
  fleetId: string | null;
  requestedByUserId: string;
  permissions?: Record<string, boolean> | null;
  accessScopes?: InvitationAccessScope[] | null;
}

export interface AcceptInvitationResult {
  authUserId: string;
  email: string;
  fleetId: string | null;
  role: UserRole;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly authClient: AuthClientService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get jwtSecret(): string {
    return (
      this.config.get('INVITATION_JWT_SECRET', { infer: true }) ||
      this.config.get('VIZYO_AUTH_JWT_ACCESS_SECRET', { infer: true })
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create + send an invitation. Returns the persisted row (without the secret token).
   */
  async create(params: CreateInvitationParams) {
    const email = params.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Email invalide');
    }

    // Reject if a user with this email already exists in Tracky.
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (!existingUser.isActive) {
        throw new ConflictException(
          'Cet utilisateur est archivé. Désarchivez-le depuis la liste des utilisateurs au lieu de le ré-inviter.',
        );
      }
      throw new ConflictException('Un utilisateur avec cet email existe déjà et est actif.');
    }

    // Auto-revoke any existing PENDING invitation for this email (allows resend).
    await this.prisma.invitation.updateMany({
      where: { email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });

    // RBAC: FLEET_ADMIN ne peut inviter que dans sa propre flotte.
    const inviter = await this.prisma.user.findUnique({
      where: { id: params.requestedByUserId },
    });
    if (!inviter) throw new UnauthorizedException('Inviteur introuvable');
    // V1.16 (audit A1) — garde d'autorite partagee avec update() (cf. assertInviterCanGrant).
    this.assertInviterCanGrant(inviter, params.role, params.fleetId);

    const fleet = params.fleetId
      ? await this.prisma.fleet.findUnique({ where: { id: params.fleetId } })
      : null;
    if (params.fleetId && !fleet) throw new NotFoundException('Flotte introuvable');

    const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

    // Securite (audit critique) — clamp des permissions a l'intersection avec
    // celles de l'inviteur : un inviteur ne peut JAMAIS accorder une capacite
    // qu'il n'a pas (anti-escalade via compte-pantin). SUPER_ADMIN/FLEET_ADMIN
    // = bypass (toutes permissions). Cf. clampPermissions (lot 5, desormais fait).
    let invPermissions: Record<string, boolean> = clampPermissions(
      params.permissions,
      inviter,
      getDefaultPermissions(params.role),
    ) as unknown as Record<string, boolean>;

    // Matrice d'acces des l'invitation : si des scopes sont fournis, on les valide
    // (flotte) + clampe (anti-escalade), on les persiste, et on derive `permissions`
    // (= scope ALL) pour la compat / User.permissions a l'acceptation.
    let storedScopes: InvitationAccessScope[] | null = null;
    if (params.accessScopes && params.accessScopes.length > 0) {
      const resolved = await this.resolveScopes(params.accessScopes, inviter, params.role, params.fleetId);
      storedScopes = resolved.stored;
      invPermissions = resolved.permissions;
    }

    const invitation = await this.prisma.invitation.create({
      data: {
        email,
        role: params.role,
        fleetId: params.fleetId,
        permissions: invPermissions as unknown as Prisma.JsonObject,
        ...(storedScopes ? { accessScopes: storedScopes as unknown as Prisma.InputJsonValue } : {}),
        tokenHash,
        expiresAt,
        createdById: params.requestedByUserId,
      },
    });

    // Sign a JWT carrying the invitation id + token. The hash is in DB so even
    // if the JWT is leaked, an attacker still needs the matching token.
    const inviteJwt = jwt.sign(
      { invitationId: invitation.id, token: rawToken },
      this.jwtSecret,
      { expiresIn: TOKEN_TTL_SECONDS, issuer: 'vizyo-tracky' },
    );

    const baseUrl = this.config.get('APP_BASE_URL', { infer: true });
    const acceptUrl = `${baseUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(inviteJwt)}`;
    const inviterName = [inviter.firstName, inviter.lastName].filter(Boolean).join(' ') || inviter.email;

    const tpl = this.email.buildInvitationEmail({
      recipientName: null,
      inviterName,
      fleetName: fleet?.name ?? 'Vizyo Tracky',
      role: this.formatRole(params.role),
      acceptUrl,
      expiresAt,
    });

    const sent = await this.email.send({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      context: {
        invitationId: invitation.id,
        // Attribution journal Système : l'invitation est un acte manuel de l'inviteur.
        requestedByUserId: params.requestedByUserId,
        fleetId: params.fleetId ?? undefined,
      },
    });

    if (!sent.ok) {
      this.logger.warn(
        `Invitation ${invitation.id} cree mais email echoue : ${sent.error ?? 'no error message'}`,
      );
    }

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      fleetId: invitation.fleetId,
      permissions: invitation.permissions,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
      acceptUrlForDevDebug: this.email.isEnabled() ? null : acceptUrl,
    };
  }

  /**
   * Accept an invitation : verify JWT + token hash, register user in Vizyo Auth,
   * create the local Tracky User, mark invitation ACCEPTED.
   *
   * Returns the freshly-issued access + refresh tokens so the frontend can
   * auto-login the new user.
   */
  async accept(jwtToken: string, password: string, displayName: string): Promise<AcceptInvitationResult> {
    if (!password || password.length < 12) {
      throw new BadRequestException('Le mot de passe doit faire au moins 12 caracteres');
    }
    if (!displayName || displayName.trim().length < 2) {
      throw new BadRequestException('Nom complet requis (2 caracteres minimum)');
    }

    let payload: { invitationId: string; token: string };
    try {
      payload = jwt.verify(jwtToken, this.jwtSecret, {
        issuer: 'vizyo-tracky',
      }) as { invitationId: string; token: string };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new BadRequestException(
          'Ce lien d\'invitation a expire. Veuillez demander a votre administrateur de renvoyer une invitation.',
        );
      }
      throw new BadRequestException('Lien d\'invitation invalide. Verifiez que vous avez copie le lien complet.');
    }

    const invitation = await this.prisma.invitation.findUnique({
      where: { id: payload.invitationId },
    });
    if (!invitation) throw new NotFoundException('Invitation introuvable');
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation deja ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('Invitation expiree');
    }
    if (invitation.tokenHash !== this.hashToken(payload.token)) {
      throw new BadRequestException('Token invalide');
    }

    // Defensive: if a user with this email got created between create() and accept(),
    // refuse to overwrite.
    const existingUser = await this.prisma.user.findUnique({
      where: { email: invitation.email },
    });
    if (existingUser) {
      throw new ConflictException(
        'Votre compte est deja active. Connectez-vous avec vos identifiants.',
      );
    }

    // 1) Register in Vizyo Auth (external).
    // Si 409 (deja enregistre), on continue — l'user existe dans Auth mais pas dans Tracky
    // (cas de retry apres echec partiel ou renvoi d'invitation).
    try {
      await this.authClient.register(invitation.email, password, displayName);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('409') || msg.includes('already registered')) {
        this.logger.warn({ email: invitation.email }, 'User already in Vizyo Auth — continuing accept flow');
      } else if (msg.includes('400') || msg.includes('Password must be')) {
        throw new BadRequestException('Le mot de passe doit faire au moins 12 caracteres.');
      } else {
        throw err;
      }
    }

    // 2) Login to get tokens + authUserId.
    let session: { accessToken: string; refreshToken: string };
    try {
      session = await this.authClient.login(invitation.email, password);
    } catch (loginErr: any) {
      // UnauthorizedException du authClient ou toute erreur auth
      if (
        loginErr?.status === 401 ||
        loginErr?.response?.statusCode === 401 ||
        (loginErr?.message ?? '').includes('Authentication failed')
      ) {
        throw new UnauthorizedException(
          'Ce compte existe déjà avec un autre mot de passe. Connectez-vous avec votre mot de passe habituel ou réinitialisez-le.',
        );
      }
      throw loginErr;
    }
    const me = await this.authClient.me(session.accessToken);

    // 3) Parse displayName into firstName / lastName (best-effort).
    const parts = displayName.trim().split(/\s+/);
    const firstName = parts[0] ?? null;
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;

    // 4) Create local Tracky User with the invited role + fleet + pre-configured permissions.
    const userPermissions = (invitation.permissions ?? getDefaultPermissions(invitation.role)) as unknown as Prisma.JsonObject;
    const createdUser = await this.prisma.user.create({
      data: {
        authUserId: me.id,
        email: invitation.email,
        firstName,
        lastName,
        role: invitation.role,
        fleetId: invitation.fleetId,
        permissions: userPermissions,
      },
    });

    // 4b) Matérialiser la matrice d'accès en lignes UserVehicleAccess. On utilise les
    // scopes de l'invitation s'ils existent, sinon on seede un unique scope ALL depuis
    // `permissions` (même pour les invitations legacy) — ainsi la matrice « Accès &
    // Permissions » n'est JAMAIS vide après acceptation (fin du « on doit remettre les
    // rôles »). Les valeurs ont déjà été clampées à la création/màj de l'invitation.
    const scopes: InvitationAccessScope[] =
      (invitation.accessScopes as unknown as InvitationAccessScope[] | null)?.length
        ? (invitation.accessScopes as unknown as InvitationAccessScope[])
        : [{ type: 'ALL', permissions: invitation.permissions as Record<string, boolean> | null }];
    await this.prisma.userVehicleAccess.createMany({
      data: scopes.map((s) => ({
        userId: createdUser.id,
        accessType: s.type as AccessType,
        groupId: s.type === 'GROUP' ? s.groupId ?? null : null,
        vehicleId: s.type === 'VEHICLE' ? s.vehicleId ?? null : null,
        permissions: (s.permissions ?? null) as unknown as Prisma.InputJsonValue,
      })),
    });

    // 5) Mark invitation accepted.
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });

    return {
      authUserId: me.id,
      email: invitation.email,
      fleetId: invitation.fleetId,
      role: invitation.role,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  async list(requestedBy: { id: string; role: UserRole; fleetId: string | null }) {
    const where = requestedBy.role === UserRole.SUPER_ADMIN
      ? {}
      : { fleetId: requestedBy.fleetId };
    return this.prisma.invitation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Resend an invitation: find original, re-invoke create() with same params.
   * create() auto-revokes old PENDING invitations, so no duplicates.
   */
  async resend(invitationId: string, requestedBy: { id: string; role: UserRole; fleetId: string | null }) {
    const where: Prisma.InvitationWhereInput = { id: invitationId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Invitation introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const original = await this.prisma.invitation.findFirst({ where });
    if (!original) throw new NotFoundException('Invitation introuvable');
    if (original.status === 'ACCEPTED') {
      throw new BadRequestException('Cette invitation a deja ete acceptee');
    }
    return this.create({
      email: original.email,
      role: original.role,
      fleetId: original.fleetId,
      requestedByUserId: requestedBy.id,
      permissions: original.permissions as Record<string, boolean> | null,
      accessScopes: original.accessScopes as unknown as InvitationAccessScope[] | null,
    });
  }

  /**
   * Update a PENDING invitation (fleetId, role, permissions).
   */
  async update(
    invitationId: string,
    data: { fleetId?: string | null; role?: UserRole; permissions?: Record<string, boolean> | null; accessScopes?: InvitationAccessScope[] | null },
    requestedBy: { id: string; role: UserRole; fleetId: string | null },
  ) {
    const where: Prisma.InvitationWhereInput = { id: invitationId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Invitation introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const inv = await this.prisma.invitation.findFirst({ where });
    if (!inv) throw new NotFoundException('Invitation introuvable');
    if (inv.status !== 'PENDING') {
      throw new BadRequestException(`Impossible de modifier une invitation ${inv.status.toLowerCase()}`);
    }

    // Validate fleet if changing
    if (data.fleetId !== undefined && data.fleetId !== null) {
      const fleet = await this.prisma.fleet.findUnique({ where: { id: data.fleetId } });
      if (!fleet) throw new NotFoundException('Flotte introuvable');
    }

    // V1.16 (audit A1) — Garde d'escalade : un inviteur ne peut pas promouvoir
    // l'invitation vers un role/flotte au-dela de son autorite (ex FLEET_ADMIN
    // -> SUPER_ADMIN, ou reassignation hors de sa flotte). On evalue le role et la
    // flotte *resultants* du patch, et on se base sur la ligne user en base
    // (source de verite) plutot que sur le JWT. Couvre aussi l'ancien controle de
    // reassignation de flotte (desormais inclus dans assertInviterCanGrant).
    const inviter = await this.prisma.user.findUnique({ where: { id: requestedBy.id } });
    if (!inviter) throw new UnauthorizedException('Inviteur introuvable');
    const targetRole = data.role ?? inv.role;
    const targetFleetId = data.fleetId !== undefined ? data.fleetId : inv.fleetId;
    this.assertInviterCanGrant(inviter, targetRole, targetFleetId);

    const updateData: Prisma.InvitationUpdateInput = {};
    if (data.fleetId !== undefined) updateData.fleetId = data.fleetId;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.permissions !== undefined) {
      // Clamp anti-escalade (idem create) : borne aux permissions de l'inviteur.
      // `null` (= reset vers les defauts du role a l'accept) est preserve tel quel.
      updateData.permissions = (data.permissions
        ? clampPermissions(data.permissions, inviter, getDefaultPermissions(targetRole))
        : data.permissions) as unknown as Prisma.JsonObject;
    }

    // Matrice d'acces : si des scopes sont fournis, on les revalide/clampe contre la
    // flotte RESULTANTE (targetFleetId) et on re-derive `permissions` (scope ALL).
    if (data.accessScopes !== undefined) {
      if (data.accessScopes && data.accessScopes.length > 0) {
        const resolved = await this.resolveScopes(data.accessScopes, inviter, targetRole, targetFleetId);
        updateData.accessScopes = resolved.stored as unknown as Prisma.InputJsonValue;
        updateData.permissions = resolved.permissions as unknown as Prisma.JsonObject;
      } else {
        // Liste vide/null → on efface les scopes (retour au comportement legacy ALL).
        updateData.accessScopes = Prisma.JsonNull;
      }
    }

    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: updateData,
    });
  }

  async revoke(invitationId: string, requestedBy: { id: string; role: UserRole; fleetId: string | null }) {
    // Filtre tenant integre au where (404 plutot que 403 cross-fleet).
    const where: Prisma.InvitationWhereInput = { id: invitationId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Invitation introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const inv = await this.prisma.invitation.findFirst({ where });
    if (!inv) throw new NotFoundException('Invitation introuvable');
    if (inv.status !== 'PENDING') return inv;
    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });
  }

  /**
   * Valide + clampe une liste de scopes d'accès fournie à l'invitation :
   *  - structure : GROUP requiert groupId, VEHICLE requiert vehicleId ;
   *  - flotte (anti-IDOR) : chaque groupe/véhicule doit appartenir à `fleetId` ;
   *  - anti-escalade : chaque scope est clampé aux permissions de l'inviteur.
   * Retourne les scopes normalisés à persister + les `permissions` dérivées du scope
   * ALL (jeu COMPLET clampé, pour la compat `permissions` / User.permissions à l'accept).
   */
  private async resolveScopes(
    scopes: InvitationAccessScope[],
    inviter: { role: UserRole; permissions: Prisma.JsonValue | null },
    role: UserRole,
    fleetId: string | null,
  ): Promise<{ stored: InvitationAccessScope[]; permissions: Record<string, boolean> }> {
    const granter = { role: inviter.role, permissions: inviter.permissions };

    const groupIds: string[] = [];
    const vehicleIds: string[] = [];
    for (const s of scopes) {
      if (s.type === 'GROUP') {
        if (!s.groupId) throw new BadRequestException('groupId requis pour un scope GROUP');
        groupIds.push(s.groupId);
      } else if (s.type === 'VEHICLE') {
        if (!s.vehicleId) throw new BadRequestException('vehicleId requis pour un scope VEHICLE');
        vehicleIds.push(s.vehicleId);
      }
    }
    if (groupIds.length > 0) {
      const found = await this.prisma.vehicleGroup.findMany({
        where: { id: { in: groupIds }, fleetId: fleetId ?? undefined },
        select: { id: true },
      });
      if (found.length !== new Set(groupIds).size) {
        throw new BadRequestException("Un ou plusieurs groupes n'appartiennent pas à la flotte de l'invité");
      }
    }
    if (vehicleIds.length > 0) {
      const found = await this.prisma.vehicle.findMany({
        where: { id: { in: vehicleIds }, fleetId: fleetId ?? undefined },
        select: { id: true },
      });
      if (found.length !== new Set(vehicleIds).size) {
        throw new BadRequestException("Un ou plusieurs véhicules n'appartiennent pas à la flotte de l'invité");
      }
    }

    const stored: InvitationAccessScope[] = scopes.map((s) => ({
      type: s.type,
      groupId: s.type === 'GROUP' ? s.groupId ?? null : null,
      vehicleId: s.type === 'VEHICLE' ? s.vehicleId ?? null : null,
      permissions: s.permissions
        ? (clampPartialPermissions(s.permissions, granter) as unknown as Record<string, boolean>)
        : null,
    }));

    const allScope = stored.find((s) => s.type === 'ALL');
    const permissions = clampPermissions(
      allScope?.permissions ?? undefined,
      granter,
      getDefaultPermissions(role),
    ) as unknown as Record<string, boolean>;

    return { stored, permissions };
  }

  /**
   * V1.16 (audit A1) — Garde d'autorite partagee par `create()` et `update()`.
   * Verifie qu'un inviteur a le droit d'attribuer `targetRole` dans `targetFleetId`.
   * Empeche l'escalade de privileges (un FLEET_ADMIN ne peut pas creer/promouvoir
   * une invitation en SUPER_ADMIN) et la sortie de flotte. SUPER_ADMIN : tout permis.
   * Le clamp fin des permissions (intersection) est traite separement (lot 5).
   */
  private assertInviterCanGrant(
    inviter: { role: UserRole; fleetId: string | null; permissions: Prisma.JsonValue | null },
    targetRole: UserRole,
    targetFleetId: string | null,
  ): void {
    if (inviter.role === UserRole.SUPER_ADMIN) return;

    if (inviter.role === UserRole.FLEET_MANAGER) {
      const inviterPerms = inviter.permissions as Record<string, boolean> | null;
      if (!inviterPerms?.users_manage) {
        throw new ForbiddenException('Permission insuffisante pour inviter');
      }
      if (targetFleetId !== inviter.fleetId) {
        throw new ForbiddenException('Vous ne pouvez inviter que dans votre flotte');
      }
      if (targetRole !== UserRole.VIEWER) {
        throw new ForbiddenException('Un Manager ne peut inviter que des Lecteurs');
      }
      return;
    }

    if (inviter.role === UserRole.FLEET_ADMIN) {
      if (targetFleetId !== inviter.fleetId) {
        throw new ForbiddenException('Vous ne pouvez inviter que dans votre flotte');
      }
      if (targetRole === UserRole.SUPER_ADMIN) {
        throw new ForbiddenException('Un FLEET_ADMIN ne peut pas creer un SUPER_ADMIN');
      }
      return;
    }

    throw new ForbiddenException('Vous n\'avez pas le droit d\'inviter');
  }

  private formatRole(role: UserRole): string {
    switch (role) {
      case UserRole.SUPER_ADMIN: return 'Super administrateur';
      case UserRole.FLEET_ADMIN: return 'Administrateur de flotte';
      case UserRole.FLEET_MANAGER: return 'Gestionnaire de flotte';
      case UserRole.VIEWER: return 'Lecteur';
      default: return role;
    }
  }
}
