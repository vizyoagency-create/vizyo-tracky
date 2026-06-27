import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AudioMonitoringController } from './audio-monitoring.controller';
import { AudioMonitoringGuard } from './audio-monitoring.guard';

/**
 * Sprint 4 — Module écoute audio (Phase 2 : SÉCURITÉ uniquement).
 *
 * ⚠️ VOLONTAIREMENT NON enregistré dans app.module.ts : on ne touche pas au boot
 * applicatif tant que le bloc sécurité n'a pas été revu (cf. docs/sprint-4/PLAN.md
 * §4 — STOP). L'enregistrement (+ service, modèles Prisma, mail, UI) = Phase 3.
 */
@Module({
  imports: [AuthModule],
  controllers: [AudioMonitoringController],
  providers: [AudioMonitoringGuard],
})
export class AudioMonitoringModule {}
