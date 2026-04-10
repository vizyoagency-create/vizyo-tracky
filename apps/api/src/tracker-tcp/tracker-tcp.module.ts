import { forwardRef, Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PositionsModule } from '../positions/positions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TcpServerService } from './tcp-server.service';

@Module({
  imports: [PositionsModule, AlertsModule, forwardRef(() => RealtimeModule)],
  providers: [TcpServerService],
})
export class TrackerTcpModule {}
