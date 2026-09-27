import { BackgroundTasksService, RECALAGE_DIFFERE } from './background-tasks.service';

/**
 * ── T83 bis (2026-09-27) — LE RYTHME DE RATTRAPAGE NE DOIT PAS COMPTER LE FLUX COURANT ──────
 *
 * L'écran d'arriéré avait été écrit POUR corriger « un compteur n'est pas un débit » (deux stocks
 * soustraits à 24 h d'écart, qui soustraient silencieusement les nouveaux arrivants). Il a
 * reproduit la faute d'un cran plus loin : compter TOUS les tracés recalés en 24 h inclut les
 * trajets neufs, recalés à leur création, qui n'ont jamais fait reculer l'arriéré.
 *
 * Mesuré en production le 27/09 : **463/jour comptés, 367/jour de vrai rattrapage** (+26 %) —
 * une échéance annoncée à ~19 jours pour ~24 jours réels.
 *
 * Ces tests verrouillent l'exclusion. Si quelqu'un revient au `count` naïf, `$queryRaw` n'est
 * plus appelé du tout et le premier test tombe.
 */
describe("BackgroundTasksService — le rythme de rattrapage des tracés", () => {
  function monter(opts: { restant?: number; plusAncien?: Date | null; rythme?: number }) {
    const $queryRaw = jest.fn(async () => [{ n: BigInt(opts.rythme ?? 367) }]);
    const prisma: Record<string, unknown> = {
      $queryRaw,
      trip: {
        count: jest.fn().mockResolvedValue(opts.restant ?? 8798),
        aggregate: jest.fn().mockResolvedValue({ _min: { endedAt: opts.plusAncien ?? new Date('2026-04-15T06:00:00Z') } }),
      },
      tripAnalysis: { count: jest.fn().mockResolvedValue(0) },
      tripAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
      agendaAgentSettings: { findMany: jest.fn().mockResolvedValue([]) },
      placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      speedLimitCache: {
        aggregate: jest.fn().mockResolvedValue({ _max: { createdAt: null } }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
    const svc = new BackgroundTasksService(
      prisma as never,
      registry as never,
      { resteRecitTotal: async () => ({ aNarrer: 0, enAttenteDeRecalcul: 0, libelle: 'analyses sans récit' }) } as never,
    );
    return { svc, prisma, $queryRaw };
  }

  async function traces(svc: BackgroundTasksService) {
    const res = await svc.list();
    const ligne = res.rattrapages?.find((r) => r.id === 'recalage-traces');
    expect(ligne).toBeDefined();
    return ligne!;
  }

  it('⚠️ le rythme EXCLUT les trajets recalés à leur création — sinon il mesure le flux, pas le rattrapage', async () => {
    const { svc, $queryRaw } = monter({ rythme: 367 });
    await traces(svc);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [fragments, ...valeurs] = $queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    const sql = fragments.join(' ? ');
    // La fenêtre de 24 h est conservée : une moyenne plus longue masquerait un arrêt de deux jours.
    expect(sql).toMatch(/"polylineMatchedAt"\s*>=\s*now\(\)\s*-\s*interval\s*'24 hours'/);
    // Et c'est l'écart fin-du-trajet → recalage qui sépare le rattrapage du flux courant.
    expect(sql).toMatch(/"polylineMatchedAt"\s*-\s*"endedAt"\s*>/);
    expect(valeurs).toEqual([RECALAGE_DIFFERE]);
  });

  it('le nombre rendu par la requête est celui affiché — aucun recalcul en route', async () => {
    const { svc } = monter({ rythme: 367 });
    expect((await traces(svc)).parJour).toBe(367);
  });

  it('un rythme nul se dit 0, pas null : « rien ne bouge » n’est pas « on ne sait pas »', async () => {
    const { svc } = monter({ rythme: 0 });
    expect((await traces(svc)).parJour).toBe(0);
  });

  it('une requête qui échoue n’emporte pas l’écran qu’elle supervise', async () => {
    const { svc, prisma } = monter({});
    (prisma['$queryRaw'] as jest.Mock).mockRejectedValue(new Error('relation "trips" does not exist'));
    const res = await svc.list();
    // La ligne des tracés disparaît (best-effort), mais la page répond et garde les autres.
    expect(res.rattrapages?.some((r) => r.id === 'recalage-traces')).toBe(false);
    expect(res.tasks.length).toBeGreaterThan(0);
  });

  it("l'arriéré et son ancienneté viennent bien du stock, pas du rythme", async () => {
    const { svc } = monter({ restant: 8798, plusAncien: new Date('2026-04-15T06:00:00Z') });
    const ligne = await traces(svc);
    expect(ligne.restant).toBe(8798);
    expect(ligne.plusAncien).toBe('2026-04-15T06:00:00.000Z');
  });
});
