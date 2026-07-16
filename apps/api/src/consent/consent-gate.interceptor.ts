import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { CONSENT_VERSION } from './consent.constants';
import { ConsentService } from './consent.service';

/**
 * Gate de consentement — interceptor GLOBAL (comme MutationAuditInterceptor, il
 * s'exécute APRÈS les guards → req.user est peuplé sur les routes protégées ;
 * absent sur les routes publiques → on laisse passer). Si l'utilisateur
 * authentifié n'a pas accepté la version courante des CGU+Confidentialité, on
 * renvoie 403 { code: 'CONSENT_REQUIRED' }. Le front redirige alors vers l'écran de
 * consentement (refus = déconnexion).
 *
 * ⚠️ Routes joignables SANS consentement à jour (sinon impossible d'accepter ou de
 * se déconnecter) : l'API de consentement, l'auth (login/logout), /users/me (le
 * front lit le statut pour AFFICHER l'écran), health + routes publiques.
 */
const EXEMPT_PREFIXES = [
  '/api/consent', // /consent/current + /accept + /lp — DOIT rester joignable
  '/api/auth/', // login / refresh / logout / accept-invitation
  '/api/users/me', // GET me + onboarding-complete — le front en a besoin pour décider
  '/api/health',
  '/api/leads/', // formulaire public LP
  '/api/activity/', // batchs de tracking (publics)
  '/api/partner/', // beacons LP (publics)
  '/api/internal/', // callbacks machine
];

interface GateRequest {
  originalUrl?: string;
  user?: { id?: string };
}

@Injectable()
export class ConsentGateInterceptor implements NestInterceptor {
  constructor(private readonly consent: ConsentService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<GateRequest>();
    const userId = req.user?.id;
    if (!userId) return next.handle(); // route publique / non authentifiée

    const path = (req.originalUrl ?? '').split('?')[0] || '/';
    if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    if (this.consent.isCached(userId)) return next.handle();

    return from(this.consent.hasCurrentConsent(userId)).pipe(
      switchMap((ok) => {
        if (!ok) {
          throw new ForbiddenException({
            code: 'CONSENT_REQUIRED',
            version: CONSENT_VERSION,
            message: 'Consentement requis pour accéder au service.',
          });
        }
        return next.handle();
      }),
    );
  }
}
