import { UserRole } from '@prisma/client';
import { AiUsageService } from './ai-usage.service';

/**
 * ══ C3 points 4 et 5 (2026-09-05) — LES ÉCHECS SONT DES LIGNES, ET LA PAGE EST JUSTE ═══
 *
 * Relevé de production : `ai_usage_logs` n'avait JAMAIS porté une ligne `ok = false` — trois
 * jours de compte Anthropic à sec (03-04/09) sans une trace sur la page « Coûts IA » ; le taux
 * USD→€ valait 0,92 en dur (marché ≈ 0,86) ; le jour du tableau de tendance était tronqué en UTC
 * alors que le filtre « jour » de la page est en heure de Paris.
 *
 * Ce qui est verrouillé ici : ce que `recordFailure` écrit (coût réel quand le fournisseur a
 * facturé, estimation sinon), ce que `summary` compte à part, ce que le budget IGNORE, d'où
 * vient le taux, et la forme des requêtes qui portent ces règles.
 */

type Aggregate = { _count: { _all: number }; _sum: Record<string, number | null | undefined> };

function build(over: {
  budgetRow?: { id: string; monthlyBudgetEur: number; usdToEurRate: number | null; updatedAt: Date } | null;
  aggregate?: (args: { where?: Record<string, unknown>; _sum?: Record<string, boolean> }) => Aggregate;
  groupBy?: (args: { by: string[]; where?: Record<string, unknown> }) => unknown[];
  count?: number;
  findMany?: unknown[];
} = {}) {
  const created: Record<string, unknown>[] = [];
  let budgetRow = over.budgetRow === undefined
    ? { id: 'b1', monthlyBudgetEur: 10, usdToEurRate: 0.86, updatedAt: new Date('2026-09-05T08:00:00Z') }
    : over.budgetRow;
  const prisma = {
    aiUsageLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; }),
      aggregate: jest.fn(async (args: { where?: Record<string, unknown>; _sum?: Record<string, boolean> }) =>
        over.aggregate ? over.aggregate(args) : { _count: { _all: 0 }, _sum: { costUsd: 0.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 } }),
      count: jest.fn(async () => over.count ?? 0),
      groupBy: jest.fn(async (args: { by: string[]; where?: Record<string, unknown> }) => (over.groupBy ? over.groupBy(args) : [])),
      findMany: jest.fn(async () => over.findMany ?? []),
    },
    aiBudget: {
      findFirst: jest.fn(async () => budgetRow),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { budgetRow = { ...budgetRow!, ...data } as never; return budgetRow; }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { budgetRow = { id: 'b-new', updatedAt: new Date(), usdToEurRate: 0.86, monthlyBudgetEur: 0, ...data } as never; return budgetRow; }),
    },
    fleet: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    user: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  };
  const systemActivity = { record: jest.fn() };
  const ownerVis = { isMasked: () => false, getOwnerIds: async () => [] };
  const svc = new AiUsageService(prisma as never, systemActivity as never, ownerVis as never);
  return { svc, prisma, created, systemActivity };
}

const USAGE_TRONQUE = { inputTokens: 100, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 };

