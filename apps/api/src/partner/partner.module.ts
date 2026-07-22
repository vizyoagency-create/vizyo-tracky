import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { PartnerConfigService } from './partner.config';
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
  providers: [PartnerConfigService, PartnerSignatureGuard],
  exports: [PartnerConfigService, PartnerSignatureGuard],
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
