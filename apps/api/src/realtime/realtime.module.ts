import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PositionsModule } from '../positions/positions.module';
import { MockPositionEmitterService } from './mock-position-emitter.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [AuthModule, forwardRef(() => PositionsModule)],
  providers: [RealtimeGateway, MockPositionEmitterService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
