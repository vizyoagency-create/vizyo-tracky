import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { ApiTrafficService } from './api-traffic.service';

/**
 * Observabilité du trafic API — capture les hits d'API PUBLIQUE et les requêtes SANS
 * utilisateur authentifié (IP potentiellement inconnues). Best-effort, JAMAIS bloquant.
 *
 * S'exécute APRÈS les guards → req.user (JwtAuthGuard) est disponible. Les requêtes
 * rejetées par un guard (ThrottlerGuard 429, JwtAuthGuard 401) n'atteignent PAS
 * l'interceptor — voulu : pas d'inondation, pas de capture des flux d'auth.
 *
 * Volume maîtrisé :
 *  - hits PUBLICS ou NON authentifiés → journalisés (LA donnée voulue : qui entre, d'où).
 *  - requêtes AUTHENTIFIÉES → journalisées au plus 1×/(user,ip)/10 min (dédup mémoire) :
 *    construit le corpus des IP « connues » sans une ligne par requête.
 */

/** Préfixes PUBLICS explicitement journalisés. */
const PUBLIC_PREFIXES = [
  '/api/leads',
  '/api/webhooks',
  '/api/sms/webhook',
  '/api/email/webhook',
];

/** Préfixes JAMAIS journalisés (sensibles, très fréquents, ou déjà couverts / anti-boucle). */
const EXCLUDED_PREFIXES = [
  '/api/auth/', // login/refresh/logout — sensibles + fréquents
  '/api/activity/', // batch de tracking (volume dominant)
  '/api/internal/', // callbacks machine (secret guard)
  '/api/partner', // beacons : déjà tracés en PARTNER_EVENT par le contrôleur (anti-doublon)
  '/api/admin/api-traffic', // nos propres endpoints de lecture (anti-boucle)
  '/api/health', // healthcheck Docker (wget) / Traefik toutes les ~30 s — pur bruit d'infra
];

interface TrafficRequest extends Request {
  user?: { id?: string };
}

@Injectable()
export class ApiTrafficInterceptor implements NestInterceptor {
  /** Dédup des requêtes authentifiées : `${userId}|${ip}` → dernier ts journalisé. */
  private readonly authSeen = new Map<string, number>();
  private readonly authDedupMs = 10 * 60_000;
  private lastPrune = Date.now();

  constructor(private readonly traffic: ApiTrafficService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<TrafficRequest>();
    const method = (req.method ?? 'GET').toUpperCase();
    const rawPath = (req.originalUrl ?? req.url ?? '').split('?')[0] || '/';

    // Ne traiter que l'API (préfixe global 'api'). Écarte assets / bruit hors-API.
    if (!rawPath.startsWith('/api')) return next.handle();
    if (EXCLUDED_PREFIXES.some((p) => rawPath.startsWith(p))) return next.handle();

    const startedAt = Date.now();
    const finalize = (statusCode: number): void => {
      try {
        this.maybeRecord(req, method, rawPath, statusCode, Date.now() - startedAt);
      } catch {
        /* JAMAIS bloquant */
      }
    };

    return next.handle().pipe(
      tap(() => finalize(context.switchToHttp().getResponse<Response>()?.statusCode ?? 200)),
      catchError((err: unknown) => {
        finalize(err instanceof HttpException ? err.getStatus() : 500);
        return throwError(() => err);
      }),
    );
  }

  private maybeRecord(
    req: TrafficRequest,
    method: string,
    path: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const userId = req.user?.id ?? null;
    const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));

    if (!isPublic && userId) {
      // Requête authentifiée « normale » : n'alimenter que le corpus des IP connues,
      // dédupliqué par (user, ip) sur 10 min (évite une ligne par requête).
      const ip = this.extractIp(req);
      const key = `${userId}|${ip ?? '?'}`;
      const now = Date.now();
      const last = this.authSeen.get(key);
      if (last && now - last < this.authDedupMs) return;
      this.authSeen.set(key, now);
      this.prune();
      this.emit(req, method, path, statusCode, durationMs, userId, ip);
      return;
    }

    if (isPublic || !userId) {
      // Trafic public OU non authentifié (IP potentiellement inconnue) : la donnée voulue.
      this.emit(req, method, path, statusCode, durationMs, userId, this.extractIp(req));
    }
  }

  private emit(
    req: TrafficRequest,
    method: string,
    path: string,
    statusCode: number,
    durationMs: number,
    userId: string | null,
    ip: string | null,
  ): void {
    this.traffic.record({
      kind: 'REQUEST',
      method,
      path,
      statusCode,
      ip,
      userId,
      userAgent: this.header(req, 'user-agent'),
      origin: this.header(req, 'origin') ?? this.header(req, 'referer'),
      durationMs,
    });
  }

  /** IP réelle derrière Traefik : 1er hop de X-Forwarded-For, puis req.ip / socket. */
  private extractIp(req: TrafficRequest): string | null {
    const xff = req.headers['x-forwarded-for'];
    const first =
      typeof xff === 'string' ? xff.split(',')[0]?.trim() : Array.isArray(xff) ? xff[0] : undefined;
    return first || req.ip || req.socket?.remoteAddress || null;
  }

  private header(req: TrafficRequest, name: string): string | null {
    const v = req.headers[name];
    return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
  }

  /** Purge périodique de la table de dédup (borne mémoire). */
  private prune(): void {
    const now = Date.now();
    if (now - this.lastPrune < 5 * 60_000) return;
    this.lastPrune = now;
    for (const [k, ts] of this.authSeen) if (now - ts > this.authDedupMs) this.authSeen.delete(k);
    if (this.authSeen.size > 50_000) this.authSeen.clear();
  }
}
