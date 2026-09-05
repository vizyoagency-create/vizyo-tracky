import { getNowInTimezone } from '../vehicle-schedules/schedule-evaluator';
import {
  AgentsLocauxSentinelleService,
  GRACE_MS,
  REFROIDISSEMENT_MS,
  SOURCE_AGENTS_LOCAUX,
} from './agents-locaux-sentinelle.service';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * ── CE QUE CES TESTS PROTÈGENT (PS du chantier C3, 2026-09-05) ────────────────────────────
 *
 * « PC éteint la nuit = le matin, tous les agents en échec. » Les agents du poste ne lèvent aucune
 * erreur serveur quand ils ne tournent pas ; la sentinelle est le seul instrument qui aille chercher
 * leur silence, et elle juge sur le DERNIER DÉCLENCHEMENT PLANIFIÉ en heure de Paris — pas sur un
 * multiple de cadence, qui n'aurait vu un PC éteint que le surlendemain.
 *
 * Horloge SIMULÉE partout : chaque cas fixe « maintenant » et le journal des passages, et lit ce
 * que la sentinelle écrit au centre d'alerte, au refroidissement et aux super-admins.
 */
const HEURE = 3_600_000;
const MINUTE = 60_000;
const PARIS = 'Europe/Paris';

/**
 * Instant UTC d'une heure murale de PARIS, sans coder le décalage été/hiver en dur : on essaie
 * les deux décalages possibles et on garde celui que l'horloge de Paris confirme.
 */
function paris(annee: number, mois: number, jour: number, heure: number, minute = 0): number {
  for (const decalage of [2, 1]) {
    const t = Date.UTC(annee, mois - 1, jour, heure - decalage, minute);
    const w = getNowInTimezone(PARIS, new Date(t));
    if (
      w.getFullYear() === annee && w.getMonth() === mois - 1 && w.getDate() === jour &&
      w.getHours() === heure && w.getMinutes() === minute
    ) return t;
  }
  throw new Error(`heure de Paris introuvable : ${annee}-${mois}-${jour} ${heure}:${minute}`);
}

interface Passage {
  demarreA: Date;
  finiA: Date;
  succes: boolean;
  resume: string | null;
  erreur: string | null;
}

function passage(demarreMs: number, over: Partial<Passage> = {}): Passage {
  return {
    demarreA: new Date(demarreMs),
    finiA: new Date(demarreMs + 20 * MINUTE),
    succes: true,
    resume: 'travail fait',
    erreur: null,
    ...over,
  };
}

function construire(opts: {
  now: number;
  /** Passages par CLÉ DU JOURNAL (celle que le poste écrit). Non listé = passage frais et réussi. */
  passages?: Record<string, Passage | null>;
  /** Reste à narrer du rattrapage : 0 = arriéré résorbé, silence légitime. */
  aNarrer?: number;
  /** Verdict du refroidissement par clé (défaut : on émet). */
  tenterEmission?: (cle: string) => boolean;
  /** Dernière émission connue par clé (défaut : jamais). */
  derniereEmission?: Record<string, Date>;
  /** Lignes que l'archivage automatique trouve. */
  archivees?: number;
  /** `null` = aucun service de notification injecté ; sinon le double fourni. */
  dispatch?: { notifyUsers: jest.Mock } | null;
  /** Clés dont la lecture du journal REJETTE (table absente, base injoignable). */
  lectureCassee?: string[];
}) {
  const passages = opts.passages ?? {};
  const prisma = {
    passageAgentLocal: {
      findFirst: jest.fn(async (args: { where: { agent: string } }) => {
        if (opts.lectureCassee?.includes(args.where.agent)) throw new Error('relation "passages_agents_locaux" does not exist');
        return args.where.agent in passages ? passages[args.where.agent] : passage(opts.now - 30 * MINUTE);
      }),
    },
    errorLog: { updateMany: jest.fn().mockResolvedValue({ count: opts.archivees ?? 0 }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'sa-1' }, { id: 'sa-2' }]) },
  };
  // Le VRAI catalogue : horaires, matcheurs de Paris et clés du journal sont ceux de production.
  const catalogue = new BackgroundTasksService(
    prisma as never,
    { getCronJobs: () => new Map(), getIntervals: () => [] } as never,
    { resteRecitTotal: async () => ({ aNarrer: opts.aNarrer ?? 5, enAttenteDeRecalcul: 0, libelle: 'analyses sans récit' }) } as never,
  );
  const errorLogger = { record: jest.fn().mockResolvedValue('id-ligne'), recordBackground: jest.fn() };
  const refroidissement = {
    tenterEmission: jest.fn(async (cle: string) => opts.tenterEmission?.(cle) ?? true),
    derniereEmission: jest.fn(async (cle: string) => opts.derniereEmission?.[cle] ?? null),
    oublier: jest.fn().mockResolvedValue(undefined),
  };
  const dispatch = opts.dispatch === null ? undefined : (opts.dispatch ?? { notifyUsers: jest.fn().mockResolvedValue(1) });
  const svc = new AgentsLocauxSentinelleService(
    prisma as never,
    catalogue,
    errorLogger as never,
    refroidissement as never,
    dispatch as never,
  );
  return { svc, prisma, errorLogger, refroidissement, dispatch };
}

