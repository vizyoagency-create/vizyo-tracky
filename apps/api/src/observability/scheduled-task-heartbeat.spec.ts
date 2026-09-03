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
 * ── ET LA SONDE ELLE-MÊME S'EST TROMPÉE ─────────────────────────────────────────────
 *
 * ⚠️ Sa première version codait les seuils en dur. Dès son premier passage en production,
 * elle a crié « Rapport d'activité arrêté depuis 121 h ». Faux : ce rapport est réglé en
 * HEBDOMADAIRE, il avait tourné 5 jours plus tôt et n'était dû que 2 jours plus tard.
 *
 * Une sonde qui juge sur une cadence SUPPOSÉE est pire qu'aucune sonde : elle produit de
 * fausses alertes, on apprend à les ignorer, et la vraie panne passe avec. La cadence est
 * stockée à côté du `lastRunAt` — elle se lit.
 */
describe('ScheduledTaskHeartbeatService', () => {
  const NOW = new Date('2026-08-03T18:00:00Z').getTime();
  const ilYA = (heures: number): Date => new Date(NOW - heures * 3_600_000);

  type Etat = { enabled: boolean; lastRunAt: Date | null; frequency?: string; updatedAt?: Date | null };

  /**
   * ⚠️ `updatedAt` est injecte PAR DEFAUT, et c'est volontaire.
   *
   * Prisma rend TOUJOURS cette colonne : un mock qui l'omet vaut `undefined` la ou la
   * production a une date, et le test decrirait alors un comportement qui n'existe nulle
   * part. C'est exactement le piege paye le 2026-08-17 (garde ecrite sur `reviewedAt ===
   * null`, verte en test, divergente en base). Un test doit pouvoir CHOISIR cette valeur,
   * jamais l'oublier.
   */
  const CONFIGUREE_DEPUIS_LONGTEMPS = new Date(NOW - 1000 * 3_600_000);

  function setup(etats: Record<string, Etat | null>) {
    const rows = (k: string) => {
      const e = etats[k];
      const valeur = e === null || e === undefined
        ? null
        : { updatedAt: CONFIGUREE_DEPUIS_LONGTEMPS, ...e };
      return { findFirst: jest.fn().mockResolvedValue(valeur) };
    };
    const prisma = {
      tripAutomationSettings: rows('trip'),
      agendaAgentSettings: rows('agenda'),
      activityReportSchedule: rows('report'),
      placeAutomationSettings: rows('place'),
      // Rapport hebdomadaire des sociétés (2026-09) : par défaut AUCUNE ligne, donc rien
      // à surveiller. ⚠️ Un modèle absent du mock fait échouer la LECTURE de la tâche, et la
      // sonde journalise alors une erreur de lecture — ce qui ajoutait un appel parasite à
      // chacun des tests ci-dessous. Toute tâche ajoutée à la sonde doit apparaître ici.
      fleetReportSchedule: rows('hebdo'),
    } as never;
    const recordBackground = jest.fn();
    const svc = new ScheduledTaskHeartbeatService(prisma, { recordBackground } as never);
    return { svc, recordBackground };
  }

  it('signale une tâche ACTIVÉE et muette au-delà du seuil', async () => {
    // Le cas réel : automatisation horaire, dernier passage il y a 5 jours.
    const { svc, recordBackground } = setup({
      trip: { enabled: true, lastRunAt: ilYA(120), frequency: 'hourly' },
    });
    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    const [err, source, ctx, severity] = recordBackground.mock.calls[0]!;
    expect((err as Error).message).toContain('Automatisation des trajets');
    expect((err as Error).message).toContain('120 h');
    // ⚠️ La cadence CONFIGURÉE figure dans le message : sans elle, « 120 h » ne dit pas si
    // c'est anormal. Avec elle, l'écart saute aux yeux.
    expect((err as Error).message).toContain('toutes les heures');
    expect(source).toBe('scheduled-task-heartbeat');
    expect(ctx).toEqual(expect.objectContaining({ task: 'Automatisation des trajets' }));
    expect(severity).toBe('CRITICAL');
  });

  // ── La cadence se LIT ────────────────────────────────────────────────────────────────

  it('NE crie PAS sur un rapport HEBDOMADAIRE muet depuis 121 h — la fausse alerte du 03/08', async () => {
    // ⚠️ LE cas qui a piégé la première version : 121 h de silence, mais la tâche est
    // hebdomadaire. Elle a tourné il y a 5 jours et n'est due que dans 2. Rien à signaler.
    const { svc, recordBackground } = setup({
      report: { enabled: true, lastRunAt: ilYA(121), frequency: 'weekly' },
    });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('crie sur la MÊME durée de silence si la tâche est réglée en QUOTIDIEN', async () => {
    // Même 121 h, cadence différente → verdict différent. C'est bien la cadence qui décide,
    // pas une constante écrite dans la sonde.
    const { svc, recordBackground } = setup({
      report: { enabled: true, lastRunAt: ilYA(121), frequency: 'daily' },
    });
    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    expect((recordBackground.mock.calls[0]![0] as Error).message).toContain('quotidienne');
  });

  it('tolère UNE période manquée, pas DEUX', async () => {
    // Une seule période ratée s'explique par un redémarrage. Deux d'affilée, non.
    const unSeulJour = setup({ report: { enabled: true, lastRunAt: ilYA(30), frequency: 'daily' } });
    await unSeulJour.svc.check(NOW);
    expect(unSeulJour.recordBackground).not.toHaveBeenCalled();

    const deuxJours = setup({ report: { enabled: true, lastRunAt: ilYA(60), frequency: 'daily' } });
    await deuxJours.svc.check(NOW);
    expect(deuxJours.recordBackground).toHaveBeenCalledTimes(1);
  });

  it('une cadence inconnue est traitée comme quotidienne, jamais comme horaire', async () => {
    // Un repli trop serré recréerait la fausse alerte qu'on vient de corriger.
    const { svc, recordBackground } = setup({
      trip: { enabled: true, lastRunAt: ilYA(20), frequency: 'cadence-inventee' },
    });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  // ── Ce qui ne doit RIEN déclencher ───────────────────────────────────────────────────

  it('NE signale PAS une tâche volontairement coupée', async () => {
    // Une tâche désactivée n'est pas une panne. La signaler apprendrait à ignorer la
    // sonde — et le jour où elle a raison, personne ne la lirait.
    const { svc, recordBackground } = setup({
      trip: { enabled: false, lastRunAt: ilYA(500), frequency: 'hourly' },
    });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('NE signale PAS une tâche qui vient de tourner', async () => {
    const { svc, recordBackground } = setup({
      trip: { enabled: true, lastRunAt: ilYA(0.7), frequency: 'hourly' },
    });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('tolère un retard NORMAL sur une tâche horaire — plancher de 4 h', async () => {
    // Deux périodes d'une tâche horaire = 2 h : trop serré, on crierait pour un redémarrage.
    // D'où le plancher. Ici 3 h de retard ne doivent rien déclencher.
    const { svc, recordBackground } = setup({
      trip: { enabled: true, lastRunAt: ilYA(3), frequency: 'hourly' },
    });
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  it('une tâche NON CONFIGURÉE ne déclenche rien', async () => {
    const { svc, recordBackground } = setup({});
    await svc.check(NOW);
    expect(recordBackground).not.toHaveBeenCalled();
  });

  // ── Cas discrets ─────────────────────────────────────────────────────────────────────

  it('signale une tâche activée qui n’a JAMAIS tourné', async () => {
    // Le cas le plus discret : ni succès, ni échec, aucune trace d'aucune sorte.
    const { svc, recordBackground } = setup({
      report: { enabled: true, lastRunAt: null, frequency: 'weekly' },
    });
    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    expect((recordBackground.mock.calls[0]![0] as Error).message).toContain('aucun passage enregistré');
  });

  it("🔑 NE crie PAS sur une tâche qu'on VIENT d'activer — le faux positif du 22/08", async () => {
    // Le cas réel : « Automatisation des lieux » activée à 06:02, quotidienne à 03:00, donc
    // premier passage possible 21 h plus tard. L'ancienne version l'a déclarée à l'arrêt
    // 33 min après l'activation, puis TOUTES LES HEURES — 7 CRITICAL en une matinée.
    const { svc, recordBackground } = setup({
      place: { enabled: true, lastRunAt: null, updatedAt: ilYA(0.55) },
    });
    await svc.check(NOW);

    expect(recordBackground).not.toHaveBeenCalled();
  });

  it("tolère l'attente jusqu'au seuil, puis signale au-delà", async () => {
    // Quotidienne ⇒ tolérance 48 h. À 47 h on attend encore ; à 49 h, elle n'a jamais démarré.
    const avant = setup({ place: { enabled: true, lastRunAt: null, updatedAt: ilYA(47) } });
    await avant.svc.check(NOW);
    expect(avant.recordBackground).not.toHaveBeenCalled();

    const apres = setup({ place: { enabled: true, lastRunAt: null, updatedAt: ilYA(49) } });
    await apres.svc.check(NOW);
    expect(apres.recordBackground).toHaveBeenCalledTimes(1);
  });

  it("le message DATE l'attente — « aucun passage » seul ne dit pas si c'est grave", async () => {
    const { svc, recordBackground } = setup({
      place: { enabled: true, lastRunAt: null, updatedAt: ilYA(200) },
    });
    await svc.check(NOW);

    const msg = (recordBackground.mock.calls[0]![0] as Error).message;
    expect(msg).toContain('aucun passage enregistré depuis son activation il y a 200 h');
  });

  it("⚠️ sans repère de configuration, on SIGNALE — se taire masquerait une vraie panne", async () => {
    // Repli défensif : si `updatedAt` venait à manquer, l'ancien comportement reprend.
    const { svc, recordBackground } = setup({
      place: { enabled: true, lastRunAt: null, updatedAt: null },
    });
    await svc.check(NOW);

    expect(recordBackground).toHaveBeenCalledTimes(1);
    expect((recordBackground.mock.calls[0]![0] as Error).message).toContain('aucun passage enregistré');
  });

  it('signale CHAQUE tâche en panne, pas seulement la première', async () => {
    // S'arrêter à la première laisserait la seconde invisible — exactement le défaut réparé.
    const { svc, recordBackground } = setup({
      trip: { enabled: true, lastRunAt: ilYA(120), frequency: 'hourly' },
      report: { enabled: true, lastRunAt: ilYA(400), frequency: 'daily' },
    });
    await svc.check(NOW);
    expect(recordBackground).toHaveBeenCalledTimes(2);
  });

  it('une lecture en ERREUR est signalée comme telle, pas comme un arrêt', async () => {
    // ⚠️ Confondre « je n'ai pas pu lire » et « la tâche ne tourne plus » enverrait
    // chercher au mauvais endroit : on irait relancer une tâche qui va très bien.
    const prisma = {
      tripAutomationSettings: { findFirst: jest.fn().mockRejectedValue(new Error('DB down')) },
      agendaAgentSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
      placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      fleetReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
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

  it('l’automatisation des lieux, sans colonne de cadence, est jugée quotidienne', async () => {
    const ok = setup({ place: { enabled: true, lastRunAt: ilYA(30) } });
    await ok.svc.check(NOW);
    expect(ok.recordBackground).not.toHaveBeenCalled();

    const ko = setup({ place: { enabled: true, lastRunAt: ilYA(60) } });
    await ko.svc.check(NOW);
    expect(ko.recordBackground).toHaveBeenCalledTimes(1);
  });
});
