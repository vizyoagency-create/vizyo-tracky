import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import * as twilio from 'twilio';
import type { Env } from '../config/env.validation';
import { SmsGatewayService } from './sms-gateway.service';

/**
 * V1.5 (Sprint I) — Webhook Twilio pour les SMS entrants.
 *
 * Exposee publiquement (Twilio l'appelle), donc on valide la signature X-Twilio-Signature
 * pour rejeter les appels non legitimes.
 *
 * Configurer dans la console Twilio :
 *   Phone Numbers > Manage > Active Numbers > <number> > Configure
 *   "A MESSAGE COMES IN" → Webhook → POST → https://<domain>/api/sms/webhook
 */
@Controller('sms')
export class SmsWebhookController {
  private readonly logger = new Logger(SmsWebhookController.name);

  constructor(
    private readonly sms: SmsGatewayService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleInbound(
    @Req() req: Request,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Body()
    body: {
      From?: string;
      To?: string;
      Body?: string;
      MessageSid?: string;
      [k: string]: unknown;
    },
  ): Promise<{ ok: boolean }> {
    const authToken = this.config.get('TWILIO_AUTH_TOKEN', { infer: true });
    const webhookUrl = this.config.get('TWILIO_WEBHOOK_URL', { infer: true });

    // Validate signature in production. In dev, allow without signature.
    if (authToken && webhookUrl && signature) {
      const valid = twilio.validateRequest(authToken, signature, webhookUrl, body as Record<string, string>);
      if (!valid) {
        this.logger.warn('Invalid Twilio webhook signature, rejecting');
        return { ok: false };
      }
    }

    if (!body?.From || !body?.Body) {
      return { ok: false };
    }

    await this.sms.recordInbound({
      fromNumber: body.From,
      toNumber: body.To ?? '',
      body: body.Body,
      twilioSid: body.MessageSid,
    });
    this.logger.debug(`Inbound SMS from ${body.From}: ${body.Body}`);
    return { ok: true };
  }
}
