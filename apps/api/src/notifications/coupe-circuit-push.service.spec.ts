import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CoupeCircuitPushService } from './coupe-circuit-push.service';
import { NotificationDispatchService } from './notification-dispatch.service';

/**
 * 16/09/2026 — la nuit du 15 au 16, l'interlock a retenu 24 coupes (preuve SMS > 24 h) et l'a
 * écrit toutes les 15 min sans que personne ne soit averti. Ce service est le chaînon manquant :
 * l'événement `coupe-circuit.push` devient une notification aux super-admins, par le socle.
 */
describe('CoupeCircuitPushService', () => {
  let service: CoupeCircuitPushService;
  let findMany: jest.Mock;
  let notifyUsers: jest.Mock;

  beforeEach(async () => {
    findMany = jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);
    notifyUsers = jest.fn().mockResolvedValue(2);
    const module = await Test.createTestingModule({
      providers: [
        CoupeCircuitPushService,
        { provide: PrismaService, useValue: { user: { findMany } } },
        { provide: NotificationDispatchService, useValue: { notifyUsers } },
      ],
    }).compile();
    service = module.get(CoupeCircuitPushService);
  });

  it('pousse aux super-admins ACTIFS, en catégorie SYSTEM, cloisonné par sujet, vers le centre d alerte', async () => {
    const n = await service.prevenir({
      kind: 'coupe-retenue',
      subjectKey: 'interlock|preuve trop ancienne',
      title: 'Coupes automatiques retenues',
      body: '24 refus',
    });
    expect(n).toBe(2);
    expect(findMany).toHaveBeenCalledWith({ where: { role: UserRole.SUPER_ADMIN, isActive: true }, select: { id: true } });
    expect(notifyUsers).toHaveBeenCalledWith({
      userIds: ['admin-1', 'admin-2'],
      category: 'SYSTEM',
      kind: 'coupe-retenue',
      subjectKey: 'interlock|preuve trop ancienne',
      title: 'Coupes automatiques retenues',
      body: '24 refus',
      url: '/admin/alerts',
    });
  });

  it('sans super-admin actif : rien à pousser, 0', async () => {
    findMany.mockResolvedValue([]);
    expect(await service.prevenir({ kind: 'preuve-sms', subjectKey: 'x', title: 't', body: 'b' })).toBe(0);
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it('un socle en panne ne lève jamais — la ligne du centre d alerte est déjà écrite', async () => {
    notifyUsers.mockRejectedValue(new Error('push indisponible'));
    await expect(service.prevenir({ kind: 'passerelle-sms', subjectKey: 'passerelle', title: 't', body: 'b' })).resolves.toBe(0);
  });

  it('respecte une url explicite', async () => {
    await service.prevenir({ kind: 'restore-non-prouvee', subjectKey: 'cmd-1', title: 't', body: 'b', url: '/vehicles/v1' });
    expect(notifyUsers).toHaveBeenCalledWith(expect.objectContaining({ url: '/vehicles/v1' }));
  });
});
