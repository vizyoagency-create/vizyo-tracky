/**
 * Espace depot (2026-08) — les DTO du bloc A.
 *
 * `DepotMissionDto` est un CONTRAT DE FUITE, pas un simple type : il enumere
 * exhaustivement ce qu'un compte DEPOT recoit. **Tout champ absent d'ici ne doit
 * jamais transiter.** Cf. design/A1-ROLE-DEPOT.md § 4.
 */

export type MissionStatusDto = 'PLANNED' | 'IN_PROGRESS' | 'LATE' | 'DONE' | 'CANCELLED';

/**
 * Le vehicule, vu par un depot.
 *
 * La PLAQUE est sa cle, et elle est publique — c'est ce qu'il lit sur le camion qui
 * se presente a son quai. L'identifiant interne, lui, ne sort jamais : il permettrait
 * d'interroger d'autres endpoints et de deviner la taille de la flotte (A3 § 7, regle 3).
 */
export interface DepotMissionVehicleDto {
  plate: string;
  /** « Renault D 12 t ». Null si le transporteur n'a pas renseigne de libelle. */
  label: string | null;
  // Volontairement ABSENTS : id, imei, groupe, couts, scores, consommation.
}

/**
 * Le conducteur, vu par un depot. Servi UNIQUEMENT si `driver_contact_view`.
 */
export interface DepotMissionDriverDto {
  /** « Karim B. » — prenom + initiale. Jamais le nom complet. */
  displayName: string;
  /**
   * ⚠️ MASQUE COTE SERVEUR : « 06 12 •• •• 47 ». Le numero complet ne quitte pas
   * l'API. Le bouton « appeler » passe par un endpoint dedie qui journalise l'acces —
   * sinon le masquage ne serait qu'un habillage, contourne par l'onglet reseau.
   */
  phone: string | null;
}

/**
 * Une mission, vue par son depot destinataire.
 *
 * Ce que ce DTO n'expose PAS, et pourquoi :
 *   - l'identifiant du vehicule    → permettrait d'interroger d'autres routes
 *   - le cout, le score, la conso  → donnees d'exploitation du transporteur (A3 § 7)
 *   - le groupe du vehicule        → revele l'organisation de la flotte
 *   - les notes de la mission      → notes internes du transporteur (A2 § 5)
 *   - le trace parcouru            → revele les points de livraison precedents,
 *                                     donc les autres clients (A4 § 2)
 */
export interface DepotMissionDto {
  id: string;
  /** Reference lisible : « M-2481 ». */
  ref: string;
  /** Libelle seul, jamais un `FleetPlace` complet (qui porterait des coordonnees). */
  origin: string;
  destination: string;
  /** ISO 8601. La fenetre annoncee au depot. */
  startAt: string;
  endAt: string;
  status: MissionStatusDto;
  vehicle: DepotMissionVehicleDto;
  /** Null si `driver_contact_view` n'est pas accordee, ou si aucun conducteur. */
  driver: DepotMissionDriverDto | null;
  /** Heure d'arrivee estimee, ISO 8601. Null tant qu'elle n'est pas calculable. */
  etaAt: string | null;
  /**
   * Retard en minutes, CALCULE A LA VOLEE — jamais stocke, il change a chaque minute.
   * `now - endAt` si en cours, `actualEndAt - endAt` si terminee (A2 § 2).
   */
  delayMinutes: number | null;
  /** `Fleet.name` — la marque du transporteur. L'espace lui appartient visuellement. */
  carrierName: string;
}

/**
 * Masque un numero de telephone pour l'affichage : « 0612345647 » → « 06 12 •• •• 47 ».
 *
 * A appliquer COTE SERVEUR, avant serialisation. Un masquage cote template laisserait
 * le numero complet dans la reponse HTTP — visible dans l'onglet reseau, et donc
 * strictement equivalent a ne rien masquer.
 *
 * Garde les 4 premiers chiffres (indicatif + debut, qui ne suffisent pas a joindre) et
 * les 2 derniers (qui permettent au depot de reconnaitre un appel entrant du conducteur).
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let chiffres = phone.replace(/\D/g, '');

  // `User.phone` est stocke en E.164 (« +33612345678 », cf. schema.prisma). Le cas
  // international est donc le cas COURANT, pas l'exception. Sans cette normalisation,
  // un numero francais s'afficherait « 33 61 •• •• 78 » — un indicatif pays presente
  // comme un debut de numero, que personne ne reconnait.
  if (chiffres.length === 11 && chiffres.startsWith('33')) {
    chiffres = '0' + chiffres.slice(2);
  }

  if (chiffres.length < 6) return '••';
  const debut = chiffres.slice(0, 4);
  const fin = chiffres.slice(-2);
  return `${debut.slice(0, 2)} ${debut.slice(2, 4)} •• •• ${fin}`;
}
