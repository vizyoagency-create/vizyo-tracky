import { GpsDeadZoneLabel, GpsDeadZoneStatus } from '@prisma/client';
import type { GpsDeadZone } from '@prisma/client';
import {
  getVehicleConnectivityState,
  type VehicleConnectivityInput,
} from '@vizyo/tracky-shared';

/**
 * ══ TRK-046 — LA PRÉSOMPTION DE STATIONNEMENT (décision du propriétaire, 25/08) ═══════════
 *
 * Un boîtier Coban émet une position toutes les ~20 s. Entre deux positions, le véhicule
 * peut entrer dans un parking souterrain : la dernière vitesse connue reste alors FIGÉE à sa
 * valeur d'entrée (27,15 km/h mesurés sur FZ-862-VY), pendant des heures, alors que le
 * véhicule est à l'arrêt sous terre. Ce fichier porte la règle qui remplace la lecture naïve
 * de cette vitesse :
 *
 *   « Si le lieu de la perte est une zone VALIDÉE comme parking (souterrain ou couvert),
 *     le véhicule est CONSIDÉRÉ STATIONNÉ — ce n'est pas une erreur, c'est le comportement
 *     normal de tous les GPS dans un parking souterrain. Les commandes de coupure ne
 *     l'atteignent de toute façon pas ; le filet de sécurité est la SORTIE : un véhicule
 *     hors champ qui réapparaît en roulant hors horaire autorisé déclenche une alerte. »
 *
 * Les prédicats sont PURS (testables à instant figé — leçon TRK-044) et partagés entre les
 * trois consommateurs : le garde de coupe automatique (engine-control), l'affichage
 * liste/fiche/snapshot (vehicles.service) et l'émetteur d'alerte de sortie (positions).
 */

/**
 * Silence complet au-delà duquel une absence de position vaut « hors champ » (parking
 * profond : le GSM meurt avec le GPS, le boîtier ne produit plus RIEN).
 *
 * ⚠️ 90 min et pas 10 : un véhicule garé dehors, contact coupé, n'émet qu'un heartbeat
 * ~horaire (V1.18). Un seuil plus court classerait « hors champ » tout véhicule sainement
 * garé entre deux heartbeats — et le garde de coupe sauterait sa coupe programmée pour
 * n'importe quel véhicule stationné à moins de 150 m d'une rampe connue.
 */
export const SILENCE_HORS_CHAMP_MIN_MS = 90 * 60 * 1000;

/**
 * Obscurité minimale pour qu'une réapparition compte comme une « sortie » (alerte
 * TRK-046). Aligné sur la fenêtre d'immobilité de la coupe auto (10 min) : en-deçà,
 * c'est un simple trou de couverture en roulant, déjà géré par l'anti-téléportation.
 */
export const RESURFACE_SOMBRE_MIN_MS = 10 * 60 * 1000;

/**
 * Le lieu est-il un parking reconnu — automatiquement (2ᵉ occurrence, décision du
 * propriétaire du 17/08) ou par revue humaine ?
 *
 * ⚠️ Même sémantique que `deadZoneEstSilencieuse` côté web (apps/web/src/app/shared/utils/
 * gps-dead-zone.ts) : le statut bénin seul ne suffit PAS — seule la nature « parking »
 * rend la perte de fix attendue sans limite de durée. Une zone bénigne d'une autre nature
 * (tunnel, OTHER) garde son plafond de silence (TRK-011) et ne présume rien.
 */
export function estZoneParkingValidee(
  zone: Pick<GpsDeadZone, 'status' | 'label'> | null | undefined,
): boolean {
  return (
    !!zone &&
    zone.status === GpsDeadZoneStatus.CONFIRMED_BENIGN &&
    (zone.label === GpsDeadZoneLabel.UNDERGROUND_PARKING ||
      zone.label === GpsDeadZoneLabel.COVERED_PARKING)
  );
}

