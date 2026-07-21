import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PricingGridService } from './pricing-grid.service';

/**
 * Phase 3 — grille tarifaire PUBLIQUE pour la LP (hydratation runtime des prix : cartes, simulateur).
 * Public — aucune donnée sensible (ce sont les prix affichés). Cache 5 min côté service.
 */
@Controller('public')
export class PublicPricingController {
  constructor(private readonly pricing: PricingGridService) {}

  @Get('pricing')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  grid() {
    return this.pricing.get();
  }
}
