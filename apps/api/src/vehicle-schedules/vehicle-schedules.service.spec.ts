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

/**
 * 06/10/2026 — activer le planning d'un véhicule INDISPONIBLE hors de sa plage ne le coupe pas :
 * même règle que le cron (coupes automatiques suspendues). Avant, la coupe immédiate partait —
 * le seul chemin SCHEDULER qui ne passait pas par le cron.
 */
describe('VehicleSchedulesService — activation hors plage d’un véhicule indisponible', () => {
  const horsPlage = () => ({
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
  }) as any;

  function build(opts: { motif?: string | null; evenements?: unknown[] } = {}) {
    const schedule = horsPlage();
    const prisma = {
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({ fleetId: 'f-1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'v-1', tracker: { id: 't-1' }, outOfServiceReason: opts.motif ?? null }),
      },
      vehicleSchedule: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(schedule),
        upsert: jest.fn().mockResolvedValue(schedule),
        update: jest.fn().mockResolvedValue(schedule),
      },
      tracker: { findFirst: jest.fn().mockResolvedValue({ id: 't-1' }) },
      engineControlCommand: { findFirst: jest.fn() },
      vehicleEvent: { findMany: jest.fn().mockResolvedValue(opts.evenements ?? []) },
    } as any;
    const engine = { requestCommand: jest.fn().mockResolvedValue({}) } as any;
    const service = new VehicleSchedulesService(prisma, engine, { recordBackground: jest.fn() } as any);
    const activer = () => service.upsert('v-1', { enabled: true } as any, { userId: 'u-1', role: UserRole.SUPER_ADMIN, fleetId: null });
    return { prisma, engine, activer };
  }

  it('en service : la coupe immédiate part, comme avant (repère)', async () => {
    const { engine, activer } = build();
    await activer();
    expect(engine.requestCommand).toHaveBeenCalledTimes(1);
    expect(engine.requestCommand.mock.calls[0][1]).toBe('CUT');
  });

  it('déclaré immobilisé : aucune coupe, et l’état n’avance pas (le cron reprendra à la remise en service)', async () => {
    const { engine, prisma, activer } = build({ motif: 'IMMOBILIZED' });
    await activer();
    expect(engine.requestCommand).not.toHaveBeenCalled();
    expect(prisma.vehicleSchedule.update).not.toHaveBeenCalled();
  });

  it('en maintenance dans l’agenda : aucune coupe non plus', async () => {
    const H = 60 * 60 * 1000;
    const { engine, activer } = build({
      evenements: [{
        id: 'ev-1', vehicleId: 'v-1', type: 'MAINTENANCE', status: 'IN_PROGRESS', blocksVehicle: true,
        title: 'Carrosserie', startAt: new Date(Date.now() - H), endAt: new Date(Date.now() + H),
      }],
    });
    await activer();
    expect(engine.requestCommand).not.toHaveBeenCalled();
  });
});
