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
  } as never;
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
function makeDetector(patterns: RecurringPattern[]) {
  return { detect: jest.fn().mockResolvedValue(patterns) } as never;
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

  it('planifié + agent désactivé : no-op (ne détecte même pas)', async () => {
    const prisma = makePrisma(makeSettings({ enabled: false }));
    const detector = makeDetector([PATTERN]);
    const svc = new AgendaAgentRunnerService(prisma, detector, makeReservations(), makeEvents(), makeActivity());

    const res = await svc.runForFleet('f1', 'scheduled');
    expect(res).toMatchObject({ created: 0, proposed: 0, skipped: 0 });
    expect((detector as unknown as { detect: jest.Mock }).detect).not.toHaveBeenCalled();
  });
});
