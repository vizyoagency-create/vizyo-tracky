import { ForbiddenException } from '@nestjs/common';
import { EngineAction, UserRole } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { EngineControlController } from './engine-control.controller';

describe('EngineControlController — droit conditionnel de sortie du planning', () => {
  const user = {
    id: 'user-1', authUserId: 'auth-1', email: 'test@example.test', firstName: null,
    lastName: null, role: UserRole.FLEET_MANAGER, isOwner: false, fleetId: 'fleet-1',
    isActive: true, permissions: null,
  };
  const request = { user } as unknown as AuthenticatedRequest;
  let engineControl: { requestCommand: jest.Mock };
  let permissions: { canOnVehicle: jest.Mock };
  let prisma: { tracker: { findUnique: jest.Mock } };
  let controller: EngineControlController;

  beforeEach(() => {
    engineControl = { requestCommand: jest.fn().mockResolvedValue({ id: 'command-1' }) };
    permissions = { canOnVehicle: jest.fn() };
    prisma = { tracker: { findUnique: jest.fn().mockResolvedValue({ vehicle: { id: 'vehicle-1' } }) } };
    controller = new EngineControlController(engineControl as never, permissions as never, prisma as never);
  });

  it('une CUT normale conserve le planning sans demander schedules_manage', async () => {
    await controller.requestCommand('tracker-1', { action: EngineAction.CUT }, request);
    expect(permissions.canOnVehicle).not.toHaveBeenCalled();
    expect(engineControl.requestCommand).toHaveBeenCalledWith(
      'tracker-1', EngineAction.CUT, null,
      { userId: 'user-1', role: UserRole.FLEET_MANAGER, fleetId: 'fleet-1' },
      'MANUAL', undefined, false, undefined,
    );
  });

  it('refuse disableSchedule au rôle qui ne peut pas gérer les horaires', async () => {
    permissions.canOnVehicle.mockResolvedValue(false);
    await expect(controller.requestCommand(
      'tracker-1', { action: EngineAction.CUT, disableSchedule: true }, request,
    )).rejects.toThrow(ForbiddenException);
    expect(engineControl.requestCommand).not.toHaveBeenCalled();
  });

  it('accepte l’immobilisation durable avec schedules_manage', async () => {
    permissions.canOnVehicle.mockResolvedValue(true);
    await controller.requestCommand(
      'tracker-1', { action: EngineAction.CUT, disableSchedule: true }, request,
    );
    expect(permissions.canOnVehicle).toHaveBeenCalledWith(user, 'vehicle-1', 'schedules_manage');
    expect(engineControl.requestCommand).toHaveBeenCalledWith(
      'tracker-1', EngineAction.CUT, null,
      { userId: 'user-1', role: UserRole.FLEET_MANAGER, fleetId: 'fleet-1' },
      'MANUAL', true, false, undefined,
    );
  });

  it('refuse disableSchedule sur RESTORE même avec le droit horaires', async () => {
    permissions.canOnVehicle.mockResolvedValue(true);
    await expect(controller.requestCommand(
      'tracker-1', { action: EngineAction.RESTORE, disableSchedule: true }, request,
    )).rejects.toThrow('disableSchedule est réservé à une coupure durable');
    expect(permissions.canOnVehicle).not.toHaveBeenCalled();
    expect(engineControl.requestCommand).not.toHaveBeenCalled();
  });
});
