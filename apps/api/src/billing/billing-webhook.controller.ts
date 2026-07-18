import { Controller, Headers, HttpCode, HttpStatus, Logger, OnModuleInit, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type Stripe from 'stripe';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';

/**
 * Webhook ENTRANT depuis Stripe (cycle de vie des abonnements → synchro `Fleet.aiEnabled`).
 * PUBLIC mais authentifié par SIGNATURE (`stripe-signature`), fail-closed : en prod sans
 * `STRIPE_WEBHOOK_SECRET`, on rejette tout. Utilise le rawBody (NestFactory `rawBody: true`).
 * Config Stripe : dashboard → Webhooks → `https://<domaine>/api/billing/webhook`,
 * events customer.subscription.created/updated/deleted.
 */
@Controller('billing')
export class BillingWebhookController implements OnModuleInit {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly stripe: StripeService,
    private readonly billing: BillingService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  private get isProd(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }

  onModuleInit(): void {
    if (this.isProd && this.stripe.isConfigured() && !this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true })) {
      this.logger.error('CRITICAL: STRIPE_WEBHOOK_SECRET non configuré en production — /billing/webhook rejette tout (fail-closed).');
      this.errorLogger
        .record('STRIPE_WEBHOOK_SECRET manquant en production (webhook billing fail-closed)', 'billing-webhook', { phase: 'boot' })
        .catch(() => undefined);
    }
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ ok: boolean }> {
    const secret = this.config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
    if (!secret) {
      if (this.isProd) {
        this.logger.error('Webhook Stripe : secret absent en production — rejet (fail-closed)');
        return { ok: false };
      }
      this.logger.warn('Webhook Stripe : pas de secret (dev) — signature non vérifiée, event ignoré');
      return { ok: true };
    }
    if (!req.rawBody || !signature) return { ok: false };

    let event: Stripe.Event;
    try {
      event = this.stripe.constructWebhookEvent(req.rawBody, signature, secret);
    } catch (e) {
      this.logger.warn(`Webhook Stripe : signature invalide — ${(e as Error)?.message ?? e}`);
      return { ok: false };
    }

    try {
      await this.billing.handleWebhook(event);
    } catch (e) {
      // On répond 200 quand même (sinon Stripe retente en boucle) mais on trace l'échec.
      this.logger.error(`Webhook Stripe handler échec (${event.type}) : ${String(e)}`);
      this.errorLogger.record(e as Error, 'billing-webhook', { type: event.type }).catch(() => undefined);
    }
    return { ok: true };
  }
}
