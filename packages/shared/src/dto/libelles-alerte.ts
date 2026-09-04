/**
 * LIBELLÉS LISIBLES DES ALERTES — une seule table, pour tous les écrans et tous les fichiers.
 *
 * ── POURQUOI ELLE DÉMÉNAGE ICI (2026-09-04) ─────────────────────────────────────────────
 *
 * Elle vivait dans le générateur de PDF, et nulle part ailleurs. Le PDF disait donc « Excès de
 * vitesse » là où le CSV et l'écran écrivaient `OVERSPEED` — un client qui lit les deux se
 * demande légitimement s'il s'agit de la même chose. Et le jour où un type d'alerte s'ajoute,
 * une table recopiée fait diverger les deux documents sans qu'aucun test ne s'en aperçoive.
 *
 * ⚠️ Ce fichier ne connaît ni Prisma ni Angular : c'est la condition pour qu'il n'y en ait
 * qu'un. Toute traduction d'un type d'alerte en français passe par ici.
 */

/** Types d'alerte, en clair. */
export const LIBELLES_TYPE_ALERTE: Record<string, string> = {
  OVERSPEED: 'Excès de vitesse',
  GEOFENCE_EXIT: 'Sortie de zone',
  GEOFENCE_ENTER: 'Entrée de zone',
  GPS_LOST: 'Signal GPS perdu',
  LOW_BATTERY: 'Batterie faible',
  POWER_CUT: 'Alimentation coupée',
  SOS: 'Appel SOS',
  OFF_SCHEDULE_MOVEMENT: 'Déplacement hors horaires',
  TOWING: 'Remorquage suspecté',
  TOW: 'Remorquage suspecté',
  ACCIDENT: 'Accident suspecté',
  COLLISION: 'Collision détectée',
  TAMPER: 'Tentative de retrait du boîtier',
  ILLEGAL_IGNITION: 'Démarrage non autorisé',
  MOVEMENT_IDLE: 'Mouvement véhicule éteint',
  HARSH_BRAKING: 'Freinage brusque',
  HARSH_ACCELERATION: 'Accélération brusque',
  HARSH_TURN: 'Virage brusque',
  FATIGUE: 'Fatigue conducteur',
  IDLE_TIME: 'Ralenti prolongé',
  BONNET: 'Capot ouvert',
  DOOR: 'Porte ouverte',
  VIBRATION: 'Vibration détectée',
  SURVEILLANCE_TRIGGERED: 'Surveillance déclenchée',
  MAINTENANCE_DUE: 'Entretien à prévoir',
  PRICING_GRID_MISSING: 'Grille tarifaire absente',
  ENGINE_CUT: 'Moteur coupé à distance',
  UNKNOWN: 'Autre',
};

/** Gravités, en clair. */
export const LIBELLES_GRAVITE_ALERTE: Record<string, string> = {
  CRITICAL: 'Critique',
  WARNING: 'Avertissement',
  INFO: 'Information',
};

/**
 * Le libellé d'un type d'alerte.
 *
 * ⚠️ Un type INCONNU n'est jamais rendu tel quel en majuscules à vis. Il est mis en forme
 * (`ILLEGAL_IGNITION` → « Illegal ignition ») : un mot lisible mais non traduit se remarque et
 * se corrige, là où un `ILLEGAL_IGNITION` brut passe pour une panne d'affichage.
 */
export function libelleTypeAlerte(type: string): string {
  return (
    LIBELLES_TYPE_ALERTE[type]
    ?? type.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

/** La gravité d'une alerte, en clair. Rend la valeur d'origine si elle est inconnue. */
export function libelleGraviteAlerte(gravite: string): string {
  return LIBELLES_GRAVITE_ALERTE[gravite] ?? gravite;
}
