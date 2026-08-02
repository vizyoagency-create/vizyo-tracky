import { UnauthorizedException } from '@nestjs/common';
import { AuthClientService } from './auth-client.service';
import type { Env } from '../config/env.validation';

/**
 * Ces tests verrouillent LA distinction qui a casse la gestion des utilisateurs
 * en production : Vizyo Auth expose DEUX identifiants d'application qui ne sont
 * pas interchangeables.
 *
 *   publicId (`app_xxx`)  -> en-tete X-App-Id
 *   cuid interne (`cm...`) -> chemins /v1/apps/:appId/...
 *
 * Cote Vizyo Auth, `AppGuard` resout l'en-tete via findByPublicId() et pose
 * `req.appEntity` (dont `.id` est le cuid interne) ; `checkAppAccess()` compare
 * ensuite ce cuid au parametre d'URL. Passer le publicId dans le chemin renvoie
 * un 403 « Access denied: you can only access users of your own application »,
 * qui fait croire a un probleme de droits alors que c'est un probleme
 * d'identifiant.
 *
 * Verifie en production le 2026-08-02 sur l'API reelle :
 *   GET /v1/apps/app_36170036c6e545b6/users        -> 403
 *   GET /v1/apps/cmnu688d80000okkrkxtw46o7/users   -> 200
 */

const API_URL = 'http://vizyo-auth-api:3200';
const PUBLIC_ID = 'app_publicid0000';
const INTERNAL_ID = 'cminternalid0000';
const APP_SECRET = 'secret-de-test-suffisamment-long';

function createService() {
  const config = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        VIZYO_AUTH_API_URL: API_URL,
        VIZYO_AUTH_APP_ID: PUBLIC_ID,
        VIZYO_AUTH_APP_INTERNAL_ID: INTERNAL_ID,
        VIZYO_AUTH_APP_SECRET: APP_SECRET,
      };
      return map[key];
    }),
  } as unknown as import('@nestjs/config').ConfigService<Env, true>;

  return new AuthClientService(config);
}

/** Capture l'URL et les en-tetes du dernier fetch, et renvoie `body`. */
function mockFetch(status = 200, body: unknown = {}) {
  const spy = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

function lastCall(spy: jest.Mock): { url: string; headers: Record<string, string> } {
  const [url, init] = spy.mock.calls[spy.mock.calls.length - 1];
  return { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
}

describe('AuthClientService — publicId vs cuid interne', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('les routes /v1/apps/:appId/... utilisent le cuid INTERNE', () => {
    it.each([
      ['suspendUser', (s: AuthClientService) => s.suspendUser('u1')],
      ['activateUser', (s: AuthClientService) => s.activateUser('u1')],
      ['removeUserFromApp', (s: AuthClientService) => s.removeUserFromApp('u1')],
      ['listAppUsers', (s: AuthClientService) => s.listAppUsers()],
    ])('%s', async (_name, call) => {
      const spy = mockFetch(200, { users: [] });
      await call(createService());

      const { url } = lastCall(spy);
      expect(url).toContain(`/v1/apps/${INTERNAL_ID}/users`);
      // Le publicId dans le chemin = le 403 de production.
      expect(url).not.toContain(`/v1/apps/${PUBLIC_ID}/`);
    });
  });

  it("l'en-tete X-App-Id porte le publicId, jamais le cuid interne", async () => {
    const spy = mockFetch(200, { users: [] });
    await createService().listAppUsers();

    const { headers } = lastCall(spy);
    expect(headers['X-App-Id']).toBe(PUBLIC_ID);
    expect(headers['X-App-Id']).not.toBe(INTERNAL_ID);
  });

  it('les routes /v1/auth/... ne portent aucun identifiant d\'application', async () => {
    const spy = mockFetch(200, { accessToken: 'a', refreshToken: 'r' });
    await createService().login('a@b.c', 'pw');

    const { url } = lastCall(spy);
    expect(url).toBe(`${API_URL}/v1/auth/login`);
  });

  it('un 403 upstream reste une UnauthorizedException (pas de silence)', async () => {
    mockFetch(403, { error: { code: 'INTERNAL', message: 'Access denied' } });
    await expect(createService().suspendUser('u1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthClientService — signature HMAC', () => {
  afterEach(() => jest.restoreAllMocks());

  it("signe une chaine vide sur un GET (le AppGuard calcule sur '' quand il n'y a pas de body)", async () => {
    const spy = mockFetch(200, { users: [] });
    await createService().listAppUsers();

    const { headers } = lastCall(spy);
    const { createHmac } = await import('crypto');
    const expected = createHmac('sha256', APP_SECRET)
      .update(`${headers['X-App-Timestamp']}.`)
      .digest('hex');

    expect(headers['X-App-Signature']).toBe(expected);
  });

  it('signe exactement le body envoye sur un DELETE (body {} explicite)', async () => {
    const spy = mockFetch(204);
    await createService().removeUserFromApp('u1');

    const [, init] = spy.mock.calls[0];
    const { headers } = lastCall(spy);
    const { createHmac } = await import('crypto');
    const expected = createHmac('sha256', APP_SECRET)
      .update(`${headers['X-App-Timestamp']}.${init?.body}`)
      .digest('hex');

    // Si la signature et le body envoye divergent, Vizyo Auth renvoie 401.
    expect(init?.body).toBe('{}');
    expect(headers['X-App-Signature']).toBe(expected);
  });
});
