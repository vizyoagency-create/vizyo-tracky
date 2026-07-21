import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/**
 * Grille par défaut = repositionnement 2026 (D1, xlsx « Repositionnement »), même forme que
 * lp/src/data/pricing.mjs. Sert de seed au premier accès ; ensuite la DB fait foi et la LP
 * s'hydrate dessus (GET /public/pricing) → changer un prix ne demande AUCUN redéploiement.
 */
export const DEFAULT_PRICING_GRID = {
  currency: '€',
  vat: 'HT',
  toutInclus: 'Boîtier, SIM & data, pose par nos équipes et garantie inclus',
  formules: {
    serenite: { key: 'serenite', name: 'Sérénité', sub: 'Tout inclus · engagement 36 mois', engagementMois: 36 },
    liberte: { key: 'liberte', name: 'Liberté', sub: 'Sans engagement · 12 mois · matériel restitué', engagementMois: 0 },
  },
  plans: {
    lite: { key: 'lite', name: 'Tracky Lite', tagline: 'Géolocalisation simple — sans coupe-circuit', serenite: 149, liberte: 199 },
    pro: { key: 'pro', name: 'Tracky Pro', tagline: 'Contrôle total — coupure moteur incluse', serenite: 199, liberte: 259, popular: true },
    signature: { key: 'signature', name: 'Tracky Signature', tagline: 'Premium — tout compris, sans exception', serenite: 269, liberte: 349 },
  },
  addons: {
    live: { key: 'live', label: 'Live temps réel (20 s)', perVehYear: 119 },
    micro: { key: 'micro', label: "Micro d'assistance", perVehYear: 83 },
    agent: { key: 'agent', label: 'Assistant IA (optimisation)', perVehYear: 179 },
    retention: [
      { key: '90j', years: 0.25, label: '90 jours', perVehYear: 0, included: true },
      { key: '1an', years: 1, label: '1 an', perVehYear: 47 },
      { key: '2ans', years: 2, label: '2 ans', perVehYear: 83 },
      { key: '3ans', years: 3, label: '3 ans', perVehYear: 119 },
    ],
  },
  savingsPerVehYear: { low: 200, high: 400 },
  launch: { active: true, label: 'Tarif de lancement', until: '2026-09-30', slotsLeft: 12, guarantee: 'Tarif garanti à vie pour toute souscription avant cette date.' },
} as const;

export type PricingGrid = typeof DEFAULT_PRICING_GRID;

type Actor = { userId: string };

/**
 * Phase 3 — grille tarifaire en DB (singleton). Source de vérité des prix : LP (hydratation
 * runtime), app admin (« Abonnements & tarifs ») et calculs d'abonnement (FleetSubscriptions).
 * Toute modification est AUDITÉE (journal Système) ; erreurs inattendues → centre d'alerte.
 */
@Injectable()
export class PricingGridService {
  private readonly logger = new Logger(PricingGridService.name);
  private cache: { at: number; grid: PricingGrid } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly errors: ErrorLogger,
  ) {}

  /** Grille courante (cache 5 min). Seed automatique à la grille D1 si la table est vide. */
  async get(): Promise<PricingGrid> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 5 * 60_000) return this.cache.grid;
    try {
      let row = await this.prisma.pricingSettings.findFirst({ orderBy: { createdAt: 'asc' } });
      if (!row) {
        row = await this.prisma.pricingSettings.create({
          data: { grid: DEFAULT_PRICING_GRID as unknown as Prisma.InputJsonValue },
        });
        this.logger.log('PricingSettings seedé avec la grille par défaut (D1)');
      }
      const grid = row.grid as unknown as PricingGrid;
      this.cache = { at: now, grid };
      return grid;
    } catch (err) {
      // Fail-safe : la LP et l'admin ne doivent jamais tomber pour une erreur DB — repli grille code.
      this.errors
        .record(err instanceof Error ? err : new Error(String(err)), 'pricing-grid', {}, 'ERROR')
        .catch(() => undefined);
      return DEFAULT_PRICING_GRID;
    }
  }

  /** Métadonnées d'édition pour l'admin (qui a modifié, quand). */
  async getWithMeta(): Promise<{ grid: PricingGrid; updatedAt: string | null; updatedByUserId: string | null }> {
    const grid = await this.get();
    const row = await this.prisma.pricingSettings.findFirst({ select: { updatedAt: true, updatedByUserId: true } });
    return { grid, updatedAt: row?.updatedAt?.toISOString() ?? null, updatedByUserId: row?.updatedByUserId ?? null };
  }

  /** Remplace la grille (validée). Audit « qui a changé les prix, quand ». */
  async update(grid: unknown, actor: Actor): Promise<PricingGrid> {
    this.validate(grid);
    try {
      const existing = await this.prisma.pricingSettings.findFirst({ select: { id: true } });
      const data = { grid: grid as Prisma.InputJsonValue, updatedByUserId: actor.userId };
      if (existing) await this.prisma.pricingSettings.update({ where: { id: existing.id }, data });
      else await this.prisma.pricingSettings.create({ data });
      this.cache = null; // la LP verra le nouveau prix au prochain fetch (≤ 5 min)
      const g = grid as PricingGrid;
      this.systemActivity.record({
        category: 'BILLING',
        action: 'pricing_updated',
        status: 'SUCCESS',
        actor: 'opérateur',
        target: 'Grille tarifaire publique',
        detail: `Grille mise à jour — Sérénité ${g.plans.lite.serenite}/${g.plans.pro.serenite}/${g.plans.signature.serenite} €/an`,
        triggeredByUserId: actor.userId,
        meta: { serenite: [g.plans.lite.serenite, g.plans.pro.serenite, g.plans.signature.serenite], liberte: [g.plans.lite.liberte, g.plans.pro.liberte, g.plans.signature.liberte] },
      });
      return g;
    } catch (err) {
      this.errors
        .record(err instanceof Error ? err : new Error(String(err)), 'pricing-grid', { userId: actor.userId }, 'ERROR')
        .catch(() => undefined);
      throw err;
    }
  }

  /** Validation structurelle : refuse une grille qui casserait la LP ou les calculs d'abonnement. */
  private validate(grid: unknown): asserts grid is PricingGrid {
    const g = grid as PricingGrid;
    const price = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 100_000;
    if (!g || typeof g !== 'object') throw new BadRequestException('Grille invalide.');
    for (const p of ['lite', 'pro', 'signature'] as const) {
      const plan = g.plans?.[p];
      if (!plan || !price(plan.serenite) || !price(plan.liberte)) {
        throw new BadRequestException(`Plan « ${p} » : prix Sérénité/Liberté requis (nombre > 0).`);
      }
    }
    for (const a of ['live', 'micro', 'agent'] as const) {
      if (!price(g.addons?.[a]?.perVehYear)) throw new BadRequestException(`Option « ${a} » : prix €/an requis.`);
    }
    if (!Array.isArray(g.addons?.retention) || g.addons.retention.length < 1) {
      throw new BadRequestException('Paliers de rétention requis.');
    }
  }
}
