import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UserActivityController } from './user-activity.controller';
import { UserActivityService } from './user-activity.service';

/** User activity tracking. PrismaService est global ; AuthModule fournit les guards. */
@Module({
  imports: [AuthModule],
  controllers: [UserActivityController],
  providers: [UserActivityService],
})
export class UserActivityModule {}
