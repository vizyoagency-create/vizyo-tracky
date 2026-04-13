import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AdminLogsController } from './admin-logs.controller';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { CobanWireLogger } from './coban-wire-logger.service';
import { ErrorLogger } from './error-logger.service';
import { LogCleanupService } from './log-cleanup.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminLogsController],
  providers: [
    CobanWireLogger,
    ErrorLogger,
    LogCleanupService,
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
  exports: [CobanWireLogger, ErrorLogger],
})
export class ObservabilityModule {}
