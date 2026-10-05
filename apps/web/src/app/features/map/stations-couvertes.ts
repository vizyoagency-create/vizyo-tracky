import { haversineMeters } from '@vizyo/tracky-shared';

/**
 * Stations DÉTECTÉES (rond violet + nombre de passages) et lieux « pompe » de la flotte.
 *
 * Demande du propriétaire du 06/10/2026 : quand une station est devenue un lieu de la flotte
 * (carré émeraude à la pompe), « ne plus afficher le rond violet et le nombre de passages ». Les
 * deux se superposaient au même endroit — et le rond, plus large que la pompe, prenait les clics
 * autour d'elle et ouvrait la card de la station au lieu de celle du lieu.
 */

/**
 * Distance sous laquelle une station détectée et une pompe posée À LA MAIN sont la même station.
 * Une station détectée est le centre des arrêts de ravitaillement, à une vingtaine de mètres des
 * pistes ; une pompe posée à la main l'est à l'œil, sur le bâtiment ou l'entrée. 60 m couvre les
 * deux sans avaler la station d'en face dans le cas courant. Une pompe VALIDÉE depuis la carte
 * porte, elle, le lien `stationId` : la distance ne joue pas.
 */
export const RAYON_MEME_STATION_M = 60;

interface PointStation {
  stationId: string;
  lat: number;
  lng: number;
}

interface LieuPompe {
  kind: string;
  stationId: string | null;
  lat: number;
  lng: number;
}

/**
 * La station détectée d'un lieu « pompe » : celle dont il vient (validation depuis la carte),
 * sinon la plus proche à moins de {@link RAYON_MEME_STATION_M}. C'est elle qui donne à la card
 * de la pompe ses passages, ses véhicules et son dernier prix — le rond violet qui les portait
 * n'est plus dessiné.
 */
export function stationDuLieu<S extends PointStation>(lieu: LieuPompe, stations: readonly S[]): S | undefined {
  if (lieu.kind !== 'FUEL_STATION') return undefined;
  if (lieu.stationId) {
    const liee = stations.find((s) => s.stationId === lieu.stationId);
    if (liee) return liee;
  }
  let plusProche: S | undefined;
  let distanceMin = RAYON_MEME_STATION_M;
  for (const s of stations) {
    const d = haversineMeters(lieu.lat, lieu.lng, s.lat, s.lng);
    if (d <= distanceMin) {
      distanceMin = d;
      plusProche = s;
    }
  }
  return plusProche;
}

/**
 * Les stations détectées qu'un lieu « pompe » AFFICHÉ recouvre — à ne plus dessiner.
 *
 * ⚠️ On ne passe ici que les lieux réellement à l'écran : calque des lieux masqué, plus de pompe,
 * et le rond violet doit revenir — sinon la station disparaîtrait de la carte.
 */
export function stationsCouvertes(
  stations: readonly PointStation[],
  lieuxAffiches: readonly LieuPompe[],
): Set<string> {
  const couvertes = new Set<string>();
  for (const lieu of lieuxAffiches) {
    if (lieu.kind !== 'FUEL_STATION') continue;
    // Le lien d'origine couvre sa station même si son centre a bougé depuis la validation…
    if (lieu.stationId) couvertes.add(lieu.stationId);
    // …et la distance couvre une pompe posée à la main sur une station déjà détectée.
    for (const s of stations) {
      if (haversineMeters(lieu.lat, lieu.lng, s.lat, s.lng) <= RAYON_MEME_STATION_M) couvertes.add(s.stationId);
    }
  }
  return couvertes;
}
