import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VehicleGroupsController } from './vehicle-groups.controller';

@Module({
  imports: [AuthModule],
  controllers: [VehicleGroupsController],
})
export class VehicleGroupsModule {}
