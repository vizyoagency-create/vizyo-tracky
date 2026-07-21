/**
 * Mode vie privée conducteur (par véhicule) — DTOs partagés frontend/backend.
 *
 * Quand le mode privé est ACTIF, aucune position n'est collectée/diffusée pour le
 * véhicule (la trame est jetée à l'ingestion). État courant + historique tracés.
 */

export interface PrivacyModeStateDto {
  vehicleId: string;
  /** Usage MIXTE déclaré : sans lui, le mode vie privée ne s'applique pas (véhicule tracé 24/7). */
  mixedUseEnabled: boolean;
  enabled: boolean;
  /** ISO — depuis quand l'état courant est actif (null si jamais basculé). */
  since: string | null;
  /** Auteur de la dernière bascule (null = système). */
  byUserId: string | null;
  byName: string | null;
  note: string | null;
}

export interface PrivacyModeEventDto {
  id: string;
  enabled: boolean;
  reason: string | null;
  userId: string | null;
  byName: string | null;
  createdAt: string;
}

export interface SetPrivacyModeRequestDto {
  enabled: boolean;
  /** Note facultative (traçabilité) — max 500 caractères. */
  reason?: string | null;
}