/** Les lignes CRITICAL écrites, réduites à (agent, motif, message). */
function alertes(errorLogger: { record: jest.Mock }) {
  return errorLogger.record.mock.calls.map((c: [Error, string, Record<string, unknown>, string]) => ({
    source: c[1],
    level: c[3],
    agent: c[2]['agent'],
    motif: c[2]['motif'],
    message: c[0].message,
  }));
}

// Le scénario de référence : l'agent de récits est attendu à 03:15 (Paris), il a tourné la veille.
const NUIT_SANS_PC = {
  now: paris(2026, 9, 5, 5, 30),
  passages: { 'agent-recit-trajet': passage(paris(2026, 9, 4, 3, 16), { resume: '12 récits écrits' }) },
};

describe('Sentinelle des agents du poste — le matin, un PC éteint se lit au centre d’alerte', () => {
  it('⚠️ (a) attendu à 03:15, rien depuis la veille, 05:30 → CRITICAL « passage manqué » daté en heure de Paris', async () => {
    const { svc, errorLogger, refroidissement } = construire(NUIT_SANS_PC);
    await svc.verifier(NUIT_SANS_PC.now);

    expect(alertes(errorLogger)).toEqual([
      {
        source: SOURCE_AGENTS_LOCAUX,
        level: 'CRITICAL',
        agent: 'agent-recit-trajet',
        motif: 'manque',
        message:
          'Passage manqué : agent-recit-trajet attendu le 05/09/2026 à 03:15 (Paris), ' +
          'dernier passage le 04/09/2026 à 03:16 — 12 récits écrits',
      },
    ]);
    // Le contexte porte de quoi enquêter sans rouvrir le journal.
    const contexte = errorLogger.record.mock.calls[0][2];
    expect(contexte).toMatchObject({
      cleJournal: 'agent-recit-trajet',
      attenduAt: new Date(paris(2026, 9, 5, 3, 15)).toISOString(),
      dernierPassageAt: new Date(paris(2026, 9, 4, 3, 16)).toISOString(),
      resume: '12 récits écrits',
      erreur: null,
      cadenceMs: 24 * HEURE,
    });
    // Une ligne par agent, par motif et par jour : la clé et la fenêtre sont celles du cahier.
    expect(refroidissement.tenterEmission).toHaveBeenCalledWith('agent-local:agent-recit-trajet:manque', REFROIDISSEMENT_MS);
    // ⚠️ STRICTEMENT sous les 24 h : le contrôle tire toutes les heures à la même minute, et une
    // fenêtre de 24 h pile se rouvre quelques millisecondes trop tard — la ligne du lendemain
    // glissait à 06:50, puis 07:50, jusqu'à quitter la matinée (revue C3 du 2026-09-05).
    expect(REFROIDISSEMENT_MS).toBeLessThan(24 * HEURE);
    expect(REFROIDISSEMENT_MS).toBeGreaterThanOrEqual(20 * HEURE);
  });

  it('(b) à 04:00, encore dans la grâce de 2 h : rien — StartWhenAvailable peut encore rattraper', async () => {
    const now = paris(2026, 9, 5, 4, 0);
    const { svc, errorLogger } = construire({ ...NUIT_SANS_PC, now });
    await svc.verifier(now);
    expect(errorLogger.record).not.toHaveBeenCalled();
    expect(GRACE_MS).toBe(2 * HEURE);
  });

  it('(c) passage réussi à 03:20 pour le créneau de 03:15 : rien', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger } = construire({
      now,
      passages: { 'agent-recit-trajet': passage(paris(2026, 9, 5, 3, 20)) },
    });
    await svc.verifier(now);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('un passage démarré quelques secondes AVANT la minute planifiée est bien celui du créneau', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger } = construire({
      now,
      passages: { 'agent-recit-trajet': passage(paris(2026, 9, 5, 3, 15) - 40_000) },
    });
    await svc.verifier(now);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('⚠️ (d) dernier passage en ÉCHEC → CRITICAL avec le motif consigné par le poste', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger, refroidissement } = construire({
      now,
      passages: {
        'agent-recit-trajet': passage(paris(2026, 9, 5, 3, 20), {
          succes: false,
          erreur: "claude auth status : l'abonnement claude.ai n'est pas actif",
        }),
      },
    });
    await svc.verifier(now);
    expect(alertes(errorLogger)).toEqual([
      {
        source: SOURCE_AGENTS_LOCAUX,
        level: 'CRITICAL',
        agent: 'agent-recit-trajet',
        motif: 'echec',
        message:
          "Dernier passage en échec : agent-recit-trajet le 05/09/2026 à 03:20 — claude auth status : l'abonnement claude.ai n'est pas actif",
      },
    ]);
    expect(refroidissement.tenterEmission).toHaveBeenCalledWith('agent-local:agent-recit-trajet:echec', REFROIDISSEMENT_MS);
  });

  it('un créneau manqué APRÈS un échec se signale « manqué », et le message garde le motif de l’échec', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger } = construire({
      now,
      passages: {
        'agent-recit-trajet': passage(paris(2026, 9, 4, 3, 16), { succes: false, erreur: 'délai dépassé' }),
      },
    });
    await svc.verifier(now);
    const [a] = alertes(errorLogger);
    expect(a.motif).toBe('manque');
    expect(a.message).toContain('— en échec : délai dépassé');
  });

  it('⚠️ (e) refroidissement : un second passage de la sentinelle dans les 24 h n’écrit PAS de seconde ligne', async () => {
    let emissions = 0;
    const { svc, errorLogger, dispatch } = construire({
      ...NUIT_SANS_PC,
      tenterEmission: () => emissions++ === 0, // la première demande passe, les suivantes non
    });
    await svc.verifier(NUIT_SANS_PC.now);
    await svc.verifier(NUIT_SANS_PC.now + HEURE);
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    // Et la notification suit la ligne, pas la vérification : une seule aussi.
    expect(dispatch!.notifyUsers).toHaveBeenCalledTimes(1);
  });

  it('⚠️ (f) résolution : un passage réussi POSTÉRIEUR archive les lignes ouvertes de l’agent et oublie l’épisode', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const demarreA = new Date(paris(2026, 9, 5, 3, 20));
    const { svc, prisma, refroidissement } = construire({
      now,
      passages: { 'agent-recit-trajet': { ...passage(demarreA.getTime()), demarreA } },
      archivees: 1,
      derniereEmission: {
        // Émise hier matin, donc AVANT le passage réussi : épisode clos.
        'agent-local:agent-recit-trajet:manque': new Date(paris(2026, 9, 4, 5, 50)),
        // Émise APRÈS le passage (autre épisode, déjà en cours) : on n'y touche pas.
        'agent-local:agent-recit-trajet:echec': new Date(paris(2026, 9, 5, 4, 50)),
      },
    });
    await svc.verifier(now);

    const appel = prisma.errorLog.updateMany.mock.calls.find(
      (c: [{ where: { context: { equals: string } } }]) => c[0].where.context.equals === 'agent-recit-trajet',
    );
    expect(appel).toBeDefined();
    expect(appel![0]).toEqual({
      where: {
        source: SOURCE_AGENTS_LOCAUX,
        resolvedAt: null,
        // La borne qui rend l'archivage juste : une ligne écrite après la FIN de ce passage reste
        // ouverte. La fin, et non le début : le journal du poste n'existe qu'à la fin du passage,
        // et un passage lancé à 05:41 (rattrapage au démarrage du PC) qui se termine à 05:58
        // répond bel et bien à la ligne écrite à 05:50 (revue C3 du 2026-09-05).
        createdAt: { lt: new Date(demarreA.getTime() + 20 * MINUTE) },
        // Chemin JSON, pas `message contains` : « courrier-ia » est contenu dans « agent-courrier-ia ».
        context: { path: ['agent'], equals: 'agent-recit-trajet' },
      },
      data: {
        resolvedAt: new Date(now),
        resolvedNote: 'Agent repassé le 05/09/2026 à 03:20 (résolution automatique)',
      },
    });
    expect(refroidissement.oublier).toHaveBeenCalledWith('agent-local:agent-recit-trajet:manque');
    expect(refroidissement.oublier).not.toHaveBeenCalledWith('agent-local:agent-recit-trajet:echec');
    expect(refroidissement.oublier).not.toHaveBeenCalledWith('agent-local:agent-recit-trajet:jamais');
  });

  it('un passage en échec ne referme rien : l’épisode reste ouvert', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, prisma, refroidissement } = construire({
      now,
      passages: { 'agent-recit-trajet': passage(paris(2026, 9, 5, 3, 20), { succes: false, erreur: 'x' }) },
      derniereEmission: { 'agent-local:agent-recit-trajet:manque': new Date(paris(2026, 9, 4, 5, 50)) },
    });
    await svc.verifier(now);
    const pourRecit = prisma.errorLog.updateMany.mock.calls.filter(
      (c: [{ where: { context: { equals: string } } }]) => c[0].where.context.equals === 'agent-recit-trajet',
    );
    expect(pourRecit).toEqual([]);
    expect(refroidissement.oublier).not.toHaveBeenCalledWith('agent-local:agent-recit-trajet:manque');
  });

  it('⚠️ (g) rattrapage SANS OBJET (arriéré résorbé) : aucun passage manqué, même après dix jours', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger } = construire({
      now,
      passages: { 'rattrapage-recits': passage(now - 10 * 24 * HEURE) },
      aNarrer: 0,
    });
    await svc.verifier(now);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('…mais tant qu’il reste des récits à écrire, le rattrapage est attendu aux heures paires de Paris', async () => {
    // À 06:30, le tick de 06:00 est encore dans sa grâce ; celui de 04:00 ne l'est plus : c'est LUI
    // qui est manqué. Juger « le dernier tick + grâce » ne verrait jamais rien pour cet agent — avec
    // une période de 2 h et une grâce de 2 h, le tick suivant arrive toujours avant que la grâce du
    // dernier ne s'écoule. Le premier jeu d'essai l'a montré : ce cas restait muet.
    const now = paris(2026, 9, 5, 6, 30);
    const { svc, errorLogger } = construire({
      now,
      passages: { 'rattrapage-recits': passage(now - 10 * 24 * HEURE) },
      aNarrer: 5,
    });
    await svc.verifier(now);
    const [a] = alertes(errorLogger);
    expect(a).toMatchObject({ agent: 'rattrapage-recits', motif: 'manque' });
    expect(a.message).toContain('attendu le 05/09/2026 à 04:00 (Paris)');
  });

  it('⚠️ (i) agent JAMAIS journalisé → CRITICAL « jamais » : la tâche est-elle inscrite au Planificateur ?', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger, refroidissement } = construire({ now, passages: { 'agent-qualite-gps': null } });
    await svc.verifier(now);
    expect(alertes(errorLogger)).toEqual([
      {
        source: SOURCE_AGENTS_LOCAUX,
        level: 'CRITICAL',
        agent: 'agent-qualite-gps',
        motif: 'jamais',
        message: 'Agent du poste jamais journalisé : agent-qualite-gps',
      },
    ]);
    expect(refroidissement.tenterEmission).toHaveBeenCalledWith('agent-local:agent-qualite-gps:jamais', REFROIDISSEMENT_MS);
  });

  it('⚠️ le matin, TOUS les agents manquants sont en échec — cinq lignes, une par agent', async () => {
    // PC éteint depuis l'avant-veille au soir : tous les créneaux de la nuit sont perdus.
    const now = paris(2026, 9, 5, 7, 50);
    const ancien = passage(paris(2026, 9, 3, 22, 0));
    const { svc, errorLogger } = construire({
      now,
      passages: {
        'agent-limites-vitesse': ancien,
        'agent-recit-trajet': ancien,
        'rattrapage-recits': ancien,
        'agent-qualite-gps': ancien,
        'agent-courrier-ia': ancien,
      },
    });
    await svc.verifier(now);
    const lignes = alertes(errorLogger);
    expect(lignes.map((l) => l.agent).sort()).toEqual([
      'agent-limites-vitesse',
      'agent-qualite-gps',
      'agent-recit-trajet',
      'courrier-ia',
      'rattrapage-recits',
    ]);
    expect(lignes.every((l) => l.motif === 'manque' && l.level === 'CRITICAL')).toBe(true);
  });

  it('⚠️ les CLÉS interrogées sont celles que le poste ÉCRIT — le courrier journalise sous « agent-courrier-ia »', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, prisma } = construire({ now });
    await svc.verifier(now);
    const demandes = prisma.passageAgentLocal.findFirst.mock.calls.map((c: [{ where: { agent: string } }]) => c[0].where.agent);
    expect(demandes.sort()).toEqual([
      'agent-courrier-ia',
      'agent-limites-vitesse',
      'agent-qualite-gps',
      'agent-recit-trajet',
      'rattrapage-recits',
    ]);
  });

  describe('prévenir les super-admins', () => {
    it('chaque NOUVELLE ligne part en push aux super-admins actifs, catégorie SYSTEM, vers le centre d’alerte', async () => {
      const { svc, dispatch, prisma } = construire(NUIT_SANS_PC);
      await svc.verifier(NUIT_SANS_PC.now);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { id: true },
      });
      expect(dispatch!.notifyUsers).toHaveBeenCalledWith({
        userIds: ['sa-1', 'sa-2'],
        category: 'SYSTEM',
        kind: 'agent-local-absent',
        subjectKey: 'agent-recit-trajet',
        title: 'Agent du poste en alerte',
        body: expect.stringContaining('Passage manqué : agent-recit-trajet'),
        url: '/admin/alerts',
      });
    });

    it('un envoi qui échoue est avalé : la ligne du centre d’alerte prime, la vérification continue', async () => {
      const now = paris(2026, 9, 5, 5, 30);
      const { svc, errorLogger } = construire({
        now,
        passages: { 'agent-recit-trajet': passage(paris(2026, 9, 4, 3, 16)), 'agent-qualite-gps': null },
        dispatch: { notifyUsers: jest.fn().mockRejectedValue(new Error('push down')) },
      });
      await expect(svc.verifier(now)).resolves.toBeUndefined();
      expect(alertes(errorLogger).map((a) => a.motif).sort()).toEqual(['jamais', 'manque']);
    });

    it('sans service de notification injecté, la ligne est écrite quand même', async () => {
      const { svc, errorLogger } = construire({ ...NUIT_SANS_PC, dispatch: null });
      await svc.verifier(NUIT_SANS_PC.now);
      expect(errorLogger.record).toHaveBeenCalledTimes(1);
    });
  });

  it('⚠️ un journal ILLISIBLE n’est pas un agent « jamais vu » : ligne ERROR nommée, et les autres agents sont examinés', async () => {
    const now = paris(2026, 9, 5, 5, 30);
    const { svc, errorLogger, dispatch } = construire({
      now,
      lectureCassee: ['agent-limites-vitesse'],
      passages: { 'agent-recit-trajet': passage(paris(2026, 9, 4, 3, 16)) },
    });
    await svc.verifier(now);
    // Pas de CRITICAL « jamais » pour l'agent dont la lecture a échoué…
    expect(alertes(errorLogger)).toEqual([expect.objectContaining({ agent: 'agent-recit-trajet', motif: 'manque' })]);
    // …mais une ligne ERROR qui nomme l'opération, avec le motif technique en fin de phrase.
    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    const [err, source, contexte, niveau] = errorLogger.recordBackground.mock.calls[0];
    expect(source).toBe(SOURCE_AGENTS_LOCAUX);
    expect(niveau).toBe('ERROR');
    expect(contexte).toMatchObject({ agent: 'agent-limites-vitesse', motif: 'lecture' });
    expect((err as Error).message).toBe(
      'Journal des passages illisible pour agent-limites-vitesse : relation "passages_agents_locaux" does not exist',
    );
    // Et l'on ne réveille personne pour une base illisible.
    expect(dispatch!.notifyUsers).toHaveBeenCalledTimes(1);
  });
});
