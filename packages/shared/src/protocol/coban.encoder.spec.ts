import { encodeCommand } from './coban.encoder';
import { formatFrequency } from './coban.utils';

const IMEI = '864035050002451';

describe('encodeCommand', () => {
  // 1. engine_stop
  it('should encode engine_stop', () => {
    expect(encodeCommand(IMEI, { type: 'engine_stop' }))
      .toBe(`**,imei:${IMEI},J;`);
  });

  // 2. engine_resume
  it('should encode engine_resume', () => {
    expect(encodeCommand(IMEI, { type: 'engine_resume' }))
      .toBe(`**,imei:${IMEI},K;`);
  });

  // 3. alarm_arm
  it('should encode alarm_arm', () => {
    expect(encodeCommand(IMEI, { type: 'alarm_arm' }))
      .toBe(`**,imei:${IMEI},L;`);
  });

  // 4. alarm_disarm
  it('should encode alarm_disarm', () => {
    expect(encodeCommand(IMEI, { type: 'alarm_disarm' }))
      .toBe(`**,imei:${IMEI},M;`);
  });

  // 5. position_single
  it('should encode position_single', () => {
    expect(encodeCommand(IMEI, { type: 'position_single' }))
      .toBe(`**,imei:${IMEI},B;`);
  });

  // 6. position_periodic 30s
  it('should encode position_periodic 30s', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 30 }))
      .toBe(`**,imei:${IMEI},C,30s;`);
  });

  // 7. position_periodic 120s → 02m
  it('should encode position_periodic 120s as 02m', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 120 }))
      .toBe(`**,imei:${IMEI},C,02m;`);
  });

  // 8. position_periodic 3600s → 01h
  it('should encode position_periodic 3600s as 01h', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 3600 }))
      .toBe(`**,imei:${IMEI},C,01h;`);
  });

  // 9. position_periodic 90s → 01m (truncates like Traccar)
  it('should encode position_periodic 90s as 01m (truncates)', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 90 }))
      .toBe(`**,imei:${IMEI},C,01m;`);
  });

  // 10. position_stop
  it('should encode position_stop', () => {
    expect(encodeCommand(IMEI, { type: 'position_stop' }))
      .toBe(`**,imei:${IMEI},D;`);
  });

  // 11. request_photo → 160
  it('should encode request_photo with numeric 160', () => {
    expect(encodeCommand(IMEI, { type: 'request_photo' }))
      .toBe(`**,imei:${IMEI},160;`);
  });

  // 12. sos_ack
  it('should encode sos_ack', () => {
    expect(encodeCommand(IMEI, { type: 'sos_ack' }))
      .toBe(`**,imei:${IMEI},E;`);
  });

  // 13. custom
  it('should encode custom command', () => {
    expect(encodeCommand(IMEI, { type: 'custom', raw: 'F,1000m' }))
      .toBe(`**,imei:${IMEI},F,1000m;`);
  });

  // 14. Invalid IMEI (14 digits) → throw
  it('should throw on invalid IMEI', () => {
    expect(() => encodeCommand('12345678901234', { type: 'engine_stop' }))
      .toThrow('Invalid IMEI');
  });

  // 15. position_periodic frequency=0 → throw
  it('should throw on frequency=0', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 0 }))
      .toThrow('Invalid frequency');
  });

  // 16. position_periodic frequency=100000 → throw
  it('should throw on frequency>86400', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 100000 }))
      .toThrow('Invalid frequency');
  });
});

describe('formatFrequency', () => {
  it('should format 30 as 30s', () => expect(formatFrequency(30)).toBe('30s'));
  it('should format 120 as 02m', () => expect(formatFrequency(120)).toBe('02m'));
  it('should format 3600 as 01h', () => expect(formatFrequency(3600)).toBe('01h'));
  it('should format 5 as 05s', () => expect(formatFrequency(5)).toBe('05s'));
});
