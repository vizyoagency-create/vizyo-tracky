import { parseMaxspeed, inferFromHighway } from './speed-limit.service';

describe('parseMaxspeed', () => {
  it('nombres, mph, catégories FR, cas spéciaux', () => {
    expect(parseMaxspeed('50')).toBe(50);
    expect(parseMaxspeed('30 mph')).toBe(48);
    expect(parseMaxspeed('FR:urban')).toBe(50);
    expect(parseMaxspeed('FR:motorway')).toBe(130);
    expect(parseMaxspeed('FR:rural')).toBe(80);
    expect(parseMaxspeed('walk')).toBe(6);
  });
  it('inconnu / vide → null (jamais un faux nombre)', () => {
    expect(parseMaxspeed('none')).toBeNull();
    expect(parseMaxspeed('bogus')).toBeNull();
    expect(parseMaxspeed('')).toBeNull();
    expect(parseMaxspeed(undefined)).toBeNull();
  });
});

describe('inferFromHighway', () => {
  it('défauts FR par type de voie', () => {
    expect(inferFromHighway('motorway')).toBe(130);
    expect(inferFromHighway('trunk')).toBe(110);
    expect(inferFromHighway('residential')).toBe(50);
    expect(inferFromHighway('living_street')).toBe(20);
  });
  it('type inconnu / non routable → null', () => {
    expect(inferFromHighway('footway')).toBeNull();
    expect(inferFromHighway('unknown_type')).toBeNull();
    expect(inferFromHighway(undefined)).toBeNull();
  });
});
