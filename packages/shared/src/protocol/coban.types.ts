export type CobanAlarmType =
  | 'none'
  | 'sos'
  | 'low_battery'
  | 'geofence'
  | 'movement'
  | 'overspeed'
  | 'door'
  | 'power_cut'
  | 'accident'
  | 'collision'
  | 'vibration'
  | 'bonnet'
  | 'foot_brake'
  | 'harsh_braking'
  | 'harsh_acceleration'
  | 'harsh_turn'
  | 'tow'
  | 'tamper'
  | 'fatigue'
  | 'illegal_ignition'
  | 'gps_lost'
  | 'idle_alert'
  | 'acc_on'
  | 'acc_off'
  | 'temperature'
  | 'fuel'
  | 'rfid'
  | 'dtc'
  | 'unknown';

export interface CobanLoginFrame {
  type: 'login';
  imei: string;
  raw: string;
}

export interface CobanHeartbeatFrame {
  type: 'heartbeat';
  imei: string;
  raw: string;
}

export interface CobanPositionFrame {
  type: 'position';
  imei: string;
  alarm: CobanAlarmType;
  deviceTime: Date;
  valid: boolean;
  latitude: number;
  longitude: number;
  speedKph: number;
  course?: number;
  altitude?: number;
  ignition?: boolean;
  door?: boolean;
  fuel1?: number;
  fuel2?: number;
  temperature?: number;
  rfid?: string;
  raw: string;
}

export interface CobanUnknownFrame {
  type: 'unknown';
  raw: string;
  reason: string;
}

/**
 * Boîtier vivant mais SANS fix GPS (flag non-A/V ou coordonnées absentes : rapport
 * LBS sans lock satellite, ex. "imei:...,tracker,<date>,<batt>%,L,,,<cell>,..."). Porte
 * l'IMEI pour rafraîchir lastSeenAt (→ état « en attente GPS ») sans écrire de position.
 */
export interface CobanNoFixFrame {
  type: 'no_fix';
  imei: string;
  alarm: CobanAlarmType;
  /** Date locale du boîtier si parsable, sinon null. Aucune coordonnée (pas de fix). */
  deviceTime: Date | null;
  raw: string;
}

export type CobanFrame =
  | CobanLoginFrame
  | CobanHeartbeatFrame
  | CobanPositionFrame
  | CobanNoFixFrame
  | CobanUnknownFrame;

export type CobanCommand =
  | { type: 'engine_stop' }
  | { type: 'engine_resume' }
  | { type: 'alarm_arm' }
  | { type: 'alarm_disarm' }
  | { type: 'position_single' }
  | { type: 'position_periodic'; frequencySeconds: number }
  | { type: 'position_stop' }
  | { type: 'request_photo' }
  | { type: 'sos_ack' }
  | { type: 'custom'; raw: string };
