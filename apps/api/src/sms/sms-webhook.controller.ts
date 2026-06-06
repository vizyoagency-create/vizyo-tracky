import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';

/**
 * V1.14 — Webhook ENTRANT depuis vizyo-texto (remplace l'ancien webhook Twilio).
 *
 * Le relay vizyo-texto recoit les SMS captes par le S21 (capcom6 -> relay), les
 * route vers le tenant via l'expediteur, puis les POST ici. Signe en
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`) avec les headers X-Vizyo-Signature
 * + X-Vizyo-Timestamp. secret = VIZYO_TEXTO_WEBHOOK_SECRET (= webhookSecret du
 * tenant tracky cote relay).
 *
 * Cote relay, definir le callbackUrl du tenant tracky :
 *   PATCH /admin/tenants/<id>  { "callbackUrl": "https://<domaine>/api/sms/webhook" }
 * Et cote app S21 (capcom6) : webhook sms:received -> https://texto.../internal/capcom6/webhook
 * avec Signing Key = CAPCOM6_WEBHOOK_SECRET.
 */
@Controller('sms')
export class SmsWebhookController {
  private readonly logger = new Logger(SmsWebhookController.name);

  constructor(
    private readonly sms: SmsGatewayService,
    private readonly config: ConfigService<Env, true>,
    private readonly errorLogger: ErrorLogger,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleInbound(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-vizyo-signature') signature: string | undefined,
    @Headers('x-vizyo-timestamp') timestamp: string | undefined,
    @Body()
    body: {
      from?: string;
      to?: string;
      body?: string;
      receivedAt?: string;
      providerId?: string;
    },
  ): Promise<{ ok: boolean }> {
    const secret = this.config.get('VIZYO_TEXTO_WEBHOOK_SECRET', { infer: true });

    // Valide la signature si un secret est configure (sinon dev / no-op).
    if (secret) {
      if (!this.verifySignature(req.rawBody, signature, timestamp, secret)) {
        this.logger.warn('Webhook vizyo-texto : signature invalide, rejet');
        // A4 — persiste le rejet dans ErrorLog pour visibilite.
        this.errorLogger.record(
          'Webhook vizyo-texto: signature HMAC invalide',
          'sms-webhook',
          { from: body?.from, timestamp, bodyPreview: body?.body?.slice(0, 80) },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return { ok: false };
      }
    }

    if (!body?.from || !body?.body) {
      // A5 — body incomplet : persiste le rejet dans ErrorLog.
      this.errorLogger.record(
        'Webhook vizyo-texto: body incomplet (from ou body manquant)',
        'sms-webhook',
        { bodyKeys: Object.keys(body ?? {}) },
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
      return { ok: false };
    }

    await this.sms.recordInbound({
      fromNumber: body.from,
      toNumber: body.to ?? '',
      body: body.body,
      twilioSid: body.providerId,
    });
    this.logger.debug(`Inbound SMS (vizyo-texto) de ${body.from}: ${body.body}`);
    return { ok: true };
  }

  /** HMAC-SHA256(secret, `${ts}.${rawBody}`) hex + anti-replay 5 min, timing-safe. */
  private verifySignature(
    raw: Buffer | undefined,
    signature: string | undefined,
    timestamp: string | undefined,
    secret: string,
  ): boolean {
    if (!raw || !signature || !timestamp) return false;
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
      return false;
    }
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${raw.toString('utf8')}`)
      .digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }
}
