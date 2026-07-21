import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { DriversService } from './drivers.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/**
 * RGPD 4.3/4.4 — export art. 15 (complet + audité) et anonymisation art. 17 (PII écrasée,
 * User lié neutralisé, Trip.driverId conservé, audité). Tenant : 404 cross-flotte via findOne.
 */
const DRIVER = {
  id: 'd1', fleetId: 'f1', userId: 'u9',
  firstName: 'Jean', lastName: 'Dupont', phone: '0600000000', email: 'jean@ex.fr',
  licenseNumber: 'B-123', notes: 'VIP', isActive: true, color: null, createdAt: new Date(), updatedAt: new Date(),
};

function makeService() {
  const prisma = {
    driver: { findFirst: jest.fn().mockResolvedValue(DRIVER), update: jest.fn().mockResolvedValue({}) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'u9', email: 'jean@ex.fr', firstName: 'Jean', lastName: 'Dupont', role: 'DRIVER', isActive: true, createdAt: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
    userVehicleAccess: { findMany: jest.fn().mockResolvedValue([{ accessType: 'VEHICLE', vehicleId: 'v1', groupId: null, permissions: null, createdAt: new Date() }]), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    trip: { findMany: jest.fn().mockResolvedValue([{ id: 't1', startedAt: new Date(), endedAt: new Date(), durationSeconds: 60, distanceKm: 2, maxSpeed: 50, driverSource: 'AUTO', vehicle: { plate: 'AA-111-AA' } }]) },
    privacyModeEvent: { findMany: jest.fn().mockResolvedValue([]) },
    systemActivityLog: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const systemActivity = { record: jest.fn() };
  const errors = { record: jest.fn().mockResolvedValue('id') };
  const service = new DriversService(
    prisma as unknown as PrismaService,
    systemActivity as unknown as SystemActivityService,
    errors as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity };
}

const ADMIN = { userId: 'a1', role: UserRole.FLEET_ADMIN, fleetId: 'f1' };

describe('DriversService — RGPD', () => {
  it('gdprExport : rassemble profil + compte + accès + trajets + AUDITE (EXPORT)', async () => {
    const { service, systemActivity } = makeService();
    const res = await service.gdprExport('d1', ADMIN);
    expect(res.driver).toMatchObject({ id: 'd1', firstName: 'Jean', licenseNumber: 'B-123' });
    expect(res.account).toMatchObject({ email: 'jean@ex.fr' });
    expect(res.trips.count).toBe(1);
    expect(res.accessScopes).toHaveLength(1);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'EXPORT', action: 'gdpr_driver_export', target: 'Jean Dupont' });
  });

  it('anonymize : écrase la PII, neutralise le User lié, détache les véhicules, AUDITE', async () => {
    const { service, prisma, systemActivity } = makeService();
    const res = await service.anonymize('d1', ADMIN);

    expect(res).toEqual({ ok: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.driver.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ firstName: 'Conducteur', lastName: 'anonymisé', phone: null, email: null, licenseNumber: null, notes: null, isActive: false, userId: null }),
    });
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({ where: { currentDriverId: 'd1' }, data: { currentDriverId: null } });
    expect(prisma.userVehicleAccess.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u9' } });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u9' },
      data: expect.objectContaining({ isActive: false, email: 'anonyme-d1@supprime.tracky.invalid' }),
    });
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'PRIVACY', action: 'driver_anonymized' });
  });

  it('anonymize : conducteur SANS compte lié → pas de mutation User', async () => {
    const { service, prisma } = makeService();
    prisma.driver.findFirst.mockResolvedValue({ ...DRIVER, userId: null });
    await service.anonymize('d1', ADMIN);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.userVehicleAccess.deleteMany).not.toHaveBeenCalled();
  });

  it('cross-flotte → 404 (aucune donnée exportée/modifiée)', async () => {
    const { service, prisma } = makeService();
    prisma.driver.findFirst.mockResolvedValue(null);
    await expect(service.gdprExport('d1', { ...ADMIN, fleetId: 'AUTRE' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.anonymize('d1', { ...ADMIN, fleetId: 'AUTRE' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
