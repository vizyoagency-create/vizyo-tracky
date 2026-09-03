import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * ── CE QUE CES TESTS PROTÈGENT ───────────────────────────────────────────────────────
 *
 * « Tout doit être traçable dans l'espace admin. » Les agents du poste étaient l'angle mort :
 * l'écran ne montrait d'eux qu'un booléen, et encore, seulement en filigrane. Un agent arrêté
 * depuis TROIS JOURS y ressemblait exactement à un agent arrêté depuis une heure — donc les
 * trois jours ne se voyaient pas. C'est la panne la plus probable de toute l'application : ces
 * traitements ne tournent pas sur le VPS, ils dépendent d'un PC allumé, et leur arrêt ne lève
 * AUCUNE erreur côté serveur. Rien à corréler, rien dans les journaux, rien du tout.
 *
 * Trois exigences, vérifiées ici :
 *   1. dire QUAND, avec quelle ISSUE, et DEPUIS COMBIEN DE TEMPS ;
 *   2. le dire FORT au-delà de deux fois la cadence annoncée — mais se taire quand le silence
 *      est normal, sans quoi l'écran devient un bruit de fond que plus personne ne lit ;
 *   3. ne jamais tomber : une supervision qui casse la page qu'elle supervise ne supervise rien.
 */
const HEURE = 3_600_000;

interface Passage {
  finiA: Date;
  succes: boolean;
  resume: string | null;
  erreur: string | null;
}

function passage(over: Partial<Passage> = {}): Passage {
  return { finiA: new Date(Date.now() - 2 * HEURE), succes: true, resume: 'travail fait', erreur: null, ...over };
}

function construire(
  opts: {
    /** Passage journalisé par agent (clé = id du catalogue). */
    passages?: Record<string, Passage | null>;
    /** Passage renvoyé pour tout agent non listé ci-dessus. */
    passageParDefaut?: Passage | null;
    /** Date du dernier TRAVAIL écrit (limites résolues, récits) — le repli historique. */
    productionAt?: Date | null;
    /** Trajets encore sans récit. Zéro = l'arriéré est résorbé, le silence devient normal. */
    restantsSansRecit?: number;
    ouverts?: number;
    /** Toutes les lectures échouent : la page doit survivre. */
    casse?: boolean;
  } = {},
) {
  const rejette = () => Promise.reject(new Error('base injoignable'));
  const passages = opts.passages ?? {};
  const restants = opts.restantsSansRecit ?? 5;

  const prisma = {
    tripAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    agendaAgentSettings: { findMany: jest.fn().mockResolvedValue([]) },
    placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    speedLimitCache: {
      aggregate: opts.casse ? jest.fn(rejette) : jest.fn().mockResolvedValue({ _max: { createdAt: opts.productionAt ?? null } }),
      count: jest.fn().mockResolvedValue(0),
    },
    tripAnalysis: {
      // Trois requêtes distinctes partagent ce compteur : seule celle des trajets « sans récit »
      // décide si le rattrapage a encore du travail, d'où la discrimination sur le `where`.
      count: opts.casse
        ? jest.fn(rejette)
        : jest.fn((args?: { where?: Record<string, unknown> }) =>
            Promise.resolve(args?.where && 'narrative' in args.where ? restants : 0),
          ),
      aggregate: opts.casse ? jest.fn(rejette) : jest.fn().mockResolvedValue({ _max: { updatedAt: opts.productionAt ?? null } }),
    },
    travailIaLocal: { count: opts.casse ? jest.fn(rejette) : jest.fn().mockResolvedValue(0) },
    gpsZoneDiagnostic: { count: opts.casse ? jest.fn(rejette) : jest.fn().mockResolvedValue(opts.ouverts ?? 0) },
    passageAgentLocal: {
      findFirst: opts.casse
        ? jest.fn(rejette)
        : jest.fn((args: { where: { agent: string } }) =>
            Promise.resolve(
              args.where.agent in passages ? passages[args.where.agent] : (opts.passageParDefaut ?? null),
            ),
          ),
    },
  };
  const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
  return { svc: new BackgroundTasksService(prisma as never, registry as never, { resteRecitTotal: async () => ({ aNarrer: 0, enAttenteDeRecalcul: 0, libelle: 'analyses sans recit que l agent prendra' }) } as never), prisma };
}

const service = (opts: Parameters<typeof construire>[0] = {}) => construire(opts).svc;

const tache = async (svc: BackgroundTasksService, id: string) => {
  const t = (await svc.list()).tasks.find((x) => x.id === id);
  expect(t).toBeDefined();
  return t!;
};

