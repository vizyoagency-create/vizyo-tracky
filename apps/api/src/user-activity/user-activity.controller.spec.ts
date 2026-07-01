import { UserActivityController } from './user-activity.controller';

describe('UserActivityController', () => {
  let controller: UserActivityController;
  let svc: { ingestBatch: jest.Mock };
  let errorLogger: { record: jest.Mock };

  const reqFor = (user: unknown, ua = 'jest-ua') =>
    ({ user, headers: { 'user-agent': ua } }) as any;

  beforeEach(() => {
    svc = { ingestBatch: jest.fn().mockResolvedValue(undefined) };
    errorLogger = { record: jest.fn().mockResolvedValue('id') };
    controller = new UserActivityController(svc as any, errorLogger as any, { getFeed: jest.fn() } as any);
  });

  it('reportError enregistre une erreur frontend enrichie (user/page/session/device)', async () => {
    const res = await controller.reportError(
      reqFor({ id: 'u1', email: 'sara@x.com', fleetId: 'f1' }),
      { message: 'TypeError: x', stack: 'at foo:1', route: '/map', sessionId: 'sess-1' },
    );

    expect(res).toEqual({ ok: true });
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    const [err, source, ctx, level] = errorLogger.record.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('TypeError: x');
    expect((err as Error).stack).toBe('at foo:1');
    expect(source).toBe('frontend');
    expect(level).toBe('ERROR');
    expect(ctx).toEqual(
      expect.objectContaining({
        userId: 'u1',
        userEmail: 'sara@x.com',
        fleetId: 'f1',
        page: '/map',
        sessionId: 'sess-1',
        userAgent: 'jest-ua',
      }),
    );
  });

  it('batch délègue au service avec le user-agent', async () => {
    await controller.batch(reqFor({ id: 'u1', fleetId: 'f1' }), { events: [] } as any);
    expect(svc.ingestBatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ events: [] }),
      expect.objectContaining({ userAgent: 'jest-ua' }),
    );
  });
});
