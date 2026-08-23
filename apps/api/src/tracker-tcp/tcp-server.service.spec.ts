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
  let prisma: { tracker: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock } };
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
        // TRK-024 : l'écriture OFFLINE passe par updateMany conditionnel.
        // count: 1 = le WHERE de fraîcheur a matché (cas nominal).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    const t0 = Date.now(); // fake timers modernes : Date.now est piloté par l'horloge factice
    (service as any).scheduleOffline(IMEI);
    expect(prisma.tracker.updateMany).not.toHaveBeenCalled(); // rien avant le délai

    await jest.advanceTimersByTimeAsync(GRACE_MS);

    // TRK-024 : la condition de fraîcheur voyage DANS le WHERE, même instruction
    // que l'écriture. Seuil attendu = instant du tir (t0+90s) - grâce (90s) = t0.
    expect(prisma.tracker.updateMany).toHaveBeenCalledWith({
      where: { id: trackerRow.id, lastSeenAt: { lt: new Date(t0) } },
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

    expect(prisma.tracker.updateMany).not.toHaveBeenCalled();
    expect(gateway.emitTrackerStatus).not.toHaveBeenCalled();
  });

  it('ne marque pas OFFLINE si le tracker est ré-enregistré à l\'échéance', async () => {
    registry.has.mockReturnValue(true); // reconnecté entre-temps
    (service as any).scheduleOffline(IMEI);

    await jest.advanceTimersByTimeAsync(GRACE_MS);

    expect(prisma.tracker.findUnique).not.toHaveBeenCalled();
    expect(prisma.tracker.updateMany).not.toHaveBeenCalled();
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
    expect(prisma.tracker.updateMany).toHaveBeenCalledTimes(1);
  });

  it('scheduleOffline appelé deux fois ne déclenche qu\'un seul passage OFFLINE', async () => {
    (service as any).scheduleOffline(IMEI);
    (service as any).scheduleOffline(IMEI);

    await jest.advanceTimersByTimeAsync(GRACE_MS);
    expect(prisma.tracker.updateMany).toHaveBeenCalledTimes(1);
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

    expect(prisma.tracker.updateMany).not.toHaveBeenCalled();
    expect(gateway.emitTrackerStatus).not.toHaveBeenCalled();
  });

  // ─── TRK-024 — l'écriture OFFLINE ne survit plus aux trames ───

  it("TRK-024 : n'émet PAS d'event WS « offline » quand le WHERE de fraîcheur n'a rien écrit (count=0)", async () => {
    // Boîtier ravivé pendant la grâce (login/position/no_fix a rafraîchi
    // lastSeenAt) : l'updateMany conditionnel ne matche pas → rien en base,
    // donc rien sur le WS (sinon l'UI afficherait un offline que la DB dément).
    prisma.tracker.updateMany.mockResolvedValue({ count: 0 });

    (service as any).scheduleOffline(IMEI);
    await jest.advanceTimersByTimeAsync(GRACE_MS);

    expect(prisma.tracker.updateMany).toHaveBeenCalledTimes(1); // la tentative a bien eu lieu
    expect(gateway.emitTrackerStatus).not.toHaveBeenCalled();   // mais rien n'est diffusé
  });

  it("TRK-024 : le seuil du WHERE est la grâce (90 s), pas un seuil d'affichage (5/15 min)", async () => {
    // Si on prenait 5 ou 15 min : un boîtier mort dont la socket tombe vite (RST)
    // arriverait ici avec un lastSeenAt de ~90 s → pas d'écriture, et RIEN ne
    // re-programme jamais ce passage → ONLINE fantôme permanent, compteur
    // /admin/alerts aveugle (il exige status=OFFLINE). Le seuil DOIT rester ≤ grâce.
    const t0 = Date.now();
    (service as any).scheduleOffline(IMEI);
    await jest.advanceTimersByTimeAsync(GRACE_MS);

    const arg = prisma.tracker.updateMany.mock.calls[0][0];
    expect(arg.where.lastSeenAt.lt.getTime()).toBe(t0); // tir (t0+90s) − grâce (90s) = t0
  });
});
