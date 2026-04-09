import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PositionsModule } from '../positions/positions.module';
import { TcpServerService } from './tcp-server.service';

@Module({
  imports: [PositionsModule, AlertsModule],
  providers: [TcpServerService],
})
export class TrackerTcpModule {}
