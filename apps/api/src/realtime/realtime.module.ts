import { forwardRef, Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { PositionsModule } from '../positions/positions.module';
import { MockPositionEmitterService } from './mock-position-emitter.service';
import { PositionBroadcastBuffer } from './position-broadcast-buffer.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeIncidentController } from './realtime-incident.controller';

@Module({
  imports: [AuthModule, forwardRef(() => PositionsModule), forwardRef(() => AlertsModule)],
  controllers: [RealtimeIncidentController],
  providers: [RealtimeGateway, MockPositionEmitterService, PositionBroadcastBuffer],
  exports: [RealtimeGateway, PositionBroadcastBuffer],
})
export class RealtimeModule {}
