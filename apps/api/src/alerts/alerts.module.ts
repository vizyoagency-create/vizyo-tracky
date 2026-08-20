import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { DetectionAccidentService } from './detection-accident.service';

@Module({
  imports: [AuthModule, forwardRef(() => RealtimeModule), NotificationsModule],
  controllers: [AlertsController],
  providers: [AlertsService, DetectionAccidentService],
  exports: [AlertsService],
})
export class AlertsModule {}
