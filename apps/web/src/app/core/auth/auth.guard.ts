import { inject } from '@angular/core';
import { type ActivatedRouteSnapshot, type CanActivateFn, type RouterStateSnapshot, Router } from '@angular/router';
import { retourSur } from './retour-interne';

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
 * ⚠️ CE QUI MÉRITE D'ÊTRE REPORTÉ EST DÉFINI AILLEURS — `retourSur`, partagé avec
 * l'intercepteur qui écrit le même paramètre et avec la page de connexion qui le suit. Les
 * trois se posaient la question chacun de son côté ; la règle et ses raisons sont là-bas.
 */
export const authGuard: CanActivateFn = (_route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
  const router = inject(Router);
  const token = localStorage.getItem('vizyo-tracky-token');
  if (token) return true;

  const retour = retourSur(state.url);
  return router.createUrlTree(['/login'], retour ? { queryParams: { returnUrl: retour } } : {});
};
