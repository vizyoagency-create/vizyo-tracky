import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
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
      // D0 — « cette réservation est-elle déjà liée à une AUTRE proposition ? » (null = non).
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async () => ({ id: `p${++seq}` })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...(existingProposal as object), ...data })),
      // P2-5 — la purge des propositions closes : `findMany` (lot borné) puis `deleteMany`.
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue([]),
      // Plaque relue pour le journal métier d'un « Écarter » (29/09).
      findUnique: jest.fn().mockResolvedValue({ plate: 'AA-1' }),
    },
    // D0 — le rattrapage cherche la réservation posée PAR une proposition prise (relecture 29/09).
    vehicleEvent: { findMany: jest.fn().mockResolvedValue([]) },
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
  excluded: {
    skippedDormantVehicles?: number;
    skippedOutOfServiceVehicles?: number;
    skippedStalePatterns?: number;
  } = {},
) {
  return {
    detectWithStats: jest.fn().mockResolvedValue({
      patterns,
      skippedDormantVehicles: excluded.skippedDormantVehicles ?? 0,
      skippedOutOfServiceVehicles: excluded.skippedOutOfServiceVehicles ?? 0,
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
  excluded?: {
    skippedDormantVehicles?: number;
    skippedOutOfServiceVehicles?: number;
    skippedStalePatterns?: number;
  };
  reservations?: ReturnType<typeof makeReservations>;
  detector?: { detectWithStats: jest.Mock };
  aiOn?: boolean;
  faits?: unknown[];
  /** `null` = aucun journal injecté (le geste doit passer quand même). */
  activity?: { record: jest.Mock } | null;
  /** Périmètre véhicule (piste 3 du 29/09) : la société rendue par `assertVehicleAccess`. */
  events?: ReturnType<typeof makeEvents>;
} = {}) {
  const prisma = makePrisma(opts.settings === undefined ? makeSettings() : opts.settings, opts.existing ?? null);
  const detector = opts.detector ?? makeDetector(opts.patterns ?? [PATTERN], opts.excluded);
  const reservations = opts.reservations ?? makeReservations();
  const events = opts.events ?? makeEvents();
  const activity = opts.activity === null ? (undefined as unknown as ReturnType<typeof makeActivity>) : (opts.activity ?? makeActivity());
  const errors = makeErrors();
  const aiUsage = makeAiUsage();
  const travauxIa = makeTravauxIa(opts.faits);
  const aiAvail = opts.aiOn === undefined ? undefined : makeAiAvail(opts.aiOn);
  const svc = new AgendaAgentRunnerService(
    prisma as never, detector as never, reservations as never, events as never, activity as never,
    travauxIa as never, aiUsage as never, errors as never, aiAvail as never,
  );
  return { svc, prisma, detector, reservations, events, activity, errors, aiUsage, travauxIa, aiAvail };
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
  /**
   * ── L'AGENT NE RÉSERVE PLUS, MÊME RÉGLÉ SUR « AUTO » (2026-09-23) ──────────────────────────
   *
   * Ce test disait l'inverse jusqu'au 23/09 : il VERROUILLAIT la réservation ferme. La mesure
   * l'a renversé — 321 réservations automatiques passées de cdef31, 57 % seulement ont vu le
   * véhicule rouler sur le créneau, 23 % ne l'ont pas vu bouger du tout, et toutes étaient
   * au-dessus du seuil de confiance. Une réservation ferme à ±47 min bloque le mauvais créneau.
   *
   * Le réglage reste en base — c'est le RÉSULTAT qui change : proposition, jamais réservation.
   */
  it('même en autonomie « auto », l’agent PROPOSE et ne réserve JAMAIS', async () => {
    const { svc, prisma, reservations } = monter(); // `makeSettings()` = auto_high_confidence

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.created).toBe(0);
    expect(reservations.systemConfirm).not.toHaveBeenCalled();
    const data = proposalsOf(prisma).create.mock.calls[0][0].data;
    expect(data.status).toBe('pending');
    expect(data.createdEventId).toBeNull();
  });

  /**
   * Et la conséquence qui compte pour l'exploitant : une proposition n'entre dans AUCUN calcul
   * de disponibilité. Le véhicule reste réservable par un humain — c'est toute la différence
   * entre un pré-remplissage et un blocage.
   */
  it('la proposition passe par isVehicleFree, pas par systemConfirm', async () => {
    const { svc, reservations } = monter();
    await svc.runForFleet('f1', 'scheduled');
    expect(reservations.isVehicleFree).toHaveBeenCalled();
    expect(reservations.systemConfirm).not.toHaveBeenCalled();
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
      expect(res.proposed).toBeGreaterThanOrEqual(1);
      expect(reservations.systemConfirm).not.toHaveBeenCalled();
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

    /**
     * Le réglage « auto » ne change plus le RÉSULTAT (cf. le test du haut) — mais il ne doit pas
     * non plus casser la chaîne de jugement : les propositions qu'il produit partent au verdict
     * exactement comme celles du mode « suggestions seules ».
     */
    it('(b bis) réglage « auto » : des propositions, et elles sont soumises au verdict', async () => {
      const { svc, prisma, reservations, travauxIa } = monter({ aiOn: true });

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(res.proposed).toBeGreaterThanOrEqual(1);
      expect(res.created).toBe(0);
      expect(reservations.systemConfirm).not.toHaveBeenCalled();
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

  /**
   * (f bis) P2-5 — RÉTENTION des propositions closes. Le 22/09 : 2 049 `expired` + 172
   * `dismissed` jamais purgées, ~30 lignes par nuit et par société. La purge efface ce que plus
   * personne ne lira, et RIEN de ce qui pointe une réservation créée.
   */
  describe('(f bis) purge des propositions closes depuis plus d’un trimestre', () => {
    const now = new Date('2026-09-28T02:00:00Z');

    it('ne vise que expired / dismissed dont le créneau a plus de 90 jours, par lot borné', async () => {
      const { svc, prisma } = monter();
      proposalsOf(prisma).findMany.mockResolvedValue([{ id: 'p-old-1' }, { id: 'p-old-2' }]);
      proposalsOf(prisma).deleteMany.mockResolvedValue({ count: 2 });

      const n = await svc.purgerPropositions(now);

      expect(n).toBe(2);
      const [args] = proposalsOf(prisma).findMany.mock.calls[0];
      expect(args.where).toEqual({ status: { in: ['expired', 'dismissed'] }, endAt: { lt: expect.any(Date) } });
      // 90 jours exactement avant `now` : une proposition de 89 jours reste.
      expect(args.where.endAt.lt.toISOString()).toBe('2026-06-30T02:00:00.000Z');
      expect(args.take).toBeGreaterThan(0);
      expect(args.select).toEqual({ id: true });
      // La suppression cible les identifiants lus, jamais un `where` ouvert.
      expect(proposalsOf(prisma).deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['p-old-1', 'p-old-2'] } } });
    });

    it('rien à purger : aucun deleteMany — on ne verrouille pas une table pour rien', async () => {
      const { svc, prisma } = monter();
      proposalsOf(prisma).findMany.mockResolvedValue([]);
      await expect(svc.purgerPropositions(now)).resolves.toBe(0);
      expect(proposalsOf(prisma).deleteMany).not.toHaveBeenCalled();
    });

    it('⚠️ pending, applied et auto_applied ne sont JAMAIS dans le filtre', async () => {
      const { svc, prisma } = monter();
      await svc.purgerPropositions(now);
      const statuts: string[] = proposalsOf(prisma).findMany.mock.calls[0][0].where.status.in;
      for (const vivant of ['pending', 'applied', 'auto_applied']) expect(statuts).not.toContain(vivant);
    });

    it('le cron horaire la lance après l’expiration, et une purge qui plante n’arrête ni la consommation ni les flottes', async () => {
      const { svc, prisma, travauxIa, errors } = monter();
      proposalsOf(prisma).findMany.mockRejectedValue(new Error('verrou'));

      await svc.runScheduled();

      expect(errors.record).toHaveBeenCalledWith(expect.any(Error), 'AGENDA_AGENT', expect.objectContaining({ phase: 'purgerPropositions' }));
      expect(travauxIa.faits).toHaveBeenCalled();
      expect(prisma.agendaAgentSettings.findMany).toHaveBeenCalledTimes(1);
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

  /**
   * Revue du 29/09 — une proposition ne se tranche qu'UNE fois. Deux onglets (« Réserver » ici,
   * « Écarter » là, ou « Tout réserver » lancé deux fois) passaient tous deux le contrôle
   * « pending » lu avant l'écriture : la proposition finissait « écartée » au-dessus d'une
   * réservation ferme. L'écriture est désormais conditionnée au statut.
   */
  describe('apply / dismiss : une proposition ne se tranche qu’une fois', () => {
    const user = { id: 'u1', role: 'FLEET_ADMIN', fleetId: 'f1' } as never;
    const pending = {
      id: 'p1', fleetId: 'f1', vehicleId: 'v1', startAt: new Date('2026-10-05T07:00:00Z'), endAt: new Date('2026-10-05T10:00:00Z'),
      dayOfWeek: 1, destinationLabel: 'Carcassonne', confidence: 0.9, basis: 'b', reasoning: 'r', status: 'pending', origin: 'scheduled',
      createdEventId: null, createdAt: new Date('2026-09-28T00:00:00Z'), aiVerdictAt: null, aiKeep: null,
    };

    it('apply PREND la proposition (pending → applied sous condition) AVANT de réserver, puis note la réservation', async () => {
      const { svc, prisma, reservations } = monter({ existing: pending });

      const dto = await svc.apply(user, 'p1');

      const prise = proposalsOf(prisma).updateMany.mock.calls[0][0];
      expect(prise).toEqual({ where: { id: 'p1', status: 'pending' }, data: { status: 'applied' } });
      expect(proposalsOf(prisma).updateMany.mock.invocationCallOrder[0]).toBeLessThan(reservations.systemConfirm.mock.invocationCallOrder[0]);
      expect(proposalsOf(prisma).update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { status: 'applied', createdEventId: 'ev1' } });
      expect(dto).toEqual(expect.objectContaining({ status: 'applied', createdEventId: 'ev1', vehiclePlate: 'AA-1' }));
    });

    it('apply perdu (un autre onglet l’a tranchée entre-temps) → « déjà traitée », AUCUNE réservation', async () => {
      const { svc, prisma, reservations } = monter({ existing: pending });
      proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(svc.apply(user, 'p1')).rejects.toThrow('Proposition déjà traitée.');
      expect(reservations.systemConfirm).not.toHaveBeenCalled();
      expect(proposalsOf(prisma).update).not.toHaveBeenCalled();
    });

    it('créneau occupé → 409 et la proposition est RENDUE (retour à pending) : elle reste réservable', async () => {
      const reservations = makeReservations({ systemConfirm: jest.fn().mockResolvedValue(null) });
      const { svc, prisma } = monter({ existing: pending, reservations });

      await expect(svc.apply(user, 'p1')).rejects.toThrow('Le créneau est déjà occupé.');
      expect(proposalsOf(prisma).updateMany.mock.calls[1][0]).toEqual({
        where: { id: 'p1', status: 'applied', createdEventId: null },
        data: { status: 'pending' },
      });
      expect(proposalsOf(prisma).update).not.toHaveBeenCalled();
    });

    it('réservation en erreur → la proposition est rendue, l’erreur remonte telle quelle', async () => {
      const reservations = makeReservations({ systemConfirm: jest.fn().mockRejectedValue(new Error('base indisponible')) });
      const { svc, prisma } = monter({ existing: pending, reservations });

      await expect(svc.apply(user, 'p1')).rejects.toThrow('base indisponible');
      expect(proposalsOf(prisma).updateMany.mock.calls[1][0].data).toEqual({ status: 'pending' });
    });

    it('dismiss écrit sous condition `pending` (jamais sur une proposition devenue réservation, écartée ou expirée)', async () => {
      const { svc, prisma } = monter({ existing: pending });

      const dto = await svc.dismiss(user, 'p1');

      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', status: 'pending' },
        data: { status: 'dismissed' },
      });
      expect(dto.status).toBe('dismissed');
    });

    it('dismiss perdu (réservée entre la lecture et l’écriture) → 400 « réservation », rien d’écrit', async () => {
      const { svc, prisma } = monter({ existing: pending });
      proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });
      // Première lecture : pending ; relecture après l'écriture perdue : réservée.
      proposalsOf(prisma).findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce({ status: 'applied' });

      await expect(svc.dismiss(user, 'p1')).rejects.toThrow('Une réservation déjà créée s\'annule depuis l\'agenda.');
      expect(proposalsOf(prisma).update).not.toHaveBeenCalled();
    });

    /**
     * Revue du 29/09 (C3) — l'écran ne se rafraîchit pas : une proposition écartée par l'IA, par le
     * ménage ou par un collègue, ou expirée par le cron, y reste affichée. « Écarter » réussissait et
     * écrivait une SECONDE ligne au nom de celui qui cliquait ; une `expired` repassait `dismissed`.
     */
    it('déjà écartée → 200 idempotent : rien d’écrit', async () => {
      const { svc, prisma } = monter({ existing: { ...pending, status: 'dismissed' } });

      await expect(svc.dismiss(user, 'p1')).resolves.toEqual(expect.objectContaining({ id: 'p1', status: 'dismissed' }));
      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
    });

    it('expirée → rendue TELLE QUELLE (expired), jamais réécrite en dismissed', async () => {
      const { svc, prisma } = monter({ existing: { ...pending, status: 'expired' } });

      await expect(svc.dismiss(user, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'expired' }));
      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
    });

    it('écartée EN PARALLÈLE (count 0, relue dismissed) → 200, pas d’erreur « réservation »', async () => {
      const { svc, prisma } = monter({ existing: pending });
      proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });
      proposalsOf(prisma).findUnique.mockResolvedValueOnce(pending).mockResolvedValueOnce({ status: 'dismissed' });

      await expect(svc.dismiss(user, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'dismissed' }));
    });

    it('prise puis rendue pendant l’écriture (count 0, relue pending) → 409 « réessayez »', async () => {
      const { svc, prisma } = monter({ existing: pending });
      proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(svc.dismiss(user, 'p1')).rejects.toMatchObject({ constructor: ConflictException });
    });
  });
});

