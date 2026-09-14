import { computeNextTransition, computeUpcomingHolidays, evaluateSchedule, getNowInTimezone } from './schedule-evaluator';

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
    cutOnHolidays: false,
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

  // Incident 2026-07-14 — la coupe les fériés est désormais OPT-IN (cutOnHolidays).
  it('countryCode FR + jour ferie SANS cutOnHolidays → suit les horaires normaux (IN_WINDOW)', () => {
    const s = baseSchedule({ countryCode: 'FR' }); // cutOnHolidays défaut false
    // 2026-05-01 (vendredi) Fete du travail FR, 10:00 dans la plage 08-18 → doit rouler.
    const r = evaluateSchedule(s, new Date('2026-05-01T10:00:00Z'));
    expect(r.state).toBe('IN_WINDOW');
  });

  it('countryCode FR + cutOnHolidays=true + jour ferie → OUT_OF_WINDOW HOLIDAY (opt-in)', () => {
    const s = baseSchedule({ countryCode: 'FR', cutOnHolidays: true });
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

describe('computeNextTransition (compte-à-rebours page flotte)', () => {
  it('dans la plage → prochaine bascule = CUT à la fin de plage (18:00) le jour même', () => {
    const nt = computeNextTransition(baseSchedule(), MONDAY_10H);
    expect(nt).not.toBeNull();
    expect(nt!.action).toBe('CUT');
    // 2026-04-27 18:00 UTC (timezone du planning = UTC)
    expect(nt!.at.getUTCHours()).toBe(18);
    expect(nt!.at.getUTCMinutes()).toBe(0);
    expect(nt!.at.getUTCDate()).toBe(27);
  });

  it('hors plage le soir → prochaine bascule = RESTORE au début de plage du lendemain (08:00)', () => {
    const nt = computeNextTransition(baseSchedule(), MONDAY_22H);
    expect(nt).not.toBeNull();
    expect(nt!.action).toBe('RESTORE');
    // mardi 2026-04-28 08:00 UTC
    expect(nt!.at.getUTCHours()).toBe(8);
    expect(nt!.at.getUTCDate()).toBe(28);
  });

  it('planning « toujours ouvert » (tous les jours sans plages) → aucune bascule → null', () => {
    const allOpen = baseSchedule({
      mondayStart: null, mondayEnd: null, tuesdayStart: null, tuesdayEnd: null,
      wednesdayStart: null, wednesdayEnd: null, thursdayStart: null, thursdayEnd: null,
      fridayStart: null, fridayEnd: null,
      saturdayEnabled: true, saturdayStart: null, saturdayEnd: null,
      sundayEnabled: true, sundayStart: null, sundayEnd: null,
    });
    expect(computeNextTransition(allOpen, MONDAY_10H)).toBeNull();
  });

  it('action manuelle ne casse pas le cycle : CUT en journée → CUT du soir → RESTORE le lendemain', () => {
    const schedule = baseSchedule(); // fenêtre 08:00–18:00 UTC

    // À midi le planning est en phase IN_WINDOW. La coupe manuelle est une dérogation :
    // elle expire à la bascule du soir, sans modifier le planning ni son état mémorisé.
    const apresCoupeManuelle = computeNextTransition(schedule, MONDAY_10H);
    expect(apresCoupeManuelle).toEqual({
      action: 'CUT',
      at: new Date('2026-04-27T18:00:00.000Z'),
    });

    // Le cron reprend alors son cycle normal : OUT le soir, puis IN le lendemain matin.
    expect(evaluateSchedule(schedule, apresCoupeManuelle!.at).state).toBe('OUT_OF_WINDOW');
    const reprise = computeNextTransition(schedule, apresCoupeManuelle!.at);
    expect(reprise).toEqual({
      action: 'RESTORE',
      at: new Date('2026-04-28T08:00:00.000Z'),
    });
    expect(evaluateSchedule(schedule, reprise!.at).state).toBe('IN_WINDOW');
  });

  it('RESTORE manuel après la coupe du soir → planning toujours actif et RESTORE garanti le matin', () => {
    const schedule = baseSchedule();
    const apresRallumageManuel = computeNextTransition(schedule, MONDAY_22H);
    expect(apresRallumageManuel).toEqual({
      action: 'RESTORE',
      at: new Date('2026-04-28T08:00:00.000Z'),
    });
  });
});

describe('computeUpcomingHolidays (aperçu fériés page flotte — incident 14/07)', () => {
  it('FR renvoie les prochains fériés PUBLICS à venir, triés', () => {
    const from = new Date('2026-07-01T10:00:00Z');
    const up = computeUpcomingHolidays('FR', from, 2);
    expect(up.length).toBe(2);
    expect(up[0].date).toBe('2026-07-14'); // Fête Nationale
    expect(up[1].date).toBe('2026-08-15'); // Assomption
    expect(up[0].name).toBeTruthy();
  });

  it('sans countryCode → vide', () => {
    expect(computeUpcomingHolidays('', new Date())).toEqual([]);
  });

  it('countryCode invalide → vide (ne plante pas)', () => {
    expect(computeUpcomingHolidays('XX_INVALID', new Date())).toEqual([]);
  });
});

/**
 * ── T53 (contre-expertise du 13/09, P2-10) — changement d'heure Europe/Paris ───────────────────
 * Le 25/10/2026 à 03:00 CEST les horloges reviennent à 02:00 CET : l'heure murale 02:00–02:59
 * existe DEUX fois. Le 28/03/2027 à 02:00 CET elles sautent à 03:00 CEST : 02:00–02:59 n'existe
 * pas. `getNowInTimezone` fabrique une Date LOCALE à partir de l'heure murale du fuseau, et
 * l'évaluateur n'en lit que le jour et l'heure murale — c'est ce que ces tests fixent, instant UTC
 * par instant UTC, pour que le prochain changement d'heure ne soit pas une découverte.
 */
describe('T53 — changement d heure Europe/Paris (25/10/2026, puis 28/03/2027)', () => {
  const paris = (overrides: Partial<Record<string, unknown>> = {}) =>
    baseSchedule({
      timezone: 'Europe/Paris',
      saturdayEnabled: true, saturdayStart: '06:00', saturdayEnd: '18:00',
      sundayEnabled: true, sundayStart: '06:00', sundayEnd: '18:00',
      ...overrides,
    });

  it('getNowInTimezone : autour de 01:00Z le 25/10, l heure murale passe de 02:59:59 à 02:00:00 puis 03:00:00 — même dimanche 25', () => {
    const mur = (iso: string) => {
      const w = getNowInTimezone('Europe/Paris', new Date(iso));
      return { d: w.getDate(), day: w.getDay(), h: w.getHours(), m: w.getMinutes(), s: w.getSeconds() };
    };
    expect(mur('2026-10-25T00:59:59Z')).toEqual({ d: 25, day: 0, h: 2, m: 59, s: 59 }); // 02:59:59 CEST
    expect(mur('2026-10-25T01:00:00Z')).toEqual({ d: 25, day: 0, h: 2, m: 0, s: 0 });   // 02:00:00 CET — l'heure recommence
    expect(mur('2026-10-25T01:59:59Z')).toEqual({ d: 25, day: 0, h: 2, m: 59, s: 59 }); // 02:59:59 CET
    expect(mur('2026-10-25T02:00:00Z')).toEqual({ d: 25, day: 0, h: 3, m: 0, s: 0 });   // 03:00:00 CET
  });

  it('la fenêtre 06:00–18:00 s ouvre à 04:00Z le samedi 24/10 (CEST) mais à 05:00Z le dimanche 25/10 (CET)', () => {
    const s = paris();
    expect(evaluateSchedule(s, new Date('2026-10-24T03:59:59Z')).state).toBe('OUT_OF_WINDOW');
    expect(evaluateSchedule(s, new Date('2026-10-24T04:00:00Z')).state).toBe('IN_WINDOW');     // 06:00 CEST
    expect(evaluateSchedule(s, new Date('2026-10-25T04:00:00Z')).state).toBe('OUT_OF_WINDOW'); // 05:00 CET : une heure trop tôt
    expect(evaluateSchedule(s, new Date('2026-10-25T04:59:59Z')).state).toBe('OUT_OF_WINDOW');
    expect(evaluateSchedule(s, new Date('2026-10-25T05:00:00Z')).state).toBe('IN_WINDOW');     // 06:00 CET
    expect(evaluateSchedule(s, new Date('2026-10-25T16:59:59Z')).state).toBe('IN_WINDOW');
    expect(evaluateSchedule(s, new Date('2026-10-25T17:00:00Z')).state).toBe('OUT_OF_WINDOW'); // 18:00 CET
  });

  it('computeNextTransition traverse le changement d heure : RESTORE du dimanche 06:00 à 05:00Z, CUT de 18:00 à 17:00Z', () => {
    const s = paris();
    expect(computeNextTransition(s, new Date('2026-10-24T20:00:00Z'))).toEqual({ at: new Date('2026-10-25T05:00:00Z'), action: 'RESTORE' });
    expect(computeNextTransition(s, new Date('2026-10-25T10:00:00Z'))).toEqual({ at: new Date('2026-10-25T17:00:00Z'), action: 'CUT' });
  });

  it('l heure répétée : une plage de nuit 22:00–02:45 se referme DEUX fois (02:45 CEST puis 02:45 CET) — sémantique horloge murale, connue et documentée, non corrigée', () => {
    const s = paris({ saturdayStart: '22:00', saturdayEnd: '02:45', sundayStart: '22:00', sundayEnd: '02:45' });
    expect(evaluateSchedule(s, new Date('2026-10-25T00:44:59Z')).state).toBe('IN_WINDOW');     // 02:44:59 CEST
    expect(evaluateSchedule(s, new Date('2026-10-25T00:45:00Z')).state).toBe('OUT_OF_WINDOW'); // 02:45 CEST → CUT
    expect(evaluateSchedule(s, new Date('2026-10-25T01:00:00Z')).state).toBe('IN_WINDOW');     // 02:00 CET → RESTORE
    expect(evaluateSchedule(s, new Date('2026-10-25T01:45:00Z')).state).toBe('OUT_OF_WINDOW'); // 02:45 CET → CUT à nouveau
    expect(evaluateSchedule(s, new Date('2026-10-25T02:00:00Z')).state).toBe('OUT_OF_WINDOW'); // 03:00 CET
    // Le compte-à-rebours suit la même horloge : trois bascules en une heure et quart.
    expect(computeNextTransition(s, new Date('2026-10-25T00:30:00Z'))).toEqual({ at: new Date('2026-10-25T00:45:00Z'), action: 'CUT' });
    expect(computeNextTransition(s, new Date('2026-10-25T00:45:00Z'))).toEqual({ at: new Date('2026-10-25T01:00:00Z'), action: 'RESTORE' });
    expect(computeNextTransition(s, new Date('2026-10-25T01:00:00Z'))).toEqual({ at: new Date('2026-10-25T01:45:00Z'), action: 'CUT' });
  });

  it('le 28/03/2027, l heure sautée : une plage 02:30–06:00 s ouvre directement à 03:00 CEST (01:00Z), jamais à 02:30', () => {
    const s = paris({ sundayStart: '02:30', sundayEnd: '06:00' });
    expect(evaluateSchedule(s, new Date('2027-03-28T00:59:59Z')).state).toBe('OUT_OF_WINDOW'); // 01:59:59 CET
    expect(evaluateSchedule(s, new Date('2027-03-28T01:00:00Z')).state).toBe('IN_WINDOW');     // 03:00:00 CEST
    expect(computeNextTransition(s, new Date('2027-03-28T00:00:00Z'))).toEqual({ at: new Date('2027-03-28T01:00:00Z'), action: 'RESTORE' });
    expect(evaluateSchedule(s, new Date('2027-03-28T04:00:00Z')).state).toBe('OUT_OF_WINDOW'); // 06:00 CEST
  });
});
