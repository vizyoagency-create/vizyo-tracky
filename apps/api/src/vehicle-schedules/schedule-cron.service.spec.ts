import { ServiceUnavailableException } from '@nestjs/common';
import { ScheduleCronService } from './schedule-cron.service';
import type { VehicleSchedule } from '@prisma/client';

/** Helper to build a schedule with defaults. */
function makeSchedule(overrides: Partial<VehicleSchedule> = {}): VehicleSchedule {
  return {
    id: 'sched-1',
    vehicleId: 'v-1',
    enabled: true,
    timezone: 'Europe/Paris',
    mondayEnabled: true,
    mondayStart: '08:00',
    mondayEnd: '20:00',
    tuesdayEnabled: true,
    tuesdayStart: '08:00',
    tuesdayEnd: '20:00',
    wednesdayEnabled: true,
    wednesdayStart: '08:00',
    wednesdayEnd: '20:00',
    thursdayEnabled: true,
    thursdayStart: '08:00',
    thursdayEnd: '20:00',
    fridayEnabled: true,
    fridayStart: '08:00',
    fridayEnd: '20:00',
    saturdayEnabled: false,
    saturdayStart: null,
    saturdayEnd: null,
    sundayEnabled: false,
    sundayStart: null,
    sundayEnd: null,
    // V1.5 (Sprint K) — multi-plages + jours feries + dates speciales
    mondaySlots: null,
    tuesdaySlots: null,
    wednesdaySlots: null,
    thursdaySlots: null,
    fridaySlots: null,
    saturdaySlots: null,
    sundaySlots: null,
    countryCode: 'FR',
    cutOnHolidays: false,
    customDates: null,
    lastEvaluatedAt: null,
    lastEvaluatedState: null,
    overrideUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ScheduleCronService.computeState', () => {
  let service: ScheduleCronService;

  beforeEach(() => {
    // Only testing computeState — no DB/engine dependencies needed
    service = new ScheduleCronService(null as any, null as any, null as any, { emit: jest.fn() } as any);
  });

  it('should return IN_WINDOW when within allowed hours on an enabled day', () => {
    // Mock Intl to return a Wednesday 10:00
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '10' },
            { type: 'minute', value: '00' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('IN_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return OUT_OF_WINDOW when outside allowed hours', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '22' },
            { type: 'minute', value: '30' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('OUT_OF_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return OUT_OF_WINDOW when day is disabled (Saturday)', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '18' }, // Saturday
            { type: 'hour', value: '10' },
            { type: 'minute', value: '00' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('OUT_OF_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return IN_WINDOW when day enabled but no start/end defined', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '23' },
            { type: 'minute', value: '59' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule({
      wednesdayEnabled: true,
      wednesdayStart: null,
      wednesdayEnd: null,
    });
    expect(service.computeState(schedule)).toBe('IN_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return OUT_OF_WINDOW at the exact end time (end is exclusive)', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '20' },
            { type: 'minute', value: '00' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('OUT_OF_WINDOW');

    jest.restoreAllMocks();
  });

  it('should detect transition from null to IN_WINDOW', () => {
    const schedule = makeSchedule({ lastEvaluatedState: null });
    // computeState doesn't deal with transitions, but the cron does:
    // if state !== lastEvaluatedState → action. null !== 'IN_WINDOW' → transition.
    const state = service.computeState(schedule);
    expect(state !== schedule.lastEvaluatedState).toBe(true);
  });
});

/**
 * Backoff des coupes en échec (incident 2026-07-19 — 954 commandes en échec en une nuit).
 *
 * Le test qui compte le plus est le 3e : une RESTAURATION ne doit JAMAIS être retardée. Rater une
 * coupe est un désagrément ; rater une restauration immobilise un véhicule.
 */
describe('ScheduleCronService — backoff des coupes', () => {
  const OUT_OF_WINDOW_SCHEDULE = () => ({
    ...makeSchedule({
      lastEvaluatedState: 'IN_WINDOW',
      // Samedi désactivé → toujours hors plage, quel que soit le jour du test.
      mondayEnabled: false, tuesdayEnabled: false, wednesdayEnabled: false,
      thursdayEnabled: false, fridayEnabled: false,
    }),
    vehicle: { id: 'v-1', fleetId: 'f-1', tracker: { id: 't-1', imei: '123', status: 'OFFLINE' } },
  } as any);

  function build(failWith?: Error) {
    const prisma = {
      vehicleSchedule: { update: jest.fn().mockResolvedValue({}) },
      scheduleHistory: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const engine = {
      requestCommand: failWith
        ? jest.fn().mockRejectedValue(failWith)
        : jest.fn().mockResolvedValue({}),
    } as any;
    const errorLogger = { record: jest.fn().mockResolvedValue('id') } as any;
    const service = new ScheduleCronService(prisma, engine, errorLogger, { emit: jest.fn() } as any);
    return { service, engine, prisma, errorLogger };
  }

  afterEach(() => jest.useRealTimers());

  it('ne retente PAS une coupe au tick suivant (c\'est l\'appel qui inondait le centre d\'alerte)', async () => {
    const { service, engine } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(schedule); // 1re tentative → échec, backoff armé
    await service.evaluateOne(schedule); // tick suivant (1 min plus tard)
    await service.evaluateOne(schedule);

    expect(engine.requestCommand).toHaveBeenCalledTimes(1);
  });

  it('retente une fois le délai écoulé, avec un palier croissant', async () => {
    jest.useFakeTimers();
    const { service, engine } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2 * 60 * 1000 + 1000); // palier 1 = 2 min
    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(2 * 60 * 1000 + 1000); // palier 2 = 5 min → pas encore
    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(3 * 60 * 1000 + 1000); // total 5 min → OK
    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(3);
  });

  it('⚠️ ne retarde JAMAIS une RESTAURATION, même juste après une coupe en échec', async () => {
    const { service, engine } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const cut = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(cut); // coupe en échec → backoff armé pour ce véhicule
    expect(engine.requestCommand).toHaveBeenCalledTimes(1);

    // Même véhicule, mais on est maintenant DANS la plage → RESTAURATION attendue.
    const restore = {
      ...makeSchedule({ lastEvaluatedState: 'OUT_OF_WINDOW' }),
      mondayEnabled: true, tuesdayEnabled: true, wednesdayEnabled: true,
      thursdayEnabled: true, fridayEnabled: true, saturdayEnabled: true, sundayEnabled: true,
      mondayStart: null, mondayEnd: null, tuesdayStart: null, tuesdayEnd: null,
      wednesdayStart: null, wednesdayEnd: null, thursdayStart: null, thursdayEnd: null,
      fridayStart: null, fridayEnd: null, saturdayStart: null, saturdayEnd: null,
      sundayStart: null, sundayEnd: null,
      vehicle: { id: 'v-1', fleetId: 'f-1', tracker: { id: 't-1', imei: '123', status: 'OFFLINE' } },
    } as any;

    await service.evaluateOne(restore);

    // 2e appel = la restauration est bien partie SANS attendre le backoff de la coupe.
    expect(engine.requestCommand).toHaveBeenCalledTimes(2);
    expect(engine.requestCommand).toHaveBeenLastCalledWith(
      't-1', 'RESTORE', expect.any(String), expect.anything(), 'SCHEDULER',
    );
  });

  it('remet le compteur à zéro quand la coupe finit par passer', async () => {
    const engineMock = jest.fn()
      .mockRejectedValueOnce(new ServiceUnavailableException('hors ligne'))
      .mockResolvedValue({});
    const prisma = {
      vehicleSchedule: { update: jest.fn().mockResolvedValue({}) },
      scheduleHistory: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const service = new ScheduleCronService(
      prisma, { requestCommand: engineMock } as any,
      { record: jest.fn().mockResolvedValue('id') } as any, { emit: jest.fn() } as any,
    );
    jest.useFakeTimers();
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(schedule);            // échec → backoff
    jest.advanceTimersByTime(2 * 60 * 1000 + 1000);
    await service.evaluateOne(schedule);            // succès → backoff effacé

    // Un nouvel échec doit repartir du PREMIER palier (2 min), pas du dernier atteint.
    engineMock.mockRejectedValue(new ServiceUnavailableException('hors ligne'));
    await service.evaluateOne({ ...schedule, lastEvaluatedState: 'IN_WINDOW' });
    expect(engineMock).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(2 * 60 * 1000 + 1000);
    await service.evaluateOne({ ...schedule, lastEvaluatedState: 'IN_WINDOW' });
    expect(engineMock).toHaveBeenCalledTimes(4);
  });

  it('sur une nuit entière : quelques tentatives au lieu d\'une par minute, et le blocage reste visible', async () => {
    jest.useFakeTimers();
    const { service, engine, errorLogger } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    // 12 h de ticks minute par minute — exactement le scénario de l'incident.
    for (let minute = 0; minute < 720; minute++) {
      await service.evaluateOne(schedule);
      jest.advanceTimersByTime(60 * 1000);
    }

    // Avant : 720 commandes (chacune tentant TCP puis SMS, chacune journalisée).
    // Après : paliers 2/5/15 puis 30 min → une trentaine.
    expect(engine.requestCommand.mock.calls.length).toBeLessThan(30);
    expect(engine.requestCommand.mock.calls.length).toBeGreaterThan(5); // on n'abandonne jamais

    // Et le blocage reste REMONTÉ au centre d'alerte (sinon on l'aurait juste rendu silencieux).
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('coupe/reprise impossible') }),
      'schedule-cron',
      expect.objectContaining({ phase: 'stuck-schedule-action' }),
    );
  });
});

describe('ScheduleCronService.evaluateOne override', () => {
  it('should skip evaluation when overrideUntil is in the future', async () => {
    const prisma = { vehicleSchedule: { update: jest.fn() } } as any;
    const engine = { requestCommand: jest.fn() } as any;
    const service = new ScheduleCronService(
      prisma, engine,
      { record: jest.fn().mockResolvedValue('id') } as any,
      { emit: jest.fn() } as any,
    );

    const schedule = {
      ...makeSchedule({
        overrideUntil: new Date(Date.now() + 60_000),
        lastEvaluatedState: 'OUT_OF_WINDOW',
      }),
      vehicle: { id: 'v-1', fleetId: 'f-1', tracker: { id: 't-1', imei: '123', status: 'ONLINE' } },
    } as any;

    await service.evaluateOne(schedule);

    expect(engine.requestCommand).not.toHaveBeenCalled();
  });
});
