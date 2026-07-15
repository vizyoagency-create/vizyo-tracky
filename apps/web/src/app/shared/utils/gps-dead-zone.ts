import type { GpsDeadZoneLabel, GpsDeadZoneStatus } from '../../core/services/gps-dead-zones.service';

/**
 * Helpers d'affichage/rattachement des zones mortes GPS (suivi FS-253). Partagés par la fiche
 * véhicule et la carte pour éviter toute divergence de libellés / de seuil de rattachement.
 */

/** Distance haversine (m) entre deux points. */
export function deadZoneDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Forme minimale géographique d'une zone (partagée par GpsDeadZoneDto et GpsDeadZoneMapDto). */
interface DeadZoneGeo {
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
}

/** Zone morte contenant le point (marge alignée sur le rayon de rattachement backend ≈ 150 m), ou null. */
export function matchDeadZone<T extends DeadZoneGeo>(zones: T[], lat: number, lng: number): T | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return (
    zones.find((z) => deadZoneDistanceM(z.centroidLat, z.centroidLng, lat, lng) <= Math.max(150, z.radiusM + 60)) ??
    null
  );
}

/** Libellé court du statut d'une zone. */
export function deadZoneStatusLabel(s: GpsDeadZoneStatus): string {
  switch (s) {
    case 'CONFIRMED_BENIGN':
      return 'Normale';
    case 'SUSPECT':
      return 'Suspecte';
    case 'RECURRING':
      return 'Récurrente';
    default:
      return 'En apprentissage';
  }
}

/** Nature (confirmée, sinon suggérée) d'une zone, en clair — suffixe « probable » si non confirmée. */
export function deadZoneNatureLabel(z: { label: GpsDeadZoneLabel; suggestedLabel: GpsDeadZoneLabel | null }): string {
  const explicit = z.label !== 'UNKNOWN';
  const l: GpsDeadZoneLabel = explicit ? z.label : z.suggestedLabel ?? 'UNKNOWN';
  const suffix = !explicit && l !== 'UNKNOWN' ? ' probable' : '';
  switch (l) {
    case 'UNDERGROUND_PARKING':
      return 'parking souterrain' + suffix;
    case 'COVERED_PARKING':
      return 'parking couvert' + suffix;
    case 'TUNNEL':
      return 'tunnel' + suffix;
    case 'JAMMER_SUSPECTED':
      return 'brouilleur suspecté';
    case 'OTHER':
      return 'autre';
    default:
      return 'cause à qualifier';
  }
}
