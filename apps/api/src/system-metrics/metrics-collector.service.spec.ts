import { MetricsCollectorService } from './metrics-collector.service';

/**
 * TRK-060 — ce que ces tests protègent : **le message, pas le mécanisme**.
 *
 * L'incident du 2026-09-02 était bénin (1 437 points sur 1 440 collectés, aucune récidive en
 * 49 h). Ce qui a coûté, c'est la ligne écrite au centre d'alerte : la pile de transport brute,
 * `getaddrinfo EAI_AGAIN tracky-postgres`, qui se lit « la base est tombée ».
 *
 * D'où le couple : on vérifie que la conséquence est nommée AVANT le motif technique, et que le
 * motif technique n'a pas disparu pour autant. Un correctif de message qui efface la preuve
 * technique ne serait pas un correctif — juste un écran plus propre.
 */

function build(over: { collectSnapshot?: jest.Mock; create?: jest.Mock; deleteMany?: jest.Mock } = {}) {
  const errorLogger = { record: jest.fn().mockResolvedValue('log-1') };
  const metrics = {
    collectSnapshot: over.collectSnapshot ?? jest.fn().mockResolvedValue({
      timestamp: Date.now(), loadAvg1: 1, loadAvg5: 1, loadAvg15: 1,
      cpuCount: 2, cpuPercent: 10, memUsedMb: 100, memTotalMb: 2000, dbSizeMb: 500,
    }),
  };
  const prisma = {
    systemMetric: {
      create: over.create ?? jest.fn().mockResolvedValue({}),
      deleteMany: over.deleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const svc = new MetricsCollectorService(metrics as never, prisma as never, errorLogger as never);
  return { svc, errorLogger, metrics, prisma };
}

/** Le message réellement archivé au centre d'alerte. */
const ligne = (errorLogger: { record: jest.Mock }) => String(errorLogger.record.mock.calls[0]?.[0] ?? '');

describe('MetricsCollectorService — TRK-060, ce que lit l’exploitant', () => {
  it('n’écrit RIEN au centre d’alerte quand la collecte réussit', async () => {
    const t = build();
    await t.svc.collect();
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('une résolution de nom en échec est nommée pour ce qu’elle est, pas pour une panne de base', async () => {
    const panne = new Error('\nInvalid `prisma.$queryRaw()` invocation:\n  getaddrinfo EAI_AGAIN tracky-postgres');
    const t = build({ collectSnapshot: jest.fn().mockRejectedValue(panne) });
    await t.svc.collect();

    const m = ligne(t.errorLogger);
    // La conséquence d'abord — elle tient en une phrase et elle est BORNÉE.
    expect(m).toContain('point de mesure système');
    expect(m).toContain("ce n'est pas une panne de la base");
    expect(m).toContain('rien d’autre n’est dégradé'.replace(/’/g, "'"));
    // Ce qui survit : sans ça, l'exploitant croit la courbe perdue.
    expect(m).toContain('la collecte reprend au passage suivant');
    // …et la preuve technique reste, en fin de phrase. On change l'ORDRE, on n'efface rien.
    expect(m).toContain('EAI_AGAIN');
  });

  it('TÉMOIN — une panne qui n’est PAS de résolution de nom ne prétend pas l’être', async () => {
    const t = build({ collectSnapshot: jest.fn().mockRejectedValue(new Error('column "cpu" does not exist')) });
    await t.svc.collect();

    const m = ligne(t.errorLogger);
    expect(m).not.toContain('résolution de nom');
    expect(m).toContain('column "cpu" does not exist');
  });

  it('la purge parle de la purge — un message générique enverrait chercher le mauvais cron', async () => {
    const t = build({ deleteMany: jest.fn().mockRejectedValue(new Error('deadlock detected')) });
    await t.svc.purge();

    const m = ligne(t.errorLogger);
    expect(m).toContain('purge des mesures système');
    expect(m).toContain('deadlock detected');
    expect(t.errorLogger.record.mock.calls[0][2]).toMatchObject({ geste: 'purge' });
  });

  it('le motif technique est BORNÉ — une pile bavarde ne doit pas noyer la ligne', async () => {
    const t = build({ collectSnapshot: jest.fn().mockRejectedValue(new Error('x'.repeat(5000))) });
    await t.svc.collect();
    expect(ligne(t.errorLogger).length).toBeLessThan(600);
  });
});
