import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';

/**
 * Palier « Coûts IA ». @Global : le recorder `AiUsageService` est injecté dans le module IA
 * (AiOptimizationService) sans import croisé, comme l'ErrorLogger de l'observabilité.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AiUsageController],
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}
