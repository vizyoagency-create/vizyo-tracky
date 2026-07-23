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

/** Ce que le partenaire renvoie après avoir créé l'espace. */
export interface PartnerProvisionResult {
  organizationId: string;
  organizationName: string;
  pairingCode: string;
  expiresAt: string;
  /** false = l'espace existait déjà, seul le code a été régénéré (rejeu). */
  created: boolean;
}

/** Résultat d'une re-synchronisation. `skipped` = lien non-ACTIF, rien touché. */
export interface PartnerReseedResult {
  created: number;
  updated: number;
  total: number;
  skipped: boolean;
  /** Corrections Tracky appliquées par le merge à 3 voies (étape 2, doc 25). */
  fastForwards?: number;
  /** Écarts observés (MAESTROO_AHEAD + CONFLICT) — journalisés, pas résolus. */
  divergences?: number;
}

/**
 * Un véhicule tel qu'on l'envoie au partenaire pour pré-remplir son espace.
 *
 * ⚠️ AUCUNE POSITION, AUCUN CONDUCTEUR : c'est l'identité du véhicule, rien de
 * plus. Le reste relève des scopes vivants, qui se coupent ; ceci est adopté
 * durablement côté partenaire (classe C) et ne disparaîtra pas à la révocation.
 */
export interface PartnerSeedVehicle {
  /**
   * Notre `Vehicle.id` — la clé de jointure STABLE côté partenaire (C2, doc 25
   * §4). Sans lui, la jointure se faisait par plaque : un renommage de plaque
   * chez nous créait un doublon fantôme chez le partenaire.
   */
  trackyVehicleId: string;
  plate: string;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  type?: string | null;
  energy?: string | null;
  consumptionL100km?: number | null;
  odometerKm?: number | null;
  seats?: number | null;
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
    body: {
      remoteLinkId: string;
      fleetName: string;
      linkSecret: string;
      scopes: string[];
      /** Pré-remplissage — envoyé UNIQUEMENT pour un espace provisionné depuis Tracky. */
      seedVehicles?: PartnerSeedVehicle[];
    },
  ): Promise<void> {
    await this.request('POST', `/partner/v1/pairing/${encodeURIComponent(code)}/complete`, 'partner.pairing.complete', body);
  }

  /**
   * Fait créer un espace Maestroo pour une flotte qui n'en a pas.
   *
   * ⚠️ N'envoie AUCUNE donnée de flotte : juste de quoi nommer l'espace et
   * savoir à qui l'adresser. Le contenu ne part qu'avec `completePairing`, une
   * fois le client consentant — créer l'espace n'est pas consentir au partage.
   */
  async provisionSpace(body: {
    fleetId: string;
    fleetName: string;
    contactEmail: string;
    contactFirstName?: string | null;
    contactLastName?: string | null;
    contactPhone?: string | null;
  }): Promise<PartnerProvisionResult> {
    return this.request<PartnerProvisionResult>(
      'POST',
      '/partner/v1/provision',
      'partner.provision',
      body,
    );
  }

  /**
   * Repousse l'identité des véhicules quand la flotte évolue.
   *
   * ⚠️ Op DISTINCTE de `provision` : une signature capturée sur l'une ne doit
   * jamais rejouer l'autre.
   */
  async reseedVehicles(remoteLinkId: string, vehicles: PartnerSeedVehicle[]): Promise<PartnerReseedResult> {
    return this.request<PartnerReseedResult>(
      'POST',
      '/partner/v1/provision/reseed',
      'partner.provision.reseed',
      { remoteLinkId, vehicles },
    );
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
   * DRY-RUN : demande au partenaire ce qu'il perdrait si on coupait.
   * Lecture seule des deux côtés — n'écrit rien, ne révoque rien.
   */
  async purgePreview(linkId: string): Promise<{ byScope: Record<string, number>; total: number }> {
    return this.request(
      'GET',
      `/partner/v1/purge-preview/${encodeURIComponent(linkId)}`,
      'partner.purge.preview',
    );
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
