import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { TrackerCommandsModule } from '../tracker-commands/tracker-commands.module';
import { SocketRegistryModule } from '../socket-registry/socket-registry.module';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminFixModeController } from './admin-fix-mode.controller';
import { TrackerFixModeService } from './tracker-fix-mode.service';

@Module({
  // TrackerCommandsModule exporte AckWaiterService (TRK-014 : ecouter la reponse du
  // boitier sur le chemin adaptatif). Un module dont le service injecte une dependance
  // qu'il n'importe pas echoue au BOOT, pas a la compilation — d'ou le smoke-boot.
  imports: [AuthModule, SocketRegistryModule, SmsModule, TrackerCommandsModule],
  controllers: [AdminAlertsController, AdminFixModeController],
  providers: [TrackerFixModeService],
  exports: [TrackerFixModeService],
})
export class TrackerFixModeModule {}
