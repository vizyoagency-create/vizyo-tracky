import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AiOptimizationService } from './ai-optimization.service';
import { AiServiceError } from './anthropic.client';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    fleet: { findUnique: jest.fn().mockResolvedValue({ metier: 'CHILDREN_TRANSPORT', name: 'CDEF' }) },
    vehicle: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    vehicleEvent: { findMany: jest.fn().mockResolvedValue([]) },
    installationTask: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as never;
}

function access(ids: string[] | 'ALL') {
  return { getAccessibleVehicleIds: jest.fn().mockResolvedValue(ids) } as never;
}

function makeEvents(over: Record<string, unknown> = {}) {
  return { assertVehicleAccess: jest.fn().mockResolvedValue('f1'), ...over } as never;
}

function makeReservations(over: Record<string, unknown> = {}) {
  return { suggest: jest.fn().mockResolvedValue({ startAt: '', endAt: '', vehicles: [] }), ...over } as never;
}

function makeForecast(over: Record<string, unknown> = {}) {
  return { getForecast: jest.fn().mockResolvedValue({ from: '', to: '', slots: [] }), ...over } as never;
}

function makeAnthropic(result: unknown) {
  // completeJson renvoie désormais { result, usage, model, latencyMs } (palier « Coûts IA »).
  return {
    completeJson: jest.fn().mockResolvedValue({
      result,
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      model: 'claude-opus-4-8',
      latencyMs: 1,
    }),
    isConfigured: () => true,
  } as never;
}

function makeErrors() {
  return { record: jest.fn().mockResolvedValue('log-1') } as never;
}

function makeAiUsage() {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    costOf: jest.fn().mockReturnValue(0.02),
    eurRate: jest.fn().mockReturnValue(0.92),
  } as never;
}

function build(over: {
  prisma?: unknown;
  access?: unknown;
  events?: unknown;
  reservations?: unknown;
  forecast?: unknown;
  anthropic?: unknown;
  errors?: unknown;
  aiUsage?: unknown;
} = {}) {
  return new AiOptimizationService(
    (over.prisma ?? makePrisma()) as never,
    (over.access ?? access('ALL')) as never,
    (over.events ?? makeEvents()) as never,
    (over.reservations ?? makeReservations()) as never,
    (over.forecast ?? makeForecast()) as never,
    (over.anthropic ?? makeAnthropic({ proposals: [] })) as never,
    (over.errors ?? makeErrors()) as never,
    (over.aiUsage ?? makeAiUsage()) as never,
  );
}

const SLOT = { startAt: '2026-07-06T06:00:00.000Z', endAt: '2026-07-06T07:00:00.000Z' };

