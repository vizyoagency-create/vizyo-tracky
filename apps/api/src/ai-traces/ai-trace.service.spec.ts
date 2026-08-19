import { AiTraceService } from './ai-trace.service';

/**
 * Conservation des couples (entrée, sortie) IA.
 *
 * Trois propriétés sont verrouillées ici, et aucune ne concerne le contenu des traces :
 *   1. archiver ne doit JAMAIS casser le travail utile ;
 *   2. un payload tronqué doit le DIRE — un JSON coupé en silence passerait pour la donnée réelle ;
 *   3. le plafond est par ACTION, pas global : une action rare ne doit pas disparaître sous le
 *      volume d'une action fréquente.
 */
describe('AiTraceService', () => {
  function build(opts: { echecCreate?: boolean; trop?: number } = {}) {
    const prisma = {
      aiAgentTrace: {
        create: opts.echecCreate
          ? jest.fn().mockRejectedValue(new Error('base indisponible'))
          : jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: opts.trop ?? 0 }, (_, i) => ({ id: `vieux-${i}` })),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: opts.trop ?? 0 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    return { svc: new AiTraceService(prisma as never), prisma };
  }

  const base = { action: 'trip_analysis', input: { a: 1 }, output: { b: 2 }, verdict: 'concluant' as const };

  // ─── Archiver ne casse jamais le travail utile ─────────────────────────────

  it('ne lève pas quand l\'écriture échoue', async () => {
    const { svc } = build({ echecCreate: true });
    // Faire échouer un récit de trajet parce que son archivage a raté serait absurde : on
    // perdrait le travail utile pour sauver son commentaire.
    await expect(svc.record(base)).resolves.toBeUndefined();
  });

  it('écrit la trace AVANT d\'élaguer', async () => {
    const { svc, prisma } = build({ trop: 3 });
    const ordre: string[] = [];
    prisma.aiAgentTrace.create.mockImplementation(async () => { ordre.push('create'); return {}; });
    prisma.aiAgentTrace.deleteMany.mockImplementation(async () => { ordre.push('delete'); return { count: 3 }; });
    await svc.record(base);
    // L'inverse perdrait la trace pour cause de ménage raté.
    expect(ordre).toEqual(['create', 'delete']);
  });

  // ─── Un payload tronqué le DIT ─────────────────────────────────────────────

  it('marque un payload trop gros au lieu de le couper en silence', async () => {
    const { svc, prisma } = build();
    const enorme = { texte: 'x'.repeat(80_000) };
    await svc.record({ ...base, input: enorme });
    const ecrit = prisma.aiAgentTrace.create.mock.calls[0][0].data.input as Record<string, unknown>;
    // Un JSON coupé au milieu serait illisible et, pire, passerait pour la donnée réelle.
    expect(ecrit.tronque).toBe(true);
    expect(ecrit.tailleOriginale).toBeGreaterThan(80_000);
    expect(typeof ecrit.apercu).toBe('string');
  });

  it('laisse intact un payload qui tient dans le plafond', async () => {
    const { svc, prisma } = build();
    await svc.record({ ...base, input: { question: 'courte' } });
    expect(prisma.aiAgentTrace.create.mock.calls[0][0].data.input).toEqual({ question: 'courte' });
  });

  it('survit à un payload non sérialisable', async () => {
    const { svc, prisma } = build();
    const cyclique: Record<string, unknown> = {};
    cyclique['moi'] = cyclique;
    await expect(svc.record({ ...base, input: cyclique })).resolves.toBeUndefined();
    expect((prisma.aiAgentTrace.create.mock.calls[0][0].data.input as Record<string, unknown>).tronque).toBe(true);
  });

  // ─── Le plafond est par action ─────────────────────────────────────────────

  it('n\'élague que l\'action concernée, et garde les 200 plus récentes', async () => {
    const { svc, prisma } = build({ trop: 5 });
    await svc.record({ ...base, action: 'activity_report' });
    const req = prisma.aiAgentTrace.findMany.mock.calls[0][0];
    // Une purge par ancienneté effacerait intégralement les traces d'une action rare —
    // précisément celle dont on a le moins d'exemples et le plus besoin.
    expect(req.where).toEqual({ action: 'activity_report' });
    expect(req.skip).toBe(200);
    expect(req.orderBy).toEqual({ createdAt: 'desc' });
    expect(prisma.aiAgentTrace.deleteMany).toHaveBeenCalled();
  });

  it('ne supprime rien quand le plafond n\'est pas atteint', async () => {
    const { svc, prisma } = build({ trop: 0 });
    await svc.record(base);
    expect(prisma.aiAgentTrace.deleteMany).not.toHaveBeenCalled();
  });

  // ─── Champs ────────────────────────────────────────────────────────────────

  it('retient le verdict, le motif et l\'exécutant', async () => {
    const { svc, prisma } = build();
    await svc.record({ ...base, verdict: 'rejete', verdictNote: 'schema non respecte', executor: 'local' });
    expect(prisma.aiAgentTrace.create.mock.calls[0][0].data).toMatchObject({
      verdict: 'rejete', verdictNote: 'schema non respecte', executor: 'local',
    });
  });

  it('retombe sur `api` quand l\'exécutant n\'est pas précisé', async () => {
    const { svc, prisma } = build();
    await svc.record(base);
    // Même règle que pour les coûts : un oubli compte comme une dépense, jamais comme du gratuit.
    expect(prisma.aiAgentTrace.create.mock.calls[0][0].data.executor).toBe('api');
  });

  it('un appel en échec conserve son entrée et son message, sans sortie', async () => {
    const { svc, prisma } = build();
    await svc.record({ action: 'trip_analysis', input: { a: 1 }, error: 'timeout', verdict: 'rejete' });
    const d = prisma.aiAgentTrace.create.mock.calls[0][0].data;
    // C'est le cas le PLUS utile a rejouer : on garde l'entree meme sans reponse.
    expect(d.input).toEqual({ a: 1 });
    expect(d.error).toBe('timeout');
  });
});