describe('AiUsageService.recordFailure — un échec est une ligne', () => {
  it('sans usage (refus avant réponse) : costUsd 0, estimation = jetons d’entrée × prix d’entrée, ok=false, resultCount 0', async () => {
    const { svc, created } = build();
    await svc.recordFailure({
      action: 'agenda_agent', userId: 'u1', fleetId: 'f1', provider: 'claude', model: 'claude-sonnet-5',
      errorKind: 'provider_unfunded', errorDetail: 'Your credit balance is too low', latencyMs: 320,
      estimatedInputTokens: 1000,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      executor: 'api', ok: false, resultCount: 0, userId: 'u1', fleetId: 'f1', provider: 'claude',
      model: 'claude-sonnet-5', action: 'agenda_agent', errorKind: 'provider_unfunded',
      errorDetail: 'Your credit balance is too low', latencyMs: 320,
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
      // ⚠️ L'argent réel : rien n'a été facturé.
      costUsd: 0,
    });
    // 1 000 jetons × 2 $/M (Sonnet 5, page officielle du 05/09) = 0,002 $ — une estimation.
    expect(created[0]['estimatedCostUsd']).toBeCloseTo(0.002, 9);
  });

  it('avec usage (réponse tronquée, facturée) : costUsd = coût RÉEL des jetons, et l’estimation vaut ce coût', async () => {
    const { svc, created } = build();
    await svc.recordFailure({
      action: 'activity_report', provider: 'claude', model: 'claude-sonnet-5',
      errorKind: 'truncated', errorDetail: 'max_tokens', usage: USAGE_TRONQUE, estimatedInputTokens: 99_999,
    });
    // (100 × 2 + 500 × 10) / 1 000 000 = 0,0052 $ — de l'argent, pas une estimation.
    expect(created[0]['costUsd']).toBeCloseTo(0.0052, 9);
    expect(created[0]['estimatedCostUsd']).toBeCloseTo(0.0052, 9);
    expect(created[0]).toMatchObject({ inputTokens: 100, outputTokens: 500, ok: false });
  });

  it('le motif est borné à 400 caractères ; vide → null', async () => {
    const { svc, created } = build();
    await svc.recordFailure({ action: 'x', provider: 'gpt', model: 'gpt-4.1', errorKind: 'http', errorDetail: 'a'.repeat(1000) });
    await svc.recordFailure({ action: 'x', provider: 'gpt', model: 'gpt-4.1', errorKind: 'http', errorDetail: '   ' });
    expect((created[0]['errorDetail'] as string).length).toBe(400);
    expect(created[1]['errorDetail']).toBeNull();
  });

  it('le plafond mensuel (refus avant tout moteur) s’écrit sans fournisseur', async () => {
    const { svc, created } = build();
    await svc.recordFailure({ action: 'trip_analysis', provider: null, model: 'claude-sonnet-5', errorKind: 'quota', errorDetail: 'Plafond', estimatedInputTokens: 10 });
    expect(created[0]).toMatchObject({ provider: null, errorKind: 'quota', ok: false });
  });

  it('passe par le même entonnoir Système (FAILURE), sauf le rapport d’activité', async () => {
    const { svc, systemActivity } = build();
    await svc.recordFailure({ action: 'placement', provider: 'claude', model: 'claude-sonnet-5', errorKind: 'quota' });
    expect(systemActivity.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'AI', action: 'ai_placement', status: 'FAILURE' }));
    systemActivity.record.mockClear();
    await svc.recordFailure({ action: 'activity_report', provider: 'claude', model: 'claude-sonnet-5', errorKind: 'quota' });
    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  it('ne lève jamais : une base en panne se journalise, l’appel métier continue', async () => {
    const { svc, prisma } = build();
    prisma.aiUsageLog.create.mockRejectedValue(new Error('DB down'));
    await expect(svc.recordFailure({ action: 'x', provider: 'claude', model: 'm', errorKind: 'http' })).resolves.toBeUndefined();
  });
});

