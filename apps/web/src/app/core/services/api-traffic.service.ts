import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Client HTTP typé — Observabilité du trafic API public + intelligence IP.
 *
 * Tous les endpoints sont gardés SUPER_ADMIN côté serveur (cookie de session envoyé
 * automatiquement par `authInterceptor`, `withCredentials: true`). Les types sont
 * déclarés ici en local : le contrat n'est pas (encore) publié dans `@vizyo/tracky-shared`.
 * Si un nom de champ diffère légèrement à l'intégration, ajuster ces interfaces.
 */

/** Nature d'une entrée : requête HTTP entrante, ou événement métier d'un partenaire (webhook / teaser…). */
export type ApiTrafficKind = 'REQUEST' | 'PARTNER_EVENT';

/** Classe de statut HTTP (regroupement 2xx/3xx/4xx/5xx). */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

/** Une entrée du flux (`GET /api/admin/api-traffic`). */
export interface ApiTrafficEntryDto {
  id: string;
  createdAt: string;
  kind: ApiTrafficKind;
  /** Origine logique : LP / Maestroo / API / Webhook / Unknown (chaîne libre côté serveur). */
  source: string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  /** PARTNER_EVENT : verbe métier (ex. « teaser_open »). */
  action: string | null;
  /** PARTNER_EVENT : cible/canal (ex. « WhatsApp »). */
  target: string | null;
  ip: string | null;
  /** true = IP rattachée à un compte/partenaire connu ; false = inconnue (bot/scan potentiel). */
  ipKnown: boolean;
  userId: string | null;
  userAgent: string | null;
  durationMs: number | null;
  meta?: Record<string, unknown> | null;
}

/** Une ligne d'intelligence IP (`GET /api/admin/api-traffic/ips`). */
export interface IpIntelligenceRowDto {
  ip: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  known: boolean;
  knownUserName: string | null;
  sources: string[];
  /** Répartition des statuts pour cette IP : { '200': 12, '404': 3, … }. */
  statuses: Record<string, number>;
  lastPath: string | null;
  lastUserAgent: string | null;
}

/** Synthèse sur une fenêtre (`GET /api/admin/api-traffic/summary`). */
export interface ApiTrafficSummaryDto {
  totalRequests: number;
  totalPartnerEvents: number;
  /** Compte par source : { LP: 120, Maestroo: 8, API: 940, Webhook: 12, Unknown: 5 }. */
  bySource: Record<string, number>;
  byStatusClass: Record<StatusClass, number>;
  uniqueIps: number;
  unknownIps: number;
  knownIps: number;
  topPaths: { path: string; count: number }[];
  topUnknownIps: { ip: string; count: number; lastSeen: string }[];
}

/** Filtres/curseur du flux. */
export interface ApiTrafficQuery {
  limit?: number;
  /** Curseur temporel (ISO) — entrées strictement antérieures. */
  before?: string;
  /** Départage les entrées au même `createdAt` (curseur composite). */
  beforeId?: string;
  source?: string;
  kind?: ApiTrafficKind;
  /** Classe de statut : '2xx' | '3xx' | '4xx' | '5xx'. */
  status?: StatusClass;
  /** true = IP connues, false = IP inconnues, absent = toutes. */
  ipKnown?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ApiTrafficService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/admin/api-traffic';

  /** KPIs + répartitions par source/statut + top chemins / top IP inconnues, sur `windowDays`. */
  summary(windowDays: number): Observable<ApiTrafficSummaryDto> {
    const params = new HttpParams().set('windowDays', String(windowDays));
    return this.http.get<ApiTrafficSummaryDto>(`${this.base}/summary`, { params });
  }

  /** Tableau d'intelligence IP (trié par fréquence côté serveur), sur `windowDays`. */
  ips(windowDays: number): Observable<IpIntelligenceRowDto[]> {
    const params = new HttpParams().set('windowDays', String(windowDays));
    return this.http.get<IpIntelligenceRowDto[]>(`${this.base}/ips`, { params });
  }

  /** Flux des entrées récentes, filtrable + pagination par curseur (`before` / `beforeId`). */
  entries(q: ApiTrafficQuery = {}): Observable<ApiTrafficEntryDto[]> {
    let params = new HttpParams().set('limit', String(q.limit ?? 50));
    if (q.before) params = params.set('before', q.before);
    if (q.beforeId) params = params.set('beforeId', q.beforeId);
    if (q.source) params = params.set('source', q.source);
    if (q.kind) params = params.set('kind', q.kind);
    if (q.status) params = params.set('status', q.status);
    if (q.ipKnown !== undefined) params = params.set('ipKnown', String(q.ipKnown));
    return this.http.get<ApiTrafficEntryDto[]>(this.base, { params });
  }
}
