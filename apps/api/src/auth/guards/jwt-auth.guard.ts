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

    if (!cookieToken && !headerToken) {
      throw new UnauthorizedException('Missing access token');
    }

    /**
     * ── LE COOKIE A LA PRIORITÉ, PAS LE MONOPOLE ────────────────────────────────────────
     *
     * Ce guard s'écrivait `const token = cookieToken ?? headerToken`. Le repli ne servait
     * donc QUE si le cookie était ABSENT, jamais s'il était INUTILISABLE — alors que le
     * commentaire ci-dessus annonce deux modes qui « cohabitent ».
     *
     * Un cookie présent mais périmé, tronqué, ou signé avec un secret d'avant un
     * redéploiement faisait donc échouer la requête SANS JAMAIS essayer l'en-tête, que le
     * client venait pourtant de rafraîchir. Le navigateur, lui, ne peut rien y faire : le
     * cookie est httpOnly, il ne sait ni le lire ni le supprimer.
     *
     * ⚠️ CECI N'ÉLARGIT AUCUNE CONFIANCE. Les deux jetons traversent EXACTEMENT la même
     * vérification (`verifyAccessToken` : signature, émetteur, audience, type, application).
     * Un en-tête accepté ici l'aurait été à l'identique sur une requête sans cookie. On
     * corrige l'ORDRE d'essai, jamais le contrôle.
     *
     * ⚠️ Et l'échec reste un échec : si les DEUX sont invalides, c'est l'erreur du cookie
     * qui est relancée — celle du mode nominal, la plus utile à qui lit les journaux.
     */
    let payload;
    try {
      payload = this.auth.verifyAccessToken(cookieToken ?? headerToken!);
    } catch (erreurCookie) {
      // Rien à réessayer : soit il n'y avait pas de cookie, soit l'en-tête est le même jeton.
      if (!cookieToken || !headerToken || headerToken === cookieToken) throw erreurCookie;
      try {
        payload = this.auth.verifyAccessToken(headerToken);
      } catch {
        throw erreurCookie;
      }
    }

    req.user = await this.auth.resolveLocalUser(payload.sub);
    return true;
  }
}