describe('AiUsageService.summary — les échecs comptés à part', () => {
  const RATE = 0.86;

  function monde() {
    return build({
      aggregate: (args) => {
        if (args.where?.['ok'] === false) return { _count: { _all: 3 }, _sum: { estimatedCostUsd: 0.03 } };
        // Appels FACTURÉS : même agrégat que le dénominateur du « coût par appel » — 6 appels
        // pour 0,80 $, contre 1 $ toutes lignes confondues (les 0,20 $ restants sont le coût
        // RÉEL d'échecs facturés, que le dénominateur exclut : revue C3 du 2026-09-05).
        if (args.where?.['executor'] === 'api' && args.where?.['ok'] === true) {
          return { _count: { _all: 6 }, _sum: { costUsd: 0.8 } };
        }
        return { _count: { _all: 10 }, _sum: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, costUsd: 1 } };
      },
      groupBy: (args) => {
        if (args.by[0] === 'action' && args.where?.['ok'] === false) return [{ action: 'trip_analysis', _count: { _all: 3 } }];
        if (args.by[0] === 'action') {
          return [
            { action: 'trip_analysis', _count: { _all: 8 }, _sum: { inputTokens: 800, outputTokens: 400, costUsd: 0.8, resultCount: 5 } },
            { action: 'placement', _count: { _all: 2 }, _sum: { inputTokens: 200, outputTokens: 100, costUsd: 0.2, resultCount: null } },
          ];
        }
        return [];
      },
    });
  }

  it('failedCalls, failedEstimatedCost (≈) et billedCalls sont exposés ; totalCalls reste toutes les lignes', async () => {
    const { svc } = monde();
    const s = await svc.summary('2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z');
    expect(s.totalCalls).toBe(10);
    expect(s.billedCalls).toBe(6);
    expect(s.failedCalls).toBe(3);
    expect(s.failedEstimatedCostUsd).toBeCloseTo(0.03, 9);
    expect(s.failedEstimatedCostEur).toBeCloseTo(0.03 * RATE, 9);
    expect(s.totalCacheWriteTokens).toBe(50);
    expect(s.usdToEurRate).toBe(RATE);
  });

  it('chaque action porte son nombre d’échecs, et l’assistance a un libellé', async () => {
    const { svc } = monde();
    const s = await svc.summary();
    const trajets = s.byAction.find((r) => r.key === 'trip_analysis');
    expect(trajets?.failed).toBe(3);
    expect(s.byAction.find((r) => r.key === 'placement')?.failed).toBe(0);
  });

  it('billedCalls compte les lignes executor=api ET ok=true — les seules facturées', async () => {
    const { svc, prisma } = monde();
    await svc.summary();
    expect(prisma.aiUsageLog.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ executor: 'api', ok: true }),
    }));
  });

  /**
   * ⚠️ Le « coût par appel » divise deux grandeurs du MÊME ensemble. `totalCostUsd` compte aussi
   * le coût réel des échecs facturés (réponse tronquée, refus après lecture) : le diviser par les
   * seuls appels réussis gonflait le chiffre (revue C3 du 2026-09-05).
   */
  it('le coût des appels FACTURÉS est exposé à part du coût total', async () => {
    const { svc } = monde();
    const s = await svc.summary();
    expect(s.totalCostUsd).toBe(1);
    expect(s.billedCostUsd).toBeCloseTo(0.8, 9);
    expect(s.billedCostEur).toBeCloseTo(0.8 * RATE, 9);
  });

  it('⚠️ le jour de la tendance est tronqué en heure de PARIS, depuis une colonne UTC', async () => {
    const { svc, prisma } = monde();
    await svc.summary();
    const sql = ((prisma.$queryRaw.mock.calls as unknown as unknown[][])[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain(`date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris')`);
  });

  it('les libellés connaissent support_chat et place_analysis', async () => {
    const { svc } = build({
      groupBy: (args) => (args.by[0] === 'action' && args.where?.['ok'] !== false
        ? [
            { action: 'support_chat', _count: { _all: 1 }, _sum: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, resultCount: 1 } },
            { action: 'place_analysis', _count: { _all: 1 }, _sum: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, resultCount: 1 } },
          ]
        : []),
    });
    const s = await svc.summary();
    expect(s.byAction.map((r) => r.label).sort()).toEqual(['Analyse de lieu', 'Assistance (chat)']);
    expect(s.byAction.find((r) => r.key === 'support_chat')?.resultatsLibelle).toBe('réponses rédigées');
  });
});

describe('AiUsageService — encart « absorbé »', () => {
  it('ne compte que les appels locaux RÉUSSIS ; coût EXACT depuis les jetons quand la ligne en porte', async () => {
    const { svc, prisma } = build({
      groupBy: (args) => {
        if (args.by.includes('model')) {
          expect(args.where).toMatchObject({ executor: 'local', ok: true });
          return [
            { action: 'trip_analysis', model: 'claude-sonnet-4-6', _count: { _all: 2 }, _sum: { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 28_000, resultCount: 2 } },
            { action: 'place_analysis', model: 'sonnet', _count: { _all: 3 }, _sum: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, resultCount: 3 } },
          ];
        }
        if (args.by[0] === 'action' && (args.where as { executor?: string })?.executor === 'api') {
          return [{ action: 'place_analysis', _avg: { costUsd: 0.01 } }];
        }
        return [];
      },
    });
    const s = await svc.summary();
    const abs = s.absorbed!;
    expect(abs.localCalls).toBe(5);
    expect(abs.callsWithTokens).toBe(2);
    expect(abs.callsEstimated).toBe(3);
    // Sonnet 4.6 : (1000 × 3 + 500 × 15 + 28 000 × 0,3) / 1e6 = 0,0189 $ exact + 3 × 0,01 $ estimés.
    expect(abs.estimatedCostUsd).toBeCloseTo(0.0189 + 0.03, 9);
    expect(abs.actionsSansReference).toEqual([]);
    // La référence de repli est bornée aux 90 DERNIERS JOURS, pas à toute l'histoire.
    const ref = prisma.aiUsageLog.groupBy.mock.calls.find((c) => (c[0] as { where?: { executor?: string } }).where?.executor === 'api')![0] as unknown as { where: { createdAt: { gte: Date } } };
    const age = Date.now() - ref.where.createdAt.gte.getTime();
    expect(age).toBeGreaterThan(89 * 24 * 3_600_000);
    expect(age).toBeLessThan(91 * 24 * 3_600_000);
  });
});

