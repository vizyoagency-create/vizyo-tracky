import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailAdminController } from '../email/email-admin.controller';
import { EmailAdminService } from '../email/email-admin.service';
import { CommunicationsController } from './communications.controller';
import { CommunicationsService } from './communications.service';

/**
 * MODULE UNIQUE des communications sortantes (e-mail + SMS + notification push).
 *
 * Remplace l'ancien EmailAdminModule et évite d'ouvrir un module par canal : tout
 * ce qui concerne « ce que Tracky envoie à un humain » vit ici. On y trouve la vue
 * transverse (CommunicationsController) ET le centre e-mails historique
 * (EmailAdminController, conservé pour l'aperçu HTML et l'envoi de test, qui n'ont
 * pas d'équivalent SMS/push).
 *
 * Importe AuthModule pour les gardes SUPER_ADMIN. Sens unique (AuthModule n'utilise
 * rien d'ici) — voir la note de l'ancien EmailAdminModule sur le cycle à éviter.
 */
@Module({
  imports: [AuthModule],
  controllers: [CommunicationsController, EmailAdminController],
  providers: [CommunicationsService, EmailAdminService],
  exports: [CommunicationsService],
})
export class CommunicationsModule {}
