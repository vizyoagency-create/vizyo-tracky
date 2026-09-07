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
import { PublicTripShareController } from './public-trip-share.controller';
import { TripShareController } from './trip-share.controller';
import { TripSharePurgeService } from './trip-share-purge.service';
import { TripShareService } from './trip-share.service';

@Module({
  imports: [AuthModule],
  controllers: [
    ReportsController,
    TripShareController,
    // ⚠️ La route PUBLIQUE, sans aucun garde, déclarée à côté des autres mais définie dans
    // son propre fichier : c'est la seule façon qu'un `@UseGuards` ajouté au contrôleur
    // authentifié ne l'atteigne jamais par accident.
    PublicTripShareController,
  ],
  providers: [
    ReportsStatsService,
    ReportPdfService,
    ReportCsvService,
    ReportExcelService,
    ReportScheduleService,
    ReportsCronService,
    SpeedReportService,
    TripShareService,
    TripSharePurgeService,
  ],
  exports: [ReportsStatsService],
})
export class ReportsModule {}
