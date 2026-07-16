import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
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
  imports: [PrismaModule],
  controllers: [ConsentController],
  providers: [ConsentService, { provide: APP_INTERCEPTOR, useClass: ConsentGateInterceptor }],
  exports: [ConsentService],
})
export class ConsentModule {}
