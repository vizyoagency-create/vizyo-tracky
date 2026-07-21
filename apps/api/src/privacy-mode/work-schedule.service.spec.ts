import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { WorkScheduleService } from './work-schedule.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/**
 * Cadre de temps de travail : lecture de l'état effectif, upsert + audit (journal Système +
 * PrivacyModeEvent visible du conducteur), garde de tenant (anti cross-fleet), et remontée des
 * erreurs inattendues au centre d'alerte (ErrorLogger).
 */
function makeService() {
  const prisma = {
    vehicle: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    vehicleWorkSchedule: { upsert: jest.fn().mockResolvedValue({}) },
    privacyModeEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const systemActivity = { record: jest.fn() };
  const errors = { record: jest.fn().mockResolvedValue('err-id') };
  const service = new WorkScheduleService(
    prisma as unknown as PrismaService,
    systemActivity as unknown as SystemActivityService,
    errors as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity, errors };
}

const ADMIN = { userId: 'a1', role: UserRole.FLEET_ADMIN, fleetId: 'f1' };

describe('WorkScheduleService', () => {
  it('get : sans cadre → état effectif TRACÉ (NO_SCHEDULE)', async () => {
    const { service, prisma } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', fleetId: 'f1', mixedUseEnabled: true, privacyModeEnabled: false, workOverrideUntil: null, workSchedule: null,
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

  it('set : erreur INATTENDUE (DB) → remontée au centre d\'alerte (ErrorLogger) + propagée', async () => {
    const { service, prisma, errors } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD' });
    prisma.vehicleWorkSchedule.upsert.mockRejectedValueOnce(new Error('db down'));

    await expect(service.set('v1', { enabled: true }, ADMIN)).rejects.toThrow('db down');
    expect(errors.record).toHaveBeenCalledTimes(1);
    expect(errors.record.mock.calls[0][1]).toBe('work-schedule'); // source repérable dans le centre d'alerte
  });
});


describe('WorkScheduleService — usage mixte (lot 2)', () => {
  it('setMixedUse(true) : active le flag + AUDITE des deux côtés (journal + timeline conducteur)', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', mixedUseEnabled: false, privacyModeEnabled: false,
    });

    const res = await service.setMixedUse('v1', true, ADMIN);

    expect(res).toEqual({ ok: true, mixedUseEnabled: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { mixedUseEnabled: true } });
    // Visible du conducteur (même timeline que ses bascules) …
    expect(prisma.privacyModeEvent.create.mock.calls[0][0].data).toMatchObject({ vehicleId: 'v1', enabled: true, userId: 'a1' });
    // … et dans le journal Système (feed admin).
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'PRIVACY', action: 'mixed_use_enabled', target: 'AB-123-CD' });
  });

  it('setMixedUse(false) : lève AUSSI le privé manuel (jamais un état affiché mensonger)', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', mixedUseEnabled: true, privacyModeEnabled: true,
    });

    await service.setMixedUse('v1', false, ADMIN);

    expect(prisma.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { mixedUseEnabled: false, privacyModeEnabled: false, privacyModeSince: null, privacyModeNote: null },
    });
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ action: 'mixed_use_disabled' });
  });

  it('setMixedUse : idempotent (même valeur → aucune écriture, aucun bruit au journal)', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', mixedUseEnabled: true, privacyModeEnabled: false,
    });
    await service.setMixedUse('v1', true, ADMIN);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  it('setMixedUse : véhicule d’une AUTRE flotte → 404, rien modifié', async () => {
    const { service, prisma } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', fleetId: 'AUTRE', plate: 'AB-123-CD', mixedUseEnabled: false, privacyModeEnabled: false,
    });
    await expect(service.setMixedUse('v1', true, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('coverage : classe PROTEGE / MIXTE_SANS_CADRE / NON_COUVERT et compte les non-couverts', async () => {
    const { service, prisma } = makeService();
    prisma.vehicle.findMany.mockResolvedValueOnce([
      { id: 'v1', plate: 'AA-111-AA', mixedUseEnabled: true, fleet: { name: 'F1' }, workSchedule: { enabled: true }, currentDriver: { firstName: 'Jean', lastName: 'Dupont' } },
      { id: 'v2', plate: 'BB-222-BB', mixedUseEnabled: true, fleet: { name: 'F1' }, workSchedule: { enabled: false }, currentDriver: null },
      { id: 'v3', plate: 'CC-333-CC', mixedUseEnabled: false, fleet: { name: 'F1' }, workSchedule: null, currentDriver: null },
    ]);

    const res = await service.coverage(ADMIN);

    expect(res.items.map((i) => i.status)).toEqual(['PROTEGE', 'MIXTE_SANS_CADRE', 'NON_COUVERT']);
    expect(res).toMatchObject({ total: 3, protectedCount: 1, uncoveredCount: 2 });
    expect(res.items[0].driverName).toBe('Jean Dupont');
  });

  it('coverage : un non-super ne voit QUE sa flotte (scope tenant)', async () => {
    const { service, prisma } = makeService();
    await service.coverage(ADMIN);
    expect(prisma.vehicle.findMany.mock.calls[0][0].where).toEqual({ fleetId: 'f1' });
  });
});
