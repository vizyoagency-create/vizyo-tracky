import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditAlertesController } from './audit-alertes.controller';
import { AuditAlertesService } from './audit-alertes.service';

/** Audit des alertes et de leurs trames — outil de diagnostic super-admin. */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AuditAlertesController],
  providers: [AuditAlertesService],
})
export class AuditAlertesModule {}
