import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccessType, UserRole } from '@prisma/client';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
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
    // Analyse conservée (28/09) : aucune par défaut → la garde « une par jour » laisse passer.
    aiCapacityAnalysis: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'an1', createdAt: new Date('2026-09-28T12:00:00Z') }),
      update: jest.fn().mockResolvedValue({}),
    },
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

/**
 * Droits par véhicule (T9) — par défaut, tout est permis : les tests historiques tournent en admin
 * de flotte, que le vrai résolveur laisse passer sans requête. Le cas « lecture seule sur un
 * groupe » se teste avec le VRAI `PermissionsResolverService` (voir le bloc T9).
 */
function makePermissions() {
  return {
    resolveForVehicles: jest.fn().mockResolvedValue(new Map()),
    canOnVehicle: jest.fn().mockResolvedValue(true),
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
  permissions?: unknown;
  /** Journal métier (29/09) — absent par défaut, comme avant : il est @Optional. */
  systemActivity?: unknown;
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
    (over.permissions ?? makePermissions()) as never,
    over.systemActivity as never,
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
    expect(res.proposals[0]).toMatchObject({ plate: 'AA', model: 'ë-Jumpy', seats: 9 });
    // Revue du 29/09 : la fiche lue à l'analyse voyage avec la proposition.
    expect(res.proposals[0]).toMatchObject({ currentSeats: null, currentFeatures: [] });
    // Sièges auto (28/09) : un stock de la société, plus une capacité devinée par véhicule.
    expect(res.proposals[0]).not.toHaveProperty('childSeats');
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

  it('suggestCapacity : assainit les valeurs aberrantes (seats hors 1..99 → null, confidence clampée, équipements nettoyés)', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA', type: 'CAR', brand: 'X', model: 'Y', seats: null, childSeats: null, features: [] },
          { id: 'v2', plate: 'BB', type: 'CAR', brand: 'X', model: 'Y', seats: null, childSeats: null, features: [] },
        ]),
        update: jest.fn(),
      },
    });
    const anthropic = makeAnthropic({
      proposals: [
        // Places négatives, équipements sales : doublon de casse, non-chaîne, vide, trop long (> 40).
        { vehicleId: 'v1', seats: -3, childSeats: 2.7, features: [' clim ', 42, '', 'CLIM', 'x'.repeat(41)], confidence: 5, reasoning: 42 },
        // Équipements qui ne sont pas un tableau → [] ; 2,5 places n'est pas un nombre de places.
        { vehicleId: 'v2', seats: 2.5, features: 'pas-un-tableau', confidence: -1, reasoning: 'ok' },
      ],
    });
    const svc = build({ prisma, anthropic });

    const res = await svc.suggestCapacity(makeUser(), {});
    expect(res.proposals[0]).toMatchObject({ vehicleId: 'v1', seats: null, features: ['clim'], confidence: 1, reasoning: '' });
    // v2 n'apporte rien une fois assaini (ni place valide, ni équipement) : il n'est pas conservé.
    expect(res.proposals.map((p) => p.vehicleId)).toEqual(['v1']);
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
    // TRK-061 — on passe l'INSTANCE, pas son message : `ErrorLogger` marque l'erreur qu'il
    // archive pour qu'une couche supérieure ne la réécrive pas, et il ne peut marquer qu'un
    // OBJET. Avec une chaîne, le marqueur ne se posait sur rien — d'où « un incident, deux
    // lignes » le 03/09 (`AI_OPTIMIZER` puis `http`, 17 ms plus tard, pour un seul appel).
    expect((errors as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Quota IA atteint' }),
      'AI_OPTIMIZER',
      expect.objectContaining({ capability: 'capacity', kind: 'quota', fleetId: 'f1' }),
      'ERROR',
    );
  });

  // ── TRK-061 — le compte du fournisseur à sec ────────────────────────────────────────────
  it('TRK-061 : compte sans crédit → DEGRADATION, motif fournisseur dans le CONTEXTE', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA', type: 'CAR', brand: 'X', model: 'Y', seats: null, childSeats: null, features: [] }]),
        update: jest.fn(),
      },
    });
    const panne = new AiServiceError(
      'provider_unfunded',
      "Assistance IA indisponible : le compte du fournisseur n'a plus de crédit.",
      'Your credit balance is too low to access the Anthropic API.',
    );
    const anthropic = { completeJson: jest.fn().mockRejectedValue(panne), isConfigured: () => true } as never;
    const errors = makeErrors();
    const svc = build({ prisma, anthropic, errors });

    await expect(svc.suggestCapacity(makeUser(), {})).rejects.toBeInstanceOf(AiServiceError);

    const [erreur, source, contexte, niveau] = (errors as unknown as { record: jest.Mock }).record.mock.calls[0];
    // La gravité vient de l'erreur elle-même, plus de cet appelant : le même incident ne peut
    // plus être « défaut » ici et « dégradation » ailleurs.
    expect(niveau).toBe('DEGRADATION');
    expect(source).toBe('AI_OPTIMIZER');
    // Le motif du fournisseur est archivé — mais dans le contexte, pas dans ce que lit le client.
    expect(contexte).toMatchObject({ kind: 'provider_unfunded', motifFournisseur: expect.stringContaining('credit balance') });
    expect((erreur as Error).message).not.toMatch(/credit balance/i);
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
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA', seats: null, features: [] }]),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const events = makeEvents();
    const svc = build({ prisma, events });

    const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9, childSeats: 3, features: ['clim'] } as never] });
    expect(res).toEqual({ updated: 1, skipped: [] });
    expect((events as unknown as { assertVehicleAccess: jest.Mock }).assertVehicleAccess).toHaveBeenCalledWith(expect.anything(), 'v1');
    const data = (prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update.mock.calls[0][0].data;
    expect(data).toEqual({ seats: 9, features: ['clim'] }); // un `childSeats` reçu n'est plus écrit : stock société (28/09)
  });

  it('applyCapacity : véhicule hors périmètre -> ÉCARTÉ avec son motif, sans écrire ni livrer sa plaque (revue du 29/09)', async () => {
    const prisma = makePrisma({
      vehicle: { findMany: jest.fn().mockResolvedValue([{ id: 'vX', plate: 'SECRET', seats: null, features: [] }]), update: jest.fn() },
    });
    const events = makeEvents({ assertVehicleAccess: jest.fn().mockRejectedValue(new ForbiddenException()) });
    const svc = build({ prisma, events });

    const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'vX', seats: 5 }] });
    expect(res).toEqual({ updated: 0, skipped: [{ vehicleId: 'vX', plate: null, motif: expect.stringMatching(/hors de votre périmètre/) }] });
    expect((prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update).not.toHaveBeenCalled();
  });

  // Revue du 29/09 (T9) — le contrôleur ne voit `vehicles_edit` qu'en union des scopes. Un
  // gestionnaire « Nord : modifier / Sud : lire » réécrivait les places d'un véhicule Sud.
  describe('T9 : vehicles_edit résolu sur CHAQUE véhicule (vrai résolveur de droits)', () => {
    const scopes = [
      { accessType: AccessType.GROUP, permissions: { vehicles_view: true, vehicles_edit: true }, vehicleId: null, group: { vehicles: [{ vehicleId: 'vN' }] } },
      { accessType: AccessType.GROUP, permissions: { vehicles_view: true, vehicles_edit: false }, vehicleId: null, group: { vehicles: [{ vehicleId: 'vS' }] } },
    ];
    const parc = () =>
      makePrisma({
        vehicle: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'vN', plate: 'NORD', seats: null, features: [] },
            { id: 'vS', plate: 'SUD', seats: null, features: [] },
          ]),
          update: jest.fn().mockResolvedValue({}),
        },
      });
    const resolveur = () => {
      const acces = { findMany: jest.fn().mockResolvedValue(scopes) };
      return { acces, service: new PermissionsResolverService({ userVehicleAccess: acces } as never) };
    };

    it('un véhicule du périmètre en LECTURE SEULE est écarté avec son motif, sans être écrit ni noté ; l’autre est écrit', async () => {
      const prisma = parc();
      const { acces, service } = resolveur();
      const svc = build({ prisma, permissions: service });

      const gestionnaire = makeUser({ role: UserRole.FLEET_MANAGER });
      const res = await svc.applyCapacity(gestionnaire, { items: [{ vehicleId: 'vN', seats: 9 }, { vehicleId: 'vS', seats: 9 }] });

      expect(res).toEqual({
        updated: 1,
        // Pas de plaque lue en base pour un refus : l'écran la tient de sa proposition.
        skipped: [{ vehicleId: 'vS', plate: null, motif: expect.stringMatching(/Modifier un véhicule/) }],
      });
      const update = (prisma as unknown as { vehicle: { update: jest.Mock } }).vehicle.update;
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0].where).toEqual({ id: 'vN' });
      // Une seule lecture des droits pour tout le lot (VPS à 2 vCPU) : le cache de la requête sert ensuite.
      expect(acces.findMany).toHaveBeenCalledTimes(1);
    });

    it('un admin de flotte passe sans lire les droits (même règle que la garde)', async () => {
      const prisma = parc();
      const { acces, service } = resolveur();
      const svc = build({ prisma, permissions: service });

      const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'vN', seats: 9 }, { vehicleId: 'vS', seats: 9 }] });
      expect(res).toEqual({ updated: 2, skipped: [] });
      expect(acces.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── Placement ─────────────────────────────────────────────────────────────

  it('suggestPlacement : aucun candidat libre -> noGoodMatch sans appeler l\'IA', async () => {
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false });
    const svc = build({ anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { childSeatsChild: 7 } });
    expect(res.noGoodMatch).toBe(true);
    expect(res.proposals).toEqual([]);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  // ─── Sièges auto (2026-09-28) : un STOCK société, deux types non substituables ───────────

  it('suggestPlacement : tous les véhicules libres écartés faute de sièges → noGoodMatch SANS appeler l\'IA, en le disant', async () => {
    // Le vivier a jugé (sièges à bord, puis stock selon la politique) : plus aucun candidat, 2 écartés.
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt, vehicles: [],
        childSeats: { startAt: SLOT.startAt, endAt: SLOT.endAt, policy: 'STOCK_OR_INSTALLED', total: { baby: 1, child: 4 }, installed: { baby: 0, child: 0 }, stock: { baby: 1, child: 4 }, engaged: { baby: 1, child: 0 }, available: { baby: 0, child: 4 } },
        excludedChildSeats: 2, excludedUnknownCapacity: 0, excludedImmobilized: 0, excludedDormant: 0,
      }),
    });
    const anthropic = makeAnthropic({ proposals: [{ vehicleId: 'v1', score: 0.9, reasoning: 'ok' }], noGoodMatch: false, notes: null });
    const svc = build({ reservations, anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { childSeatsBaby: 1, childSeatsChild: 2 } });
    expect(res.noGoodMatch).toBe(true);
    expect(res.proposals).toEqual([]);
    expect(res.excludedChildSeats).toBe(2);
    expect(res.notes).toMatch(/sièges auto demandés.*2 véhicule\(s\) écarté\(s\)/);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('suggestPlacement : besoin couvert → l\'IA lit la politique, le stock du créneau, et par candidat l\'à-bord et le reste à prendre au stock', async () => {
    const dispo = { startAt: SLOT.startAt, endAt: SLOT.endAt, policy: 'STOCK_OR_INSTALLED', total: { baby: 2, child: 4 }, installed: { baby: 1, child: 2 }, stock: { baby: 1, child: 2 }, engaged: { baby: 0, child: 0 }, available: { baby: 1, child: 2 } };
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt,
        vehicles: [{
          vehicleId: 'v1', vehiclePlate: 'AA', seats: 9, features: [], utilizationRatio: 0.05, underutilized: true,
          childSeatsInstalled: { baby: 1, child: 2 }, childSeatsFromStock: { baby: 0, child: 0 },
        }],
        childSeats: dispo,
        excludedChildSeats: 0, excludedUnknownCapacity: 0, excludedImmobilized: 0, excludedDormant: 0,
      }),
    });
    const anthropic = makeAnthropic({ proposals: [{ vehicleId: 'v1', score: 0.9, reasoning: 'déjà équipé' }], noGoodMatch: false, notes: null });
    const svc = build({ reservations, anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { childSeatsBaby: 1, childSeatsChild: 2 } });
    expect(res.proposals.map((p) => p.vehicleId)).toEqual(['v1']);
    expect(res.proposals[0]).not.toHaveProperty('childSeats');
    const payload = (anthropic as unknown as { completeJson: jest.Mock }).completeJson.mock.calls[0][0].userPayload;
    expect(payload.childSeats).toEqual(dispo);
    expect(payload.request.criteria).toEqual({ childSeatsBaby: 1, childSeatsChild: 2 });
    expect(payload.candidates[0]).toMatchObject({ childSeatsInstalled: { baby: 1, child: 2 }, childSeatsFromStock: { baby: 0, child: 0 } });
    expect(payload.candidates[0]).not.toHaveProperty('childSeats');
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

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, title: '7 enfants', criteria: { minSeats: 8 } });
    expect(res.proposals.map((p) => p.vehicleId)).toEqual(['v1', 'v2']); // trié par score, GHOST filtré
    expect(res.proposals[0]).toMatchObject({ plate: 'AA', seats: 9 });
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

