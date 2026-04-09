import { forwardRef, Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { PositionsModule } from '../positions/positions.module';
import { MockPositionEmitterService } from './mock-position-emitter.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [AuthModule, forwardRef(() => PositionsModule), forwardRef(() => AlertsModule)],
  providers: [RealtimeGateway, MockPositionEmitterService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
