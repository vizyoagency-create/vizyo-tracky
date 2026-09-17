import { ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ManagerClientService } from './manager-client.service';

/**
 * TRACKY → VIZYO MANAGER : la création d'un client, signée comme Manager l'attend.
 *
 * Ce qu'on verrouille : la SIGNATURE (le garde `InternalHmacGuard` de Manager recalcule
 * HMAC-SHA256(secret, `${timestamp}.${body}`) sur le corps EXACT), l'inactivité tant que
 * `MANAGER_INTERNAL_URL` est vide, et le refus de rattacher une flotte que Manager n'a pas rendue.
 */
const SECRET = 'secret-tracky-dans-vizyo-auth';

function service(env: Record<string, string | undefined>) {
  const config = { get: (k: string) => env[k] } as never;
  return new ManagerClientService(config);
}

const DONNEES = {
  companyName: 'Garage Martin', email: 'marc@legrand.fr', contactFirstName: 'Marc', contactLastName: 'Legrand',
  phone: '+33612345678', externalRef: 'book-1',
};

describe('ManagerClientService', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => { global.fetch = fetchOriginal; });

  it('non configuré : `estConfigure` est faux, la création est refusée en 503, et le secours prérempli existe', async () => {
    const svc = service({ VIZYO_AUTH_APP_SECRET: SECRET, MANAGER_WEB_URL: 'https://manager.vizyoagency.com/' });
    expect(svc.estConfigure()).toBe(false);
    await expect(svc.creerClient(DONNEES)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(svc.urlNouveauClient({ companyName: 'Garage Martin', email: 'marc@legrand.fr', phone: '+33612345678' }))
      .toBe('https://manager.vizyoagency.com/admin/clients/new?companyName=Garage+Martin&email=marc%40legrand.fr&tracky=1&phone=%2B33612345678');
  });

  it('configuré : POST /internal/clients signé (X-App-Id tracky, HMAC du `${timestamp}.${corps}`), et la flotte rendue est rattachée', async () => {
    const svc = service({ VIZYO_AUTH_APP_SECRET: SECRET, MANAGER_INTERNAL_URL: 'https://manager-api.vizyoagency.com/' });
    expect(svc.estConfigure()).toBe(true);
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ clientId: 'cli-1', trackyFleetId: 'fleet-1' }) });
    global.fetch = fetchMock as never;

    await expect(svc.creerClient(DONNEES)).resolves.toEqual({ clientId: 'cli-1', trackyFleetId: 'fleet-1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://manager-api.vizyoagency.com/internal/clients');
    expect(init.method).toBe('POST');
    expect(init.headers['X-App-Id']).toBe('tracky');
    const attendu = createHmac('sha256', SECRET).update(`${init.headers['X-App-Timestamp']}.${init.body}`).digest('hex');
    expect(init.headers['X-App-Signature']).toBe(attendu);
    expect(JSON.parse(init.body)).toEqual(expect.objectContaining({
      companyName: 'Garage Martin', email: 'marc@legrand.fr', trackyEnabled: true, origin: 'tracky-rdv', externalRef: 'book-1',
    }));
  });

  it('Manager refuse (4xx) : son message remonte en 503, rien n’est rattaché', async () => {
    const svc = service({ VIZYO_AUTH_APP_SECRET: SECRET, MANAGER_INTERNAL_URL: 'https://manager-api.vizyoagency.com' });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'E-mail déjà utilisé' }) }) as never;
    await expect(svc.creerClient(DONNEES)).rejects.toThrow('E-mail déjà utilisé');
  });

  it('Manager crée le client mais ne rend pas de flotte : 503 explicite — jamais de demi-client rattaché', async () => {
    const svc = service({ VIZYO_AUTH_APP_SECRET: SECRET, MANAGER_INTERNAL_URL: 'https://manager-api.vizyoagency.com' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ clientId: 'cli-1', trackyFleetId: null }) }) as never;
    await expect(svc.creerClient(DONNEES)).rejects.toThrow(/Activer Tracky/);
  });

  it('Manager injoignable : 503, avec la sortie manuelle', async () => {
    const svc = service({ VIZYO_AUTH_APP_SECRET: SECRET, MANAGER_INTERNAL_URL: 'https://manager-api.vizyoagency.com' });
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    await expect(svc.creerClient(DONNEES)).rejects.toThrow(/ne répond pas/);
  });
});
