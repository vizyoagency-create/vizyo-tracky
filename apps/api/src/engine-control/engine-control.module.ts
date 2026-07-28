import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GpsDeadZonesModule } from '../gps-dead-zones/gps-dead-zones.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SmsModule } from '../sms/sms.module';
import { TrackerCommandsModule } from '../tracker-commands/tracker-commands.module';
import { EngineControlController } from './engine-control.controller';
import { EngineControlService } from './engine-control.service';

@Module({
  imports: [
    AuthModule,
    SmsModule,
    // La sentinelle « coupure invérifiable » consulte les zones mortes GPS : une perte de
    // signal EXPLIQUÉE (parking souterrain confirmé) ne doit pas produire d'alerte.
    GpsDeadZonesModule,
    forwardRef(() => TrackerCommandsModule),
    forwardRef(() => RealtimeModule),
  ],
  controllers: [EngineControlController],
  providers: [EngineControlService],
  exports: [EngineControlService],
})
export class EngineControlModule {}
