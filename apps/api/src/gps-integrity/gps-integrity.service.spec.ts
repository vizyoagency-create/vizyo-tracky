import { GpsIntegrityService } from './gps-integrity.service';

/**
 * Incident FS-253 — le détecteur repère un boîtier VIVANT sans position GPS et lève une
 * alerte véhicule + une entrée centre d'alertes (ErrorLog), SANS spammer (dédup) et SANS
 * casser la boucle sur une erreur isolée.
 *
 * Zones mortes GPS (2026-07) — au-dessus : chaque perte est enregistrée (recordLoss). Si elle
 * tombe dans une zone CONFIRMÉE « normale » (parking souterrain) l'alerte est SUPPRIMÉE ; une
 * zone RÉCURRENTE non suspecte alerte le fleet-admin mais n'inonde plus le centre admin ; une
 * zone SUSPECTE (brouilleur) reste remontée au centre admin.
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

  const build = (recordLossResult: unknown = null) => {
    const prisma = { tracker: { findMany: jest.fn() } } as any;
    const alerts = { createGpsLostAlert: jest.fn() } as any;
    const deadZones = {
      minOccurrences: 3,
      recordLoss: jest.fn().mockResolvedValue(recordLossResult),
    } as any;
    const errorLogger = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new GpsIntegrityService(prisma, alerts, deadZones, errorLogger);
    return { svc, prisma, alerts, deadZones, errorLogger };
  };

  it('lève une alerte + un ErrorLog pour un boîtier vivant sans GPS (nouvelle alerte)', async () => {
    const { svc, prisma, alerts, deadZones, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' }); // créée (pas un doublon)

    await svc.tick();

    // La perte est enregistrée pour le clustering des zones mortes.
    expect(deadZones.recordLoss).toHaveBeenCalledTimes(1);
    expect(deadZones.recordLoss.mock.calls[0][0]).toMatchObject({ vehicleId: 'v1', fleetId: 'f1', trackerId: 't1' });

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

  // --- Zones mortes GPS -----------------------------------------------------------------

  it('SUPPRIME l\'alerte quand la perte tombe dans une zone confirmée « normale »', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'CONFIRMED_BENIGN', occurrences: 8 },
      isNewEpisode: false,
    });
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);

    await svc.tick();

    // Parking souterrain habituel confirmé → aucune alerte, aucun ErrorLog.
    expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('alerte le fleet-admin avec contexte récurrent MAIS n\'inonde pas le centre admin (zone récurrente non suspecte)', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'RECURRING', occurrences: 4 },
      isNewEpisode: true,
    });
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    const recurrence = alerts.createGpsLostAlert.mock.calls[0][4];
    expect(recurrence).toMatchObject({ count: 4, recognized: true, suspect: false });
    // Récurrente non suspecte → pas de spam du centre d'alertes super-admin.
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('REMONTE au centre admin quand la zone est marquée suspecte (brouilleur)', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'SUSPECT', occurrences: 6 },
      isNewEpisode: true,
    });
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    const recurrence = alerts.createGpsLostAlert.mock.calls[0][4];
    expect(recurrence).toMatchObject({ suspect: true });
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(String(errorLogger.record.mock.calls[0][0])).toContain('SUSPECTE');
  });
});
