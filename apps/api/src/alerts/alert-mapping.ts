import type { CobanAlarmType } from '@vizyo/tracky-shared';
import type { AlertSeverity, AlertType } from '@prisma/client';

export interface AlertMapping {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
}

const MAPPING: Record<CobanAlarmType, AlertMapping | null> = {
  none: null,
  acc_on: null,
  acc_off: null,
  rfid: null,
  temperature: null,
  fuel: null,
  dtc: null,

  sos: { type: 'SOS', severity: 'CRITICAL', title: 'Appel SOS conducteur' },
  power_cut: { type: 'POWER_CUT', severity: 'CRITICAL', title: 'Alimentation coupee' },
  accident: { type: 'ACCIDENT', severity: 'CRITICAL', title: 'Accident detecte' },
  collision: { type: 'COLLISION', severity: 'CRITICAL', title: 'Collision detectee' },

  low_battery: { type: 'LOW_BATTERY', severity: 'WARNING', title: 'Batterie faible' },
  overspeed: { type: 'OVERSPEED', severity: 'WARNING', title: 'Exces de vitesse' },
  geofence: { type: 'GEOFENCE_EXIT', severity: 'WARNING', title: 'Sortie de zone autorisee' },
  movement: { type: 'MOVEMENT_IDLE', severity: 'WARNING', title: 'Mouvement detecte a l\'arret' },
  bonnet: { type: 'BONNET', severity: 'WARNING', title: 'Capot ouvert' },
  door: { type: 'DOOR', severity: 'WARNING', title: 'Porte ouverte' },

  vibration: { type: 'VIBRATION', severity: 'INFO', title: 'Vibration detectee' },
  foot_brake: { type: 'HARSH_BRAKING', severity: 'INFO', title: 'Freinage brusque' },
  harsh_braking: { type: 'HARSH_BRAKING', severity: 'INFO', title: 'Freinage brusque' },
  harsh_acceleration: { type: 'HARSH_ACCELERATION', severity: 'INFO', title: 'Acceleration brusque' },
  harsh_turn: { type: 'HARSH_TURN', severity: 'INFO', title: 'Virage brusque' },

  unknown: { type: 'UNKNOWN', severity: 'INFO', title: 'Alarme inconnue' },
};

export function mapCobanAlarm(alarm: CobanAlarmType): AlertMapping | null {
  return MAPPING[alarm] ?? null;
}
