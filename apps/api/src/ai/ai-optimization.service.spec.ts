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

/** Interrupteur maître IA — par défaut activé (comportement historique des tests). */
function makeAiAvail(enabled = true) {
  return { isConfigured: () => true, isEnabledForFleet: jest.fn().mockResolvedValue(enabled) } as never;
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
  aiAvail?: unknown;
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
    (over.aiAvail ?? makeAiAvail()) as never,
    (over.errors ?? makeErrors()) as never,
    (over.aiUsage ?? makeAiUsage()) as never,
  );
}

const SLOT = { startAt: '2026-07-06T06:00:00.000Z', endAt: '2026-07-06T07:00:00.000Z' };
const DAY = 24 * 60 * 60 * 1000;

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

  // ─── Placement × dormance : ne pas proposer un véhicule qu'on ne sait plus joindre ─────────

  /** Vivier renvoyé par la réservation : v1 vivant, v2 (le cas prod FV-941-LZ) muet. */
  function twoCandidates(extra: Record<string, unknown> = {}) {
    return makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt,
        endAt: SLOT.endAt,
        vehicles: [
          { vehicleId: 'v1', vehiclePlate: 'AA', seats: 9, childSeats: 8, features: [], utilizationRatio: 0.3, underutilized: false },
          { vehicleId: 'v2', vehiclePlate: 'FV-941-LZ', seats: 9, childSeats: 8, features: [], utilizationRatio: 0, underutilized: true },
        ],
        excludedUnknownCapacity: 0,
        excludedImmobilized: 0,
        ...extra,
      }),
    });
  }

  /** Meta véhicules (énergie + boîtier) telle que la lit `buildPlacementPayload`. */
  function metaPrisma(v2LastSeenAt: Date | null, v2Tracker: { id: string } | null = { id: 't2' }) {
    return makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', energy: 'DIESEL', fuelConsumptionL100km: 8, tracker: { id: 't1', lastSeenAt: new Date() } },
          {
            id: 'v2',
            energy: 'DIESEL',
            fuelConsumptionL100km: 8,
            tracker: v2Tracker ? { ...v2Tracker, lastSeenAt: v2LastSeenAt } : null,
          },
        ]),
        update: jest.fn(),
      },
    });
  }

  it('suggestPlacement : véhicule DORMANT (89 j) écarté du vivier IA, compté, et le résumé annonce le périmètre réel', async () => {
    const anthropic = makeAnthropic({ proposals: [{ vehicleId: 'v1', score: 0.9, reasoning: 'ok' }], noGoodMatch: false, notes: null });
    const svc = build({
      prisma: metaPrisma(new Date(Date.now() - 89 * DAY)),
      reservations: twoCandidates(),
      anthropic,
    });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    // Le muet n'atteint jamais le raisonnement (il serait classé 1er : ratio 0 = « à mutualiser »).
    expect(payload.candidates.map((c: { vehicleId: string }) => c.vehicleId)).toEqual(['v1']);
    expect(payload.fleetSummary.totalVehicles).toBe(1);
    expect(payload.fleetSummary.dormantExcluded).toBe(1);
    expect(payload.fleetSummary.underutilizedCount).toBe(0); // le 0 % du muet ne pollue plus le résumé
    expect(payload.scopeNote).toContain('7 jours');
    // Le périmètre annoncé au modèle est celui qu'on a RÉELLEMENT mesuré : `suggest()` est borné
    // aux véhicules accessibles à cet utilisateur puis aux critères. Dire « de cette flotte »
    // ferait écrire au modèle, dans ses notes rendues au client, un état du parc entier qu'aucune
    // requête n'a établi (un chef de groupe lirait « 2 véhicules hors service » sur 40).
    expect(payload.scopeNote).toContain('périmètre analysé');
    expect(payload.scopeNote).not.toContain('de cette flotte');
    // Transparence UI : le chiffre ne baisse pas en silence.
    expect(res.excludedDormant).toBe(1);
  });

  it('suggestPlacement : silence de 2 h -> candidat NORMAL (aucune exclusion, aucune note de périmètre)', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false, notes: null });
    const svc = build({
      prisma: metaPrisma(new Date(Date.now() - 2 * 60 * 60 * 1000)),
      reservations: twoCandidates(),
      anthropic,
    });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    expect(payload.candidates.map((c: { vehicleId: string }) => c.vehicleId)).toEqual(['v1', 'v2']);
    expect(payload.scopeNote).toBeUndefined(); // pas d'exclusion -> pas d'affirmation d'exclusion
    expect(res.excludedDormant).toBe(0);
  });

  it('suggestPlacement : véhicule SANS boîtier -> reste proposable (il est réservable, juste pas suivi)', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false, notes: null });
    const svc = build({
      prisma: metaPrisma(null, null), // v2 sans tracker du tout
      reservations: twoCandidates(),
      anthropic,
    });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    expect(payload.candidates.map((c: { vehicleId: string }) => c.vehicleId)).toEqual(['v1', 'v2']);
    expect(res.excludedDormant).toBe(0);
  });

  it('suggestPlacement : boîtier affecté mais JAMAIS vu -> reste proposable (« jamais connecté » ≠ « s\'est tu »)', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false, notes: null });
    const svc = build({ prisma: metaPrisma(null), reservations: twoCandidates(), anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    expect(payload.candidates.map((c: { vehicleId: string }) => c.vehicleId)).toEqual(['v1', 'v2']);
    expect(res.excludedDormant).toBe(0);
  });

  it('suggestPlacement : réintégration automatique dès que le boîtier ré-émet', async () => {
    const muetAi = makeAnthropic({ proposals: [], noGoodMatch: false, notes: null });
    const muet = build({ prisma: metaPrisma(new Date(Date.now() - 8 * DAY)), reservations: twoCandidates(), anthropic: muetAi });
    await muet.suggestPlacement(makeUser(), { ...SLOT });
    expect(
      (muetAi as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload.candidates,
    ).toHaveLength(1);

    // Une seule trame reçue suffit : aucun bouton « réactiver », aucune écriture en base.
    const revenuAi = makeAnthropic({ proposals: [], noGoodMatch: false, notes: null });
    const revenu = build({ prisma: metaPrisma(new Date()), reservations: twoCandidates(), anthropic: revenuAi });
    const res = await revenu.suggestPlacement(makeUser(), { ...SLOT });
    expect(
      (revenuAi as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload.candidates,
    ).toHaveLength(2);
    expect(res.excludedDormant).toBe(0);
  });

  it('suggestPlacement : compteur du vivier amont additionné SANS double comptage', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false, notes: null });
    // L'amont a déjà écarté 2 muets (ils ne sont plus dans `vehicles`) ; on en trouve 1 de plus ici.
    const svc = build({
      prisma: metaPrisma(new Date(Date.now() - 30 * DAY)),
      reservations: twoCandidates({ excludedDormant: 2 }),
      anthropic,
    });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    expect(res.excludedDormant).toBe(3);
  });

  it('suggestPlacement : parc entièrement muet -> noGoodMatch qui NOMME la cause, sans dépenser un jeton', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false });
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', energy: 'DIESEL', fuelConsumptionL100km: 8, tracker: { id: 't1', lastSeenAt: new Date(Date.now() - 40 * DAY) } },
          { id: 'v2', energy: 'DIESEL', fuelConsumptionL100km: 8, tracker: { id: 't2', lastSeenAt: new Date(Date.now() - 89 * DAY) } },
        ]),
        update: jest.fn(),
      },
    });
    const svc = build({ prisma, reservations: twoCandidates(), anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT });
    expect(res.noGoodMatch).toBe(true);
    expect(res.proposals).toEqual([]);
    expect(res.excludedDormant).toBe(2);
    expect(res.notes).toContain('boîtier muet');
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('suggestCapacity : les DORMANTS restent dans le payload (le nombre de places ne dépend pas du boîtier)', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA', type: 'VAN', brand: 'Citroën', model: 'ë-Jumpy', seats: null, childSeats: null, features: [] },
        ]),
        update: jest.fn(),
      },
    });
    const anthropic = makeAnthropic({ proposals: [] });
    const svc = build({ prisma, anthropic });

    await svc.suggestCapacity(makeUser(), {});
    // La requête capacité ne filtre PAS sur la liveness du boîtier : elle décrit le véhicule
    // physique. Sinon la fiche d'un véhicule muet resterait incomplète pour toujours.
    const where = (prisma as unknown as { vehicle: { findMany: jest.Mock } }).vehicle.findMany.mock.calls[0][0].where;
    expect(where.tracker).toBeUndefined();
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    expect(payload.vehicles).toHaveLength(1);
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
