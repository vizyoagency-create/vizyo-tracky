/**
 * TRK-046 — événement émis par l'ingestion quand un véhicule HORS CHAMP GPS réapparaît EN
 * MOUVEMENT. C'est le déclencheur du filet de sécurité de la présomption de stationnement :
 * l'écouteur (vehicle-schedules/sortie-hors-horaire.service) décide seul si la réapparition
 * tombe hors horaire autorisé — l'ingestion ne connaît que les faits GPS, jamais le planning.
 *
 * Découplage par événement (même motif que SMS_INBOUND_EVENT) : aucun lien de module entre
 * l'ingestion et le domaine des horaires, donc aucun risque de cycle DI.
 */
export const SORTIE_HORS_CHAMP_EVENT = 'gps.sortie-hors-champ';

export interface SortieHorsChampEvent {
  trackerId: string;
  imei: string;
  vehicleId: string;
  fleetId: string;
  plate: string;
  /** Instant de la trame de réapparition (deviceTime). ISO 8601. */
  at: string;
  /** Début de l'obscurité = dernière position valide AVANT le trou. ISO 8601. */
  sombreDepuis: string;
  /** Durée du trou sans position (ms). */
  sombreMs: number;
  /** Vitesse de la trame de réapparition (km/h) — toujours > seuil d'arrêt à l'émission. */
  speedKmh: number;
  lat: number;
  lng: number;
  /**
   * Le lieu de la perte (l'ancre) était-il un parking validé ? `true` → le véhicule était
   * « considéré stationné » et la coupe programmée ne lui a volontairement pas été martelée.
   */
  lieuValide: boolean;
}