describe('Agents du poste — traçabilité dans l’espace admin', () => {
  it('⚠️ CHAQUE agent du poste porte une trace : sans elle, sa colonne reste vide', async () => {
    const svc = service({ passageParDefaut: passage() });
    const locaux = (await svc.list()).tasks.filter((t) => t.executor === 'poste-local');

    expect(locaux.length).toBeGreaterThanOrEqual(5);
    for (const t of locaux) {
      // Le trou d'origine : `lastRunAt` et l'état restaient nuls pour ces lignes-là.
      expect(t.traceLocale).not.toBeNull();
      expect(t.lastRunAt).not.toBeNull();
      expect(t.traceLocale!.depuis).toBeTruthy();
      expect(t.traceLocale!.cadenceMs).toBeGreaterThan(0);
      // L'alarme ne crie jamais AVANT que l'agent ne soit seulement considéré en retard :
      // deux seuils qui se contredisent à l'écran ne veulent plus rien dire.
      expect(t.traceLocale!.seuilSilenceMs).toBeGreaterThanOrEqual(2 * t.traceLocale!.cadenceMs);
    }
  });

  it('aucun cron du SERVEUR ne porte de trace du poste — il a le registre NestJS pour preuve', async () => {
    const svc = service({ passageParDefaut: passage() });
    const serveur = (await svc.list()).tasks.filter((t) => t.executor === 'serveur');
    expect(serveur.every((t) => t.traceLocale === null)).toBe(true);
  });

  it('passage récent et abouti → sain, et la date est celle de la FIN du passage', async () => {
    const fini = new Date(Date.now() - 2 * HEURE);
    const t = await tache(service({ passages: { 'agent-qualite-gps': passage({ finiA: fini }) } }), 'agent-qualite-gps');
    expect(t.traceLocale!.etat).toBe('sain');
    expect(t.traceLocale!.issue).toBe('succes');
    expect(t.lastRunAt).toBe(fini.toISOString());
    expect(t.traceLocale!.dernierPassageAt).toBe(fini.toISOString());
  });

  it('⚠️ AU-DELÀ DE DEUX FOIS LA CADENCE, la ligne le DIT — c’est tout l’enjeu', async () => {
    // Récit de trajet : un passage par nuit, donc l'alarme à 48 h. Trois jours de silence.
    const t = await tache(
      service({ passages: { 'agent-recit-trajet': passage({ finiA: new Date(Date.now() - 72 * HEURE) }) } }),
      'agent-recit-trajet',
    );
    expect(t.traceLocale!.etat).toBe('silencieux');
    expect(t.traceLocale!.depuis).toBe('3 jours');
    expect(t.traceLocale!.message).toBe('Aucun passage depuis 3 jours — la tâche tourne-t-elle sur le poste ?');
  });

  it('entre la cadence et son double : « en retard », pas « silencieux » — on ne crie pas trop tôt', async () => {
    const t = await tache(
      service({ passages: { 'agent-qualite-gps': passage({ finiA: new Date(Date.now() - 40 * HEURE) }) } }),
      'agent-qualite-gps',
    );
    expect(t.traceLocale!.etat).toBe('retard');
    // Le contrat historique tient : au-delà de sa fenêtre de fraîcheur, l'agent n'est plus « sain ».
    expect(t.enabled).toBe(false);
  });

  it('un passage FRAIS mais en ÉCHEC n’est pas un silence : le poste répond, et il rate', async () => {
    const t = await tache(
      service({ passages: { 'agent-qualite-gps': passage({ succes: false, erreur: 'ssh: connexion refusee' }) } }),
      'agent-qualite-gps',
    );
    expect(t.traceLocale!.etat).toBe('echec');
    expect(t.traceLocale!.issue).toBe('echec');
    expect(t.traceLocale!.message).toContain('ssh: connexion refusee');
    expect(t.enabled).toBe(false);
  });

  it('jamais vu passer → INCONNU, jamais « silencieux » : on n’accuse pas sans preuve', async () => {
    const t = await tache(service({ passages: { 'agent-qualite-gps': null } }), 'agent-qualite-gps');
    expect(t.traceLocale!.etat).toBe('inconnu');
    expect(t.traceLocale!.depuisMs).toBeNull();
    expect(t.enabled).toBeNull();
    expect(t.traceLocale!.message).toContain('Planificateur');
  });

  /**
   * Le contre-poison de l'exigence n° 2. Une tâche qui a FINI son travail n'écrit plus rien : la
   * déclarer en panne reviendrait à crier sur un succès, et un écran qui crie sur les succès
   * finit par ne plus être lu — c'est alors la vraie panne qui passe inaperçue.
   */
  it('⚠️ silence VOULU (arriéré résorbé) → « sans objet », et surtout aucune alarme', async () => {
    const t = await tache(
      service({
        passages: { 'rattrapage-recits': passage({ finiA: new Date(Date.now() - 30 * 24 * HEURE) }) },
        restantsSansRecit: 0,
      }),
      'rattrapage-recits',
    );
    expect(t.traceLocale!.etat).toBe('sans-objet');
    expect(t.traceLocale!.message).toContain('normal');
    expect(t.enabled).toBe(true);
  });

  /**
   * Le journal des passages répond à « a-t-il TOURNÉ ? », la production à « a-t-il TROUVÉ ? ».
   * Confondre les deux annonce « à l'arrêt » les nuits où l'agent n'avait simplement rien à faire.
   */
  it('⚠️ le JOURNAL DES PASSAGES prime sur le travail écrit', async () => {
    const fini = new Date(Date.now() - 1 * HEURE);
    const t = await tache(
      service({
        passages: { 'agent-limites-vitesse': passage({ finiA: fini }) },
        productionAt: new Date(Date.now() - 40 * HEURE), // production ancienne : il n'a rien trouvé
      }),
      'agent-limites-vitesse',
    );
    expect(t.traceLocale!.preuve).toBe('journal-passages');
    expect(t.traceLocale!.etat).toBe('sain');
    expect(t.lastRunAt).toBe(fini.toISOString());
  });

  it('sans passage journalisé, le travail écrit reste le repli — et il s’annonce comme tel', async () => {
    const ecrit = new Date(Date.now() - 2 * HEURE);
    const t = await tache(service({ passageParDefaut: null, productionAt: ecrit }), 'agent-limites-vitesse');
    expect(t.traceLocale!.preuve).toBe('travail-ecrit');
    // La production ne dit pas l'issue : l'affirmer serait inventer une information.
    expect(t.traceLocale!.issue).toBe('inconnu');
    expect(t.lastRunAt).toBe(ecrit.toISOString());
  });

  /**
   * Le piège : la clé du journal est celle que le POSTE écrit, pas l'id du catalogue. Ils
   * coïncident partout sauf pour le courrier (`agent-courrier-ia` en base, `courrier-ia` au
   * catalogue). Une « simplification » qui alignerait les deux rendrait ce seul agent muet — en
   * silence, ce qui est exactement la panne que cet écran doit rendre impossible.
   */
  it('⚠️ les CLÉS interrogées sont celles que le poste ÉCRIT, pas les id du catalogue', async () => {
    const { svc, prisma } = construire({ passageParDefaut: passage() });
    await svc.list();
    // Le mock est typé par inférence sur deux signatures (nominale / en échec) : on relit ses
    // appels tels quels plutôt que de tordre le type d'un espion.
    const appels = prisma.passageAgentLocal.findFirst.mock.calls as unknown as Array<[{ where: { agent: string } }]>;
    const demandes = appels.map((c) => c[0].where.agent);
    expect(demandes.sort()).toEqual([
      'agent-courrier-ia',
      'agent-limites-vitesse',
      'agent-qualite-gps',
      'agent-recit-trajet',
      'rattrapage-recits',
    ]);
  });

  it('⚠️ la supervision ne fait JAMAIS tomber la page qu’elle supervise', async () => {
    const reponse = await service({ casse: true }).list();
    expect(reponse.tasks.length).toBeGreaterThan(10);
    for (const t of reponse.tasks.filter((x) => x.executor === 'poste-local')) {
      // Sans trace exploitable, on n'affiche RIEN plutôt qu'un état inventé.
      expect(t.traceLocale).toBeNull();
      expect(t.enabled).toBeNull();
    }
  });
});

