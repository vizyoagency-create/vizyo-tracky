import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { EngineControlModule } from './engine-control/engine-control.module';
import { GeofencesModule } from './geofences/geofences.module';
import { TripsModule } from './trips/trips.module';
import { PositionsModule } from './positions/positions.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SocketRegistryModule } from './socket-registry/socket-registry.module';
import { TrackerTcpModule } from './tracker-tcp/tracker-tcp.module';
import { TrackersModule } from './trackers/trackers.module';
import { VehiclesModule } from './vehicles/vehicles.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    PrismaModule,
    SocketRegistryModule,
    AuthModule,
    PositionsModule,
    AlertsModule,
    EngineControlModule,
    GeofencesModule,
    TripsModule,
    VehiclesModule,
    TrackersModule,
    TrackerTcpModule,
    RealtimeModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
