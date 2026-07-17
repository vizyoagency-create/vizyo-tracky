import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GeoipService } from './geoip.service';
import { SecurityAdminController } from './security-admin.controller';
import { SecurityController } from './security.controller';
import { SecurityGateInterceptor } from './security-gate.interceptor';
import { SecurityService } from './security.service';

/**
 * Sécurité des connexions — 2FA app opt-in adaptatif + journal/carte de connexions.
 * @Global (comme le module de consentement) : le service est injectable partout et
 * le gate est enregistré en APP_INTERCEPTOR. AuthModule pour JwtAuthGuard/RolesGuard ;
 * AuthClientService et EmailService sont déjà @Global.
 */
@Global()
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SecurityController, SecurityAdminController],
  providers: [
    SecurityService,
    GeoipService,
    { provide: APP_INTERCEPTOR, useClass: SecurityGateInterceptor },
  ],
  exports: [SecurityService],
})
export class SecurityModule {}
