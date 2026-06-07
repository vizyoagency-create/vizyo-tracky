import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SimsController } from './sims.controller';
import { SimsService } from './sims.service';
import { SimsSyncService } from './sims-sync.service';
import { WhereverSimClient } from './whereversim.client';

/**
 * V1.16 — Parc de cartes SIM M2M (WhereverSIM).
 * PrismaModule, PermissionsModule (PermissionsGuard) et ConfigModule sont globaux ;
 * on importe AuthModule pour le JwtAuthGuard. SimsSyncService porte le cron de sync.
 */
@Module({
  imports: [AuthModule],
  controllers: [SimsController],
  providers: [SimsService, SimsSyncService, WhereverSimClient],
  exports: [SimsService],
})
export class SimsModule {}
