import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationDisabledException } from '../common/automation-disabled.exception';
import { AgendaAgentRunnerService } from './agenda-agent-runner.service';
import { AGENDA_AGENT_SCHEMA } from './agenda-agent.prompt';
import { fleetTzFormatter, localParts } from './fleet-tz.util';
import type { RecurringPattern } from './recurrence-detector.service';

const PATTERN: RecurringPattern = {
  vehicleId: 'v1',
  vehiclePlate: 'AA-1',
  dayOfWeek: 1, // lundi : une occurrence future existe toujours dans l'horizon 14 j
  startMinutes: 9 * 60,
  endMinutes: 12 * 60,
  destLat: 43.21,
  destLng: 2.35,
  destinationLabel: 'Carcassonne',
  itinerary: ['Carcassonne'],
  roundTripFromDepot: false,
  zones: [],
  activeWeeks: 9,
  confidence: 0.9,
  basis: 'Observé 9/10 lundis',
};
/** Second motif (mardi) : sert aux verdicts multi-motifs. */
const PATTERN_2: RecurringPattern = { ...PATTERN, vehicleId: 'v2', vehiclePlate: 'BB-2', dayOfWeek: 2, destinationLabel: 'Narbonne', itinerary: ['Narbonne'] };

/** Jour Paris courant : la clé d'idempotence nocturne le porte. */
const dateKeyDuJour = () => localParts(fleetTzFormatter(), Date.now()).dateKey;

function makeSettings(over: Record<string, unknown> = {}) {
  return {
    enabled: true, autonomy: 'auto_high_confidence', confidenceThreshold: 80,
    nightlyHour: 2, frequency: 'daily', triggerNightly: true, lastRunAt: null, ...over,
  };
}

/**
 * Prisma mocké. Les créations de propositions rendent un identifiant SÉQUENTIEL (`p1`, `p2`…) :
 * c'est ce que le producteur range dans le travail de jugement, motif par motif — un mock qui
 * rendrait `{}` ferait passer un enfilage sans propositions pour un enfilage réussi.
 */
