import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportCsvService } from './report-csv.service';
import { ReportExcelService } from './report-excel.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportScheduleService } from './report-schedule.service';
import { ReportsController } from './reports.controller';
import { ReportsCronService } from './reports-cron.service';
import { ReportsStatsService } from './reports-stats.service';
import { SpeedReportService } from './speed-report.service';

// VehicleAccessService est fourni globalement (VehicleAccessModule @Global) :
// pas besoin de l'importer ici, il est injectable dans le controller + le
// ReportExcelService.
@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [
    ReportsStatsService,
    ReportPdfService,
    ReportCsvService,
    ReportExcelService,
    ReportScheduleService,
    ReportsCronService,
    SpeedReportService,
  ],
  exports: [ReportsStatsService],
})
export class ReportsModule {}
