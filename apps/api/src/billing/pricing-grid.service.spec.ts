import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PRICING_GRID, PricingGridService } from './pricing-grid.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/**
 * Phase 3 — grille tarifaire en DB : seed auto à la grille D1, update validé + audité,
 * grille invalide refusée (la LP ne doit jamais recevoir une grille cassée), fail-safe DB.
 */
function makeService() {
  const prisma = {
    pricingSettings: {
      findFirst: jest.fn(),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', grid: data.grid, updatedAt: new Date(), updatedByUserId: null })),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const systemActivity = { record: jest.fn() };
  const errors = { record: jest.fn().mockResolvedValue('id') };
  const service = new PricingGridService(
    prisma as unknown as PrismaService,
    systemActivity as unknown as SystemActivityService,
    errors as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity, errors };
}

describe('PricingGridService', () => {
  it('get : table vide → seed automatique avec la grille D1 (149/199/269)', async () => {
    const { service, prisma } = makeService();
    prisma.pricingSettings.findFirst.mockResolvedValue(null);
    const grid = await service.get();
    expect(prisma.pricingSettings.create).toHaveBeenCalledTimes(1);
    expect(grid.plans.lite.serenite).toBe(149);
    expect(grid.plans.signature.liberte).toBe(349);
  });

  it('update : grille valide → persistée + AUDITÉE (BILLING/pricing_updated) + cache invalidé', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.pricingSettings.findFirst.mockResolvedValue({ id: 'p1' });
    const grid = JSON.parse(JSON.stringify(DEFAULT_PRICING_GRID));
    grid.plans.pro.serenite = 219;

    const res = await service.update(grid, { userId: 'u1' });

    expect(prisma.pricingSettings.update).toHaveBeenCalledTimes(1);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'BILLING', action: 'pricing_updated' });
    expect(res.plans.pro.serenite).toBe(219);
  });

  it('update : grille INVALIDE (prix manquant/négatif) → 400, rien de persisté', async () => {
    const { service, prisma } = makeService();
    const bad = JSON.parse(JSON.stringify(DEFAULT_PRICING_GRID));
    bad.plans.pro.serenite = -5;
    await expect(service.update(bad, { userId: 'u1' })).rejects.toBeInstanceOf(BadRequestException);
    delete bad.plans.lite;
    await expect(service.update(bad, { userId: 'u1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pricingSettings.update).not.toHaveBeenCalled();
  });

  it('get : erreur DB → repli sur la grille code (fail-safe LP) + centre d\'alerte', async () => {
    const { service, prisma, errors } = makeService();
    prisma.pricingSettings.findFirst.mockRejectedValue(new Error('db down'));
    const grid = await service.get();
    expect(grid.plans.lite.serenite).toBe(149);
    expect(errors.record).toHaveBeenCalledTimes(1);
    expect(errors.record.mock.calls[0][1]).toBe('pricing-grid');
  });
});
