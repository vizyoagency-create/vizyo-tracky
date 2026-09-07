import { inject } from '@angular/core';
import { type ActivatedRouteSnapshot, type CanActivateFn, type RouterStateSnapshot, Router } from '@angular/router';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * SESSION REQUISE — ET L'ADRESSE DEMANDÉE N'EST PAS PERDUE EN CHEMIN
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce garde renvoyait `createUrlTree(['/login'])` : l'adresse qu'on essayait d'ouvrir était
 * simplement jetée. La page de connexion sait pourtant revenir — elle lit `?returnUrl=` depuis
 * le lot des comptes conducteurs — mais personne ne le lui donnait.
 *
 * ── CE QUE ÇA COÛTAIT, CONCRÈTEMENT ─────────────────────────────────────────────────────
 *
 * Toutes les entrées PROFONDES du produit tombent ici quand la session a expiré :
 *
 *   - la notification push d'un excès de vitesse, qui vise le trajet en cause ;
 *   - le bouton du rapport hebdomadaire, qui vise la semaine du document ;
 *   - un lien recopié dans une conversation.
 *
 * Dans les trois cas, on se connectait puis on atterrissait sur le tableau de bord, avec la
 * charge de retrouver soi-même le trajet ou la période. Sur un téléphone, personne ne le fait.
 *
 * ⚠️ `state.url` PORTE DÉJÀ LA QUERY. C'est ce qui rend le retour utile : sans elle,
 * `/vehicles/xxx` ramènerait la fiche mais pas le trajet, ni l'alerte à marquer vue — la
 * moitié de la promesse, donc le pire des deux mondes.
 *
 * ⚠️ ON N'ENVOIE JAMAIS `/login` COMME RETOUR. Une session expirée sur la page de connexion
 * elle-même (ou une double redirection) créerait une boucle : connecté, renvoyé au login,
 * reconnecté. La page de connexion valide déjà que le retour est un chemin interne
 * (anti-redirection ouverte) ; on ajoute ici la seule garde qu'elle ne peut pas faire.
 */
export const authGuard: CanActivateFn = (_route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
  const router = inject(Router);
  const token = localStorage.getItem('vizyo-tracky-token');
  if (token) return true;

  const cible = state.url;
  const utile = cible && cible !== '/' && !cible.startsWith('/login');
  return router.createUrlTree(['/login'], utile ? { queryParams: { returnUrl: cible } } : {});
};
