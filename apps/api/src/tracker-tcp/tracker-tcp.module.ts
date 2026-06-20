import { forwardRef, Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PositionsModule } from '../positions/positions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TrackerCommandsModule } from '../tracker-commands/tracker-commands.module';
import { UnknownTrackersModule } from '../unknown-trackers/unknown-trackers.module';
import { TcpServerService } from './tcp-server.service';

@Module({
  imports: [
    PositionsModule,
    AlertsModule,
    forwardRef(() => RealtimeModule),
    forwardRef(() => TrackerCommandsModule),
    UnknownTrackersModule,
  ],
  providers: [TcpServerService],
})
export class TrackerTcpModule {}
