import { Global, Module } from '@nestjs/common';
import { SystemActivityService } from './system-activity.service';

/**
 * Palier B — module @Global : le journal des actions système est injectable
 * PARTOUT (primitives e-mail / SMS / push, engine-control, rétention, rapports
 * IA…) sans import explicite, à l'image d'ObservabilityModule (ErrorLogger).
 * PrismaService étant déjà global, ce module n'a besoin d'aucun import.
 */
@Global()
@Module({
  providers: [SystemActivityService],
  exports: [SystemActivityService],
})
export class SystemActivityModule {}
