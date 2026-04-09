import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngineControlController } from './engine-control.controller';
import { EngineControlService } from './engine-control.service';

@Module({
  imports: [AuthModule],
  controllers: [EngineControlController],
  providers: [EngineControlService],
  exports: [EngineControlService],
})
export class EngineControlModule {}
