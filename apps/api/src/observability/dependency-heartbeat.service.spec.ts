import { DependencyHeartbeatService } from './dependency-heartbeat.service';

/**
 * Sonde active des dépendances. Ce qui est protégé ici :
 *  1. on ne sonde QUE ce qui est configuré (pas d'alerte fantôme sur une dépendance absente) ;
 *  2. un échec ISOLÉ ne réveille personne (anti-flapping) — il en faut deux d'affilée ;
 *  3. un **404** compte comme injoignable : c'est EXACTEMENT l'incident du 2026-07 (Vizyo Auth
 *     sain mais sans route Traefik → 404 sur tout) ;
 *  4. un rétablissement remet le compteur à zéro (sinon deux pannes espacées d'une semaine
 *     déclencheraient une alerte au premier hoquet) ;
 *  5. la sonde ne lève JAMAIS (elle tourne dans le scheduler).
 */
describe('DependencyHeartbeatService', () => {
  function build(env: Record<string, string | undefined>) {
    const config = { get: jest.fn().mockImplementation((k: string) => env[k]) };
    const errorLogger = { recordBackground: jest.fn(), record: jest.fn() };
    const svc = new DependencyHeartbeatService(config as never, errorLogger as never);
    return { svc, errorLogger, config };
  }

  const reachable = { ok: true, status: 200 };
  const traefik404 = { ok: false, status: 404 };

  function mockFetch(impl: jest.Mock) {
    (global as unknown as { fetch: unknown }).fetch = impl;
    return impl;
  }

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
  });

  it('ne sonde que les dépendances configurées (et normalise le slash final)', async () => {
    const fetchMock = mockFetch(jest.fn().mockResolvedValue(reachable));
    const { svc } = build({ VIZYO_AUTH_API_URL: 'https://api.auth.vizyoagency.com/' }); // texto absent

    await svc.check();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.auth.vizyoagency.com/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it("une dépendance qui répond n'écrit RIEN au centre d'alerte", async () => {
    mockFetch(jest.fn().mockResolvedValue(reachable));
    const { svc, errorLogger } = build({ VIZYO_AUTH_API_URL: 'https://api.auth.x' });

    await svc.check();
    await svc.check();

    expect(errorLogger.recordBackground).not.toHaveBeenCalled();
  });

  it("un échec ISOLÉ n'alerte pas ; deux consécutifs alertent en CRITICAL", async () => {
    mockFetch(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { svc, errorLogger } = build({ VIZYO_AUTH_API_URL: 'https://api.auth.x' });

    await svc.check();
    expect(errorLogger.recordBackground).not.toHaveBeenCalled();

    await svc.check();
    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    const [error, source, context, level] = errorLogger.recordBackground.mock.calls[0];
    expect(source).toBe('dependency:vizyo-auth');
    expect(level).toBe('CRITICAL');
    expect(context).toMatchObject({ consecutiveFailures: 2 });
    expect((error as Error).message).toContain('injoignable');
  });

  it('un 404 compte comme injoignable (incident Traefik 2026-07)', async () => {
    mockFetch(jest.fn().mockResolvedValue(traefik404));
    const { svc, errorLogger } = build({ VIZYO_AUTH_API_URL: 'https://api.auth.x' });

    await svc.check();
    await svc.check();

    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    expect(errorLogger.recordBackground.mock.calls[0][1]).toBe('dependency:vizyo-auth');
  });

  it('un rétablissement remet le compteur à zéro', async () => {
    mockFetch(
      jest
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(reachable)
        .mockRejectedValueOnce(new Error('down')),
    );
    const { svc, errorLogger } = build({ VIZYO_AUTH_API_URL: 'https://api.auth.x' });

    await svc.check(); // 1er échec
    await svc.check(); // rétabli → compteur remis à 0
    await svc.check(); // échec isolé de nouveau

    expect(errorLogger.recordBackground).not.toHaveBeenCalled();
  });

  it('sonde les DEUX dépendances quand les deux sont configurées', async () => {
    const fetchMock = mockFetch(jest.fn().mockResolvedValue(reachable));
    const { svc } = build({
      VIZYO_AUTH_API_URL: 'https://api.auth.x',
      VIZYO_TEXTO_URL: 'https://texto.x',
    });

    await svc.check();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.auth.x/health',
      'https://texto.x/health',
    ]);
  });

  it('ne lève JAMAIS, même si fetch explose', async () => {
    mockFetch(
      jest.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    );
    const { svc } = build({ VIZYO_AUTH_API_URL: 'https://api.auth.x' });

    await expect(svc.check()).resolves.toBeUndefined();
  });
});
