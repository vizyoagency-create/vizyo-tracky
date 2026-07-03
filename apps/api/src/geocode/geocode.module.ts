import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GeocodeController } from './geocode.controller';
import { GeocodeService } from './geocode.service';

// AuthModule fournit AuthService + JwtAuthGuard (dépendance du @UseGuards du
// controller). Sans cet import, Nest ne peut pas résoudre JwtAuthGuard.
@Module({
  imports: [AuthModule],
  controllers: [GeocodeController],
  providers: [GeocodeService],
})
export class GeocodeModule {}
