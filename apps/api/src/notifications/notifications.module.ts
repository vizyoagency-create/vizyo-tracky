import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { AlertRulesService } from './alert-rules.service';
import { EscalationCronService } from './escalation-cron.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationsController } from './notifications.controller';
import { WebPushService } from './web-push.service';

@Module({
  imports: [AuthModule, SmsModule],
  controllers: [NotificationsController],
  providers: [
    WebPushService,
    NotificationDispatchService,
    AlertRulesService,
    EscalationCronService,
  ],
  exports: [WebPushService, NotificationDispatchService, AlertRulesService],
})
export class NotificationsModule {}
