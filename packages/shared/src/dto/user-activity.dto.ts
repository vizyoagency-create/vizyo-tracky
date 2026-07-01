/**
 * User activity tracking (espace admin) — types partagés API ↔ web.
 *
 * Collecte légère : le client bufferise des events (navigation, clics,
 * présence) et les POST en batch. La présence (ACTIVE/IDLE/AWAY) est
 * auto-évaluée côté client ; OFFLINE est dérivé au read-time (lastSeenAt
 * périmé). Pas de WebSocket dédié : l'admin rafraîchit par polling.
 */

export type ActivityType =
  | 'PAGE_VIEW'
  | 'CLICK'
  | 'SCROLL'
  | 'FORM_SUBMIT'
  | 'SESSION_START'
  | 'SESSION_END'
  | 'SESSION_RESUME'
  | 'IDLE'
  | 'AWAY'
  | 'HEARTBEAT';

export type PresenceStatus = 'ACTIVE' | 'IDLE' | 'AWAY' | 'OFFLINE';

/** Un event envoyé par le client dans un batch. */
export interface ActivityEventInput {
  type: ActivityType;
  route?: string;
  routeLabel?: string;
  target?: string;
  durationMs?: number;
  /** Statut de présence auto-évalué côté client (jamais OFFLINE). */
  status?: 'ACTIVE' | 'IDLE' | 'AWAY';
  /** Timestamp client ISO (optionnel, indicatif). */
  at?: string;
}

export interface ActivityBatchInput {
  events: ActivityEventInput[];
  deviceType?: string;
}

/** Un utilisateur actuellement en ligne (vue admin live). */
export interface OnlineUserDto {
  userId: string;
  name: string;
  role: string;
  fleetId: string | null;
  status: PresenceStatus;
  currentRoute: string | null;
  currentRouteLabel: string | null;
  deviceType: string | null;
  /** Durée depuis le début de la session (ms). */
  sinceMs: number;
  /** Secondes depuis le dernier signal reçu. */
  lastSeenSec: number;
}

export interface ActivityFeedItemDto {
  id: string;
  userId: string;
  userName: string;
  type: ActivityType;
  route: string | null;
  routeLabel: string | null;
  target: string | null;
  durationMs: number | null;
  at: string;
}

export interface TopPageDto {
  route: string;
  label: string;
  views: number;
  avgDurationMs: number;
}

export interface TopClickDto {
  target: string;
  count: number;
}

export interface ActivityStatsDto {
  from: string;
  to: string;
  uniqueUsers: number;
  totalSessions: number;
  totalPageViews: number;
  avgSessionSec: number;
  topPages: TopPageDto[];
  topClicks: TopClickDto[];
  sessionsPerDay: { date: string; count: number }[];
}

/**
 * Audit d'une commande moteur (coupe-circuit) — vue admin.
 * Source : EngineControlCommand (CUT/RESTORE) jointe au tracker/véhicule, avec
 * le demandeur résolu (requestedBy stocké en String UUID, pas une FK formelle).
 */
export interface EngineCommandAuditDto {
  id: string;
  action: 'CUT' | 'RESTORE';
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'REJECTED_SPEED';
  vehiclePlate: string | null;
  trackerImei: string;
  requestedByName: string;
  requestedByRole: string | null;
  source: string;
  reason: string | null;
  confirmationExpected: boolean;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  ackedAt: string | null;
}

/** Libellés lisibles des routes (partagé : le client envoie, l'admin affiche). */
export const ROUTE_LABELS: Record<string, string> = {
  '/map': 'Carte live',
  '/dashboard': 'Tableau de bord',
  '/vehicles': 'Véhicules',
  '/alerts': 'Alertes',
  '/reports': 'Rapports',
  '/geofences': 'Géofences',
  '/groups': 'Groupes',
  '/drivers': 'Chauffeurs',
  '/users': 'Utilisateurs',
  '/settings': 'Paramètres',
  '/account': 'Mon compte',
  '/alert-rules': 'Règles alertes',
  '/admin': 'Admin',
  '/admin/system': 'Admin · Système VPS',
  '/admin/activity': 'Admin · Activité',
  '/admin/trackers': 'Admin · Trackers',
  '/admin/alerts': 'Admin · Centre alertes',
  '/admin/observability': 'Admin · Diagnostic',
  '/admin/sms': 'Admin · SMS & Backup',
  '/admin/sims': 'Admin · Cartes SIM',
  '/admin/installations': 'Admin · Installations',
};

/** Résout le libellé d'une route (gère les routes à paramètres via préfixe). */
export function labelForRoute(route: string): string {
  const clean = (route.split('?')[0] || route).replace(/\/+$/, '') || '/';
  const exact = ROUTE_LABELS[clean];
  if (exact) return exact;
  const best = Object.keys(ROUTE_LABELS)
    .filter((k) => clean === k || clean.startsWith(k + '/'))
    .sort((a, b) => b.length - a.length)[0];
  return (best && ROUTE_LABELS[best]) || clean;
}
