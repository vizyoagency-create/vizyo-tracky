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
  | 'UNKNOWN';

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
