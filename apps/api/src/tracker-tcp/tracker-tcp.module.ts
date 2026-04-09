import { Module } from '@nestjs/common';
import { PositionsModule } from '../positions/positions.module';
import { TcpServerService } from './tcp-server.service';

@Module({
  imports: [PositionsModule],
  providers: [TcpServerService],
})
export class TrackerTcpModule {}
