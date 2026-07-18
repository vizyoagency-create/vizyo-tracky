import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation';

/**
 * Wrapper mince du SDK Stripe. Init PARESSEUX : si `STRIPE_SECRET_KEY` est vide, le module billing
 * est en mode no-op (`isConfigured()` = false) et l'app tourne sans facturation (l'IA reste pilotée
 * par le toggle super-admin « offert »). Ne lève jamais à l'init. La logique métier (statuts,
 * synchro `Fleet.aiEnabled`, e-mails) vit dans `BillingService` ; ici uniquement les appels Stripe.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: Stripe | null;
  private readonly publishableKey: string;
  /** Produit Stripe unique « Option IA Tracky » (créé à la 1re souscription, mis en cache process). */
  private cachedProductId: string | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {
    const key = this.config.get('STRIPE_SECRET_KEY', { infer: true }) ?? '';
    this.publishableKey = this.config.get('STRIPE_PUBLISHABLE_KEY', { infer: true }) ?? '';
    this.client = key ? new Stripe(key) : null;
    if (!this.client) this.logger.warn('Stripe non configuré (STRIPE_SECRET_KEY vide) — billing en mode no-op.');
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getPublishableKey(): string {
    return this.publishableKey;
  }

  private require(): Stripe {
    if (!this.client) throw new ServiceUnavailableException('Facturation non configurée côté serveur.');
    return this.client;
  }

  /** Réutilise `existingCustomerId` sinon crée un client Stripe pour la société. Renvoie l'id. */
  async ensureCustomer(params: { fleetId: string; name: string; existingCustomerId?: string | null; email?: string | null }): Promise<string> {
    if (params.existingCustomerId) return params.existingCustomerId;
    const c = await this.require().customers.create({
      name: params.name,
      email: params.email ?? undefined,
      metadata: { fleetId: params.fleetId },
    });
    return c.id;
  }

  /** SetupIntent pour enregistrer une carte hors-session (facturation récurrente). */
  async createSetupIntent(customerId: string): Promise<string> {
    const si = await this.require().setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });
    if (!si.client_secret) throw new ServiceUnavailableException('SetupIntent sans client_secret.');
    return si.client_secret;
  }

  /** Carte par défaut (ou 1re carte) du client, pour l'affichage (jamais le PAN complet). */
  async getDefaultCard(customerId: string): Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null> {
    const stripe = this.require();
    const cust = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] });
    if (cust.deleted) return null;
    let pm = (cust.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null) ?? null;
    if (!pm || typeof pm === 'string') {
      const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      pm = list.data[0] ?? null;
    }
    if (!pm?.card) return null;
    return { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
  }

  /** Fixe la carte comme moyen de paiement par défaut (après un SetupIntent confirmé côté front). */
  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.require().customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  /** Le client a-t-il au moins une carte enregistrée ? (pré-requis pour s'abonner par carte.) */
  async hasPaymentMethod(customerId: string): Promise<boolean> {
    const list = await this.require().paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    return list.data.length > 0;
  }

  /** Produit Stripe unique réutilisé (évite d'en créer un par abonnement). */
  private async ensureProduct(): Promise<string> {
    if (this.cachedProductId) return this.cachedProductId;
    const stripe = this.require();
    const found = await stripe.products
      .search({ query: `active:'true' AND metadata['tracky_key']:'ai_option'`, limit: 1 })
      .catch(() => null);
    const id = found?.data?.[0]?.id
      ?? (await stripe.products.create({ name: 'Option IA Tracky', metadata: { tracky_key: 'ai_option' } })).id;
    this.cachedProductId = id;
    return id;
  }

  /** Crée l'abonnement mensuel (prix inline). Confirme immédiatement sur la carte par défaut. */
  async createSubscription(params: {
    customerId: string; unitAmountCents: number; quantity: number; currency: string; fleetId: string;
  }): Promise<Stripe.Subscription> {
    const product = await this.ensureProduct();
    return this.require().subscriptions.create({
      customer: params.customerId,
      items: [{
        price_data: {
          currency: params.currency,
          product,
          unit_amount: params.unitAmountCents,
          recurring: { interval: 'month' },
        },
        quantity: Math.max(1, params.quantity),
      }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { fleetId: params.fleetId },
    });
  }

  async cancelSubscription(subscriptionId: string, atPeriodEnd: boolean): Promise<Stripe.Subscription> {
    const stripe = this.require();
    return atPeriodEnd
      ? stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
      : stripe.subscriptions.cancel(subscriptionId);
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.require().subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice.payment_intent'] });
  }

  /** Vérifie la signature d'un event webhook (fail-closed en amont si secret absent). */
  constructWebhookEvent(payload: Buffer, signature: string, secret: string): Stripe.Event {
    return this.require().webhooks.constructEvent(payload, signature, secret);
  }
}
