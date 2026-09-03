import { BackgroundTasksService } from './background-tasks.service';

/**
 * ── LE PIÈGE QUE CES TESTS DÉSAMORCENT ───────────────────────────────────────────────
 *
 * Les deux premiers agents sur poste déduisent leur santé de ce qu'ils ont ÉCRIT : la dernière
 * limite de vitesse résolue, le dernier récit rédigé. C'était juste POUR EUX — ils ont toujours
 * du travail en attente, donc une date qui n'avance plus signifie vraiment une panne.
 *
 * Copier ce raisonnement pour l'agent de qualité GPS aurait été une faute. Celui-ci peut
 * légitimement ne RIEN écrire d'une nuit : aucune zone partagée par deux véhicules, aucun boîtier
 * dispersé — et c'est le résultat qu'on espère. L'écran aurait donc annoncé « agent à l'arrêt »
 * précisément les nuits où le parc va bien. Une supervision qui crie au loup quand tout va bien
 * finit par ne plus être lue, et c'est alors la vraie panne qui passe inaperçue.
 *
 * D'où la séparation vérifiée ici :
 *   « a-t-il TOURNÉ ? »  → la table des passages, une ligne par passage, même vide.
 *   « a-t-il TROUVÉ ? »  → le résumé, qui compte les zones en attente de relecture.
 */
const HEURE = 3_600_000;

type Passage = {
  finiA: Date;
  succes: boolean;
  resume: string;
  erreur: string | null;
};

function service(opts: { passage?: Passage | null; ouverts?: number; casse?: boolean } = {}) {
  const rejette = () => Promise.reject(new Error('base injoignable'));
  const prisma = {
    tripAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    agendaAgentSettings: { findMany: jest.fn().mockResolvedValue([]) },
    placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    speedLimitCache: {
      aggregate: jest.fn().mockResolvedValue({ _max: { createdAt: null } }),
      count: jest.fn().mockResolvedValue(0),
    },
    tripAnalysis: { count: jest.fn().mockResolvedValue(0), aggregate: jest.fn().mockResolvedValue({ _max: { updatedAt: null } }) },
    // Le catalogue lit desormais AUSSI la file des travaux IA locaux (courrier + rattrapage) :
    // un faux prisma qui l'ignore fait exploser Promise.all en unhandled rejection sous Node 22.
    travailIaLocal: { count: jest.fn().mockResolvedValue(0) },
    passageAgentLocal: {
      findFirst: opts.casse
        ? jest.fn().mockImplementation(rejette)
        : jest.fn().mockResolvedValue(opts.passage ?? null),
    },
    gpsZoneDiagnostic: { count: jest.fn().mockResolvedValue(opts.ouverts ?? 0) },
  };
  const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
  return new BackgroundTasksService(prisma as never, registry as never, { resteRecitTotal: async () => ({ aNarrer: 0, enAttenteDeRecalcul: 0, libelle: 'analyses sans recit que l agent prendra' }) } as never);
}

const agentDe = async (svc: BackgroundTasksService) =>
  (await svc.list()).tasks.find((t) => t.id === 'agent-qualite-gps');

const passageFrais = (over: Partial<Passage> = {}): Passage => ({
  finiA: new Date(Date.now() - 2 * HEURE),
  succes: true,
  resume: '1 zone(s) enregistree(s), 0 boitier(s) signale(s)',
  erreur: null,
  ...over,
});

describe('Traitements de fond — agent qualite GPS', () => {
  it('⚠️ il FIGURE au catalogue : un traitement absent d’ici tourne en silence', async () => {
    const agent = await agentDe(service({ passage: passageFrais() }));
    expect(agent).toBeDefined();
    expect(agent!.category).toBe('Maintenance données');
    expect(agent!.executor).toBe('poste-local');
  });

  it('n’appelle aucun modele : ni facture, ni absorbe — simplement AUCUN cout', async () => {
    const agent = await agentDe(service({ passage: passageFrais() }));
    expect(agent!.coutIa).toBe('aucun');
    expect(agent!.note).toContain('AUCUN modele');
  });

  it('l’horaire annonce est celui reellement programme sur le poste', async () => {
    const agent = await agentDe(service({ passage: passageFrais() }));
    expect(agent!.scheduleHuman).toContain('05:00');
  });

  it('⚠️ UNE NUIT SANS RIEN TROUVER N’EST PAS UNE PANNE — c’est tout l’enjeu', async () => {
    const agent = await agentDe(
      service({
        passage: passageFrais({ resume: 'Aucune zone a signaler (18 zone(s) examinee(s), 8 sans conclusion)' }),
        ouverts: 0,
      }),
    );
    // Il a tourne, il n'a rien trouve : sain. Deduire l'etat de la production aurait dit « en panne ».
    expect(agent!.enabled).toBe(true);
    expect(agent!.settingsSummary).toContain('Aucune zone a signaler');
  });

  it('passage recent et reussi → sain, et la date est celle de la FIN du passage', async () => {
    const fini = new Date(Date.now() - 2 * HEURE);
    const agent = await agentDe(service({ passage: passageFrais({ finiA: fini }), ouverts: 3 }));
    expect(agent!.enabled).toBe(true);
    expect(agent!.lastRunAt).toBe(fini.toISOString());
    expect(agent!.settingsSummary).toContain('3 zone(s) en attente');
  });

  it('⚠️ un passage FRAIS mais en ECHEC reste un probleme : il tourne et n’aboutit pas', async () => {
    const agent = await agentDe(
      service({ passage: passageFrais({ succes: false, resume: 'Passage interrompu', erreur: 'ssh: connexion refusee' }) }),
    );
    expect(agent!.enabled).toBe(false);
    expect(agent!.settingsSummary).toContain('ssh: connexion refusee');
  });

  it('un echec sans motif consigne le dit, plutot que d’afficher un blanc', async () => {
    const agent = await agentDe(service({ passage: passageFrais({ succes: false, erreur: null }) }));
    expect(agent!.settingsSummary).toContain('motif non consigné');
  });

  it('silencieux depuis plus de 36 h → signale en panne (poste eteint, tache supprimee…)', async () => {
    const agent = await agentDe(service({ passage: passageFrais({ finiA: new Date(Date.now() - 40 * HEURE) }) }));
    expect(agent!.enabled).toBe(false);
  });

  it('jamais vu passer → etat INCONNU, pas « en panne » (on n’accuse pas sans preuve)', async () => {
    const agent = await agentDe(service({ passage: null, ouverts: 1 }));
    expect(agent!.enabled).toBeNull();
    expect(agent!.lastRunAt).toBeNull();
    // Le reste a faire reste affiche : il ne depend pas de l'agent.
    expect(agent!.settingsSummary).toContain('1 zone(s) en attente');
  });

  it('⚠️ la supervision ne fait jamais tomber la page qu’elle supervise', async () => {
    const reponse = await service({ casse: true }).list();
    expect(reponse.tasks.length).toBeGreaterThan(10);
    expect(reponse.tasks.find((t) => t.id === 'agent-qualite-gps')!.enabled).toBeNull();
  });
});
