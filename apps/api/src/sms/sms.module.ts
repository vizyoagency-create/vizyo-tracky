import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AllowlistService } from './allowlist.service';
import { SmsAdminController } from './sms-admin.controller';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsHeartbeatService } from './sms-heartbeat.service';
import { SmsWebhookController } from './sms-webhook.controller';
import { TrackerProvisioningService } from './tracker-provisioning.service';

@Module({
  imports: [AuthModule],
  controllers: [SmsAdminController, SmsWebhookController],
  providers: [SmsGatewayService, TrackerProvisioningService, AllowlistService, SmsHeartbeatService],
  exports: [SmsGatewayService, TrackerProvisioningService],
})
export class SmsModule {}
