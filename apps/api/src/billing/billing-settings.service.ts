import { Injectable } from '@nestjs/common';
import type { BillingPricingUnit, BillingSettingsDto } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';

/** Défaut placeholder (5,00 €/véhicule/mois) — à ajuster par le super-admin dans l'UI. */
const DEFAULT_UNIT_AMOUNT_CENTS = 500;

/**
 * Réglages de facturation (SINGLETON). Le prix de l'option IA est CONFIGURABLE par le super-admin
 * (pas figé dans le code) : défaut placeholder tant qu'il n'a pas été réglé, puis valeur en base.
 */
@Injectable()
export class BillingSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<{ aiUnitAmountEurCents: number; aiPricingUnit: BillingPricingUnit; currency: string; updatedAt: Date | null }> {
    const row = await this.prisma.billingSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (row) {
      return {
        aiUnitAmountEurCents: row.aiUnitAmountEurCents,
        aiPricingUnit: (row.aiPricingUnit as BillingPricingUnit) ?? 'per_vehicle',
        currency: row.currency,
        updatedAt: row.updatedAt,
      };
    }
    return { aiUnitAmountEurCents: DEFAULT_UNIT_AMOUNT_CENTS, aiPricingUnit: 'per_vehicle', currency: 'eur', updatedAt: null };
  }

  async toDto(): Promise<BillingSettingsDto> {
    const s = await this.get();
    return {
      aiUnitAmountEurCents: s.aiUnitAmountEurCents,
      aiPricingUnit: s.aiPricingUnit,
      currency: s.currency,
      updatedAt: s.updatedAt?.toISOString() ?? null,
    };
  }

  /** Règle le prix (super-admin). Crée la ligne singleton au 1er réglage. */
  async setPrice(aiUnitAmountEurCents: number, aiPricingUnit: BillingPricingUnit | undefined, userId?: string): Promise<BillingSettingsDto> {
    const amount = Math.max(0, Math.round(Number(aiUnitAmountEurCents) || 0));
    const existing = await this.prisma.billingSettings.findFirst();
    if (existing) {
      await this.prisma.billingSettings.update({
        where: { id: existing.id },
        data: { aiUnitAmountEurCents: amount, ...(aiPricingUnit ? { aiPricingUnit } : {}), updatedByUserId: userId ?? null },
      });
    } else {
      await this.prisma.billingSettings.create({
        data: { aiUnitAmountEurCents: amount, aiPricingUnit: aiPricingUnit ?? 'per_vehicle', updatedByUserId: userId ?? null },
      });
    }
    return this.toDto();
  }
}
