import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AckWaiterService } from './ack-waiter.service';
import { CommandsHistoryController } from './commands-history.controller';
import { TrackerCommandsController } from './tracker-commands.controller';
import { TrackerCommandsSchedulerService } from './tracker-commands-scheduler.service';
import { TrackerCommandsService } from './tracker-commands.service';

@Module({
  imports: [AuthModule, forwardRef(() => RealtimeModule)],
  controllers: [TrackerCommandsController, CommandsHistoryController],
  providers: [
    AckWaiterService,
    TrackerCommandsService,
    TrackerCommandsSchedulerService,
  ],
  exports: [AckWaiterService, TrackerCommandsService],
})
export class TrackerCommandsModule {}
