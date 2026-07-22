import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemActivityModule } from '../system-activity/system-activity.module';
import { PartnerAdminController } from './partner-admin.controller';
import { PartnerAdminService } from './partner-admin.service';
import { PartnerApiController } from './partner-api.controller';
import { PartnerClientService } from './partner-client.service';
import { PartnerOutboxService } from './partner-outbox.service';
import { PartnerRevocationService } from './partner-revocation.service';
import { PartnerConfigService } from './partner.config';
import { PartnerTokenGuard } from './partner-token.guard';
import { PartnerTokenService } from './partner-token.service';
import { PartnerController } from './partner.controller';
import { PartnerPairingService } from './partner-pairing.service';
import { PartnerSignatureGuard } from './partner-signature.guard';

/**
 * Socle de l'intégration partenaire (Tracky × Maestroo) — lot 0.
 *
 * Ne contient ENCORE aucune route ni aucune donnée métier : uniquement la
 * configuration et la vérification de signature, sur lesquelles s'appuieront le
 * handshake (incr. 0.4b) puis le bail et la révocation.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md
 */
@Module({
  // AuthModule : requis par JwtAuthGuard sur les routes client.
  imports: [AuthModule, PrismaModule, SystemActivityModule],
  controllers: [PartnerController, PartnerApiController, PartnerAdminController],
  providers: [
    PartnerConfigService,
    PartnerSignatureGuard,
    PartnerClientService,
    PartnerPairingService,
    PartnerTokenService,
    PartnerTokenGuard,
    PartnerRevocationService,
    PartnerOutboxService,
    PartnerAdminService,
  ],
  exports: [PartnerConfigService, PartnerSignatureGuard, PartnerTokenService, PartnerRevocationService],
})
export class PartnerModule implements OnModuleInit {
  private readonly logger = new Logger(PartnerModule.name);

  constructor(private readonly config: PartnerConfigService) {}

  /**
   * Journalise l'état au démarrage. « L'intégration ne marche pas » ne doit jamais
   * être une énigme : si le module est éteint, le log dit POURQUOI (kill-switch,
   * secret manquant, URL manquante).
   */
  onModuleInit(): void {
    const reason = this.config.disabledReason;
    if (reason) {
      this.logger.log(`Intégration Maestroo INACTIVE — ${reason}`);
    } else {
      this.logger.log(`Intégration Maestroo active — pair : ${this.config.maestrooApiUrl}`);
    }
  }
}
