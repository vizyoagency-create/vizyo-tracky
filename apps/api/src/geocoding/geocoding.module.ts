import { Global, Module } from '@nestjs/common';
import { ReverseGeocodeService } from './reverse-geocode.service';

/**
 * Refonte agenda/IA (2026-07, P3) — Géocodage inverse (Nominatim/OSM). Exposé globalement
 * (comme le cache/permissions) : injectable par l'agent d'agenda sans import explicite.
 */
@Global()
@Module({
  providers: [ReverseGeocodeService],
  exports: [ReverseGeocodeService],
})
export class GeocodingModule {}
