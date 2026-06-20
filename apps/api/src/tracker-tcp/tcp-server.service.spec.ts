import { TrackerStatus } from '@prisma/client';
import { TcpServerService } from './tcp-server.service';

/**
 * Sprint 0.1 — couverture du débounce OFFLINE + fix de la race de reconnexion.
 * On teste les méthodes privées (logique nouvelle, à risque) via `as any`, avec
 * des fake timers pour piloter le délai de grâce de façon déterministe.
 */
describe('TcpServerService — débounce OFFLINE', () => {
  const IMEI = '359339074500001';
  const GRACE_MS = 90_000;

  let service: TcpServerService;
  let registry: { get: jest.Mock; has: jest.Mock; unregister: jest.Mock };
  let prisma: { tracker: { findUnique: jest.Mock; update: jest.Mock } };
  let gateway: { emitTrackerStatus: jest.Mock };
  let ackWaiter: { cancelAll: jest.Mock };
  let errorLogger: { record: jest.Mock };

  const trackerRow = {
    id: 'tracker-1',
    imei: IMEI,
    vehicle: { id: 'veh-1', fleetId: 'fleet-1' },
  };

  beforeEach(() => {
    jest.useFakeTimers();
    registry = { get: jest.fn(), has: jest.fn().mockReturnValue(false), unregister: jest.fn() };
    prisma = {
      tracker: {
        findUnique: jest.fn().mockResolvedValue(trackerRow),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    gateway = { emitTrackerStatus: jest.fn() };
    ackWaiter = { cancelAll: jest.fn() };
    errorLogger = { record: jest.fn().mockResolvedValue('err-id') };

    service = new TcpServerService(
      { get: jest.fn() } as any, // config
      registry as any,
      prisma as any,
      {} as any, // positions
      {} as any, // alertsService
      gateway as any,
      {} as any, // wireLogger
      errorLogger as any,
      ackWaiter as any,
      { record: jest.fn(), forget: jest.fn() } as any, // unknownTrackers
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('marque OFFLINE après le délai de grâce si pas de reconnexion', async () => {
    (service as any).scheduleOffline(IMEI);
    expect(prisma.tracker.update).not.toHaveBeenCalled(); // rien avant le délai

    await jest.advanceTimersByTimeAsync(GRACE_MS);

    expect(prisma.tracker.update).toHaveBeenCalledWith({
      where: { id: trackerRow.id },
      data: { status: TrackerStatus.OFFLINE },
    });
    expect(gateway.emitTrackerStatus).toHaveBeenCalledWith(
      'fleet-1',
      expect.objectContaining({ trackerId: trackerRow.id, status: 'offline' }),
    );
  });

  it('annule le passage OFFLINE si le boîtier se reconnecte avant la fin du délai', async () => {
    (service as any).scheduleOffline(IMEI);
    (service as any).cancelPendingOffline(IMEI); // = ce que fait le login

    await jest.advanceTimersByTimeAsync(GRACE_MS);

    expect(prisma.tracker.update).not.toHaveBeenCalled();
    expect(gateway.emitTrackerStatus).not.toHaveBeenCalled();
  });

  it('ne marque pas OFFLINE si le tracker est ré-enregistré à l\'échéance', async () => {
    registry.has.mockReturnValue(true); // reconnecté entre-temps
    (service as any).scheduleOffline(IMEI);

    await jest.advanceTimersByTimeAsync(GRACE_MS);

    expect(prisma.tracker.findUnique).not.toHaveBeenCalled();
    expect(prisma.tracker.update).not.toHaveBeenCalled();
  });

  it('handleSocketClose ignore un socket périmé quand un plus récent est enregistré (race)', () => {
    const socketA = { id: 'A' } as any;
    const socketB = { id: 'B' } as any;
    registry.get.mockReturnValue({ socket: socketB }); // B a déjà remplacé A

    (service as any).handleSocketClose(IMEI, socketA);

    expect(registry.unregister).not.toHaveBeenCalled();
    expect(ackWaiter.cancelAll).not.toHaveBeenCalled();
  });

  it('handleSocketClose sur le socket courant désenregistre et programme OFFLINE', async () => {
    const socketA = { id: 'A' } as any;
    registry.get.mockReturnValue({ socket: socketA });
    registry.has.mockReturnValue(false);

    (service as any).handleSocketClose(IMEI, socketA);
    expect(registry.unregister).toHaveBeenCalledWith(IMEI);
    expect(ackWaiter.cancelAll).toHaveBeenCalledWith(IMEI);

    await jest.advanceTimersByTimeAsync(GRACE_MS);
    expect(prisma.tracker.update).toHaveBeenCalledTimes(1);
  });

  it('scheduleOffline appelé deux fois ne déclenche qu\'un seul passage OFFLINE', async () => {
    (service as any).scheduleOffline(IMEI);
    (service as any).scheduleOffline(IMEI);

    await jest.advanceTimersByTimeAsync(GRACE_MS);
    expect(prisma.tracker.update).toHaveBeenCalledTimes(1);
  });

  it('markOffline catche les erreurs DB et les enregistre sans throw', async () => {
    prisma.tracker.findUnique.mockRejectedValueOnce(new Error('DB down'));

    await expect((service as any).markOffline(IMEI)).resolves.toBeUndefined();
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error),
      'tcp-server',
      { imei: IMEI },
    );
  });

  it('ne marque pas OFFLINE si le boîtier se reconnecte pendant le findUnique (#11)', async () => {
    // La reconnexion arrive PENDANT la lecture du tracker : has() passe à true
    // juste avant l'écriture → on ne doit pas écraser le ONLINE par un OFFLINE.
    prisma.tracker.findUnique.mockImplementationOnce(async () => {
      registry.has.mockReturnValue(true);
      return trackerRow;
    });

    await (service as any).markOffline(IMEI);

    expect(prisma.tracker.update).not.toHaveBeenCalled();
    expect(gateway.emitTrackerStatus).not.toHaveBeenCalled();
  });
});
