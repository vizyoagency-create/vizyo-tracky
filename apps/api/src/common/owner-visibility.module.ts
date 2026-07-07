import { Global, Module } from '@nestjs/common';
import { OwnerVisibilityService } from './owner-visibility.service';

/**
 * Module @Global — le service d'invisibilité owner est injectable PARTOUT
 * (contrôleurs users, vues d'activité, rapports/coûts IA, sérialiseurs d'action)
 * sans import explicite, à l'image de SystemActivityModule. PrismaService étant
 * déjà global, ce module n'a besoin d'aucun import.
 */
@Global()
@Module({
  providers: [OwnerVisibilityService],
  exports: [OwnerVisibilityService],
})
export class OwnerVisibilityModule {}
