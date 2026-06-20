import { UnknownTrackerRegistry } from './unknown-trackers.registry';

describe('UnknownTrackerRegistry', () => {
  let reg: UnknownTrackerRegistry;
  beforeEach(() => {
    reg = new UnknownTrackerRegistry();
  });

  it('record() expose l\'IMEI avec le compteur de tentatives + l\'IP', () => {
    reg.record('864035054757902', '46.114.229.57');
    reg.record('864035054757902', '46.114.229.57');
    reg.record('864035054757902', '46.114.229.57');
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      imei: '864035054757902',
      attempts: 3,
      lastRemoteAddr: '46.114.229.57',
    });
    expect(typeof list[0].firstSeenAt).toBe('string');
    expect(typeof list[0].lastSeenAt).toBe('string');
  });

  it('forget() retire l\'IMEI (appelé quand le tracker se connecte enfin)', () => {
    reg.record('864035054757902', null);
    expect(reg.list()).toHaveLength(1);
    reg.forget('864035054757902');
    expect(reg.list()).toHaveLength(0);
  });

  it('deux IMEI distincts → deux entrées', () => {
    reg.record('111111111111111', '1.1.1.1');
    reg.record('222222222222222', '2.2.2.2');
    expect(reg.list().map((e) => e.imei).sort()).toEqual(['111111111111111', '222222222222222']);
  });

  it('forget() d\'un IMEI absent ne casse pas', () => {
    expect(() => reg.forget('000000000000000')).not.toThrow();
    expect(reg.list()).toHaveLength(0);
  });
});
