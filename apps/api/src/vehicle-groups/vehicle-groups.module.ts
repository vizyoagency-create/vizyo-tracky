import { Module } from '@nestjs/common';
import { VehicleGroupsController } from './vehicle-groups.controller';

@Module({
  controllers: [VehicleGroupsController],
})
export class VehicleGroupsModule {}
