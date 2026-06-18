import { WS_EVENTS } from '@vizyo/tracky-shared';
import { PositionBroadcastBuffer } from './position-broadcast-buffer.service';

/**
 * Couvre le coalescing + l'emission systematique du batch (fix du finding disputé :
 * plus de filtre "room vide" base sur l'adapter LOCAL, incorrect en multi-instance).
 */
describe('PositionBroadcastBuffer', () => {
  function makeBuffer() {
    const emit = jest.fn();
    const to = jest.fn().mockReturnThis();
    const server = { to, emit };
    const buffer = new PositionBroadcastBuffer({ server } as never);
    return { buffer, to, emit };
  }

  const pos = (trackerId: string) =>
    ({ trackerId, vehicleId: 'v', lat: 1, lng: 2, speedKmh: 0, heading: 0, timestamp: '' }) as never;

  it('coalesce par trackerId et emet UN POSITIONS_BATCH par fleet au flush', () => {
    const { buffer, to, emit } = makeBuffer();
    buffer.enqueue('fleet-1', pos('t1'));
    buffer.enqueue('fleet-1', pos('t1')); // meme tracker -> dedup (garde le dernier)
    buffer.enqueue('fleet-1', pos('t2'));

    buffer.flush();

    // Sprint 3 — les positions transitent désormais par la room dédiée `pos:fleet:*`
    // (le veilleur de nuit ne la rejoint pas → sans live).
    expect(to).toHaveBeenCalledWith('pos:fleet:fleet-1');
    expect(to).toHaveBeenCalledWith('pos:fleet:*');
    expect(emit).toHaveBeenCalledTimes(1);
    const [evt, payload] = emit.mock.calls[0];
    expect(evt).toBe(WS_EVENTS.POSITIONS_BATCH);
    expect(payload.fleetId).toBe('fleet-1');
    expect(payload.positions).toHaveLength(2); // t1 dedupe + t2
  });

  it('emet le batch meme sans presence locale (correct multi-instance, no-op si vide)', () => {
    const { buffer, emit } = makeBuffer();
    buffer.enqueue('fleet-x', pos('t1'));
    buffer.flush();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('un flush sans rien en buffer n emet pas', () => {
    const { buffer, emit } = makeBuffer();
    buffer.flush();
    expect(emit).not.toHaveBeenCalled();
  });
});
