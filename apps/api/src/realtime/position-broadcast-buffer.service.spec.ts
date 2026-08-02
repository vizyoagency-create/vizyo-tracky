import { WS_EVENTS } from '@vizyo/tracky-shared';
import { PositionBroadcastBuffer } from './position-broadcast-buffer.service';

/**
 * Couvre le coalescing + l'émission systématique du batch (fix du finding disputé :
 * plus de filtre « room vide » basé sur l'adapter LOCAL, incorrect en multi-instance).
 *
 * ⚠️ Le buffer n'émet plus sur `server` directement : il passe par la PASSERELLE
 * (`gateway.emitPositionsBatch`). Elle seule connaît les raccordements au périmètre
 * RESTREINT, qui ne sont dans aucun salon de flotte et doivent recevoir un lot FILTRÉ.
 * Émettre sur le salon depuis ici les priverait de tout live — ou, avant le correctif,
 * leur livrait les positions de tous les véhicules de la flotte.
 */
describe('PositionBroadcastBuffer', () => {
  function makeBuffer() {
    const emitPositionsBatch = jest.fn();
    // `server` reste lu par le buffer pour savoir s'il y a un serveur attaché.
    const gateway = { server: {}, emitPositionsBatch };
    const buffer = new PositionBroadcastBuffer(gateway as never);
    return { buffer, emitPositionsBatch };
  }

  const pos = (trackerId: string, vehicleId = 'v') =>
    ({ trackerId, vehicleId, lat: 1, lng: 2, speedKmh: 0, heading: 0, timestamp: '' }) as never;

  it('coalesce par trackerId et emet UN lot par flotte au flush', () => {
    const { buffer, emitPositionsBatch } = makeBuffer();
    buffer.enqueue('fleet-1', pos('t1'));
    buffer.enqueue('fleet-1', pos('t1')); // meme tracker -> dedup (garde le dernier)
    buffer.enqueue('fleet-1', pos('t2'));

    buffer.flush();

    expect(emitPositionsBatch).toHaveBeenCalledTimes(1);
    const [fleetId, positions] = emitPositionsBatch.mock.calls[0];
    expect(fleetId).toBe('fleet-1');
    expect(positions).toHaveLength(2); // t1 dedupe + t2
  });

  it('emet le lot meme sans presence locale (correct multi-instance, no-op si vide)', () => {
    const { buffer, emitPositionsBatch } = makeBuffer();
    buffer.enqueue('fleet-x', pos('t1'));
    buffer.flush();
    expect(emitPositionsBatch).toHaveBeenCalledTimes(1);
  });

  it('un flush sans rien en buffer n emet pas', () => {
    const { buffer, emitPositionsBatch } = makeBuffer();
    buffer.flush();
    expect(emitPositionsBatch).not.toHaveBeenCalled();
  });

  it('deux flottes produisent deux lots DISTINCTS', () => {
    // Un lot par flotte : melanger deux societes dans un meme evenement serait la
    // fuite inter-clients, cette fois par le temps reel.
    const { buffer, emitPositionsBatch } = makeBuffer();
    buffer.enqueue('fleet-a', pos('t1'));
    buffer.enqueue('fleet-b', pos('t2'));
    buffer.flush();

    expect(emitPositionsBatch).toHaveBeenCalledTimes(2);
    const fleets = emitPositionsBatch.mock.calls.map((c) => c[0]).sort();
    expect(fleets).toEqual(['fleet-a', 'fleet-b']);
  });

  it('le nom de l evenement reste celui du contrat partage', () => {
    // Garde-fou : le renommer casserait tous les clients sans qu'aucun test ne bronche,
    // l'emission etant desormais indirecte.
    expect(WS_EVENTS.POSITIONS_BATCH).toBe('positions:batch');
  });
});
