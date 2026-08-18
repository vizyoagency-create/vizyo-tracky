import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemActivityModule } from '../system-activity/system-activity.module';
import { UnknownTrackersModule } from '../unknown-trackers/unknown-trackers.module';
import { RattachementService } from './rattachement.service';
import { TrackerOnboardingController } from './tracker-onboarding.controller';
import { TrackerOnboardingService } from './tracker-onboarding.service';
import { VerrouProvisioningRegistry } from './verrou-provisioning.registry';

/** Mise en service d'un boîtier : résolution d'un code scanné, puis rattachement. */
@Module({
  imports: [AuthModule, PrismaModule, SystemActivityModule, UnknownTrackersModule],
  controllers: [TrackerOnboardingController],
  providers: [TrackerOnboardingService, VerrouProvisioningRegistry, RattachementService],
  exports: [TrackerOnboardingService, VerrouProvisioningRegistry, RattachementService],
})
export class TrackerOnboardingModule {}
