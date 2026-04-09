import { Module } from '@nestjs/common';
import { SocketRegistryService } from './socket-registry.service';
import { TcpServerService } from './tcp-server.service';

@Module({
  providers: [SocketRegistryService, TcpServerService],
  exports: [SocketRegistryService],
})
export class TrackerTcpModule {}
