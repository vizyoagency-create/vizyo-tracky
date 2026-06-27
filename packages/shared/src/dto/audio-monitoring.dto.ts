/**
 * Sprint 4 — Écoute audio à distance (micro embarqué) — types partagés API ↔ web.
 *
 * Scénario A confirmé (appel live) : l'« écoute » = le boîtier ouvre son micro et
 * l'admin APPELLE la SIM pour entendre la cabine. Aucun clip n'est uploadé/stocké
 * → ces DTO portent l'AUDIT (qui/quand/véhicule/motif) et l'état d'ACTIVATION de la
 * flotte, jamais de données audio.
 */

/**
 * Audit d'une commande d'écoute audio — vue admin.
 * Source : AudioMonitoringCommand jointe au tracker/véhicule, avec le demandeur
 * résolu (requestedBy stocké en String UUID, pas une FK formelle — comme
 * EngineCommandAuditDto).
 */
export interface AudioCommandAuditDto {
  id: string;
  /** Toujours 'LISTEN' (une seule action en Scénario A : armer le micro pour un appel live). */
  action: 'LISTEN';
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'REJECTED';
  vehiclePlate: string | null;
  trackerImei: string;
  requestedByName: string;
  requestedByRole: string | null;
  /** Environnement du déclenchement ('development'|'production') — traçabilité du gate #3. */
  requestedInEnv: string;
  reason: string;
  source: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/**
 * État d'activation de l'écoute audio pour une flotte (garde-fous #1 + #5 + #6).
 * `enabled=false` (défaut) ⇒ l'écoute est refusée pour toute la flotte.
 */
export interface FleetAudioConfigDto {
  enabled: boolean;
  attestedAt: string | null;
  attestationVersion: string | null;
  activationEmailSentAt: string | null;
}