describe('AiUsageService — budget et taux', () => {
  it('⚠️ le budget ne somme que costUsd (l’argent réel) : jamais estimatedCostUsd', async () => {
    const { svc, prisma } = build();
    const b = await svc.getBudget({ isOwner: true });
    const agg = prisma.aiUsageLog.aggregate.mock.calls[0][0] as { _sum: Record<string, boolean> };
    expect(agg._sum).toEqual({ costUsd: true });
    expect(b.spentThisMonthUsd).toBe(0.5);
    expect(b.spentThisMonthEur).toBeCloseTo(0.5 * 0.86, 9);
  });

  it('monthBudgetExhausted compare la dépense RÉELLE en euros au plafond', async () => {
    // 0,5 $ × 0,86 = 0,43 € contre 10 € : loin du plafond.
    const { svc } = build();
    expect(await svc.monthBudgetExhausted()).toBe(false);
    const { svc: serre } = build({ budgetRow: { id: 'b', monthlyBudgetEur: 0.4, usdToEurRate: 0.86, updatedAt: new Date() } });
    expect(await serre.monthBudgetExhausted()).toBe(true);
  });

  it('le taux vient de ai_budget.usdToEurRate', async () => {
    const { svc } = build({ budgetRow: { id: 'b', monthlyBudgetEur: 0, usdToEurRate: 0.91, updatedAt: new Date() } });
    expect((await svc.getBudget()).usdToEurRate).toBe(0.91);
    // Et le chemin synchrone, une fois le cache chaud, rend la même valeur.
    expect(svc.eurRate()).toBe(0.91);
  });

  it('sans ligne de budget : repli sur AI_USD_TO_EUR, sinon 0,86 (plus jamais 0,92 en dur)', async () => {
    const avant = process.env.AI_USD_TO_EUR;
    try {
      delete process.env.AI_USD_TO_EUR;
      expect((await build({ budgetRow: null }).svc.getBudget()).usdToEurRate).toBe(0.86);
      process.env.AI_USD_TO_EUR = '0.9';
      expect((await build({ budgetRow: null }).svc.getBudget()).usdToEurRate).toBe(0.9);
    } finally {
      if (avant === undefined) delete process.env.AI_USD_TO_EUR;
      else process.env.AI_USD_TO_EUR = avant;
    }
  });

  it('setBudget accepte le taux (0,5..1,5), le persiste et invalide le cache', async () => {
    const { svc, prisma } = build();
    expect((await svc.getBudget()).usdToEurRate).toBe(0.86);
    const b = await svc.setBudget({ monthlyBudgetEur: 12, usdToEurRate: 0.9 }, 'u1', { isOwner: true });
    expect(prisma.aiBudget.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: expect.objectContaining({ monthlyBudgetEur: 12, usdToEurRate: 0.9 }) });
    expect(b.usdToEurRate).toBe(0.9);
    expect(b.monthlyBudgetEur).toBe(12);
  });

  it('un taux hors bornes (faute de frappe) est ignoré : le taux enregistré ne bouge pas', async () => {
    const { svc, prisma } = build();
    await svc.setBudget({ monthlyBudgetEur: 12, usdToEurRate: 8.6 }, 'u1');
    const data = (prisma.aiBudget.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('usdToEurRate');
  });

  it('setBudget sans taux ne touche pas au taux', async () => {
    const { svc, prisma } = build();
    await svc.setBudget({ monthlyBudgetEur: 5 }, 'u1');
    const data = (prisma.aiBudget.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('usdToEurRate');
    expect(data).toMatchObject({ monthlyBudgetEur: 5 });
  });
});

describe('AiUsageService.logs — le journal des échecs', () => {
  const ligne = (over: Record<string, unknown>) => ({
    id: 'l1', createdAt: new Date('2026-09-05T10:00:00Z'), userId: null, fleetId: null, model: 'claude-sonnet-5', action: 'agenda_agent',
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, latencyMs: 200, ok: true, executor: 'api',
    provider: null, errorKind: null, errorDetail: null, estimatedCostUsd: null, resultCount: null, ...over,
  });

  it('« échecs seulement » filtre sur ok=false', async () => {
    const { svc, prisma } = build();
    await svc.logs({ onlyFailed: true, action: 'agenda_agent' });
    expect(prisma.aiUsageLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ok: false, action: 'agenda_agent' }) }));
  });

  it('un échec sans jeton est marqué ESTIMÉ (≈) ; un échec facturé (jetons) ne l’est pas', async () => {
    const { svc } = build({
      findMany: [
        ligne({ id: 'a', ok: false, provider: 'claude', errorKind: 'provider_unfunded', errorDetail: 'credit', estimatedCostUsd: 0.002 }),
        ligne({ id: 'b', ok: false, provider: 'claude', errorKind: 'truncated', inputTokens: 100, outputTokens: 500, costUsd: 0.0052, estimatedCostUsd: 0.0052 }),
      ],
    });
    const page = await svc.logs({}, { role: UserRole.SUPER_ADMIN });
    expect(page.rows[0]).toMatchObject({ ok: false, estime: true, errorKind: 'provider_unfunded', errorDetail: 'credit', provider: 'claude', estimatedCostUsd: 0.002 });
    expect(page.rows[0].estimatedCostEur).toBeCloseTo(0.002 * 0.86, 9);
    expect(page.rows[1]).toMatchObject({ ok: false, estime: false, errorKind: 'truncated' });
  });

  /**
   * ⚠️ TRK-061 avait retiré le texte du fournisseur (« Your credit balance is too low… ») de ce que
   * lit un client, pour le réserver au centre d'alerte — un écran de super-admin. Le journal des
   * coûts, lui, est ouvert aux administrateurs de société : ils voient la SORTE de l'échec, jamais
   * la phrase du sous-traitant (revue C3 du 2026-09-05).
   */
  it('⚠️ le motif BRUT du fournisseur n’est servi qu’au super-admin', async () => {
    const { svc } = build({
      findMany: [ligne({ id: 'a', ok: false, errorKind: 'provider_unfunded', errorDetail: 'Your credit balance is too low' })],
    });
    const admin = await svc.logs({}, { role: UserRole.FLEET_ADMIN });
    expect(admin.rows[0].errorDetail).toBeNull();
    // La sorte, elle, reste : l'écran nomme l'échec sans citer personne.
    expect(admin.rows[0].errorKind).toBe('provider_unfunded');
    const owner = await svc.logs({}, { role: UserRole.SUPER_ADMIN });
    expect(owner.rows[0].errorDetail).toBe('Your credit balance is too low');
  });

  it('un succès n’a ni sorte ni estimation, et son fournisseur est déduit du modèle quand la colonne est vide', async () => {
    const { svc } = build({
      findMany: [
        ligne({ id: 'a', model: 'sonnet', executor: 'local' }),
        ligne({ id: 'b', model: 'gpt-4.1-2025-04-14' }),
        ligne({ id: 'c', model: 'claude-sonnet-5', provider: 'gpt' }),
      ],
    });
    const page = await svc.logs({});
    expect(page.rows[0]).toMatchObject({ provider: 'claude', executor: 'local', estime: false, estimatedCostUsd: null, errorKind: null });
    expect(page.rows[1].provider).toBe('gpt');
    // Une colonne renseignée prime sur la déduction.
    expect(page.rows[2].provider).toBe('gpt');
  });
});