describe('AiOptimizationService — Sprint 9 (copilote IA)', () => {
  // ─── Capacité ──────────────────────────────────────────────────────────────

  it('suggestCapacity : payload scopé (énergie du planning), filtre les ids hallucinés', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA', type: 'VAN', brand: 'Citroën', model: 'ë-Jumpy', seats: null, childSeats: null, features: [] },
        ]),
        update: jest.fn(),
      },
      installationTask: { findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v1', energy: 'ELECTRIQUE' }]) },
    });
    const anthropic = makeAnthropic({
      proposals: [
        { vehicleId: 'v1', seats: 9, childSeats: 6, features: ['climatisation'], confidence: 0.5, reasoning: 'navette probable' },
        { vehicleId: 'GHOST', seats: 5, childSeats: 3, features: [], confidence: 0.9, reasoning: 'inconnu' },
      ],
    });
    const svc = build({ prisma, anthropic });

    const res = await svc.suggestCapacity(makeUser(), {});
    expect(res.metier).toBe('CHILDREN_TRANSPORT');
    expect(res.proposals.map((p) => p.vehicleId)).toEqual(['v1']); // GHOST ignoré
    expect(res.proposals[0]).toMatchObject({ plate: 'AA', model: 'ë-Jumpy', seats: 9, childSeats: 6 });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    expect(payload.vehicles[0].energy).toBe('ELECTRIQUE');
    expect((prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update).not.toHaveBeenCalled();
  });

  it('previewCapacity : renvoie le payload EXACT sans appeler l\'IA (live data, testable Console)', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA', type: 'VAN', brand: 'Citroën', model: 'ë-Jumpy', seats: null, childSeats: null, features: [] },
        ]),
        update: jest.fn(),
      },
      installationTask: { findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v1', energy: 'ELECTRIQUE' }]) },
    });
    const anthropic = makeAnthropic({});
    const svc = build({ prisma, anthropic });

    const payload = await svc.previewCapacity(makeUser(), {});
    expect(payload.metier).toBe('CHILDREN_TRANSPORT');
    expect(payload.fleetContext).toBe('CDEF');
    expect(payload.vehicles[0]).toMatchObject({ vehicleId: 'v1', model: 'ë-Jumpy', energy: 'ELECTRIQUE' });
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('suggestCapacity : assainit les valeurs aberrantes (seats négatif → null, confidence clampée, features non-array → [])', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA', type: 'CAR', brand: 'X', model: 'Y', seats: null, childSeats: null, features: [] }]),
        update: jest.fn(),
      },
    });
    const anthropic = makeAnthropic({
      proposals: [{ vehicleId: 'v1', seats: -3, childSeats: 2.7, features: 'pas-un-tableau', confidence: 5, reasoning: 42 }],
    });
    const svc = build({ prisma, anthropic });

    const res = await svc.suggestCapacity(makeUser(), {});
    expect(res.proposals[0]).toMatchObject({ seats: null, childSeats: 2, features: [], confidence: 1, reasoning: '' });
  });

  it('suggestCapacity : échec IA → journalisé (centre d\'alerte) + propagé', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA', type: 'CAR', brand: 'X', model: 'Y', seats: null, childSeats: null, features: [] }]),
        update: jest.fn(),
      },
    });
    const anthropic = { completeJson: jest.fn().mockRejectedValue(new AiServiceError('quota', 'Quota IA atteint')), isConfigured: () => true } as never;
    const errors = makeErrors();
    const svc = build({ prisma, anthropic, errors });

    await expect(svc.suggestCapacity(makeUser(), {})).rejects.toBeInstanceOf(AiServiceError);
    expect((errors as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      'Quota IA atteint',
      'AI_OPTIMIZER',
      expect.objectContaining({ capability: 'capacity', kind: 'quota', fleetId: 'f1' }),
      'ERROR',
    );
  });

  it('suggestCapacity : super-admin sans fleetId et sans dto.fleetId -> 400', async () => {
    const svc = build();
    await expect(svc.suggestCapacity(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('suggestCapacity : non-super qui vise une autre flotte -> 403 (anti-IDOR)', async () => {
    const svc = build();
    await expect(svc.suggestCapacity(makeUser(), { fleetId: 'f2' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('applyCapacity : écrit la capacité scopée (assertVehicleAccess) + assainit', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) } });
    const events = makeEvents();
    const svc = build({ prisma, events });

    const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9, childSeats: -1, features: ['clim'] }] });
    expect(res.updated).toBe(1);
    expect((events as unknown as { assertVehicleAccess: jest.Mock }).assertVehicleAccess).toHaveBeenCalledWith(expect.anything(), 'v1');
    const data = (prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ seats: 9, childSeats: null, features: ['clim'] }); // childSeats négatif → null
  });

  it('applyCapacity : véhicule hors périmètre -> rejette sans écrire', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn(), update: jest.fn() } });
    const events = makeEvents({ assertVehicleAccess: jest.fn().mockRejectedValue(new ForbiddenException()) });
    const svc = build({ prisma, events });

    await expect(svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'vX', seats: 5 }] })).rejects.toBeInstanceOf(ForbiddenException);
    expect((prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update).not.toHaveBeenCalled();
  });

  // ─── Placement ─────────────────────────────────────────────────────────────

  it('suggestPlacement : aucun candidat libre -> noGoodMatch sans appeler l\'IA', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false });
    const svc = build({ anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { minChildSeats: 7 } });
    expect(res.noGoodMatch).toBe(true);
    expect(res.proposals).toEqual([]);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('suggestPlacement : marque forecastBusy, filtre les hallucinations, trie par score', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt,
        endAt: SLOT.endAt,
        vehicles: [
          { vehicleId: 'v1', vehiclePlate: 'AA', seats: 9, childSeats: 8, features: [], utilizationRatio: 0.06, underutilized: true },
          { vehicleId: 'v2', vehiclePlate: 'BB', seats: 9, childSeats: 8, features: [], utilizationRatio: 0.4, underutilized: false },
        ],
      }),
    });
    const forecast = makeForecast({
      getForecast: jest.fn().mockResolvedValue({
        from: '', to: '',
        slots: [{ vehicleId: 'v2', startAt: SLOT.startAt, endAt: SLOT.endAt, dayOfWeek: 1, basis: '', confidence: 0.8 }],
      }),
    });
    const anthropic = makeAnthropic({
      proposals: [
        { vehicleId: 'v2', score: 0.7, reasoning: 'ok mais sollicité' },
        { vehicleId: 'v1', score: 0.95, reasoning: 'idéal, sous-utilisé' },
        { vehicleId: 'GHOST', score: 1, reasoning: 'inconnu' },
      ],
      noGoodMatch: false,
      notes: null,
    });
    const prisma = makePrisma();
    const svc = build({ prisma, reservations, forecast, anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, title: '7 enfants', criteria: { minChildSeats: 7 } });
    expect(res.proposals.map((p) => p.vehicleId)).toEqual(['v1', 'v2']); // trié par score, GHOST filtré
    expect(res.proposals[0]).toMatchObject({ plate: 'AA', seats: 9, childSeats: 8 });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    const v2 = payload.candidates.find((c: { vehicleId: string }) => c.vehicleId === 'v2');
    expect(v2.forecastBusy).toBe(true);
    expect((prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update).not.toHaveBeenCalled();
  });

  it('suggestPlacement : enrichit le payload avec énergie + coût/km + maintenance imminente (P3)', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt,
        vehicles: [
          { vehicleId: 'v1', vehiclePlate: 'AA', seats: 5, childSeats: 0, features: [], utilizationRatio: 0.05, underutilized: true },
          { vehicleId: 'v2', vehiclePlate: 'BB', seats: 5, childSeats: 0, features: [], utilizationRatio: 0.2, underutilized: false },
        ],
      }),
    });
    const prisma = makePrisma({
      fleet: { findUnique: jest.fn().mockResolvedValue({ metier: 'GENERIC', name: 'F' }) },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', energy: 'ELECTRIQUE', fuelConsumptionL100km: null }, // 0,03 €/km forfait
          { id: 'v2', energy: 'DIESEL', fuelConsumptionL100km: 8 },        // 8/100 * 1,75 = 0,14 €/km
        ]),
        update: jest.fn(),
      },
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v2' }]) }, // maintenance imminente sur v2
    });
    const anthropic = makeAnthropic({
      proposals: [{ vehicleId: 'v1', score: 0.9, reasoning: 'électrique, le moins cher' }],
      noGoodMatch: false, notes: null,
    });
    const svc = build({ prisma, reservations, anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    const v1 = payload.candidates.find((c: { vehicleId: string }) => c.vehicleId === 'v1');
    const v2 = payload.candidates.find((c: { vehicleId: string }) => c.vehicleId === 'v2');
    expect(v1).toMatchObject({ energy: 'ELECTRIQUE', costPerKm: 0.03, upcomingMaintenance: false });
    expect(v2).toMatchObject({ energy: 'DIESEL', costPerKm: 0.14, upcomingMaintenance: true });
    expect(payload.fleetSummary.cheapestCostPerKm).toBe(0.03);
    // Proposition : coût/km propagé ; coût de l'appel IA renvoyé (costOf 0,02 × 0,92).
    expect(res.proposals[0]).toMatchObject({ energy: 'ELECTRIQUE', costPerKm: 0.03 });
    expect(res.aiCostEur).toBeCloseTo(0.0184, 4);
  });

  it('suggestPlacement : super-admin SANS fleetId -> 400 (jamais d\'agrégation multi-flottes)', async () => {
    const reservations = makeReservations();
    const svc = build({ reservations });
    await expect(
      svc.suggestPlacement(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), { ...SLOT }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // La flotte est exigée AVANT de lister le moindre candidat : pas de fuite inter-tenant.
    expect((reservations as unknown as { suggest: jest.Mock }).suggest).not.toHaveBeenCalled();
  });

  it('suggestPlacement : super-admin AVEC fleetId -> candidats + coût IA scopés à CETTE flotte', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt,
        vehicles: [{ vehicleId: 'v1', vehiclePlate: 'AA', seats: 9, childSeats: 8, features: [], utilizationRatio: 0.05, underutilized: true }],
      }),
    });
    const aiUsage = makeAiUsage();
    const anthropic = makeAnthropic({ proposals: [{ vehicleId: 'v1', score: 0.9, reasoning: 'ok' }], noGoodMatch: false, notes: null });
    const svc = build({ reservations, aiUsage, anthropic });

    await svc.suggestPlacement(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), { ...SLOT, fleetId: 'f9' });
    // suggest() est appelé scopé à la flotte demandée (plus de parc agrégé)
    expect((reservations as unknown as { suggest: jest.Mock }).suggest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fleetId: 'f9' }),
    );
    // le coût IA est imputé à la flotte résolue (avant : null pour un super-admin)
    expect((aiUsage as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'placement', fleetId: 'f9' }),
    );
  });
});
