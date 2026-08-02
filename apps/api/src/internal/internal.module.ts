import { Module } from '@nestjs/common';
import { AuthAccountSyncService } from '../users/auth-account-sync.service';
import { InternalController } from './internal.controller';
import { InternalSecretGuard } from './internal-secret.guard';

@Module({
  controllers: [InternalController],
  providers: [InternalSecretGuard, AuthAccountSyncService],
})
export class InternalModule {}
