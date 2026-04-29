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
import { UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { AuthClientService } from '../auth-client/auth-client.service';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

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

interface CreateInvitationParams {
  email: string;
  role: UserRole;
  fleetId: string | null;
  requestedByUserId: string;
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
      throw new ConflictException('Un utilisateur avec cet email existe deja');
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
    if (inviter.role !== UserRole.SUPER_ADMIN) {
      if (inviter.role !== UserRole.FLEET_ADMIN) {
        throw new ForbiddenException('Seuls SUPER_ADMIN et FLEET_ADMIN peuvent inviter');
      }
      if (params.fleetId !== inviter.fleetId) {
        throw new ForbiddenException('Vous ne pouvez inviter que dans votre flotte');
      }
      if (params.role === UserRole.SUPER_ADMIN) {
        throw new ForbiddenException('Un FLEET_ADMIN ne peut pas creer un SUPER_ADMIN');
      }
    }

    const fleet = params.fleetId
      ? await this.prisma.fleet.findUnique({ where: { id: params.fleetId } })
      : null;
    if (params.fleetId && !fleet) throw new NotFoundException('Flotte introuvable');

    const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

    const invitation = await this.prisma.invitation.create({
      data: {
        email,
        role: params.role,
        fleetId: params.fleetId,
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
      context: { invitationId: invitation.id },
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
    if (!password || password.length < 8) {
      throw new BadRequestException('Le mot de passe doit faire au moins 8 caracteres');
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
      const reason = err instanceof Error ? err.message : 'invalide';
      throw new BadRequestException(`Lien d'invitation invalide ou expire (${reason})`);
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
        'Un utilisateur avec cet email existe deja. Connectez-vous au lieu d\'utiliser ce lien.',
      );
    }

    // 1) Register in Vizyo Auth (external).
    await this.authClient.register(invitation.email, password, displayName);

    // 2) Login to get tokens + authUserId.
    const session = await this.authClient.login(invitation.email, password);
    const me = await this.authClient.me(session.accessToken);

    // 3) Parse displayName into firstName / lastName (best-effort).
    const parts = displayName.trim().split(/\s+/);
    const firstName = parts[0] ?? null;
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;

    // 4) Create local Tracky User with the invited role + fleet.
    await this.prisma.user.create({
      data: {
        authUserId: me.id,
        email: invitation.email,
        firstName,
        lastName,
        role: invitation.role,
        fleetId: invitation.fleetId,
      },
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

  async revoke(invitationId: string, requestedBy: { id: string; role: UserRole; fleetId: string | null }) {
    const inv = await this.prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!inv) throw new NotFoundException('Invitation introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && inv.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
    if (inv.status !== 'PENDING') return inv;
    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });
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
