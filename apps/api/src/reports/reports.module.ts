import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportCsvService } from './report-csv.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsController } from './reports.controller';
import { ReportsCronService } from './reports-cron.service';
import { ReportsStatsService } from './reports-stats.service';
import { SpeedReportService } from './speed-report.service';

@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [ReportsStatsService, ReportPdfService, ReportCsvService, ReportsCronService, SpeedReportService],
  exports: [ReportsStatsService],
})
export class ReportsModule {}
