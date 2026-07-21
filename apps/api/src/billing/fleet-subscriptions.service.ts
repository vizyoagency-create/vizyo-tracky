import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TrackyFormule, TrackyPlan } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PricingGridService } from './pricing-grid.service';

type Actor = { userId: string };

export interface SubscriptionUpsertInput {
  plan: TrackyPlan;
  formule: TrackyFormule;
  optLive?: boolean;
  optMicro?: boolean;
  optAgent?: boolean;
  retentionKey?: string;
  isComp?: boolean;
  customPriceEurYear?: number | null;
  notes?: string | null;
}

/** Options EFFECTIVES d'une flotte (SIGNATURE inclut tout — règle produit D1/D4). */
export interface EffectiveOptions {
  live: boolean;
  micro: boolean;
  agent: boolean;
  retentionKey: string;
}

/**
 * D4 — Abonnements commerciaux par flotte (plan/formule/options/cas spéciaux), édités par le
 * SUPER_ADMIN dans « Abonnements & tarifs ». Une flotte SANS ligne = « non attribué » (affiché
 * tel quel dans l'admin, comportement app inchangé). SIGNATURE inclut TOUTES les options.
 * Chaque modification est AUDITÉE ; erreurs inattendues → centre d'alerte (source fleet-subscriptions).
 */
@Injectable()
export class FleetSubscriptionsService {
  private readonly logger = new Logger(FleetSubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingGridService,
    private readonly systemActivity: SystemActivityService,
    private readonly errors: ErrorLogger,
  ) {}

  /** Règle produit : SIGNATURE = tout compris (options + rétention 3 ans). */
  static effectiveOptions(sub: { plan: TrackyPlan; optLive: boolean; optMicro: boolean; optAgent: boolean; retentionKey: string }): EffectiveOptions {
    if (sub.plan === TrackyPlan.SIGNATURE) return { live: true, micro: true, agent: true, retentionKey: '3ans' };
    return { live: sub.optLive, micro: sub.optMicro, agent: sub.optAgent, retentionKey: sub.retentionKey };
  }

  /** Prix effectif €/véhicule/an : COMP = 0 ; prix négocié sinon grille + options à la carte. */
  private pricePerVehYear(
    sub: { plan: TrackyPlan; formule: TrackyFormule; isComp: boolean; customPriceEurYear: number | null; optLive: boolean; optMicro: boolean; optAgent: boolean; retentionKey: string },
    grid: Awaited<ReturnType<PricingGridService['get']>>,
  ): number {
    if (sub.isComp) return 0;
    if (sub.customPriceEurYear != null) return sub.customPriceEurYear;
    const planKey = sub.plan.toLowerCase() as 'lite' | 'pro' | 'signature';
    const formuleKey = sub.formule === TrackyFormule.SERENITE ? 'serenite' : 'liberte';
    let price = grid.plans[planKey][formuleKey];
    if (sub.plan !== TrackyPlan.SIGNATURE) {
      if (sub.optLive) price += grid.addons.live.perVehYear;
      if (sub.optMicro) price += grid.addons.micro.perVehYear;
      if (sub.optAgent) price += grid.addons.agent.perVehYear;
      const ret = grid.addons.retention.find((r) => r.key === sub.retentionKey);
      if (ret) price += ret.perVehYear;
    }
    return price;
  }

