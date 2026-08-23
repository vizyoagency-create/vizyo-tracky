import { BackgroundTasksService } from './background-tasks.service';

/**
 * TRK-043 — l'écran des tâches de fond et la garde des trajets doivent prédire le MÊME tick.
 *
 * L'ancien écran reproduisait l'arithmétique boguée (fin + 50 min) : après le correctif de la
 * garde, il aurait annoncé jusqu'à une heure de retard qui n'existe plus. Et « Actif · chaque
 * heure » n'affichait rien des ticks annulés — 10 disparitions par jour, invisibles.
 */
describe("BackgroundTasksService — la garde des trajets vue de l'écran (TRK-043)", () => {
  afterEach(() => jest.useRealTimers());

  function monter(opts: {
    lastRunAt?: Date | null;
    dernierDepart?: Date | null;
    ticksAnnules?: number;
    /** true = tables neuves ABSENTES du mock, comme dans les vieux specs à mock partiel. */
    mockPartiel?: boolean;
  }) {
    const prisma: Record<string, unknown> = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue({
          enabled: true, frequency: 'hourly', hour: 2,
          lastRunAt: opts.lastRunAt ?? null,
        }),
      },
      activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
      agendaAgentSettings: { findMany: jest.fn().mockResolvedValue([]) },
      placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      speedLimitCache: {
        aggregate: jest.fn().mockResolvedValue({ _max: { createdAt: null } }),
        count: jest.fn().mockResolvedValue(0),
      },
      tripAnalysis: { count: jest.fn().mockResolvedValue(0) },
    };
    if (!opts.mockPartiel) {
      prisma['tripAutomationRun'] = {
        findFirst: jest.fn().mockResolvedValue(opts.dernierDepart ? { startedAt: opts.dernierDepart } : null),
      };
      prisma['systemActivityLog'] = { count: jest.fn().mockResolvedValue(opts.ticksAnnules ?? 0) };
    }
    const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
    return new BackgroundTasksService(prisma as never, registry as never);
  }

  async function tacheTrip(svc: BackgroundTasksService) {
    const res = await svc.list();
    const t = res.tasks.find((x) => x.id === 'trip-automation');
    expect(t).toBeDefined();
    return t!;
  }

  it('🔑 nextRunAt est prédit depuis le DÉPART, pas depuis la fin', async () => {
    // Run réel : départ 10:45 Paris, fin 11:20 (35 min). Il est 11:30.
    // Depuis le DÉPART : 10:45 + 50 min = 11:35 → prochain :45 = 11:45 Paris = 09:45 UTC.
    // L'ancienne formule (fin 11:20 + 50 = 12:10 → 12:45) annonçait une heure de retard fictive.
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-08-24T11:30:00+02:00'));
    const svc = monter({
      lastRunAt: new Date('2026-08-24T11:20:00+02:00'),
      dernierDepart: new Date('2026-08-24T10:45:00+02:00'),
    });
    const t = await tacheTrip(svc);
    expect(t.nextRunAt).toBe('2026-08-24T09:45:00.000Z');
  });

  it("les ticks annulés s'affichent à côté de la cadence déclarée", async () => {
    const svc = monter({ ticksAnnules: 10 });
    const t = await tacheTrip(svc);
    expect(t.settingsSummary).toContain('10 tick(s) annulé(s) sur 24 h');
  });

  it('zéro tick annulé : pas de bruit — le libellé reste nu', async () => {
    const svc = monter({ ticksAnnules: 0 });
    const t = await tacheTrip(svc);
    expect(t.settingsSummary).toBe('Actif · chaque heure');
  });

  it("⚠️ mock partiel / tables illisibles : l'écran ne casse pas (repli fin-based)", async () => {
    // Les vieux specs de cet écran ont des mocks prisma PARTIELS : toute lecture non défensive
    // les tuerait d'un TypeError synchrone. `gardeTrajets()` garde l'accès de propriété DANS
    // le try — ce test verrouille ce style, pour la prochaine décoration qu'on ajoutera.
    const svc = monter({ mockPartiel: true, lastRunAt: new Date() });
    const t = await tacheTrip(svc);
    expect(t.enabled).toBe(true);
  });
});
