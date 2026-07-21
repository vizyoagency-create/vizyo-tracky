import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

/**
 * D5 (chantier commercial) — chiffres PUBLICS de la LP, lus depuis la base (vérité produit,
 * plus de chiffre marketing en dur). Consommé cross-origin par tracky.vizyoagency.com (vt.js) :
 * les compteurs `data-vt-stat` s'hydratent au chargement, avec repli sur la valeur bakée.
 *
 * Public — pas de JwtAuthGuard (aucune donnée sensible : un simple total plateforme).
 * Rate-limité + cache mémoire 5 min (une visite LP ne coûte pas un COUNT SQL).
 */
@Controller('public')
export class PublicStatsController {
  private cache: { at: number; vehicles: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  @Get('stats')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async stats(): Promise<{ vehicles: number }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 5 * 60_000) return { vehicles: this.cache.vehicles };
    const vehicles = await this.prisma.vehicle.count();
    this.cache = { at: now, vehicles };
    return { vehicles };
  }
}
