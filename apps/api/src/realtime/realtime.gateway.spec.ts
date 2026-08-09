import { RealtimeGateway } from './realtime.gateway';

/**
 * #13 — revalidation periodique : un user suspendu/supprime ne doit plus recevoir
 * le live apres le handshake. On teste la logique de revalidateConnections en
 * injectant un faux namespace `server.sockets` + un prisma mocke.
 */
describe('RealtimeGateway — revalidation #13', () => {
  function makeSocket(id: string, userId: string | undefined) {
    return { id, data: { userId }, disconnect: jest.fn() };
  }

  it('deconnecte les sockets des users inactifs/supprimes, garde les actifs', async () => {
    const sActive = makeSocket('s1', 'user-active');
    const sSuspended = makeSocket('s2', 'user-suspended');
    const sDeleted = makeSocket('s3', 'user-deleted');
    const sNoUser = makeSocket('s4', undefined);

    const prisma = {
      // Seul user-active ressort comme isActive=true.
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'user-active' }]) },
    };
    const gateway = new RealtimeGateway({} as never, prisma as never, { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never, { activeMissionIds: jest.fn().mockResolvedValue([]) } as never);
    (gateway as unknown as { server: unknown }).server = {
      sockets: new Map([
        ['s1', sActive],
        ['s2', sSuspended],
        ['s3', sDeleted],
        ['s4', sNoUser],
      ]),
    };

    await gateway.revalidateConnections();

    expect(sActive.disconnect).not.toHaveBeenCalled();
    expect(sSuspended.disconnect).toHaveBeenCalled();
    expect(sDeleted.disconnect).toHaveBeenCalled();
    expect(sNoUser.disconnect).not.toHaveBeenCalled(); // pas d'userId -> ignore
    // La requete ne porte que sur les userIds connectes et filtre isActive=true.
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }),
    );
  });

  it('no-op quand aucune socket connectee', async () => {
    const prisma = { user: { findMany: jest.fn() } };
    const gateway = new RealtimeGateway({} as never, prisma as never, { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never, { activeMissionIds: jest.fn().mockResolvedValue([]) } as never);
    (gateway as unknown as { server: unknown }).server = { sockets: new Map() };
    await gateway.revalidateConnections();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
