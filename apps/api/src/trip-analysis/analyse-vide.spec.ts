import { UnprocessableEntityException } from '@nestjs/common';
import { TripAnalysisService } from './trip-analysis.service';

/**
 * ── NE JAMAIS PERSISTER UNE ANALYSE VIDE SUR UN TRAJET QUI A ROULÉ ──────────────────
 *
 * Relevé du 2026-08-21 : 60 analyses « distance 0, aucun arrêt, 0 point GPS » en base, toutes
 * sur des trajets réels de plus de 500 m, toutes à la frontière de purge du 18-19/06. Le
 * mécanisme : la fenêtre du rattrapage (1 500 h) mordait sur la zone où la rétention de 60 jours
 * avait déjà supprimé les positions — l'analyse chargeait zéro point et persistait un zéro
 * inventé, indiscernable d'un vrai trajet immobile.
 *
 * La règle testée ici : ce cas se REFUSE, il ne se maquille pas. L'appelant décide — le cron
 * saute et réessaiera, l'humain lit un message honnête au lieu d'un faux zéro.
 */
function service(opts: { distanceMeters: number | null; positions?: unknown[] }) {
  const prisma = {
    trip: {
      findUnique: jest.fn().mockResolvedValue({
        id: 't-1', fleetId: 'f-1', vehicleId: 'v-1', trackerId: 'trk-1',
        startedAt: new Date('2026-06-18T08:00:00Z'), endedAt: new Date('2026-06-18T09:00:00Z'),
        distanceMeters: opts.distanceMeters,
        vehicle: { type: 'CAR', energy: 'DIESEL', fuelConsumptionL100km: 6.5 },
      }),
    },
    position: { findMany: jest.fn().mockResolvedValue(opts.positions ?? []) },
    tripAnalysis: {
      // Le DTO de sortie lit les dates et compteurs du rang upserte : un mock plausible suffit.
      upsert: jest.fn().mockResolvedValue({
        tripId: 't-1', vehicleId: 'v-1', fleetId: 'f-1', computedAt: new Date(),
        distanceKm: 0, durationSec: 0, movingSec: 0, avgSpeedKmh: 0, maxSpeedKmh: 0,
        stopCount: 0, idleSec: 0, gpsPoints: 0, gpsValidRatio: 0, gpsLostCount: 0,
        speedingCount: 0, speedingSec: 0, maxOverKmh: 0, limitsKnown: false,
        harshAccel: 0, harshBrake: 0, ecoScore: 100, fuelLiters: null, co2Kg: null,
        narrative: null, advice: null, trustScore: null, provider: null, detail: {},
      }),
    },
  };
  const svc = new TripAnalysisService(
    prisma as never,
    { hasAccessToVehicle: jest.fn().mockResolvedValue(true) } as never,
    { buildResolver: jest.fn().mockResolvedValue(() => null) } as never,
    { attachStops: jest.fn().mockResolvedValue(undefined), enrich: jest.fn().mockResolvedValue(undefined) } as never,
    { record: jest.fn() } as never,
  );
  return { svc, prisma };
}

const USER = { id: 'u-1', role: 'SUPER_ADMIN', fleetId: null } as never;

describe('Analyse sans positions — refuser plutôt qu’inventer', () => {
  it('⚠️ trajet réel (>500 m) sans aucune position → REFUS explicite, rien n’est écrit', async () => {
    const { svc, prisma } = service({ distanceMeters: 2000, positions: [] });

    await expect(svc.analyze(USER, 't-1')).rejects.toThrow(UnprocessableEntityException);
    await expect(svc.analyze(USER, 't-1')).rejects.toThrow(/invent/i);
    expect(prisma.tripAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('trajet minuscule (≤500 m) sans position : l’analyse vide reste permise', async () => {
    // Une manoeuvre de cour peut legitimement n'avoir capte aucun point exploitable : le refus
    // ne vaut que lorsque le compteur du trajet PROUVE qu'on a roule.
    const { svc, prisma } = service({ distanceMeters: 120, positions: [] });

    await expect(svc.analyze(USER, 't-1')).resolves.toBeDefined();
    expect(prisma.tripAnalysis.upsert).toHaveBeenCalledTimes(1);
  });

  it('distance inconnue (null) sans position : permis aussi — on n’accuse pas sans preuve', async () => {
    const { svc } = service({ distanceMeters: null, positions: [] });
    await expect(svc.analyze(USER, 't-1')).resolves.toBeDefined();
  });
});
