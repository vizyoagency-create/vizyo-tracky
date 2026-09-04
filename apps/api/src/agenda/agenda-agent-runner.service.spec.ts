import { AiServiceError } from '../ai/anthropic.client';
import { AgendaAgentRunnerService } from './agenda-agent-runner.service';
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

function makeSettings(over: Record<string, unknown> = {}) {
  return {
    enabled: true, autonomy: 'auto_high_confidence', confidenceThreshold: 80,
    nightlyHour: 2, frequency: 'daily', triggerNightly: true, lastRunAt: null, ...over,
  };
}

function makePrisma(settings: unknown, existingProposal: unknown = null) {
  return {
    agendaAgentSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      update: jest.fn().mockResolvedValue({}),
    },
    agendaAgentProposal: {
      findUnique: jest.fn().mockResolvedValue(existingProposal),
      create: jest.fn().mockResolvedValue({}),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    fleet: { findUnique: jest.fn().mockResolvedValue({ metier: 'CHILDREN_TRANSPORT', name: 'CDEF' }) },
    // Historique des passages : présent dans le mock pour que les tests exercent la VRAIE
    // écriture (sinon tout partirait dans le catch défensif de recordRun sans qu'on le voie).
    agendaAgentRun: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as never;
}
/** Accès typé au mock d'historique. */
function runsOf(prisma: unknown) {
  return (prisma as { agendaAgentRun: { create: jest.Mock; findMany: jest.Mock; deleteMany: jest.Mock } }).agendaAgentRun;
}
function makeAnthropic(reviews: unknown[]) {
  return {
    isConfigured: () => true,
    completeJson: jest.fn().mockResolvedValue({
      result: { reviews },
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      model: 'claude-opus-4-8', latencyMs: 1,
    }),
  } as never;
}
const makeAiUsage = () => ({ record: jest.fn() } as never);
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
  } as never;
}
function makeReservations(over: Record<string, unknown> = {}) {
  return {
    systemConfirm: jest.fn().mockResolvedValue({ id: 'ev1', vehiclePlate: 'AA-1' }),
    isVehicleFree: jest.fn().mockResolvedValue(true),
    ...over,
  } as never;
}
const makeEvents = () => ({ assertVehicleAccess: jest.fn().mockResolvedValue('f1') } as never);
const makeActivity = () => ({ record: jest.fn() } as never);
const makeErrors = () => ({ record: jest.fn().mockResolvedValue('log-1') } as never);
/** Anthropic dont l'appel IA ÉCHOUE (quota/timeout) → l'agent doit dégrader ET journaliser l'alerte. */
const makeAnthropicThrows = () =>
  ({ isConfigured: () => true, completeJson: jest.fn().mockRejectedValue(new Error('quota dépassé')) } as never);

