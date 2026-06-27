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
 *       • si `AUDIO_MONITORING_ENABLED` n'est pas exactement 'true' → 403 (#2 :
 *         écoute techniquement impossible sans interrupteur explicite, OFF par défaut) ;
 *       • si l'appelant est SUPER_ADMIN ET `AUDIO_SUPERADMIN_ENABLED` != 'true' →
 *         403 (#3 : le prestataire/super-admin ne déclenche PAS en prod PAR DÉFAUT).
 *         Phase de test interne : `AUDIO_SUPERADMIN_ENABLED=true` l'autorise
 *         explicitement (réversible d'un seul flag).
 *   - En **dev/test** : super-admin autorisé (véhicule de test), pas de flag exigé.
 *
 * Phase actuelle : le déclenchement (@Roles) est restreint à SUPER_ADMIN (test
 * interne) ; FLEET_ADMIN sera rouvert ensuite. Ici on ne fait que l'arbitrage prod.
 */
@Injectable()
export class AudioMonitoringGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const env = this.config.get('NODE_ENV', { infer: true });
    const masterFlag = this.config.get('AUDIO_MONITORING_ENABLED', { infer: true }) === 'true';
    const superAdminAllowed =
      this.config.get('AUDIO_SUPERADMIN_ENABLED', { infer: true }) === 'true';
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (env === 'production') {
      if (!masterFlag)
        throw new ForbiddenException('Écoute audio désactivée en production (flag absent).'); // #2
      // #3 : le super-admin (prestataire) ne déclenche PAS en prod PAR DÉFAUT.
      // Phase de test interne : AUDIO_SUPERADMIN_ENABLED=true l'autorise explicitement (réversible d'un flag).
      if (user.role === UserRole.SUPER_ADMIN && !superAdminAllowed) {
        throw new ForbiddenException(
          "Le super-admin ne peut pas déclencher d'écoute en production (hors phase de test).",
        );
      }
    }
    return true;
  }
}
