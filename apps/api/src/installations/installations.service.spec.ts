import { BadRequestException } from '@nestjs/common';
import { InstallationsService } from './installations.service';

/**
 * Lot A (RDV v2) : une pose créée à la validation d'une réservation peut n'avoir pas de plaque
 * (« À confirmer »). On ne provisionne jamais un véhicule sous cette plaque : la vraie est exigée
 * au moment de valider la pose — mais SAUTER la pose (véhicule absent) reste permis.
 */
function service(plate: string) {
  const prisma = {
    installationPlan: { findUnique: jest.fn().mockResolvedValue({ id: 'plan-1', status: 'DRAFT', tasks: [] }) },
    installationTask: {
      findFirst: jest.fn().mockResolvedValue({ id: 't1', planId: 'plan-1', plate, installedAt: null, status: 'PENDING' }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 't1', planId: 'plan-1', orderIndex: 0, scheduledDate: null, plate, brand: null, model: null, energy: null,
        status: 'SKIPPED', installedAt: null, imei: '123456789012345', simNumber: null, fieldNotes: null,
        vehicleId: null, trackerId: null, bookingId: null, createdAt: new Date(), updatedAt: new Date(),
      }),
    },
  };
  const svc = new InstallationsService(prisma as never, { emit: jest.fn() } as never);
  return { svc, prisma };
}

describe('InstallationsService.completeTask — la plaque « À confirmer »', () => {
  it('refuse de VALIDER la pose tant que la plaque est « À confirmer » : rien n’est écrit', async () => {
    const { svc, prisma } = service('À confirmer');
    await expect(svc.completeTask('plan-1', 't1', { imei: '123456789012345' }))
      .rejects.toThrow(/plaque/);
    expect(prisma.installationTask.update).not.toHaveBeenCalled();
  });

  it('un IMEI invalide est refusé avant même la plaque', async () => {
    const { svc } = service('À confirmer');
    await expect(svc.completeTask('plan-1', 't1', { imei: '12' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SAUTER la pose reste possible sans plaque (le véhicule n’est pas venu)', async () => {
    const { svc, prisma } = service('À confirmer');
    await svc.completeTask('plan-1', 't1', { imei: '123456789012345', status: 'SKIPPED' });
    expect(prisma.installationTask.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'SKIPPED' }),
    }));
  });
});
