import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { DetectionAccidentService } from './detection-accident.service';
import { PowerCutRecheckService } from './power-cut-recheck.service';
import { SpeedAlertService } from './speed-alert.service';
import { SpeedAlertSettingsService } from './speed-alert-settings.service';

@Module({
  imports: [AuthModule, forwardRef(() => RealtimeModule), NotificationsModule],
  controllers: [AlertsController],
  providers: [AlertsService, DetectionAccidentService, PowerCutRecheckService, SpeedAlertService, SpeedAlertSettingsService],
  // `SpeedAlertService` : l'analyse de trajet (TripAnalysisModule) l'appelle après chaque écriture.
  exports: [AlertsService, SpeedAlertService],
})
export class AlertsModule {}
