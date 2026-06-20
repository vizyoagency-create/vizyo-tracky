import { Module } from '@nestjs/common';
import { UnknownTrackersController } from './unknown-trackers.controller';
import { UnknownTrackerRegistry } from './unknown-trackers.registry';

/**
 * Boîtiers non reconnus — registre en mémoire (exporté pour que le serveur TCP y écrive) +
 * endpoint admin de lecture/dismiss.
 */
@Module({
  controllers: [UnknownTrackersController],
  providers: [UnknownTrackerRegistry],
  exports: [UnknownTrackerRegistry],
})
export class UnknownTrackersModule {}
