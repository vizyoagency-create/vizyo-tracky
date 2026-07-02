import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { SystemActivityService } from './system-activity.service';

/**
 * Audit « altitude » — journalise TOUTE mutation HTTP (POST/PUT/PATCH/DELETE) dans
 * system_activity_logs (catégorie MUTATION) : méthode + template de route (sans ids
 * bruts ni query), utilisateur, statut, durée. Complète la capture front (clics) par
 * la preuve côté serveur que l'action a réellement eu lieu — et couvre d'un coup les
 * mutations métier sans table d'audit dédiée (véhicules, géofences, groupes, users…).
 *
 * JAMAIS le body (mots de passe sur /users et /internal). Les doublons assumés avec
 * ENGINE/SMS/EMAIL (2 lignes pour 1 action) sont des granularités différentes.
 * S'exécute APRÈS les guards → req.user (JwtAuthGuard) est disponible.
 */

/** Préfixes exclus : haut volume, callbacks machine ou déjà couverts ailleurs. */
const EXCLUDED_PREFIXES = [
  '/api/activity/', // batchs de tracking (volume dominant, c'est déjà le journal)
  '/api/auth/', // login/refresh/logout — sensibles + fréquents
  '/api/sms/webhook', // callbacks passerelle vizyo-texto
  '/api/realtime/incident', // déjà routé vers ErrorLog
  '/api/internal/', // instrumentation dédiée catégorie INTERNAL (plus riche) + BackupRun
  '/api/leads/contact', // formulaire public LP
  '/api/notifications/push/subscribe', // abonnements push (fréquents, techniques)
];

interface MutationRequest {
  method?: string;
  originalUrl?: string;
  route?: { path?: string };
  user?: { id?: string; email?: string; firstName?: string | null; lastName?: string | null; fleetId?: string | null };
}

@Injectable()
export class MutationAuditInterceptor implements NestInterceptor {
  constructor(private readonly systemActivity: SystemActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<MutationRequest>();
    const method = (req.method ?? '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next.handle();

    const rawPath = (req.originalUrl ?? '').split('?')[0] || '/';
    if (EXCLUDED_PREFIXES.some((p) => rawPath.startsWith(p))) return next.handle();

    // Template de route Express ('/api/users/:id') = pas d'ids bruts. Fallback : chemin
    // réel avec les UUID remplacés (route 404/guard rejeté avant le matching de route).
    const template =
      req.route?.path ??
      rawPath.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, ':id');

    const startedAt = Date.now();
    const record = (statusCode: number, errorMessage?: string) => {
      const u = req.user;
      const actor = u
        ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'utilisateur'
        : 'anonyme';
      this.systemActivity.record({
        category: 'MUTATION',
        action: `http_${method.toLowerCase()}`,
        status: statusCode >= 400 ? 'FAILURE' : 'SUCCESS',
        actor,
        target: `${method} ${template}`,
        detail: errorMessage ? `HTTP ${statusCode} — ${errorMessage}` : `HTTP ${statusCode}`,
        fleetId: u?.fleetId ?? null,
        triggeredByUserId: u?.id ?? null,
        durationMs: Date.now() - startedAt,
        meta: errorMessage ? { error: errorMessage, statusCode } : { statusCode },
      });
    };

    return next.handle().pipe(
      tap(() => record(context.switchToHttp().getResponse<{ statusCode?: number }>()?.statusCode ?? 200)),
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        const message = err instanceof Error ? err.message : String(err);
        record(status, message.slice(0, 200));
        return throwError(() => err);
      }),
    );
  }
}
