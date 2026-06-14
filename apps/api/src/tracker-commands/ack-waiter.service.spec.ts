import { Test } from '@nestjs/testing';
import { AckWaiterService } from './ack-waiter.service';

describe('AckWaiterService', () => {
  let service: AckWaiterService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [AckWaiterService],
    }).compile();
    service = module.get(AckWaiterService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should resolve when ACK matches pattern', async () => {
    const promise = service.waitForAck('123456789012345', /reset\s*ok/i, 5000, 'cmd-1');
    const matched = service.tryMatch('123456789012345', 'reset ok');
    expect(matched).toBe(true);
    const result = await promise;
    expect(result).toBe('reset ok');
  });

  it('should not match wrong pattern', () => {
    const promise = service.waitForAck('123456789012345', /reset\s*ok/i, 5000, 'cmd-1');
    promise.catch(() => {}); // suppress unhandled rejection
    const matched = service.tryMatch('123456789012345', 'speed ok');
    expect(matched).toBe(false);
    service.cancelAll('123456789012345');
  });

  it('should not match different IMEI', () => {
    const promise = service.waitForAck('123456789012345', /reset\s*ok/i, 5000, 'cmd-1');
    promise.catch(() => {}); // suppress unhandled rejection
    const matched = service.tryMatch('999999999999999', 'reset ok');
    expect(matched).toBe(false);
    service.cancelAll('123456789012345');
  });

  it('should timeout and reject', async () => {
    jest.useFakeTimers();
    const promise = service.waitForAck('123456789012345', /reset\s*ok/i, 1000, 'cmd-2');
    jest.advanceTimersByTime(1001);
    await expect(promise).rejects.toThrow('ACK timeout after 1000ms');
  });

  it('should handle multiple waiters on same IMEI', async () => {
    const p1 = service.waitForAck('123456789012345', /reset\s*ok/i, 5000, 'cmd-1');
    const p2 = service.waitForAck('123456789012345', /speed\s*ok/i, 5000, 'cmd-2');

    service.tryMatch('123456789012345', 'speed ok');
    const r2 = await p2;
    expect(r2).toBe('speed ok');

    service.tryMatch('123456789012345', 'reset ok');
    const r1 = await p1;
    expect(r1).toBe('reset ok');
  });

  it('should remove waiter after match', () => {
    service.waitForAck('123456789012345', /reset\s*ok/i, 5000, 'cmd-1');
    expect(service.hasPending('123456789012345')).toBe(true);
    service.tryMatch('123456789012345', 'reset ok');
    expect(service.hasPending('123456789012345')).toBe(false);
  });

  it('should cancel all pending for IMEI', () => {
    const p1 = service.waitForAck('123456789012345', /ok/i, 5000, 'cmd-1');
    const p2 = service.waitForAck('123456789012345', /ok/i, 5000, 'cmd-2');

    service.cancelAll('123456789012345');

    expect(service.hasPending('123456789012345')).toBe(false);
    return Promise.allSettled([p1, p2]).then((results) => {
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
    });
  });

  it('should return false when no waiters exist', () => {
    expect(service.tryMatch('123456789012345', 'anything')).toBe(false);
  });

  it('should resolve the higher-priority waiter when several patterns match (#7)', async () => {
    // Commande generique (pattern LARGE, priorite 0) enregistree EN PREMIER, puis
    // commande moteur (pattern specifique J, priorite haute). L'echo moteur matche
    // LES DEUX patterns -> il ne doit PAS etre vole par le pattern generique.
    const generic = service.waitForAck('123456789012345', /imei:\d{15},/i, 5000, 'cmd-generic', 0);
    const engine = service.waitForAck('123456789012345', /imei:\d{15},J/i, 5000, 'cmd-engine', 10);
    generic.catch(() => {});

    const matched = service.tryMatch('123456789012345', 'imei:123456789012345,J');
    expect(matched).toBe(true);
    await expect(engine).resolves.toBe('imei:123456789012345,J');
    // Le waiter generique reste en attente (non resolu a tort).
    expect(service.hasPending('123456789012345')).toBe(true);
    service.cancelAll('123456789012345');
  });
});
