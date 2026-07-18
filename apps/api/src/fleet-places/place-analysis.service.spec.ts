import { ServiceUnavailableException } from '@nestjs/common';
import { FleetPlaceKind } from '@prisma/client';
import { PlaceAnalysisService } from './place-analysis.service';

/**
 * Analyse IA d'un lieu clé. Ce qui est protégé ici, par ordre d'importance :
 *  1. **L'IA coupée ne coûte RIEN** — aucun appel au moteur si la porte `isEnabledForFleet` est
 *     fermée (clé absente / kill-switch owner / société sans option IA) ;
 *  2. **tout appel réussi est facturé** (`aiUsage.record`), sinon le coût est invisible ;
 *  3. **la sortie du modèle n'est jamais crue sur parole** (bornage) ;
 *  4. l'IA ne reçoit **que** des faits vérifiables (anti-hallucination).
 */
describe('PlaceAnalysisService', () => {
  const STATION_PLACE = {
    id: 'place-1',
    fleetId: 'fleet-1',
    name: 'Station Leclerc Saint-Orens',
    kind: FleetPlaceKind.FUEL_STATION,
    lat: 43.55,
    lng: 1.53,
    radiusM: 120,
    note: null,
    stationId: 'station-1',
  };
  const PARKING_PLACE = { ...STATION_PLACE, id: 'place-2', kind: FleetPlaceKind.PARKING, stationId: null, name: 'CDEF Launaguet' };

  const user = { id: 'user-1', fleetId: 'fleet-1' } as never;

  const LLM_OK = {
    result: { summary: 'Station ouverte 24/7.', highlights: ['Lavage disponible'], recommendations: ['Regrouper les pleins ici'] },
    usage: { inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 0 },
    model: 'claude-opus-4-8',
    provider: 'claude',
    latencyMs: 2400,
  };

  function build(over: {
    enabled?: boolean;
    complete?: jest.Mock;
    fuelStops?: unknown[];
    deadZones?: unknown[];
    facts?: unknown;
  } = {}) {
    const prisma = {
      placeAnalysis: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) =>
          Promise.resolve({ id: 'analysis-1', computedAt: new Date('2026-07-18T10:00:00Z'), facts: create.facts, ...create }),
        ),
      },
      tripFuelStop: { findMany: jest.fn().mockResolvedValue(over.fuelStops ?? []) },
      gpsDeadZone: { findMany: jest.fn().mockResolvedValue(over.deadZones ?? []) },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'FS-253-HR' },
          { id: 'v2', plate: 'AB-123-CD' },
        ]),
      },
    };
    const places = { findScoped: jest.fn().mockResolvedValue(STATION_PLACE) };
    // `in` et non `??` : le test « OSM ne connaît pas le lieu » passe explicitement `null`.
    const facts = 'facts' in over ? over.facts : { name: 'Station Leclerc', openingHours: '24/7' };
    const enrichment = { enrich: jest.fn().mockResolvedValue(facts) };
    const aiAvail = { isEnabledForFleet: jest.fn().mockResolvedValue(over.enabled ?? true) };
    const ai = { completeJson: over.complete ?? jest.fn().mockResolvedValue(LLM_OK) };
    const aiUsage = { record: jest.fn().mockResolvedValue(undefined), costOf: jest.fn().mockReturnValue(0.021), eurRate: jest.fn().mockReturnValue(0.92) };
    const errorLogger = { recordBackground: jest.fn() };

    const svc = new PlaceAnalysisService(
      prisma as never, places as never, enrichment as never,
      aiAvail as never, ai as never, aiUsage as never, errorLogger as never,
    );
    return { svc, prisma, places, enrichment, aiAvail, ai, aiUsage, errorLogger };
  }

  beforeEach(() => jest.clearAllMocks());

  // ── 1. La porte IA ─────────────────────────────────────────────────────────
  it("REFUSE d'analyser quand l'IA est coupée pour la société — et n'appelle AUCUN moteur", async () => {
    const { svc, ai, aiUsage, prisma } = build({ enabled: false });

    await expect(svc.analyze(user, 'place-1')).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Le cœur du contrôle client : pas d'appel = pas un centime dépensé, et rien de persisté.
    expect(ai.completeJson).not.toHaveBeenCalled();
    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(prisma.placeAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('interroge la porte CANONIQUE avec la fonctionnalité `placeAnalysis` (pas un contrôle maison)', async () => {
    const { svc, aiAvail } = build();
    await svc.analyze(user, 'place-1');
    expect(aiAvail.isEnabledForFleet).toHaveBeenCalledWith('fleet-1', 'placeAnalysis');
  });

  it('isAvailable() relaie la porte telle quelle (sert à masquer le bouton côté UI)', async () => {
    const off = build({ enabled: false });
    await expect(off.svc.isAvailable('fleet-1')).resolves.toBe(false);
    const on = build({ enabled: true });
    await expect(on.svc.isAvailable('fleet-1')).resolves.toBe(true);
  });

  it('la LECTURE d\'une analyse existante ne déclenche aucun appel IA', async () => {
    const { svc, prisma, ai } = build();
    prisma.placeAnalysis.findUnique.mockResolvedValue({
      id: 'a1', placeId: 'place-1', summary: 'déjà calculé', highlights: ['x'], recommendations: [],
      aiProvider: 'claude', aiModel: 'claude-opus-4-8', costEur: 0.02, origin: 'manual',
      computedAt: new Date('2026-07-18T09:00:00Z'), facts: { openStreetMap: { name: 'Leclerc' } },
    });

    const dto = await svc.get(user, 'place-1');

    expect(dto?.summary).toBe('déjà calculé');
    expect(dto?.facts).toEqual({ name: 'Leclerc' });
    expect(ai.completeJson).not.toHaveBeenCalled();
  });

  // ── 2. Coût ────────────────────────────────────────────────────────────────
  it('enregistre le coût de CHAQUE appel réussi (action `place_analysis`, société attribuée)', async () => {
    const { svc, aiUsage } = build();
    await svc.analyze(user, 'place-1');

    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'place_analysis',
        fleetId: 'fleet-1',
        userId: 'user-1',
        model: 'claude-opus-4-8',
        inputTokens: 1200,
        outputTokens: 300,
        ok: true,
      }),
    );
  });

  it('convertit le coût en euros (costOf renvoie des USD)', async () => {
    const { svc, prisma } = build();
    await svc.analyze(user, 'place-1');
    // 0.021 USD × 0.92 = 0.01932 € → arrondi 4 décimales
    expect(prisma.placeAnalysis.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ costEur: 0.0193 }) }),
    );
  });

  it("remonte la panne du moteur au centre d'alerte et propage l'erreur (pas d'analyse vide silencieuse)", async () => {
    const boom = jest.fn().mockRejectedValue(new Error('provider 503'));
    const { svc, errorLogger, aiUsage, prisma } = build({ complete: boom });

    await expect(svc.analyze(user, 'place-1')).rejects.toThrow('provider 503');

    expect(errorLogger.recordBackground).toHaveBeenCalledWith(
      expect.any(Error), 'place-analysis', expect.objectContaining({ placeId: 'place-1', fleetId: 'fleet-1' }),
    );
    expect(aiUsage.record).not.toHaveBeenCalled();
    expect(prisma.placeAnalysis.upsert).not.toHaveBeenCalled();
  });

  // ── 3. On ne fait pas confiance au modèle ──────────────────────────────────
  it('borne une sortie de modèle délirante (trop d\'items, textes à rallonge, valeurs non-string)', async () => {
    const complete = jest.fn().mockResolvedValue({
      ...LLM_OK,
      result: {
        summary: 'x'.repeat(5000),
        highlights: [...Array(40)].map((_, i) => `point ${i} ${'y'.repeat(500)}`),
        recommendations: ['ok', 42, null, '   ', 'utile'],
      },
    });
    const { svc, prisma } = build({ complete });

    await svc.analyze(user, 'place-1');

    const saved = prisma.placeAnalysis.upsert.mock.calls[0]![0].create;
    expect(saved.summary.length).toBe(700);
    expect(saved.highlights).toHaveLength(6);
    expect(saved.highlights[0].length).toBe(220);
    expect(saved.recommendations).toEqual(['ok', 'utile']); // non-strings et vides écartés
  });

  it('survit à un modèle qui renvoie un objet vide (aucun champ attendu)', async () => {
    const complete = jest.fn().mockResolvedValue({ ...LLM_OK, result: {} });
    const { svc, prisma } = build({ complete });

    await svc.analyze(user, 'place-1');

    const saved = prisma.placeAnalysis.upsert.mock.calls[0]![0].create;
    expect(saved).toEqual(expect.objectContaining({ summary: '', highlights: [], recommendations: [] }));
  });

  // ── 4. L'IA ne reçoit que des faits ────────────────────────────────────────
  it("interdit explicitement l'invention dans le prompt système", async () => {
    const { svc, ai } = build();
    await svc.analyze(user, 'place-1');

    const { system } = ai.completeJson.mock.calls[0]![0];
    expect(system).toMatch(/N'invente AUCUNE information/);
    expect(system).toMatch(/UNIQUEMENT les faits fournis/);
  });

  it('agrège les passages RÉELS de la flotte (qui est passé, combien de fois, prix relevés)', async () => {
    const fuelStops = [
      { vehicleId: 'v1', arrivedAt: new Date('2026-07-17T08:00:00Z'), durationSec: 420, unitPriceEur: 1.789, fuelType: 'Gazole' },
      { vehicleId: 'v1', arrivedAt: new Date('2026-07-10T08:00:00Z'), durationSec: 300, unitPriceEur: 1.759, fuelType: 'Gazole' },
      { vehicleId: 'v2', arrivedAt: new Date('2026-07-05T08:00:00Z'), durationSec: 600, unitPriceEur: null, fuelType: 'Gazole' },
    ];
    const { svc, ai } = build({ fuelStops });

    await svc.analyze(user, 'place-1');

    const payload = ai.completeJson.mock.calls[0]![0].userPayload as {
      usageFlotte: Record<string, unknown>; openStreetMap: unknown; lieu: Record<string, unknown>;
    };
    expect(payload.usageFlotte).toEqual(
      expect.objectContaining({
        passages: 3,
        vehiculesDistincts: 2,
        parVehicule: [
          { vehicule: 'FS-253-HR', passages: 2 },
          { vehicule: 'AB-123-CD', passages: 1 },
        ],
        dernierPassage: '2026-07-17',
        arretMoyenMin: 7, // (420+300+600)/3 = 440 s ≈ 7 min
        prixReleveEurL: { min: 1.759, max: 1.789, dernier: 1.789 },
      }),
    );
    expect(payload.lieu).toEqual(expect.objectContaining({ nom: 'Station Leclerc Saint-Orens', nature: 'station-service' }));
    expect(payload.openStreetMap).toEqual({ name: 'Station Leclerc', openingHours: '24/7' });
  });

  it('pour un parking, croise avec les zones mortes GPS et ignore celles hors rayon', async () => {
    const deadZones = [
      { vehicleId: 'v1', centroidLat: 43.55, centroidLng: 1.53, occurrences: 7, status: 'CONFIRMED_BENIGN' },
      { vehicleId: 'v2', centroidLat: 43.9, centroidLng: 1.9, occurrences: 3, status: 'LEARNING' }, // ~45 km → hors rayon
    ];
    const { svc, ai, places, prisma } = build({ deadZones });
    places.findScoped.mockResolvedValue(PARKING_PLACE);

    await svc.analyze(user, 'place-2');

    const payload = ai.completeJson.mock.calls[0]![0].userPayload as { usageFlotte: Record<string, unknown> };
    expect(payload.usageFlotte).toEqual({
      vehiculesObserves: 1,
      pertesGpsTotales: 7,
      parVehicule: [{ vehicule: 'FS-253-HR', pertesGps: 7 }],
      stationnementCouvertConfirme: true,
    });
    // Un parking n'a pas de station → on n'interroge pas les passages carburant.
    expect(prisma.tripFuelStop.findMany).not.toHaveBeenCalled();
  });

  it('reste analysable quand OSM ne connaît pas le lieu (faits partiels, pas de plantage)', async () => {
    const { svc, ai, prisma } = build({ facts: null });
    await svc.analyze(user, 'place-1');

    const payload = ai.completeJson.mock.calls[0]![0].userPayload as Record<string, unknown>;
    expect(payload.openStreetMap).toBeUndefined();
    expect(prisma.placeAnalysis.upsert).toHaveBeenCalled();
  });

  it('applique le périmètre société via findScoped (anti-IDOR délégué, jamais redupliqué)', async () => {
    const { svc, places, ai } = build();
    places.findScoped.mockRejectedValue(new Error('Lieu introuvable'));

    await expect(svc.analyze(user, 'place-autre-societe')).rejects.toThrow('Lieu introuvable');
    expect(ai.completeJson).not.toHaveBeenCalled();
  });
});
