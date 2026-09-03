import { TripAnalysisService } from './trip-analysis.service';

/**
 * Option IA coupée = récit MASQUÉ à la lecture, côté serveur.
 *
 * ── LA RÈGLE (2026-09-02) ─────────────────────────────────────────────────────────────
 * L'agent sur poste rédige les récits de toutes les sociétés, option active ou non. Ce que
 * le client VOIT dépend de son option : coupée → récit, conseils, Trust Score et moteur
 * absents du DTO ; les chiffres déterministes restent. Le super-admin voit tout.
 *
 * Pourquoi côté serveur : un écran qui cache un champ présent dans la réponse ne protège
 * rien — le JSON est à un clic dans l'inspecteur. Et pourquoi masquer plutôt que ne pas
 * rédiger : le jour où l'option est activée, l'historique complet apparaît d'un coup.
 */
describe('Récit IA — masqué quand l\'option de la société est coupée', () => {
  const ROW = {
    tripId: 't-1', vehicleId: 'v-1', fleetId: 'f-1', computedAt: new Date('2026-09-01T10:00:00Z'),
    distanceKm: 12.3, durationSec: 900, movingSec: 800, avgSpeedKmh: 49, maxSpeedKmh: 92,
    stopCount: 1, idleSec: 60, gpsPoints: 120, gpsValidRatio: 0.98, gpsLostCount: 0,
    speedingCount: 2, speedingSec: 30, maxOverKmh: 12, limitsKnown: true,
    harshAccel: 1, harshBrake: 0, ecoScore: 81, fuelLiters: 0.9, co2Kg: 2.1, detail: {},
    provider: 'local', narrative: 'Trajet urbain fluide.', advice: 'Anticiper.', trustScore: 88,
  };

  function service(optionActive: boolean) {
    const prisma = {
      tripAnalysis: {
        findUnique: jest.fn().mockResolvedValue(ROW),
        findMany: jest.fn().mockResolvedValue([ROW, { ...ROW, tripId: 't-2' }]),
      },
    };
    const svc = new TripAnalysisService(
      prisma as never,
      { hasAccessToVehicle: jest.fn().mockResolvedValue(true), getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      { isEnabledForFleet: jest.fn().mockResolvedValue(optionActive) } as never,
    );
    return svc;
  }

  const CLIENT = { id: 'u-1', role: 'FLEET_ADMIN', fleetId: 'f-1' } as never;
  const SUPER = { id: 'u-0', role: 'SUPER_ADMIN', fleetId: null } as never;

  it('option coupée : le client reçoit l\'analyse SANS récit, conseils, Trust Score ni moteur', async () => {
    const dto = await service(false).get(CLIENT, 't-1');
    expect(dto).not.toBeNull();
    expect(dto!.narrative).toBeNull();
    expect(dto!.advice).toBeNull();
    expect(dto!.trustScore).toBeNull();
    expect(dto!.provider).toBeNull();
    // Le déterministe, lui, reste entier.
    expect(dto!.ecoScore).toBe(81);
    expect(dto!.speedingCount).toBe(2);
    expect(dto!.maxSpeedKmh).toBe(92);
  });

  it('option active : le client voit le récit, avec le moteur en marque blanche « tracky »', async () => {
    const dto = await service(true).get(CLIENT, 't-1');
    expect(dto!.narrative).toBe('Trajet urbain fluide.');
    expect(dto!.trustScore).toBe(88);
    expect(dto!.provider).toBe('tracky');
  });

  it('le super-admin voit tout, option coupée ou non — c\'est lui qui contrôle l\'agent', async () => {
    const dto = await service(false).get(SUPER, 't-1');
    expect(dto!.narrative).toBe('Trajet urbain fluide.');
    expect(dto!.provider).toBe('local');
  });

  it('les listes appliquent la même règle (par trajets et par véhicule)', async () => {
    const svc = service(false);
    const parTrajets = await svc.listForTrips(CLIENT, ['t-1', 't-2']);
    expect(parTrajets).toHaveLength(2);
    expect(parTrajets.every((d) => d.narrative === null && d.trustScore === null)).toBe(true);
    const parVehicule = await svc.listForVehicle(CLIENT, 'v-1', 50);
    expect(parVehicule.every((d) => d.narrative === null)).toBe(true);
  });
});
