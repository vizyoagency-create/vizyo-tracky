import { Module } from '@nestjs/common';
import { AuthClientModule } from '../auth-client/auth-client.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { AuthAccountSyncService } from './auth-account-sync.service';
import { UsersController } from './users.controller';

@Module({
  imports: [AuthModule, AuthClientModule, EmailModule, InvitationsModule],
  controllers: [UsersController],
  providers: [AuthAccountSyncService],
  // Exporté pour la purge des comptes de démonstration : suspendre dans Vizyo Auth est le
  // seul geste qui empêche réellement une reconnexion.
  exports: [AuthAccountSyncService],
})
export class UsersModule {}