/**
 * ── UNE ANALYSE DE CAPACITÉS PAR JOUR ET PAR SOCIÉTÉ, CONSERVÉE (refonte UX du 28/09, point 6) ──
 * « Les utilisateurs peuvent lancer l'analyse autant de fois qu'ils le souhaitent alors que cela ne
 * va rien changer. » Le serveur garde le résultat et refuse d'en payer un second avant 24 h.
 */
describe('AiOptimizationService — analyse de capacités : une par jour, conservée', () => {
  const unVehicule = () =>
    makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA', type: 'VAN', brand: 'Citroën', model: 'ë-Jumpy', seats: null, features: [] },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    });
  const propose = () => makeAnthropic({ proposals: [{ vehicleId: 'v1', seats: 9, features: [], confidence: 0.8, reasoning: 'ok' }] });

  it('une analyse réussie est CONSERVÉE, et le résultat porte sa date', async () => {
    const prisma = unVehicule();
    const svc = build({ prisma, anthropic: propose() });
    const res = await svc.suggestCapacity(makeUser(), {});
    const create = (prisma as unknown as { aiCapacityAnalysis: { create: jest.Mock } }).aiCapacityAnalysis.create;
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fleetId: 'f1', createdBy: 'u1', metier: 'CHILDREN_TRANSPORT', proposalsCount: 1 }),
      }),
    );
    expect(res.analysisId).toBe('an1');
    expect(res.analysedAt).toBe('2026-09-28T12:00:00.000Z');
  });

  it('une seconde analyse dans les 24 h est REFUSÉE (429) sans dépenser un jeton, et le message date la prochaine', async () => {
    const prisma = unVehicule();
    (prisma as unknown as { aiCapacityAnalysis: { findFirst: jest.Mock } }).aiCapacityAnalysis.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const anthropic = propose();
    const svc = build({ prisma, anthropic });
    await expect(svc.suggestCapacity(makeUser(), {})).rejects.toMatchObject({ status: 429 });
    await expect(svc.suggestCapacity(makeUser(), {})).rejects.toThrow(/Une analyse par jour et par société/);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('après 24 h, une nouvelle analyse passe', async () => {
    const prisma = unVehicule();
    (prisma as unknown as { aiCapacityAnalysis: { findFirst: jest.Mock } }).aiCapacityAnalysis.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 25 * 3_600_000),
    });
    const svc = build({ prisma, anthropic: propose() });
    const res = await svc.suggestCapacity(makeUser(), {});
    expect(res.proposals).toHaveLength(1);
  });

  it('un super-admin peut FORCER (recette) ; un admin de société, non', async () => {
    const recente = { createdAt: new Date(Date.now() - 3_600_000) };
    const prisma = unVehicule();
    (prisma as unknown as { aiCapacityAnalysis: { findFirst: jest.Mock } }).aiCapacityAnalysis.findFirst.mockResolvedValue(recente);
    const svc = build({ prisma, anthropic: propose() });
    await expect(svc.suggestCapacity(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), { fleetId: 'f1', force: true })).resolves.toMatchObject({ analysisId: 'an1' });
    await expect(svc.suggestCapacity(makeUser(), { force: true })).rejects.toMatchObject({ status: 429 });
  });

  it('latestCapacity : rend la dernière analyse et quand la prochaine est possible', async () => {
    const prisma = unVehicule();
    const il_y_a_2h = new Date(Date.now() - 2 * 3_600_000);
    (prisma as unknown as { aiCapacityAnalysis: { findFirst: jest.Mock } }).aiCapacityAnalysis.findFirst.mockResolvedValue({
      id: 'an1', fleetId: 'f1', createdAt: il_y_a_2h, metier: 'CHILDREN_TRANSPORT',
      proposals: [{ vehicleId: 'v1', plate: 'AA', model: null, seats: 9, features: [], confidence: 0.8, reasoning: 'ok' }],
      appliedVehicleIds: ['v1'],
    });
    const svc = build({ prisma });
    const res = await svc.latestCapacity(makeUser(), undefined);
    expect(res.canRun).toBe(false);
    expect(new Date(res.nextAllowedAt!).getTime()).toBe(il_y_a_2h.getTime() + 24 * 3_600_000);
    expect(res.analysis).toMatchObject({ id: 'an1', appliedVehicleIds: ['v1'] });
    expect(res.analysis!.proposals).toHaveLength(1);
  });

  it('latestCapacity : sans analyse, on peut lancer', async () => {
    const svc = build({ prisma: unVehicule() });
    await expect(svc.latestCapacity(makeUser(), undefined)).resolves.toMatchObject({
      analysis: null, canRun: true, nextAllowedAt: null, enCours: false,
    });
  });

  it('applyCapacity : note sur l’analyse conservée les véhicules appliqués', async () => {
    const prisma = unVehicule();
    const an = (prisma as unknown as { aiCapacityAnalysis: { findFirst: jest.Mock; update: jest.Mock } }).aiCapacityAnalysis;
    an.findFirst.mockResolvedValue({
      id: 'an1',
      proposals: [
        { vehicleId: 'v0', plate: 'ZZ', model: null, seats: 5, features: [], confidence: 0.8, reasoning: 'ok', currentSeats: null, currentFeatures: [] },
        { vehicleId: 'v1', plate: 'AA', model: null, seats: 9, features: [], confidence: 0.8, reasoning: 'ok', currentSeats: null, currentFeatures: [] },
      ],
      appliedVehicleIds: ['v0'],
    });
    const svc = build({ prisma });
    await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9 }] });
    // Ajout ATOMIQUE (`push`) des seuls nouveaux : deux applications simultanées ne s'effacent plus.
    expect(an.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'an1' }, data: expect.objectContaining({ appliedVehicleIds: { push: ['v1'] } }) }),
    );
  });
});

