import { Global, Module } from '@nestjs/common';
import { InMemoryCacheService } from './in-memory-cache.service';

/**
 * V1.10 (Sprint 2 perf) — Module cache global.
 *
 * @Global permet d'injecter InMemoryCacheService partout sans avoir a
 * importer CacheModule dans chaque feature module (pattern utilise aussi
 * par VehicleAccessModule).
 */
@Global()
@Module({
  providers: [InMemoryCacheService],
  exports: [InMemoryCacheService],
})
export class CacheModule {}
