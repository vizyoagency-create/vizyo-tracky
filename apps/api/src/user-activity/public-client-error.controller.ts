import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ErrorLogger } from '../observability/error-logger.service';

/**
 * Remontée PUBLIQUE (sans auth) d'un bug JS client survenu AVANT connexion — page de login /
 * mot de passe oublié / reset : pas encore de session, donc l'endpoint authentifié
 * `POST /api/activity/error` (JwtAuthGuard) est inaccessible et l'erreur serait perdue. C'est
 * le pire cas pour la crédibilité (« je n'arrive pas à me connecter » = invisible).
 *
 * Rate-limité, tolérant (entrée non fiable → tout tronqué, lu via @Req pour ne pas dépendre du
 * ValidationPipe global), 204 sans contenu. Alimente le centre d'alerte (error_logs) avec la
 * source `frontend-anon` (distincte de `frontend` authentifié). La dédup d'ErrorLogger borne le flood.
 */
@Controller('public')
export class PublicClientErrorController {
  constructor(private readonly errorLogger: ErrorLogger) {}

  @Post('client-error')
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  report(@Req() req: Request): void {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' && v.length ? v.slice(0, max) : undefined;

    const message = str(body.message, 2000) ?? 'Frontend error (pre-auth)';
    const err = new Error(message);
    const stack = str(body.stack, 6000);
    if (stack) err.stack = stack;

    this.errorLogger.recordBackground(err, 'frontend-anon', {
      preAuth: true,
      route: str(body.route, 200),
      page: str(body.route, 200),
      sessionId: str(body.sessionId, 60),
      httpUrl: str(body.httpUrl, 300),
      userAgent: str(req.headers['user-agent'], 300),
      ip: req.ip,
    });
  }
}
