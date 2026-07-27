import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { AlertRulesService } from './alert-rules.service';
import { EscalationCronService } from './escalation-cron.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsController } from './notifications.controller';
import { WebPushService } from './web-push.service';

/**
 * NotificationPreferencesService est EXPORTE : il porte l'aiguillage du push (qui recoit
 * quoi) et les conversions de severite entre l'enum Prisma (MAJUSCULES) et le contrat
 * partage (minuscules). Toute logique de decision push doit passer par lui — deux
 * implementations auraient diverge au premier changement de regle, et c'est exactement
 * ce genre d'ecart qui a produit 582 alertes sans le moindre push.
 */
@Module({
  imports: [AuthModule, SmsModule],
  controllers: [NotificationsController],
  providers: [
    WebPushService,
    NotificationDispatchService,
    AlertRulesService,
    EscalationCronService,
    NotificationPreferencesService,
  ],
  exports: [
    WebPushService,
    NotificationDispatchService,
    AlertRulesService,
    NotificationPreferencesService,
  ],
})
export class NotificationsModule {}
