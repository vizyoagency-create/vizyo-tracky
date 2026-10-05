import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TripAnalysisModule } from '../trip-analysis/trip-analysis.module';
import { UserActivityModule } from '../user-activity/user-activity.module';
import { AssistanceAiService } from './assistance-ai.service';
import { AssistanceContextService } from './assistance-context.service';
import { AssistanceController } from './assistance.controller';
import { AssistanceService } from './assistance.service';

/**
 * Assistance IA (2026-08). Le reste est @Global — AiRouter (AiCoreModule), AiUsageService,
 * ErrorLogger, SystemActivityService, VehicleAccessService, PermissionsResolverService,
 * DepotScopeGuard et Prisma.
 *
 * `TripAnalysisModule` (2026-10-01) pour `DrivingScoreService` : le lot de contexte « scores »
 * répond à « qui conduit le mieux ? » avec le classement de l'écran, pas avec un calcul refait.
 * Le sens de la dépendance reste le bon — l'assistance CONSOMME le produit.
 *
 * `UserActivityModule` (2026-10-01) : une question posée, un appui sur la ligne d'urgence
 * WhatsApp s'écrivent au centre d'activité des utilisateurs — par le serveur, pas par le
 * navigateur, pour qu'aucun lot jamais envoyé ne les perde.
 *
 * Aucun service n'est exporté : l'assistance est une extrémité de l'application, pas une
 * dépendance. Si un jour un autre module veut « demander à l'assistant », c'est le signe qu'il
 * faut extraire la connaissance, pas ouvrir ce module.
 */
@Module({
  imports: [AuthModule, NotificationsModule, TripAnalysisModule, UserActivityModule],
  controllers: [AssistanceController],
  providers: [AssistanceService, AssistanceAiService, AssistanceContextService],
})
export class AssistanceModule {}
