import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { simStatusLabel } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { SystemActivityService } from '../system-activity/system-activity.service';

/**
 * V1.16 — Client GraphQL WhereverSIM (parc SIM M2M).
 *
 * Endpoint : POST {WHEREVER_SIM_API_URL}. Auth : header `Authorization: <token>`
 * (token BRUT, sans prefixe Bearer — verifie en live). Mode no-op si le token
 * est vide (comme Twilio/vizyo-texto) : `isConfigured()` renvoie false et les
 * appels throw ServiceUnavailable.
 *
 * Thin client base sur `fetch` (aucune dependance Apollo). Les `Long` GraphQL
 * (timestamps en millisecondes, volumes en octets) arrivent en `number` JSON,
 * dans la plage safe-integer pour nos usages (volumes mensuels, dates).
 */

/** SIM brute telle que renvoyee par WhereverSIM (champs scalaires confirmes en live). */
export interface RawSim {
  iccid: string;
  msisdn: string | null;
  imsi: string | null;
  imei: string | null;
  statusid: number;
  providerid: number;
  activation_timestamp: number | null;
  monthly_data_volume: number | null;
  monthly_data_limit: number | null;
  previous_month_data_volume: number | null;
  custom_field_1: string | null;
  apn: string | null;
  ip_address: string | null;
  in_session_since: number | null;
}

export interface RawSimList {
  items: RawSim[];
  nextToken: string | null;
  totalSims: number;
}

export interface RawStatistics {
  totalSimCards: number;
  activeSimCards: number;
  currentMonthlyDataUsage: number;
  previousMonthDataUsage: number;
}

export interface RawConsumptionPoint {
  day: string;
  bytes: number;
}

export interface RawSimEvent {
  // V1.x — l'API WhereverSIM a renommé `timestamp` -> `timestampMilliseconds`
  // (époch ms). L'ancien nom déclenchait une erreur de validation GraphQL (503).
  timestampMilliseconds: number;
  type: string;
  details: unknown;
}

export interface UpdateSimInput {
  iccid: string;
  statusid?: number;
  monthly_data_limit?: number;
  custom_field_1?: string;
}

/** Champs scalaires demandes pour une SIM (reutilise par listSims/updateSim). */
const SIM_FIELDS = `
  iccid
  msisdn
  imsi
  imei
  statusid
  providerid
  activation_timestamp
  monthly_data_volume
  monthly_data_limit
  previous_month_data_volume
  custom_field_1
  apn
  ip_address
  in_session_since
`;

