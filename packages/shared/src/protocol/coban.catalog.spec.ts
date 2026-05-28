import { COBAN_COMMAND_CATALOG, findTemplate, getCatalogByCategory, CATEGORY_LABELS } from './coban.catalog';

const IMEI = '865328021056352';

describe('CobanCommandCatalog', () => {
  it('should have at least 20 templates (was 20 at V1.5, additions over time OK)', () => {
    expect(COBAN_COMMAND_CATALOG.length).toBeGreaterThanOrEqual(20);
  });

  it('should NOT include engine_stop or engine_resume', () => {
    const ids = COBAN_COMMAND_CATALOG.map((t) => t.id);
    expect(ids).not.toContain('engine_stop');
    expect(ids).not.toContain('engine_resume');
  });

  it('should find template by id', () => {
    expect(findTemplate('reset')).toBeDefined();
    expect(findTemplate('nonexistent')).toBeUndefined();
  });

  it('should group by category', () => {
    const grouped = getCatalogByCategory();
    expect(Object.keys(grouped).length).toBeGreaterThanOrEqual(6);
    expect(grouped['info']).toBeDefined();
    expect(grouped['power']).toBeDefined();
  });

  it('should have labels for all categories', () => {
    const categories = new Set(COBAN_COMMAND_CATALOG.map((t) => t.category));
    for (const cat of categories) {
      expect(CATEGORY_LABELS[cat]).toBeDefined();
    }
  });

  // ─── buildPayload tests ───

  it('status: should build TCP position request', () => {
    const tpl = findTemplate('status')!;
    expect(tpl.buildPayload(IMEI, {})).toBe(`**,imei:${IMEI},B;`);
  });

  it('position_single: should build TCP B command', () => {
    const tpl = findTemplate('position_single')!;
    expect(tpl.buildPayload(IMEI, {})).toBe(`**,imei:${IMEI},B;`);
  });

  it('reset: should build SMS reset command', () => {
    const tpl = findTemplate('reset')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('reset123456');
  });

  it('factory: should build SMS factory command', () => {
    const tpl = findTemplate('factory')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('factory123456');
  });

  it('sleep_on: should build sleep on command', () => {
    const tpl = findTemplate('sleep_on')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('sleep123456 on');
  });

  it('fix_continuous: should build fix command with interval', () => {
    const tpl = findTemplate('fix_continuous')!;
    expect(tpl.buildPayload(IMEI, { interval: '030s' })).toBe('fix030s***n123456');
    expect(tpl.buildPayload(IMEI, { interval: '005m' })).toBe('fix005m***n123456');
  });

  it('fix_stop: should build nofix command', () => {
    const tpl = findTemplate('fix_stop')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('nofix123456');
  });

  it('speed_alarm: should pad speed to 3 digits', () => {
    const tpl = findTemplate('speed_alarm')!;
    expect(tpl.buildPayload(IMEI, { speed_kmh: 80 })).toBe('speed123456 080');
    expect(tpl.buildPayload(IMEI, { speed_kmh: 120 })).toBe('speed123456 120');
  });

  it('move_alarm: should build move command', () => {
    const tpl = findTemplate('move_alarm')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('move123456');
  });

  it('stockade_set: should build geofence box', () => {
    const tpl = findTemplate('stockade_set')!;
    expect(tpl.buildPayload(IMEI, { lat1: 33.5, lng1: -7.6, lat2: 33.6, lng2: -7.5 }))
      .toBe('stockade123456 33.5,-7.6;33.6,-7.5');
  });

  it('stockade_clear: should build nostockade', () => {
    const tpl = findTemplate('stockade_clear')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('nostockade123456');
  });

  it('time_zone: should build timezone command', () => {
    const tpl = findTemplate('time_zone')!;
    expect(tpl.buildPayload(IMEI, { offset: 1 })).toBe('time zone123456,1');
    expect(tpl.buildPayload(IMEI, { offset: -5 })).toBe('time zone123456,-5');
  });

  it('apn: should build apn with optional user/pass', () => {
    const tpl = findTemplate('apn')!;
    expect(tpl.buildPayload(IMEI, { apn: 'internet' })).toBe('apn123456 internet');
    expect(tpl.buildPayload(IMEI, { apn: 'orange.fr', user: 'usr', pass: 'pwd' }))
      .toBe('apn123456 orange.fr,usr,pwd');
  });

  it('adminip: should build adminip command', () => {
    const tpl = findTemplate('adminip')!;
    expect(tpl.buildPayload(IMEI, { ip: '192.168.1.1', port: 5023 }))
      .toBe('adminip123456 192.168.1.1 5023');
  });

  it('password_change: should build password command', () => {
    const tpl = findTemplate('password_change')!;
    expect(tpl.buildPayload(IMEI, { new_pass: '654321' })).toBe('password123456 654321');
  });

  it('protocol_18: should build protocol 18 command', () => {
    const tpl = findTemplate('protocol_18')!;
    expect(tpl.buildPayload(IMEI, {})).toBe('protocol123456 18');
  });

  it('raw: should wrap with TCP prefix if no imei in payload', () => {
    const tpl = findTemplate('raw')!;
    expect(tpl.buildPayload(IMEI, { raw_payload: 'custom_cmd' }))
      .toBe(`**,imei:${IMEI},custom_cmd;`);
  });

  it('raw: should pass through if payload contains imei', () => {
    const tpl = findTemplate('raw')!;
    const payload = `**,imei:${IMEI},X;`;
    expect(tpl.buildPayload(IMEI, { raw_payload: payload })).toBe(payload);
  });

  // ─── ACK pattern matching tests ───

  it('reset ACK should match "reset ok"', () => {
    expect(findTemplate('reset')!.expectedAckPattern.test('reset ok')).toBe(true);
    expect(findTemplate('reset')!.expectedAckPattern.test('Reset OK')).toBe(true);
  });

  it('speed_alarm ACK should match "speed ok!"', () => {
    expect(findTemplate('speed_alarm')!.expectedAckPattern.test('speed ok!')).toBe(true);
    expect(findTemplate('speed_alarm')!.expectedAckPattern.test('Speed OK')).toBe(true);
  });

  it('apn ACK should match "APN OK"', () => {
    expect(findTemplate('apn')!.expectedAckPattern.test('APN OK')).toBe(true);
    expect(findTemplate('apn')!.expectedAckPattern.test('APN ok')).toBe(true);
  });

  it('password_change ACK should match "password ok"', () => {
    expect(findTemplate('password_change')!.expectedAckPattern.test('password ok')).toBe(true);
  });

  it('password_change validation should reject non-6-digit', () => {
    const validator = findTemplate('password_change')!.params[0]!.validate!;
    expect(validator('123456')).toBeNull();
    expect(validator('12345')).not.toBeNull();
    expect(validator('abcdef')).not.toBeNull();
  });

  // ─── Security checks ───

  it('dangerous commands should require confirmation', () => {
    const dangerous = COBAN_COMMAND_CATALOG.filter((t) => t.dangerous);
    for (const tpl of dangerous) {
      expect(tpl.requiresConfirmation).toBe(true);
    }
  });

  it('super admin commands should be marked', () => {
    const superOnly = COBAN_COMMAND_CATALOG.filter((t) => t.requiresSuperAdmin);
    const ids = superOnly.map((t) => t.id);
    expect(ids).toContain('factory');
    expect(ids).toContain('apn');
    expect(ids).toContain('adminip');
    expect(ids).toContain('password_change');
    expect(ids).toContain('protocol_18');
    expect(ids).toContain('raw');
  });
});
