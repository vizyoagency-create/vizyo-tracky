import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SmsModule } from '../sms/sms.module';
import { TrackerCommandsModule } from '../tracker-commands/tracker-commands.module';
import { EngineControlController } from './engine-control.controller';
import { EngineControlService } from './engine-control.service';

@Module({
  imports: [
    AuthModule,
    SmsModule,
    forwardRef(() => TrackerCommandsModule),
    forwardRef(() => RealtimeModule),
  ],
  controllers: [EngineControlController],
  providers: [EngineControlService],
  exports: [EngineControlService],
})
export class EngineControlModule {}
