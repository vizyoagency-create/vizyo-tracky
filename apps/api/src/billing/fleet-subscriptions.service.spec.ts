import { NotFoundException } from '@nestjs/common';
import { TrackyFormule, TrackyPlan } from '@prisma/client';
import { FleetSubscriptionsService } from './fleet-subscriptions.service';
import { DEFAULT_PRICING_GRID, type PricingGridService } from './pricing-grid.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/**
 * D4 — abonnements par flotte : SIGNATURE inclut tout, COMP = 0 €, prix négocié prioritaire,
 * upsert audité, 404 flotte inconnue, revenu calculé depuis la grille + options.
 */
function makeService() {
  const prisma = {
    fleet: { findMany: jest.fn(), findUnique: jest.fn() },
    fleetSubscription: { upsert: jest.fn() },
  };
  const pricing = { get: jest.fn().mockResolvedValue(DEFAULT_PRICING_GRID) };
  const systemActivity = { record: jest.fn() };
  const errors = { record: jest.fn().mockResolvedValue('id') };
  const service = new FleetSubscriptionsService(
    prisma as unknown as PrismaService,
    pricing as unknown as PricingGridService,
    systemActivity as unknown as SystemActivityService,
    errors as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity };
}

const baseSub = {
  plan: TrackyPlan.PRO, formule: TrackyFormule.SERENITE,
  optLive: false, optMicro: false, optAgent: false, retentionKey: '90j',
  isComp: false, customPriceEurYear: null, notes: null, updatedAt: new Date(),
};

describe('FleetSubscriptionsService', () => {
  it('effectiveOptions : SIGNATURE inclut TOUT (options + rétention 3 ans)', () => {
    expect(FleetSubscriptionsService.effectiveOptions({ ...baseSub, plan: TrackyPlan.SIGNATURE }))
      .toEqual({ live: true, micro: true, agent: true, retentionKey: '3ans' });
    expect(FleetSubscriptionsService.effectiveOptions({ ...baseSub, optLive: true }))
      .toEqual({ live: true, micro: false, agent: false, retentionKey: '90j' });
  });

  it('list : revenu = prix grille (+ options à la carte) × véhicules ; COMP = 0 ; négocié prioritaire', async () => {
    const { service, prisma } = makeService();
    prisma.fleet.findMany.mockResolvedValue([
      { id: 'f1', name: 'Pro simple', _count: { vehicles: 10 }, subscription: { ...baseSub } }, // 199×10
      { id: 'f2', name: 'Pro + live', _count: { vehicles: 2 }, subscription: { ...baseSub, optLive: true } }, // (199+119)×2
      { id: 'f3', name: 'Comp', _count: { vehicles: 5 }, subscription: { ...baseSub, isComp: true } }, // 0
      { id: 'f4', name: 'Négocié', _count: { vehicles: 3 }, subscription: { ...baseSub, customPriceEurYear: 100 } }, // 300
      { id: 'f5', name: 'Sans abo', _count: { vehicles: 7 }, subscription: null },
    ]);

    const res = await service.list();

    expect(res.items[0].subscription!.revenueYear).toBe(1990);
    expect(res.items[1].subscription!.revenueYear).toBe(636);
    expect(res.items[2].subscription!.pricePerVehYear).toBe(0);
    expect(res.items[3].subscription!.revenueYear).toBe(300);
    expect(res.items[4].subscription).toBeNull();
    expect(res.totalRevenueYear).toBe(1990 + 636 + 0 + 300);
  });

  it('upsert : crée/modifie + AUDITE (journal Système, catégorie BILLING)', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.fleet.findUnique.mockResolvedValue({ id: 'f1', name: 'MH Cars' });
    prisma.fleetSubscription.upsert.mockResolvedValue({ ...baseSub, plan: TrackyPlan.SIGNATURE });

    const res = await service.upsert('f1', { plan: TrackyPlan.SIGNATURE, formule: TrackyFormule.SERENITE }, { userId: 'u1' });

    expect(prisma.fleetSubscription.upsert).toHaveBeenCalledTimes(1);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'BILLING', action: 'subscription_updated', target: 'MH Cars' });
    expect(res.effective).toEqual({ live: true, micro: true, agent: true, retentionKey: '3ans' });
  });

  it('upsert : flotte inconnue → 404, rien d\'écrit ni d\'audité', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.fleet.findUnique.mockResolvedValue(null);
    await expect(service.upsert('nope', { plan: TrackyPlan.PRO, formule: TrackyFormule.LIBERTE }, { userId: 'u1' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.fleetSubscription.upsert).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });
});
