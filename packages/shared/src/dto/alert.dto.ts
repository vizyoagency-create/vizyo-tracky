export type AlertType =
  | 'speeding'
  | 'low_battery'
  | 'geofence_enter'
  | 'geofence_exit'
  | 'sos'
  | 'offline';

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
