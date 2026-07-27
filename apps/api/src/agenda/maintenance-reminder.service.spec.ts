import { MaintenanceReminderService } from './maintenance-reminder.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Plan « vidange tous les 15 000 km » : PAS d'intervalle en mois -> échéance purement kilométrique. */
function kmPlan(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    fleetId: 'f1',
    vehicleId: 'v1',
    label: 'Vidange',
    category: 'OIL_CHANGE',
    intervalMonths: null,
    intervalKm: 15000,
    lastDoneAt: null,
    lastDoneKm: 30000,
    reminderDaysBefore: 30,
    reminderKmBefore: 1000,
    enabled: true,
    vehicle: { plate: 'FV-941-LZ', tracker: { id: 't1', lastSeenAt: new Date(Date.now() - 89 * DAY_MS) } },
    ...over,
  };
}

function build(over: { plans?: unknown[]; nextDueAt?: Date | null; systemActivity?: unknown } = {}) {
  const prisma = {
    maintenancePlan: { findMany: jest.fn().mockResolvedValue(over.plans ?? [kmPlan()]) },
    vehicleEvent: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]) },
  };
  const plans = {
    materializePlannedEvent: jest.fn().mockResolvedValue(undefined),
    // Reproduit FIDÈLEMENT `MaintenancePlansService.computeNextDue` pour le volet km : un stub qui
    // renverrait toujours un `nextDueKm` masquerait le cas « intervalle km SANS relevé de départ »,
    // où il n'y a aucune échéance à évaluer — et le test validerait un faux diagnostic.
    computeNextDue: jest.fn((p: { intervalKm: number | null; lastDoneKm: number | null }) => ({
      nextDueAt: over.nextDueAt === undefined ? null : over.nextDueAt,
      nextDueKm: p.intervalKm && p.lastDoneKm != null ? p.lastDoneKm + p.intervalKm : null,
    })),
  };
  const webPush = { sendToUser: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }) };
  const systemActivity = (over.systemActivity as { record: jest.Mock }) ?? { record: jest.fn() };
  const errorLogger = { recordBackground: jest.fn() };
  const svc = new MaintenanceReminderService(
    prisma as never,
    plans as never,
    webPush as never,
    systemActivity as never,
    errorLogger as never,
  );
  return { svc, prisma, plans, webPush, systemActivity, errorLogger };
}

/** Entrées de journal « échéance km non évaluable » émises pendant le run. */
function unevaluableEntries(systemActivity: { record: jest.Mock }) {
  return systemActivity.record.mock.calls
    .map((c) => c[0])
    .filter((e: { action: string }) => e.action === 'maintenance_due_km_unevaluable');
}

describe('MaintenanceReminderService — échéance km sur véhicule muet', () => {
  it('véhicule DORMANT (89 j) + échéance au km -> journalise « non evaluable » (le silence du cron ne passe plus pour un plan sain)', async () => {
    const { svc, systemActivity, errorLogger } = build();
    await svc.run();

    const entries = unevaluableEntries(systemActivity);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      category: 'MAINTENANCE',
      status: 'SKIPPED',
      fleetId: 'f1',
      target: 'FV-941-LZ : Vidange',
    });
    expect(entries[0].detail).toContain('89 j');
    // `nextDueKm` accompagne l'entrée : c'est le chiffre à confronter au compteur réel.
    expect(entries[0].meta).toMatchObject({ vehicleId: 'v1', planId: 'p1', intervalKm: 15000, nextDueKm: 45000 });
    // Aucun plantage silencieux : le run doit s'être déroulé jusqu'au bout.
    expect(errorLogger.recordBackground).not.toHaveBeenCalled();
  });

  it('véhicule silencieux 2 h -> AUCUN signal (un stationnement de nuit n\'est pas une panne)', async () => {
    const { svc, systemActivity } = build({
      plans: [kmPlan({ vehicle: { plate: 'AA-1', tracker: { id: 't1', lastSeenAt: new Date(Date.now() - 2 * HOUR_MS) } } })],
    });
    await svc.run();
    expect(unevaluableEntries(systemActivity)).toHaveLength(0);
  });

  it('véhicule SANS boîtier -> AUCUN signal (jamais suivi n\'est pas « s\'est tu »)', async () => {
    const { svc, systemActivity } = build({
      plans: [kmPlan({ vehicle: { plate: 'TEST-001-XX', tracker: null } })],
    });
    await svc.run();
    expect(unevaluableEntries(systemActivity)).toHaveLength(0);
  });

  it('boîtier affecté mais qui n\'a JAMAIS émis -> AUCUN signal', async () => {
    const { svc, systemActivity } = build({
      plans: [kmPlan({ vehicle: { plate: 'BB-2', tracker: { id: 't9', lastSeenAt: null } } })],
    });
    await svc.run();
    expect(unevaluableEntries(systemActivity)).toHaveLength(0);
  });

  it('intervalle km SANS relevé de départ sur véhicule dormant -> AUCUN signal (la cause n\'est pas le boîtier)', async () => {
    // `computeNextDue` ne produit aucun `nextDueKm` sans `lastDoneKm` : il n'y a donc RIEN à
    // évaluer, muet ou pas. Accuser le silence du boîtier enverrait l'exploitant démonter un
    // traceur en état de marche, tous les jours, alors qu'il manque juste une saisie.
    const { svc, systemActivity } = build({ plans: [kmPlan({ lastDoneKm: null })] });
    await svc.run();
    expect(unevaluableEntries(systemActivity)).toHaveLength(0);
  });

  it('échéance purement CALENDAIRE sur véhicule dormant -> AUCUN signal (un CT reste dû, boîtier ou pas)', async () => {
    const { svc, systemActivity } = build({
      plans: [kmPlan({ intervalKm: null, intervalMonths: 12, lastDoneAt: new Date() })],
    });
    await svc.run();
    expect(unevaluableEntries(systemActivity)).toHaveLength(0);
  });

  it('réintégration : dès que le boîtier ré-émet, le signal disparaît sans aucune action manuelle', async () => {
    const muet = build();
    await muet.svc.run();
    expect(unevaluableEntries(muet.systemActivity)).toHaveLength(1);

    // Même plan, même base : seule `lastSeenAt` a été rafraîchie par une trame reçue.
    const revenu = build({
      plans: [kmPlan({ vehicle: { plate: 'FV-941-LZ', tracker: { id: 't1', lastSeenAt: new Date() } } })],
    });
    await revenu.svc.run();
    expect(unevaluableEntries(revenu.systemActivity)).toHaveLength(0);
  });

  it('non-régression : le rappel CALENDAIRE part toujours, même si le véhicule est dormant', async () => {
    const due = new Date(Date.now() + 5 * DAY_MS); // dans le préavis de 30 j
    const { svc, webPush, prisma } = build({
      plans: [kmPlan({ intervalMonths: 12, lastDoneAt: new Date() })],
      nextDueAt: due,
    });
    await svc.run();
    expect(webPush.sendToUser).toHaveBeenCalledTimes(1);
    expect(prisma.maintenancePlan.findMany).toHaveBeenCalledTimes(1);
  });
});
