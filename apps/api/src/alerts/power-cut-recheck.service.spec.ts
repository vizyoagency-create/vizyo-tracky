import { PowerCutRecheckService } from './power-cut-recheck.service';

/**
 * TRK-040 — le réexamen différé : la PENTE confirme ce que l'instant zéro ne pouvait pas.
 *
 * Trois garde-fous verrouillés ici, chacun contre une simplification tentante :
 *  - le réexamen est RÉCURRENT à partir de T+30, pas unique (à T+30, DZ-034-CA affichait
 *    encore 100 % — la baisse n'est venue qu'à 07:00) ;
 *  - la pente exige une lecture batterie POSTÉRIEURE au soupçon (une lecture périmée
 *    n'est pas une pente, c'est un point) ;
 *  - le seuil est CELUI DU PROPRIÉTAIRE, réutilisé — pas de seuil déguisé.
 */
describe('PowerCutRecheckService (TRK-040)', () => {
  const ilYA = (min: number) => new Date(Date.now() - min * 60_000);

  function monter(trackers: Record<string, unknown>[], opts: { alerteDejaOuverte?: boolean } = {}) {
    const prisma = {
      tracker: {
        findMany: jest.fn().mockResolvedValue(trackers),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const alerts = {
      createPowerCutConfirmedAlert: jest.fn().mockResolvedValue(opts.alerteDejaOuverte ? null : { id: 'a1' }),
    };
    const errorLogger = { recordBackground: jest.fn() };
    const svc = new PowerCutRecheckService(prisma as never, alerts as never, errorLogger as never);
    return { svc, prisma, alerts };
  }

  const suspect = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    imei: '864035054756177',
    lastLat: 43.6,
    lastLng: 1.43,
    lastKnownIgnition: false,
    powerLossSuspectAt: ilYA(31),
    powerLossSuspectBattery: 100,
    lastBatteryPercent: 83,
    lastBatteryAt: ilYA(5),
    vehicle: { id: 'v1', plate: 'DZ-034-CA', fleetId: 'f1' },
    ...over,
  });

  it('🔑 pente confirmée : alerte avec l heure de la PREMIÈRE trame, note remplacée, soupçon refermé', async () => {
    const { svc, prisma, alerts } = monter([suspect()]);
    await svc.tick();
    expect(alerts.createPowerCutConfirmedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      expect.objectContaining({ plate: 'DZ-034-CA' }),
      expect.objectContaining({ suspectBattery: 100, currentBattery: 83, suspectAt: expect.any(Date) }),
    );
    expect(prisma.tracker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastPowerNotice: expect.stringContaining('CONFIRMÉE'),
          powerLossSuspectAt: null,
          powerLossSuspectBattery: null,
        }),
      }),
    );
  });

  it('⚠️ batterie encore pleine après T+30 : RIEN — le soupçon reste ouvert, revu au tick suivant', async () => {
    // À 06:53, la salve montrait encore 100 % : un réexamen unique aurait raté le cas mesuré.
    const { svc, prisma, alerts } = monter([suspect({ lastBatteryPercent: 100 })]);
    await svc.tick();
    expect(alerts.createPowerCutConfirmedAlert).not.toHaveBeenCalled();
    expect(prisma.tracker.update).not.toHaveBeenCalled();
  });

  it('contact revenu : soupçon refermé SANS alerte (épisode bénin)', async () => {
    const { svc, prisma, alerts } = monter([suspect({ lastKnownIgnition: true })]);
    await svc.tick();
    expect(alerts.createPowerCutConfirmedAlert).not.toHaveBeenCalled();
    expect(prisma.tracker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { powerLossSuspectAt: null, powerLossSuspectBattery: null },
      }),
    );
  });

  it('⚠️ lecture batterie ANTÉRIEURE au soupçon : pas une pente, pas d alerte', async () => {
    const { svc, alerts } = monter([
      suspect({ lastBatteryPercent: 40, lastBatteryAt: ilYA(60), powerLossSuspectAt: ilYA(31) }),
    ]);
    await svc.tick();
    expect(alerts.createPowerCutConfirmedAlert).not.toHaveBeenCalled();
  });

  it('le where ne réexamine pas avant T+30', async () => {
    const { svc, prisma } = monter([]);
    await svc.tick();
    const where = prisma.tracker.findMany.mock.calls[0][0].where;
    expect(where.powerLossSuspectAt.not).toBeNull();
    expect(where.powerLossSuspectAt.lte).toBeInstanceOf(Date);
    expect(Date.now() - where.powerLossSuspectAt.lte.getTime()).toBeGreaterThanOrEqual(29 * 60_000);
  });

  it('la dédup vit dans AlertsService : un null (alerte déjà ouverte) ne fait pas crasher le tick', async () => {
    const { svc, prisma } = monter([suspect()], { alerteDejaOuverte: true });
    await expect(svc.tick()).resolves.toBeUndefined();
    // La note et la fermeture du soupçon s appliquent quand même : l épisode est traité.
    expect(prisma.tracker.update).toHaveBeenCalled();
  });
});
