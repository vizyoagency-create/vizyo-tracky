import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  DEVICE_ID_HEADER,
  DEVICE_VERIFICATION_REQUIRED,
  SECURITY_ENABLED,
} from './security.constants';
import { SecurityService } from './security.service';

/**
 * Gate de sécurité — interceptor GLOBAL (comme le gate de consentement). S'exécute
 * APRÈS les guards → `req.user` peuplé sur les routes protégées. Ne bloque QUE si un
 * challenge est en cours pour cet (utilisateur, appareil) — décision prise à
 * l'ouverture de session par /api/security/connection (utilisateur ayant activé le
 * 2FA + anomalie). Lecture mémoire O(1), aucun coût DB par requête.
 *
 * ⚠️ Routes toujours joignables (sinon impossible de recevoir/saisir le code ou de
 * se déconnecter) : /api/security/*, /api/auth, /api/users/me, consentement, health.
 */
const EXEMPT_PREFIXES = [
  '/api/security', // connection / verify / resend / 2fa — DOIT rester joignable
  '/api/auth/',
  '/api/users/me',
  '/api/consent',
  '/api/health',
  '/api/leads/',
  '/api/activity/',
  '/api/partner/',
  '/api/internal/',
];

interface GateRequest {
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string };
}

@Injectable()
export class SecurityGateInterceptor implements NestInterceptor {
  constructor(private readonly security: SecurityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!SECURITY_ENABLED) return next.handle();
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<GateRequest>();
    const userId = req.user?.id;
    if (!userId) return next.handle();

    const path = (req.originalUrl ?? '').split('?')[0] || '/';
    if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    const deviceId = headerStr(req.headers[DEVICE_ID_HEADER]);
    if (this.security.gateBlocks(userId, deviceId)) {
      throw new ForbiddenException({
        code: DEVICE_VERIFICATION_REQUIRED,
        message: 'Vérification de l’appareil requise.',
      });
    }
    return next.handle();
  }
}

function headerStr(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return (v[0] ?? '').trim() || null;
  return null;
}
