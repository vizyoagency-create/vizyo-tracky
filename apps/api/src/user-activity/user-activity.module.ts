import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { ActivityReportController } from './activity-report.controller';
import { ActivityReportService } from './activity-report.service';
import { UserActivityController } from './user-activity.controller';
import { UserActivityService } from './user-activity.service';

/**
 * User activity tracking. PrismaService est global ; AuthModule fournit les guards.
 * Palier 3 — AiModule fournit AnthropicClient au service de rapports (AiUsageService est global).
 */
@Module({
  imports: [AuthModule, AiModule],
  controllers: [UserActivityController, ActivityReportController],
  providers: [UserActivityService, ActivityReportService],
})
export class UserActivityModule {}
