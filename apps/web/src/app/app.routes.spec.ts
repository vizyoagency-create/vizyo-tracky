import type { Route } from '@angular/router';
import { routes } from './app.routes';

/**
 * ── Ce que ces tests VERROUILLENT (audit du 2026-08-03) ──────────────────────────────
 *
 * La route `/users` — qui affiche noms, e-mails, téléphones et rôles de tous les membres
 * d'une flotte — n'avait AUCUNE garde, alors que sa voisine immédiate `/users/overview`
 * en avait une. Il suffisait de taper l'URL.
 *
 * Le défaut est resté invisible parce qu'un SECOND défaut le couvrait : l'API refusait
 * bien la requête (403), mais l'écran avalait l'erreur en silence et affichait « Aucun
 * utilisateur dans votre flotte ». À l'écran, une garde absente ressemblait donc à une
 * flotte vide — pas à une fuite. Deux défauts qui se cachaient l'un l'autre.
 *
 * ⚠️ Ces tests inspectent la STRUCTURE des routes, pas leur comportement : c'est
 * volontaire. Le défaut n'était pas une garde qui laissait passer, c'était une garde
 * ABSENTE — et une absence ne se teste qu'en la cherchant.
 */
describe('app.routes — gardes des écrans sensibles', () => {
  /** Aplatit l'arbre en « chemin complet → route », en suivant les enfants. */
  function flatten(rs: Route[], prefix = ''): Map<string, Route> {
    const out = new Map<string, Route>();
    for (const r of rs) {
      const full = [prefix, r.path ?? ''].filter((p) => p !== '').join('/');
      out.set(full, r);
      if (r.children) for (const [k, v] of flatten(r.children, full)) out.set(k, v);
    }
    return out;
  }

  const all = flatten(routes);

  function route(path: string): Route {
    const r = all.get(path);
    expect(r).withContext(`route ${path} introuvable`).toBeDefined();
    return r!;
  }

  it('/users est gardée (c était LE défaut : elle ne l était pas)', () => {
    expect(route('users').canActivate?.length ?? 0).toBeGreaterThan(0);
  });

  it('/users/overview est gardée (elle l a toujours été — la référence)', () => {
    expect(route('users/overview').canActivate?.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * Écrans qui exposent des données personnelles ou du pilotage plateforme.
   * En ajouter un ici est le geste à faire quand on crée une page sensible.
   */
  const SENSIBLES = [
    'users',
    'users/overview',
    'admin/partner-links',
    'integrations',
    'admin/security',
  ];

  for (const path of SENSIBLES) {
    it(`/${path} refuse de s ouvrir sans garde`, () => {
      const r = route(path);
      expect(r.canActivate?.length ?? 0)
        .withContext(
          `/${path} affiche des données sensibles et n'a aucun canActivate. ` +
            `Une garde côté API ne suffit pas : l'écran s'affiche quand même, et son ` +
            `état d'erreur ressemble à un écran vide.`,
        )
        .toBeGreaterThan(0);
    });
  }

  it('toutes les routes admin/* sont gardées, sans exception', () => {
    // Balaie l'existant ET le futur : une nouvelle page admin sans garde casse ici.
    const nues = [...all.entries()]
      .filter(([p, r]) => p.startsWith('admin/') && r.loadComponent)
      .filter(([, r]) => (r.canActivate?.length ?? 0) === 0)
      .map(([p]) => p);
    expect(nues).withContext(`routes admin sans canActivate : ${nues.join(', ')}`).toEqual([]);
  });
});
