import { inject } from '@angular/core';
import { type CanActivateChildFn, Router, type RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Sprint 3 — Confinement du rôle « veilleur de nuit » (NIGHT_WATCHMAN).
 *
 * Allowlist **default-deny** : le veilleur ne peut atteindre QUE la liste des
 * véhicules (`/vehicles`). Le détail véhicule (`/vehicles/:id`) est volontairement
 * BLOQUÉ — il expose vitesse, position, coordonnées, IMEI, historique : le client
 * ne veut AUCUNE donnée pour ce rôle. Le veilleur agit (couper/rallumer) directement
 * depuis la liste. Toute autre route — détail, dashboard, carte, alertes, rapports,
 * admin, et toute route AJOUTÉE plus tard — le renvoie vers `/vehicles`.
 *
 * Posé en `canActivateChild` du layout dashboard → couvre tous les enfants,
 * présents et futurs, sans devoir gérer chaque route individuellement.
 *
 * Défense en profondeur uniquement : le vrai périmètre du veilleur est garanti
 * **côté serveur** (403 sur tout endpoint hors `/vehicles` GET + engine POST).
 * Les autres rôles ne sont pas affectés par ce guard.
 */
export const watchmanChildGuard: CanActivateChildFn = (_childRoute, state: RouterStateSnapshot) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isWatchman()) return true;

  const path = state.url.split('?')[0].split('#')[0];
  // Seule la LISTE est autorisée : pas de détail (`/vehicles/:id`) → zéro donnée.
  const allowed = path === '/vehicles';
  return allowed ? true : router.createUrlTree(['/vehicles']);
};
