import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MockPositionEmitterService } from './mock-position-emitter.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, MockPositionEmitterService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
