import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssistanceAiService } from './assistance-ai.service';
import { AssistanceContextService } from './assistance-context.service';
import { AssistanceController } from './assistance.controller';
import { AssistanceService } from './assistance.service';

/**
 * Assistance IA (2026-08). Seul `AuthModule` est importé : tout le reste est @Global —
 * AiRouter (AiCoreModule), AiUsageService, ErrorLogger, SystemActivityService,
 * VehicleAccessService, PermissionsResolverService, DepotScopeGuard et Prisma.
 *
 * Aucun service n'est exporté : l'assistance est une extrémité de l'application, pas une
 * dépendance. Si un jour un autre module veut « demander à l'assistant », c'est le signe qu'il
 * faut extraire la connaissance, pas ouvrir ce module.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AssistanceController],
  providers: [AssistanceService, AssistanceAiService, AssistanceContextService],
})
export class AssistanceModule {}
