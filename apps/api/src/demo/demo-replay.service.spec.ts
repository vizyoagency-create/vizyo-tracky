import { BATTEMENT_MS, DELAI_EFFET_COMMANDE_MS, DemoReplayService } from './demo-replay.service';

/**
 * Le rejeu de la démo : des faux boîtiers dans le registre, des trames réelles réinjectées à
 * l'heure locale, et une coupure moteur dont l'effet est la chute du contact — jamais un accusé.
 */
describe('DemoReplayService', () => {
  const IMEI = '353000000000015';
  const TRACKER = {
    id: 'trk-1',
    imei: IMEI,
    lastLat: 43.6,
    lastLng: 1.44,
    lastHeading: 90,
    lastIgnition: true,
    vehicle: { fleetId: 'fleet-demo' },
  };
  // 2026-09-08 (mardi) 08:00:10 heure de Paris = 06:00:10Z.
  const T0 = new Date('2026-09-08T06:00:10Z');

  let prisma: {
    tracker: { findMany: jest.Mock; update: jest.Mock };
    demoReplayFrame: { findMany: jest.Mock; findFirst: jest.Mock };
  };
  let positions: { ingest: jest.Mock };
  let registry: { register: jest.Mock; unregister: jest.Mock };
  let gateway: { emitTrackerStatus: jest.Mock };

  function construire(enabled = true): DemoReplayService {
    return new DemoReplayService(
      { enabled } as never,
      prisma as never,
      positions as never,
      registry as never,
      gateway as never,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0.getTime());
    prisma = {
      tracker: { findMany: jest.fn().mockResolvedValue([TRACKER]), update: jest.fn().mockResolvedValue({}) },
      // `findFirst` sert au REPLACEMENT sur la trace : null = aucune ancre, le service n'y touche pas.
      demoReplayFrame: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    };
    positions = { ingest: jest.fn().mockResolvedValue(undefined) };
    registry = { register: jest.fn(), unregister: jest.fn() };
    gateway = { emitTrackerStatus: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("hors DEMO_MODE, n'enregistre aucun boîtier et ne touche à rien", async () => {
    const service = construire(false);
    await service.onModuleInit();
    expect(prisma.tracker.findMany).not.toHaveBeenCalled();
    expect(registry.register).not.toHaveBeenCalled();
    expect(service.nombreBoitiers).toBe(0);
  });

  it('enregistre un faux socket par boîtier rattaché à un véhicule, et le retire quand il disparaît', async () => {
    const service = construire();
    await service.synchroniser();
    expect(registry.register).toHaveBeenCalledWith(IMEI, expect.objectContaining({ imei: IMEI }));
    expect(gateway.emitTrackerStatus).toHaveBeenCalledWith(
      'fleet-demo',
      expect.objectContaining({ trackerId: 'trk-1', imei: IMEI, status: 'online' }),
    );
    expect(service.nombreBoitiers).toBe(1);

    prisma.tracker.findMany.mockResolvedValue([]);
    await service.synchroniser();
    expect(registry.unregister).toHaveBeenCalledWith(IMEI);
    expect(service.nombreBoitiers).toBe(0);
  });

  it('rejoue les trames du jour de semaine courant dont la seconde LOCALE vient de passer', async () => {
    const service = construire();
    await service.synchroniser();

    // Premier tic : pose le curseur, ne rejoue rien (on ne rattrape pas la nuit). Il émet le
    // battement initial (dernière position connue) — on l'écarte pour ne compter que le rejeu.
    await service.tic(T0);
    expect(prisma.demoReplayFrame.findMany).not.toHaveBeenCalled();
    positions.ingest.mockClear();

    // Deuxième tic, 10 s plus tard : la fenêtre (08:00:10, 08:00:20] du mardi (ISO 2).
    const sec = 8 * 3600 + 10;
    prisma.demoReplayFrame.findMany.mockResolvedValue([
      { imei: IMEI, weekday: 2, secondOfDay: sec + 3, lat: 43.61, lng: 1.45, speedKmh: 42, heading: 100, altitude: null, ignition: true, valid: true },
      { imei: IMEI, weekday: 2, secondOfDay: sec + 9, lat: 43.62, lng: 1.46, speedKmh: 45, heading: 101, altitude: 150, ignition: true, valid: true },
    ]);
    const T1 = new Date(T0.getTime() + 10_000);
    await service.tic(T1);

    expect(prisma.demoReplayFrame.findMany).toHaveBeenCalledWith({
      where: { imei: IMEI, weekday: 2, secondOfDay: { gt: sec, lte: sec + 10 } },
      orderBy: { secondOfDay: 'asc' },
    });
    expect(positions.ingest).toHaveBeenCalledTimes(2);
    const [premiere, seconde] = positions.ingest.mock.calls.map((c) => c[0]);
    expect(premiere).toMatchObject({ type: 'position', imei: IMEI, alarm: 'none', latitude: 43.61, longitude: 1.45, speedKph: 42, ignition: true, raw: '[demo]' });
    // La trame garde son âge relatif : émise à sec+3 dans une fenêtre qui finit à sec+10 → datée 7 s avant T1.
    expect(premiere.deviceTime.toISOString()).toBe(new Date(T1.getTime() - 7000).toISOString());
    expect(seconde.deviceTime.toISOString()).toBe(new Date(T1.getTime() - 1000).toISOString());
    expect(seconde.altitude).toBe(150);
  });

  it('coupure : pas d\'accusé, mais une trame « contact coupé, vitesse nulle » à la même position, puis le rejeu suspendu', async () => {
    const service = construire();
    await service.synchroniser();
    const socket = registry.register.mock.calls[0][1] as { write: (s: string) => boolean };

    // La commande moteur réelle, telle que EngineControlService l'écrit dans le socket.
    socket.write(`**,imei:${IMEI},J#`);
    expect(positions.ingest).not.toHaveBeenCalled(); // rien d'immédiat : un Coban exécute en silence

    await jest.advanceTimersByTimeAsync(DELAI_EFFET_COMMANDE_MS);
    expect(positions.ingest).toHaveBeenCalledTimes(1);
    expect(positions.ingest.mock.calls[0][0]).toMatchObject({
      imei: IMEI,
      latitude: 43.6,
      longitude: 1.44,
      speedKph: 0,
      ignition: false,
    });

    // Tant que le véhicule est coupé, ses trames ne sont plus rejouées…
    await service.tic(new Date(Date.now()));
    await service.tic(new Date(Date.now() + 10_000));
    expect(prisma.demoReplayFrame.findMany).not.toHaveBeenCalled();

    // …et le rallumage lève la suspension, avec le retard de la coupure reporté sur la journée.
    socket.write(`**,imei:${IMEI},K#`);
    await jest.advanceTimersByTimeAsync(DELAI_EFFET_COMMANDE_MS);
    const T = new Date(Date.now() + 10_000);
    await service.tic(T);
    await service.tic(new Date(T.getTime() + 10_000));
    expect(prisma.demoReplayFrame.findMany).toHaveBeenCalled();
    const where = prisma.demoReplayFrame.findMany.mock.calls[0][0].where;
    // La borne haute est en retard sur l'heure locale d'au moins la durée de la coupure (≈ 4 s, arrondie).
    const secLocale = ((T.getTime() + 10_000 - new Date('2026-09-07T22:00:00Z').getTime()) / 1000) | 0;
    expect(where.secondOfDay.lte).toBeLessThan(secLocale);
  });

  it('un boîtier silencieux depuis 2 min émet un battement à sa dernière position', async () => {
    const service = construire();
    await service.synchroniser();
    await service.tic(T0); // pose le curseur ; derniereEmissionMs vaut 0 → battement dû
    expect(positions.ingest).toHaveBeenCalledTimes(1);
    expect(positions.ingest.mock.calls[0][0]).toMatchObject({ imei: IMEI, latitude: 43.6, speedKph: 0, ignition: true });

    // Juste après : rien (moins de 2 min).
    jest.setSystemTime(T0.getTime() + 30_000);
    await service.tic(new Date(T0.getTime() + 30_000));
    expect(positions.ingest).toHaveBeenCalledTimes(1);

    // 2 min plus tard : un nouveau battement, daté strictement après le précédent.
    jest.setSystemTime(T0.getTime() + BATTEMENT_MS + 1000);
    await service.tic(new Date(T0.getTime() + BATTEMENT_MS + 1000));
    expect(positions.ingest).toHaveBeenCalledTimes(2);
    const [a, b] = positions.ingest.mock.calls.map((c) => c[0].deviceTime.getTime());
    expect(b).toBeGreaterThan(a);
  });

  it('replace le boîtier sur sa trace au premier passage, sans écrire de position', async () => {
    // Sans ce replacement, la première trame rejouée est un saut infaisable depuis la position
    // héritée de l'import : l'ingestion la rejette, la position connue ne bouge pas, et TOUTES
    // les suivantes sont rejetées à leur tour. Carte figée (constat du 2026-09-07).
    prisma.demoReplayFrame.findFirst.mockResolvedValue({
      imei: IMEI, weekday: 2, secondOfDay: 8 * 3600, lat: 43.7, lng: 1.5,
      speedKmh: 0, heading: 12, altitude: null, ignition: true, valid: true,
    });
    const service = construire();
    await service.synchroniser();
    await service.tic(T0);

    expect(prisma.demoReplayFrame.findFirst).toHaveBeenCalledWith({
      where: { imei: IMEI, weekday: 2, secondOfDay: { lte: 8 * 3600 + 10 } },
      orderBy: { secondOfDay: 'desc' },
    });
    expect(prisma.tracker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'trk-1' },
        data: expect.objectContaining({ lastLat: 43.7, lastLng: 1.5, status: 'ONLINE' }),
      }),
    );
    // Un REPLACEMENT, pas un déplacement : aucune ligne de positions n'est écrite pour cela.
    expect(positions.ingest).not.toHaveBeenCalled();
  });

  it("avant le premier point du jour, se replace sur le point de DÉPART de la tournée", async () => {
    // La nuit et tôt le matin, aucune trame ne précède l'heure courante. Sans repli, le boîtier
    // resterait sur sa position d'import et la première trame de la tournée serait un saut.
    prisma.demoReplayFrame.findFirst
      .mockResolvedValueOnce(null) // aucun point avant l'heure courante
      .mockResolvedValueOnce({
        imei: IMEI, weekday: 2, secondOfDay: 6 * 3600, lat: 43.8, lng: 1.6,
        speedKmh: 0, heading: 0, altitude: null, ignition: false, valid: true,
      });
    const service = construire();
    await service.synchroniser();
    await service.tic(T0);

    expect(prisma.demoReplayFrame.findFirst).toHaveBeenNthCalledWith(2, {
      where: { imei: IMEI, weekday: 2 },
      orderBy: { secondOfDay: 'asc' },
    });
    expect(prisma.tracker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastLat: 43.8, lastLng: 1.6 }) }),
    );
  });

  it("à l'arrêt du module, retire ses sockets et annule ses timers", async () => {
    const service = construire();
    await service.onModuleInit();
    const socket = registry.register.mock.calls[0][1] as { write: (s: string) => boolean };
    socket.write(`**,imei:${IMEI},J#`);
    service.onModuleDestroy();
    expect(registry.unregister).toHaveBeenCalledWith(IMEI);
    await jest.advanceTimersByTimeAsync(DELAI_EFFET_COMMANDE_MS * 2);
    expect(positions.ingest).not.toHaveBeenCalled();
  });
});
