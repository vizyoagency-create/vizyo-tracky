/**
 * Lot V5 — le réglage des alertes de vitesse : qui peut lire et écrire quoi, et ce qui
 * est écrit.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { SpeedAlertSettingsService } from './speed-alert-settings.service';

const FLEET = '00000000-0000-0000-0000-00000000000f';
const AUTRE = '00000000-0000-0000-0000-0000000000aa';

const superAdmin = { id: 'sa', email: 'sa@vizyo', role: UserRole.SUPER_ADMIN, fleetId: null } as unknown as AuthUser;
const fleetAdmin = { id: 'fa', email: 'fa@client', role: UserRole.FLEET_ADMIN, fleetId: FLEET } as unknown as AuthUser;

const fleetRow = (patch: Record<string, unknown> = {}) => ({
  id: FLEET, name: 'MH Cars',
  speedAlertEnabled: false, speedAlertOverKmh: 20, speedAlertAbsoluteKmh: 130,
  speedAlertUpdatedAt: null, speedAlertUpdatedById: null,
  ...patch,
});

describe('SpeedAlertSettingsService', () => {
  let service: SpeedAlertSettingsService;
  let prisma: {
    fleet: { findUnique: jest.Mock; update: jest.Mock };
    vehicle: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue(fleetRow()), update: jest.fn().mockResolvedValue({}) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Youness', lastName: 'H.', email: 'y@vizyo' }) },
    };
    const module = await Test.createTestingModule({
      providers: [SpeedAlertSettingsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(SpeedAlertSettingsService);
  });

  describe('périmètre', () => {
    it('un super-admin doit désigner une société', async () => {
      await expect(service.get(superAdmin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.get(superAdmin, FLEET)).resolves.toMatchObject({ fleetId: FLEET, enabled: false, overKmh: 20 });
    });

    it('un administrateur de flotte ne règle que la sienne', async () => {
      await expect(service.get(fleetAdmin, AUTRE)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.get(fleetAdmin)).resolves.toMatchObject({ fleetId: FLEET });
      await expect(service.get({ ...fleetAdmin, fleetId: null } as AuthUser)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('écriture', () => {
    it('écrit le réglage avec son auteur et sa date, et rend l’auteur nommé', async () => {
      prisma.fleet.findUnique.mockResolvedValue(fleetRow({ speedAlertEnabled: true, speedAlertOverKmh: 30, speedAlertAbsoluteKmh: null, speedAlertUpdatedAt: new Date('2026-09-03T10:00:00Z'), speedAlertUpdatedById: 'sa' }));

      const dto = await service.set(superAdmin, { enabled: true, overKmh: 30, absoluteKmh: null }, FLEET);

      expect(prisma.fleet.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: FLEET },
        data: expect.objectContaining({ speedAlertEnabled: true, speedAlertOverKmh: 30, speedAlertAbsoluteKmh: null, speedAlertUpdatedById: 'sa' }),
      }));
      expect(dto).toMatchObject({ enabled: true, overKmh: 30, absoluteKmh: null, updatedBy: 'Youness H.', updatedAt: '2026-09-03T10:00:00.000Z' });
    });

    it('liste les véhicules qui dérogent', async () => {
      prisma.vehicle.findMany.mockResolvedValue([{ id: 'v1', plate: 'AA-111-AA', speedAlertEnabled: false, speedAlertOverKmh: null }]);
      const dto = await service.get(fleetAdmin);
      expect(dto.vehicles).toEqual([{ vehicleId: 'v1', plate: 'AA-111-AA', enabled: false, overKmh: null }]);
      // La requête ne demande QUE les dérogations, pas tout le parc.
      expect(prisma.vehicle.findMany.mock.calls[0][0].where).toMatchObject({ fleetId: FLEET });
    });

    it('refuse une dérogation sur un véhicule hors société — en 404, sans rien révéler', async () => {
      await expect(service.setVehicle(fleetAdmin, 'v-ailleurs', { enabled: true, overKmh: null })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    });

    it('écrit la dérogation ET date le réglage de la société', async () => {
      prisma.vehicle.findFirst.mockResolvedValue({ id: 'v1', plate: 'AA-111-AA' });
      await service.setVehicle(fleetAdmin, 'v1', { enabled: null, overKmh: 40 });

      expect(prisma.vehicle.findFirst.mock.calls[0][0].where).toEqual({ id: 'v1', fleetId: FLEET });
      expect(prisma.vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { speedAlertEnabled: null, speedAlertOverKmh: 40 } });
      expect(prisma.fleet.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ speedAlertUpdatedById: 'fa' }) }));
    });
  });
});
