import { Global, Module } from '@nestjs/common';
import { AiTraceService } from './ai-trace.service';

/**
 * Conservation des couples (entrée, sortie) des appels IA.
 *
 * @Global comme `AiUsageModule` : la trace se pose au POINT D'APPEL, pas dans un module central.
 * Obliger chaque domaine à importer un module pour archiver ce qu'il envoie au modèle reviendrait
 * à ce que la plupart ne le fassent pas.
 */
@Global()
@Module({
  providers: [AiTraceService],
  exports: [AiTraceService],
})
export class AiTracesModule {}
