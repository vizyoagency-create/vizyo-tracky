import { ScheduledTaskHeartbeatService } from './scheduled-task-heartbeat.service';

/**
 * ── UNE TÂCHE À L'ARRÊT NE PRODUIT AUCUN SIGNAL ─────────────────────────────────────
 *
 * ⚠️ Incident du 2026-08-03 : l'automatisation des trajets était arrêtée depuis CINQ
 * JOURS. Aucune erreur, aucune alerte, aucune ligne de journal — 1 334 trajets sans
 * analyse, découverts par hasard.
 *
 * Tous les mécanismes d'alerte de cette application se déclenchent sur un ÉVÉNEMENT : une
 * erreur, un échec, un dépassement. L'absence d'événement n'en est pas un. C'est ce qui
 * rend ce type de panne si durable, et pourquoi il faut aller chercher le silence.
 *
 * La sonde a d'ailleurs révélé un second cas le jour même : le rapport d'activité,
 * activé, sans passage depuis 120 heures.
 */
describe('ScheduledTaskHeartbeatService', () => {
  const NOW = new Date('2026-08-03T18:00:00Z').getTime();
  const ilYA = (heures: number): Date => new Date(NOW - heures * 3_600_000);

  function setup(etats: Record<string, { enabled: boolean; lastRunAt: Date | null } | null>) {
    const rows = (k: string) => ({ findFirst: jest.fn().mockResolvedValue(etats[k] ?? null) });
    const prisma = {
      tripAutomationSettings: rows('trip'),
      agendaAgentSettings: rows('agenda'),
      activityReportSchedule: rows('report'),
      placeAutomationSettings: rows('place'),
    } as never;
    const recordBackground = jest.fn();
    const svc = new ScheduledTaskHeartbeatService(prisma, { recordBackground } as never);
    return { svc, recordBackground };
  }

  /** Tâches non concernées par le test courant : absentes = non configurées. */
  const AUCUNE = {};

  it('signale une tâche ACTIVÉE et muette au-delà du seuil', async () => {
    // Le cas réel : automatisation horaire, dernier passage il y a 5 jours.
    const { svc, recordBackground } = setup({
      ...AUCUNE,
      trip: { enabled: true, lastRunAt: ilYA(120) },
    });
    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    const [err, source, ctx, severity] = recordBackground.mock.calls[0]!;
    expect((err as Error).message).toContain('Automatisation des trajets');
    expect((err as Error).message).toContain('120 h');
    // ⚠️ La cadence attendue figure dans le message : sans elle, « 120 h » ne dit pas si
    // c'est anormal. Avec elle, l'écart saute aux yeux.
    expect((err as Error).message).toContain('toutes les heures');
    expect(source).toBe('scheduled-task-heartbeat');
    expect(ctx).toEqual(jasmineLike({ task: 'Automatisation des trajets' }));
    expect(severity).toBe('CRITICAL');
  });

  it('NE signale PAS une tâche volontairement coupée', async () => {
    // Une tâche désactivée n'est pas une panne. La signaler apprendrait à ignorer la
    // sonde — et le jour où elle a raison, personne ne la lirait.
    const { svc, recordBackground } = setup({ trip: { enabled: false, lastRunAt: ilYA(500) } });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('NE signale PAS une tâche qui vient de tourner', async () => {
    const { svc, recordBackground } = setup({ trip: { enabled: true, lastRunAt: ilYA(0.7) } });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('tolère un retard NORMAL — le but est de détecter un arrêt, pas un passage manqué', async () => {
    // Cadence horaire, seuil à 4 h : trois heures de retard (redémarrage, migration…) ne
    // doivent rien déclencher. Une sonde qui crie pour ça finit désactivée.
    const { svc, recordBackground } = setup({ trip: { enabled: true, lastRunAt: ilYA(3) } });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('signale une tâche activée qui n’a JAMAIS tourné', async () => {
    // Le cas le plus discret : ni succès, ni échec, aucune trace d'aucune sorte.
    const { svc, recordBackground } = setup({ report: { enabled: true, lastRunAt: null } });
    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    expect((recordBackground.mock.calls[0]![0] as Error).message).toContain(
      'aucun passage enregistré',
    );
  });

  it('signale CHAQUE tâche en panne, pas seulement la première', async () => {
    // Le 2026-08-03, deux tâches étaient à l'arrêt en même temps. S'arrêter à la première
    // aurait laissé la seconde invisible — exactement le défaut qu'on répare.
    const { svc, recordBackground } = setup({
      trip: { enabled: true, lastRunAt: ilYA(120) },
      report: { enabled: true, lastRunAt: ilYA(120) },
    });
    await svc.check(NOW);
    expect(recordBackground).toHaveBeenCalledTimes(2);
  });

  it('une tâche NON CONFIGURÉE ne déclenche rien', async () => {
    const { svc, recordBackground } = setup({});
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('une lecture en ERREUR est signalée comme telle, pas comme un arrêt', async () => {
    // ⚠️ Confondre « je n'ai pas pu lire » et « la tâche ne tourne plus » enverrait
    // chercher au mauvais endroit : on irait relancer une tâche qui va très bien.
    const prisma = {
      tripAutomationSettings: { findFirst: jest.fn().mockRejectedValue(new Error('DB down')) },
      agendaAgentSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
      placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    } as never;
    const recordBackground = jest.fn();
    const svc = new ScheduledTaskHeartbeatService(prisma, { recordBackground } as never);

    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    const [, , ctx, severity] = recordBackground.mock.calls[0]!;
    expect((ctx as { stage?: string }).stage).toBe('read');
    // Pas CRITICAL : une lecture ratée est un incident d'observabilité, pas une panne
    // de production.
    expect(severity).toBeUndefined();
  });
});

/** Petit helper : vérifie un sous-ensemble de clés sans dépendre de l'objet entier. */
function jasmineLike(subset: Record<string, unknown>): unknown {
  return expect.objectContaining(subset);
}
