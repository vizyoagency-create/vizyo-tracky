import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { SocketRegistryModule } from '../socket-registry/socket-registry.module';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminFixModeController } from './admin-fix-mode.controller';
import { TrackerFixModeService } from './tracker-fix-mode.service';

@Module({
  imports: [AuthModule, SocketRegistryModule, SmsModule],
  controllers: [AdminAlertsController, AdminFixModeController],
  providers: [TrackerFixModeService],
  exports: [TrackerFixModeService],
})
export class TrackerFixModeModule {}
