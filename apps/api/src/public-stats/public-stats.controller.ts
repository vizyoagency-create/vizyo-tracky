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
/**
 * Coup de pouce d'affichage TEMPORAIRE (+50, demandé le 21/07/2026 — « pour le début ») ajouté au
 * compte réel. À réduire/retirer quand le parc grandit : env `LP_STATS_VEHICLES_BOOST` (défaut 50,
 * poser 0 pour afficher le compte brut), sans redéploiement de la LP.
 */
const VEHICLES_DISPLAY_BOOST = Math.max(0, Number(process.env.LP_STATS_VEHICLES_BOOST ?? 50));

@Controller('public')
export class PublicStatsController {
  private cache: { at: number; vehicles: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  @Get('stats')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async stats(): Promise<{ vehicles: number }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 5 * 60_000) return { vehicles: this.cache.vehicles };
    const vehicles = (await this.prisma.vehicle.count()) + VEHICLES_DISPLAY_BOOST;
    this.cache = { at: now, vehicles };
    return { vehicles };
  }
}
