import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

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

  constructor(private readonly config: ConfigService<Env, true>) {
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
      throw new ServiceUnavailableException('WhereverSIM : reponse non-JSON');
    }
    if (body.errors && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message ?? 'erreur').join('; ');
      this.logger.warn(`WhereverSIM GraphQL errors : ${msg}`);
      throw new ServiceUnavailableException(`WhereverSIM : ${msg}`);
    }
    if (body.data === undefined) {
      throw new ServiceUnavailableException('WhereverSIM : reponse vide');
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
    const data = await this.request<{ listSims: RawSimList }>(query, {
      limit: params.limit,
      nextToken: params.nextToken ?? null,
      quickSearch: params.quickSearch ?? null,
    });
    return data.listSims;
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
    const data = await this.request<{ updateSim: RawSim }>(query, { ...input });
    return data.updateSim;
  }

  async getStatistics(): Promise<RawStatistics> {
    const query = `
      query { getStatistics { totalSimCards activeSimCards currentMonthlyDataUsage previousMonthDataUsage } }
    `;
    const data = await this.request<{ getStatistics: RawStatistics }>(query);
    return data.getStatistics;
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
    const data = await this.request<{ sendSms: boolean }>(query, { iccid, text, originator });
    return data.sendSms;
  }
}
