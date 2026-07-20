import { ErrorRateWatchdogService, WATCHDOG_SOURCE } from './error-rate-watchdog.service';

/**
 * Vigie de saturation du centre d'alerte. Ce qui est protégé ici :
 *  1. on prévient AU-DESSUS du seuil, pas en dessous (sinon l'alerte devient du bruit) ;
 *  2. **pas de boucle de rétroaction** — les erreurs de la vigie elle-même sont exclues du comptage ;
 *  3. un seul e-mail par heure pendant une tempête ;
 *  4. un envoi qui échoue ne pose PAS le cooldown (sinon on serait muet une heure pour rien) ;
 *  5. la vigie ne lève jamais (elle tourne dans le scheduler).
 */
describe('ErrorRateWatchdogService', () => {
  const T0 = new Date('2026-07-20T09:00:00Z').getTime();

  function build(rows: { source: string; level: string; n: number }[], over: { sendOk?: boolean; threshold?: string } = {}) {
    const prisma = {
      errorLog: {
        groupBy: jest.fn().mockResolvedValue(rows.map((r) => ({ source: r.source, level: r.level, _count: { _all: r.n } }))),
      },
    };
    const email = {
      send: jest.fn().mockResolvedValue({ ok: over.sendOk ?? true }),
      buildErrorRateAlertEmail: jest.fn().mockReturnValue('<html></html>'),
    };
    const config = {
      get: jest.fn().mockImplementation((k: string) => (k === 'ERROR_RATE_ALERT_THRESHOLD' ? over.threshold : undefined)),
    };
    const svc = new ErrorRateWatchdogService(prisma as never, email as never, config as never);
    return { svc, prisma, email, config };
  }

  beforeEach(() => jest.clearAllMocks());

  it("n'envoie RIEN sous le seuil (5 erreurs = pas d'alerte)", async () => {
    const { svc, email } = build([{ source: 'gps-integrity', level: 'ERROR', n: 5 }]);
    await svc.check(T0);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('alerte au-dessus du seuil, avec le total et les sources responsables', async () => {
    const { svc, email } = build([
      { source: 'engine-control', level: 'ERROR', n: 21 },
      { source: 'sms-gateway', level: 'ERROR', n: 18 },
      { source: 'gps-integrity', level: 'CRITICAL', n: 8 },
    ]);

    await svc.check(T0);

    expect(email.buildErrorRateAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 47,
        critical: 8,
        threshold: 5,
        top: [
          { source: 'engine-control', count: 21 },
          { source: 'sms-gateway', count: 18 },
          { source: 'gps-integrity', count: 8 },
        ],
      }),
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'contact@vizyoagency.com', template: 'error_rate_alert' }),
    );
  });

  it('EXCLUT ses propres erreurs du comptage (pas de boucle de rétroaction)', async () => {
    const { svc, prisma } = build([{ source: 'engine-control', level: 'ERROR', n: 9 }]);
    await svc.check(T0);
    expect(prisma.errorLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: { not: WATCHDOG_SOURCE } }) }),
    );
  });

  it("n'envoie qu'UN e-mail par heure pendant une tempête", async () => {
    const { svc, email } = build([{ source: 'engine-control', level: 'ERROR', n: 900 }]);

    await svc.check(T0);
    await svc.check(T0 + 10 * 60 * 1000); // 10 min plus tard, ça déborde toujours
    await svc.check(T0 + 30 * 60 * 1000);

    expect(email.send).toHaveBeenCalledTimes(1);

    await svc.check(T0 + 61 * 60 * 1000); // au-delà d'une heure : on redonne signe de vie
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it("un envoi EN ÉCHEC ne pose pas le cooldown (sinon on serait muet une heure)", async () => {
    const { svc, email } = build([{ source: 'engine-control', level: 'ERROR', n: 40 }], { sendOk: false });

    await svc.check(T0);
    await svc.check(T0 + 10 * 60 * 1000);

    expect(email.send).toHaveBeenCalledTimes(2); // on retente
  });

  it('respecte un seuil personnalisé par variable d\'environnement', async () => {
    const { svc, email } = build([{ source: 'x', level: 'ERROR', n: 12 }], { threshold: '20' });
    await svc.check(T0);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('ne lève JAMAIS, même si la base est indisponible', async () => {
    const { svc, prisma, email } = build([]);
    prisma.errorLog.groupBy.mockRejectedValue(new Error('DB down'));

    await expect(svc.check(T0)).resolves.toBeUndefined();
    expect(email.send).not.toHaveBeenCalled();
  });
});