/**
 * ── JOURNAL MÉTIER ET RATTRAPAGE D0 (29/09) ─────────────────────────────────────────────────
 *
 * Chaque geste sur une proposition laisse une ligne au journal métier (`system_activity_logs`),
 * lue par le fil « Agenda » de la société. Trois règles verrouillées ici : la société est celle de
 * la PROPOSITION (un super-admin agit souvent chez un client), l'auteur est l'utilisateur réel, et
 * les heures du texte sont celles de PARIS (le serveur tourne en UTC). Un journal absent ou en
 * panne ne fait jamais échouer le geste.
 *
 * D0 (4e revue) : un processus tué entre la prise et la réservation laissait une proposition
 * `applied` sans réservation, figée pour toujours. Le cron horaire la rattache ou la rend.
 */
describe('AgendaAgentRunnerService — journal métier et rattrapage D0 (29/09)', () => {
  // Super-admin SANS société propre, qui agit sur la société d'un client.
  const superAdmin = { id: 'u-sa', role: 'SUPER_ADMIN', fleetId: null } as never;
  const gestionnaire = { id: 'u1', role: 'FLEET_ADMIN', fleetId: 'fCLIENT' } as never;
  // Lundi 05/10/2026, 07:00Z → 09:00 à Paris (heure d'été).
  const proposition = {
    id: 'p1', fleetId: 'fCLIENT', vehicleId: 'v1', startAt: new Date('2026-10-05T07:00:00Z'), endAt: new Date('2026-10-05T10:00:00Z'),
    dayOfWeek: 1, destinationLabel: 'Carcassonne', confidence: 0.9, basis: 'b', reasoning: 'r', status: 'pending', origin: 'scheduled',
    createdEventId: null, createdAt: new Date('2026-09-28T00:00:00Z'), aiVerdictAt: null, aiKeep: null,
  };

  it('apply → RESERVATION / proposition_reservee, société de la PROPOSITION, auteur réel, heure de Paris', async () => {
    const { svc, activity } = monter({ existing: proposition });

    await svc.apply(superAdmin, 'p1');

    expect(activity.record).toHaveBeenCalledTimes(1);
    const ligne = activity.record.mock.calls[0][0];
    expect(ligne).toEqual(expect.objectContaining({
      category: 'RESERVATION',
      action: 'proposition_reservee',
      actor: 'utilisateur',
      target: 'AA-1',
      fleetId: 'fCLIENT',
      triggeredByUserId: 'u-sa',
    }));
    expect(ligne.meta).toEqual(expect.objectContaining({ propositionId: 'p1', reservationId: 'ev1', vehicleId: 'v1' }));
    expect(ligne.detail).toContain('05/10/2026 09:00 → 12:00');
    expect(ligne.detail).toContain('Carcassonne');
    expect(ligne.detail).not.toMatch(/T07:00|07:00/);
  });

  it('apply qui échoue (créneau occupé) : AUCUNE ligne « réservée »', async () => {
    const reservations = makeReservations({ systemConfirm: jest.fn().mockResolvedValue(null) });
    const { svc, activity } = monter({ existing: proposition, reservations });

    await expect(svc.apply(gestionnaire, 'p1')).rejects.toThrow('Le créneau est déjà occupé.');
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('dismiss → AGENDA / proposition_ecartee, société de la proposition, plaque relue, auteur réel', async () => {
    const { svc, activity, prisma } = monter({ existing: proposition });

    await svc.dismiss(superAdmin, 'p1');

    const ligne = activity.record.mock.calls[0][0];
    expect(ligne).toEqual(expect.objectContaining({
      category: 'AGENDA',
      action: 'proposition_ecartee',
      actor: 'utilisateur',
      target: 'AA-1',
      fleetId: 'fCLIENT',
      triggeredByUserId: 'u-sa',
    }));
    expect(ligne.meta).toEqual(expect.objectContaining({ propositionId: 'p1', vehicleId: 'v1' }));
    expect(ligne.detail).toContain('05/10/2026 09:00 → 12:00');
    expect(prisma.vehicle.findUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, select: { plate: true } });
  });

  it('dismiss perdu (déjà réservée) : aucune ligne', async () => {
    const { svc, activity, prisma } = monter({ existing: proposition });
    proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });
    proposalsOf(prisma).findUnique.mockResolvedValueOnce(proposition).mockResolvedValueOnce({ status: 'applied' });

    await expect(svc.dismiss(gestionnaire, 'p1')).rejects.toThrow('Une réservation déjà créée');
    expect(activity.record).not.toHaveBeenCalled();
  });

  /**
   * Revue du 29/09 (C3) — Joost écarte P ; un collègue, liste d'avant encore ouverte, écarte P à son
   * tour : une seule ligne au fil, celle de Joost. Idem pour une proposition écartée par l'IA
   * (verdict de 06:30) puis « écartée » par un gestionnaire dont l'onglet est resté ouvert.
   */
  it('dismiss d’une proposition DÉJÀ écartée (ou expirée) : 200, aucune seconde ligne', async () => {
    for (const status of ['dismissed', 'expired']) {
      const { svc, activity, prisma } = monter({ existing: { ...proposition, status } });

      await expect(svc.dismiss(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status }));
      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
      expect(activity.record).not.toHaveBeenCalled();
    }
  });

  it('dismiss écartée en parallèle (count 0, relue dismissed) : 200, aucune ligne', async () => {
    const { svc, activity, prisma } = monter({ existing: proposition });
    proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });
    proposalsOf(prisma).findUnique.mockResolvedValueOnce(proposition).mockResolvedValueOnce({ status: 'dismissed' });

    await expect(svc.dismiss(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'dismissed' }));
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('plaque illisible : la ligne part quand même, sans plaque — le geste passe', async () => {
    const { svc, activity, prisma } = monter({ existing: proposition });
    prisma.vehicle.findUnique.mockRejectedValue(new Error('base indisponible'));

    await expect(svc.dismiss(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'dismissed' }));
    expect(activity.record.mock.calls[0][0].target).toBeNull();
  });

  it('journal ABSENT : apply et dismiss passent, sans erreur', async () => {
    const a = monter({ existing: proposition, activity: null });
    await expect(a.svc.apply(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'applied', createdEventId: 'ev1' }));
    const d = monter({ existing: proposition, activity: null });
    await expect(d.svc.dismiss(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'dismissed' }));
  });

  it('journal EN PANNE (record lève) : apply et dismiss passent quand même', async () => {
    const enPanne = { record: jest.fn(() => { throw new Error('journal HS'); }) };
    const a = monter({ existing: proposition, activity: enPanne });
    await expect(a.svc.apply(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'applied' }));
    const d = monter({ existing: proposition, activity: enPanne });
    await expect(d.svc.dismiss(gestionnaire, 'p1')).resolves.toEqual(expect.objectContaining({ status: 'dismissed' }));
  });

  it('passage MANUEL : la ligne « Passage de l’agent » porte l’utilisateur réel ; un passage de nuit, personne', async () => {
    const manuel = monter({ settings: makeSettings({ autonomy: 'suggest' }) });
    await manuel.svc.runOnDemand({ id: 'u-sa', role: 'SUPER_ADMIN', fleetId: null } as never, 'fCLIENT');
    const ligneManuelle = manuel.activity.record.mock.calls[0][0];
    expect(ligneManuelle).toEqual(expect.objectContaining({ action: 'agenda_agent_run', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa', actor: 'utilisateur' }));

    const nuit = monter({ settings: makeSettings({ autonomy: 'suggest' }) });
    await nuit.svc.runForFleet('fCLIENT', 'scheduled');
    expect(nuit.activity.record.mock.calls[0][0]).toEqual(expect.objectContaining({ triggeredByUserId: null, actor: 'system' }));
  });

  describe('D0 — rattrapage des propositions prises sans réservation', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const orpheline = {
      id: 'p9', fleetId: 'fCLIENT', vehicleId: 'v1', startAt: new Date('2026-10-05T07:00:00Z'), endAt: new Date('2026-10-05T10:00:00Z'),
      destinationLabel: 'Carcassonne',
    };

    it('ne vise que les « applied » SANS réservation dont la prise a plus de 10 minutes', async () => {
      const { svc, prisma } = monter();

      await svc.rattraperPropositionsPrises(now);

      const args = proposalsOf(prisma).findMany.mock.calls[0][0];
      expect(args.where).toEqual({ status: 'applied', createdEventId: null, updatedAt: { lt: new Date('2026-10-01T11:50:00Z') } });
      expect(args.take).toBeGreaterThan(0);
    });

    it('la réservation posée PAR cette proposition → RATTACHÉE, et la ligne « réservée » est écrite au nom de qui avait cliqué', async () => {
      const { svc, prisma, activity } = monter();
      proposalsOf(prisma).findMany.mockResolvedValueOnce([orpheline]);
      prisma.vehicleEvent.findMany.mockResolvedValue([
        { id: 'ev-orph', status: 'CONFIRMED', metadata: { agent: true, appliedBy: 'u-sa' }, vehicle: { plate: 'AA-1' } },
      ]);

      const res = await svc.rattraperPropositionsPrises(now);

      expect(res).toEqual({ liees: 1, rendues: 0 });
      // « Sa » réservation, pas « une » réservation (relecture 29/09) : marquée par la proposition,
      // ou posée par l'agent sur EXACTEMENT ce véhicule et ce créneau — tous statuts, même société.
      const recherche = prisma.vehicleEvent.findMany.mock.calls[0][0].where;
      expect(recherche).toEqual({
        fleetId: 'fCLIENT',
        type: 'RESERVATION',
        OR: [
          { metadata: { path: ['propositionId'], equals: 'p9' } },
          { vehicleId: 'v1', startAt: orpheline.startAt, endAt: orpheline.endAt, metadata: { path: ['agent'], equals: true } },
        ],
      });
      expect(recherche.status).toBeUndefined();
      // Jamais une réservation déjà liée à une AUTRE proposition.
      expect(proposalsOf(prisma).findFirst).toHaveBeenCalledWith({
        where: { createdEventId: 'ev-orph', id: { not: 'p9' } },
        select: { id: true },
      });
      // Écriture SOUS CONDITION : une application tardive qui a abouti n'est jamais écrasée.
      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith({
        where: { id: 'p9', status: 'applied', createdEventId: null },
        data: { createdEventId: 'ev-orph' },
      });
      const ligne = activity.record.mock.calls[0][0];
      expect(ligne).toEqual(expect.objectContaining({
        category: 'RESERVATION', action: 'proposition_reservee', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa', actor: 'utilisateur', target: 'AA-1',
      }));
      expect(ligne.meta).toEqual(expect.objectContaining({ propositionId: 'p9', reservationId: 'ev-orph', rattrapage: true }));
      expect(ligne.detail).toContain('05/10/2026 09:00 → 12:00');
      expect(ligne.detail).not.toContain('annulée');
    });

    it('relecture 29/09 — une réservation MANUELLE (sans metadata.agent) qui couvre le créneau n’est jamais reprise : proposition rendue, aucune ligne', async () => {
      const { svc, prisma, activity } = monter();
      proposalsOf(prisma).findMany.mockResolvedValueOnce([orpheline]);
      // Même si la base la rendait (filtre JSON contourné), le contrôle en mémoire l'écarte.
      prisma.vehicleEvent.findMany.mockResolvedValue([
        { id: 'ev-main', status: 'CONFIRMED', metadata: { group: 'Atelier' }, vehicle: { plate: 'AA-1' } },
      ]);

      await expect(svc.rattraperPropositionsPrises(now)).resolves.toEqual({ liees: 0, rendues: 1 });
      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { createdEventId: 'ev-main' } }));
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('relecture 29/09 — la réservation d’une AUTRE proposition (marqueur différent, ou déjà liée) n’est jamais reprise', async () => {
      const { svc, prisma, activity } = monter();
      proposalsOf(prisma).findMany.mockResolvedValueOnce([orpheline]);
      prisma.vehicleEvent.findMany.mockResolvedValue([
        { id: 'ev-autre', status: 'CONFIRMED', metadata: { agent: true, propositionId: 'p-autre', appliedBy: 'u2' }, vehicle: { plate: 'AA-1' } },
        { id: 'ev-liee', status: 'CONFIRMED', metadata: { agent: true, appliedBy: 'u2' }, vehicle: { plate: 'AA-1' } },
      ]);
      proposalsOf(prisma).findFirst.mockImplementation(async ({ where }: { where: { createdEventId: string } }) =>
        where.createdEventId === 'ev-liee' ? { id: 'p-autre' } : null,
      );

      await expect(svc.rattraperPropositionsPrises(now)).resolves.toEqual({ liees: 0, rendues: 1 });
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('relecture 29/09 — sa réservation ANNULÉE avant le passage : la proposition garde son lien (applied), jamais re-proposée', async () => {
      const { svc, prisma, activity } = monter();
      proposalsOf(prisma).findMany.mockResolvedValueOnce([orpheline]);
      prisma.vehicleEvent.findMany.mockResolvedValue([
        { id: 'ev-ann', status: 'CANCELLED', metadata: { agent: true, propositionId: 'p9', appliedBy: 'u-sa' }, vehicle: { plate: 'AA-1' } },
      ]);

      await expect(svc.rattraperPropositionsPrises(now)).resolves.toEqual({ liees: 1, rendues: 0 });
      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith({
        where: { id: 'p9', status: 'applied', createdEventId: null },
        data: { createdEventId: 'ev-ann' },
      });
      expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'pending' } }));
      const ligne = activity.record.mock.calls[0][0];
      expect(ligne).toEqual(expect.objectContaining({ action: 'proposition_reservee', triggeredByUserId: 'u-sa', actor: 'utilisateur' }));
      expect(ligne.detail).toContain('réservation annulée depuis');
    });

    it('apply marque la réservation avec l’identité de la proposition (metadata.propositionId)', async () => {
      const { svc, reservations } = monter({ existing: proposition });

      await svc.apply(gestionnaire, 'p1');

      expect(reservations.systemConfirm).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ agent: true, propositionId: 'p1', appliedBy: 'u1' }),
      }));
    });

    it('aucune réservation → la proposition est RENDUE à pending (réservable à nouveau), sans ligne au journal', async () => {
      const { svc, prisma, activity } = monter();
      proposalsOf(prisma).findMany.mockResolvedValueOnce([orpheline]);

      const res = await svc.rattraperPropositionsPrises(now);

      expect(res).toEqual({ liees: 0, rendues: 1 });
      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith({
        where: { id: 'p9', status: 'applied', createdEventId: null },
        data: { status: 'pending' },
      });
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('course perdue (l’application a abouti entre-temps) : rien compté, rien journalisé', async () => {
      const { svc, prisma, activity } = monter();
      proposalsOf(prisma).findMany.mockResolvedValueOnce([orpheline]);
      prisma.vehicleEvent.findMany.mockResolvedValue([
        { id: 'ev-orph', status: 'CONFIRMED', metadata: { agent: true }, vehicle: { plate: 'AA-1' } },
      ]);
      proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(svc.rattraperPropositionsPrises(now)).resolves.toEqual({ liees: 0, rendues: 0 });
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('le cron horaire rattrape AVANT d’expirer — une proposition rendue dont le créneau est passé expire au même passage', async () => {
      const { svc, prisma } = monter();

      await svc.runScheduled();

      const rattrapage = proposalsOf(prisma).findMany.mock.invocationCallOrder[0];
      const expiration = proposalsOf(prisma).updateMany.mock.invocationCallOrder[0];
      expect(proposalsOf(prisma).findMany.mock.calls[0][0].where.status).toBe('applied');
      expect(rattrapage).toBeLessThan(expiration);
    });

    it('un rattrapage qui plante est archivé (AGENDA_AGENT) et n’empêche ni l’expiration ni les flottes', async () => {
      const { svc, prisma, errors } = monter();
      proposalsOf(prisma).findMany.mockRejectedValueOnce(new Error('verrou'));

      await svc.runScheduled();

      expect(errors.record).toHaveBeenCalledWith(expect.any(Error), 'AGENDA_AGENT', expect.objectContaining({ phase: 'rattraperPropositionsPrises' }));
      expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'expired' } }));
      expect(prisma.agendaAgentSettings.findMany).toHaveBeenCalledTimes(1);
    });
  });
});

