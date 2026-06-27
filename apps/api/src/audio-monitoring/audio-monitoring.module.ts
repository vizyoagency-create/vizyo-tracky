import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { AudioAutoDisarmService } from './audio-auto-disarm.service';
import { AudioMonitoringController } from './audio-monitoring.controller';
import { AudioMonitoringGuard } from './audio-monitoring.guard';
import { AudioMonitoringService } from './audio-monitoring.service';

/**
 * Sprint 4 — Module écoute audio à distance (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A confirmé : appel live (le serveur arme le micro + audite, l'admin appelle
 * la SIM) — aucun clip reçu/stocké. ARMEMENT RÉEL via SMS Coban (`monitor<pwd>` /
 * `tracker<pwd>`) — un SMS RÉEL part vers un BOÎTIER RÉEL au déclenchement (gating amont
 * inchangé = seule barrière).
 *
 * DI : AuthModule fournit JwtAuthGuard/RolesGuard. SmsModule fournit SmsGatewayService
 * (ARM/DISARM réel — même passerelle que le coupe-circuit). PrismaService, PermissionsResolver
 * (PermissionsGuard), EmailService, ConfigService et ErrorLogger sont GLOBAUX (PrismaModule,
 * PermissionsModule, EmailModule, ObservabilityModule @Global + ConfigModule root) → injectés
 * sans import explicite. AudioAutoDisarmService porte le filet de sécurité (cron : aucun
 * véhicule laissé en monitor au-delà de la fenêtre). Rien n'est exporté.
 */
@Module({
  imports: [AuthModule, SmsModule],
  controllers: [AudioMonitoringController],
  providers: [AudioMonitoringGuard, AudioMonitoringService, AudioAutoDisarmService],
})
export class AudioMonitoringModule {}
