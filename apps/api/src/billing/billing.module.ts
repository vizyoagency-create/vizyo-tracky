import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingSettingsService } from './billing-settings.service';
import { FleetSubscriptionsService } from './fleet-subscriptions.service';
import { PricingGridService } from './pricing-grid.service';
import { PublicPricingController } from './public-pricing.controller';
import { StripeService } from './stripe.service';
import { SubscriptionsAdminController } from './subscriptions-admin.controller';

/**
 * Facturation (2026-07) — option IA payante (Stripe) + chantier commercial (D4/Phase 3) :
 * grille tarifaire publique en DB (PricingGridService, hydrate la LP) et abonnements clients
 * (FleetSubscriptionsService, espace admin « Abonnements & tarifs »). Dépend de services GLOBAUX
 * (Prisma, Email, ErrorLogger, SystemActivity, AiCoreModule @Global, ConfigService). Si
 * `STRIPE_SECRET_KEY` est vide, la partie Stripe tourne en no-op.
 */
@Module({
  imports: [AuthModule], // requis : les controllers billing sont gardés (JwtAuthGuard → AuthService)
  controllers: [BillingController, BillingWebhookController, SubscriptionsAdminController, PublicPricingController],
  providers: [StripeService, BillingSettingsService, BillingService, PricingGridService, FleetSubscriptionsService],
  exports: [BillingService, BillingSettingsService, PricingGridService, FleetSubscriptionsService],
})
export class BillingModule {}
