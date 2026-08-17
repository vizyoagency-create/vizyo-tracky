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

/**
 * La PÉRIODE d'observation d'une zone, pour donner son échelle au compteur de passages.
 *
 * ⚠️ « 9 passages » NE VEUT RIEN DIRE SANS SA PÉRIODE. Neuf pertes en un mois décrivent
 * un trajet quotidien ; neuf en un an décrivent une coïncidence. Le compteur seul laissait
 * l'exploitant sans échelle — or c'est de cette échelle qu'il a besoin pour juger si le
 * lieu est un passage régulier ou un hasard.
 *
 * Un seul passage n'a pas d'étendue : on ne rend que sa date. Afficher « sur 0 jour »
 * aurait l'air d'un défaut d'affichage.
 *
 * `relatif` est injecté plutôt qu'importé : le formatage de date relative appartient à
 * l'appelant (la fiche véhicule a le sien), et le figer ici forcerait deux vérités.
 */
export function deadZonePeriodeLabel(
  z: { occurrences: number; firstSeenAt: string; lastSeenAt: string },
  relatif: (iso: string) => string,
): string {
  const derniere = `dernière ${relatif(z.lastSeenAt)}`;
  if (z.occurrences <= 1) return derniere;

  const debut = new Date(z.firstSeenAt);
  const fin = new Date(z.lastSeenAt);

  // ⚠️ ON COMPARE LES DATES CIVILES, PAS UNE DURÉE. Première version : arrondir l'écart
  // en millisecondes. Elle annonçait « sur 1 jour » pour trois pertes entre 6 h et 20 h
  // du MÊME jour — quatorze heures s'arrondissent à un jour. Le test l'a attrapée.
  // Un écart de 23 h peut aussi enjamber minuit : « le même jour » serait alors faux.
  // La question posée est calendaire, la réponse doit l'être.
  const memeJour =
    debut.getFullYear() === fin.getFullYear() &&
    debut.getMonth() === fin.getMonth() &&
    debut.getDate() === fin.getDate();
  if (memeJour) return `${derniere}, toutes le même jour`;

  const jours = Math.max(1, Math.round((fin.getTime() - debut.getTime()) / 86_400_000));
  if (jours < 31) return `sur ${jours} jour${jours > 1 ? 's' : ''} · ${derniere}`;
  const mois = Math.round(jours / 30);
  return `sur ${mois} mois · ${derniere}`;
}

/**
 * La zone est-elle DÉFINITIVEMENT silencieuse — c'est-à-dire un parking reconnu ?
 *
 * ⚠️ « Confirmée bénigne » NE SUFFIT PAS, et la nuance est la seule qui compte pour
 * l'exploitant. Côté serveur (`gps-integrity`), le silence est inconditionnel sur un
 * parking (souterrain ou couvert) : la durée n'y porte plus d'information, un véhicule
 * peut y dormir tout le week-end. Sur une zone confirmée normale SANS être un parking,
 * le plafond de silence reste actif : au-delà, l'alerte revient.
 *
 * Écrire « aucune alerte ici » sur ces zones-là serait donc faux — et le mensonge se
 * découvrirait le jour où l'alerte tombe, c'est-à-dire au pire moment.
 */
export function deadZoneEstSilencieuse(z: { status: GpsDeadZoneStatus; label: GpsDeadZoneLabel }): boolean {
  return (
    z.status === 'CONFIRMED_BENIGN' &&
    (z.label === 'UNDERGROUND_PARKING' || z.label === 'COVERED_PARKING')
  );
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
