import { SecurityService } from './security.service';

/**
 * Durcissement — la DÉSACTIVATION du 2FA exige un code e-mail frais (anti session
 * volée). Un cookie volé ne doit plus pouvoir couper la protection en silence.
 */
describe('SecurityService — désactivation 2FA sécurisée', () => {
  function build(verifyOk: boolean) {
    const prisma = { user: { update: jest.fn().mockResolvedValue({}) } } as any;
    const authClient = {
      sendLoginCode: jest.fn().mockResolvedValue({ code: '123456', expiresIn: 600 }),
      verifyLoginCode: jest.fn().mockResolvedValue({ ok: verifyOk }),
    } as any;
    const email = {
      buildTwoFactorDisableEmail: jest.fn().mockReturnValue({ subject: 's', html: 'h', text: 't' }),
      send: jest.fn().mockResolvedValue(undefined),
    } as any;
    const geoip = {} as any;
    const errorLogger = { record: jest.fn(), recordBackground: jest.fn() } as any;
    const systemActivity = { record: jest.fn() } as any;
    const svc = new SecurityService(prisma, authClient, email, geoip, errorLogger, systemActivity);
    return { svc, prisma, authClient, email, systemActivity };
  }

  it('REFUSE la désactivation si le code est invalide (2FA maintenu, rien de tracé)', async () => {
    const { svc, prisma, systemActivity } = build(false);
    const ok = await svc.disableTwoFactor({ id: 'u1', email: 'a@b.c' }, '000000');
    expect(ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled(); // le 2FA reste actif
    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  it('désactive ET trace quand le code est valide', async () => {
    const { svc, prisma, authClient, systemActivity } = build(true);
    const ok = await svc.disableTwoFactor({ id: 'u1', email: 'a@b.c' }, '123456');
    expect(ok).toBe(true);
    expect(authClient.verifyLoginCode).toHaveBeenCalledWith('a@b.c', '123456');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' }, data: { twoFactorEnabled: false } }),
    );
    expect(systemActivity.record).toHaveBeenCalledTimes(1);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({
      action: 'two_factor_disabled',
      triggeredByUserId: 'u1',
    });
  });

  it('sendDisableCode envoie l\'e-mail dédié (template two_factor_disable)', async () => {
    const { svc, authClient, email } = build(true);
    await svc.sendDisableCode({ email: 'a@b.c', firstName: 'Jean' });
    expect(authClient.sendLoginCode).toHaveBeenCalledWith('a@b.c');
    expect(email.buildTwoFactorDisableEmail).toHaveBeenCalled();
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.c', template: 'two_factor_disable' }),
    );
  });
});
