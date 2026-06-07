import { SmsWebhookController } from './sms-webhook.controller';

/**
 * Audit D4 — webhook SMS entrant fail-closed.
 * Sans secret configuré : en production on REJETTE (anti-forge), en dev on tolère.
 * Avec secret : signature invalide → rejet (logique HMAC existante, inchangée).
 */
function makeController(opts: { secret?: string; prod?: boolean } = {}) {
  const sms = { recordInbound: jest.fn().mockResolvedValue(undefined) };
  const errorLogger = { record: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (key: string) => {
      if (key === 'VIZYO_TEXTO_WEBHOOK_SECRET') return opts.secret;
      if (key === 'NODE_ENV') return opts.prod ? 'production' : 'development';
      return undefined;
    },
  };
  const ctrl = new SmsWebhookController(sms as never, config as never, errorLogger as never);
  return { ctrl, sms, errorLogger };
}

const reqNoRaw = { rawBody: undefined } as never;
const body = { from: '+33600000000', body: 'hello' };

describe('SmsWebhookController — D4 fail-closed', () => {
  it('production SANS secret → rejet, recordInbound non appelé', async () => {
    const { ctrl, sms } = makeController({ secret: undefined, prod: true });
    const res = await ctrl.handleInbound(reqNoRaw, undefined, undefined, body);
    expect(res).toEqual({ ok: false });
    expect(sms.recordInbound).not.toHaveBeenCalled();
  });

  it('dev SANS secret → toléré (no-op signature), recordInbound appelé', async () => {
    const { ctrl, sms } = makeController({ secret: undefined, prod: false });
    const res = await ctrl.handleInbound(reqNoRaw, undefined, undefined, body);
    expect(res).toEqual({ ok: true });
    expect(sms.recordInbound).toHaveBeenCalledTimes(1);
  });

  it('secret présent + signature invalide → rejet', async () => {
    const { ctrl, sms } = makeController({ secret: 's3cr3t', prod: true });
    // rawBody absent → verifySignature renvoie false quoi qu'il arrive.
    const res = await ctrl.handleInbound(reqNoRaw, 'deadbeef', '123', body);
    expect(res).toEqual({ ok: false });
    expect(sms.recordInbound).not.toHaveBeenCalled();
  });

  it('onModuleInit : prod sans secret → enregistre un CRITICAL (errorLogger)', () => {
    const { ctrl, errorLogger } = makeController({ secret: undefined, prod: true });
    ctrl.onModuleInit();
    expect(errorLogger.record).toHaveBeenCalled();
  });

  it('onModuleInit : prod avec secret → pas d alerte', () => {
    const { ctrl, errorLogger } = makeController({ secret: 's3cr3t', prod: true });
    ctrl.onModuleInit();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });
});
