/**
 * Lot V5 (2026-09-03) — ALERTES DE VITESSE NÉES DE L'ANALYSE DE TRAJET.
 *
 * ── CE QUI MANQUAIT ──────────────────────────────────────────────────────────────────────
 * La seule alerte d'excès venait d'un bit d'alarme du boîtier : seuil fixe, aucune limite
 * légale, 1 627 alertes en un mois pour une seule société, toutes acquittées en bloc — et pas
 * une pour un trajet à 168 km/h dont l'analyse connaissait pourtant la limite. Tracky mesurait
 * l'excès, le rangeait dans un rapport, et n'en prévenait personne.
 *
 * Ces réglages gouvernent la NOUVELLE alerte, celle qui compare la vitesse mesurée à la limite
 * légale de la voie. Ils vivent sur la société et se surchargent par véhicule.
 */

/** Dépassement minimal acceptable en réglage (km/h au-dessus de la limite). */
export const SPEED_ALERT_OVER_MIN_KMH = 5;
export const SPEED_ALERT_OVER_MAX_KMH = 100;
/** Plafond absolu acceptable en réglage (km/h). */
export const SPEED_ALERT_ABSOLUTE_MIN_KMH = 50;
export const SPEED_ALERT_ABSOLUTE_MAX_KMH = 200;

/** Défauts appliqués à une société qui n'a jamais réglé ses alertes de vitesse. */
export const SPEED_ALERT_DEFAULTS = {
  enabled: false,
  overKmh: 20,
  /** Aucune route française n'autorise davantage. */
  absoluteKmh: 130,
} as const;

/**
 * À partir de ce dépassement, l'alerte est CRITIQUE et non plus un avertissement. C'est le
 * seuil du délit routier en France (50 km/h et plus au-dessus de la limite) : la loi elle-même
 * change de registre à cet endroit, l'alerte fait de même.
 */
export const EXCES_CRITIQUE_KMH = 50;

/** Réglage d'une société, tel qu'il s'affiche et se modifie. */
export interface FleetSpeedAlertSettingsDto {
  fleetId: string;
  fleetName: string;
  enabled: boolean;
  overKmh: number;
  absoluteKmh: number | null;
  /** Dernière modification — qui et quand, pour que le réglage ait un auteur. */
  updatedAt: string | null;
  updatedBy: string | null;
  /** Véhicules qui dérogent au réglage de la société. */
  vehicles: VehicleSpeedAlertOverrideDto[];
}

/** Une dérogation véhicule : chaque champ nul hérite de la société. */
export interface VehicleSpeedAlertOverrideDto {
  vehicleId: string;
  plate: string;
  enabled: boolean | null;
  overKmh: number | null;
}

export interface SetFleetSpeedAlertSettingsDto {
  enabled: boolean;
  overKmh: number;
  absoluteKmh: number | null;
}

export interface SetVehicleSpeedAlertOverrideDto {
  enabled: boolean | null;
  overKmh: number | null;
}
