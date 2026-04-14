import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FleetsController } from './fleets.controller';
import { FleetsService } from './fleets.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FleetsController],
  providers: [FleetsService],
  exports: [FleetsService],
})
export class FleetsModule {}
