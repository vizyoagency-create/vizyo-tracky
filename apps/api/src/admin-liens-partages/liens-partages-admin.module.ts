import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LiensPartagesAdminController } from './liens-partages-admin.controller';
import { LiensPartagesAdminService } from './liens-partages-admin.service';

/**
 * La vue d'ensemble des accès publics — SUPER_ADMIN uniquement.
 *
 * ⚠️ Module SÉPARÉ des deux mécanismes qu'il observe (`ReportsModule` pour le partage de
 * trajet, `MissionsModule` pour le suivi de livraison). Le brancher dans l'un ou l'autre
 * l'aurait rendu dépendant d'un seul des deux, et c'est précisément leur réunion qui fait
 * l'intérêt de l'écran.
 *
 * ⚠️ `AuthModule` EST OBLIGATOIRE : le contrôleur pose `JwtAuthGuard` + `RolesGuard`, qui ne se
 * résolvent pas sans lui. Le graphe d'injection ne le dit qu'au démarrage — c'est le
 * smoke-boot qui l'a attrapé, pas la compilation.
 *
 * `PrismaModule` et `SystemActivityModule` sont @Global : ils s'injectent sans import.
 */
@Module({
  imports: [AuthModule],
  controllers: [LiensPartagesAdminController],
  providers: [LiensPartagesAdminService],
})
export class LiensPartagesAdminModule {}
