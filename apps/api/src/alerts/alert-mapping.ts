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
  power_cut: { type: 'POWER_CUT', severity: 'CRITICAL', title: 'Alimentation coupée' },
  accident: { type: 'ACCIDENT', severity: 'CRITICAL', title: 'Accident détecté' },
  collision: { type: 'COLLISION', severity: 'CRITICAL', title: 'Collision détectée' },

  low_battery: { type: 'LOW_BATTERY', severity: 'WARNING', title: 'Batterie faible' },
  overspeed: { type: 'OVERSPEED', severity: 'WARNING', title: 'Excès de vitesse' },
  geofence: { type: 'GEOFENCE_EXIT', severity: 'WARNING', title: 'Sortie de zone autorisée' },
  movement: { type: 'MOVEMENT_IDLE', severity: 'WARNING', title: 'Mouvement véhicule éteint' },
  bonnet: { type: 'BONNET', severity: 'WARNING', title: 'Capot ouvert' },
  door: { type: 'DOOR', severity: 'WARNING', title: 'Porte ouverte' },

  vibration: { type: 'VIBRATION', severity: 'INFO', title: 'Vibration détectée' },
  foot_brake: { type: 'HARSH_BRAKING', severity: 'INFO', title: 'Freinage brusque' },
  harsh_braking: { type: 'HARSH_BRAKING', severity: 'INFO', title: 'Freinage brusque' },
  harsh_acceleration: { type: 'HARSH_ACCELERATION', severity: 'INFO', title: 'Accélération brusque' },
  harsh_turn: { type: 'HARSH_TURN', severity: 'INFO', title: 'Virage brusque' },

  tow: { type: 'TOW', severity: 'CRITICAL', title: 'Remorquage détecté' },
  tamper: { type: 'TAMPER', severity: 'CRITICAL', title: 'Tentative de retrait du tracker' },
  fatigue: { type: 'FATIGUE', severity: 'WARNING', title: 'Fatigue conducteur détectée' },
  illegal_ignition: { type: 'ILLEGAL_IGNITION', severity: 'CRITICAL', title: 'Démarrage non autorisé' },
  gps_lost: { type: 'GPS_LOST', severity: 'INFO', title: 'Signal GPS perdu' },
  idle_alert: { type: 'IDLE_TIME', severity: 'INFO', title: 'Temps d\'arrêt excessif' },

  unknown: { type: 'UNKNOWN', severity: 'INFO', title: 'Alarme inconnue' },
};

export function mapCobanAlarm(alarm: CobanAlarmType): AlertMapping | null {
  return MAPPING[alarm] ?? null;
}
