import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AudioMonitoringController } from './audio-monitoring.controller';
import { AudioMonitoringGuard } from './audio-monitoring.guard';
import { AudioMonitoringService } from './audio-monitoring.service';

/**
 * Sprint 4 — Module écoute audio à distance (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A confirmé : appel live (le serveur arme le micro + audite, l'admin appelle
 * la SIM) — aucun clip reçu/stocké. Device MOCKÉ dans le service.
 *
 * DI : AuthModule fournit JwtAuthGuard/RolesGuard. PrismaService, PermissionsResolver
 * (PermissionsGuard), EmailService et ConfigService sont GLOBAUX (PrismaModule,
 * PermissionsModule, EmailModule @Global + ConfigModule root) → injectés sans import
 * explicite. Le service injecte Prisma + Email + Config. Rien n'est exporté.
 */
@Module({
  imports: [AuthModule],
  controllers: [AudioMonitoringController],
  providers: [AudioMonitoringGuard, AudioMonitoringService],
})
export class AudioMonitoringModule {}
