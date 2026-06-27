import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import type { Env } from '../config/env.validation';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

/**
 * Sprint 4 — Le PIVOT dev/prod de l'écoute audio (garde-fous #2 + #3).
 *
 * Feature LÉGALEMENT CRITIQUE (micro embarqué). Ce guard ne fait QUE l'arbitrage
 * environnement ; il s'enchaîne APRÈS RolesGuard (qui a déjà filtré le rôle) et
 * AVANT PermissionsGuard. Logique stricte :
 *
 *   - En **production** :
 *       • si le flag `AUDIO_MONITORING_ENABLED` n'est pas exactement 'true' →
 *         403 (#2 : l'écoute est techniquement impossible sans interrupteur
 *         explicite, OFF par défaut) ;
 *       • si l'appelant est SUPER_ADMIN → 403 (#3 : le prestataire/super-admin
 *         ne déclenche JAMAIS d'écoute en production sur le parc d'un client).
 *   - En **dev/test** : super-admin autorisé (véhicule de test), pas de flag exigé.
 *
 * Le rôle déclenchant légitime en prod est donc FLEET_ADMIN (filtré en amont par
 * @Roles). Ici on ne fait que refermer les portes prod.
 */
@Injectable()
export class AudioMonitoringGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const env = this.config.get('NODE_ENV', { infer: true });
    const flag = this.config.get('AUDIO_MONITORING_ENABLED', { infer: true }) === 'true';

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;

    if (env === 'production') {
      if (!flag) {
        throw new ForbiddenException('Écoute audio désactivée en production (flag absent).');
      }
      if (user.role === UserRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          "Le super-admin ne peut pas déclencher d'écoute en production.",
        );
      }
    }

    return true;
  }
}