/**
 * ── REVUE DU 29/09 — L'ANALYSE CONSERVÉE NE DOIT NI FUIR, NI BLOQUER, NI ÉCRASER ──────────────────
 * Depuis la refonte, l'analyse vit en base des jours et se partage entre postes : elle doit rester
 * bornée au périmètre de chacun, ne pas se payer deux fois, et « Appliquer » doit compléter une
 * fiche sans rien effacer ni réécrire une correction faite à la main.
 */
describe('AiOptimizationService — revue du 29/09 : analyse de capacités conservée', () => {
  const A1 = '11111111-1111-4111-8111-111111111111';
  const A2 = '22222222-2222-4222-8222-222222222222';
  const A3 = '33333333-3333-4333-8333-333333333333';

  type Fiche = { id: string; plate?: string; seats: number | null; features: string[] };
  /** `vehicle.findMany` qui respecte `where.id.in` : sert au payload (sans filtre) comme aux relectures. */
  function parc(rows: Fiche[]) {
    return jest.fn().mockImplementation((args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      return Promise.resolve(
        rows
          .filter((r) => !ids || ids.includes(r.id))
          .map((r) => ({ type: 'VAN', brand: 'Citroën', model: 'Jumpy', plate: r.id.toUpperCase(), ...r })),
      );
    });
  }
  function prismaAvec(rows: Fiche[], analyseConservee: unknown = null) {
    return makePrisma({
      vehicle: { findMany: parc(rows), update: jest.fn().mockResolvedValue({}) },
      aiCapacityAnalysis: {
        findFirst: jest.fn().mockResolvedValue(analyseConservee),
        create: jest.fn().mockResolvedValue({ id: A1, createdAt: new Date('2026-09-29T08:00:00Z') }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
  }
  /** Une proposition telle que conservée depuis le 29/09 (avec l'instantané de la fiche). */
  const prop = (vehicleId: string, seats: number | null, currentSeats: number | null, extra: Record<string, unknown> = {}) => ({
    vehicleId, plate: vehicleId.toUpperCase(), model: 'Jumpy', seats, features: [], confidence: 0.8, reasoning: 'ok',
    currentSeats, currentFeatures: [], ...extra,
  });
  const analyse = (proposals: unknown[], appliedVehicleIds: string[] = [], ilYA = 2 * 3_600_000) => ({
    id: A1, fleetId: 'f1', createdAt: new Date(Date.now() - ilYA), metier: 'CHILDREN_TRANSPORT', proposals, appliedVehicleIds,
  });
  const mocks = (prisma: unknown) =>
    prisma as unknown as {
      vehicle: { findMany: jest.Mock; update: jest.Mock };
      aiCapacityAnalysis: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    };
  const manager = () => makeUser({ id: 'm1', role: UserRole.FLEET_MANAGER });
  const reponseIa = (proposals: unknown[]) => ({
    result: { proposals },
    usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    model: 'm',
    latencyMs: 1,
  });

  // ─── C10 — l'analyse de la SOCIÉTÉ n'est lancée et lue que dans le bon périmètre ─────────────

  it('C10 : un gestionnaire au périmètre partiel ne lance pas l’analyse de la société (403, ni lecture, ni appel IA, ni ligne)', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }]);
    const anthropic = makeAnthropic({ proposals: [{ vehicleId: 'v1', seats: 9, features: [], confidence: 0.8, reasoning: 'ok' }] });
    const svc = build({ prisma, anthropic, access: access(['v1']) });

    await expect(svc.suggestCapacity(manager(), {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.suggestCapacity(manager(), {})).rejects.toThrow(/toute la société/);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
    expect(mocks(prisma).aiCapacityAnalysis.create).not.toHaveBeenCalled();
    expect(mocks(prisma).vehicle.findMany).not.toHaveBeenCalled();
  });

  it('C10 : une sélection vehicleIds est refusée, même à un administrateur (une analyse partielle confisquait le quota)', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }]);
    const anthropic = makeAnthropic({ proposals: [{ vehicleId: 'v1', seats: 9, features: [], confidence: 0.8, reasoning: 'ok' }] });
    const svc = build({ prisma, anthropic });

    await expect(svc.suggestCapacity(makeUser(), { vehicleIds: ['v1'] })).rejects.toBeInstanceOf(ForbiddenException);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
    // Une liste vide n'est pas une sélection.
    await expect(svc.suggestCapacity(makeUser(), { vehicleIds: [] })).resolves.toMatchObject({ analysisId: A1 });
  });

  it('C10 : latestCapacity borne propositions et appliedVehicleIds au périmètre ; canRun=false avec un motif', async () => {
    const prisma = prismaAvec(
      [
        { id: 'v1', seats: null, features: [] },
        { id: 'v2', seats: null, features: [] },
        { id: 'v3', seats: 9, features: [] },
      ],
      // Fenêtre de 24 h OUVERTE (30 h) : seul le périmètre empêche de lancer.
      analyse([prop('v1', 9, null), prop('v2', 9, null), prop('v3', 9, null)], ['v2', 'v3'], 30 * 3_600_000),
    );
    const svc = build({ prisma, access: access(['v1', 'v3']) });

    const res = await svc.latestCapacity(manager(), undefined);
    expect(res.analysis!.proposals.map((p) => p.vehicleId)).toEqual(['v1', 'v3']); // v2 : hors périmètre
    expect(res.analysis!.appliedVehicleIds).toEqual(['v3']);
    expect(res.canRun).toBe(false);
    expect(res.nextAllowedAt).toBeNull();
    expect(res.motif).toMatch(/toute la société/);
    // La relecture des fiches ne touche jamais un véhicule hors périmètre.
    expect(mocks(prisma).vehicle.findMany.mock.calls[0][0].where.id.in).not.toContain('v2');
  });

  it('C10 : un administrateur lit toute l’analyse, sans motif', async () => {
    const prisma = prismaAvec(
      [{ id: 'v1', seats: null, features: [] }, { id: 'v2', seats: null, features: [] }],
      analyse([prop('v1', 9, null), prop('v2', 9, null)], [], 30 * 3_600_000),
    );
    const svc = build({ prisma });
    const res = await svc.latestCapacity(makeUser(), undefined);
    expect(res).toMatchObject({ canRun: true, motif: null, nextAllowedAt: null });
    expect(res.analysis!.proposals).toHaveLength(2);
  });

  // ─── C11/C24 — un véhicule disparu ou refusé n'arrête plus « Appliquer » ────────────────────

  it('C11 : un véhicule supprimé ou hors périmètre est ÉCARTÉ avec son motif ; les autres sont écrits ET notés', async () => {
    const prisma = prismaAvec(
      [{ id: 'v1', plate: 'AA-111-AA', seats: null, features: [] }],
      { id: A1, proposals: [prop('v1', 9, null), prop('v3', 9, null), prop('v4', 9, null)], appliedVehicleIds: [] },
    );
    const events = makeEvents({
      assertVehicleAccess: jest.fn().mockImplementation((_u: unknown, id: string) => {
        if (id === 'v3') return Promise.reject(new NotFoundException('Véhicule introuvable'));
        if (id === 'v4') return Promise.reject(new ForbiddenException('Véhicule hors de votre flotte'));
        return Promise.resolve('f1');
      }),
    });
    const svc = build({ prisma, events });

    const res = await svc.applyCapacity(makeUser(), {
      items: [{ vehicleId: 'v3', seats: 9 }, { vehicleId: 'v1', seats: 9 }, { vehicleId: 'v4', seats: 9 }],
    });
    expect(res.updated).toBe(1);
    expect(res.skipped).toEqual([
      { vehicleId: 'v3', plate: null, motif: expect.stringMatching(/introuvable/) },
      { vehicleId: 'v4', plate: null, motif: expect.stringMatching(/périmètre/) },
    ]);
    expect(mocks(prisma).vehicle.update).toHaveBeenCalledTimes(1);
    expect(mocks(prisma).vehicle.update.mock.calls[0][0].where).toEqual({ id: 'v1' });
    expect(mocks(prisma).aiCapacityAnalysis.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: A1 }, data: expect.objectContaining({ appliedVehicleIds: { push: ['v1'] } }) }),
    );
  });

  it('C11 : une erreur imprévue interrompt l’envoi, mais ce qui a déjà été écrit est NOTÉ, et l’erreur remonte', async () => {
    const prisma = prismaAvec(
      [{ id: 'v1', seats: null, features: [] }, { id: 'v2', seats: null, features: [] }],
      { id: A1, proposals: [prop('v1', 9, null), prop('v2', 9, null)], appliedVehicleIds: [] },
    );
    mocks(prisma).vehicle.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('base indisponible'));
    const svc = build({ prisma });

    await expect(
      svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9 }, { vehicleId: 'v2', seats: 9 }] }),
    ).rejects.toThrow('base indisponible');
    expect(mocks(prisma).aiCapacityAnalysis.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: A1 }, data: expect.objectContaining({ appliedVehicleIds: { push: ['v1'] } }) }),
    );
  });

  it('C11 : latestCapacity écarte les propositions dont le véhicule n’existe plus dans la société', async () => {
    // v3 a été supprimé (ou transféré) : la relecture bornée à la société ne le rend plus.
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }], analyse([prop('v1', 9, null), prop('v3', 9, null)]));
    const svc = build({ prisma });
    const res = await svc.latestCapacity(makeUser(), undefined);
    expect(res.analysis!.proposals.map((p) => p.vehicleId)).toEqual(['v1']);
    expect(mocks(prisma).vehicle.findMany.mock.calls[0][0].where).toMatchObject({ fleetId: 'f1' });
  });

  // ─── C12/C22 — « Appliquer » complète la fiche, il ne l'écrase pas ─────────────────────────

  it('C12 : suggestCapacity garde l’instantané de la fiche et ne conserve que les propositions qui APPORTENT quelque chose', async () => {
    const prisma = prismaAvec([
      { id: 'v1', seats: 9, features: ['Climatisation'] },
      { id: 'v2', seats: null, features: [] },
      { id: 'v3', seats: 5, features: ['attelage'] },
      { id: 'v4', seats: 9, features: [] },
    ]);
    const anthropic = makeAnthropic({
      proposals: [
        { vehicleId: 'v1', seats: 9, features: ['climatisation'], confidence: 0.9, reasoning: 'déjà complet' }, // rien de neuf (casse ignorée)
        { vehicleId: 'v2', seats: 9, features: [], confidence: 0.8, reasoning: 'navette' },
        { vehicleId: 'v3', seats: 5, features: ['Attelage', 'rampe'], confidence: 0.7, reasoning: 'rampe PMR' },
        { vehicleId: 'v4', seats: 0, features: [], confidence: 0.4, reasoning: '0 place' }, // 0 refusé
      ],
    });
    const svc = build({ prisma, anthropic });

    const res = await svc.suggestCapacity(makeUser(), {});
    expect(res.proposals.map((p) => p.vehicleId)).toEqual(['v2', 'v3']);
    expect(res.proposals[0]).toMatchObject({ seats: 9, currentSeats: null, currentFeatures: [] });
    // Contre-revue du 29/09 (R7) : seuls les AJOUTS sont conservés — « Attelage » est déjà sur la fiche.
    expect(res.proposals[1]).toMatchObject({ seats: 5, features: ['rampe'], currentSeats: 5, currentFeatures: ['attelage'] });
    expect(mocks(prisma).aiCapacityAnalysis.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ proposalsCount: 2 }) }),
    );
  });

  it('C12 : applyCapacity n’écrit jamais seats à null ni à 0, et FUSIONNE les équipements (union, casse ignorée)', async () => {
    const prisma = prismaAvec([
      { id: 'v1', seats: 9, features: ['Attelage'] },
      { id: 'v2', seats: 7, features: [] },
    ]);
    const svc = build({ prisma });

    const res = await svc.applyCapacity(makeUser(), {
      items: [
        { vehicleId: 'v1', seats: null, features: ['attelage', 'climatisation'] },
        { vehicleId: 'v2', seats: 0, features: ['rampe'] },
      ],
    });
    expect(res).toEqual({ updated: 2, skipped: [] });
    const [v1, v2] = mocks(prisma).vehicle.update.mock.calls.map((c) => c[0]);
    expect(v1).toEqual({ where: { id: 'v1' }, data: { features: ['Attelage', 'climatisation'] } }); // « Attelage » saisi à la main reste
    expect(v2).toEqual({ where: { id: 'v2' }, data: { features: ['rampe'] } }); // 7 places gardées
  });

  it('C12 : une fiche modifiée depuis l’analyse est ÉCARTÉE, pas réécrite (correction manuelle dans la vue Parc)', async () => {
    // Analyse : Jumpy sans places, l'IA propose 3. Depuis, le gestionnaire a mis 9 dans la vue Parc.
    const prisma = prismaAvec(
      [{ id: 'v1', plate: 'AB-123-CD', seats: 9, features: [] }],
      { id: A1, proposals: [prop('v1', 3, null)], appliedVehicleIds: [] },
    );
    const svc = build({ prisma });

    const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 3, features: [] }] });
    expect(res).toEqual({ updated: 0, skipped: [{ vehicleId: 'v1', plate: 'AB-123-CD', motif: "fiche modifiée depuis l'analyse" }] });
    expect(mocks(prisma).vehicle.update).not.toHaveBeenCalled();
    expect(mocks(prisma).aiCapacityAnalysis.update).not.toHaveBeenCalled(); // pas « déjà appliqué » : il est à revoir
  });

  it('C12 : une fiche qui porte déjà la proposition n’est pas réécrite, mais la proposition est notée faite', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: 9, features: [] }], { id: A1, proposals: [prop('v1', 9, null)], appliedVehicleIds: [] });
    const svc = build({ prisma });

    const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9, features: [] }] });
    expect(res).toEqual({ updated: 0, skipped: [] });
    expect(mocks(prisma).vehicle.update).not.toHaveBeenCalled();
    expect(mocks(prisma).aiCapacityAnalysis.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ appliedVehicleIds: { push: ['v1'] } }) }),
    );
  });

  it('C12 : latestCapacity rend la fiche actuelle, signale une fiche modifiée, et retire ce qui n’apporte plus rien', async () => {
    const prisma = prismaAvec(
      [
        { id: 'v1', seats: 9, features: [] }, // corrigée à 9 à la main, l'IA proposait 3
        { id: 'v2', seats: null, features: ['attelage'] }, // intacte
        { id: 'v3', seats: 9, features: [] }, // corrigée à la main à la valeur proposée : plus rien à faire
      ],
      analyse([prop('v1', 3, null), prop('v2', 9, null, { currentFeatures: ['attelage'] }), prop('v3', 9, null)]),
    );
    const svc = build({ prisma });

    const res = await svc.latestCapacity(makeUser(), undefined);
    const parId = new Map(res.analysis!.proposals.map((p) => [p.vehicleId, p]));
    expect([...parId.keys()]).toEqual(['v1', 'v2']);
    expect(parId.get('v1')).toMatchObject({ nowSeats: 9, nowFeatures: [], ficheModifiee: true });
    expect(parId.get('v2')).toMatchObject({ nowSeats: null, nowFeatures: ['attelage'], ficheModifiee: false });
  });

  it('R8 : analyse du 28/09 SANS instantané — jamais « modifiée depuis l’analyse » (ni à l’écran, ni dans le 429) ; cochée, elle s’applique', async () => {
    // Le 28/09, l'IA répondait pour chaque véhicule : la fiche portait DÉJÀ 5 places, personne n'y a touché.
    const ancienne = { vehicleId: 'v1', plate: 'AA', model: 'Jumpy', seats: 9, features: [], confidence: 0.5, reasoning: 'fourgon 9 places' };
    const prisma = prismaAvec([{ id: 'v1', plate: 'AA', seats: 5, features: [] }], analyse([ancienne]));
    const svc = build({ prisma });

    const latest = await svc.latestCapacity(makeUser(), undefined);
    // L'écran montre « Places : 5 → 9 », sans affirmer une correction manuelle.
    expect(latest.analysis!.proposals[0]).toMatchObject({ ficheModifiee: false, nowSeats: 5, seats: 9 });
    const err = await svc.suggestCapacity(makeUser(), {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect((err as Error).message).toMatch(/1 proposition reste à appliquer\.$/);
    expect((err as Error).message).not.toMatch(/modifiée/);
    // Le gestionnaire l'a cochée en voyant « 5 → 9 » : elle s'applique, aucun motif inventé.
    const res = await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9 }] });
    expect(res).toEqual({ updated: 1, skipped: [] });
    expect(mocks(prisma).vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { seats: 9 } });
  });

  // ─── C13 — une seule analyse à la fois par société ─────────────────────────────────────────

  it('C13 : deux lancements simultanés — un seul appel payé, le second reçoit 429 « déjà en cours »', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }]);
    let repondre: (v: unknown) => void = () => undefined;
    let signaler: () => void = () => undefined;
    const appele = new Promise<void>((r) => {
      signaler = r;
    });
    const reponse = new Promise((r) => {
      repondre = r;
    });
    const completeJson = jest.fn().mockImplementation(() => {
      signaler();
      return reponse;
    });
    // Le gestionnaire « m1 » ne voit qu'une partie du parc ; les autres comptes voient tout.
    const acces = {
      getAccessibleVehicleIds: jest.fn().mockImplementation((u: { id: string }) => Promise.resolve(u.id === 'm1' ? ['v1'] : 'ALL')),
    };
    const svc = build({ prisma, access: acces, anthropic: { completeJson, isConfigured: () => true } });

    const premier = svc.suggestCapacity(makeUser(), {});
    await appele; // la première est chez l'IA, sa ligne n'existe pas encore
    await expect(svc.suggestCapacity(makeUser({ id: 'u2' }), {})).rejects.toMatchObject({
      status: 429,
      message: 'Une analyse de ce parc est déjà en cours.',
    });
    // Un onglet rechargé pendant l'attente voit le bouton grisé, et pourquoi — et `enCours` (R9),
    // pour relire jusqu'à la fin sans reconnaître la phrase du motif.
    await expect(svc.latestCapacity(makeUser(), undefined)).resolves.toMatchObject({
      canRun: false,
      motif: 'Une analyse de ce parc est déjà en cours.',
      enCours: true,
    });
    // Un périmètre partiel garde son motif, mais apprend aussi qu'une analyse tourne : il relira ses propositions.
    await expect(svc.latestCapacity(manager(), undefined)).resolves.toMatchObject({
      motif: expect.stringMatching(/toute la société/),
      enCours: true,
    });

    repondre(reponseIa([{ vehicleId: 'v1', seats: 9, features: [], confidence: 0.8, reasoning: 'ok' }]));
    await expect(premier).resolves.toMatchObject({ analysisId: A1 });
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(mocks(prisma).aiCapacityAnalysis.create).toHaveBeenCalledTimes(1);
    // Verrou libéré à la fin.
    await expect(svc.latestCapacity(makeUser(), undefined)).resolves.toMatchObject({ motif: null, enCours: false });
  });

  it('C13 : le verrou est libéré même quand l’IA échoue', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }]);
    const completeJson = jest
      .fn()
      .mockRejectedValueOnce(new AiServiceError('quota', 'Quota IA atteint'))
      .mockResolvedValueOnce(reponseIa([]));
    const svc = build({ prisma, anthropic: { completeJson, isConfigured: () => true } });

    await expect(svc.suggestCapacity(makeUser(), {})).rejects.toBeInstanceOf(AiServiceError);
    // R9 : un autre onglet qui relit voit l'analyse redevenue possible — plus « déjà en cours ».
    await expect(svc.latestCapacity(makeUser(), undefined)).resolves.toMatchObject({ enCours: false, canRun: true, motif: null });
    await expect(svc.suggestCapacity(makeUser(), {})).resolves.toMatchObject({ analysisId: A1 });
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  // ─── C14 — le refus 429 dit ce qu'il reste VRAIMENT ────────────────────────────────────────

  it('C14 : 429 — « restent à appliquer » seulement s’il reste des propositions non appliquées', async () => {
    const fiches = [{ id: 'v1', seats: null, features: [] }, { id: 'v2', seats: null, features: [] }];
    const prisma = prismaAvec(fiches, analyse([prop('v1', 9, null), prop('v2', 9, null)]));
    const svc = build({ prisma });
    const err = await svc.suggestCapacity(makeUser(), {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect((err as Error).message).toMatch(/^Une analyse par jour et par société.*2 propositions restent à appliquer\.$/);
  });

  it('C14 : 429 — une analyse sans proposition ne prétend pas qu’il reste quelque chose', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }], analyse([]));
    const svc = build({ prisma });
    const err = await svc.suggestCapacity(makeUser(), {}).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/rien trouvé à compléter/);
    expect((err as Error).message).not.toMatch(/reste/);
  });

  it('C14 : 429 — une analyse entièrement appliquée le dit', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: 9, features: [] }], analyse([prop('v1', 9, null)], ['v1']));
    const svc = build({ prisma });
    const err = await svc.suggestCapacity(makeUser(), {}).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Toutes ses propositions ont été appliquées/);
    expect((err as Error).message).not.toMatch(/reste/);
  });

  // ─── D3 — on note l'analyse que l'écran affichait ─────────────────────────────────────────

  it('D3 : applyCapacity note l’analyse analysisId si elle est de la société, sinon la dernière', async () => {
    const prisma = prismaAvec([{ id: 'v1', seats: null, features: [] }]);
    mocks(prisma).aiCapacityAnalysis.findFirst.mockImplementation((args: { where: { id?: string; fleetId: string } }) => {
      const { id, fleetId } = args.where;
      if (id === A1 && fleetId === 'f1') return Promise.resolve({ id: A1, proposals: [prop('v1', 9, null)], appliedVehicleIds: [] });
      if (id) return Promise.resolve(null); // A3 appartient à une autre société
      return Promise.resolve({ id: A2, proposals: [prop('v1', 9, null)], appliedVehicleIds: [] }); // la dernière
    });
    const svc = build({ prisma });
    const marquee = () => {
      const appels = mocks(prisma).aiCapacityAnalysis.update.mock.calls;
      return appels[appels.length - 1][0].where.id;
    };

    await svc.applyCapacity(makeUser(), { analysisId: A1, items: [{ vehicleId: 'v1', seats: 9 }] });
    expect(marquee()).toBe(A1);
    await svc.applyCapacity(makeUser(), { analysisId: A3, items: [{ vehicleId: 'v1', seats: 9 }] });
    expect(marquee()).toBe(A2);
    // Un identifiant mal formé n'atteint pas la base (la colonne est un uuid) : repli sur la dernière.
    await svc.applyCapacity(makeUser(), { analysisId: 'pas-un-uuid', items: [{ vehicleId: 'v1', seats: 9 }] });
    expect(marquee()).toBe(A2);
    expect(mocks(prisma).aiCapacityAnalysis.findFirst.mock.calls.some((c) => c[0].where.id === 'pas-un-uuid')).toBe(false);
  });

  // ─── Contre-revue du 29/09 ─────────────────────────────────────────────────────────────────

  /** `n` équipements distincts, tels qu'une fiche peut en porter (30 au plus, 40 caractères chacun). */
  const equipements = (n: number): string[] => Array.from({ length: n }, (_, i) => `équipement ${i + 1}`);
  const noteSurAnalyse = (prisma: unknown) =>
    mocks(prisma).aiCapacityAnalysis.update.mock.calls.flatMap((c) => c[0].data.appliedVehicleIds.push as string[]);

  it('R6 : une fiche modifiée depuis l’analyse n’est réécrite qu’avec forcer: true (« Appliquer quand même »)', async () => {
    // Analyse : Jumpy sans places, l'IA propose 3. Depuis, le gestionnaire a mis 9 dans la vue Parc.
    const prisma = prismaAvec(
      [{ id: 'v1', plate: 'AB-123-CD', seats: 9, features: [] }],
      { id: A1, proposals: [prop('v1', 3, null)], appliedVehicleIds: [] },
    );
    const svc = build({ prisma });

    // Sans le geste : écartée avec son motif, rien d'écrit, rien de noté.
    const sans = await svc.applyCapacity(makeUser(), { analysisId: A1, items: [{ vehicleId: 'v1', seats: 3 }] });
    expect(sans).toEqual({ updated: 0, skipped: [{ vehicleId: 'v1', plate: 'AB-123-CD', motif: "fiche modifiée depuis l'analyse" }] });
    // Un « true » qui n'est pas un booléen ne passe pas outre une correction manuelle.
    const chaine = await svc.applyCapacity(makeUser(), { analysisId: A1, items: [{ vehicleId: 'v1', seats: 3, forcer: 'true' as never }] });
    expect(chaine.updated).toBe(0);
    expect(mocks(prisma).vehicle.update).not.toHaveBeenCalled();
    expect(mocks(prisma).aiCapacityAnalysis.update).not.toHaveBeenCalled();

    // Avec le geste : réécrite, et notée faite.
    const avec = await svc.applyCapacity(makeUser(), { analysisId: A1, items: [{ vehicleId: 'v1', seats: 3, forcer: true }] });
    expect(avec).toEqual({ updated: 1, skipped: [] });
    expect(mocks(prisma).vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { seats: 3 } });
    expect(noteSurAnalyse(prisma)).toEqual(['v1']);
  });

  it('R7 : fiche de 20 équipements — l’union envoyée par un écran en cache garde son ajout (la borne ne tombe plus avant le tri)', async () => {
    const vingt = equipements(20);
    const prisma = prismaAvec(
      [{ id: 'v1', seats: 9, features: vingt }],
      { id: A1, proposals: [prop('v1', 9, 9, { features: ['rampe PMR'], currentFeatures: vingt })], appliedVehicleIds: [] },
    );
    const svc = build({ prisma });

    const res = await svc.applyCapacity(makeUser(), { analysisId: A1, items: [{ vehicleId: 'v1', features: [...vingt, 'rampe PMR'] }] });
    expect(res).toEqual({ updated: 1, skipped: [] });
    // Avant : les 20 existants remplissaient la borne, « rampe PMR » disparaissait, et le véhicule était noté appliqué.
    expect(mocks(prisma).vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { features: [...vingt, 'rampe PMR'] } });
    expect(noteSurAnalyse(prisma)).toEqual(['v1']);
  });

  it('R24 : features = les seuls AJOUTS (contrat du 29/09) — fiche de 19 + 2 ajouts : les deux sont écrits', async () => {
    const dixNeuf = equipements(19);
    const prisma = prismaAvec(
      [{ id: 'v1', seats: 9, features: dixNeuf }],
      { id: A1, proposals: [prop('v1', 9, 9, { features: ['clim', 'rampe'], currentFeatures: dixNeuf })], appliedVehicleIds: [] },
    );
    const svc = build({ prisma });

    const res = await svc.applyCapacity(makeUser(), { analysisId: A1, items: [{ vehicleId: 'v1', features: ['clim', 'rampe'] }] });
    expect(res).toEqual({ updated: 1, skipped: [] });
    const ecrit = mocks(prisma).vehicle.update.mock.calls[0][0].data.features as string[];
    expect(ecrit).toHaveLength(21);
    expect(ecrit.slice(-2)).toEqual(['clim', 'rampe']);
    expect(ecrit.slice(0, 19)).toEqual(dixNeuf); // l'existant, intact et en tête
  });

  it('R7 : une union qui dépasserait 30 équipements est ÉCARTÉE avec son motif — rien d’écrit en partie, rien de noté ; 30 tout juste passe', async () => {
    const prisma = prismaAvec(
      [
        { id: 'v1', plate: 'PLEIN-29', seats: 5, features: equipements(29) },
        { id: 'v2', plate: 'JUSTE-28', seats: 5, features: equipements(28) },
        { id: 'v3', plate: 'PLEIN-30', seats: null, features: equipements(30) },
      ],
      {
        id: A1,
        proposals: [
          prop('v1', 9, 5, { features: ['clim', 'rampe'], currentFeatures: equipements(29) }),
          prop('v2', 5, 5, { features: ['clim', 'rampe'], currentFeatures: equipements(28) }),
          prop('v3', 9, null, { currentFeatures: equipements(30) }),
        ],
        appliedVehicleIds: [],
      },
    );
    const svc = build({ prisma });

    const res = await svc.applyCapacity(makeUser(), {
      analysisId: A1,
      items: [
        // Les places aussi restent en l'état : le véhicule est écarté en entier, jamais à moitié.
        { vehicleId: 'v1', seats: 9, features: ['clim', 'rampe'] },
        { vehicleId: 'v2', features: ['clim', 'rampe'] },
        // Une fiche déjà pleine qui ne reçoit que des places n'est pas refusée : sa liste n'est pas réécrite.
        { vehicleId: 'v3', seats: 9 },
      ],
    });
    expect(res).toEqual({
      updated: 2,
      skipped: [{ vehicleId: 'v1', plate: 'PLEIN-29', motif: "trop d'équipements (30 au plus)" }],
    });
    expect(mocks(prisma).vehicle.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: 'v2' }, data: { features: [...equipements(28), 'clim', 'rampe'] } },
      { where: { id: 'v3' }, data: { seats: 9 } },
    ]);
    expect(noteSurAnalyse(prisma)).toEqual(['v2', 'v3']); // v1 reste à appliquer : on fait de la place dans la vue Parc
  });

  it('R7 : l’analyse garde l’ajout même quand l’IA recopie d’abord la fiche, et latest le montre sur une fiche de 20', async () => {
    const vingt = equipements(20);
    const prisma = prismaAvec([{ id: 'v1', seats: 9, features: vingt }]);
    const anthropic = makeAnthropic({
      proposals: [{ vehicleId: 'v1', seats: 9, features: [...vingt, 'rampe PMR'], confidence: 0.8, reasoning: 'rampe' }],
    });
    const svc = build({ prisma, anthropic });

    const res = await svc.suggestCapacity(makeUser(), {});
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ features: ['rampe PMR'], currentFeatures: vingt });

    // Relue demain : la fiche est inchangée, la proposition reste à appliquer — pas « modifiée ».
    mocks(prisma).aiCapacityAnalysis.findFirst.mockResolvedValue(analyse(res.proposals));
    const latest = await svc.latestCapacity(makeUser(), undefined);
    expect(latest.analysis!.proposals).toEqual([expect.objectContaining({ vehicleId: 'v1', ficheModifiee: false, nowFeatures: vingt })]);
  });

  it('R8 : 429 — les propositions à appliquer ET les fiches modifiées depuis sont dites ensemble', async () => {
    const prisma = prismaAvec(
      [
        { id: 'v1', seats: null, features: [] },
        { id: 'v2', seats: 9, features: [] }, // corrigée à 9 à la main, l'IA proposait 3
      ],
      analyse([prop('v1', 9, null), prop('v2', 3, null)]),
    );
    const svc = build({ prisma });
    const err = await svc.suggestCapacity(makeUser(), {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect((err as Error).message).toMatch(/1 proposition reste à appliquer, 1 fiche modifiée depuis est à revoir\.$/);
  });
});

