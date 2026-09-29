import { SystemActivityService } from './system-activity.service';

/**
 * Fil admin du journal système (`GET /api/admin/activity/system`) — 29/09 : filtres optionnels
 * société (`fleetId`) et période (`from`/`to`), sans perdre la règle « owner caché aux autres
 * super-admins » ni le cursor composite.
 */
const FLEET_A = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '99999999-9999-4999-8999-999999999999';
const ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function make(opts: { ownerIds?: string[] } = {}) {
  const prisma = {
    systemActivityLog: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    fleet: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const ownerIds = opts.ownerIds ?? [];
  // Mêmes règles que OwnerVisibilityService.nullableUserIdExclusion : un viewer owner voit tout.
  const ownerVis = {
    nullableUserIdExclusion: jest.fn(async (viewer: { isOwner?: boolean | null }, field: string) =>
      viewer?.isOwner || ownerIds.length === 0 ? {} : { OR: [{ [field]: null }, { [field]: { notIn: ownerIds } }] },
    ),
  };
  const svc = new SystemActivityService(prisma as any, ownerVis as any, { recordBackground: jest.fn() } as any);
  const where = () => prisma.systemActivityLog.findMany.mock.calls[0][0].where;
  return { svc, prisma, where };
}

describe('SystemActivityService.getFeed — filtres société et période', () => {
  it('fleetId : filtre sur la société de la ligne', async () => {
    const { svc, where } = make();
    await svc.getFeed({ fleetId: FLEET_A }, { isOwner: true });
    expect(where().AND).toEqual(expect.arrayContaining([{ fleetId: FLEET_A }]));
  });

  it('fleetId mal formé : liste VIDE, aucune requête (et surtout pas tout le journal)', async () => {
    const { svc, prisma } = make();
    const out = await svc.getFeed({ fleetId: 'pas-un-uuid' }, { isOwner: true });
    expect(out).toEqual([]);
    expect(prisma.systemActivityLog.findMany).not.toHaveBeenCalled();
  });

  it('période from/to : bornes gte / lte ; une date illisible est ignorée', async () => {
    const { svc, where } = make();
    await svc.getFeed({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-07T23:59:59.000Z' }, { isOwner: true });
    expect(where().AND).toEqual(
      expect.arrayContaining([
        { createdAt: { gte: new Date('2026-09-01T00:00:00.000Z') } },
        { createdAt: { lte: new Date('2026-09-07T23:59:59.000Z') } },
      ]),
    );

    const b = make();
    await b.svc.getFeed({ from: 'n-importe-quoi' }, { isOwner: true });
    expect(b.where()).toEqual({});
  });

  it('owner caché : un super-admin NON owner ne voit pas les gestes du propriétaire, filtre société compris', async () => {
    const { svc, where } = make({ ownerIds: [OWNER_ID] });
    await svc.getFeed({ fleetId: FLEET_A, from: '2026-09-01T00:00:00.000Z' }, { isOwner: false });
    const and = where().AND;
    expect(and).toEqual(expect.arrayContaining([{ fleetId: FLEET_A }]));
    expect(and).toEqual(
      expect.arrayContaining([{ OR: [{ triggeredByUserId: null }, { triggeredByUserId: { notIn: [OWNER_ID] } }] }]),
    );
  });

  it('le cursor composite et l exclusion owner coexistent (aucun OR n écrase l autre)', async () => {
    const { svc, where } = make({ ownerIds: [OWNER_ID] });
    const before = '2026-09-20T10:00:00.000Z';
    await svc.getFeed({ before, beforeId: ROW_ID, category: 'RESERVATION' }, { isOwner: false });
    const w = where();
    expect(w.OR).toBeUndefined();
    expect(w.AND).toEqual(
      expect.arrayContaining([
        { category: 'RESERVATION' },
        { OR: [{ createdAt: { lt: new Date(before) } }, { createdAt: new Date(before), id: { lt: ROW_ID } }] },
        { OR: [{ triggeredByUserId: null }, { triggeredByUserId: { notIn: [OWNER_ID] } }] },
      ]),
    );
  });

  it('beforeId mal formé : on pagine à la date seule (pas d erreur Prisma sur la colonne uuid)', async () => {
    const { svc, where } = make();
    const before = '2026-09-20T10:00:00.000Z';
    await svc.getFeed({ before, beforeId: '42' }, { isOwner: true });
    expect(where().AND).toEqual([{ createdAt: { lt: new Date(before) } }]);
  });

  it('sans filtre : where vide, comme avant', async () => {
    const { svc, where } = make();
    await svc.getFeed({}, { isOwner: true });
    expect(where()).toEqual({});
  });
});
