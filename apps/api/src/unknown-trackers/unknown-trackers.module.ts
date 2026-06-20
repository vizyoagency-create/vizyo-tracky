import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UnknownTrackersController } from './unknown-trackers.controller';
import { UnknownTrackerRegistry } from './unknown-trackers.registry';

/**
 * Boîtiers non reconnus — registre en mémoire (exporté pour que le serveur TCP y écrive) +
 * endpoint admin de lecture/dismiss. Importe AuthModule pour résoudre les dépendances des
 * guards du contrôleur (JwtAuthGuard → AuthService, RolesGuard), comme les autres contrôleurs.
 */
@Module({
  imports: [AuthModule],
  controllers: [UnknownTrackersController],
  providers: [UnknownTrackerRegistry],
  exports: [UnknownTrackerRegistry],
})
export class UnknownTrackersModule {}