  /** Vue d'ensemble admin : toutes les flottes, leur abonnement (ou « non attribué »), le revenu estimé. */
  async list(): Promise<{
    items: Array<{
      fleetId: string;
      fleetName: string;
      vehicles: number;
      subscription: null | {
        plan: TrackyPlan; formule: TrackyFormule;
        optLive: boolean; optMicro: boolean; optAgent: boolean; retentionKey: string;
        isComp: boolean; customPriceEurYear: number | null; notes: string | null; updatedAt: string;
        effective: EffectiveOptions;
        pricePerVehYear: number;
        revenueYear: number;
      };
    }>;
    totalRevenueYear: number;
  }> {
    const [fleets, grid] = await Promise.all([
      this.prisma.fleet.findMany({
        select: {
          id: true,
          name: true,
          subscription: true,
          _count: { select: { vehicles: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.pricing.get(),
    ]);
    let totalRevenueYear = 0;
    const items = fleets.map((f) => {
      let subscription = null;
      if (f.subscription) {
        const s = f.subscription;
        const pricePerVehYear = this.pricePerVehYear(s, grid);
        const revenueYear = pricePerVehYear * f._count.vehicles;
        totalRevenueYear += revenueYear;
        subscription = {
          plan: s.plan, formule: s.formule,
          optLive: s.optLive, optMicro: s.optMicro, optAgent: s.optAgent, retentionKey: s.retentionKey,
          isComp: s.isComp, customPriceEurYear: s.customPriceEurYear, notes: s.notes,
          updatedAt: s.updatedAt.toISOString(),
          effective: FleetSubscriptionsService.effectiveOptions(s),
          pricePerVehYear,
          revenueYear,
        };
      }
      return { fleetId: f.id, fleetName: f.name, vehicles: f._count.vehicles, subscription };
    });
    return { items, totalRevenueYear };
  }

  /**
   * 5.2 (gating doux) — abonnement EFFECTIF de la flotte de l'utilisateur connecté.
   * `hasSubscription:false` (aucune ligne, ou pas de flotte) = AUCUN gating côté app :
   * les clients existants non attribués gardent tout (décision sécurité du 21/07).
   */
  async getEffectiveForFleet(fleetId: string | null): Promise<{
    hasSubscription: boolean;
    plan: TrackyPlan | null;
    formule: TrackyFormule | null;
    isComp: boolean;
    options: EffectiveOptions | null;
  }> {
    if (!fleetId) return { hasSubscription: false, plan: null, formule: null, isComp: false, options: null };
    const sub = await this.prisma.fleetSubscription.findUnique({ where: { fleetId } });
    if (!sub) return { hasSubscription: false, plan: null, formule: null, isComp: false, options: null };
    return {
      hasSubscription: true,
      plan: sub.plan,
      formule: sub.formule,
      isComp: sub.isComp,
      options: FleetSubscriptionsService.effectiveOptions(sub),
    };
  }

  /** Crée/modifie l'abonnement d'une flotte. Audité (qui, quoi, quand — feed admin). */
  async upsert(fleetId: string, input: SubscriptionUpsertInput, actor: Actor) {
    try {
      const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
      if (!fleet) throw new NotFoundException('Flotte introuvable.');

      const data = {
        plan: input.plan,
        formule: input.formule,
        optLive: input.optLive ?? false,
        optMicro: input.optMicro ?? false,
        optAgent: input.optAgent ?? false,
        retentionKey: input.retentionKey ?? '90j',
        isComp: input.isComp ?? false,
        customPriceEurYear: input.customPriceEurYear ?? null,
        notes: input.notes?.trim() || null,
        updatedByUserId: actor.userId,
      };
      const sub = await this.prisma.fleetSubscription.upsert({
        where: { fleetId },
        create: { fleetId, ...data },
        update: data,
      });

      const compLbl = sub.isComp ? ' · OFFERT (comp)' : sub.customPriceEurYear != null ? ` · prix négocié ${sub.customPriceEurYear} €/véh/an` : '';
      this.systemActivity.record({
        category: 'BILLING',
        action: 'subscription_updated',
        status: 'SUCCESS',
        actor: 'opérateur',
        target: fleet.name,
        detail: `Abonnement ${sub.plan} · ${sub.formule === TrackyFormule.SERENITE ? 'Sérénité' : 'Liberté'}${compLbl}`,
        fleetId,
        triggeredByUserId: actor.userId,
        meta: { plan: sub.plan, formule: sub.formule, isComp: sub.isComp, customPriceEurYear: sub.customPriceEurYear },
      });
      this.logger.log({ fleetId, plan: sub.plan, formule: sub.formule, by: actor.userId }, 'Fleet subscription upserted');
      return { ...sub, effective: FleetSubscriptionsService.effectiveOptions(sub) };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.errors
        .record(err instanceof Error ? err : new Error(String(err)), 'fleet-subscriptions', { fleetId, userId: actor.userId }, 'ERROR')
        .catch(() => undefined);
      throw err;
    }
  }
}
