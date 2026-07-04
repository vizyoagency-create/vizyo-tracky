import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GeocodeService } from './geocode.service';

/**
 * Géocodage inverse pour la liste des véhicules. Auth requise (JwtAuthGuard) :
 * pas d'endpoint public de géocodage. La réponse est toujours `{ address }`
 * (chaîne vide si coordonnées invalides ou géocodage indisponible).
 */
@Controller('geocode')
@UseGuards(JwtAuthGuard)
export class GeocodeController {
  constructor(private readonly geocode: GeocodeService) {}

  @Get('reverse')
  async reverse(@Query('lat') lat?: string, @Query('lng') lng?: string): Promise<{ address: string }> {
    const la = Number(lat);
    const lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      return { address: '' };
    }
    return { address: await this.geocode.reverse(la, lo) };
  }
}