function makePrisma(settings: unknown, existingProposal: unknown = null) {
  let seq = 0;
  return {
    agendaAgentSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    agendaAgentProposal: {
      findUnique: jest.fn().mockResolvedValue(existingProposal),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async () => ({ id: `p${++seq}` })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    fleet: { findUnique: jest.fn().mockResolvedValue({ metier: 'CHILDREN_TRANSPORT', name: 'CDEF' }) },
    // Historique des passages : présent dans le mock pour que les tests exercent la VRAIE
    // écriture (sinon tout partirait dans le catch défensif de recordRun sans qu'on le voie).
    // `create` rend un identifiant : c'est le `runId` que porte le travail de jugement.
    agendaAgentRun: {
      create: jest.fn().mockResolvedValue({ id: 'run-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
type PrismaMock = ReturnType<typeof makePrisma>;
/** Accès typé au mock d'historique. */
const runsOf = (prisma: PrismaMock) => prisma.agendaAgentRun;
const proposalsOf = (prisma: PrismaMock) => prisma.agendaAgentProposal;

/**
 * File des travaux du poste, mockée : `faits` rend ce que le courrier aurait livré. L'agent ne
 * connaît la file que par ces cinq méthodes — c'est tout le contrat (design/C1, C3 point 7).
 */
function makeTravauxIa(faits: unknown[] = []) {
  return {
    enfiler: jest.fn().mockResolvedValue({ enfile: true, id: 't1' }),
    reprendrePerimes: jest.fn().mockResolvedValue({ repris: 0, abandonnes: 0, plafonnes: 0 }),
    faits: jest.fn().mockResolvedValue(faits),
    consommer: jest.fn().mockResolvedValue(undefined),
    rejeter: jest.fn().mockResolvedValue(undefined),
  };
}
const makeAiUsage = () => ({ record: jest.fn().mockResolvedValue(undefined) });
/**
 * Détecteur mocké. `detectWithStats` est la SEULE méthode que l'agent appelle : il ne choisit pas
 * ses véhicules, il applique les motifs qu'on lui donne — c'est donc le détecteur qui écarte les
 * boîtiers muets, et l'agent qui doit rendre ces exclusions visibles.
 */
function makeDetector(
  patterns: RecurringPattern[],
  excluded: { skippedDormantVehicles?: number; skippedStalePatterns?: number } = {},
) {
  return {
    detectWithStats: jest.fn().mockResolvedValue({
      patterns,
      skippedDormantVehicles: excluded.skippedDormantVehicles ?? 0,
      skippedStalePatterns: excluded.skippedStalePatterns ?? 0,
    }),
  };
}
function makeReservations(over: Record<string, unknown> = {}) {
  return {
    systemConfirm: jest.fn().mockResolvedValue({ id: 'ev1', vehiclePlate: 'AA-1' }),
    isVehicleFree: jest.fn().mockResolvedValue(true),
    ...over,
  };
}
const makeEvents = () => ({ assertVehicleAccess: jest.fn().mockResolvedValue('f1') });
const makeActivity = () => ({ record: jest.fn() });
const makeErrors = () => ({ record: jest.fn().mockResolvedValue('log-1') });
/** Porte IA de la société : `null` = service absent (specs historiques), sinon sa réponse. */
const makeAiAvail = (on: boolean) => ({ isFeatureOnForFleet: jest.fn().mockResolvedValue(on) });

/**
 * Monte le service avec des doubles cohérents. `aiOn` : `undefined` = pas de service de
 * disponibilité IA (comme les specs d'avant le 05/09 → jamais d'enfilage) ; true/false = réponse
 * de la porte IA de la société.
 */
function monter(opts: {
  settings?: unknown;
  existing?: unknown;
  patterns?: RecurringPattern[];
  excluded?: { skippedDormantVehicles?: number; skippedStalePatterns?: number };
  reservations?: ReturnType<typeof makeReservations>;
  detector?: { detectWithStats: jest.Mock };
  aiOn?: boolean;
  faits?: unknown[];
} = {}) {
  const prisma = makePrisma(opts.settings === undefined ? makeSettings() : opts.settings, opts.existing ?? null);
  const detector = opts.detector ?? makeDetector(opts.patterns ?? [PATTERN], opts.excluded);
  const reservations = opts.reservations ?? makeReservations();
  const activity = makeActivity();
  const errors = makeErrors();
  const aiUsage = makeAiUsage();
  const travauxIa = makeTravauxIa(opts.faits);
  const aiAvail = opts.aiOn === undefined ? undefined : makeAiAvail(opts.aiOn);
  const svc = new AgendaAgentRunnerService(
    prisma as never, detector as never, reservations as never, makeEvents() as never, activity as never,
    travauxIa as never, aiUsage as never, errors as never, aiAvail as never,
  );
  return { svc, prisma, detector, reservations, activity, errors, aiUsage, travauxIa, aiAvail };
}

/** Un travail `jugement-agenda` tel que le courrier le laisse en `fait` (nouveau format de résultat). */
function travailFait(reviews: unknown, over: { contexte?: Record<string, unknown>; resultat?: Record<string, unknown> } = {}) {
  return {
    id: 't1',
    resultat: {
      contenu: { reviews },
      modele: 'claude-sonnet-4-5-20250929',
      usage: { inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 28000 },
      coutEquivalentUsd: 0.0123,
      dureeMs: 4200,
      ...over.resultat,
    },
    contexte: {
      cleIdempotence: `jugement-agenda:f1:${dateKeyDuJour()}`,
      fleetId: 'f1',
      runId: 'run-1',
      dateKey: dateKeyDuJour(),
      motifs: [
        { index: 0, proposalIds: ['p1'] },
        { index: 1, proposalIds: ['p2', 'p3'] },
      ],
      ...over.contexte,
    },
    payload: {},
  };
}

describe('AgendaAgentRunnerService (P3.3 — agent nocturne)', () => {
  it('auto (confiance ≥ seuil) : crée des réservations FERMES (auto_applied)', async () => {
    const { svc, prisma, reservations } = monter();

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.created).toBeGreaterThanOrEqual(1);
    expect(reservations.systemConfirm).toHaveBeenCalled();
    const data = proposalsOf(prisma).create.mock.calls[0][0].data;
    expect(data.status).toBe('auto_applied');
    expect(data.createdEventId).toBe('ev1');
  });

  it('suggestions seules : ne réserve PAS, ajoute des propositions pending', async () => {
    const { svc, prisma, reservations } = monter({ settings: makeSettings({ autonomy: 'suggest' }) });

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.proposed).toBeGreaterThanOrEqual(1);
    expect(res.created).toBe(0);
    expect(reservations.systemConfirm).not.toHaveBeenCalled();
    const data = proposalsOf(prisma).create.mock.calls[0][0].data;
    expect(data.status).toBe('pending');
  });

  /**
   * Historique des passages. Jusqu'ici seul `lastRunAt` survivait : on savait QUAND l'agent avait
   * tourné, jamais ce qu'il avait fait. Le test le plus important est le dernier : la traçabilité
   * ne doit JAMAIS faire échouer un passage qui, lui, a bien travaillé.
   */
  describe('historique des passages', () => {
    it('archive un passage réussi avec ce qu\'il a fait (motifs, créées, proposées, ignorées)', async () => {
      const { svc, prisma } = monter();

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(runsOf(prisma).create).toHaveBeenCalledTimes(1);
      const data = runsOf(prisma).create.mock.calls[0]![0].data;
      expect(data).toEqual(expect.objectContaining({
        fleetId: 'f1', origin: 'scheduled', status: 'completed',
        patterns: 1, created: res.created, proposed: res.proposed, skipped: res.skipped,
        aiUsed: false, // aucune couche IA branchée dans ce test
      }));
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
      expect(data.finishedAt).toBeInstanceOf(Date);
    });

    /**
     * Avant le 05/09, `aiUsed` était vrai dès la création quand l'appel API avait jugé. Le
     * jugement passe désormais par la file du poste (design/C3 point 7) : à la création, l'IA
     * n'a encore rien dit, même ouverte pour la société — c'est la consommation du verdict qui
     * marque le passage (voir « consommerJugements »).
     */
    it('n\'écrit PAS aiUsed à la création, même IA ouverte : le verdict n\'est pas encore rendu', async () => {
      const { svc, prisma, travauxIa } = monter({ aiOn: true });

      await svc.runForFleet('f1', 'scheduled');

      expect(travauxIa.enfiler).toHaveBeenCalledTimes(1); // le jugement est bien parti
      expect(runsOf(prisma).create.mock.calls[0]![0].data.aiUsed).toBe(false);
    });

    it('archive AUSSI un passage en échec (sinon un agent cassé passerait pour un agent inactif)', async () => {
      const detector = { detectWithStats: jest.fn().mockRejectedValue(new Error('détecteur HS')) };
      const { svc, prisma } = monter({ detector });

      await expect(svc.runForFleet('f1', 'scheduled')).rejects.toThrow('détecteur HS');

      const data = runsOf(prisma).create.mock.calls[0]![0].data;
      expect(data).toEqual(expect.objectContaining({ status: 'error', error: 'détecteur HS' }));
    });

    it('élague au-delà du plafond par société', async () => {
      const { svc, prisma } = monter();
      runsOf(prisma).findMany.mockResolvedValue([{ id: 'vieux-1' }, { id: 'vieux-2' }]);

      await svc.runForFleet('f1', 'scheduled');

      expect(runsOf(prisma).deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['vieux-1', 'vieux-2'] } } });
    });

    it('⚠️ un historique qui échoue ne casse PAS le passage — et le jugement part quand même, sans runId', async () => {
      const { svc, prisma, reservations, travauxIa } = monter({ aiOn: true });
      runsOf(prisma).create.mockRejectedValue(new Error('table absente'));

      const res = await svc.runForFleet('f1', 'scheduled');

      // Le travail utile a bien eu lieu, malgré la traçabilité en panne.
      expect(res.created).toBeGreaterThanOrEqual(1);
      expect(reservations.systemConfirm).toHaveBeenCalled();
      // Les propositions seront jugées ; seul le badge « IA » du passage manquera.
      expect(travauxIa.enfiler).toHaveBeenCalledTimes(1);
      expect(travauxIa.enfiler.mock.calls[0][2]).toEqual(expect.objectContaining({ runId: null }));
    });
  });

  it('dédup : une occurrence déjà proposée n\'est pas recréée (skipped)', async () => {
    const { svc, prisma, reservations } = monter({ existing: { id: 'existing' } });

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.created).toBe(0);
    expect(proposalsOf(prisma).create).not.toHaveBeenCalled();
    expect(reservations.systemConfirm).not.toHaveBeenCalled();
  });

  /**
   * design/C3 point 7 (2026-09-05) — le jugement de l'IA passe par la file du poste.
   *
   * Jusqu'ici chaque passage appelait l'API AVANT de créer les propositions (12 appels en 30 j
   * pour la seule société cdef31 ; passage du 04/09 tombé sur un compte à sec — TRK-061). Le
   * propriétaire veut un coût API automatique de 0 pour l'agenda : la détection reste au serveur,
   * les propositions naissent tout de suite avec leur phrase mécanique, et UN travail
   * `jugement-agenda` part pour le courrier du poste avec la liste des propositions par motif.
   *
   * Les anciens tests « échec de la couche IA → AGENDA_AGENT_AI » et « TRK-061 : compte à sec →
   * DEGRADATION » n'ont plus d'objet : il n'y a plus d'appel modèle à faire échouer ici. Leur
   * rôle — un verdict IA défaillant ne casse jamais l'agent et se voit — est repris par
   * « consommerJugements » (résultat invalide → `rejeter`, rien modifié) et par la file elle-même
   * (3 tentatives, alerte et ligne d'usage `ok=false` — travaux-ia.service.spec.ts).
   */
  describe('producteur : le jugement part vers la file du poste (design/C3 point 7)', () => {
    it('(a) passage planifié : propositions créées AUSSITÔT + UN travail enfilé avec prompt, schéma, données et propositions par motif', async () => {
      const { svc, prisma, travauxIa, aiUsage, aiAvail } = monter({ settings: makeSettings({ autonomy: 'suggest' }), aiOn: true });

      const res = await svc.runForFleet('f1', 'scheduled');

      // Les propositions existent avant tout verdict, avec la phrase mécanique.
      const creations = proposalsOf(prisma).create.mock.calls;
      expect(creations.length).toBeGreaterThanOrEqual(1);
      expect(creations[0][0].data.reasoning).toContain('projetée par l\'agent');
      expect(res.proposed).toBe(creations.length);
      expect(res.aiVerdictQueued).toBe(true);
      expect(aiAvail!.isFeatureOnForFleet).toHaveBeenCalledWith('f1', 'agendaAgent');

      expect(travauxIa.enfiler).toHaveBeenCalledTimes(1);
      const [type, payload, contexte] = travauxIa.enfiler.mock.calls[0];
      expect(type).toBe('jugement-agenda');
      expect(payload).toEqual({
        system: expect.stringContaining("transport d'enfants"), // métier de la société dans le prompt
        schema: AGENDA_AGENT_SCHEMA,
        userPayload: expect.objectContaining({
          fleetName: 'CDEF',
          metier: 'CHILDREN_TRANSPORT',
          patterns: [expect.objectContaining({ index: 0, plate: 'AA-1', dayOfWeek: 1, start: '09:00', end: '12:00', destination: 'Carcassonne', itinerary: ['Carcassonne'], weeksObserved: 9 })],
        }),
        maxTokens: 16000,
      });
      expect(contexte).toEqual({
        cleIdempotence: `jugement-agenda:f1:${dateKeyDuJour()}`,
        fleetId: 'f1',
        runId: 'run-1',
        dateKey: dateKeyDuJour(),
        motifs: [{ index: 0, proposalIds: creations.map((_, i) => `p${i + 1}`) }],
      });
      // Aucun usage à la création : la ligne s'écrit à la consommation, avec les jetons réels.
      expect(aiUsage.record).not.toHaveBeenCalled();
    });

    it('(a bis) le service ne contient plus aucun appel synchrone au routeur IA', () => {
      // Garde mécanique : si quelqu'un rebranche `AiRouter.completeJson` dans l'agent, ce test
      // rougit — c'est précisément le chemin qui coûtait des crédits la nuit et au clic.
      const source = readFileSync(join(__dirname, 'agenda-agent-runner.service.ts'), 'utf8');
      expect(source).not.toMatch(/completeJson\(/);
      expect(source).not.toMatch(/from '\.\.\/ai\/ai-router\.service'/);
    });

    it('(b) passage manuel : même chemin, clé d\'idempotence DISTINCTE (origine + horodatage)', async () => {
      const { svc, travauxIa } = monter({ settings: makeSettings({ autonomy: 'suggest' }), aiOn: true });

      const res = await svc.runForFleet('f1', 'manual');

      expect(res.aiVerdictQueued).toBe(true);
      expect(travauxIa.enfiler).toHaveBeenCalledTimes(1);
      const contexte = travauxIa.enfiler.mock.calls[0][2];
      expect(contexte.cleIdempotence).toMatch(new RegExp(`^jugement-agenda:f1:${dateKeyDuJour()}:manuel:\\d+$`));
      expect(contexte.cleIdempotence).not.toBe(`jugement-agenda:f1:${dateKeyDuJour()}`);
      expect(travauxIa.enfiler.mock.calls[0][1]).toEqual(expect.objectContaining({ maxTokens: 16000 }));
    });

    it('(b bis) autonomie haute : les réservations FERMES partent comme avant, et sont soumises au verdict', async () => {
      const { svc, prisma, reservations, travauxIa } = monter({ aiOn: true });

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(res.created).toBeGreaterThanOrEqual(1);
      expect(reservations.systemConfirm).toHaveBeenCalled();
      const ids = proposalsOf(prisma).create.mock.calls.map((_, i) => `p${i + 1}`);
      expect(travauxIa.enfiler.mock.calls[0][2].motifs).toEqual([{ index: 0, proposalIds: ids }]);
    });

    it('(c) IA coupée pour la société : aucun enfilage, propositions quand même', async () => {
      const { svc, prisma, travauxIa } = monter({ settings: makeSettings({ autonomy: 'suggest' }), aiOn: false });

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(res.proposed).toBeGreaterThanOrEqual(1);
      expect(proposalsOf(prisma).create).toHaveBeenCalled();
      expect(travauxIa.enfiler).not.toHaveBeenCalled();
      expect(res.aiVerdictQueued).toBe(false);
    });

    it('(c bis) sans service de disponibilité IA (specs historiques) : jamais d\'enfilage', async () => {
      const { svc, travauxIa } = monter({ settings: makeSettings({ autonomy: 'suggest' }) });

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(travauxIa.enfiler).not.toHaveBeenCalled();
      expect(res.aiVerdictQueued).toBe(false);
    });

    it('(c ter) rien de neuf à juger (toutes les occurrences déjà proposées) : pas de travail, porte IA pas même consultée', async () => {
      const { svc, travauxIa, aiAvail } = monter({ existing: { id: 'existing' }, aiOn: true });

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(travauxIa.enfiler).not.toHaveBeenCalled();
      expect(aiAvail!.isFeatureOnForFleet).not.toHaveBeenCalled();
      expect(res.aiVerdictQueued).toBe(false);
    });

    it('(c quater) file injoignable : le passage reste réussi, l\'échec est au centre d\'alerte (AGENDA_AGENT)', async () => {
      const { svc, prisma, travauxIa, errors, activity } = monter({ settings: makeSettings({ autonomy: 'suggest' }), aiOn: true });
      travauxIa.enfiler.mockRejectedValue(new Error('file indisponible'));

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(res.proposed).toBeGreaterThanOrEqual(1);
      expect(res.aiVerdictQueued).toBe(false);
      // UNE ligne d'historique, en succès : les propositions existent, le passage a travaillé.
      expect(runsOf(prisma).create).toHaveBeenCalledTimes(1);
      expect(runsOf(prisma).create.mock.calls[0][0].data.status).toBe('completed');
      expect(errors.record).toHaveBeenCalledWith(
        expect.any(Error), 'AGENDA_AGENT', expect.objectContaining({ fleetId: 'f1', phase: 'enfilerJugement' }),
      );
      // Le journal Système ne promet pas un avis qui ne viendra pas.
      expect(activity.record.mock.calls[0][0].detail).not.toContain('avis de l\'IA');
      expect(activity.record.mock.calls[0][0].meta).toEqual(expect.objectContaining({ aiVerdictQueued: false }));
    });

    it('le journal Système dit qu\'un avis est attendu quand le travail est parti', async () => {
      const { svc, activity } = monter({ settings: makeSettings({ autonomy: 'suggest' }), aiOn: true });

      await svc.runForFleet('f1', 'scheduled');

      expect(activity.record.mock.calls[0][0].detail).toContain('avis de l\'IA confié au poste');
    });
  });

  /**
   * Le consommateur range ce que le courrier a rendu. Deux motifs : le premier écarté, le second
   * conservé. Le motif écarté porte UNE proposition ; le conservé en porte deux.
   */
  describe('consommerJugements : range les verdicts du poste (design/C3 point 7)', () => {
    it('(d) keep=false → dismissed avec la raison de l\'IA ; keep=true → raisonnement remplacé ; verdict posé, passage aiUsed, usage local, travail consommé', async () => {
      const faits = [travailFait([
        { index: 0, keep: false, reasoning: 'Récurrence trop instable' },
        { index: 1, keep: true, reasoning: 'Ce véhicule va presque tous les mardis à Narbonne' },
      ])];
      const { svc, prisma, travauxIa, aiUsage } = monter({ faits });

      const res = await svc.consommerJugements();

      expect(res).toEqual({ ranges: 1, rejetes: 0 });
      expect(travauxIa.reprendrePerimes).toHaveBeenCalledTimes(1);
      const maj = proposalsOf(prisma).updateMany.mock.calls.map((c) => c[0]);
      // Motif 0, écarté : seules les propositions ENCORE pending sont écartées.
      expect(maj).toContainEqual({
        where: { id: { in: ['p1'] }, status: 'pending' },
        data: { status: 'dismissed', reasoning: 'Écartée par l\'IA : Récurrence trop instable', aiVerdictAt: expect.any(Date), aiKeep: false },
      });
      // Motif 1, conservé : la phrase mécanique cède la place au « pourquoi » de l'IA.
      expect(maj).toContainEqual({
        where: { id: { in: ['p2', 'p3'] }, status: 'pending' },
        data: { reasoning: 'Ce véhicule va presque tous les mardis à Narbonne', aiVerdictAt: expect.any(Date), aiKeep: true },
      });
      // Les réservations fermes portent le verdict, sans changement de statut.
      expect(maj).toContainEqual({ where: { id: { in: ['p1'] }, status: 'auto_applied' }, data: { aiVerdictAt: expect.any(Date), aiKeep: false } });
      expect(maj).toContainEqual({ where: { id: { in: ['p2', 'p3'] }, status: 'auto_applied' }, data: { aiVerdictAt: expect.any(Date), aiKeep: true } });
      expect(runsOf(prisma).updateMany).toHaveBeenCalledWith({ where: { id: 'run-1' }, data: { aiUsed: true } });
      expect(aiUsage.record).toHaveBeenCalledTimes(1);
      expect(aiUsage.record).toHaveBeenCalledWith({
        userId: null, fleetId: 'f1', action: 'agenda_agent',
        model: 'claude-sonnet-4-5-20250929', executor: 'local',
        inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 28000,
        latencyMs: 4200, ok: true, resultCount: 2,
      });
      expect(travauxIa.consommer).toHaveBeenCalledWith('t1');
      expect(travauxIa.rejeter).not.toHaveBeenCalled();
    });

    it('⚠️ une réservation FERME n\'est JAMAIS annulée par le verdict : aucune mise à jour ne change le statut d\'une auto_applied', async () => {
      const faits = [travailFait([{ index: 0, keep: false, reasoning: 'Sans intérêt' }, { index: 1, keep: false, reasoning: 'Idem' }])];
      const { svc, prisma, reservations } = monter({ faits });

      await svc.consommerJugements();

      const maj = proposalsOf(prisma).updateMany.mock.calls.map((c) => c[0]);
      for (const m of maj) {
        // Seules les `pending` changent de statut, et uniquement vers `dismissed`.
        if (m.where.status !== 'pending') expect(m.data).not.toHaveProperty('status');
        else expect(m.data.status).toBe('dismissed');
      }
      // Aucun geste sur l'agenda : la réservation est là, l'humain décide.
      expect(reservations.systemConfirm).not.toHaveBeenCalled();
    });

    it('justification vide sur keep=true : la phrase mécanique est conservée ; trop longue : bornée à 400', async () => {
      const longue = 'x'.repeat(650);
      const faits = [travailFait([{ index: 0, keep: true, reasoning: '   ' }, { index: 1, keep: true, reasoning: longue }])];
      const { svc, prisma } = monter({ faits });

      await svc.consommerJugements();

      const maj = proposalsOf(prisma).updateMany.mock.calls.map((c) => c[0]);
      const m0 = maj.find((m) => m.where.status === 'pending' && m.where.id.in[0] === 'p1');
      expect(m0!.data).not.toHaveProperty('reasoning');
      expect(m0!.data).toEqual(expect.objectContaining({ aiKeep: true }));
      const m1 = maj.find((m) => m.where.status === 'pending' && m.where.id.in[0] === 'p2');
      expect(m1!.data.reasoning).toHaveLength(400);
    });

    it('verdict sans aucune revue : consommé, usage écrit (les jetons ont été dépensés), passage PAS marqué aiUsed', async () => {
      const { svc, prisma, travauxIa, aiUsage } = monter({ faits: [travailFait([])] });

      const res = await svc.consommerJugements();

      expect(res).toEqual({ ranges: 1, rejetes: 0 });
      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
      expect(runsOf(prisma).updateMany).not.toHaveBeenCalled();
      expect(aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({ resultCount: 0, executor: 'local' }));
      expect(travauxIa.consommer).toHaveBeenCalledWith('t1');
    });

    it('ancien format de résultat (sans jetons) : usage à 0 sous le modèle « local », jamais d\'erreur', async () => {
      const t = travailFait([{ index: 0, keep: true, reasoning: 'ok' }]);
      t.resultat = { contenu: { reviews: [{ index: 0, keep: true, reasoning: 'ok' }] } } as never;
      const { svc, aiUsage, travauxIa } = monter({ faits: [t] });

      await svc.consommerJugements();

      expect(aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({
        model: 'local', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, latencyMs: null,
      }));
      expect(travauxIa.consommer).toHaveBeenCalledWith('t1');
    });

    it('sans runId (historique en panne à la création) : les verdicts s\'appliquent, rien à marquer', async () => {
      const { svc, prisma, travauxIa } = monter({ faits: [travailFait([{ index: 0, keep: true, reasoning: 'ok' }], { contexte: { runId: null } })] });

      await svc.consommerJugements();

      expect(proposalsOf(prisma).updateMany).toHaveBeenCalled();
      expect(runsOf(prisma).updateMany).not.toHaveBeenCalled();
      expect(travauxIa.consommer).toHaveBeenCalledWith('t1');
    });

    it('un motif sans proposition (course sur la clé unique) : verdict ignoré, pas de requête', async () => {
      const { svc, prisma } = monter({ faits: [travailFait([{ index: 0, keep: false, reasoning: 'x' }], { contexte: { motifs: [{ index: 0, proposalIds: [] }] } })] });

      await svc.consommerJugements();

      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
    });

    /**
     * (e) Un résultat qui ne respecte pas le schéma promis est REJETÉ en bloc : la file le rejoue,
     * puis l'acte en échec (alerte + ligne `ok=false`). Rien n'est modifié en base — un verdict
     * à moitié lisible n'en est pas un.
     */
    describe('(e) résultat invalide → rejeter, rien modifié', () => {
      const cas: Array<[string, unknown, RegExp]> = [
        ['index hors bornes', [{ index: 5, keep: false, reasoning: 'x' }], /hors bornes/],
        ['index non entier', [{ index: 0.5, keep: false, reasoning: 'x' }], /hors bornes/],
        ['keep non booléen', [{ index: 0, keep: 'non', reasoning: 'x' }], /keep non booléen/],
        ['reasoning non textuel', [{ index: 0, keep: true, reasoning: 42 }], /reasoning non textuel/],
        ['revue qui n\'est pas un objet', ['garder'], /pas un objet/],
        ['reviews absent', undefined, /sans tableau reviews/],
      ];
      it.each(cas)('%s', async (_nom, reviews, motif) => {
        const t = travailFait(reviews);
        if (reviews === undefined) t.resultat = { ...t.resultat, contenu: { verdicts: [] } } as never;
        const { svc, prisma, travauxIa, aiUsage } = monter({ faits: [t] });

        const res = await svc.consommerJugements();

        expect(res).toEqual({ ranges: 0, rejetes: 1 });
        expect(travauxIa.rejeter).toHaveBeenCalledWith('t1', expect.stringMatching(motif));
        expect(travauxIa.consommer).not.toHaveBeenCalled();
        expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
        expect(runsOf(prisma).updateMany).not.toHaveBeenCalled();
        expect(aiUsage.record).not.toHaveBeenCalled();
      });

      it('contexte sans motifs (ligne altérée) : rejeté aussi', async () => {
        const { svc, prisma, travauxIa } = monter({ faits: [travailFait([{ index: 0, keep: true, reasoning: 'ok' }], { contexte: { motifs: undefined } })] });

        await svc.consommerJugements();

        expect(travauxIa.rejeter).toHaveBeenCalledWith('t1', expect.stringMatching(/sans tableau motifs/));
        expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
      });

      it('un travail invalide n\'empêche pas de ranger le suivant', async () => {
        const mauvais = travailFait([{ index: 9, keep: true, reasoning: 'x' }]);
        const bon = { ...travailFait([{ index: 0, keep: true, reasoning: 'ok' }]), id: 't2' };
        const { svc, travauxIa } = monter({ faits: [mauvais, bon] });

        const res = await svc.consommerJugements();

        expect(res).toEqual({ ranges: 1, rejetes: 1 });
        expect(travauxIa.rejeter).toHaveBeenCalledWith('t1', expect.any(String));
        expect(travauxIa.consommer).toHaveBeenCalledWith('t2');
      });
    });
  });

  /**
   * (f) Expiration : 1 954 `pending` dont 1 615 périmées relevées le 05/09, jamais aucune
   * expiration. Le cron horaire bascule les suggestions dont le créneau est passé ; la liste
   * n'attend pas le cron pour cacher celles dont le départ est dépassé.
   */
  describe('(f) expiration des suggestions périmées', () => {
    it('expirerPropositions : pending dont la fin est passée → expired ; une future n\'entre pas dans le filtre', async () => {
      const { svc, prisma } = monter();
      proposalsOf(prisma).updateMany.mockResolvedValue({ count: 1615 });
      const now = new Date('2026-09-05T10:00:00Z');

      const n = await svc.expirerPropositions(now);

      expect(n).toBe(1615);
      // Le filtre EST la garantie : `status: 'pending'` (jamais une réservation ferme ni une
      // proposition tranchée) et `endAt < now` (une occurrence future reste intacte).
      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledTimes(1);
      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith({
        where: { status: 'pending', endAt: { lt: now } },
        data: { status: 'expired' },
      });
    });

    it('list() des pending ne renvoie que les départs à venir, triés par départ ; les autres statuts restent historiques', async () => {
      const { svc, prisma } = monter();
      const user = { id: 'u1', role: 'FLEET_ADMIN', fleetId: 'f1' } as never;
      const avant = Date.now();

      await svc.list(user);
      await svc.list(user, undefined, 'dismissed');

      const [pending, dismissed] = proposalsOf(prisma).findMany.mock.calls.map((c) => c[0]);
      expect(pending.where).toEqual({ fleetId: 'f1', status: 'pending', startAt: { gte: expect.any(Date) } });
      expect(pending.where.startAt.gte.getTime()).toBeGreaterThanOrEqual(avant);
      expect(pending.orderBy).toEqual({ startAt: 'asc' });
      expect(dismissed.where).toEqual({ fleetId: 'f1', status: 'dismissed' });
    });

    it('toDto expose le verdict (aiVerdictAt ISO, aiKeep) — nul tant que l\'IA n\'a rien dit', async () => {
      const { svc, prisma } = monter();
      const base = {
        id: 'p1', fleetId: 'f1', vehicleId: 'v1', startAt: new Date('2026-09-08T07:00:00Z'), endAt: new Date('2026-09-08T10:00:00Z'),
        dayOfWeek: 1, destinationLabel: 'Carcassonne', confidence: 0.9, basis: 'b', reasoning: 'r', status: 'pending', origin: 'scheduled',
        createdEventId: null, createdAt: new Date('2026-09-05T00:00:00Z'),
      };
      proposalsOf(prisma).findMany.mockResolvedValue([
        { ...base, aiVerdictAt: null, aiKeep: null },
        { ...base, id: 'p2', aiVerdictAt: new Date('2026-09-05T05:00:00Z'), aiKeep: true },
      ]);

      const rows = await svc.list({ id: 'u1', role: 'FLEET_ADMIN', fleetId: 'f1' } as never);

      expect(rows[0]).toEqual(expect.objectContaining({ aiVerdictAt: null, aiKeep: null }));
      expect(rows[1]).toEqual(expect.objectContaining({ aiVerdictAt: '2026-09-05T05:00:00.000Z', aiKeep: true }));
    });
  });

  /** (g) Le cron horaire : expiration puis consommation AVANT les flottes, chacune isolée. */
  describe('(g) cron horaire : expire, consomme, puis passe aux flottes — sans qu\'une panne bloque le reste', () => {
    it('appelle l\'expiration et la consommation en tête, puis lit les flottes', async () => {
      const { svc, prisma, travauxIa } = monter();

      await svc.runScheduled();

      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'expired' } }));
      expect(travauxIa.reprendrePerimes).toHaveBeenCalledTimes(1);
      expect(travauxIa.faits).toHaveBeenCalledWith('jugement-agenda');
      expect(prisma.agendaAgentSettings.findMany).toHaveBeenCalledTimes(1);
      // Ordre : expiration, consommation, flottes.
      const ordre = [
        proposalsOf(prisma).updateMany.mock.invocationCallOrder[0],
        travauxIa.faits.mock.invocationCallOrder[0],
        prisma.agendaAgentSettings.findMany.mock.invocationCallOrder[0],
      ];
      expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    });

    it('une consommation qui plante est archivée (AGENDA_AGENT) et les flottes tournent quand même', async () => {
      const { svc, prisma, travauxIa, errors } = monter();
      travauxIa.faits.mockRejectedValue(new Error('file HS'));

      await svc.runScheduled();

      expect(errors.record).toHaveBeenCalledWith(expect.any(Error), 'AGENDA_AGENT', expect.objectContaining({ phase: 'consommerJugements' }));
      expect(prisma.agendaAgentSettings.findMany).toHaveBeenCalledTimes(1);
    });

    it('une expiration qui plante n\'empêche ni la consommation ni les flottes', async () => {
      const { svc, prisma, travauxIa, errors } = monter();
      proposalsOf(prisma).updateMany.mockRejectedValue(new Error('verrou'));

      await svc.runScheduled();

      expect(errors.record).toHaveBeenCalledWith(expect.any(Error), 'AGENDA_AGENT', expect.objectContaining({ phase: 'expirerPropositions' }));
      expect(travauxIa.faits).toHaveBeenCalled();
      expect(prisma.agendaAgentSettings.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it('planifié + agent désactivé : no-op (ne détecte même pas)', async () => {
    const { svc, detector } = monter({ settings: makeSettings({ enabled: false }) });

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res).toMatchObject({ created: 0, proposed: 0, skipped: 0 });
    expect(detector.detectWithStats).not.toHaveBeenCalled();
  });

  /**
   * design/C3 point 2 (2026-09-05) — « Lancer l'analyse » ne contourne plus l'interrupteur.
   *
   * Avant : un clic sur une société dont l'agent était coupé tournait quand même — détection,
   * propositions, et jusqu'à l'appel IA (12 appels API en 30 j relevés le 05/09 pour la seule
   * société cdef31). Le refus doit être un 409 lisible, tomber AVANT tout travail, et ne laisser
   * NI ligne d'historique NI travail en file : un réglage respecté ne doit pas ressembler à un
   * agent en panne.
   */
  describe('manuel + agent désactivé : refus, sans détection ni trace (design/C3)', () => {
    const monterCoupe = (settings: unknown) => monter({ settings, aiOn: true });

    it('refuse en 409 (AutomationDisabledException) avec la consigne en français', async () => {
      const { svc } = monterCoupe(makeSettings({ enabled: false }));

      const refus = await svc.runForFleet('f1', 'manual').catch((e: unknown) => e);

      expect(refus).toBeInstanceOf(AutomationDisabledException);
      expect((refus as AutomationDisabledException).getStatus()).toBe(409);
      expect((refus as Error).message).toMatch(/désactivé pour cette société/);
      expect((refus as Error).message).toMatch(/Activez-le et enregistrez/);
    });

    it('ne détecte rien, n\'enfile rien, ne réserve rien, n\'écrit ni historique ni journal', async () => {
      const { svc, prisma, detector, reservations, activity, travauxIa } = monterCoupe(makeSettings({ enabled: false }));

      await expect(svc.runForFleet('f1', 'manual')).rejects.toBeInstanceOf(AutomationDisabledException);

      expect(detector.detectWithStats).not.toHaveBeenCalled();
      expect(travauxIa.enfiler).not.toHaveBeenCalled();
      expect(reservations.systemConfirm).not.toHaveBeenCalled();
      expect(proposalsOf(prisma).create).not.toHaveBeenCalled();
      // Pas de ligne « error » : ce passage n'a pas eu lieu, il n'a pas échoué.
      expect(runsOf(prisma).create).not.toHaveBeenCalled();
      expect(activity.record).not.toHaveBeenCalled();
      // `lastRunAt` reste celui du dernier VRAI passage.
      expect(prisma.agendaAgentSettings.update).not.toHaveBeenCalled();
    });

    it('société sans ligne de réglage (agent jamais activé) : même refus', async () => {
      const { svc, detector } = monterCoupe(null);

      await expect(svc.runForFleet('f1', 'manual')).rejects.toBeInstanceOf(AutomationDisabledException);
      expect(detector.detectWithStats).not.toHaveBeenCalled();
    });

    it('relâche le verrou anti-chevauchement : un second clic est refusé pareil, pas « déjà en cours »', async () => {
      const { svc } = monterCoupe(makeSettings({ enabled: false }));

      await expect(svc.runForFleet('f1', 'manual')).rejects.toBeInstanceOf(AutomationDisabledException);
      // Sans le `finally`, le second appel rendrait `alreadyRunning: true` en silence.
      await expect(svc.runForFleet('f1', 'manual')).rejects.toBeInstanceOf(AutomationDisabledException);
    });

    it('agent activé : le lancement manuel tourne comme avant (garde ciblée, pas un verrou global)', async () => {
      const { svc, detector } = monterCoupe(makeSettings({ enabled: true, autonomy: 'suggest' }));

      const res = await svc.runForFleet('f1', 'manual');

      expect(res.proposed).toBeGreaterThanOrEqual(1);
      expect(detector.detectWithStats).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * L'agent n'a pas de garde de dormance à lui : elle est en amont, dans le détecteur. Son devoir,
   * c'est de ne pas laisser disparaître ce qui a été écarté — un « 0 proposition » silencieux
   * passerait pour un agent en panne alors que la flotte a simplement des boîtiers muets.
   */
  describe('exclusions amont (boîtiers muets, habitudes éteintes)', () => {
    it('les remonte dans ignoré(s) et les DÉTAILLE dans le journal d\'activité', async () => {
      const { svc, prisma, activity } = monter({ patterns: [], excluded: { skippedDormantVehicles: 2, skippedStalePatterns: 1 } });

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(res).toMatchObject({ created: 0, proposed: 0, skipped: 3 });
      const rec = activity.record.mock.calls[0][0];
      expect(rec.detail).toContain('2 véhicule(s) au boîtier muet, 1 habitude(s) éteinte(s)');
      expect(rec.meta).toMatchObject({ skippedDormantVehicles: 2, skippedStalePatterns: 1 });
      // L'historique conserve la trace : 0 motif exploitable, 3 écartés.
      expect(runsOf(prisma).create.mock.calls[0]![0].data).toEqual(
        expect.objectContaining({ patterns: 0, skipped: 3, status: 'completed' }),
      );
    });

    it('rien d\'écarté : le libellé reste propre (pas de parenthèse à zéro)', async () => {
      const { svc, activity } = monter();

      await svc.runForFleet('f1', 'scheduled');

      const rec = activity.record.mock.calls[0][0];
      expect(rec.detail).not.toContain('boîtier muet');
    });
  });

  it('deux motifs : chacun a son rang et ses propositions dans le travail', async () => {
    const { svc, prisma, travauxIa } = monter({ settings: makeSettings({ autonomy: 'suggest' }), patterns: [PATTERN, PATTERN_2], aiOn: true });

    await svc.runForFleet('f1', 'scheduled');

    const creations = proposalsOf(prisma).create.mock.calls.map((c, i) => ({ id: `p${i + 1}`, vehicleId: c[0].data.vehicleId }));
    const motifs = travauxIa.enfiler.mock.calls[0][2].motifs;
    expect(motifs).toEqual([
      { index: 0, proposalIds: creations.filter((c) => c.vehicleId === 'v1').map((c) => c.id) },
      { index: 1, proposalIds: creations.filter((c) => c.vehicleId === 'v2').map((c) => c.id) },
    ]);
    const patterns = travauxIa.enfiler.mock.calls[0][1].userPayload.patterns;
    expect(patterns.map((p: { index: number; plate: string }) => [p.index, p.plate])).toEqual([[0, 'AA-1'], [1, 'BB-2']]);
  });
});
