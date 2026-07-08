import { GpsIntegrityService } from './gps-integrity.service';

/**
 * Incident FS-253 — le détecteur repère un boîtier VIVANT sans position GPS et lève une
 * alerte véhicule + une entrée centre d'alertes (ErrorLog), SANS spammer (dédup) et SANS
 * casser la boucle sur une erreur isolée.
 */
describe('GpsIntegrityService', () => {
  const makeTracker = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    imei: '864035054757027',
    lastLat: 43.6,
    lastLng: 1.45,
    lastPositionAt: new Date(Date.now() - 29 * 3600_000), // 29 h
    vehicle: { id: 'v1', plate: 'FS-253-HR', fleetId: 'f1' },
    ...over,
  });

  const build = () => {
    const prisma = { tracker: { findMany: jest.fn() } } as any;
    const alerts = { createGpsLostAlert: jest.fn() } as any;
    const errorLogger = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new GpsIntegrityService(prisma, alerts, errorLogger);
    return { svc, prisma, alerts, errorLogger };
  };

  it('lève une alerte + un ErrorLog pour un boîtier vivant sans GPS (nouvelle alerte)', async () => {
    const { svc, prisma, alerts, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' }); // créée (pas un doublon)

    await svc.tick();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    const [tracker, vehicle, ago] = alerts.createGpsLostAlert.mock.calls[0];
    expect(tracker.imei).toBe('864035054757027');
    expect(vehicle.plate).toBe('FS-253-HR');
    expect(ago).toContain('h'); // « 29 h »
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(errorLogger.record.mock.calls[0][1]).toBe('gps-integrity');
  });

  it('ne remonte PAS d\'ErrorLog quand l\'alerte est dédupliquée (déjà ouverte)', async () => {
    const { svc, prisma, alerts, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue(null); // doublon → skip

    await svc.tick();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('ne fait rien quand aucun boîtier n\'est concerné', async () => {
    const { svc, prisma, alerts } = build();
    prisma.tracker.findMany.mockResolvedValue([]);

    await svc.tick();

    expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
  });

  it('une erreur sur un boîtier ne casse pas la boucle (best-effort)', async () => {
    const { svc, prisma, alerts, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([
      makeTracker({ id: 't1', imei: 'AAA' }),
      makeTracker({ id: 't2', imei: 'BBB' }),
    ]);
    alerts.createGpsLostAlert
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'a2' });

    await expect(svc.tick()).resolves.toBeUndefined();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(2);
    expect(errorLogger.record).toHaveBeenCalledTimes(1); // seulement le 2e (le 1er a throw)
  });

  it('interroge la base avec le bon filtre (vivant + no_fix récent + position périmée)', async () => {
    const { svc, prisma } = build();
    prisma.tracker.findMany.mockResolvedValue([]);

    await svc.tick();

    const where = prisma.tracker.findMany.mock.calls[0][0].where;
    expect(where.vehicleId).toEqual({ not: null });
    expect(where.lastSeenAt.gte).toBeInstanceOf(Date);
    expect(where.lastNoFixAt.gte).toBeInstanceOf(Date);
    expect(where.OR).toEqual([{ lastPositionAt: null }, { lastPositionAt: { lt: expect.any(Date) } }]);
  });
});
