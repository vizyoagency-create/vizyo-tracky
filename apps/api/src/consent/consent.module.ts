import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsentAdminController } from './consent-admin.controller';
import { ConsentController } from './consent.controller';
import { ConsentGateInterceptor } from './consent-gate.interceptor';
import { ConsentService } from './consent.service';

/**
 * Module de consentement RGPD. @Global pour que ConsentService soit injectable
 * partout (ex. futures instrumentations), et il enregistre le gate en
 * APP_INTERCEPTOR (global) tout en résolvant ConsentService dans le même injecteur
 * — même schéma que ApiTrafficModule.
 */
@Global()
@Module({
  // AuthModule importé pour que ConsentController/ConsentAdminController résolvent
  // JwtAuthGuard/RolesGuard (mêmes gardes que les autres vues protégées).
  imports: [PrismaModule, AuthModule],
  controllers: [ConsentController, ConsentAdminController],
  providers: [ConsentService, { provide: APP_INTERCEPTOR, useClass: ConsentGateInterceptor }],
  exports: [ConsentService],
})
export class ConsentModule {}
