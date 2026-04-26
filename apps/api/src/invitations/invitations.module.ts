import { Module } from '@nestjs/common';
import { AuthClientModule } from '../auth-client/auth-client.module';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [AuthClientModule],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
