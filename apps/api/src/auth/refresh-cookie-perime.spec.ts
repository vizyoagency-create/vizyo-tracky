import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN COOKIE DE RAFRAÎCHISSEMENT PÉRIMÉ NE DOIT PLUS COÛTER LA SESSION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `POST /auth/refresh` lisait `req.cookies['tracky_rt'] ?? dto.refreshToken` : le corps ne
 * servait QUE si le cookie était absent, jamais s'il était périmé.
 *
 * Or LE JETON DE RAFRAÎCHISSEMENT TOURNE À CHAQUE APPEL. Vizyo Auth en rend un neuf, qu'on
 * repose en cookie ET que le client conserve de son côté. Il suffit d'UNE rotation perdue en
 * route — un onglet qui rafraîchit pendant qu'un autre dort, une réponse qui n'arrive pas,
 * une écriture de cookie bloquée — pour que les deux divergent. À partir de là le cookie est
 * mort pour toujours, le client en détient un valide, et le serveur refuse sans jamais le
 * regarder.
 *
 * L'utilisateur ne peut rien y faire : `tracky_rt` est httpOnly, il ne sait ni le lire ni
 * l'effacer. Il se reconnecte, encore et encore.
 *
 * C'est le jumeau exact du défaut corrigé dans `JwtAuthGuard` — même écriture, même piège.
 */
describe('POST /auth/refresh — le cookie a la priorité, pas le monopole', () => {
  const RESULTAT = { accessToken: 'at-neuf', refreshToken: 'rt-neuf' };

  /** Un client Vizyo Auth qui n'accepte QUE les jetons listés. */
  function client(valides: string[]) {
    return {
      refresh: jest.fn(async (t: string) => {
        if (!valides.includes(t)) throw new UnauthorizedException('Refresh token refusé');
        return RESULTAT;
      }),
    };
  }

  function reponse() {
    return { cookie: jest.fn(), clearCookie: jest.fn() } as never;
  }

  function requete(cookie?: string) {
    return { cookies: cookie ? { tracky_rt: cookie } : {} } as never;
  }

  function controleur(valides: string[]) {
    const authClient = client(valides);
    // Six dépendances, dont une seule compte ici : le client Vizyo Auth.
    const ctrl = new AuthController(
      {} as never, authClient as never, {} as never,
      {} as never, {} as never, {} as never,
    );
    return { ctrl, authClient };
  }

  it('cookie PÉRIMÉ + corps valide : la session est sauvée', async () => {
    // Le cas vécu : une rotation perdue, un cookie httpOnly mort que le navigateur ne peut
    // pas retirer, et un client qui détient pourtant de quoi continuer.
    const { ctrl, authClient } = controleur(['rt-du-client']);

    const r = await ctrl.refresh({ refreshToken: 'rt-du-client' }, requete('rt-perime'), reponse());

    expect(r).toEqual(RESULTAT);
    expect(authClient.refresh).toHaveBeenNthCalledWith(1, 'rt-perime');
    expect(authClient.refresh).toHaveBeenNthCalledWith(2, 'rt-du-client');
  });

  it('cookie VALIDE : il reste prioritaire, le corps n’est pas essayé', async () => {
    // Le témoin du mode nominal — sans lui, on ne saurait pas si la priorité tient encore.
    const { ctrl, authClient } = controleur(['rt-cookie']);

    await ctrl.refresh({ refreshToken: 'rt-du-client' }, requete('rt-cookie'), reponse());

    expect(authClient.refresh).toHaveBeenCalledTimes(1);
    expect(authClient.refresh).toHaveBeenCalledWith('rt-cookie');
  });

  it('LES DEUX refusés : la requête échoue — le repli n’accepte rien de neuf', async () => {
    // L'assertion de sécurité. Les deux jetons partent au MÊME client, qui reste seul juge.
    const { ctrl } = controleur(['un-autre']);

    await expect(ctrl.refresh({ refreshToken: 'aussi-mort' }, requete('mort'), reponse()))
      .rejects.toThrow(/Refresh token refusé/);
  });

  it('aucun des deux : 400, et le message ne change pas', async () => {
    const { ctrl } = controleur([]);

    await expect(ctrl.refresh({}, requete(), reponse())).rejects.toThrow(BadRequestException);
  });

  it('corps seul (client SDK, pas de cookie) : inchangé', async () => {
    const { ctrl, authClient } = controleur(['rt-sdk']);

    await ctrl.refresh({ refreshToken: 'rt-sdk' }, requete(), reponse());

    expect(authClient.refresh).toHaveBeenCalledTimes(1);
  });

  it('cookie et corps IDENTIQUES et refusés : un seul appel, pas deux', async () => {
    // Sans ce garde, chaque refus doublerait les appels à Vizyo Auth — et un service
    // d'authentification qui compte les tentatives finirait par verrouiller le compte.
    const { ctrl, authClient } = controleur([]);

    await expect(ctrl.refresh({ refreshToken: 'meme' }, requete('meme'), reponse())).rejects.toThrow();

    expect(authClient.refresh).toHaveBeenCalledTimes(1);
  });
});
