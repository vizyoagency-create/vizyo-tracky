import { inject } from '@angular/core';
import { type CanActivateChildFn, type CanActivateFn, Router, type RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Espace dépôt (2026-08) — les deux gardes du rôle DEPOT. Cf. design/A1-ROLE-DEPOT.md § 5.
 *
 * Défense en profondeur UNIQUEMENT. Le vrai périmètre est garanti côté serveur :
 * `DepotScopeGuard` répond 403, et les endpoints `/depot/*` filtrent sur `depotUserId`.
 * Ces gardes évitent d'afficher une page qui ne se remplira jamais — ils ne protègent
 * aucune donnée.
 */

/**
 * VERROUILLAGE INVERSE — un dépôt qui tape `/map`, `/vehicles` ou `/reports` est renvoyé
 * sur `/depot`.
 *
 * ⚠️ Pas de page 403, et c'est délibéré : ces routes **n'existent pas dans son monde**.
 * Lui montrer « accès refusé » lui apprendrait qu'il y a quelque chose derrière, et
 * l'inviterait à demander pourquoi. Une redirection silencieuse dit la vérité utile :
 * son espace, c'est `/depot`.
 *
 * Allowlist **default-deny**, sur le modèle de `watchmanChildGuard` : toute route ajoutée
 * plus tard au shell est fermée au dépôt sans qu'on ait à y penser. C'est l'inverse d'une
 * liste de routes interdites, qu'il faudrait maintenir et qu'on oublierait.
 *
 * Posé en `canActivateChild` du layout dashboard — et non en `canActivate`, sinon il
 * s'appliquerait au layout lui-même et renverrait le dépôt de `/depot` vers `/depot`,
 * en boucle.
 */
const PREFIXES_AUTORISES = ['/depot', '/account'];

export const depotChildGuard: CanActivateChildFn = (_route, state: RouterStateSnapshot) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isDepot()) return true;

  const chemin = state.url.split('?')[0].split('#')[0];
  // `/account` reste ouvert : « Mon compte » figure dans son menu profil (A1 § 5), et
  // c'est là qu'il change son mot de passe. Tout le reste est fermé.
  const autorise = PREFIXES_AUTORISES.some((p) => chemin === p || chemin.startsWith(p + '/'));
  return autorise ? true : router.createUrlTree(['/depot']);
};

/**
 * VERROU D'ENTRÉE — seul un compte DEPOT entre dans `/depot`.
 *
 * Un gestionnaire du transporteur qui s'y égarerait verrait un espace vide et
 * incompréhensible : ses missions ne lui sont pas assignées, elles sont assignées à ses
 * dépôts. Il est renvoyé vers son propre tableau de bord.
 */
export const depotRoleGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isDepot() ? true : router.createUrlTree(['/dashboard']);
};