describe('AgendaAgentRunnerService.ecarterEnLot — Réorganiser écarte les propositions (29/09, piste 3)', () => {
  const H = 60 * 60 * 1000;
  const admin = { id: 'u1', role: 'FLEET_ADMIN', fleetId: 'f1' } as never;
  const superAdmin = { id: 'u-sa', role: 'SUPER_ADMIN', fleetId: null } as never;
  const dans = (h: number) => new Date(Date.now() + h * H);
  const prop = (id: string, vehicleId: string, hDebut: number) => ({
    id, vehicleId, startAt: dans(hDebut), endAt: dans(hDebut + 3), destinationLabel: 'Carcassonne',
  });
  const fenetre = (hDebut: number, hFin: number) => ({ from: dans(hDebut).toISOString(), to: dans(hFin).toISOString() });
  const PLAQUES = [{ id: 'v1', plate: 'AA-1' }, { id: 'v2', plate: 'BB-2' }, { id: 'v3', plate: 'CC-3' }];

  /** Le lot tel que la base le rend (déjà filtré par la requête) ; `gere` = règle par véhicule. */
  function monterLot(opts: { lignes?: unknown[]; gere?: (vid: string) => boolean; societeVehicule?: string } = {}) {
    const reservations = makeReservations({
      gereLesReservationsDe: jest.fn(async (_u: unknown, vid: string) => (opts.gere ? opts.gere(vid) : true)),
    });
    const events = { assertVehicleAccess: jest.fn().mockResolvedValue(opts.societeVehicule ?? 'f1') };
    const m = monter({ reservations, events });
    proposalsOf(m.prisma).findMany.mockResolvedValue(opts.lignes ?? []);
    m.prisma.vehicle.findMany.mockResolvedValue(PLAQUES);
    return m;
  }
  const LIGNES = [prop('p1', 'v2', 2), prop('p2', 'v1', 5), prop('p3', 'v2', 26)];

  it('simulation (défaut) : le lot, ses véhicules et son aperçu — RIEN n’est écrit ni journalisé', async () => {
    const { svc, prisma, activity } = monterLot({ lignes: LIGNES });

    const r = await svc.ecarterEnLot(admin, fenetre(0, 7 * 24));

    expect(r).toMatchObject({ simulation: true, concernees: 3, ecartees: 0, dejaTraitees: 0, horsGestion: 0, plafonne: false });
    expect(r.lotIds).toEqual(['p1', 'p2', 'p3']);
    // Triés par plaque, pour la liste « Véhicule ».
    expect(r.parVehicule).toEqual([
      { vehicleId: 'v1', plate: 'AA-1', n: 1 },
      { vehicleId: 'v2', plate: 'BB-2', n: 2 },
    ]);
    expect(r.apercu[0]).toMatchObject({ id: 'p1', plate: 'BB-2', destinationLabel: 'Carcassonne' });
    expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('la requête : la société de l’appelant, EN ATTENTE, encore à venir, qui CHEVAUCHE la fenêtre', async () => {
    const { svc, prisma } = monterLot();
    const f = fenetre(48, 72);

    await svc.ecarterEnLot(admin, f);

    const where = proposalsOf(prisma).findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('f1');
    expect(where.status).toBe('pending');
    // Commencée = plus réservable : jamais prise, même si la fenêtre commence avant maintenant.
    expect(Math.abs(where.startAt.gte.getTime() - Date.now())).toBeLessThan(5_000);
    expect(where.startAt.lt.toISOString()).toBe(f.to);
    // Chevauchement : un trajet 08:00–12:00 sous une immobilisation qui commence à 10:00 est pris.
    expect(where.endAt.gt.toISOString()).toBe(f.from);
  });

  it('une fenêtre commencée dans le passé est ramenée à maintenant ; entièrement passée ou invalide : 400', async () => {
    const { svc, prisma } = monterLot();
    await svc.ecarterEnLot(admin, fenetre(-48, 24));
    const where = proposalsOf(prisma).findMany.mock.calls[0][0].where;
    expect(Math.abs(where.endAt.gt.getTime() - Date.now())).toBeLessThan(5_000);

    await expect(svc.ecarterEnLot(admin, fenetre(-48, -24))).rejects.toThrow('entièrement passée');
    await expect(svc.ecarterEnLot(admin, { from: 'n’importe quoi', to: dans(2).toISOString() })).rejects.toThrow('Fenêtre invalide');
    await expect(svc.ecarterEnLot(admin, fenetre(24, 2))).rejects.toThrow('Fenêtre invalide');
  });

  it('un véhicule choisi : lui seul dans le lot, mais la liste garde tous les véhicules gérés', async () => {
    const { svc, events } = monterLot({ lignes: LIGNES });

    const r = await svc.ecarterEnLot(admin, { ...fenetre(0, 7 * 24), vehicleId: 'v2' });

    expect(events.assertVehicleAccess).toHaveBeenCalledWith(admin, 'v2');
    expect(r.lotIds).toEqual(['p1', 'p3']);
    expect(r.concernees).toBe(2);
    expect(r.parVehicule.map((v) => v.vehicleId)).toEqual(['v1', 'v2']);
  });

  it('un véhicule d’une autre société que celle visée : 400, rien lu', async () => {
    const { svc, prisma } = monterLot({ lignes: LIGNES, societeVehicule: 'f-autre' });

    await expect(svc.ecarterEnLot(admin, { ...fenetre(0, 24), vehicleId: 'v9' })).rejects.toThrow('pas de la société');
    expect(proposalsOf(prisma).findMany).not.toHaveBeenCalled();
  });

  it('les véhicules dont on ne gère pas les réservations : jamais dans le lot, comptés à part ; choisi : 403 qui le nomme', async () => {
    const { svc } = monterLot({ lignes: LIGNES, gere: (vid) => vid !== 'v2' });

    const r = await svc.ecarterEnLot(admin, fenetre(0, 7 * 24));
    expect(r.lotIds).toEqual(['p2']);
    expect(r.horsGestion).toBe(2);
    expect(r.parVehicule).toEqual([{ vehicleId: 'v1', plate: 'AA-1', n: 1 }]);

    // La plaque vient de `vehicle.findUnique` (mock : AA-1), comme pour un « Écarter » à l'unité.
    await expect(svc.ecarterEnLot(admin, { ...fenetre(0, 24), vehicleId: 'v2' })).rejects.toThrow(
      'Vous ne gérez pas les réservations de AA-1',
    );
  });

  it('super-admin : une société est exigée (400) ; avec celle du bandeau, c’est elle qui est lue', async () => {
    const { svc, prisma } = monterLot({ lignes: LIGNES });

    await expect(svc.ecarterEnLot(superAdmin, fenetre(0, 24))).rejects.toThrow('Préciser la flotte');
    await svc.ecarterEnLot(superAdmin, { ...fenetre(0, 24), fleetId: 'fCLIENT' });
    expect(proposalsOf(prisma).findMany.mock.calls[0][0].where.fleetId).toBe('fCLIENT');
  });

  it('un gestionnaire : `fleetId` est ignoré, c’est SA société qui est lue (filtre resté d’une session super-admin)', async () => {
    const { svc, prisma } = monterLot({ lignes: LIGNES });

    await svc.ecarterEnLot(admin, { ...fenetre(0, 24), fleetId: 'f-autre' });

    expect(proposalsOf(prisma).findMany.mock.calls[0][0].where.fleetId).toBe('f1');
  });

  it('application SANS la liste montrée : 400 — on n’écarte jamais « tout » sans l’avoir vu', async () => {
    const { svc, prisma } = monterLot({ lignes: LIGNES });

    await expect(svc.ecarterEnLot(admin, { ...fenetre(0, 24), simulation: false })).rejects.toThrow('« ids » est obligatoire');
    await expect(svc.ecarterEnLot(admin, { ...fenetre(0, 24), simulation: false, ids: [] })).rejects.toThrow('« ids » est obligatoire');
    await expect(svc.ecarterEnLot(admin, { ...fenetre(0, 24), simulation: false, ids: [''] })).rejects.toThrow('« ids » invalide');
    expect(proposalsOf(prisma).updateMany).not.toHaveBeenCalled();
  });

  it('application : écrit SOUS CONDITION les seules propositions montrées, et UNE ligne de journal pour le lot', async () => {
    // p9 est arrivée depuis la simulation (passage de l'agent) : elle n'est pas dans `ids`.
    const { svc, prisma, activity } = monterLot({ lignes: [...LIGNES, prop('p9', 'v2', 30)] });
    proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 2 });

    const r = await svc.ecarterEnLot(admin, { ...fenetre(0, 7 * 24), vehicleId: 'v2', simulation: false, ids: ['p1', 'p3'] });

    expect(proposalsOf(prisma).updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p3'] }, fleetId: 'f1', status: 'pending' },
      data: { status: 'dismissed' },
    });
    expect(r).toMatchObject({ simulation: false, concernees: 2, ecartees: 2, dejaTraitees: 0 });
    // La liste « Véhicule » d'après : ce qui RESTE en attente — p2, et p9 qui n'a jamais été montrée.
    expect(r.parVehicule).toEqual([
      { vehicleId: 'v1', plate: 'AA-1', n: 1 },
      { vehicleId: 'v2', plate: 'BB-2', n: 1 },
    ]);
    expect(activity.record).toHaveBeenCalledTimes(1);
    const ligne = activity.record.mock.calls[0][0];
    expect(ligne).toMatchObject({
      category: 'AGENDA',
      action: 'propositions_ecartees',
      actor: 'utilisateur',
      target: 'BB-2',
      fleetId: 'f1',
      triggeredByUserId: 'u1',
    });
    expect(ligne.detail).toContain("2 propositions de l'agent écartées en lot — BB-2");
    expect(ligne.meta).toMatchObject({ vehicleId: 'v2', concernees: 2, ecartees: 2, dejaTraitees: 0, ids: ['p1', 'p3'] });
  });

  it('une proposition réservée (ou écartée) ailleurs entre-temps : non touchée, comptée « déjà traitée », dite au journal', async () => {
    // p3 a été réservée depuis : la base ne la rend plus en attente ; p1 perd la course de l'écriture.
    const { svc, prisma, activity } = monterLot({ lignes: [prop('p1', 'v2', 2)] });
    proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 0 });

    const r = await svc.ecarterEnLot(admin, { ...fenetre(0, 7 * 24), simulation: false, ids: ['p1', 'p3'] });

    expect(proposalsOf(prisma).updateMany.mock.calls[0][0].where.id).toEqual({ in: ['p1'] });
    expect(r).toMatchObject({ ecartees: 0, dejaTraitees: 2 });
    // Rien n'a changé : aucune ligne.
    expect(activity.record).not.toHaveBeenCalled();

    proposalsOf(prisma).findMany.mockResolvedValue(LIGNES);
    proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 2 });
    const r2 = await svc.ecarterEnLot(admin, { ...fenetre(0, 7 * 24), simulation: false, ids: ['p1', 'p2', 'p3'] });
    expect(r2).toMatchObject({ ecartees: 2, dejaTraitees: 1 });
    expect(activity.record.mock.calls[0][0].detail).toContain('(1 déjà traitée entre-temps, laissée telle quelle)');
    // Plusieurs véhicules : pas de plaque unique en cible.
    expect(activity.record.mock.calls[0][0].target).toBeNull();
  });

  it('plus de 500 propositions : les 500 premières, et la réponse le DIT', async () => {
    const beaucoup = Array.from({ length: 501 }, (_, i) => prop(`p${i}`, 'v1', 2 + i / 100));
    const { svc } = monterLot({ lignes: beaucoup });

    const r = await svc.ecarterEnLot(admin, fenetre(0, 30 * 24));

    expect(r.concernees).toBe(500);
    expect(r.plafonne).toBe(true);
    expect(r.lotIds).toHaveLength(500);
    expect(r.apercu).toHaveLength(8);
  });

  it('un journal en panne ne fait pas échouer le lot', async () => {
    const activity = { record: jest.fn(() => { throw new Error('journal HS'); }) };
    const reservations = makeReservations({ gereLesReservationsDe: jest.fn().mockResolvedValue(true) });
    const { svc, prisma } = monter({ reservations, activity });
    proposalsOf(prisma).findMany.mockResolvedValue(LIGNES);
    prisma.vehicle.findMany.mockResolvedValue(PLAQUES);
    proposalsOf(prisma).updateMany.mockResolvedValueOnce({ count: 3 });

    await expect(
      svc.ecarterEnLot(admin, { ...fenetre(0, 7 * 24), simulation: false, ids: ['p1', 'p2', 'p3'] }),
    ).resolves.toMatchObject({ ecartees: 3 });
  });
});
