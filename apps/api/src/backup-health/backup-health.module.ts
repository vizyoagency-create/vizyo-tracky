import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BackupHealthController } from './backup-health.controller';
import { BackupHealthService } from './backup-health.service';

@Module({
  imports: [AuthModule],
  controllers: [BackupHealthController],
  providers: [BackupHealthService],
  exports: [BackupHealthService],
})
export class BackupHealthModule {}
