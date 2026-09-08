import { ErrorRateWatchdogService } from './error-rate-watchdog.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UNE ERREUR CRITIQUE SUFFIT — LA VIGIE NE REGARDE PLUS SEULEMENT LE DÉBIT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Décision du 2026-09-08. La vigie du centre d'alerte ne prévenait qu'au-dessus de cinq
 * erreurs dans l'heure. Un passage d'automatisation tué, un agent local muet, une base
 * injoignable écrivent UNE ligne CRITICAL — et personne n'était prévenu tant que quatre
 * autres erreurs ne suivaient pas. Mesuré en production le 2026-09-07 : « Passage manqué :
 * agent-limites-vitesse » à 18:50, aucun e-mail.
 *
 * Ce qui est protégé ici :
 *  1. une seule erreur critique prévient, sous le seuil ;
 *  2. le détail ne cite que les sources critiques ;
 *  3. un e-mail par heure au plus, avec son PROPRE refroidissement ;
 *  4. l'e-mail de saturation, qui cite déjà les critiques, n'est pas doublé dix minutes après ;
 *  5. un envoi en échec ne pose pas le refroidissement ;
 *  6. `ERROR_CRITICAL_ALERT=off` coupe cette vigie seule.
 */
describe('Vigie du centre d\'alerte — erreurs critiques', () => {
  const T0 = new Date('2026-09-08T00:30:00Z').getTime();
  type Ligne = { source: string; level: string; n: number };

  const refroidissementAvecMemoire = () => {
    const memoire = new Map<string, number>();
    return {
      tenterEmission: jest.fn(async (cle: string, fenetreMs: number) => {
        const precedent = memoire.get(cle);
        if (precedent !== undefined && Date.now() - precedent < fenetreMs) return false;
        memoire.set(cle, Date.now());
        return true;
      }),
      derniereEmission: jest.fn(async (cle: string) => {
        const t = memoire.get(cle);
        return t === undefined ? null : new Date(t);
      }),
      marquerEmission: jest.fn(async (cle: string, quand?: Date) => { memoire.set(cle, quand ? quand.getTime() : Date.now()); }),
      oublier: jest.fn(async (cle: string) => { memoire.delete(cle); }),
    } as never;
  };

  const comptage = (lignes: Ligne[]) => lignes.map((r) => ({ source: r.source, level: r.level, _count: { _all: r.n } }));

  function build(lignes: Ligne[], over: { sendOk?: boolean; critiques?: string } = {}) {
    const prisma = { errorLog: { groupBy: jest.fn().mockResolvedValue(comptage(lignes)) } };
    const email = {
      send: jest.fn().mockResolvedValue({ ok: over.sendOk ?? true }),
      buildErrorRateAlertEmail: jest.fn().mockReturnValue('<html>saturation</html>'),
      buildCriticalErrorAlertEmail: jest.fn().mockReturnValue('<html>critique</html>'),
    };
    const config = {
      get: jest.fn().mockImplementation((k: string) => (k === 'ERROR_CRITICAL_ALERT' ? over.critiques : undefined)),
    };
    const svc = new ErrorRateWatchdogService(prisma as never, email as never, config as never, refroidissementAvecMemoire());
    return { svc, prisma, email };
  }

  beforeEach(() => jest.clearAllMocks());

  it('🔴 UNE erreur critique prévient, même seule et loin sous le seuil de débit', async () => {
    const { svc, email } = build([{ source: 'trip-automation', level: 'CRITICAL', n: 1 }]);

    await svc.check(T0);

    expect(email.buildCriticalErrorAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ critical: 1, total: 1, top: [{ source: 'trip-automation', count: 1 }] }),
    );
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'contact@vizyoagency.com',
        template: 'critical_error_alert',
        subject: '1 erreur critique — trip-automation',
      }),
    );
    // Ce n'est PAS l'e-mail de saturation : le seuil n'est pas franchi.
    expect(email.buildErrorRateAlertEmail).not.toHaveBeenCalled();
  });

  it('🔴 le détail ne cite que les sources critiques ; les autres erreurs restent au compte total', async () => {
    const { svc, email } = build([
      { source: 'gps-integrity', level: 'ERROR', n: 3 },
      { source: 'agents-locaux', level: 'CRITICAL', n: 1 },
    ]);

    await svc.check(T0);

    expect(email.buildCriticalErrorAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ critical: 1, total: 4, top: [{ source: 'agents-locaux', count: 1 }] }),
    );
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: '1 erreur critique — agents-locaux' }));
  });

  it('🔴 un seul e-mail par heure, puis on redonne signe de vie', async () => {
    const { svc, email } = build([{ source: 'trip-automation', level: 'CRITICAL', n: 2 }]);

    await svc.check(T0);
    await svc.check(T0 + 10 * 60 * 1000);
    await svc.check(T0 + 30 * 60 * 1000);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ subject: '2 erreurs critiques — trip-automation' }));

    await svc.check(T0 + 61 * 60 * 1000);
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it("🔴 l'e-mail de saturation cite déjà les critiques : pas de second e-mail dix minutes plus tard", async () => {
    const { svc, prisma, email } = build([]);
    prisma.errorLog.groupBy
      // 47 erreurs dont 8 critiques : la saturation parle.
      .mockResolvedValueOnce(comptage([
        { source: 'engine-control', level: 'ERROR', n: 39 },
        { source: 'gps-integrity', level: 'CRITICAL', n: 8 },
      ]))
      // Dix minutes plus tard, la tempête est passée mais deux critiques restent dans l'heure.
      .mockResolvedValueOnce(comptage([{ source: 'gps-integrity', level: 'CRITICAL', n: 2 }]));

    await svc.check(T0);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'error_rate_alert' }));

    await svc.check(T0 + 10 * 60 * 1000);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.buildCriticalErrorAlertEmail).not.toHaveBeenCalled();
  });

  it('un envoi EN ÉCHEC ne pose pas le refroidissement : on retente à la fenêtre suivante', async () => {
    const { svc, email } = build([{ source: 'trip-automation', level: 'CRITICAL', n: 1 }], { sendOk: false });

    await svc.check(T0);
    await svc.check(T0 + 10 * 60 * 1000);

    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('ERROR_CRITICAL_ALERT=off coupe cette vigie sans toucher à celle de saturation', async () => {
    const muette = build([{ source: 'trip-automation', level: 'CRITICAL', n: 1 }], { critiques: 'off' });
    await muette.svc.check(T0);
    expect(muette.email.send).not.toHaveBeenCalled();

    const saturee = build([{ source: 'engine-control', level: 'ERROR', n: 40 }], { critiques: 'off' });
    await saturee.svc.check(T0);
    expect(saturee.email.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'error_rate_alert' }));
  });

  it("sous le seuil et sans critique : toujours le silence (l'alerte doit rester rare)", async () => {
    const { svc, email } = build([{ source: 'gps-integrity', level: 'ERROR', n: 3 }]);
    await svc.check(T0);
    expect(email.send).not.toHaveBeenCalled();
  });
});
