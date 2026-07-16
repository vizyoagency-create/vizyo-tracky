import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActivityReportController } from './activity-report.controller';
import { ActivityReportService } from './activity-report.service';
import { PublicClientErrorController } from './public-client-error.controller';
import { UserActivityController } from './user-activity.controller';
import { UserActivityService } from './user-activity.service';

/**
 * User activity tracking. PrismaService est global ; AuthModule fournit les guards.
 * Palier 3 — le service de rapports appelle l'IA via AiRouter (@Global AiCoreModule) ; AiUsageService global.
 * PublicClientErrorController = remontée PUBLIQUE des bugs JS pré-connexion (ErrorLogger @Global, aucun guard).
 */
@Module({
  imports: [AuthModule],
  controllers: [UserActivityController, ActivityReportController, PublicClientErrorController],
  providers: [UserActivityService, ActivityReportService],
})
export class UserActivityModule {}
