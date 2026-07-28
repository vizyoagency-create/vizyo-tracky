import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { AlertRulesService } from './alert-rules.service';
import { EscalationCronService } from './escalation-cron.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationThrottleService } from './notification-throttle.service';
import { NotificationRetentionService } from './notification-retention.service';
import { NotificationCenterController } from './notification-center.controller';
import { NotificationCenterService } from './notification-center.service';
import { NotificationsController } from './notifications.controller';
import { WebPushService } from './web-push.service';

/**
 * NotificationPreferencesService est EXPORTE : il porte l'aiguillage du push (qui recoit
 * quoi) et les conversions de severite entre l'enum Prisma (MAJUSCULES) et le contrat
 * partage (minuscules). Toute logique de decision push doit passer par lui — deux
 * implementations auraient diverge au premier changement de regle, et c'est exactement
 * ce genre d'ecart qui a produit 582 alertes sans le moindre push.
 *
 * NotificationThrottleService reste INTERNE au module : c'est une dependance du dispatch,
 * pas une API. Son seul point d'entree legitime est `dispatchAlert()` — un appelant
 * exterieur qui l'invoquerait sans passer par le dispatch consommerait des compteurs sans
 * jamais envoyer ni journaliser, et rendrait un utilisateur muet sans laisser de trace.
 */
@Module({
  imports: [AuthModule, SmsModule],
  controllers: [NotificationsController, NotificationCenterController],
  providers: [NotificationRetentionService,
    NotificationCenterService,
    
    WebPushService,
    NotificationDispatchService,
    NotificationThrottleService,
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
