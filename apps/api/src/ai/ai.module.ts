import { Module } from '@nestjs/common';
import { AgendaModule } from '../agenda/agenda.module';
import { AuthModule } from '../auth/auth.module';
import { ObservabilityModule } from '../observability/observability.module';
import { AiOptimizationController } from './ai-optimization.controller';
import { AiOptimizationService } from './ai-optimization.service';
import { AiStatusController } from './ai-status.controller';

/**
 * Sprint 9 — Copilote IA d'optimisation (capacité + placement). Réutilise les
 * services S8 via AgendaModule (Reservations/Forecast/VehicleEvents) ; PrismaService
 * et VehicleAccessService sont globaux ; AuthModule fournit les guards. Inactif sans
 * ANTHROPIC_API_KEY (les endpoints renvoient 503) — l'app continue de tourner.
 */
@Module({
  imports: [AuthModule, AgendaModule, ObservabilityModule],
  controllers: [AiOptimizationController, AiStatusController],
  providers: [AiOptimizationService],
})
export class AiModule {}
