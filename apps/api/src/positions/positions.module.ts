import { forwardRef, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { PositionsService } from './positions.service';

@Module({
  imports: [forwardRef(() => RealtimeModule)],
  providers: [PositionsService],
  exports: [PositionsService],
})
export class PositionsModule {}
