import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isExpectedRefusal } from '../common/expected-refusal.exception';
import { ErrorLogger } from './error-logger.service';

/**
 * Abandon de la requête CÔTÉ CLIENT (pas une faute serveur) : un mobile qui passe en
 * arrière-plan ou perd le réseau au milieu d'un POST (typiquement `/api/activity/batch`
 * envoyé en keepalive/beacon depuis un iPhone) → `raw-body` lève
 * `BadRequestError: request aborted` (`type: 'request.aborted'`), ou le socket est reset
 * (`ECONNRESET`/`ECONNABORTED`). Ces cas ne doivent PAS polluer le centre d'alerte (encore
 * moins en CRITICAL) : il n'y a plus personne au bout du fil.
 */
function isClientDisconnect(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { type?: string; code?: string; message?: string };
  return (
    err.type === 'request.aborted' ||
    err.code === 'ECONNRESET' ||
    err.code === 'ECONNABORTED' ||
    err.message === 'request aborted'
  );
}

/**
 * Throttling d'un service AMONT (ex. Vizyo Auth renvoie 429 « Too Many Requests » quand TOUS les
 * onglets ouverts rafraîchissent leur token EN MÊME TEMPS — typiquement pendant un REDÉPLOIEMENT :
 * l'API redémarre, les clients se reconnectent et refont un `/auth/refresh` d'un coup). Ce n'est ni
 * un crash ni une faute serveur : le client réessaie et ça se résorbe tout seul. On NE l'écrit PAS
 * au centre d'alerte — sinon un simple deploy = ~100 fausses erreurs CRITICAL (incident observé le
 * 2026-07-15). La réponse HTTP au client reste inchangée : seule la journalisation est supprimée.
 */
function isUpstreamThrottle(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /Vizyo Auth error 429|ThrottlerException|Too Many Requests/i.test(msg);
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly errorLogger: ErrorLogger) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const requestId = (req as any).id ?? randomUUID().slice(0, 8);

    // Client parti en cours de requête : rien à journaliser (pas une faute serveur) et
    // plus personne à qui répondre. On sort tôt pour ne pas gonfler le centre d'alerte.
    if (isClientDisconnect(exception)) {
      this.logger.debug(
        { requestId, route: `${req.method} ${req.url}` },
        'Requête abandonnée par le client (ignorée)',
      );
      return;
    }

    let status: number;
    let message: string;
    let code: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : (body as any).message ?? exception.message;
      code = typeof body === 'object' && (body as any).error ? (body as any).error : HttpStatus[status] ?? 'ERROR';
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      code = 'INTERNAL_SERVER_ERROR';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Unknown error';
      code = 'INTERNAL_SERVER_ERROR';
    }

    if (Array.isArray(message)) {
      message = message.join(', ');
    }

    const user = (req as any).user as
      | { id?: string; email?: string; fleetId?: string | null }
      | undefined;
    const headers: Record<string, unknown> = req.headers ?? {};
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' ? v.slice(0, max) : undefined;

    // TRK-004 — `isExpectedRefusal` écarte les refus DÉLIBÉRÉS (plafond de dépense IA
    // atteint, assistance IA coupée pour une société). Ce sont des décisions de la
    // plateforme, pas des pannes : les archiver revenait à signaler comme une faute une
    // gouvernance qui fonctionne. Même patron que `isUpstreamThrottle` juste au-dessus,
    // ajouté après les ~100 fausses CRITICAL d'un redéploiement. La réponse HTTP au client
    // est inchangée : seule la journalisation disparaît.
    if (
      (status >= 500 || !(exception instanceof HttpException)) &&
      !isUpstreamThrottle(exception) &&
      !isExpectedRefusal(exception)
    ) {
      // CRITICAL est reserve aux fautes serveur non maitrisees (exception non geree
      // -> 500). Un 5xx leve VOLONTAIREMENT (HttpException) est une condition
      // operationnelle attendue, pas un crash : ex. 503 "tracker hors ligne" sur
      // arm surveillance / engine-control, ou 503 "vizyo-texto injoignable". On le
      // logge en ERROR (toujours visible dans le centre d'alertes) sans gonfler le
      // compteur CRITICAL — sinon le centre d'alertes "crie au loup".
      const level: 'ERROR' | 'CRITICAL' =
        exception instanceof HttpException ? 'ERROR' : 'CRITICAL';
      await this.errorLogger.record(
        exception instanceof Error ? exception : new Error(String(exception)),
        'http',
        {
          requestId,
          route: `${req.method} ${req.url}`,
          userId: user?.id,
          userEmail: user?.email,
          fleetId: user?.fleetId ?? undefined,
          // Page frontend + session côté client (headers posés par l'intercepteur).
          page: str(headers['x-current-route'], 200),
          sessionId: str(headers['x-session-id'], 60),
          userAgent: str(headers['user-agent'], 300),
          ip: req.ip,
          statusCode: status,
        },
        level,
      );
    }

    this.logger.warn(
      { requestId, status, route: `${req.method} ${req.url}`, userId: user?.id },
      `${status} ${code}: ${message}`,
    );

    res.status(status).json({
      error: {
        code,
        message,
        requestId,
      },
    });
  }
}
