import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { InternalSecretGuard } from './internal-secret.guard';

@Module({
  controllers: [InternalController],
  providers: [InternalSecretGuard],
})
export class InternalModule {}
