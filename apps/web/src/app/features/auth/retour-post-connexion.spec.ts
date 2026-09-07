import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { retourSur } from '../../core/auth/retour-interne';
import { AuthService } from '../../core/services/auth.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';
import { LoginComponent } from './login.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA DERNIÈRE MARCHE : APRÈS LA CONNEXION, ON REVIENT OÙ L'ON ALLAIT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `authGuard` et `authInterceptor` posent `?returnUrl=` (cf. `core/auth/retour-apres-connexion
 * .spec.ts`). Ce fichier tient l'AUTRE bout : que la page de connexion s'en serve vraiment, et
 * qu'elle refuse ce qu'elle doit refuser.
 *
 * Le parcours complet d'une notification d'excès reçue session expirée :
 *
 *   notification  →  /vehicles/x?trip=…&alert=…
 *   garde         →  /login?returnUrl=/vehicles/x?trip=…&alert=…
 *   connexion     →  /vehicles/x?trip=…&alert=…      ← ici
 *
 * ⚠️ CE TEST MONTE LE VRAI COMPOSANT ET APPELLE `onSubmit()`. Une première version recopiait
 * le prédicat dans un helper et n'appelait rien : elle aurait garanti sa propre copie, et rien
 * d'autre. La règle est maintenant une fonction de production (`retourSur`), partagée par les
 * trois points qui se posent la question ; les deux blocs ci-dessous vérifient la règle, puis
 * qu'elle est réellement appliquée au moment de naviguer.
 */

/** La réponse que renverrait `/api/auth/login` pour un gestionnaire ordinaire. */
const REPONSE_LOGIN = {
  accessToken: 'jeton',
  refreshToken: 'rafraichissement',
  user: { id: 'u1', email: 'a@b.c', role: 'MANAGER', fleetId: 'f1' },
};

/** Monte la page avec un `returnUrl` donné, et rend l'espion de navigation. */
function monter(returnUrl: string | null) {
  TestBed.resetTestingModule();
  /* eslint-disable @typescript-eslint/no-empty-function */
  TestBed.configureTestingModule({
    imports: [LoginComponent],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: convertToParamMap(returnUrl ? { returnUrl } : {}) },
          queryParamMap: of(convertToParamMap(returnUrl ? { returnUrl } : {})),
          params: of({}),
        },
      },
      {
        provide: AuthService,
        useValue: {
          setSession: () => {},
          isDepot: () => false,
          isDriver: () => false,
          isWatchman: () => false,
        },
      },
      { provide: PreferencesService, useValue: { load: () => {} } },
      { provide: RealtimeService, useValue: { connect: () => {} } },
      { provide: ThemeService, useValue: { init: () => {} } },
    ],
  });
  /* eslint-enable @typescript-eslint/no-empty-function */

  const fixture = TestBed.createComponent(LoginComponent);
  const router = TestBed.inject(Router);
  const naviguer = spyOn(router, 'navigateByUrl').and.resolveTo(true);
  spyOn(window, 'fetch').and.resolveTo(
    { ok: true, json: () => Promise.resolve(REPONSE_LOGIN) } as unknown as Response,
  );
  return { fixture, naviguer };
}

/** Joue une connexion réussie et rend l'adresse vers laquelle on est parti. */
async function ouAtterrit(returnUrl: string | null): Promise<string> {
  const { fixture, naviguer } = monter(returnUrl);
  // `onSubmit` est protégé — on passe par l'instance, comme le ferait le clic sur le bouton.
  await (fixture.componentInstance as unknown as { onSubmit(): Promise<void> }).onSubmit();

  expect(naviguer).toHaveBeenCalledTimes(1);
  return naviguer.calls.mostRecent().args[0] as string;
}

describe('retourSur — ce qui mérite d’être reporté après une connexion', () => {
  it('une entrée profonde est retenue, query comprise', () => {
    expect(retourSur('/vehicles/v1?tab=reports&trip=t1&alert=a1'))
      .toBe('/vehicles/v1?tab=reports&trip=t1&alert=a1');
  });

  it('le lien du rapport hebdomadaire aussi, avec sa période', () => {
    expect(retourSur('/reports?from=2026-09-01&to=2026-09-08'))
      .toBe('/reports?from=2026-09-01&to=2026-09-08');
  });

  it('une adresse externe est refusée — redirection ouverte', () => {
    expect(retourSur('https://ailleurs.example/vol')).toBeNull();
  });

  it('« // » aussi, malgré sa barre de tête', () => {
    // `//ailleurs.example` est une URL relative au protocole : le navigateur y va vraiment.
    expect(retourSur('//ailleurs.example/vol')).toBeNull();
  });

  it('« /\\ » aussi — la même, écrite à l’envers', () => {
    // Plusieurs navigateurs normalisent l'antislash en barre avant de résoudre l'adresse.
    expect(retourSur('/\\ailleurs.example/vol')).toBeNull();
  });

  it('« /login » est refusé — sinon se connecter renvoie à la connexion', () => {
    expect(retourSur('/login?returnUrl=/login')).toBeNull();
  });

  it('la racine non plus : elle écraserait la destination par rôle', () => {
    expect(retourSur('/')).toBeNull();
  });

  it('ni le vide, ni l’absence', () => {
    expect(retourSur('')).toBeNull();
    expect(retourSur(null)).toBeNull();
    expect(retourSur(undefined)).toBeNull();
  });
});

describe('Connexion — la page suit vraiment le retour', () => {
  it('après connexion, on repart vers l’adresse demandée', async () => {
    expect(await ouAtterrit('/vehicles/v1?tab=reports&trip=t1&alert=a1'))
      .toBe('/vehicles/v1?tab=reports&trip=t1&alert=a1');
  });

  it('le bouton du rapport hebdomadaire mène à sa période', async () => {
    expect(await ouAtterrit('/reports?from=2026-09-01&to=2026-09-08'))
      .toBe('/reports?from=2026-09-01&to=2026-09-08');
  });

  it('⚠️ un retour externe est IGNORÉ : on va à la destination du rôle', async () => {
    // C'est le test qui compte : refuser en théorie ne sert à rien si on navigue quand même.
    expect(await ouAtterrit('https://ailleurs.example/vol')).toBe('/dashboard');
  });

  it('« /login » ne boucle pas : on va au tableau de bord', async () => {
    expect(await ouAtterrit('/login')).toBe('/dashboard');
  });

  it('sans paramètre, la destination par défaut joue', async () => {
    expect(await ouAtterrit(null)).toBe('/dashboard');
  });
});
