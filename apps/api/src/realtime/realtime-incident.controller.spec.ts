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

  it('escalade en CRITICAL si le canal n\'a JAMAIS été établi (API/WS injoignable)', async () => {
    await controller.report(reqFor({ id: 'u1', fleetId: 'f1' }), { downMs: 50_000, everConnected: false });
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.stringContaining('JAMAIS établi'),
      'realtime-client',
      expect.objectContaining({ everConnected: false }),
      'CRITICAL',
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
