import { Global, Module } from '@nestjs/common';
import { SocketRegistryService } from './socket-registry.service';

@Global()
@Module({
  providers: [SocketRegistryService],
  exports: [SocketRegistryService],
})
export class SocketRegistryModule {}
