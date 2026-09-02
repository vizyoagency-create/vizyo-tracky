import { TripsService } from './trips.service';

/**
 * Charge ALLÉGÉE de `GET /trips?light=1` — le contrat que les écrans de liste attendent.
 *
 * Mesure en production (2026-09-02, mh cars, 100 trajets) : 430 Ko par page, dont 238 Ko de
 * polylignes et ~100 Ko de fiche véhicule répétée cent fois — pour un tableau qui n'affiche
 * ni l'une ni l'autre. Ces tests figent les deux faces du contrat :
 *
 *   1. en mode léger, la requête passe par un `select` SANS `polyline` ni `polylineMatched`,
 *      et le véhicule est réduit à son identité ;
 *   2. sans le paramètre, RIEN ne change : `include` complet, comme avant. Les appelants qui
 *      dessinent (carte, historique) ne doivent pas perdre leurs tracés parce qu'un écran de
 *      liste a voulu s'alléger.
 */
describe('TripsService.list — charge allégée (light)', () => {
  function build() {
    const calls: unknown[] = [];
    const prisma = {
      trip: {
        findMany: jest.fn(async (args: unknown) => { calls.push(args); return []; }),
      },
    };
    const svc = new TripsService(prisma as never, {} as never, {} as never, {} as never);
    (svc as unknown as { ready: boolean }).ready = true;
    const superAdmin = { userId: 'u', role: 'SUPER_ADMIN' as never, fleetId: null };
    return { svc, calls, superAdmin };
  }

  it('light=1 : select explicite, sans polylignes, véhicule réduit à son identité', async () => {
    const { svc, calls, superAdmin } = build();
    await svc.list(superAdmin, { light: '1', limit: '10' });

    expect(calls).toHaveLength(1);
    const args = calls[0] as { select?: Record<string, unknown>; include?: unknown };
    expect(args.include).toBeUndefined();
    expect(args.select).toBeDefined();
    expect(args.select).not.toHaveProperty('polyline');
    expect(args.select).not.toHaveProperty('polylineMatched');
    // Ce que le tableau affiche doit rester là.
    for (const champ of ['id', 'vehicleId', 'startedAt', 'endedAt', 'durationSeconds', 'distanceMeters', 'maxSpeed', 'avgSpeed', 'notes', 'driver', 'notesUpdatedBy']) {
      expect(args.select).toHaveProperty(champ);
    }
    expect(args.select!['vehicle']).toEqual({
      select: { id: true, fleetId: true, plate: true, type: true, brand: true, model: true },
    });
  });

  it('sans paramètre : include complet, comportement historique intact', async () => {
    const { svc, calls, superAdmin } = build();
    await svc.list(superAdmin, { limit: '10' });

    const args = calls[0] as { select?: unknown; include?: Record<string, unknown> };
    expect(args.select).toBeUndefined();
    expect(args.include).toBeDefined();
    expect(args.include!['vehicle']).toBe(true);
  });

  it('light=true est accepté aussi ; toute autre valeur garde la charge complète', async () => {
    const { svc, calls, superAdmin } = build();
    await svc.list(superAdmin, { light: 'true' });
    await svc.list(superAdmin, { light: '0' });

    expect((calls[0] as { select?: unknown }).select).toBeDefined();
    expect((calls[1] as { include?: unknown }).include).toBeDefined();
  });
});
