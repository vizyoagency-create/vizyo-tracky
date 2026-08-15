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
/**
 * A6 — UNE version de la tournee, telle que le DEPOT la relit.
 *
 * ⚠️ Volontairement plus pauvre que le DTO du transporteur : ni identifiant d'auteur,
 * ni `placeId`, ni note interne. Le depot doit pouvoir repondre a « qu'est-ce qui a
 * change, quand, par qui, et combien ca coute » — pas obtenir l'annuaire interne de
 * son transporteur.
 */
export interface DepotStopRevisionDto {
  /** Rang de la version. 0 = l'etat a la creation de la mission. */
  position: number;
  /** Nom FIGE a l'ecriture : un compte supprime ne doit pas effacer sa signature. */
  authorName: string;
  /** Ce que l'auteur a repondu a « pourquoi ». Absent sur la version initiale. */
  reason: string | null;
  /** Les arrets de CETTE version, dans l'ordre. Libelles seuls. */
  stops: string[];
  distanceKm: number | null;
  /** Tarif de cette version en centimes HT. `null` = sur devis, ou pas de grille. */
  amountCents: number | null;
  /** Le tarif d'AVANT, pour lire l'ecart sans rejouer l'historique. */
  previousAmountCents: number | null;
  createdAt: string;
}

export interface DepotMissionDto {
  id: string;
  /** Reference lisible : « M-2481 ». */
  ref: string;
  /** Libelle seul, jamais un `FleetPlace` complet (qui porterait des coordonnees). */
  origin: string;
  destination: string;
  /**
   * A6 / T8 — les arrets de la tournee, dans l'ordre de passage. LIBELLES SEULS, pour
   * la meme raison qu'`origin` et `destination` : un `FleetPlace` complet livrerait au
   * tiers les coordonnees des lieux cles de son transporteur, dont il n'a que faire.
   *
   * VIDE pour une mission point a point — l'ecran retombe alors sur
   * `origin -> destination`, exactement comme avant T8. C'est ce qui rend ce champ
   * additif sans reprendre aucun affichage existant.
   *
   * ⚠️ NE PAS CONFONDRE AVEC `DepotTripDto.stops`, qui compte les ARRETS DETECTES par
   * le boitier pendant le trajet. Ceux-la sont subis et constates ; ceux-ci sont
   * planifies. Les deux coexistent sur le meme ecran et ne veulent pas dire la meme
   * chose : « 3 arrets » sur la fiche trajet peut parfaitement accompagner une tournee
   * a 4 arrets prevus.
   */
  stops: string[];
  /**
   * A6 — L'HISTORIQUE DES TOURNEES, du plus ancien au plus recent.
   *
   * ┌─ POURQUOI LE DEPOT Y A DROIT ─────────────────────────────────────────────┐
   * │ Une tournee qui change change aussi le PRIX : trois livraisons de plus, et │
   * │ la distance saute d'une tranche. Sans cet historique, le depot decouvre    │
   * │ l'ecart sur sa facture et n'a aucun moyen de savoir ce qui a bouge, quand, │
   * │ ni pourquoi. C'est exactement l'appel telephonique que tout ce lot cherche │
   * │ a eviter.                                                                  │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * VIDE pour les missions creees avant cette version, et pour celles dont la
   * tournee n'a jamais bouge — l'ecran n'affiche alors rien du tout.
   */
  stopHistory: DepotStopRevisionDto[];
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
