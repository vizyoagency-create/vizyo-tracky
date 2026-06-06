import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import type { UserRoleSlug } from '@vizyo/tracky-shared';
import { AuthService } from '../services/auth.service';

/**
 * Guard de route generique par role. Ex : `roleGuard('FLEET_ADMIN','SUPER_ADMIN')`.
 * Redirige vers /dashboard si le role courant n'est pas autorise. Cote serveur,
 * l'acces reste re-verifie (le guard est purement UX).
 */
export function roleGuard(...roles: UserRoleSlug[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const role = auth.user()?.role;
    if (role && roles.includes(role)) return true;
    return router.createUrlTree(['/dashboard']);
  };
}
