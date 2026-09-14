import { SocketRegistryService, TRACKER_CONNECTED_EVENT, type TrackerSocket } from './socket-registry.service';

/**
 * T42 (contre-expertise du 13/09, P1-1) — le registre DIT quand un boîtier redevient joignable.
 * Avant : aucun événement ; une RESTORE non prouvée ne pouvait pas savoir que sa socket était revenue.
 */
describe('SocketRegistryService — événement tracker.connected (T42)', () => {
  const IMEI = '123456789012345';
  const makeSocket = (remoteAddress = '10.0.0.1'): TrackerSocket & { destroy: jest.Mock } => ({
    write: jest.fn().mockReturnValue(true),
    destroy: jest.fn(),
    remoteAddress,
    destroyed: false,
    writable: true,
  });

  it('émet à la PREMIÈRE inscription d un IMEI, après que la socket est trouvable', () => {
    const emit = jest.fn();
    const registry = new SocketRegistryService({ emit } as never);
    const socket = makeSocket('10.0.0.1');
    emit.mockImplementation(() => {
      // Un abonné qui écrit immédiatement doit trouver la socket : l'inscription précède l'événement.
      expect(registry.has(IMEI)).toBe(true);
    });

    registry.register(IMEI, socket);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(TRACKER_CONNECTED_EVENT, {
      imei: IMEI,
      remoteAddress: '10.0.0.1',
      replaced: false,
      at: expect.any(String),
    });
  });

  it('émet avec replaced=true quand une socket neuve remplace l ancienne — et détruit l ancienne', () => {
    const emit = jest.fn();
    const registry = new SocketRegistryService({ emit } as never);
    const ancienne = makeSocket('10.0.0.1');
    const nouvelle = makeSocket('10.0.0.2');
    registry.register(IMEI, ancienne);
    emit.mockClear();

    registry.register(IMEI, nouvelle);

    expect(ancienne.destroy).toHaveBeenCalledTimes(1);
    expect(registry.get(IMEI)?.socket).toBe(nouvelle);
    expect(emit).toHaveBeenCalledWith(TRACKER_CONNECTED_EVENT, expect.objectContaining({ imei: IMEI, replaced: true, remoteAddress: '10.0.0.2' }));
  });

  it('n émet PAS quand le boîtier renvoie son login sur la MÊME socket — ce n est pas une reconnexion', () => {
    const emit = jest.fn();
    const registry = new SocketRegistryService({ emit } as never);
    const socket = makeSocket();
    registry.register(IMEI, socket);
    emit.mockClear();

    registry.register(IMEI, socket);

    expect(emit).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('sans émetteur (specs, outils) : le registre fonctionne comme avant', () => {
    const registry = new SocketRegistryService();
    const socket = makeSocket();
    expect(() => registry.register(IMEI, socket)).not.toThrow();
    expect(registry.send(IMEI, 'LOAD')).toBe(true);
    expect(socket.write).toHaveBeenCalledWith('LOAD');
  });

  it('🔴 un abonné qui lève ne casse JAMAIS le login du boîtier', () => {
    const emit = jest.fn().mockImplementation(() => {
      throw new Error('abonné cassé');
    });
    const registry = new SocketRegistryService({ emit } as never);
    const socket = makeSocket();

    expect(() => registry.register(IMEI, socket)).not.toThrow();
    expect(registry.has(IMEI)).toBe(true);
  });
});
