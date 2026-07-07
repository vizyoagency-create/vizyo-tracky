import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { AuthClientService } from '../auth-client/auth-client.service';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './types/auth-user';

export interface VizyoAccessPayload {
  iss: string;
  aud: string;
  sub: string;
  appId: string;
  typ: string;
  jti: string;
  exp: number;
}

@Injectable()
export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtIssuer: string;
  private readonly appInternalId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly authClient: AuthClientService,
  ) {
    this.jwtSecret = this.config.get('VIZYO_AUTH_JWT_ACCESS_SECRET', { infer: true });
    this.jwtIssuer = this.config.get('VIZYO_AUTH_JWT_ISSUER', { infer: true });
    this.appInternalId = this.config.get('VIZYO_AUTH_APP_INTERNAL_ID', { infer: true });
  }

  async login(email: string, password: string) {
    const tokens = await this.authClient.login(email, password);

    const payload = this.verifyAccessToken(tokens.accessToken);
    const localUser = await this.resolveLocalUser(payload.sub);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: localUser.id,
        email: localUser.email,
        role: localUser.role,
        isOwner: localUser.isOwner,
        fleetId: localUser.fleetId,
        permissions: localUser.permissions,
      },
    };
  }

  verifyAccessToken(token: string): VizyoAccessPayload {
    let payload: VizyoAccessPayload;
    try {
      payload = jwt.verify(token, this.jwtSecret) as VizyoAccessPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.iss !== this.jwtIssuer) {
      throw new UnauthorizedException('Invalid token issuer');
    }
    if (payload.aud !== 'api') {
      throw new UnauthorizedException('Invalid token audience');
    }
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    if (payload.appId !== this.appInternalId) {
      throw new UnauthorizedException('Invalid token app');
    }

    return payload;
  }

  async resolveLocalUser(authUserId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { authUserId },
    });

    if (!user) {
      throw new UnauthorizedException('User not provisioned in Tracky');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account suspended');
    }

    return {
      id: user.id,
      authUserId: user.authUserId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isOwner: user.isOwner,
      fleetId: user.fleetId,
      isActive: user.isActive,
      permissions: (user.permissions as AuthUser['permissions']) ?? null,
    };
  }
}