describe('AgendaAgentRunnerService (P3.3 — agent nocturne)', () => {
  it('auto (confiance ≥ seuil) : crée des réservations FERMES (auto_applied)', async () => {
    const prisma = makePrisma(makeSettings());
    const reservations = makeReservations();
    const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), reservations, makeEvents(), makeActivity());

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.created).toBeGreaterThanOrEqual(1);
    expect((reservations as unknown as { systemConfirm: jest.Mock }).systemConfirm).toHaveBeenCalled();
    const data = (prisma as unknown as { agendaAgentProposal: { create: jest.Mock } }).agendaAgentProposal.create.mock.calls[0][0].data;
    expect(data.status).toBe('auto_applied');
    expect(data.createdEventId).toBe('ev1');
  });

  it('suggestions seules : ne réserve PAS, ajoute des propositions pending', async () => {
    const prisma = makePrisma(makeSettings({ autonomy: 'suggest' }));
    const reservations = makeReservations();
    const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), reservations, makeEvents(), makeActivity());

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.proposed).toBeGreaterThanOrEqual(1);
    expect(res.created).toBe(0);
    expect((reservations as unknown as { systemConfirm: jest.Mock }).systemConfirm).not.toHaveBeenCalled();
    const data = (prisma as unknown as { agendaAgentProposal: { create: jest.Mock } }).agendaAgentProposal.create.mock.calls[0][0].data;
    expect(data.status).toBe('pending');
  });

  /**
   * Historique des passages. Jusqu'ici seul `lastRunAt` survivait : on savait QUAND l'agent avait
   * tourné, jamais ce qu'il avait fait. Le test le plus important est le dernier : la traçabilité
   * ne doit JAMAIS faire échouer un passage qui, lui, a bien travaillé.
   */
  describe('historique des passages', () => {
    it('archive un passage réussi avec ce qu\'il a fait (motifs, créées, proposées, ignorées)', async () => {
      const prisma = makePrisma(makeSettings());
      const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), makeReservations(), makeEvents(), makeActivity());

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

    it('marque aiUsed quand la couche IA a réellement jugé', async () => {
      const prisma = makePrisma(makeSettings());
      const svc = new AgendaAgentRunnerService(
        prisma, makeDetector([PATTERN]), makeReservations(), makeEvents(), makeActivity(),
        makeAnthropic([{ index: 0, keep: true, reasoning: 'Récurrence stable' }]) as never,
        makeAiUsage() as never,
        { isEnabledForFleet: jest.fn().mockResolvedValue(true) } as never,
      );

      await svc.runForFleet('f1', 'scheduled');

      expect(runsOf(prisma).create.mock.calls[0]![0].data.aiUsed).toBe(true);
    });

    it('archive AUSSI un passage en échec (sinon un agent cassé passerait pour un agent inactif)', async () => {
      const prisma = makePrisma(makeSettings());
      const detector = { detectWithStats: jest.fn().mockRejectedValue(new Error('détecteur HS')) };
      const svc = new AgendaAgentRunnerService(prisma, detector as never, makeReservations(), makeEvents(), makeActivity());

      await expect(svc.runForFleet('f1', 'scheduled')).rejects.toThrow('détecteur HS');

      const data = runsOf(prisma).create.mock.calls[0]![0].data;
      expect(data).toEqual(expect.objectContaining({ status: 'error', error: 'détecteur HS' }));
    });

    it('élague au-delà du plafond par société', async () => {
      const prisma = makePrisma(makeSettings());
      runsOf(prisma).findMany.mockResolvedValue([{ id: 'vieux-1' }, { id: 'vieux-2' }]);
      const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), makeReservations(), makeEvents(), makeActivity());

      await svc.runForFleet('f1', 'scheduled');

      expect(runsOf(prisma).deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['vieux-1', 'vieux-2'] } } });
    });

    it('⚠️ un historique qui échoue ne casse PAS le passage', async () => {
      const prisma = makePrisma(makeSettings());
      runsOf(prisma).create.mockRejectedValue(new Error('table absente'));
      const reservations = makeReservations();
      const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), reservations, makeEvents(), makeActivity());

      const res = await svc.runForFleet('f1', 'scheduled');

      // Le travail utile a bien eu lieu, malgré la traçabilité en panne.
      expect(res.created).toBeGreaterThanOrEqual(1);
      expect((reservations as unknown as { systemConfirm: jest.Mock }).systemConfirm).toHaveBeenCalled();
    });
  });

  it('dédup : une occurrence déjà proposée n\'est pas recréée (skipped)', async () => {
    const prisma = makePrisma(makeSettings(), { id: 'existing' });
    const reservations = makeReservations();
    const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), reservations, makeEvents(), makeActivity());

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.created).toBe(0);
    expect((prisma as unknown as { agendaAgentProposal: { create: jest.Mock } }).agendaAgentProposal.create).not.toHaveBeenCalled();
    expect((reservations as unknown as { systemConfirm: jest.Mock }).systemConfirm).not.toHaveBeenCalled();
  });

  it('couche IA : Claude écarte une récurrence (keep=false) -> pas de réservation, coût tracé', async () => {
    const prisma = makePrisma(makeSettings());
    const reservations = makeReservations();
    const anthropic = makeAnthropic([{ index: 0, keep: false, reasoning: 'Récurrence trop instable' }]);
    const aiUsage = makeAiUsage();
    const svc = new AgendaAgentRunnerService(prisma, makeDetector([PATTERN]), reservations, makeEvents(), makeActivity(), anthropic, aiUsage);

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res.created).toBe(0);
    expect((reservations as unknown as { systemConfirm: jest.Mock }).systemConfirm).not.toHaveBeenCalled();
    expect((prisma as unknown as { agendaAgentProposal: { create: jest.Mock } }).agendaAgentProposal.create).not.toHaveBeenCalled();
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).toHaveBeenCalled();
    expect((aiUsage as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(expect.objectContaining({ action: 'agenda_agent', fleetId: 'f1' }));
  });

  it('échec de la couche IA -> journalisé au centre d\'alerte (AGENDA_AGENT_AI) sans casser le run', async () => {
    const prisma = makePrisma(makeSettings({ autonomy: 'suggest' }));
    const errors = makeErrors();
    const svc = new AgendaAgentRunnerService(
      prisma, makeDetector([PATTERN]), makeReservations(), makeEvents(), makeActivity(),
      makeAnthropicThrows(), makeAiUsage(), errors,
    );

    const res = await svc.runForFleet('f1', 'manual'); // ne throw pas : dégrade en déterministe
    expect(res.proposed).toBeGreaterThanOrEqual(1); // l'agent a quand même proposé (fallback)
    expect((errors as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      expect.any(Error),
      'AGENDA_AGENT_AI',
      expect.objectContaining({ fleetId: 'f1' }),
      'ERROR', // par défaut : une panne IA sans niveau déclaré reste un défaut
    );
  });

  // ── TRK-061 — c'est CE chemin qui est tombé le 04/09 à 00:01 ───────────────────────────
  //
  // Le compte du fournisseur était à sec depuis 25 h. L'agent nocturne doit se comporter comme
  // l'optimiseur interactif : même incident, même gravité. Sans ce test, la classification aurait
  // pu rester juste d'un seul côté — le défaut que corrige `NIVEAU_PAR_KIND`.
  it('TRK-061 : compte du fournisseur à sec -> DEGRADATION, et le run continue', async () => {
    const prisma = makePrisma(makeSettings({ autonomy: 'suggest' }));
    const errors = makeErrors();
    const panne = new AiServiceError(
      'provider_unfunded',
      "Assistance IA indisponible : le compte du fournisseur n'a plus de crédit.",
      'Your credit balance is too low to access the Anthropic API.',
    );
    const anthropic = { completeJson: jest.fn().mockRejectedValue(panne), isConfigured: () => true } as never;
    const svc = new AgendaAgentRunnerService(
      prisma, makeDetector([PATTERN]), makeReservations(), makeEvents(), makeActivity(),
      anthropic, makeAiUsage(), errors,
    );

    const res = await svc.runForFleet('f1', 'manual');
    expect(res.proposed).toBeGreaterThanOrEqual(1); // le raisonnement déterministe survit

    const [, source, contexte, niveau] = (errors as unknown as { record: jest.Mock }).record.mock.calls[0];
    expect(source).toBe('AGENDA_AGENT_AI');
    expect(niveau).toBe('DEGRADATION');
    expect(contexte).toMatchObject({ motifFournisseur: expect.stringContaining('credit balance') });
  });

  it('planifié + agent désactivé : no-op (ne détecte même pas)', async () => {
    const prisma = makePrisma(makeSettings({ enabled: false }));
    const detector = makeDetector([PATTERN]);
    const svc = new AgendaAgentRunnerService(prisma, detector, makeReservations(), makeEvents(), makeActivity());

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res).toMatchObject({ created: 0, proposed: 0, skipped: 0 });
    expect((detector as unknown as { detectWithStats: jest.Mock }).detectWithStats).not.toHaveBeenCalled();
  });

  /**
   * L'agent n'a pas de garde de dormance à lui : elle est en amont, dans le détecteur. Son devoir,
   * c'est de ne pas laisser disparaître ce qui a été écarté — un « 0 proposition » silencieux
   * passerait pour un agent en panne alors que la flotte a simplement des boîtiers muets.
   */
  describe('exclusions amont (boîtiers muets, habitudes éteintes)', () => {
    it('les remonte dans ignoré(s) et les DÉTAILLE dans le journal d\'activité', async () => {
      const prisma = makePrisma(makeSettings());
      const activity = makeActivity();
      const svc = new AgendaAgentRunnerService(
        prisma,
        makeDetector([], { skippedDormantVehicles: 2, skippedStalePatterns: 1 }),
        makeReservations(), makeEvents(), activity,
      );

      const res = await svc.runForFleet('f1', 'scheduled');

      expect(res).toMatchObject({ created: 0, proposed: 0, skipped: 3 });
      const rec = (activity as unknown as { record: jest.Mock }).record.mock.calls[0][0];
      expect(rec.detail).toContain('2 véhicule(s) au boîtier muet, 1 habitude(s) éteinte(s)');
      expect(rec.meta).toMatchObject({ skippedDormantVehicles: 2, skippedStalePatterns: 1 });
      // L'historique conserve la trace : 0 motif exploitable, 3 écartés.
      expect(runsOf(prisma).create.mock.calls[0]![0].data).toEqual(
        expect.objectContaining({ patterns: 0, skipped: 3, status: 'completed' }),
      );
    });

    it('rien d\'écarté : le libellé reste propre (pas de parenthèse à zéro)', async () => {
      const activity = makeActivity();
      const svc = new AgendaAgentRunnerService(
        makePrisma(makeSettings()), makeDetector([PATTERN]), makeReservations(), makeEvents(), activity,
      );

      await svc.runForFleet('f1', 'scheduled');

      const rec = (activity as unknown as { record: jest.Mock }).record.mock.calls[0][0];
      expect(rec.detail).not.toContain('boîtier muet');
    });
  });
});
