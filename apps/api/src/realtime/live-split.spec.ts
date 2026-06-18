import { WS_EVENTS } from '@vizyo/tracky-shared';
import { RealtimeGateway } from './realtime.gateway';
import { PositionBroadcastBuffer } from './position-broadcast-buffer.service';

/**
 * Sprint 3 — « sans live » SERVER-ENFORCED pour le veilleur de nuit.
 *
 * Les positions live transitent par la room `pos:fleet:*` ; le veilleur ne la
 * rejoint pas (il garde `fleet:*` pour la confirmation moteur S2 + alertes/status).
 * Ces tests prouvent le split au niveau du socket — pas seulement masqué côté front.
 */

interface FakeClient {
  rooms: string[];
  id: string;
  handshake: { auth: { token?: string } };
  data: Record<string, unknown>;
  join: jest.Mock;
  disconnect: jest.Mock;
}

function makeClient(): FakeClient {
  const rooms: string[] = [];
  return {
    rooms,
    id: 'sock-1',
    handshake: { auth: { token: 'tok' } },
    data: {},
    join: jest.fn((r: string) => rooms.push(r)),
    disconnect: jest.fn(),
  };
}

function makeGateway(user: { id: string; role: string; fleetId: string | null }) {
  const auth = {
    verifyAccessToken: jest.fn().mockReturnValue({ sub: user.id }),
    resolveLocalUser: jest.fn().mockResolvedValue({ email: 'u@x.com', ...user }),
  };
  const gw = new RealtimeGateway(auth as never, {} as never);
  return gw;
}

/** Mock du Server socket.io : capture la chaîne server.to(a).to(b).emit(evt, payload). */
function makeServerMock() {
  const chain = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
  const server = { to: jest.fn().mockReturnValue(chain) };
  return { server, chain };
}

describe('Sprint 3 — live-split WS (veilleur sans live, server-enforced)', () => {
  it('NIGHT_WATCHMAN rejoint ops:fleet:<id> SEULEMENT (ni fleet:* ni pos:fleet:*)', async () => {
    const gw = makeGateway({ id: 'u1', role: 'NIGHT_WATCHMAN', fleetId: 'f1' });
    const client = makeClient();
    await gw.handleConnection(client as never);
    expect(client.rooms).toContain('ops:fleet:f1'); // confirmation moteur S2 + statut tracker (émis aussi vers ops)
    expect(client.rooms).not.toContain('fleet:f1'); // PAS fleet:* : alertes/géofences/trajets y portent des positions
    expect(client.rooms).not.toContain('pos:fleet:f1'); // pas de live
    expect(client.rooms).not.toContain('pos:fleet:*');
  });

  it('emitEngineCommandUpdate / emitTrackerStatus atteignent aussi ops:fleet:* (canal du veilleur)', () => {
    const gw = makeGateway({ id: 'u1', role: 'VIEWER', fleetId: 'f1' });
    const { server, chain } = makeServerMock();
    (gw as unknown as { server: unknown }).server = server;
    gw.emitEngineCommandUpdate('f1', { commandId: 'c1', trackerId: 't1', action: 'CUT', status: 'SENT' } as never);
    expect(chain.to).toHaveBeenCalledWith('ops:fleet:f1');
    chain.to.mockClear();
    gw.emitTrackerStatus('f1', { trackerId: 't1', status: 'ONLINE' } as never);
    expect(chain.to).toHaveBeenCalledWith('ops:fleet:f1');
  });

  it('un user régulier (VIEWER) rejoint fleet:<id> ET pos:fleet:<id>', async () => {
    const gw = makeGateway({ id: 'u2', role: 'VIEWER', fleetId: 'f1' });
    const client = makeClient();
    await gw.handleConnection(client as never);
    expect(client.rooms).toContain('fleet:f1');
    expect(client.rooms).toContain('pos:fleet:f1');
  });

  it('SUPER_ADMIN rejoint fleet:* ET pos:fleet:*', async () => {
    const gw = makeGateway({ id: 'u3', role: 'SUPER_ADMIN', fleetId: null });
    const client = makeClient();
    await gw.handleConnection(client as never);
    expect(client.rooms).toContain('fleet:*');
    expect(client.rooms).toContain('pos:fleet:*');
  });

  it('broadcastPosition émet POSITION_UPDATE sur pos:fleet:* (et non fleet:*)', () => {
    const gw = makeGateway({ id: 'u1', role: 'VIEWER', fleetId: 'f1' });
    const { server, chain } = makeServerMock();
    (gw as unknown as { server: unknown }).server = server;
    gw.broadcastPosition('f1', { trackerId: 't1' } as never);
    expect(server.to).toHaveBeenCalledWith('pos:fleet:f1');
    expect(chain.to).toHaveBeenCalledWith('pos:fleet:*');
    expect(server.to).not.toHaveBeenCalledWith('fleet:f1');
    expect(chain.emit).toHaveBeenCalledWith(WS_EVENTS.POSITION_UPDATE, expect.anything());
  });

  it('buffer.flush émet POSITIONS_BATCH sur pos:fleet:*', () => {
    const { server, chain } = makeServerMock();
    const buffer = new PositionBroadcastBuffer({ server } as never);
    buffer.enqueue('f1', { trackerId: 't1' } as never);
    buffer.flush();
    expect(server.to).toHaveBeenCalledWith('pos:fleet:f1');
    expect(chain.to).toHaveBeenCalledWith('pos:fleet:*');
    expect(chain.emit).toHaveBeenCalledWith(
      WS_EVENTS.POSITIONS_BATCH,
      expect.objectContaining({ fleetId: 'f1' }),
    );
  });
});
