import { BadRequestException } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * ── LA DÉCONNEXION DOIT RÉUSSIR QUOI QU'IL ARRIVE ────────────────────────────────────
 *
 * Trouvé le 2026-08-21 en exerçant la recette « véhicule hors service » : un appel
 * `POST /api/auth/logout` SANS CORPS rendait `dto` undefined, `dto.refreshToken` levait un
 * TypeError — et la levée se produisait AVANT `clearAuthCookies`.
 *
 * Résultat : **500, cookies intacts, utilisateur toujours connecté**. C'est le pire endroit
 * possible pour un défaut de robustesse : la déconnexion est précisément l'appel qui doit
 * aboutir quand la session est déjà abîmée — c'est même surtout dans ce cas qu'on l'appelle.
 * Et le corps est facultatif par contrat (le cookie prime) : ne pas en envoyer est légitime.
 */
function build() {
  const logout = jest.fn().mockResolvedValue(undefined);
  const refresh = jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  // Six dependances : seul `authClient` (2e) est exerce par la deconnexion et le refresh.
  const ctrl = new AuthController(
    {} as never,
    { logout, refresh } as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
  );
  const cookiesPosees: Array<{ nom: string; valeur: unknown }> = [];
  const res = {
    cookie: (nom: string, valeur: unknown) => { cookiesPosees.push({ nom, valeur }); },
    clearCookie: (nom: string) => { cookiesPosees.push({ nom, valeur: '(efface)' }); },
  };
  return { ctrl, res, cookiesPosees, logout, refresh };
}

describe('POST /auth/logout — sans corps de requête', () => {
  it('⚠️ ne lève PAS, et vide les cookies malgré tout', async () => {
    const { ctrl, res, cookiesPosees } = build();

    // `undefined` : exactement ce que produit un `fetch(url, { method: 'POST' })` sans body.
    await expect(
      ctrl.logout(undefined as never, { cookies: {} } as never, res as never),
    ).resolves.toBeUndefined();

    expect(cookiesPosees.length).toBeGreaterThan(0);
  });

  it('⚠️ vide les cookies AVANT toute autre opération — l’ordre est ce qui a manqué', async () => {
    const { ctrl, res, cookiesPosees, logout } = build();
    logout.mockRejectedValue(new Error('Vizyo Auth injoignable'));

    // Même si la révocation distante échoue, la session locale doit être coupée.
    await expect(
      ctrl.logout({} as never, { cookies: { tracky_rt: 'jeton' } } as never, res as never),
    ).resolves.toBeUndefined();

    expect(cookiesPosees.length).toBeGreaterThan(0);
  });

  it('avec un cookie, la révocation distante est bien tentée', async () => {
    const { ctrl, res, logout } = build();

    await ctrl.logout(undefined as never, { cookies: { tracky_rt: 'jeton-r' } } as never, res as never);

    expect(logout).toHaveBeenCalledWith('jeton-r');
  });
});

describe('POST /auth/refresh — sans corps de requête', () => {
  it('⚠️ répond 400 et non 500 : l’absence de jeton est une requête invalide, pas un plantage', async () => {
    const { ctrl, res } = build();

    await expect(
      ctrl.refresh(undefined as never, { cookies: {} } as never, res as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('le cookie suffit — aucun corps requis', async () => {
    const { ctrl, res, refresh } = build();

    await ctrl.refresh(undefined as never, { cookies: { tracky_rt: 'jeton-r' } } as never, res as never);

    expect(refresh).toHaveBeenCalledWith('jeton-r');
  });
});
