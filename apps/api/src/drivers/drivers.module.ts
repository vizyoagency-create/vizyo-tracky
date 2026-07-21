import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { WorkTimeService } from './work-time.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [DriversController],
  providers: [DriversService, WorkTimeService],
  exports: [DriversService],
})
export class DriversModule {}
