import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  NOTIFICATION_PAGE_SIZE,
  type NotificationDeliveryPageDto,
  type NotificationDeliveryQueryDto,
  type NotificationDeliveryRowDto,
  type NotificationHealthDto,
  type NotificationSummaryDto,
} from '@vizyo/tracky-shared';

/**
 * Client HTTP — CENTRE DE NOTIFICATIONS (super-admin, LECTURE SEULE).
 *
 * Pourquoi cet écran existe : le push d'alerte n'est jamais parti pendant des mois
 * (582 alertes en 7 jours → 0 notification), et PERSONNE ne l'a vu. Il n'existait que des
 * agrégats « 3 envoyés, 1 échec » — impossible de répondre à « qui a reçu quoi, quand, et
 * pourquoi untel n'a rien reçu ».
 *
 *   GET /api/admin/notifications/health      — la chaîne peut-elle seulement fonctionner ?
 *   GET /api/admin/notifications/summary     — combien est parti / retenu / échoué, et pourquoi
 *   GET /api/admin/notifications/deliveries  — le journal ligne à ligne, filtrable
 *
 * Les types viennent du contrat PARTAGÉ (`@vizyo/tracky-shared`), pas d'une copie locale :
 * l'API construit déjà les libellés FR des issues et des motifs, et une seconde table côté
 * écran finirait par diverger (« Échec » ici, « Échec d'envoi » là, pour la même ligne).
 *
 * UNE seule méthode d'écriture, et ciblée :
 *
 *   POST /api/admin/notifications/replay/:alertId — renvoie UNE alerte à ses destinataires
 *
 * Pas de purge ni d'acquittement de masse : sur un journal de plusieurs milliers de lignes,
 * ce serait un incident de production en puissance. Le rejeu porte sur UNE alerte désignée,
 * n'écrit ni ne détruit rien d'existant, et répondait à un besoin sans autre solution — le
 * 2026-08-03, un client n'avait reçu aucune de ses 28 alertes de vitesse et rien ne
 * permettait de lui en renvoyer une seule.
 */

/** Ce qu'un rejeu a produit, destinataire par destinataire. */
export interface ReplayResultDto {
  alertId: string;
  alertType: string;
  plate: string | null;
  destinataires: Array<{
    email: string;
    status: string;
    reason: string | null;
    reasonLabel: string | null;
    devices: number;
    sent: number;
  }>;
}

/** Fenêtre de lecture, telle que l'API l'attend (bornes ISO). */
export interface NotificationWindow {
  from: string;
  to: string;
}

// ─── Normalisation défensive ────────────────────────────────────────────────
//
// Un écran de SUPERVISION qui se vide sur un champ manquant redevient exactement l'angle
// mort qu'il est censé supprimer. Ces fonctions ne masquent aucune erreur HTTP (elle remonte
// et s'affiche) : elles garantissent qu'une réponse partielle affiche des zéros, jamais une
// page blanche.

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function normalizeHealth(raw: Partial<NotificationHealthDto> | null | undefined): NotificationHealthDto {
  const h = raw ?? {};
  return {
    // Défaut PESSIMISTE : sans confirmation explicite du serveur, on n'affiche pas « tout va
    // bien ». Un faux vert est pire que pas d'écran du tout.
    vapidConfigured: h.vapidConfigured === true,
    pushRollout: h.pushRollout ?? 'SUPER_ADMIN_ONLY',
    totalDevices: num(h.totalDevices),
    usersWithDevice: num(h.usersWithDevice),
    reachByRole: list<NotificationHealthDto['reachByRole'][number]>(h.reachByRole),
    lastSuccessfulPushAt: h.lastSuccessfulPushAt ?? null,
    lastAttemptAt: h.lastAttemptAt ?? null,
    eligibleUsers: num(h.eligibleUsers),
    eligibleWithoutDevice: num(h.eligibleWithoutDevice),
    unreachableUsers: list<NotificationHealthDto['unreachableUsers'][number]>(h.unreachableUsers),
    warnings: list<string>(h.warnings),
  };
}

