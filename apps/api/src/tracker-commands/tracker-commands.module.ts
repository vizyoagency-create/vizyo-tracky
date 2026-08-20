import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
// Le SMS est le canal REEL de 19 gabarits du catalogue, pas un accessoire.
import { SmsModule } from '../sms/sms.module';
import { AckWaiterService } from './ack-waiter.service';
import { CommandsHistoryController } from './commands-history.controller';
import { TrackerCommandsController } from './tracker-commands.controller';
import { TrackerCommandsSchedulerService } from './tracker-commands-scheduler.service';
import { TrackerCommandsService } from './tracker-commands.service';

@Module({
  imports: [AuthModule, forwardRef(() => RealtimeModule), forwardRef(() => SmsModule)],
  controllers: [TrackerCommandsController, CommandsHistoryController],
  providers: [
    AckWaiterService,
    TrackerCommandsService,
    TrackerCommandsSchedulerService,
  ],
  exports: [AckWaiterService, TrackerCommandsService],
})
export class TrackerCommandsModule {}
