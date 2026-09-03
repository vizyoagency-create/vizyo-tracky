import { BackgroundTasksService } from './background-tasks.service';

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

function service(opts: { dernier?: Date | null; resolues?: number; restantes?: number; casse?: boolean } = {}) {
  const rejette = () => Promise.reject(new Error('base injoignable'));
  const prisma = {
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
    tripAnalysis: { count: jest.fn().mockResolvedValue(opts.restantes ?? 0) },
  };
  const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
  return new BackgroundTasksService(prisma as never, registry as never, { resteRecitTotal: async () => ({ aNarrer: 0, enAttenteDeRecalcul: 0, libelle: 'analyses sans recit que l agent prendra' }) } as never);
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
    const agent = await agentDe(service({ dernier: ecrit, resolues: 16217, restantes: 4439 }));
    expect(agent!.enabled).toBe(true);
    expect(agent!.lastRunAt).toBe(ecrit.toISOString());
  });

  it('⚠️ silencieux depuis deux créneaux → signalé en panne (poste éteint, Overpass qui refuse…)', async () => {
    // Le plus long trou normal de la journée est 22:00 → 04:30, soit 6 h 30. Au-delà de 13 h,
    // ce n'est plus un aléa : l'agent ne travaille plus, et l'écran doit le dire.
    const agent = await agentDe(service({ dernier: new Date(Date.now() - 20 * HEURE) }));
    expect(agent!.enabled).toBe(false);
  });

  it('le résumé porte le RESTE À FAIRE, pas seulement l’acquis', async () => {
    const agent = await agentDe(service({ dernier: new Date(), resolues: 16217, restantes: 4439 }));
    expect(agent!.settingsSummary).toContain('16');
    expect(agent!.settingsSummary).toContain('4');
    expect(agent!.settingsSummary).toContain('encore sans limite');
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
