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
  let vehicleAccess: { getAccessibleVehicleIds: jest.Mock };
  let controller: EngineControlController;

  beforeEach(() => {
    engineControl = { requestCommand: jest.fn().mockResolvedValue({ id: 'command-1' }) };
    permissions = { canOnVehicle: jest.fn() };
    prisma = { tracker: { findUnique: jest.fn().mockResolvedValue({ vehicle: { id: 'vehicle-1' } }) } };
    vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') };
    controller = new EngineControlController(engineControl as never, permissions as never, prisma as never, vehicleAccess as never);
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

/**
 * ══ C7 — LE VEILLEUR EST ADMIS SUR L'HISTORIQUE DES COMMANDES ════════════════════════════════
 *
 * Il en était exclu : 232 `403` sur le seul créneau 01h52 → 03h02 la nuit du 24/09, et son bouton
 * se retrouvait sans autre source d'état que le WebSocket — coupé quatre fois cette nuit-là.
 *
 * Ouvrir une route, c'est déplacer une frontière. Ces cas fixent les deux choses qui doivent
 * rester vraies après l'ouverture : le rôle passe, ET son périmètre est calculé puis transmis.
 */
describe('C7 — EngineControlController.listCommands : ouverture au veilleur, périmètre transmis', () => {
  const faireControleur = (role: UserRole, acces: string[] | 'ALL') => {
    const engineControl = { listCommands: jest.fn().mockResolvedValue([]) };
    const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue(acces) };
    const controller = new EngineControlController(
      engineControl as never, { canOnVehicle: jest.fn() } as never, {} as never, vehicleAccess as never,
    );
    const req = {
      user: { id: 'u1', role, fleetId: 'fleet-1' },
    } as unknown as AuthenticatedRequest;
    return { controller, engineControl, vehicleAccess, req };
  };

  it('🔴 le rôle VEILLEUR est déclaré sur la route — c’est la cause de fond de l’incident', () => {
    const roles = Reflect.getMetadata('roles', EngineControlController.prototype.listCommands) as UserRole[];
    expect(roles).toContain(UserRole.NIGHT_WATCHMAN);
  });

  it('🔴 le périmètre véhicules est CALCULÉ puis TRANSMIS — sans quoi le cloisonnement du service est inerte', async () => {
    const { controller, engineControl, vehicleAccess, req } = faireControleur(UserRole.NIGHT_WATCHMAN, ['v1', 'v2']);
    await controller.listCommands(req, 'tracker-1');
    expect(vehicleAccess.getAccessibleVehicleIds).toHaveBeenCalledWith(req.user);
    expect(engineControl.listCommands).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1', role: UserRole.NIGHT_WATCHMAN, fleetId: 'fleet-1',
        accessibleVehicleIds: ['v1', 'v2'],
      }),
      expect.objectContaining({ trackerId: 'tracker-1' }),
    );
  });

  it('un utilisateur non restreint transmet « ALL » — la borne existe, elle ne mord simplement pas', async () => {
    const { controller, engineControl, req } = faireControleur(UserRole.FLEET_ADMIN, 'ALL');
    await controller.listCommands(req);
    expect(engineControl.listCommands).toHaveBeenCalledWith(
      expect.objectContaining({ accessibleVehicleIds: 'ALL' }),
      expect.anything(),
    );
  });
});
