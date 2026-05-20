import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import type { AuthUser } from '../types/auth-user';

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
  // cookies est deja typee par express via @types/cookie-parser (Record<string, any>).
  // On ne le redeclare pas ici pour eviter un conflit de types.
}

/**
 * V1.10 (Sprint 6) — Le guard lit le JWT prioritairement depuis le cookie
 * httpOnly `tracky_at` (nouveau, secure XSS-resistant), avec fallback sur le
 * header `Authorization: Bearer <token>` pour la backward compat des clients
 * SDK / scripts qui se loguent avec un token explicite.
 *
 * Pendant la migration, les deux modes cohabitent : login pose un cookie ET
 * renvoie le token dans le body. Le frontend Tracky utilise withCredentials et
 * ignore le body. Les clients legacy continuent de fonctionner avec le header.
 */
export const ACCESS_COOKIE_NAME = 'tracky_at';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // 1. Priorite au cookie httpOnly (mode securise).
    const cookieToken = req.cookies?.[ACCESS_COOKIE_NAME];

    // 2. Fallback header Authorization (SDK / scripts / backward compat).
    const header = req.headers.authorization;
    const headerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    const token = cookieToken ?? headerToken;
    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    const payload = this.auth.verifyAccessToken(token);
    req.user = await this.auth.resolveLocalUser(payload.sub);
    return true;
  }
}
