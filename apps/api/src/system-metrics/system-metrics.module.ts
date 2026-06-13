import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsCollectorService } from './metrics-collector.service';
import { SystemMetricsController } from './system-metrics.controller';
import { SystemMetricsService } from './system-metrics.service';

/**
 * Monitoring VPS (espace admin). PrismaService + ErrorLogger sont globaux.
 * AuthModule fournit JwtAuthGuard / RolesGuard.
 */
@Module({
  imports: [AuthModule],
  controllers: [SystemMetricsController],
  providers: [SystemMetricsService, MetricsCollectorService],
})
export class SystemMetricsModule {}
