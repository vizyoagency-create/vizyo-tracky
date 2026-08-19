import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from './config/env.validation';
import { AgendaModule } from './agenda/agenda.module';
import { AiCoreModule } from './ai/ai-core.module';
import { AiModule } from './ai/ai.module';
import { TripAnalysisModule } from './trip-analysis/trip-analysis.module';
import { AiUsageModule } from './ai-usage/ai-usage.module';
import { AssistanceModule } from './assistance/assistance.module';
import { BillingModule } from './billing/billing.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { ReservationBookingModule } from './reservation-booking/reservation-booking.module';
import { AlertsModule } from './alerts/alerts.module';
import { AudioMonitoringModule } from './audio-monitoring/audio-monitoring.module';
import { AuthClientModule } from './auth-client/auth-client.module';
import { AuthModule } from './auth/auth.module';
import { ConsentModule } from './consent/consent.module';
import { SecurityModule } from './security/security.module';
import { validateEnv } from './config/env.validation';
import { DriversModule } from './drivers/drivers.module';
import { EngineControlModule } from './engine-control/engine-control.module';
import { FleetsModule } from './fleets/fleets.module';
import { GeocodeModule } from './geocode/geocode.module';
import { GeofencesModule } from './geofences/geofences.module';
import { InstallationsModule } from './installations/installations.module';
import { InstallationBookingModule } from './installation-booking/installation-booking.module';
import { PrivacyModeModule } from './privacy-mode/privacy-mode.module';
import { InternalModule } from './internal/internal.module';
import { PartnerModule } from './partner/partner.module';
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
import { BackupHealthModule } from './backup-health/backup-health.module';
import { CacheModule } from './common/cache/cache.module';
import { OwnerVisibilityModule } from './common/owner-visibility.module';
import { EmailModule } from './email/email.module';
import { CommunicationsModule } from './communications/communications.module';
import { InvitationsModule } from './invitations/invitations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DepotModule } from './depot/depot.module';
import { MissionsModule } from './missions/missions.module';
import { PermissionsModule } from './permissions/permissions.module';
import { ReportsModule } from './reports/reports.module';
import { SimsModule } from './sims/sims.module';
import { SmsModule } from './sms/sms.module';
import { SurveillanceModule } from './surveillance/surveillance.module';
import { MutationAuditInterceptor } from './system-activity/mutation-audit.interceptor';
import { SystemActivityModule } from './system-activity/system-activity.module';
import { SystemMetricsModule } from './system-metrics/system-metrics.module';
import { TrackerCommandsModule } from './tracker-commands/tracker-commands.module';
import { UserActivityModule } from './user-activity/user-activity.module';
import { TrackerFixModeModule } from './tracker-fix-mode/tracker-fix-mode.module';
import { VehicleSchedulesModule } from './vehicle-schedules/vehicle-schedules.module';
import { BackgroundTasksModule } from './background-tasks/background-tasks.module';
import { GpsIntegrityModule } from './gps-integrity/gps-integrity.module';
import { GpsDeadZonesModule } from './gps-dead-zones/gps-dead-zones.module';
import { FleetPlacesModule } from './fleet-places/fleet-places.module';
import { HealthController } from './health/health.controller';
import { LeadsModule } from './leads/leads.module';
import { PublicStatsModule } from './public-stats/public-stats.module';
import { ApiTrafficModule } from './api-traffic/api-traffic.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { DriverUnlockApiModule } from './driver-unlock/driver-unlock-api.module';
import { AuditAlertesModule } from './audit-alertes/audit-alertes.module';
import { TrackerOnboardingModule } from './tracker-onboarding/tracker-onboarding.module';
import { UnknownTrackersModule } from './unknown-trackers/unknown-trackers.module';

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
    CacheModule,
    // « Owner » plateforme — invisibilité des comptes owner aux autres super-admins.
    // @Global : injectable partout (users, activité, IA, sérialiseurs d'action).
    OwnerVisibilityModule,
    SocketRegistryModule,
    AuthClientModule,
    AuthModule,
    PositionsModule,
    AlertsModule,
    EngineControlModule,
    FleetsModule,
    GeofencesModule,
    GeocodeModule,
    TripsModule,
    VehiclesModule,
    // feat/comptes-conducteurs (4b) — endpoint POST /driver/unlock (déverrouillage QR + proximité).
    DriverUnlockApiModule,
    TrackersModule,
    TrackerCommandsModule,
    TrackerFixModeModule,
    TrackerTcpModule,
    SmsModule,
    BackupHealthModule,
    EmailModule,
    CommunicationsModule,
    InvitationsModule,
    NotificationsModule,
    ReportsModule,
    SimsModule,
    ObservabilityModule,
    // Palier B — journal des actions auto/système (arrière-plan), @Global comme Observability.
    SystemActivityModule,
    RealtimeModule,
    VehicleAccessModule,
    VehicleGroupsModule,
    PermissionsModule,
    // Espace dépôt (2026-08) — périmètre du rôle DEPOT + son garde. @Global comme
    // PermissionsModule : le garde se pose sur des contrôleurs existants.
    DepotModule,
    // Espace dépôt (2026-08) — les missions, côté transporteur (lot A2).
    MissionsModule,
    VehicleSchedulesModule,
    BackgroundTasksModule,
    GpsIntegrityModule,
    GpsDeadZonesModule,
    FleetPlacesModule,
    InstallationsModule,
    InstallationBookingModule,
    PrivacyModeModule,
    InternalModule,
    // Integration partenaire (Tracky x Maestroo) — lot 0. Inerte tant que
    // PARTNER_MAESTROO_ENABLED n'est pas a true.
    PartnerModule,
    LeadsModule,
    // D5 (chantier commercial) — chiffres publics de la LP (compteur de véhicules, cache 5 min).
    PublicStatsModule,
    // Observabilité du trafic API PUBLIC + intelligence IP (demande client 2026-07).
    // @Global : self-enregistre son APP_INTERCEPTOR (capture des hits publics / non authentifiés).
    ApiTrafficModule,
    UsersModule,
    DriversModule,
    SurveillanceModule,
    SystemMetricsModule,
    UserActivityModule,
    AuditAlertesModule,
    TrackerOnboardingModule,
    UnknownTrackersModule,
    // Sprint 4 — écoute audio (micro embarqué), LÉGALEMENT CRITIQUE. Device MOCKÉ ;
    // en prod l'écoute reste impossible sans AUDIO_MONITORING_ENABLED='true' (#2).
    AudioMonitoringModule,
    AgendaModule,
    // Couche IA multi-provider (@Global) : moteurs Claude/GPT + routeur + réglage de provider.
    // Injectable partout (agenda, réservation, rapports, optimiseur, analyse de trajets) sans cycle.
    AiCoreModule,
    // Sprint 9 — Copilote IA d'optimisation (capacité + placement). Inactif sans
    // ANTHROPIC_API_KEY (endpoints 503). L'IA propose, l'app valide.
    AiModule,
    // Facturation (2026-07) — option IA payante (Stripe). No-op sans STRIPE_SECRET_KEY.
    BillingModule,
    // Palier « Coûts IA » — journalise l'usage/coût de chaque appel IA + budget (super-admin).
    AiUsageModule,
    // Assistance IA (2026-08) — repond EN DIRECT aux questions sur l'application, en lecture
    // seule, et archive tout pour relecture. Seul poste qui depense volontairement de l'IA.
    AssistanceModule,
    // Traçabilité fine des trajets (Palier 2) — analyse déterministe (arrêts, excès OSM, éco) persistée.
    TripAnalysisModule,
    // Refonte agenda/IA (P3) — géocodage inverse (Nominatim) pour nommer les destinations récurrentes.
    GeocodingModule,
    // Refonte agenda/IA (P4) — lien public de demande de réservation (société fixe).
    ReservationBookingModule,
    // RGPD — consentements (CGU/Confidentialité app + bandeau LP). @Global : self-
    // enregistre le gate en APP_INTERCEPTOR (403 CONSENT_REQUIRED sans accord).
    ConsentModule,
    // Sécurité — 2FA app OPT-IN adaptatif (code e-mail sur anomalie) + journal/carte
    // des connexions géo-IP. @Global : self-enregistre le gate (403 DEVICE_VERIFICATION_REQUIRED).
    SecurityModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Audit « altitude » — toute mutation HTTP journalisée dans l'onglet Système
    // (catégorie MUTATION). Après les guards → req.user disponible.
    {
      provide: APP_INTERCEPTOR,
      useClass: MutationAuditInterceptor,
    },
  ],
})
export class AppModule {}
