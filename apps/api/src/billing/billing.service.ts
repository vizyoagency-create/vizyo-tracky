import { BadRequestException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AiSubscriptionStatus, UserRole } from '@prisma/client';
import type Stripe from 'stripe';
import type { BillingStatusDto, BillingSetupIntentDto, BillingSubscribeResultDto } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { EmailService } from '../email/email.service';
import { StripeService } from './stripe.service';
import { BillingSettingsService } from './billing-settings.service';

/** Vue minimale de l'appelant (JWT) suffisante au périmètre/permissions billing. */
export interface BillingViewer {
  id: string;
  role: UserRole;
  fleetId: string | null;
}

const CONTACT_EMAIL = 'contact@vizyoagency.com';

/**
 * Facturation de l'option IA. Règles :
 * - DÉFAUT : tout le monde paie (abonnement mensuel Stripe, prix configurable).
 * - SUPER-ADMIN/OWNER : peut OFFRIR l'IA à une société (`COMP`, sans paiement) via son toggle.
 * - FLEET-ADMIN : active en s'abonnant (carte) OU en demandant une facture physique
 *   (→ e-mail à contact@vizyoagency.com, statut `INVOICE_PENDING`, activation manuelle owner).
 * L'abonnement est la SOURCE DE VÉRITÉ : il synchronise `Fleet.aiEnabled` (ACTIVE/COMP → ON).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly settings: BillingSettingsService,
    private readonly aiAvail: AiAvailabilityService,
    private readonly email: EmailService,
  ) {}

  // ── Périmètre ───────────────────────────────────────────────────────────────

  /** Flotte cible : super-admin peut viser `requested` ; fleet-admin est FORCÉ à la sienne. */
  private resolveFleet(viewer: BillingViewer, requested?: string): string {
    const isSuper = viewer.role === UserRole.SUPER_ADMIN;
    if (!isSuper && requested && requested !== viewer.fleetId) throw new ForbiddenException('Flotte hors périmètre.');
    const id = (isSuper ? requested : undefined) ?? viewer.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Flotte non déterminée.');
    return id;
  }

  private canManage(viewer: BillingViewer, fleetId: string): boolean {
    return viewer.role === UserRole.SUPER_ADMIN || (viewer.role === UserRole.FLEET_ADMIN && viewer.fleetId === fleetId);
  }

  // ── Tarification ──────────────────────────────────────────────────────────────

  private async billableVehicleCount(fleetId: string): Promise<number> {
    return this.prisma.vehicle.count({ where: { fleetId } });
  }

  private monthlyCents(unitCents: number, unit: string, qty: number): number {
    return unit === 'per_vehicle' ? unitCents * Math.max(1, qty) : unitCents;
  }

  // ── État ──────────────────────────────────────────────────────────────────────

  async getStatus(viewer: BillingViewer, requestedFleetId?: string): Promise<BillingStatusDto> {
    const fleetId = this.resolveFleet(viewer, requestedFleetId);
    const [fleet, sub, price, vehicleCount] = await Promise.all([
      this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { aiEnabled: true, stripeCustomerId: true } }),
      this.prisma.aiSubscription.findUnique({ where: { fleetId } }),
      this.settings.get(),
      this.billableVehicleCount(fleetId),
    ]);
    const status = sub?.status ?? AiSubscriptionStatus.NONE;
    const monthly = this.monthlyCents(price.aiUnitAmountEurCents, price.aiPricingUnit, vehicleCount);
    let card: BillingStatusDto['card'] = null;
    if (this.stripe.isConfigured() && fleet?.stripeCustomerId) {
      card = await this.stripe.getDefaultCard(fleet.stripeCustomerId).catch(() => null);
    }
    return {
      configured: this.stripe.isConfigured(),
      publishableKey: this.stripe.isConfigured() ? this.stripe.getPublishableKey() : null,
      status,
      card,
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      vehicleCount,
      pricingUnit: price.aiPricingUnit,
      unitAmountEurCents: price.aiUnitAmountEurCents,
      monthlyEurCents: monthly,
      perVehicleEurCents: Math.round(monthly / Math.max(1, vehicleCount)),
      currency: price.currency,
      aiEnabled: fleet?.aiEnabled ?? false,
      canManage: this.canManage(viewer, fleetId),
      isSuperAdmin: viewer.role === UserRole.SUPER_ADMIN,
    };
  }

  // ── Carte ───────────────────────────────────────────────────────────────────

  async createSetupIntent(viewer: BillingViewer, requestedFleetId?: string): Promise<BillingSetupIntentDto> {
    const fleetId = this.resolveFleet(viewer, requestedFleetId);
    if (!this.canManage(viewer, fleetId)) throw new ForbiddenException('Non autorisé.');
    if (!this.stripe.isConfigured()) throw new ServiceUnavailableException('Facturation non configurée.');
    const customerId = await this.ensureCustomer(fleetId);
    const clientSecret = await this.stripe.createSetupIntent(customerId);
    return { clientSecret, publishableKey: this.stripe.getPublishableKey() };
  }

  private async ensureCustomer(fleetId: string): Promise<string> {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true, stripeCustomerId: true } });
    if (!fleet) throw new BadRequestException('Flotte introuvable.');
    if (fleet.stripeCustomerId) return fleet.stripeCustomerId;
    const customerId = await this.stripe.ensureCustomer({ fleetId, name: fleet.name });
    await this.prisma.fleet.update({ where: { id: fleetId }, data: { stripeCustomerId: customerId } });
    return customerId;
  }

  // ── Abonnement (paiement carte) ──────────────────────────────────────────────

  async subscribe(viewer: BillingViewer, requestedFleetId?: string): Promise<BillingSubscribeResultDto> {
    const fleetId = this.resolveFleet(viewer, requestedFleetId);
    if (!this.canManage(viewer, fleetId)) throw new ForbiddenException('Non autorisé.');
    if (!this.stripe.isConfigured()) throw new ServiceUnavailableException('Facturation non configurée.');

    const existing = await this.prisma.aiSubscription.findUnique({ where: { fleetId } });
    if (existing?.status === AiSubscriptionStatus.ACTIVE || existing?.status === AiSubscriptionStatus.COMP) {
      throw new BadRequestException('IA déjà active pour cette société.');
    }
    const customerId = await this.ensureCustomer(fleetId);
    if (!(await this.stripe.hasPaymentMethod(customerId))) {
      throw new BadRequestException('Ajoutez d’abord une carte avant de vous abonner.');
    }
    const price = await this.settings.get();
    const quantity = await this.billableVehicleCount(fleetId);
    const sub = await this.stripe.createSubscription({
      customerId, unitAmountCents: price.aiUnitAmountEurCents, quantity, currency: price.currency, fleetId,
    });

    const mapped = this.mapStripeStatus(sub.status);
    await this.upsertSubscription(fleetId, {
      status: mapped,
      stripeSubscriptionId: sub.id,
      unitAmountEurCents: price.aiUnitAmountEurCents,
      quantity,
      currency: price.currency,
      currentPeriodEnd: this.periodEnd(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    });
    // Active l'IA seulement si l'abonnement est réellement payé/actif.
    await this.syncEnabled(fleetId, mapped);

    const clientSecret = this.clientSecretOf(sub);
    const requiresAction = mapped !== AiSubscriptionStatus.ACTIVE && !!clientSecret;
    return { status: mapped, requiresAction, clientSecret };
  }

  // ── Facture physique ─────────────────────────────────────────────────────────

  async requestInvoice(viewer: BillingViewer, requestedFleetId?: string): Promise<{ status: 'INVOICE_PENDING' }> {
    const fleetId = this.resolveFleet(viewer, requestedFleetId);
    if (!this.canManage(viewer, fleetId)) throw new ForbiddenException('Non autorisé.');
    const [fleet, user, price, quantity] = await Promise.all([
      this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: viewer.id }, select: { email: true, firstName: true, lastName: true } }),
      this.settings.get(),
      this.billableVehicleCount(fleetId),
    ]);
    await this.upsertSubscription(fleetId, {
      status: AiSubscriptionStatus.INVOICE_PENDING,
      unitAmountEurCents: price.aiUnitAmountEurCents,
      quantity,
      currency: price.currency,
    });
    // Notifie l'owner (contact@vizyoagency.com) — activation manuelle ensuite.
    const monthly = (this.monthlyCents(price.aiUnitAmountEurCents, price.aiPricingUnit, quantity) / 100).toFixed(2);
    const mail = this.email.buildAiInvoiceRequestEmail({
      fleetName: fleet?.name ?? fleetId,
      requester: user?.email ?? '—',
      vehicleCount: quantity,
      monthlyLabel: `${monthly} ${price.currency.toUpperCase()}`,
    });
    void this.email
      .send({ template: 'ai_invoice_request', to: CONTACT_EMAIL, subject: mail.subject, html: mail.html, text: mail.text, fleetId })
      .catch((e) => this.logger.warn(`E-mail facture physique non envoyé : ${(e as Error)?.message ?? e}`));
    return { status: 'INVOICE_PENDING' };
  }

  // ── Annulation ────────────────────────────────────────────────────────────────

  async cancel(viewer: BillingViewer, requestedFleetId?: string): Promise<{ status: AiSubscriptionStatus }> {
    const fleetId = this.resolveFleet(viewer, requestedFleetId);
    if (!this.canManage(viewer, fleetId)) throw new ForbiddenException('Non autorisé.');
    const sub = await this.prisma.aiSubscription.findUnique({ where: { fleetId } });
    if (!sub) throw new BadRequestException('Aucun abonnement à annuler.');
    if (sub.stripeSubscriptionId && this.stripe.isConfigured()) {
      // Annulation en fin de période : le client garde l'IA jusqu'à l'échéance déjà payée.
      const updated = await this.stripe.cancelSubscription(sub.stripeSubscriptionId, true);
      await this.upsertSubscription(fleetId, { status: sub.status, cancelAtPeriodEnd: updated.cancel_at_period_end ?? true, currentPeriodEnd: this.periodEnd(updated) });
      return { status: sub.status };
    }
    // COMP / INVOICE_PENDING (pas de sub Stripe) : coupe immédiatement.
    await this.upsertSubscription(fleetId, { status: AiSubscriptionStatus.CANCELED, cancelAtPeriodEnd: false });
    await this.syncEnabled(fleetId, AiSubscriptionStatus.CANCELED);
    return { status: AiSubscriptionStatus.CANCELED };
  }

  // ── Offert par l'owner (COMP) ────────────────────────────────────────────────

  /** Super-admin/owner : active (COMP, gratuit) ou coupe l'IA d'une société sans paiement. */
  async setComp(viewer: BillingViewer, fleetId: string, enabled: boolean): Promise<{ status: AiSubscriptionStatus }> {
    if (viewer.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Réservé au super-admin.');
    if (enabled) {
      await this.upsertSubscription(fleetId, { status: AiSubscriptionStatus.COMP, compedByUserId: viewer.id });
      await this.syncEnabled(fleetId, AiSubscriptionStatus.COMP);
      return { status: AiSubscriptionStatus.COMP };
    }
    // Désactivation par l'owner : si un abonnement Stripe payant existe, on le laisse tel quel mais on
    // coupe l'IA ; sinon on repasse NONE. (Cas COMP → NONE.)
    const sub = await this.prisma.aiSubscription.findUnique({ where: { fleetId } });
    const next = sub?.status === AiSubscriptionStatus.ACTIVE ? AiSubscriptionStatus.ACTIVE : AiSubscriptionStatus.NONE;
    await this.upsertSubscription(fleetId, { status: next });
    await this.syncEnabled(fleetId, AiSubscriptionStatus.NONE); // coupe l'IA quoi qu'il arrive
    return { status: next };
  }

  // ── Webhook Stripe ────────────────────────────────────────────────────────────

  async handleWebhook(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const fleetId = sub.metadata?.fleetId;
        if (!fleetId) return;
        const mapped = event.type === 'customer.subscription.deleted' ? AiSubscriptionStatus.CANCELED : this.mapStripeStatus(sub.status);
        await this.upsertSubscription(fleetId, {
          status: mapped,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd: this.periodEnd(sub),
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        });
        await this.syncEnabled(fleetId, mapped);
        break;
      }
      default:
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private mapStripeStatus(s: Stripe.Subscription.Status): AiSubscriptionStatus {
    switch (s) {
      case 'active':
      case 'trialing':
        return AiSubscriptionStatus.ACTIVE;
      case 'past_due':
      case 'unpaid':
        return AiSubscriptionStatus.PAST_DUE;
      case 'canceled':
      case 'incomplete_expired':
        return AiSubscriptionStatus.CANCELED;
      default:
        return AiSubscriptionStatus.NONE; // incomplete → en attente de paiement (IA off)
    }
  }

  /** ACTIVE/COMP → IA on, sinon off. Passe par AiAvailabilityService (met à jour aiEnabled + cache). */
  private async syncEnabled(fleetId: string, status: AiSubscriptionStatus): Promise<void> {
    const on = status === AiSubscriptionStatus.ACTIVE || status === AiSubscriptionStatus.COMP;
    await this.aiAvail.setFleet(fleetId, on);
  }

  private async upsertSubscription(fleetId: string, data: {
    status?: AiSubscriptionStatus;
    stripeSubscriptionId?: string;
    unitAmountEurCents?: number;
    quantity?: number;
    currency?: string;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    compedByUserId?: string;
  }): Promise<void> {
    const { status, ...rest } = data;
    await this.prisma.aiSubscription.upsert({
      where: { fleetId },
      create: { fleetId, status: status ?? AiSubscriptionStatus.NONE, ...rest },
      update: { ...(status !== undefined ? { status } : {}), ...rest },
    });
  }

  private periodEnd(sub: Stripe.Subscription): Date | null {
    const raw = (sub as { current_period_end?: number }).current_period_end;
    return typeof raw === 'number' ? new Date(raw * 1000) : null;
  }

  /** Extrait le client_secret du PaymentIntent (SCA) de façon défensive (champ variable selon l'API). */
  private clientSecretOf(sub: Stripe.Subscription): string | null {
    const inv = sub.latest_invoice;
    if (!inv || typeof inv === 'string') return null;
    const pi = (inv as { payment_intent?: unknown }).payment_intent;
    if (!pi || typeof pi === 'string') return null;
    return (pi as { client_secret?: string }).client_secret ?? null;
  }
}
