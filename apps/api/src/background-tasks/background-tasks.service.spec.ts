import { Prisma } from '@prisma/client';
import { BackgroundTasksService, RESTE_LIMITES_TTL_MS } from './background-tasks.service';

/**
 * ── CE QUE CES TESTS PROTÈGENT ───────────────────────────────────────────────────────
 *
 * L'écran « Traitements de fond » existe pour qu'AUCUN traitement ne tourne en silence.
 * L'agent de limites de vitesse, lui, ne tourne pas sur ce serveur : il travaille sur le poste
 * du propriétaire, parce que l'IP du VPS s'est fait bannir d'overpass-api.de. Le serveur ne
 * peut donc rien savoir de sa tâche planifiée — mais il peut voir ce qu'elle ÉCRIT.
 *
 * D'où le choix testé ici : l'état de l'agent se déduit de la dernière cellule résolue, pas
 * d'un signal de démarrage. Un agent qui démarre puis échoue (poste éteint, Overpass qui
 * refuse, session fermée) n'avance pas cette date — et l'écran le montre au lieu de rassurer.
 */
const HEURE = 3_600_000;

function service(
  opts: { dernier?: Date | null; resolues?: number; portions?: number; resteCasse?: boolean; casse?: boolean } = {},
) {
  const rejette = () => Promise.reject(new Error('base injoignable'));
  /**
   * Requêtes brutes de l'écran. Celle du reste de l'agent se reconnaît à sa table (`positions`) ;
   * les autres (rythme des tracés) rendent un compte nul.
   */
  const $queryRaw = jest.fn(async (...appel: unknown[]) => {
    if (!texteDe(appel).includes('FROM positions')) return [{ n: BigInt(0) }];
    if (opts.resteCasse) throw new Error('canceling statement due to statement timeout');
    return [{ n: opts.portions ?? 0 }];
  });
  const prisma = {
    $queryRaw,
    tripAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    agendaAgentSettings: { findMany: jest.fn().mockResolvedValue([]) },
    placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    speedLimitCache: {
      aggregate: opts.casse
        ? jest.fn().mockImplementation(rejette)
        : jest.fn().mockResolvedValue({ _max: { createdAt: opts.dernier ?? null } }),
      count: jest.fn().mockResolvedValue(opts.resolues ?? 0),
    },
    tripAnalysis: { count: jest.fn().mockResolvedValue(576) },
  };
  const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
  return new BackgroundTasksService(prisma as never, registry as never, { resteRecitTotal: async () => ({ aNarrer: 0, enAttenteDeRecalcul: 0, libelle: 'analyses sans recit que l agent prendra' }) } as never);
}

/** Le texte d'une requête brute, fragments `Prisma.raw` aplatis par Prisma lui-même. */
function texteDe(appel: readonly unknown[]): string {
  const [morceaux, ...valeurs] = appel as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(morceaux, ...valeurs).text;
}

