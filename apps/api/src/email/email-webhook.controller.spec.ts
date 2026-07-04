import { EmailWebhookController } from './email-webhook.controller';

/**
 * Webhook Resend — fail-closed (calqué sur sms-webhook.controller.spec) + mapping des
 * statuts + NON-régression (un `delivered` reçu après un `opened` ne réécrit pas OPENED).
 */
type ExistingLog = {
  status: string;
  openedAt: Date | null;
  clickedAt: Date | null;
  bouncedAt: Date | null;
};

function makeController(opts: { secret?: string; prod?: boolean; existing?: ExistingLog | null } = {}) {
  const errorLogger = { record: jest.fn().mockResolvedValue(undefined) };
  const update = jest.fn().mockResolvedValue(undefined);
  const findUnique = jest.fn().mockResolvedValue(opts.existing ?? null);
  const prisma = { emailLog: { findUnique, update } };
  const config = {
    get: (key: string) => {
      if (key === 'RESEND_WEBHOOK_SECRET') return opts.secret;
      if (key === 'NODE_ENV') return opts.prod ? 'production' : 'development';
      return undefined;
    },
  };
  const ctrl = new EmailWebhookController(config as never, prisma as never, errorLogger as never);
  return { ctrl, findUnique, update, errorLogger };
}

const reqNoRaw = { rawBody: undefined } as never;
const delivered = { type: 'email.delivered', data: { email_id: 're_1' } };

describe('EmailWebhookController — fail-closed + mapping des statuts', () => {
  it('production SANS secret → rejet, aucun traitement', async () => {
    const { ctrl, update } = makeController({ secret: undefined, prod: true });
    const res = await ctrl.handle(reqNoRaw, undefined, undefined, undefined, delivered);
    expect(res).toEqual({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('dev SANS secret → toléré, event appliqué', async () => {
    const { ctrl, update } = makeController({
      secret: undefined,
      prod: false,
      existing: { status: 'QUEUED', openedAt: null, clickedAt: null, bouncedAt: null },
    });
    const res = await ctrl.handle(reqNoRaw, undefined, undefined, undefined, delivered);
    expect(res).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerId: 're_1' },
        data: expect.objectContaining({ status: 'DELIVERED' }),
      }),
    );
  });

  it('secret présent + signature invalide (pas de rawBody) → rejet', async () => {
    const { ctrl, update } = makeController({ secret: 'whsec_dGVzdA==', prod: true });
    const res = await ctrl.handle(reqNoRaw, 'msg_1', '123', 'v1,deadbeef', delivered);
    expect(res).toEqual({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('NON-régression : delivered reçu après opened ne réécrit pas OPENED', async () => {
    const { ctrl, update } = makeController({
      secret: undefined,
      prod: false,
      existing: { status: 'OPENED', openedAt: new Date(), clickedAt: null, bouncedAt: null },
    });
    const res = await ctrl.handle(reqNoRaw, undefined, undefined, undefined, delivered);
    expect(res).toEqual({ ok: true });
    // Patch vide (statut non avancé, pas de timestamp à poser) → aucun update.
    expect(update).not.toHaveBeenCalled();
  });

  it('opened → statut OPENED + openedAt posé', async () => {
    const { ctrl, update } = makeController({
      secret: undefined,
      prod: false,
      existing: { status: 'DELIVERED', openedAt: null, clickedAt: null, bouncedAt: null },
    });
    await ctrl.handle(reqNoRaw, undefined, undefined, undefined, {
      type: 'email.opened',
      data: { email_id: 're_2' },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'OPENED', openedAt: expect.any(Date) }),
      }),
    );
  });

  it('bounced → statut BOUNCED + errorCode/message', async () => {
    const { ctrl, update } = makeController({
      secret: undefined,
      prod: false,
      existing: { status: 'QUEUED', openedAt: null, clickedAt: null, bouncedAt: null },
    });
    await ctrl.handle(reqNoRaw, undefined, undefined, undefined, {
      type: 'email.bounced',
      data: { email_id: 're_3', bounce: { type: 'Permanent', subType: 'General', message: 'mailbox not found' } },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'BOUNCED', errorCode: 'General', errorMessage: 'mailbox not found' }),
      }),
    );
  });

  it('event pour un providerId inconnu → pas d update (best-effort)', async () => {
    const { ctrl, update } = makeController({ secret: undefined, prod: false, existing: null });
    const res = await ctrl.handle(reqNoRaw, undefined, undefined, undefined, delivered);
    expect(res).toEqual({ ok: true });
    expect(update).not.toHaveBeenCalled();
  });

  it('onModuleInit : prod sans secret → enregistre un CRITICAL', () => {
    const { ctrl, errorLogger } = makeController({ secret: undefined, prod: true });
    ctrl.onModuleInit();
    expect(errorLogger.record).toHaveBeenCalled();
  });

  it('onModuleInit : prod avec secret → pas d alerte', () => {
    const { ctrl, errorLogger } = makeController({ secret: 'whsec_dGVzdA==', prod: true });
    ctrl.onModuleInit();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });
});
