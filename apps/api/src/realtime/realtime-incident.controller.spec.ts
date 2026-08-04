import { RealtimeIncidentController } from './realtime-incident.controller';

describe('RealtimeIncidentController', () => {
  let controller: RealtimeIncidentController;
  let errorLogger: { record: jest.Mock };

  const reqFor = (user: { id: string; fleetId: string | null }) => ({ user }) as any;

  beforeEach(() => {
    jest.useFakeTimers();
    errorLogger = { record: jest.fn().mockResolvedValue('id') };
    controller = new RealtimeIncidentController(errorLogger as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('enregistre un flap court (reconnecté) en ERROR avec contexte + diagnostics', async () => {
    const res = await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), {
      downMs: 65_000, reason: 'ping timeout', transport: 'websocket', flaps: 3, everConnected: true,
    });

    expect(res).toEqual({ recorded: true });
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.stringContaining('temps réel interrompue'),
      'realtime-client',
      expect.objectContaining({
        userId: 'u1', fleetId: 'f1', route: '/map', downMs: 65_000,
        reason: 'ping timeout', transport: 'websocket', flaps: 3,
      }),
      'ERROR',
    );
  });

  // --- TRK-003 : « jamais établi » seul ne suffit plus à crier au loup -------------------
  //
  // Ce test escaladait en CRITICAL sur une occurrence UNIQUE de 50 s. Or sous 2 vCPU l'API
  // rate un pong et tous les incidents tombent pile à 45 s : un aléa de charge était classé
  // au niveau maximal. On exige désormais que ça RECOMMENCE — ou que ça DURE.

  it('garde un premier échec d\'établissement ISOLÉ en ERROR', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), { downMs: 50_000, everConnected: false });
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.stringContaining('JAMAIS établi'),
      'realtime-client',
      expect.objectContaining({ everConnected: false }),
      'ERROR',
    );
  });

  it('escalade en CRITICAL quand l\'échec d\'établissement RECOMMENCE', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), { downMs: 50_000, everConnected: false });
    // Au-delà de la fenêtre de dédup (5 min), mais dans celle de répétition (1 h).
    jest.advanceTimersByTime(10 * 60_000);
    await controller.report(reqFor({ id: 'u2', fleetId: 'f1' }), { downMs: 50_000, everConnected: false });

    expect(errorLogger.record).toHaveBeenLastCalledWith(
      expect.stringContaining('JAMAIS établi'),
      'realtime-client',
      expect.objectContaining({ everConnected: false }),
      'CRITICAL',
    );
  });

  it('ne considère pas comme répétition un incident vieux de plus d\'une heure', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), { downMs: 50_000, everConnected: false });
    jest.advanceTimersByTime(90 * 60_000);
    await controller.report(reqFor({ id: 'u2', fleetId: 'f1' }), { downMs: 50_000, everConnected: false });

    expect(errorLogger.record).toHaveBeenLastCalledWith(
      expect.anything(), 'realtime-client', expect.anything(), 'ERROR',
    );
  });

  it('escalade en CRITICAL sur une coupure LONGUE, même isolée', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), { downMs: 130_000, everConnected: true });
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.anything(), 'realtime-client', expect.anything(), 'CRITICAL',
    );
  });

  it('déduplique les reports d\'une même flotte dans la fenêtre', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), { downMs: 60_000 });
    const second = await controller.report(reqFor({ id: 'u2', fleetId: 'f1' }), { downMs: 60_000 });

    expect(second).toEqual({ recorded: false });
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
  });

  it('ré-enregistre une fois la fenêtre de dédup écoulée', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), {});
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), {});

    expect(errorLogger.record).toHaveBeenCalledTimes(2);
  });

  it('ne déduplique pas entre flottes différentes', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), {});
    await controller.report(reqFor({ id: 'u2', fleetId: 'f2' }), {});

    expect(errorLogger.record).toHaveBeenCalledTimes(2);
  });

  it('scope la dédup par utilisateur quand il n\'y a pas de flotte (super-admin)', async () => {
    const first = await controller.report(reqFor({ id: 'sa1', fleetId: null }), {});
    const dup = await controller.report(reqFor({ id: 'sa1', fleetId: null }), {});
    const other = await controller.report(reqFor({ id: 'sa2', fleetId: null }), {});

    expect(first).toEqual({ recorded: true });
    expect(dup).toEqual({ recorded: false });
    expect(other).toEqual({ recorded: true });
  });
});