/** Champs tracker nécessaires aux prédicats — un sous-ensemble strict du modèle Prisma. */
export interface TrackerPourPresomption {
  id: string;
  lastSeenAt: Date | null;
  lastPositionAt: Date | null;
  lastNoFixAt: Date | null;
  lastKnownIgnition: boolean | null;
  lastLat: number | null;
  lastLng: number | null;
  powerLossSuspectAt: Date | null;
}

/**
 * Le véhicule est-il HORS CHAMP GPS ? Deux signatures, et seulement deux :
 *
 *  1. `GPS_LOST` au sens du tri-état partagé : le boîtier ÉMET des trames `no_fix`
 *     fraîches alors que sa dernière position a plus de 30 min — il nous DIT qu'il ne
 *     voit pas le ciel. C'est la signature du parking où le GSM passe (FZ-862-VY).
 *  2. Silence complet ≥ 90 min alors qu'une position existe — le parking profond où le
 *     GSM meurt aussi. Le seuil dépasse le heartbeat horaire d'un véhicule garé dehors
 *     (cf. SILENCE_HORS_CHAMP_MIN_MS) pour ne pas classer « hors champ » un simple
 *     stationnement de nuit.
 *
 * ⚠️ Volontairement PAS de branche sur la vitesse : la dernière vitesse d'un véhicule
 * hors champ est un vestige, jamais une mesure (c'est tout le sujet de TRK-046).
 */
export function estHorsChampGps(
  tracker: Pick<TrackerPourPresomption, 'id' | 'lastSeenAt' | 'lastPositionAt' | 'lastNoFixAt' | 'lastKnownIgnition'>,
  now: number = Date.now(),
): boolean {
  if (!tracker.lastPositionAt) return false; // jamais localisé = AWAITING_GPS, pas « hors champ »
  const etat = getVehicleConnectivityState(
    {
      trackerId: tracker.id,
      lastSeenAt: tracker.lastSeenAt,
      lastPositionAt: tracker.lastPositionAt,
      lastNoFixAt: tracker.lastNoFixAt,
      lastIgnition: tracker.lastKnownIgnition,
    } satisfies VehicleConnectivityInput,
    now,
  );
  if (etat === 'GPS_LOST') return true;
  if (etat === 'OFFLINE' || etat === 'PARKED') {
    return now - tracker.lastPositionAt.getTime() >= SILENCE_HORS_CHAMP_MIN_MS;
  }
  return false;
}

/**
 * Le véhicule doit-il être CONSIDÉRÉ STATIONNÉ dans cette zone ?
 *
 * Trois conditions, toutes nécessaires :
 *  - hors champ GPS (cf. `estHorsChampGps`) ;
 *  - la dernière position valide — l'ancre, figée à l'ENTRÉE du lieu — tombe dans une
 *    zone parking validée (la zone est passée en paramètre : le rattachement spatial
 *    reste du ressort de GpsDeadZonesService, seul juge du rayon) ;
 *  - AUCUN soupçon de coupure d'alimentation en cours (TRK-040) : un boîtier qui a crié
 *    « alimentation externe absente » juste avant de se taire est peut-être en train de
 *    mourir débranché — le présumer stationné éteindrait le seul témoin d'un vol.
 */
export function estStationnementPresume(
  tracker: TrackerPourPresomption,
  zone: Pick<GpsDeadZone, 'status' | 'label'> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (tracker.powerLossSuspectAt != null) return false;
  if (!estZoneParkingValidee(zone)) return false;
  return estHorsChampGps(tracker, now);
}

/**
 * Libellé humain du lieu, pour l'affichage et les messages : le géocodage s'il existe,
 * sinon la nature de la zone. Jamais null pour une zone parking validée.
 */
export function libelleZoneParking(zone: Pick<GpsDeadZone, 'label' | 'placeLabel'>): string {
  const nature =
    zone.label === GpsDeadZoneLabel.COVERED_PARKING ? 'parking couvert' : 'parking souterrain';
  return zone.placeLabel ? `${nature} — ${zone.placeLabel}` : nature;
}
