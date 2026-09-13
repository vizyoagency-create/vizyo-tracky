import { UserRole } from '@prisma/client';
import { VehicleSchedulesService } from './vehicle-schedules.service';

describe('VehicleSchedulesService — activation bulk en file', () => {
  it('enregistre le planning hors plage sans envoyer le CUT dans la requête HTTP', async () => {
    const schedule = {
      id: 's-1', vehicleId: 'v-1', enabled: true, timezone: 'Europe/Paris', countryCode: 'FR',
      mondayEnabled: false, mondayStart: null, mondayEnd: null, mondaySlots: null,
      tuesdayEnabled: false, tuesdayStart: null, tuesdayEnd: null, tuesdaySlots: null,
      wednesdayEnabled: false, wednesdayStart: null, wednesdayEnd: null, wednesdaySlots: null,
      thursdayEnabled: false, thursdayStart: null, thursdayEnd: null, thursdaySlots: null,
      fridayEnabled: false, fridayStart: null, fridayEnd: null, fridaySlots: null,
      saturdayEnabled: false, saturdayStart: null, saturdayEnd: null, saturdaySlots: null,
      sundayEnabled: false, sundayStart: null, sundayEnd: null, sundaySlots: null,
      cutOnHolidays: false, customDates: null, lastEvaluatedState: null, lastEvaluatedAt: null,
      overrideUntil: null, createdAt: new Date(), updatedAt: new Date(),
    } as any;
    const prisma = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ fleetId: 'f-1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'v-1', tracker: { id: 't-1' } }),
      },
      vehicleSchedule: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(schedule),
        upsert: jest.fn().mockResolvedValue(schedule),
        update: jest.fn(),
      },
      tracker: { findFirst: jest.fn() },
      engineControlCommand: { findFirst: jest.fn() },
    } as any;
    const engine = { requestCommand: jest.fn() } as any;
    const service = new VehicleSchedulesService(prisma, engine, { recordBackground: jest.fn() } as any);

    const result = await service.upsert(
      'v-1',
      { enabled: true } as any,
      { userId: 'u-1', role: UserRole.SUPER_ADMIN, fleetId: null },
      { deferImmediateCut: true },
    );

    expect(result).toBe(schedule);
    expect(prisma.vehicleSchedule.upsert).toHaveBeenCalledTimes(1);
    expect(engine.requestCommand).not.toHaveBeenCalled();
    expect(prisma.vehicleSchedule.update).not.toHaveBeenCalled();
  });
});
