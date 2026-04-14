import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from './config/env.validation';
import { AlertsModule } from './alerts/alerts.module';
import { AuthClientModule } from './auth-client/auth-client.module';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { EngineControlModule } from './engine-control/engine-control.module';
import { FleetsModule } from './fleets/fleets.module';
import { GeofencesModule } from './geofences/geofences.module';
import { InternalModule } from './internal/internal.module';
import { TripsModule } from './trips/trips.module';
import { PositionsModule } from './positions/positions.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SocketRegistryModule } from './socket-registry/socket-registry.module';
import { TrackerTcpModule } from './tracker-tcp/tracker-tcp.module';
import { TrackersModule } from './trackers/trackers.module';
import { UsersModule } from './users/users.module';
import { VehicleAccessModule } from './vehicle-access/vehicle-access.module';
import { VehicleGroupsModule } from './vehicle-groups/vehicle-groups.module';
import { ObservabilityModule } from './observability/observability.module';
import { TrackerCommandsModule } from './tracker-commands/tracker-commands.module';
import { VehicleSchedulesModule } from './vehicle-schedules/vehicle-schedules.module';
import { VehiclesModule } from './vehicles/vehicles.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          transport:
            config.get('NODE_ENV', { infer: true }) !== 'production'
              ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
              : undefined,
          redact: ['req.headers.authorization', '*.password', '*.token', '*.secret'],
          serializers: {
            req: (req: Record<string, unknown>) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: Record<string, unknown>) => ({
              statusCode: res.statusCode,
            }),
          },
        },
      }),
    }),
    PrismaModule,
    SocketRegistryModule,
    AuthClientModule,
    AuthModule,
    PositionsModule,
    AlertsModule,
    EngineControlModule,
    FleetsModule,
    GeofencesModule,
    TripsModule,
    VehiclesModule,
    TrackersModule,
    TrackerCommandsModule,
    TrackerTcpModule,
    ObservabilityModule,
    RealtimeModule,
    VehicleAccessModule,
    VehicleGroupsModule,
    VehicleSchedulesModule,
    InternalModule,
    UsersModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
