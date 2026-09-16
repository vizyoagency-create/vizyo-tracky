/**
 * Coupe-circuit — les événements qui doivent PRÉVENIR quelqu'un, pas seulement s'écrire.
 *
 * Mesuré la nuit du 15 au 16/09/2026 : l'interlock a retenu les 24 coupes de 22:00 (preuve SMS
 * > 24 h) et l'a écrit au centre d'alerte toutes les 15 min — sans que personne ne soit averti.
 * La ligne était juste ; son silence ne l'était pas. Ces événements sont émis par le moteur de
 * commande, la preuve quotidienne et la sentinelle du téléphone, et repris par
 * `CoupeCircuitPushService` (module notifications) qui pousse aux super-admins par le socle
 * générique — mêmes préférences, même anti-spam, même journal que toute notification.
 *
 * Émis par EventEmitter2 pour ne créer aucune dépendance de module : SmsModule est importé PAR
 * NotificationsModule, l'inverse ferait un cycle.
 */
export const COUPE_CIRCUIT_PUSH_EVENT = 'coupe-circuit.push';

export type CoupeCircuitPushKind =
  /** Coupes automatiques retenues par le kill-switch ou l'interlock (une cause = un sujet). */
  | 'coupe-retenue'
  /** Preuve SMS quotidienne en défaut (verdict ≠ OK). */
  | 'preuve-sms'
  /** Téléphone passerelle hors ligne / relais injoignable. */
  | 'passerelle-sms'
  /** Remise en route non confirmée : un véhicule est peut-être immobilisé. */
  | 'restore-non-prouvee';

export interface CoupeCircuitPushEvent {
  kind: CoupeCircuitPushKind;
  /** Cloisonne le cooldown du socle (15 min) : une cause, une commande, un état. */
  subjectKey: string;
  title: string;
  body: string;
  /** Destination au clic — par défaut le centre d'alerte. */
  url?: string;
}