function normalizeSummary(
  raw: Partial<NotificationSummaryDto> | null | undefined,
  window: NotificationWindow,
): NotificationSummaryDto {
  const s = raw ?? {};
  return {
    from: s.from ?? window.from,
    to: s.to ?? window.to,
    windowDays: num(s.windowDays),
    total: num(s.total),
    sent: num(s.sent),
    failed: num(s.failed),
    suppressed: num(s.suppressed),
    grouped: num(s.grouped),
    withheld: num(s.withheld),
    suppressionRate: num(s.suppressionRate),
    byReason: list<NotificationSummaryDto['byReason'][number]>(s.byReason),
    byStatus: list<NotificationSummaryDto['byStatus'][number]>(s.byStatus),
    byChannel: list<NotificationSummaryDto['byChannel'][number]>(s.byChannel),
    bySeverity: list<NotificationSummaryDto['bySeverity'][number]>(s.bySeverity),
    byAlertType: list<NotificationSummaryDto['byAlertType'][number]>(s.byAlertType),
    byCategory: list<NotificationSummaryDto['byCategory'][number]>(s.byCategory),
    topRecipients: list<NotificationSummaryDto['topRecipients'][number]>(s.topRecipients),
    headline: s.headline ?? '',
  };
}

function normalizePage(
  raw: Partial<NotificationDeliveryPageDto> | null | undefined,
  window: NotificationWindow,
  page: number,
): NotificationDeliveryPageDto {
  const p = raw ?? {};
  const rows = list<NotificationDeliveryRowDto>(p.rows);
  return {
    rows,
    total: num(p.total),
    page: num(p.page) || page,
    pageSize: num(p.pageSize) || NOTIFICATION_PAGE_SIZE,
    hasMore: p.hasMore === true,
    from: p.from ?? window.from,
    to: p.to ?? window.to,
  };
}

@Injectable({ providedIn: 'root' })
export class NotificationCenterApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/admin/notifications';

  /** État de la chaîne : VAPID, périmètre, appareils par rôle, trous de couverture. */
  health(): Observable<NotificationHealthDto> {
    return this.http
      .get<Partial<NotificationHealthDto>>(`${this.base}/health`)
      .pipe(map(normalizeHealth));
  }

  /**
   * Totaux + répartition des motifs de retenue sur la fenêtre.
   *
   * Le serveur refuse volontairement un filtre par statut ici : lire un taux calculé SUR les
   * statuts après en avoir filtré un n'aurait aucun sens.
   */
  summary(window: NotificationWindow): Observable<NotificationSummaryDto> {
    const params = new HttpParams().set('from', window.from).set('to', window.to);
    return this.http
      .get<Partial<NotificationSummaryDto>>(`${this.base}/summary`, { params })
      .pipe(map((s) => normalizeSummary(s, window)));
  }

  /** Journal filtrable et paginé (page 1-based, bornes imposées par le serveur). */
  deliveries(q: NotificationDeliveryQueryDto): Observable<NotificationDeliveryPageDto> {
    let params = new HttpParams();
    if (q.from) params = params.set('from', q.from);
    if (q.to) params = params.set('to', q.to);
    if (q.status) params = params.set('status', q.status);
    if (q.channel) params = params.set('channel', q.channel);
    if (q.category) params = params.set('category', q.category);
    if (q.alertType) params = params.set('alertType', q.alertType);
    if (q.severity) params = params.set('severity', q.severity);
    if (q.userId) params = params.set('userId', q.userId);
    if (q.fleetId) params = params.set('fleetId', q.fleetId);
    if (q.reason) params = params.set('reason', q.reason);
    if (q.search) params = params.set('search', q.search);
    if (q.page) params = params.set('page', String(q.page));
    if (q.pageSize) params = params.set('pageSize', String(q.pageSize));

    const window: NotificationWindow = { from: q.from ?? '', to: q.to ?? '' };
    return this.http
      .get<Partial<NotificationDeliveryPageDto>>(`${this.base}/deliveries`, { params })
      .pipe(map((res) => normalizePage(res, window, q.page ?? 1)));
  }

  /**
   * Renvoie une alerte à ses destinataires légitimes (push uniquement).
   *
   * ⚠️ Le résultat décrit ce qui s'est RÉELLEMENT passé, destinataire par destinataire —
   * relu dans le journal, pas déduit de l'appel. Un rejeu retenu par une préférence ou un
   * plafond affiche donc son motif au lieu d'un « OK » qui n'engagerait personne.
   */
  replay(alertId: string): Observable<ReplayResultDto> {
    // Même base et mêmes réglages que les lectures : l'authentification passe par le
    // cookie httpOnly posé au login, via l'intercepteur commun. Poser `withCredentials`
    // ici seulement laisserait croire que les autres appels s'en passent.
    return this.http.post<ReplayResultDto>(`${this.base}/replay/${alertId}`, {});
  }
}
