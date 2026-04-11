import { Global, Module } from '@nestjs/common';
import { VehicleAccessService } from './vehicle-access.service';

@Global()
@Module({
  providers: [VehicleAccessService],
  exports: [VehicleAccessService],
})
export class VehicleAccessModule {}
