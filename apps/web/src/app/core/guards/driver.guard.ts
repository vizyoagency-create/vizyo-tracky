import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * feat/comptes-conducteurs — un conducteur (rôle DRIVER) n'a PAS accès à l'app d'administration
 * (dashboard, carte, alertes, rapports…). Posé en `canActivate` du layout dashboard : tout
 * conducteur y est redirigé vers son espace focalisé `/driver` (« Mes véhicules »).
 *
 * Les autres rôles ne sont pas affectés. Défense en profondeur uniquement : le vrai périmètre est
 * garanti côté serveur (endpoints scopés + 403). Le veilleur garde son propre confinement
 * (watchmanChildGuard, allowlist /vehicles).
 */
export const driverAwayFromDashboardGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isDriver() ? router.createUrlTree(['/driver']) : true;
};
