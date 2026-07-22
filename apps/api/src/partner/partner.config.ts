import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

/**
 * Configuration de l'intégration partenaire (Tracky × Maestroo).
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §14.2
 */
@Injectable()
export class PartnerConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Le module est-il actif ?
   *
   * ⚠️ Exige le kill-switch ET une configuration COMPLÈTE. Un flag à `true` sans
   * secret laisserait croire que l'intégration fonctionne alors qu'elle rejetterait
   * toutes les requêtes (`verifyPartnerRequest` refuse tout sur un secret vide) —
   * on préfère un module franchement éteint à un module qui ment.
   */
  get enabled(): boolean {
    return (
      this.config.get('PARTNER_MAESTROO_ENABLED', { infer: true }) === 'true' &&
      this.platformSecret.length > 0 &&
      this.maestrooApiUrl.length > 0
    );
  }

  /** Le kill-switch seul, sans la vérification de complétude — pour le diagnostic. */
  get killSwitchOn(): boolean {
    return this.config.get('PARTNER_MAESTROO_ENABLED', { infer: true }) === 'true';
  }

  /**
   * Secret d'amorçage, partagé entre les deux DÉPLOIEMENTS (pas par client).
   * Ne sert qu'au handshake et aux webhooks ; chaque lien a ensuite le sien.
   */
  get platformSecret(): string {
    return this.config.get('PARTNER_PLATFORM_SECRET', { infer: true }) ?? '';
  }

  get maestrooApiUrl(): string {
    return (this.config.get('PARTNER_MAESTROO_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  /** Durée de vie du bail. Courte volontairement (filet si la purge Redis échoue). */
  get tokenTtlSeconds(): number {
    return this.config.get('PARTNER_TOKEN_TTL_SECONDS', { infer: true });
  }

  /**
   * Raison lisible pour laquelle le module est éteint — journalisée au démarrage,
   * pour qu'« intégration inactive » ne soit jamais un mystère en prod.
   */
  get disabledReason(): string | null {
    if (!this.killSwitchOn) return 'PARTNER_MAESTROO_ENABLED=false';
    if (!this.platformSecret) return 'PARTNER_PLATFORM_SECRET manquant';
    if (!this.maestrooApiUrl) return 'PARTNER_MAESTROO_API_URL manquant';
    return null;
  }
}