/**
 * ── LE LIEN DE RÉGLAGE POINTE-T-IL QUELQUE PART ? ────────────────────────────────────
 *
 * Le catalogue déclarait des routes que l'écran n'affichait jamais (le lien était conditionné à
 * `configurable`, faux pour trois entrées), et les agents du poste n'en déclaraient aucune alors
 * que leurs écrans existent. Une route morte ou invisible, c'est une promesse de traçabilité qui
 * ne mène nulle part — et ça ne se voit qu'en cliquant, donc jamais.
 */
describe('Catalogue — chaque écran annoncé existe vraiment', () => {
  const CATALOGUE = join(__dirname, 'background-tasks.service.ts');
  const ROUTES_WEB = join(__dirname, '..', '..', '..', 'web', 'src', 'app', 'app.routes.ts');

  function routesDeclarees(): string[] {
    const texte = readFileSync(CATALOGUE, 'utf8');
    return [...texte.matchAll(/settingsRoute:\s*'([^']+)'/g)].map((m) => m[1]!);
  }

  function cheminsAngular(): Set<string> {
    const texte = readFileSync(ROUTES_WEB, 'utf8');
    return new Set([...texte.matchAll(/path:\s*'([^']*)'/g)].map((m) => m[1]!));
  }

  it('⚠️ CHAQUE `settingsRoute` correspond à une route réelle de l’application', () => {
    const connus = cheminsAngular();
    expect(connus.size).toBeGreaterThan(30); // le parseur trouve bien la table de routage
    const mortes = routesDeclarees().filter((r) => !connus.has(r.replace(/^\//, '')));
    expect(mortes).toEqual([]);
    // Si ce test tombe : une entrée du catalogue promet un écran qui n'existe plus. Corriger la
    // route, ou retirer la promesse — un lien mort dans un écran de supervision se découvre le
    // jour de l'incident, c'est-à-dire au pire moment.
  });

  it('les agents du poste pointent l’écran où l’on CONSTATE ce qu’ils produisent', async () => {
    const locaux = (await service({ passageParDefaut: passage() }).list()).tasks.filter(
      (t) => t.executor === 'poste-local',
    );
    // Le courrier IA fait exception, assumée : aucun écran ne montre encore sa file de travaux.
    const orphelins = locaux.filter((t) => !t.settingsRoute).map((t) => t.id);
    expect(orphelins).toEqual(['courrier-ia']);
  });
});
