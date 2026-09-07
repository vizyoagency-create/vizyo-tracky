import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { authGuard } from './auth.guard';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UNE ENTRÉE PROFONDE SURVIT À LA CONNEXION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Toutes les entrées profondes du produit passent par ce garde quand la session a expiré :
 *
 *   - la notification push d'un excès de vitesse, qui vise LE trajet en cause ;
 *   - le bouton du rapport hebdomadaire, qui vise LA semaine du document ;
 *   - un lien recopié dans une conversation.
 *
 * Le garde renvoyait `/login` tout court : l'adresse demandée était jetée. On se connectait,
 * on atterrissait sur le tableau de bord, et il fallait retrouver soi-même le trajet ou la
 * période. Sur un téléphone, personne ne le fait — la notification perdait son objet.
 *
 * La page de connexion savait pourtant revenir (`?returnUrl=`, lot des comptes conducteurs) ;
 * personne ne le lui donnait.
 */
describe('authGuard — l’adresse demandée n’est pas perdue', () => {
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    router = TestBed.inject(Router);
    localStorage.removeItem('vizyo-tracky-token');
  });

  afterEach(() => localStorage.removeItem('vizyo-tracky-token'));

  /** Joue le garde sur une adresse, et rend l'arbre d'URL décidé (ou `true`). */
  const garde = (url: string): boolean | UrlTree =>
    TestBed.runInInjectionContext(() =>
      authGuard({} as never, { url } as never)) as boolean | UrlTree;

  it('session ouverte : on passe, sans détour', () => {
    localStorage.setItem('vizyo-tracky-token', 'jeton');

    expect(garde('/vehicles/v1?trip=t1')).toBeTrue();
  });

  it('session absente : redirection vers la connexion AVEC l’adresse visée', () => {
    const arbre = garde('/vehicles/v1?tab=reports&trip=t1&alert=a1') as UrlTree;

    expect(router.serializeUrl(arbre)).toContain('/login');
    expect(router.serializeUrl(arbre)).toContain('returnUrl=');
  });

  it('⚠️ la QUERY est reportée, pas seulement le chemin', () => {
    /**
     * C'est elle qui porte le trajet et l'alerte. Sans elle, on reviendrait sur la fiche du
     * véhicule sans le trajet ni l'alerte à marquer vue : la moitié de la promesse, donc le
     * pire des deux mondes — l'utilisateur croit que le lien a marché.
     */
    const arbre = garde('/vehicles/v1?tab=reports&trip=t1&alert=a1') as UrlTree;
    const retour = arbre.queryParams['returnUrl'] as string;

    expect(retour).toContain('trip=t1');
    expect(retour).toContain('alert=a1');
    expect(retour).toContain('tab=reports');
  });

  it('le lien du rapport hebdomadaire garde sa période', () => {
    const arbre = garde('/reports?from=2026-09-01&to=2026-09-08') as UrlTree;

    expect(arbre.queryParams['returnUrl']).toBe('/reports?from=2026-09-01&to=2026-09-08');
  });

  it('jamais « /login » comme retour — ce serait une boucle', () => {
    // Se connecter renverrait à la page de connexion, indéfiniment.
    const arbre = garde('/login') as UrlTree;

    expect(arbre.queryParams['returnUrl']).toBeUndefined();
  });

  it('la racine ne mérite pas de retour : c’est déjà la destination par défaut', () => {
    const arbre = garde('/') as UrlTree;

    expect(arbre.queryParams['returnUrl']).toBeUndefined();
  });
});
