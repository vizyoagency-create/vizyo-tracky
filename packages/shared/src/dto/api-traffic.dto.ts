/**
 * Observabilité du trafic API PUBLIC + intelligence IP — vue admin (SUPER_ADMIN).
 *
 * Donne à l'admin la vue de TOUTES les entrées/sorties des API publiques (qui appelle,
 * d'où : LP / Maestroo / autre, reconnu ou IP inconnue) et compare les IP des utilisateurs
 * RECONNUS de l'app avec les IP INCONNUES + leur fréquence d'apparition. Alimenté par
 * ApiTrafficInterceptor (hits publics) et le beacon public POST /api/partner/activity.
 */

/** Origine résolue depuis l'Origin/Referer (ou le champ `source` du beacon). */
export type ApiTrafficSource = 'LP' | 'MAESTROO' | 'API' | 'WEBHOOK' | 'UNKNOWN';

/** Nature de la ligne : hit API public capturé, ou beacon partenaire. */
export type ApiTrafficKind = 'REQUEST' | 'PARTNER_EVENT';

/** Une entrée du feed « trafic API » (ordre createdAt desc, curseur createdAt+id). */
export interface ApiTrafficEntryDto {
  id: string;
  createdAt: string;
  kind: ApiTrafficKind | string;
  source: ApiTrafficSource | string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  /** Sémantique des beacons (teaser_open, cta_click, teaser_close…). */
  action: string | null;
  /** Libellé bouton / cible (beacons). */
  target: string | null;
  ip: string | null;
  /** true = IP déjà vue liée à un utilisateur reconnu (lead LP ou appel authentifié). */
  ipKnown: boolean;
  userId: string | null;
  /** Nom de l'utilisateur reconnu (si `userId` résolu), sinon null. */
  userName: string | null;
  userAgent: string | null;
  durationMs: number | null;
}

/** Une ligne d'intelligence IP : agrégat par IP sur la fenêtre demandée. */
export interface IpIntelligenceRowDto {
  ip: string;
  /** Nombre d'apparitions (hits + beacons) sur la fenêtre. */
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** true = IP reconnue (lead LP ou IP d'un appel authentifié). */
  known: boolean;
  /** Nom de l'utilisateur/prospect reconnu derrière cette IP, si résolu. */
  knownUserName: string | null;
  /** Origines distinctes vues pour cette IP (LP, MAESTROO, API, WEBHOOK, UNKNOWN). */
  sources: string[];
  /** Répartition des codes HTTP (ex: { '200': 12, '404': 3 }). */
  statuses: Record<string, number>;
  /** Dernier chemin appelé par cette IP. */
  lastPath: string | null;
  /** Dernier User-Agent vu pour cette IP. */
  lastUserAgent: string | null;
}

/** Synthèse chiffrée du trafic API sur la fenêtre (cartes du tableau de bord). */
export interface ApiTrafficSummaryDto {
  /** Fenêtre effective (jours) utilisée pour le calcul. */
  windowDays: number;
  totalRequests: number;
  totalPartnerEvents: number;
  /** Répartition par origine (LP, MAESTROO, API, WEBHOOK, UNKNOWN). */
  bySource: Record<string, number>;
  /** Répartition par classe de statut HTTP. */
  byStatusClass: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  uniqueIps: number;
  unknownIps: number;
  knownIps: number;
  topPaths: { path: string; count: number }[];
  topUnknownIps: { ip: string; count: number; lastSeen: string }[];
}

/**
 * Corps du beacon public POST /api/partner/activity (envoyé par la LP / Maestroo,
 * y compris via navigator.sendBeacon → Content-Type text/plain toléré). Réponse 204.
 * Tous les champs sont tronqués côté serveur ; un payload > ~4 Ko est ignoré.
 */
export interface PartnerActivityBeaconBody {
  /** 'LP' | 'MAESTROO' | … (max 20). Sinon résolu depuis l'Origin/Referer. */
  source?: string;
  /** Sémantique de l'événement (teaser_open, cta_click, teaser_close…) — requis, max 60. */
  action: string;
  /** Cible / bouton (max 80). */
  target?: string;
  /** Libellé lisible (max 120). */
  label?: string;
  /** Durée mesurée côté client (ms). */
  durationMs?: number;
  /** Identifiant de session client (max 64). */
  sessionId?: string;
  /** Métadonnées libres (bornées côté serveur). */
  meta?: Record<string, unknown>;
}

/** Libellés lisibles des origines (affichage admin). */
export const API_TRAFFIC_SOURCE_LABELS: Record<string, string> = {
  LP: 'Landing page',
  MAESTROO: 'Maestroo',
  API: 'Application Tracky',
  WEBHOOK: 'Webhook',
  UNKNOWN: 'Inconnu',
};
