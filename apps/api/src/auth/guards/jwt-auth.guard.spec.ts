import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ACCESS_COOKIE_NAME, JwtAuthGuard } from './jwt-auth.guard';
import type { AuthService } from '../auth.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE COOKIE A LA PRIORITÉ, PAS LE MONOPOLE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le guard s'écrivait `cookieToken ?? headerToken`. Le repli ne servait donc QUE si le
 * cookie était ABSENT, jamais s'il était INUTILISABLE — alors que le commentaire du fichier
 * annonce deux modes qui « cohabitent » pendant la migration.
 *
 * Le cas qui fait mal : `tracky_at` est httpOnly. Un navigateur qui en détient un périmé,
 * tronqué, ou signé avec un secret d'avant un redéploiement ne peut NI le lire NI le
 * supprimer. Le client rafraîchit son jeton, le renvoie dans l'en-tête… et le serveur
 * refuse quand même, sans jamais le regarder. La session est morte pour l'utilisateur alors
 * que tout ce qu'il faut pour l'authentifier voyage dans la requête.
 *
 * ⚠️ CE LOT N'ÉLARGIT AUCUNE CONFIANCE, et c'est ce que le dernier test fige : les deux
 * jetons traversent la MÊME vérification. Un en-tête invalide reste refusé.
 */
describe('JwtAuthGuard — le repli sur l’en-tête quand le cookie ne vaut rien', () => {
  const UTILISATEUR = { id: 'u-1', email: 'a@b.c' };

  /** Un contexte Nest réduit à ce que le guard en lit. */
  function contexte(cookie?: string, entete?: string): ExecutionContext {
    const req: Record<string, unknown> = {
      cookies: cookie ? { [ACCESS_COOKIE_NAME]: cookie } : {},
      headers: entete ? { authorization: 'Bearer ' + entete } : {},
    };
    return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  }

  /** Un service d'auth qui n'accepte QUE les jetons listés. */
  function auth(valides: string[]): AuthService {
    return {
      verifyAccessToken: (t: string) => {
        if (!valides.includes(t)) throw new UnauthorizedException('Invalid or expired token');
        return { sub: 'auth-1' };
      },
      resolveLocalUser: async () => UTILISATEUR,
    } as unknown as AuthService;
  }

  it('cookie PÉRIMÉ + en-tête frais : la requête passe, sur le jeton de l’en-tête', async () => {
    // Le cas vécu : le navigateur détient un cookie httpOnly mort qu'il ne peut pas retirer,
    // et le client vient de rafraîchir. Sans le repli, cette requête était refusée.
    const guard = new JwtAuthGuard(auth(['frais']));
    const ctx = contexte('perime', 'frais');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('cookie VALIDE : il reste prioritaire, l’en-tête n’est même pas consulté', async () => {
    // Le témoin du mode nominal. Un service qui refuserait l'en-tête ne doit pas être
    // sollicité : si ce test tombait, la priorité du cookie serait perdue.
    const service = auth(['cookie-ok']);
    const espion = jest.spyOn(service, 'verifyAccessToken');
    const guard = new JwtAuthGuard(service);

    await expect(guard.canActivate(contexte('cookie-ok', 'entete-invalide'))).resolves.toBe(true);
    expect(espion).toHaveBeenCalledTimes(1);
    expect(espion).toHaveBeenCalledWith('cookie-ok');
  });

  it('aucun des deux : refus, et le message ne change pas', async () => {
    const guard = new JwtAuthGuard(auth([]));
    await expect(guard.canActivate(contexte())).rejects.toThrow(/Missing access token/);
  });

  it('LES DEUX INVALIDES : refus — le repli n’accepte rien de neuf', async () => {
    // L'assertion qui compte pour la sécurité. Le repli change l'ORDRE d'essai, jamais le
    // contrôle : `verifyAccessToken` reste seul juge, et il a dit non deux fois.
    const guard = new JwtAuthGuard(auth(['un-autre']));
    await expect(guard.canActivate(contexte('perime', 'aussi-perime')))
      .rejects.toThrow(/Invalid or expired token/);
  });

  it('en-tête seul (SDK, script) : inchangé, il passe toujours', async () => {
    // La compatibilité que le fichier promet depuis le Sprint 6.
    const guard = new JwtAuthGuard(auth(['jeton-sdk']));
    await expect(guard.canActivate(contexte(undefined, 'jeton-sdk'))).resolves.toBe(true);
  });

  it('cookie et en-tête IDENTIQUES et invalides : une seule vérification, pas deux', async () => {
    // Sans ce garde, un jeton mort partagé par les deux canaux ferait deux appels de
    // vérification par requête refusée — du bruit inutile sur un chemin déjà chaud.
    const service = auth([]);
    const espion = jest.spyOn(service, 'verifyAccessToken');
    const guard = new JwtAuthGuard(service);

    await expect(guard.canActivate(contexte('meme', 'meme'))).rejects.toThrow();
    expect(espion).toHaveBeenCalledTimes(1);
  });
});
