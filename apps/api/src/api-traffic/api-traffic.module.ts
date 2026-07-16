import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiTrafficAdminController } from './api-traffic-admin.controller';
import { ApiTrafficInterceptor } from './api-traffic.interceptor';
import { ApiTrafficService } from './api-traffic.service';
import { PartnerActivityController } from './partner-activity.controller';

/**
 * Observabilité du trafic API PUBLIC + intelligence IP (demande client 2026-07).
 *
 * @Global : ApiTrafficService est injectable partout (record() best-effort). L'APP_INTERCEPTOR
 * est déclaré ICI (et non dans app.module) pour que l'interceptor résolve ApiTrafficService
 * dans le même injecteur. OwnerVisibilityService + PrismaService sont déjà @Global.
 */
@Global()
@Module({
  controllers: [PartnerActivityController, ApiTrafficAdminController],
  providers: [
    ApiTrafficService,
    { provide: APP_INTERCEPTOR, useClass: ApiTrafficInterceptor },
  ],
  exports: [ApiTrafficService],
})
export class ApiTrafficModule {}
