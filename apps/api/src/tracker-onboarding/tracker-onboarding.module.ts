import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SmsModule } from '../sms/sms.module';
import { SystemActivityModule } from '../system-activity/system-activity.module';
import { UnknownTrackersModule } from '../unknown-trackers/unknown-trackers.module';
import { ProvisioningVehiculeService } from './provisioning-vehicule.service';
import { RattachementService } from './rattachement.service';
import { TrackerOnboardingController } from './tracker-onboarding.controller';
import { TrackerOnboardingService } from './tracker-onboarding.service';
import { VerrouProvisioningRegistry } from './verrou-provisioning.registry';

/** Mise en service d'un boîtier : résolution d'un code scanné, puis rattachement. */
@Module({
  imports: [AuthModule, PrismaModule, SmsModule, SystemActivityModule, UnknownTrackersModule],
  controllers: [TrackerOnboardingController],
  providers: [TrackerOnboardingService, VerrouProvisioningRegistry, RattachementService, ProvisioningVehiculeService],
  exports: [TrackerOnboardingService, VerrouProvisioningRegistry, RattachementService, ProvisioningVehiculeService],
})
export class TrackerOnboardingModule {}
