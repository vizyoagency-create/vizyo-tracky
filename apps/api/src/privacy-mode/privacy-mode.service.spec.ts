import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrivacyModeService } from './privacy-mode.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/** Acteur de la flotte f1 (tenant OK). */
const ACTOR = { userId: 'u1', role: UserRole.FLEET_MANAGER, fleetId: 'f1' };

/**
 * Vérifie la logique de bascule du mode vie privée : idempotence (pas de bruit si l'état
 * ne change pas), création de l'événement d'historique + journal Système sur changement,
 * et 404 véhicule inconnu.
 */
function makeService() {
  const prisma = {
    vehicle: { findUnique: jest.fn(), update: jest.fn() },
    privacyModeEvent: { create: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const systemActivity = { record: jest.fn() };
  const errors = { record: jest.fn().mockResolvedValue('id') };
  const service = new PrivacyModeService(
    prisma as unknown as PrismaService,
    systemActivity as unknown as SystemActivityService,
    errors as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity, errors };
}

describe('PrivacyModeService', () => {
  it('idempotent : même état demandé → aucun événement ni journal', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique
      .mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', privacyModeEnabled: true }) // setPrivacyMode
      .mockResolvedValueOnce({ id: 'v1', privacyModeEnabled: true, privacyModeSince: new Date(), privacyModeById: null, privacyModeNote: null }); // getState

    const state = await service.setPrivacyMode('v1', { enabled: true }, ACTOR);

    expect(state.enabled).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  it('activation : crée la pose d\'historique + journal Système (catégorie PRIVACY)', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique
      .mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', privacyModeEnabled: false })
      .mockResolvedValueOnce({ id: 'v1', privacyModeEnabled: true, privacyModeSince: new Date(), privacyModeById: 'u1', privacyModeNote: 'week-end' });

    const state = await service.setPrivacyMode('v1', { enabled: true, reason: 'week-end' }, ACTOR);

    expect(state.enabled).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(systemActivity.record).toHaveBeenCalledTimes(1);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'PRIVACY', action: 'privacy_enabled' });
  });

  it('libellé d\'acteur « conducteur » quand la bascule vient d\'un DRIVER', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique
      .mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', privacyModeEnabled: false })
      .mockResolvedValueOnce({ id: 'v1', privacyModeEnabled: true, privacyModeSince: new Date(), privacyModeById: 'u1', privacyModeNote: null });

    await service.setPrivacyMode('v1', { enabled: true }, { userId: 'u1', role: UserRole.DRIVER, fleetId: 'f1' });

    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ actor: 'conducteur' });
  });

  it('cross-fleet (anti-IDOR) : un non-super d\'une AUTRE flotte → 404, aucune bascule ni journal', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce({ id: 'v1', fleetId: 'f1', plate: 'AB-123-CD', privacyModeEnabled: false });

    await expect(
      service.setPrivacyMode('v1', { enabled: true }, { userId: 'intrus', role: UserRole.VIEWER, fleetId: 'AUTRE' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  it('véhicule inconnu → 404', async () => {
    const { service, prisma } = makeService();
    prisma.vehicle.findUnique.mockResolvedValueOnce(null);
    await expect(service.setPrivacyMode('nope', { enabled: true }, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });
});