/**
 * ── JOURNAL MÉTIER DE « APPLIQUER » ET « AUCUN VÉHICULE » QUI DIT POURQUOI (29/09) ──────────
 *
 * « Appliquer » les capacités laisse une ligne `capacites_appliquees` (catégorie AGENDA) PAR
 * SOCIÉTÉ DES VÉHICULES (un super-admin agit chez un client, parfois chez plusieurs d'un coup) :
 * appliqués / écartés / déjà à jour, et véhicule par véhicule dans `meta`. Un véhicule refusé avant
 * de connaître sa société (404, 403) n'est écrit chez personne.
 *
 * Placement : le 29/09 à 05:10, une demande de 12 places sur un parc dont le plus grand en a 9
 * recevait « Aucun véhicule libre ne correspond aux critères sur ce créneau » — on cherchait un
 * conflit d'horaire. La phrase vient désormais du constructeur partagé `messageAucunVehicule`.
 */
describe('AiOptimizationService — journal « Appliquer » et message « aucun véhicule » (29/09)', () => {
  const superAdmin = () => makeUser({ id: 'u-sa', role: UserRole.SUPER_ADMIN, fleetId: null });
  const parc = (fiches: { id: string; plate: string; seats: number | null; features: string[] }[]) =>
    makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue(fiches), update: jest.fn().mockResolvedValue({}) } });

  it('applyCapacity → capacites_appliquees, société des VÉHICULES, auteur réel, places avant → après', async () => {
    const journal = { record: jest.fn() };
    const prisma = parc([{ id: 'v1', plate: 'AA-1', seats: 5, features: [] }]);
    const events = makeEvents({ assertVehicleAccess: jest.fn().mockResolvedValue('fCLIENT') });
    const svc = build({ prisma, events, systemActivity: journal });

    await svc.applyCapacity(superAdmin(), { items: [{ vehicleId: 'v1', seats: 9, features: ['clim'] }] });

    expect(journal.record).toHaveBeenCalledTimes(1);
    const l = journal.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({
      category: 'AGENDA', action: 'capacites_appliquees', status: 'SUCCESS', actor: 'utilisateur',
      fleetId: 'fCLIENT', triggeredByUserId: 'u-sa', target: 'AA-1',
    }));
    expect(l.detail).toContain('1 véhicule(s) mis à jour (AA-1 : 5 → 9 places, + clim)');
    expect(l.meta).toEqual(expect.objectContaining({
      applied: 1, skipped: 0, unchanged: 0,
      vehicules: [expect.objectContaining({ vehicleId: 'v1', plate: 'AA-1', seats: { avant: 5, apres: 9 }, ajouts: ['clim'] })],
    }));
  });

  it('deux sociétés touchées d’un coup → deux lignes, chacune chez SA société ; un véhicule refusé (403) n’est écrit chez personne', async () => {
    const journal = { record: jest.fn() };
    const prisma = parc([
      { id: 'vA', plate: 'AA-1', seats: null, features: [] },
      { id: 'vB', plate: 'BB-2', seats: 9, features: [] },
      { id: 'vX', plate: 'SECRET', seats: null, features: [] },
    ]);
    const societes: Record<string, string> = { vA: 'fA', vB: 'fB' };
    const events = makeEvents({
      assertVehicleAccess: jest.fn().mockImplementation(async (_u: unknown, id: string) => {
        if (id === 'vX') throw new ForbiddenException();
        return societes[id];
      }),
    });
    const svc = build({ prisma, events, systemActivity: journal });

    await svc.applyCapacity(superAdmin(), { items: [{ vehicleId: 'vA', seats: 7 }, { vehicleId: 'vB', seats: 9 }, { vehicleId: 'vX', seats: 5 }] });

    const lignes = journal.record.mock.calls.map((c) => c[0]);
    expect(lignes.map((l) => l.fleetId).sort()).toEqual(['fA', 'fB']);
    const b = lignes.find((l) => l.fleetId === 'fB');
    // vB portait déjà 9 places : rien écrit, « déjà à jour », ligne SKIPPED.
    expect(b).toEqual(expect.objectContaining({ status: 'SKIPPED' }));
    expect(b.meta).toEqual(expect.objectContaining({ applied: 0, unchanged: 1 }));
    expect(JSON.stringify(lignes)).not.toContain('SECRET');
    expect(JSON.stringify(lignes)).not.toContain('vX');
  });

  it('un véhicule écarté (fiche modifiée depuis l’analyse) est compté et motivé dans la ligne de sa société', async () => {
    const journal = { record: jest.fn() };
    const prisma = parc([{ id: 'v1', plate: 'AA-1', seats: 9, features: [] }]);
    // L'analyse avait lu 5 places ; la fiche en porte 9 (corrigée à la main) → écartée.
    (prisma as unknown as { aiCapacityAnalysis: { findFirst: jest.Mock } }).aiCapacityAnalysis.findFirst.mockResolvedValue({
      id: 'an1', appliedVehicleIds: [],
      proposals: [{ vehicleId: 'v1', plate: 'AA-1', seats: 7, features: [], currentSeats: 5, currentFeatures: [], confidence: 0.8, reasoning: 'x' }],
    });
    const svc = build({ prisma, systemActivity: journal });

    await svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 7 }] });

    const l = journal.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({ fleetId: 'f1', status: 'SKIPPED' }));
    expect(l.detail).toContain('1 écarté(s)');
    expect(l.meta.ecartes).toEqual([expect.objectContaining({ vehicleId: 'v1', motif: expect.stringMatching(/modifiée/) })]);
  });

  it('journal EN PANNE (record lève) ou ABSENT : « Appliquer » écrit et répond pareil', async () => {
    const enPanne = { record: jest.fn(() => { throw new Error('journal HS'); }) };
    for (const systemActivity of [enPanne, undefined]) {
      const prisma = parc([{ id: 'v1', plate: 'AA-1', seats: null, features: [] }]);
      const svc = build({ prisma, systemActivity });
      await expect(svc.applyCapacity(makeUser(), { items: [{ vehicleId: 'v1', seats: 9 }] })).resolves.toEqual({ updated: 1, skipped: [] });
    }
    expect(enPanne.record).toHaveBeenCalledTimes(1);
  });

  it('placement « 12 places » sur un parc dont le plus grand en a 9 : le message parle de TAILLE, pas de créneau', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt, vehicles: [],
        excludedUnknownCapacity: 0, excludedImmobilized: 0, excludedDormant: 0, excludedChildSeats: 0,
        excludedTooSmall: 8, largestSeats: 9,
      }),
    });
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false });
    const svc = build({ reservations, anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { minSeats: 12 } });

    expect(res.noGoodMatch).toBe(true);
    expect(res.notes).toBe('Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9.');
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('placement : des véhicules assez grands existent mais aucun n’est libre → « aucun véhicule d’au moins N places n’est libre »', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt, vehicles: [], excludedDormant: 0, excludedTooSmall: 4, largestSeats: 9,
      }),
    });
    const svc = build({ reservations });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { minSeats: 8 } });
    expect(res.notes).toMatch(/^Aucun véhicule d'au moins 8 places n'est libre sur ce créneau\./);
  });

  it('placement Client test (relecture 29/09) : 5 places + siège bébé, 7 écartés pour les SIÈGES et 1 petit → le message parle des sièges, pas de la taille', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt, vehicles: [],
        excludedUnknownCapacity: 0, excludedImmobilized: 0, excludedDormant: 0,
        excludedTooSmall: 1, excludedChildSeats: 7, largestSeats: 9,
      }),
    });
    const anthropic = makeAnthropic({ proposals: [], noGoodMatch: false });
    const svc = build({ reservations, anthropic });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { minSeats: 5, childSeatsBaby: 1 } });

    expect(res.noGoodMatch).toBe(true);
    expect(res.notes).toMatch(/sièges auto demandés.*7 véhicule\(s\) écarté\(s\)/);
    expect(res.notes).not.toMatch(/au moins 5 places n'est libre/);
    expect(res.excludedChildSeats).toBe(7);
    expect((anthropic as unknown as { completeJson: jest.Mock }).completeJson).not.toHaveBeenCalled();
  });

  it('placement : sièges écartés MAIS parc vraiment trop petit (plus grand < plancher) → la TAILLE reste la cause', async () => {
    const reservations = makeReservations({
      suggest: jest.fn().mockResolvedValue({
        startAt: SLOT.startAt, endAt: SLOT.endAt, vehicles: [],
        excludedDormant: 0, excludedTooSmall: 8, excludedChildSeats: 1, largestSeats: 9,
      }),
    });
    const svc = build({ reservations });

    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { minSeats: 12 } });
    expect(res.notes).toBe('Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9.');
  });

  it('placement : un vivier qui ne rend pas encore les compteurs de taille garde le message d’avant', async () => {
    const svc = build();
    const res = await svc.suggestPlacement(makeUser(), { ...SLOT, criteria: { minSeats: 12 } });
    expect(res.notes).toBe('Aucun véhicule libre ne correspond aux critères sur ce créneau (au moins 12 places).');
  });
});
