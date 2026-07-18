import { Module } from '@nestjs/common';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingSettingsService } from './billing-settings.service';
import { StripeService } from './stripe.service';

/**
 * Facturation (2026-07) — option IA payante (Stripe). Dépend de services GLOBAUX (Prisma, Email,
 * ErrorLogger, AiAvailabilityService via AiCoreModule @Global, ConfigService). Si `STRIPE_SECRET_KEY`
 * est vide, le module tourne en no-op (aucun appel Stripe) et l'IA reste pilotée par le toggle owner.
 */
@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [StripeService, BillingSettingsService, BillingService],
  exports: [BillingService, BillingSettingsService],
})
export class BillingModule {}