@Injectable()
export class WhereverSimClient {
  private readonly logger = new Logger(WhereverSimClient.name);
  private readonly apiUrl: string;
  private readonly token: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
  ) {
    this.apiUrl = (this.config.get('WHEREVER_SIM_API_URL', { infer: true }) ?? '').trim();
    this.token = (this.config.get('WHEREVER_SIM_TOKEN', { infer: true }) ?? '').trim();
  }

  isConfigured(): boolean {
    return !!this.apiUrl && !!this.token;
  }

  // ─── Transport GraphQL ────────────────────────────────────────────────────

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'WhereverSIM non configure (WHEREVER_SIM_TOKEN absent)',
      );
    }
    let res: Response;
    try {
      res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Token brut — surtout PAS de prefixe Bearer (cf. doc + test live).
          Authorization: this.token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`WhereverSIM injoignable : ${msg}`);
      throw new ServiceUnavailableException(`WhereverSIM injoignable : ${msg}`);
    }

    const body = (await res.json().catch(() => null)) as
      | { data?: T; errors?: { message?: string }[] }
      | null;
    if (!res.ok) {
      throw new ServiceUnavailableException(`WhereverSIM HTTP ${res.status}`);
    }
    if (!body) {
      throw new ServiceUnavailableException('WhereverSIM : réponse non-JSON');
    }
    if (body.errors && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message ?? 'erreur').join('; ');
      this.logger.warn(`WhereverSIM GraphQL errors : ${msg}`);
      throw new ServiceUnavailableException(`WhereverSIM : ${msg}`);
    }
    if (body.data === undefined) {
      throw new ServiceUnavailableException('WhereverSIM : réponse vide');
    }
    return body.data;
  }

  // ─── Operations ───────────────────────────────────────────────────────────

  /** Page de SIM (limit max 100 cote API). `quickSearch` = ICCID/MSISDN/IMEI/nom. */
  async listSims(params: {
    limit: number;
    nextToken?: string | null;
    quickSearch?: string;
  }): Promise<RawSimList> {
    const query = `
      query ListSims($limit: Int!, $nextToken: String, $quickSearch: String) {
        listSims(limit: $limit, nextToken: $nextToken, quickSearch: $quickSearch) {
          totalSims
          nextToken
          items { ${SIM_FIELDS} }
        }
      }
    `;
    const data = await this.request<{ listSims: RawSimList | null }>(query, {
      limit: params.limit,
      nextToken: params.nextToken ?? null,
      quickSearch: params.quickSearch ?? null,
    });
    // #35 — payload `listSims` null (reponse fournisseur degradee) : on renvoie une
    // page vide au lieu de laisser le caller dereferencer null (sync/getStatistics 500).
    return data.listSims ?? { items: [], nextToken: null, totalSims: 0 };
  }

  /**
   * Journal Système (catégorie SIM) — seule primitive de MUTATION chez l'opérateur :
   * un changement de statut/plafond a un effet réel (et facturable) hors Tracky.
   * ICCID masqué (mêmes 4 derniers chiffres que les numéros SMS). L'attribution
   * utilisateur des actions manuelles vient de la ligne MUTATION (interceptor).
   */
  private recordSimActivity(action: string, iccid: string, status: 'SUCCESS' | 'FAILURE', detail: string): void {
    this.systemActivity.record({
      category: 'SIM',
      action,
      status,
      actor: 'system',
      target: `SIM ••${iccid.slice(-4)}`,
      detail,
      meta: status === 'FAILURE' ? { error: detail } : undefined,
    });
  }

  /** Action métier dérivée des clés présentes dans l'input (1 clé par appel réel). */
  private updateAction(input: UpdateSimInput): { action: string; detail: string } {
    if (input.statusid != null) {
      return { action: 'sim_status_changed', detail: `Statut → ${simStatusLabel(input.statusid)}` };
    }
    if (input.monthly_data_limit != null) {
      return {
        action: 'sim_data_limit_changed',
        detail: input.monthly_data_limit === 0 ? 'Plafond data → illimité' : `Plafond data → ${input.monthly_data_limit} o`,
      };
    }
    return { action: 'sim_device_name_pushed', detail: 'Nom device poussé (custom_field_1)' };
  }

  /** Modifie une SIM (statut, plafond data, custom_field_1). Renvoie la SIM a jour. */
  async updateSim(input: UpdateSimInput): Promise<RawSim> {
    const query = `
      mutation UpdateSim(
        $iccid: ID!
        $statusid: Int
        $monthly_data_limit: Long
        $custom_field_1: String
      ) {
        updateSim(
          iccid: $iccid
          statusid: $statusid
          monthly_data_limit: $monthly_data_limit
          custom_field_1: $custom_field_1
        ) { ${SIM_FIELDS} }
      }
    `;
    const { action, detail } = this.updateAction(input);
    try {
      const data = await this.request<{ updateSim: RawSim }>(query, { ...input });
      this.recordSimActivity(action, input.iccid, 'SUCCESS', detail);
      return data.updateSim;
    } catch (err) {
      this.recordSimActivity(action, input.iccid, 'FAILURE', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async getStatistics(): Promise<RawStatistics> {
    const query = `
      query { getStatistics { totalSimCards activeSimCards currentMonthlyDataUsage previousMonthDataUsage } }
    `;
    const data = await this.request<{ getStatistics: RawStatistics | null }>(query);
    // #35 — payload null : valeurs a zero plutot qu'un deref null cote caller.
    return (
      data.getStatistics ?? {
        totalSimCards: 0,
        activeSimCards: 0,
        currentMonthlyDataUsage: 0,
        previousMonthDataUsage: 0,
      }
    );
  }

  /** Conso journaliere d'une SIM (max 3 mois en arriere cote API). Dates "YYYY-MM-DD". */
  async getDataConsumptionReport(
    iccid: string,
    range: { start: string; stop: string },
  ): Promise<RawConsumptionPoint[]> {
    const query = `
      query Conso($iccid: ID!, $filterOptions: DataConsumptionFilterInput!) {
        getDataConsumptionReport(iccid: $iccid, filterOptions: $filterOptions) { day bytes }
      }
    `;
    const data = await this.request<{ getDataConsumptionReport: RawConsumptionPoint[] }>(query, {
      iccid,
      filterOptions: { start: range.start, stop: range.stop },
    });
    return data.getDataConsumptionReport ?? [];
  }

  async listSimEvents(
    iccid: string,
    params: { limit: number; nextToken?: string | null },
  ): Promise<{ items: RawSimEvent[]; nextToken: string | null }> {
    const query = `
      query Events($iccid: ID!, $limit: Int!, $nextToken: String) {
        listSimEvents(iccid: $iccid, limit: $limit, nextToken: $nextToken) {
          nextToken
          items { timestampMilliseconds type details }
        }
      }
    `;
    const data = await this.request<{
      listSimEvents: { items: RawSimEvent[]; nextToken: string | null };
    }>(query, { iccid, limit: params.limit, nextToken: params.nextToken ?? null });
    return data.listSimEvents;
  }

  /** Envoi SMS vers la SIM. L'originator doit etre pre-enregistre cote WhereverSIM. */
  async sendSms(iccid: string, text: string, originator?: string): Promise<boolean> {
    const query = `
      mutation SendSms($iccid: ID!, $text: String!, $originator: String) {
        sendSms(iccid: $iccid, text: $text, originator: $originator)
      }
    `;
    // Corps caviardé (mêmes règles que SmsGatewayService) : une commande Coban
    // avec mot de passe boîtier ne doit jamais apparaître en clair dans le feed.
    const redacted = text.replace(/\d{5,}/g, '••••');
    try {
      const data = await this.request<{ sendSms: boolean }>(query, { iccid, text, originator });
      this.recordSimActivity('sim_sms_sent', iccid, data.sendSms ? 'SUCCESS' : 'FAILURE', `SMS : ${redacted.slice(0, 120)}`);
      return data.sendSms;
    } catch (err) {
      this.recordSimActivity('sim_sms_sent', iccid, 'FAILURE', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
