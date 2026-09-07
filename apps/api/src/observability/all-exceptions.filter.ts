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

/**
 * Les clés que le filtre pose LUI-MÊME. Une charge utile ne peut pas les redéfinir : `code` et
 * `message` sont calculés au-dessus, `requestId` est la seule trace qui relie une erreur vue par
 * l'utilisateur à sa ligne de journal. `statusCode` et `error` sont l'emballage interne de Nest,
 * qui n'a aucune raison d'être exposé deux fois.
 */
const CLES_RESERVEES = new Set(['code', 'message', 'requestId', 'statusCode', 'error']);

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * LES CHAMPS MÉTIER D'UNE ERREUR DÉLIBÉRÉMENT STRUCTURÉE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le filtre ne servait QUE `{ code, message, requestId }`. Tout autre champ de la charge utile
 * était jeté, en silence — y compris quand ce champ ÉTAIT le message.
 *
 * ── CE QUE ÇA COÛTAIT, MESURÉ ────────────────────────────────────────────────────────────────
 *
 * `missions.service.ts` refuse un créneau déjà pris avec :
 *
 *     new ConflictException({ code: 'MISSION_SLOT_CONFLICT', vehiclePlate, conflictingMission })
 *
 * `vehiclePlate` et `conflictingMission` — la plaque et la mission qui bloque, avec ses dates —
 * n'arrivaient jamais. Le dialogue d'agenda, qui sait afficher un panneau « ce véhicule est pris
 * de telle heure à telle heure », retombait donc sur « La mission n'a pas pu être créée. » : un
 * refus sans motif, devant lequel la seule issue est de réessayer au hasard.
 *
 * ── POURQUOI LE `code` SERT DE CLÉ ───────────────────────────────────────────────────────────
 *
 * Un `code` posé à la main est une décision : quelqu'un a écrit un contrat pour le client. Les
 * exceptions natives de Nest — celles de la validation, des gardes, des `NotFoundException(...)`
 * — n'en portent pas, et ne laissent donc RIEN passer. C'est ce qui empêche cette ouverture de
 * devenir une fuite : elle ne s'applique qu'aux charges utiles écrites pour être lues.
 *
 * ⚠️ Ce qu'on met dans une telle charge utile PART AU CLIENT. Ne jamais y placer un identifiant
 * interne, une trace, ni un détail d'une autre société que celle qui appelle.
 */
function champsMetierDe(corps: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(corps)) {
    if (CLES_RESERVEES.has(cle)) continue;
    out[cle] = valeur;
  }
  return Object.keys(out).length > 0 ? out : null;
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
    /** Les champs métier de la charge utile, quand elle en porte. Voir `champsMetierDe`. */
    let champsMetier: Record<string, unknown> | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : (body as any).message ?? exception.message;
      /**
       * ══════════════════════════════════════════════════════════════════════════════════
       * UN CODE POSÉ EXPLICITEMENT PAR L'APPELANT NE DOIT PAS ÊTRE ÉCRASÉ
       * ══════════════════════════════════════════════════════════════════════════════════
       *
       * Cette ligne ne lisait que `body.error` — le libellé que NEST met dans ses propres
       * exceptions (« Forbidden »). Un service qui lève `new ForbiddenException({ code:
       * 'CONSENT_REQUIRED' })` voyait donc son code remplacé par `HttpStatus[403]`, soit
       * `FORBIDDEN`. Le client recevait un 403 indiscernable de tous les autres.
       *
       * ⚠️ DEUX GARDES DE SÉCURITÉ EN DÉPENDAIENT, et toutes deux étaient muettes :
       *
       *   · `ConsentGateInterceptor` → `CONSENT_REQUIRED` : l'écran de consentement ne
       *     s'ouvrait jamais depuis un appel HttpClient ;
       *   · `SecurityGateInterceptor` → `DEVICE_VERIFICATION_REQUIRED` : idem pour la
       *     vérification d'appareil.
       *
       * Constaté le 2026-09-07 : un compte DEPOT sans consentement recevait
       * `{"code":"FORBIDDEN"}`, et l'espace dépôt — qui ne peut plus distinguer — affichait
       * « Votre transporteur a fermé cet accès ». On envoyait l'utilisateur appeler son
       * transporteur pour un accord qu'il lui suffisait de donner lui-même.
       *
       * ⚠️ `code` D'ABORD, `error` ENSUITE. L'ordre importe : les exceptions natives de Nest
       * portent `{ statusCode, message, error }` et n'ont pas de `code` — elles gardent donc
       * exactement le comportement d'avant.
       */
      const corps = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
      code = (typeof corps?.['code'] === 'string' && corps['code'])
        || (typeof corps?.['error'] === 'string' && corps['error'])
        || HttpStatus[status]
        || 'ERROR';
      // Un `code` explicite = une charge utile écrite pour le client : ses autres champs
      // partent avec lui. Sans `code`, rien ne passe. Voir `champsMetierDe`.
      champsMetier = corps && typeof corps['code'] === 'string' ? champsMetierDe(corps) : null;
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
        // ⚠️ LES CHAMPS MÉTIER D'ABORD, les trois clés du filtre ENSUITE. `champsMetierDe`
        // écarte déjà les clés réservées ; cet ordre fait qu'aucune charge utile ne pourra
        // les masquer même si cette liste venait à être modifiée.
        ...(champsMetier ?? {}),
        code,
        message,
        requestId,
      },
    });
  }
}
