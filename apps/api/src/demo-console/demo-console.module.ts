import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DemoBridgeService } from './demo-bridge.service';
import { DemoConsoleAdminController } from './demo-console-admin.controller';

/**
 * Console de démonstration, côté PRODUCTION (2026-09-08).
 *
 * Ne dépend d'aucune base : tout passe par `DemoBridgeService`, qui appelle l'API de la démo.
 * Inerte tant que `DEMO_API_URL` et `DEMO_INTERNAL_SECRET` sont absentes — l'écran affiche
 * alors « non configurée », et aucune requête ne part.
 */
@Module({
  imports: [AuthModule],
  controllers: [DemoConsoleAdminController],
  providers: [DemoBridgeService],
  exports: [DemoBridgeService],
})
export class DemoConsoleModule {}
