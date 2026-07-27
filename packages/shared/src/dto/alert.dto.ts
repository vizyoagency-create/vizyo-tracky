export type AlertType =
  | 'SOS'
  | 'POWER_CUT'
  | 'ACCIDENT'
  | 'COLLISION'
  | 'LOW_BATTERY'
  | 'OVERSPEED'
  | 'GEOFENCE_ENTER'
  | 'GEOFENCE_EXIT'
  | 'MOVEMENT_IDLE'
  | 'HARSH_BRAKING'
  | 'HARSH_ACCELERATION'
  | 'HARSH_TURN'
  | 'BONNET'
  | 'DOOR'
  | 'VIBRATION'
  | 'TOW'
  | 'TAMPER'
  | 'FATIGUE'
  | 'ILLEGAL_IGNITION'
  | 'GPS_LOST'
  | 'IDLE_TIME'
  | 'SURVEILLANCE_TRIGGERED'
  // Présent dans l'enum Prisma `AlertType` mais absent ici jusqu'ici : une alerte
  // d'échéance d'entretien n'avait donc pas de type côté client (elle retombait en
  // `UNKNOWN` au typage). Ajouté pour que les préférences puissent la nommer.
  | 'MAINTENANCE_DUE'
  | 'UNKNOWN';

/**
 * ⚠️ MINUSCULES côté client, MAJUSCULES côté base (enum Prisma `AlertSeverity`).
 * L'écart est historique et assumé : c'est la couche API qui convertit aux frontières.
 * Ne PAS « harmoniser » l'un des deux sans reprendre l'autre — les payloads temps réel,
 * les alertes déjà persistées et l'UI dépendent tous de cette forme.
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertDto {
  id: string;
  vehicleId: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
}
