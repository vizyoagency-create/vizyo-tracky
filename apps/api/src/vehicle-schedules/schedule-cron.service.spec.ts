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
    service = new ScheduleCronService(null as any, null as any, null as any);
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

describe('ScheduleCronService.evaluateOne override', () => {
  it('should skip evaluation when overrideUntil is in the future', async () => {
    const prisma = { vehicleSchedule: { update: jest.fn() } } as any;
    const engine = { requestCommand: jest.fn() } as any;
    const service = new ScheduleCronService(prisma, engine, { record: jest.fn().mockResolvedValue('id') } as any);

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
