import { Module } from '@nestjs/common';
import { AuthClientModule } from '../auth-client/auth-client.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { UsersController } from './users.controller';

@Module({
  imports: [AuthModule, AuthClientModule, EmailModule, InvitationsModule],
  controllers: [UsersController],
})
export class UsersModule {}
