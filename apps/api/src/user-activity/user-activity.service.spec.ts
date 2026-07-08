import { UserActivityService } from './user-activity.service';

function makePrisma() {
  const activitiesCreated: any[][] = [];
  const sessionUpdates: any[] = [];
  return {
    _activitiesCreated: activitiesCreated,
    _sessionUpdates: sessionUpdates,
    userSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({
        id: 'sess-1',
        currentRoute: null,
        status: 'ACTIVE',
        startedAt: new Date(),
        lastSeenAt: new Date(),
        ...data,
      })),
      update: jest.fn(async ({ data }: any) => {
        sessionUpdates.push(data);
        return {};
      }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    userActivity: {
      createMany: jest.fn(async ({ data }: any) => {
        activitiesCreated.push(data);
        return { count: data.length };
      }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    engineControlCommand: { findMany: jest.fn().mockResolvedValue([]) },
    // `user.findMany` sert (a) à résoudre les noms [] et (b) à lister les rôles ÉLEVÉS
    // (requête `where.OR`) → on renvoie 2 ids élevés SEULEMENT pour cette requête.
    user: {
      findMany: jest.fn(async (args: any) => (args?.where?.OR ? [{ id: 'super1' }, { id: 'owner1' }] : [])),
    },
  };
}

const USER = { id: 'u1', fleetId: 'f1', role: 'VIEWER' } as any;
// Owner plateforme — mock du service d'invisibilité (aucun owner en contexte de test).
const OWNER_VIS = { isMasked: () => false, getOwnerIds: async () => [], userIdExclusion: async () => ({}) } as any;

describe('UserActivityService', () => {
  it('crée une session + persiste les events + met à jour la présence', async () => {
    const prisma = makePrisma();
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(
      USER,
      {
        events: [
          { type: 'SESSION_START' },
          // Le HEARTBEAT porte la route COURANTE (source de currentRoute).
          { type: 'HEARTBEAT', route: '/map', status: 'ACTIVE' },
          // Le PAGE_VIEW porte la route QUITTÉE + sa durée (analytics).
          { type: 'PAGE_VIEW', route: '/dashboard', routeLabel: 'Tableau de bord', durationMs: 5000 },
        ],
        deviceType: 'desktop',
      },
      { userAgent: 'jest' },
    );

    expect(prisma.userSession.create).toHaveBeenCalledTimes(1);
    expect(prisma._activitiesCreated[0]).toHaveLength(3);
    const upd = prisma._sessionUpdates[0];
    expect(upd.currentRoute).toBe('/map');
    expect(upd.status).toBe('ACTIVE');
    expect(upd.endedAt).toBeUndefined();
  });

  it('positionne endedAt sur SESSION_END', async () => {
    const prisma = makePrisma();
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(USER, { events: [{ type: 'SESSION_END' }] });
    expect(prisma._sessionUpdates[0].endedAt).toBeInstanceOf(Date);
  });

  it('ignore les events de type inconnu (entrée non fiable)', async () => {
    const prisma = makePrisma();
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(USER, { events: [{ type: 'HACK' }] });
    expect(prisma.userSession.create).not.toHaveBeenCalled();
    expect(prisma.userActivity.createMany).not.toHaveBeenCalled();
  });

  it('réutilise une session ouverte récente au lieu d\'en créer une', async () => {
    const prisma = makePrisma();
    prisma.userSession.findFirst.mockResolvedValue({
      id: 'sess-existing',
      currentRoute: '/dashboard',
      status: 'ACTIVE',
      startedAt: new Date(),
      lastSeenAt: new Date(),
    });
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(USER, { events: [{ type: 'PAGE_VIEW', route: '/vehicles' }] });
    expect(prisma.userSession.create).not.toHaveBeenCalled();
    expect(prisma._activitiesCreated[0][0].sessionId).toBe('sess-existing');
  });

  it('getOnline mappe, résout le libellé et dédupe par utilisateur', async () => {
    const prisma = makePrisma();
    const now = Date.now();
    prisma.userSession.findMany.mockResolvedValue([
      {
        userId: 'u1',
        fleetId: 'f1',
        status: 'ACTIVE',
        currentRoute: '/map',
        deviceType: 'desktop',
        startedAt: new Date(now - 120_000),
        lastSeenAt: new Date(now - 5_000),
        user: { firstName: 'Amir', lastName: 'B', role: 'FLEET_ADMIN' },
      },
      {
        userId: 'u1', // même user, 2e onglet
        fleetId: 'f1',
        status: 'IDLE',
        currentRoute: '/vehicles',
        deviceType: 'mobile',
        startedAt: new Date(now),
        lastSeenAt: new Date(now),
        user: { firstName: 'Amir', lastName: 'B', role: 'FLEET_ADMIN' },
      },
    ]);
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    const online = await svc.getOnline();
    expect(online).toHaveLength(1);
    expect(online[0].name).toBe('Amir B');
    expect(online[0].currentRouteLabel).toBe('Carte live');
  });

  // ── Vue FLEET-ADMIN (scope) : bornée flotte + exclusion des rôles élevés ──────────────
  describe('scope fleet-admin', () => {
    it('getEngineCommands(scope) borne à la flotte via tracker→vehicle ET exclut les rôles élevés', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getEngineCommands({}, USER, { fleetId: 'f1' });
      const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
      expect(where.tracker).toEqual({ vehicle: { fleetId: 'f1' } });
      expect(where.requestedBy).toEqual({ notIn: ['super1', 'owner1'] });
    });

    it('getOnline(scope) filtre fleetId ET exclut les userId élevés', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getOnline(USER, { fleetId: 'f1' });
      const where = prisma.userSession.findMany.mock.calls[0][0].where;
      expect(where.fleetId).toBe('f1');
      expect(where.userId).toEqual({ notIn: ['super1', 'owner1'] });
    });

    it('getFeed(scope) ajoute le filtre flotte ET l\'exclusion des rôles élevés au AND', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getFeed({}, USER, { fleetId: 'f1' });
      const and = prisma.userActivity.findMany.mock.calls[0][0].where.AND;
      expect(and).toEqual(expect.arrayContaining([{ fleetId: 'f1' }]));
      expect(and).toEqual(expect.arrayContaining([{ userId: { notIn: ['super1', 'owner1'] } }]));
    });

    it('SANS scope (vue super-admin) : aucun filtre flotte ni exclusion de rôle ajouté', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getEngineCommands({}, { id: 'sa', role: 'SUPER_ADMIN' } as any);
      const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
      expect(where.tracker).toBeUndefined();
      // OWNER_VIS.isMasked = false en test → pas d'exclusion owner non plus.
      expect(where.requestedBy).toBeUndefined();
    });
  });
});
