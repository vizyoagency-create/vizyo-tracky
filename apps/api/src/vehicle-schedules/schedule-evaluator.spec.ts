import { evaluateSchedule } from './schedule-evaluator';

/**
 * V1.6 (P6) — Tests unitaires schedule-evaluator (Sprint K).
 *
 * Couvre les 3 niveaux : customDates > jours feries > plages hebdo.
 * Tous les `now` sont en UTC, le timezone du schedule est applique
 * pour ramener `now` en local-tz avant les checks.
 */

function baseSchedule(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    timezone: 'UTC',
    countryCode: '',
    customDates: null,
    mondayEnabled: true,  mondayStart: '08:00',  mondayEnd: '18:00',  mondaySlots: null,
    tuesdayEnabled: true, tuesdayStart: '08:00', tuesdayEnd: '18:00', tuesdaySlots: null,
    wednesdayEnabled: true, wednesdayStart: '08:00', wednesdayEnd: '18:00', wednesdaySlots: null,
    thursdayEnabled: true, thursdayStart: '08:00', thursdayEnd: '18:00', thursdaySlots: null,
    fridayEnabled: true, fridayStart: '08:00', fridayEnd: '18:00', fridaySlots: null,
    saturdayEnabled: false, saturdayStart: null, saturdayEnd: null, saturdaySlots: null,
    sundayEnabled: false, sundayStart: null, sundayEnd: null, sundaySlots: null,
    ...overrides,
  };
}

// 2026-04-27 (lundi) 10:00 UTC
const MONDAY_10H = new Date('2026-04-27T10:00:00Z');
// 2026-04-27 (lundi) 22:00 UTC
const MONDAY_22H = new Date('2026-04-27T22:00:00Z');
// 2026-04-25 (samedi) 10:00 UTC
const SATURDAY_10H = new Date('2026-04-25T10:00:00Z');

describe('evaluateSchedule', () => {
  it('IN_WINDOW dans les plages hebdo simples', () => {
    const r = evaluateSchedule(baseSchedule(), MONDAY_10H);
    expect(r.state).toBe('IN_WINDOW');
    expect(r.reason).toBe('IN_WINDOW');
  });

  it('OUT_OF_WINDOW hors des plages hebdo', () => {
    const r = evaluateSchedule(baseSchedule(), MONDAY_22H);
    expect(r.state).toBe('OUT_OF_WINDOW');
    expect(r.reason).toBe('OUT_OF_WINDOW');
  });

  it('OUT_OF_WINDOW quand le jour est desactive', () => {
    const r = evaluateSchedule(baseSchedule(), SATURDAY_10H);
    expect(r.state).toBe('OUT_OF_WINDOW');
    expect(r.reason).toBe('DAY_DISABLED');
  });

  it('IN_WINDOW dans une des plages multi-slots', () => {
    const s = baseSchedule({
      mondaySlots: [
        { start: '08:00', end: '12:00' },
        { start: '14:00', end: '18:00' },
      ],
    });
    const r = evaluateSchedule(s, MONDAY_10H); // 10:00 in [08-12]
    expect(r.state).toBe('IN_WINDOW');
  });

  it('OUT_OF_WINDOW entre 2 slots multi (pause dejeuner)', () => {
    const s = baseSchedule({
      mondaySlots: [
        { start: '08:00', end: '12:00' },
        { start: '14:00', end: '18:00' },
      ],
    });
    const lunchTime = new Date('2026-04-27T13:00:00Z');
    const r = evaluateSchedule(s, lunchTime);
    expect(r.state).toBe('OUT_OF_WINDOW');
  });

  it('customDates closed=true → OUT_OF_WINDOW (priorite max)', () => {
    const s = baseSchedule({
      customDates: [{ date: '2026-04-27', closed: true }],
    });
    const r = evaluateSchedule(s, MONDAY_10H);
    expect(r.state).toBe('OUT_OF_WINDOW');
    expect(r.reason).toBe('CUSTOM_DATE_CLOSED');
  });

  it('customDates avec slots specifiques override les plages hebdo', () => {
    const s = baseSchedule({
      customDates: [{
        date: '2026-04-27',
        slots: [{ start: '06:00', end: '09:00' }],
      }],
    });
    const r1 = evaluateSchedule(s, new Date('2026-04-27T07:00:00Z'));
    expect(r1.state).toBe('IN_WINDOW');
    expect(r1.reason).toBe('CUSTOM_DATE_RANGE');

    const r2 = evaluateSchedule(s, MONDAY_10H);
    expect(r2.state).toBe('OUT_OF_WINDOW');
    expect(r2.reason).toBe('CUSTOM_DATE_OUT');
  });

  it('countryCode FR + jour ferie → OUT_OF_WINDOW HOLIDAY', () => {
    const s = baseSchedule({ countryCode: 'FR' });
    // 2026-05-01 (vendredi) Fete du travail FR
    const r = evaluateSchedule(s, new Date('2026-05-01T10:00:00Z'));
    expect(r.state).toBe('OUT_OF_WINDOW');
    expect(r.reason).toBe('HOLIDAY');
  });

  it('countryCode invalide ne fait pas planter (fallback hebdo)', () => {
    const s = baseSchedule({ countryCode: 'XX_INVALID' });
    const r = evaluateSchedule(s, MONDAY_10H);
    expect(r.state).toBe('IN_WINDOW');
  });

  it('jour active sans plages = no restriction (toute la journee)', () => {
    const s = baseSchedule({
      mondayStart: null, mondayEnd: null, mondaySlots: null,
    });
    const r = evaluateSchedule(s, MONDAY_22H);
    expect(r.state).toBe('IN_WINDOW');
    expect(r.reason).toBe('IN_WINDOW');
  });

  it('plage de nuit (fin < debut) matche bien autour de minuit (#8)', () => {
    const s = baseSchedule({ mondaySlots: [{ start: '22:00', end: '06:00' }] });
    // 22:00 -> dans la plage de nuit (apres le debut)
    expect(evaluateSchedule(s, MONDAY_22H).state).toBe('IN_WINDOW');
    // 03:00 -> encore dans la plage (avant la fin 06:00)
    expect(evaluateSchedule(s, new Date('2026-04-27T03:00:00Z')).state).toBe('IN_WINDOW');
    // 10:00 -> hors plage de nuit
    expect(evaluateSchedule(s, MONDAY_10H).state).toBe('OUT_OF_WINDOW');
  });
});
