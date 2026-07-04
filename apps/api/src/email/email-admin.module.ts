import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailAdminController } from './email-admin.controller';
import { EmailAdminService } from './email-admin.service';

/**
 * Centre e-mails admin — SÉPARÉ d'EmailModule (@Global) volontairement.
 *
 * Ce module importe AuthModule (guards SUPER_ADMIN). Or AuthModule dépend déjà
 * d'EmailService (reset mot de passe) via le scope @Global. Importer AuthModule
 * DANS EmailModule créerait un cycle d'instanciation. Ici le sens est unique :
 * EmailAdminModule → AuthModule (AuthModule n'utilise rien de ce module).
 * EmailAdminService consomme EmailService + PrismaService via le scope @Global.
 */
@Module({
  imports: [AuthModule],
  controllers: [EmailAdminController],
  providers: [EmailAdminService],
})
export class EmailAdminModule {}
