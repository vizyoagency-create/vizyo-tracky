import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { WorkScheduleService } from './work-schedule.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';

/**
 * Cadre de temps de travail : lecture de l'état effectif, upsert + audit (journal Système +
 * PrivacyModeEvent visible du conducteur), et garde de tenant (anti cross-fleet).
 */
function makeService() {
  const prisma = {
    vehicle: { findUnique: jest.fn() },
    vehicleWorkSchedule: { upsert: jest.fn().mockResolvedValue({}) },
    privacyModeEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const systemActivity = { record: jest.fn() };
  const service = new WorkScheduleService(
    prisma as unknown as PrismaService,
    systemActivity as unknown as SystemActivityService,
  );
  return { service, prisma, systemActivity };
}

const ADMIN = { userId: 'a1', role: UserRole.FLEET_ADMIN, fleetId: 'f1' };

describe('WorkScheduleService', () => {
  it('get : sans cadre → état effectif TRACÉ (NO_SCHEDULE)', async () => {
    const { service, prisma } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', fleetId: 'f1', privacyModeEnabled: false, workOverrideUntil: null, workSchedule: null,
    });
    const res = await service.get('v1', ADMIN);
    expect(res.effective).toEqual({ isPrivate: false, reason: 'NO_SCHEDULE' });
    expect(res.schedule).toBeNull();
  });

  it('set : upsert le cadre + AUDITE (journal Système + PrivacyModeEvent visible du conducteur)', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD' });

    const res = await service.set(
      'v1',
      { enabled: true, days: { monday: { enabled: true, start: '08:00', end: '18:00' } } },
      ADMIN,
    );

    expect(res).toEqual({ ok: true });
    expect(prisma.vehicleWorkSchedule.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.vehicleWorkSchedule.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ vehicleId: 'v1' });
    expect(call.update).toMatchObject({ enabled: true, mondayEnabled: true, mondayStart: '08:00', mondayEnd: '18:00' });
    expect(prisma.privacyModeEvent.create).toHaveBeenCalledTimes(1);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'PRIVACY', action: 'work_schedule_updated' });
  });

  it('set : cross-fleet (anti-IDOR) → 404, aucune écriture ni audit', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD' });

    await expect(
      service.set('v1', { enabled: true }, { userId: 'x', role: UserRole.FLEET_MANAGER, fleetId: 'AUTRE' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.vehicleWorkSchedule.upsert).not.toHaveBeenCalled();
    expect(prisma.privacyModeEvent.create).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });
});
