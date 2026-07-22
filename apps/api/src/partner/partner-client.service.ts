import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PartnerConfigService } from './partner.config';
import { signPartnerRequest } from './partner-signature';

/** Ce que le partenaire renvoie pour l'écran de consentement. */
export interface PartnerPairingDetails {
  organizationId: string;
  organizationName: string;
  siret: string | null;
  requestedByUserId: string | null;
  expiresAt: string;
}

/** Levée quand le partenaire répond une erreur MÉTIER (4xx) — la faute est côté demande. */
export class PartnerRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Partenaire ${status}`);
    this.name = 'PartnerRemoteError';
  }
}

/**
 * Client HTTP signé vers l'API partenaire (Maestroo).
 *
 * ⚠️ Distingue systématiquement une erreur MÉTIER du partenaire (4xx — on relaie) d'une
 * PANNE (réseau, 5xx, timeout — on lève `ServiceUnavailableException`). Cette
 * distinction est la même que celle qui, plus tard, séparera « révoqué » de
 * « injoignable » : mélanger les deux est le défaut qui ferait purger sur une panne.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §5, §8.4
 */
@Injectable()
export class PartnerClientService {
  private readonly logger = new Logger(PartnerClientService.name);
  /** Toute requête partenaire est bornée : sans timeout, une panne du pair bloque un worker. */
  private static readonly TIMEOUT_MS = 10_000;

  constructor(private readonly config: PartnerConfigService) {}

  async readPairing(code: string): Promise<PartnerPairingDetails> {
    return this.request<PartnerPairingDetails>(
      'GET',
      `/partner/v1/pairing/${encodeURIComponent(code)}`,
      'partner.pairing.read',
    );
  }

  async completePairing(
    code: string,
    body: { remoteLinkId: string; fleetName: string; linkSecret: string; scopes: string[] },
  ): Promise<void> {
    await this.request('POST', `/partner/v1/pairing/${encodeURIComponent(code)}/complete`, 'partner.pairing.complete', body);
  }

  /** Compensation best-effort : n'échoue JAMAIS bruyamment, elle rattrape déjà un échec. */
  async abortPairing(code: string, remoteLinkId: string): Promise<void> {
    try {
      await this.request('POST', `/partner/v1/pairing/${encodeURIComponent(code)}/abort`, 'partner.pairing.abort', {
        remoteLinkId,
      });
    } catch (err) {
      this.logger.error(
        `Compensation ECHOUEE pour le lien ${remoteLinkId} — le partenaire peut afficher « connecte » a tort : ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Émet un webhook signé vers le partenaire.
   *
   * `eventId` est la clé d'idempotence : le receveur doit pouvoir ignorer un rejeu
   * sans produire deux purges.
   */
  async sendWebhook(input: { eventId: string; type: string; payload: unknown }): Promise<void> {
    await this.request('POST', '/partner/v1/webhooks', 'partner.webhook', input);
  }

  private async request<T>(method: string, path: string, op: string, body?: unknown): Promise<T> {
    // Le corps est sérialisé UNE SEULE FOIS : c'est cette chaîne exacte qui est
    // signée ET envoyée. Re-sérialiser pour l'envoi produirait potentiellement
    // d'autres octets et la signature échouerait.
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const headers = signPartnerRequest(this.config.platformSecret, { method, op, rawBody });

    let res: Response;
    try {
      res = await fetch(`${this.config.maestrooApiUrl}${path}`, {
        method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : rawBody,
        signal: AbortSignal.timeout(PartnerClientService.TIMEOUT_MS),
      });
    } catch (err) {
      // Réseau / DNS / timeout = PANNE, jamais une décision métier du partenaire.
      this.logger.warn(`Partenaire injoignable (${op}) : ${err instanceof Error ? err.message : err}`);
      throw new ServiceUnavailableException('Partner unreachable');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status >= 500) {
        this.logger.warn(`Partenaire en erreur ${res.status} (${op})`);
        throw new ServiceUnavailableException('Partner error');
      }
      throw new PartnerRemoteError(res.status, text);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