/** Combien de fois le reste de l'agent a réellement été mesuré en base. */
function mesuresDuReste(svc: BackgroundTasksService): number {
  const { $queryRaw } = (svc as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma;
  return $queryRaw.mock.calls.filter((c) => texteDe(c).includes('FROM positions')).length;
}

const agentDe = async (svc: BackgroundTasksService) =>
  (await svc.list()).tasks.find((t) => t.id === 'agent-limites-vitesse');

describe('Traitements de fond — l’agent sur poste n’est pas invisible', () => {
  it('⚠️ il FIGURE au catalogue : un traitement absent d’ici tourne en silence', async () => {
    const agent = await agentDe(service({ dernier: new Date() }));
    expect(agent).toBeDefined();
    expect(agent!.category).toBe('Maintenance données');
  });

  it('l’horaire annoncé est celui réellement programmé sur le poste', async () => {
    const agent = await agentDe(service({ dernier: new Date() }));
    for (const h of ['04:30', '08:30', '14:00', '18:30', '22:00']) {
      expect(agent!.scheduleHuman).toContain(h);
    }
  });

  it('la note dit qu’il ne tourne PAS sur ce serveur — sinon on le chercherait ici', async () => {
    const agent = await agentDe(service({ dernier: new Date() }));
    expect(agent!.note).toContain('PAS sur ce serveur');
  });

  it('⚠️ récemment actif → sain, et le dernier passage est celui du DERNIER TRAVAIL écrit', async () => {
    const ecrit = new Date(Date.now() - 2 * HEURE);
    const agent = await agentDe(service({ dernier: ecrit, resolues: 16217, portions: 145 }));
    expect(agent!.enabled).toBe(true);
    expect(agent!.lastRunAt).toBe(ecrit.toISOString());
  });

  it('⚠️ silencieux depuis deux créneaux → signalé en panne (poste éteint, Overpass qui refuse…)', async () => {
    // Le plus long trou normal de la journée est 22:00 → 04:30, soit 6 h 30. Au-delà de 13 h,
    // ce n'est plus un aléa : l'agent ne travaille plus, et l'écran doit le dire.
    const agent = await agentDe(service({ dernier: new Date(Date.now() - 20 * HEURE) }));
    expect(agent!.enabled).toBe(false);
  });

  /**
   * ⚠️ LE RESTE DE L'AGENT SE COMPTE EN PORTIONS — CELLES QU'IL PREND (2026-10-05).
   *
   * L'écran lui attribuait « 576 trajets encore sans limite » (`limitsKnown = false`) : aucun n'était
   * son travail (trajets lents, positions purgées, orphelines), et le nombre ne pouvait pas
   * descendre à zéro. Le reste affiché est désormais celui de sa requête même — 145 portions ce
   * jour-là — et l'ancien compte ne doit plus revenir par la bande.
   */
  it('le résumé porte le RESTE À FAIRE de l’agent — ses portions, pas des trajets', async () => {
    const svc = service({ dernier: new Date(), resolues: 350600, portions: 145 });
    const agent = await agentDe(svc);

    expect(agent!.settingsSummary).toMatch(/350.600 limites résolues/);
    expect(agent!.settingsSummary).toContain('145 portion(s) à résoudre');
    expect(agent!.settingsSummary).toContain('plus de 33 km/h ces 60 derniers jours');
    expect(agent!.settingsSummary).not.toContain('trajets encore sans limite');
    const { tripAnalysis } = (svc as unknown as { prisma: { tripAnalysis: { count: jest.Mock } } }).prisma;
    expect(tripAnalysis.count.mock.calls.filter(([a]) => 'limitsKnown' in (a?.where ?? {}))).toEqual([]);
  });

  it('un reste nul se dit — « aucune portion à résoudre » —, avec l’âge de la mesure', async () => {
    const agent = await agentDe(service({ dernier: new Date(), resolues: 350600, portions: 0 }));
    expect(agent!.settingsSummary).toContain('aucune portion à résoudre (mesuré il y a moins d’une minute)');
  });

  /**
   * La requête de l'agent balaie les positions des 60 derniers jours : 1 à 2 s en production. L'écran
   * se recharge toutes les 30 s ; la rejouer à chaque fois coûterait plus que l'écran entier.
   */
  it('⚠️ le reste est mesuré au plus une fois par quart d’heure — et dit son âge', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-05T14:00:00Z') });
    try {
      const svc = service({ dernier: new Date(), portions: 145 });
      await agentDe(svc);
      await agentDe(svc);
      expect(mesuresDuReste(svc)).toBe(1);

      jest.setSystemTime(Date.parse('2026-10-05T14:12:00Z'));
      const agent = await agentDe(svc);
      expect(mesuresDuReste(svc)).toBe(1);
      expect(agent!.settingsSummary).toContain('mesuré il y a 12 min');

      jest.setSystemTime(Date.parse('2026-10-05T14:00:00Z') + RESTE_LIMITES_TTL_MS + 1);
      await agentDe(svc);
      expect(mesuresDuReste(svc)).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('une mesure en échec ne coûte que le reste — ni la preuve de vie, ni l’acquis — et se retente', async () => {
    const svc = service({ dernier: new Date(), resolues: 350600, resteCasse: true });
    const agent = await agentDe(svc);
    expect(agent!.enabled).toBe(true);
    expect(agent!.settingsSummary).toMatch(/350.600 limites résolues · reste de l’agent non mesuré/);
    // Un échec n'est pas retenu : le chargement suivant mesure de nouveau.
    await agentDe(svc);
    expect(mesuresDuReste(svc)).toBe(2);
  });

  it('jamais lancé → état INCONNU, pas « en panne » (on n’accuse pas sans preuve)', async () => {
    const agent = await agentDe(service({ dernier: null }));
    expect(agent!.enabled).toBeNull();
    expect(agent!.lastRunAt).toBeNull();
  });

  it('⚠️ la supervision ne fait jamais tomber la page qu’elle supervise', async () => {
    const svc = service({ casse: true });
    const reponse = await svc.list();
    expect(reponse.tasks.length).toBeGreaterThan(10); // les autres traitements restent affichés
    expect(reponse.tasks.find((t) => t.id === 'agent-limites-vitesse')!.enabled).toBeNull();
  });

  /**
   * Ce serveur tourne en UTC, le poste du proprietaire en heure de Paris. Avec le fuseau du
   * serveur, l'ecran annoncait « prochain passage 14:00 » deux heures APRES le passage reel.
   * Un ecran de supervision qui se trompe d'heure est pire que pas d'ecran du tout.
   */
  it('⚠️ le prochain passage est calculé en heure de PARIS, pas en heure serveur', async () => {
    const agent = await agentDe(service({ dernier: new Date() }));
    const heureParis = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(agent!.nextRunAt!));
    expect(['04:30', '08:30', '14:00', '18:30', '22:00']).toContain(heureParis);
  });
  it('un prochain passage est daté — sans lui, impossible de savoir si un trou est anormal', async () => {
    const agent = await agentDe(service({ dernier: new Date() }));
    expect(agent!.nextRunAt).not.toBeNull();
    expect(new Date(agent!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });
});
