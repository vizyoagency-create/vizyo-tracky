/**
 * Espace depot (2026-08) — les DTO du lot A3 : les ecrans.
 *
 * `mission.dto.ts` porte `DepotMissionDto`, le contrat d'A1. Ce fichier-ci porte ce
 * que les QUATRE ONGLETS ajoutent : la carte live, l'historique et ses KPI, les
 * documents, le trajet detaille, et les deux seules ecritures d'un depot.
 *
 * ┌─ MEME REGLE QU'EN A1 ─────────────────────────────────────────────────────┐
 * │ Chaque interface est un CONTRAT DE FUITE : elle enumere exhaustivement ce   │
 * │ qu'un compte DEPOT recoit. Tout champ absent d'ici ne doit jamais transiter.│
 * │ En particulier : ni cout, ni score de conduite, ni consommation, ni         │
 * │ identifiant interne de vehicule, de boitier ou de flotte (A3 § 7).          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Cf. design/A3-ESPACE-DEPOT.md.
 */

import type { DepotMissionDto } from './mission.dto';

/** Duree de conservation de l'historique d'un depot. Ecrite dans l'interface, pas
 *  seulement dans les CGU (A3 § 3) — d'ou une constante partagee plutot qu'un
 *  « 12 mois » recopie dans un template et oublie le jour ou la regle changera. */
export const DEPOT_RETENTION_MONTHS = 12;

/**
 * Taille d'echantillon en dessous de laquelle le « % a l'heure » n'est PAS affiche.
 *
 * Un taux sur deux missions n'est pas une note, c'est du bruit : une mission en
 * retard sur deux affiche « 50 % », ce que le depot lira comme un jugement sur son
 * transporteur. On prefere un tiret EXPLIQUE (A3 § 6).
 */
export const DEPOT_KPI_MIN_SAMPLE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// 1. La carte live
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une position servie a un depot. Notez ce qui n'y est PAS : ni `vehicleId`, ni
 * `trackerId`, ni `fleetId`. La mission est la seule cle — c'est par elle que le
 * depot a le droit de voir ce point, et elle suffit a le rattacher a une carte.
 */
export interface DepotPositionDto {
  missionId: string;
  lat: number;
  lng: number;
  speedKmh: number | null;
  /** ISO 8601 — l'heure de la position, PAS l'heure de la reponse. C'est elle qui
   *  permet d'ecrire « rafraichie il y a 12 s » sans mentir. */
  at: string;
  /**
   * Distance restante jusqu'au point de livraison, en km (A3 § 1).
   *
   * ⚠️ CALCULE COTE SERVEUR, et null quand il n'est pas calculable. Le DTO de mission
   * ne porte QUE des libelles de lieu, jamais leurs coordonnees (A1 § 4) : servir la
   * latitude de la destination pour que le navigateur fasse la soustraction
   * reviendrait a livrer par la fenetre ce que la porte refuse.
   *
   * Null quand la destination est une adresse libre plutot qu'un lieu cle : on
   * n'affiche alors rien, plutot qu'une estimation qu'on ne saurait pas justifier.
   */
  remainingKm: number | null;
}

/**
 * L'etat d'une position qu'on NE SERT PAS. Servi a la place de `DepotPositionDto`
 * quand le boitier s'est tu : « indisponible depuis 14 min ».
 *
 * Une derniere position connue presentee comme actuelle est le pire des deux
 * mondes — fausse ET credible (A1 § 6).
 */
export interface DepotPositionUnavailableDto {
  missionId: string;
  /** Minutes ecoulees depuis la derniere position connue. 0 = jamais de position. */
  unavailableSince: number;
  /**
   * `SUSPENDED` = le suivi est SUSPENDU, sans en dire la raison.
   *
   * ⚠️ Le libelle est volontairement muet (A3 § 8). Le vehicule est en mode vie privee :
   * dire pourquoi reviendrait a apprendre au depot ce que le conducteur fait de son
   * temps personnel — exactement ce que le mode vie privee protege. « Suivi suspendu »
   * suffit a expliquer l'absence sans la commenter.
   *
   * `UNAVAILABLE` = le boitier s'est tu ; la duree est alors pertinente et affichee.
   */
  reason: 'UNAVAILABLE' | 'SUSPENDED';
}

/**
 * La lecture unique de l'ecran carte.
 *
 * ⚠️ POURQUOI UN SEUL APPEL, et pas `GET /depot/missions` suivi de N appels
 * `/depot/missions/:id/position` : ces N appels repondent `403` pour toute mission
 * dont le suivi n'est pas actif. Un ecran qui declenche des 403 a chaque
 * rafraichissement rend les VRAIS refus illisibles dans les journaux — et c'est
 * par les journaux qu'on verifie l'isolation.
 */
export interface DepotLiveDto {
  /** `Fleet.name`. La marque du transporteur, en tete de l'espace (A3 § 7, regle 5). */
  carrierName: string;
  /** Le nom du depot connecte, tel qu'il se lit dans l'en-tete. */
  depotName: string;
  missions: DepotMissionDto[];
  /** Uniquement les missions au suivi ACTIF. Une mission planifiee n'y figure pas. */
  positions: DepotPositionDto[];
  /** Missions au suivi actif dont le boitier s'est tu. Disjoint de `positions`. */
  unavailable: DepotPositionUnavailableDto[];
  /**
   * Camions du transporteur qui ne sont sur AUCUNE mission de ce depot.
   *
   * ⚠️ C'est le SEUL chiffre de tout l'espace depot qui se calcule sur la flotte et
   * non sur les missions du depot — l'unique exception a la regle 1 d'A3 § 7, et
   * elle est deliberee. Sans elle, l'encart dirait « les autres camions », ce qui ne
   * repond pas a la question que se pose un depot qui sait que son transporteur en a
   * sept : « pourquoi je n'en vois que quatre ? ». Le chiffre transforme une absence
   * suspecte en garantie explicite — et c'est cet argument qui a permis au
   * transporteur d'ouvrir l'acces (A3 § 1).
   */
  otherVehiclesCount: number;
  /** Heure SERVEUR a l'emission. Le compteur de fraicheur s'y cale plutot que sur
   *  l'horloge du poste, qui peut deriver de plusieurs minutes. */
  serverTime: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Le trajet detaille
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une etape du deroule horodate.
 *
 * `dwellMinutes` — le temps passe SUR PLACE — est l'information qui distingue
 * « le camion est parti a 8h15 » de « le camion a attendu 14 minutes au premier
 * point ». C'est elle qui permet au depot de comprendre un retard sans appeler
 * (A3 § 5). Sans elle, le deroule n'est qu'une liste d'heures.
 */
export interface DepotTripStepDto {
  label: string;
  /** ISO 8601. Heure prevue — presente pour le depart et l'arrivee seulement. */
  plannedAt: string | null;
  /** ISO 8601. Heure REELLE. Null = etape a venir, affichee en tirete. */
  actualAt: string | null;
  /** Minutes passees sur place. Null si l'etape n'est pas un arret mesure. */
  dwellMinutes: number | null;
  /** Faux = etape a venir (tirete + heure estimee). */
  done: boolean;
}

/** Le trajet d'une mission, vu par son depot. */
export interface DepotTripDto {
  /** La mission, pas le trajet : c'est la reference que le depot connait. */
  missionRef: string;
  missionId: string;
  origin: string;
  destination: string;
  plate: string;
  /**
   * Les 4 tuiles de la modale (A3 § 5).
   *
   * `null` = PAS ENCORE MESURABLE, et l'interface affiche un tiret. Un « 0 km » sur
   * une mission en cours se lit comme une mesure — « le camion n'a pas bougé » —
   * alors qu'il signifie « le trajet n'est pas encore clos ». Même règle que pour les
   * positions périmées : on ne présente jamais une absence comme une valeur.
   */
  distanceKm: number | null;
  durationMinutes: number;
  stops: number | null;
  /** ISO 8601. Arrivee reelle si terminee, estimee sinon. Null si incalculable. */
  etaAt: string | null;
  /**
   * Le trace de CE trajet, encode polyline. Borne a la mission : il ne revele donc
   * pas les points de livraison des autres clients du transporteur (A4 § 2).
   */
  polyline: string | null;
  /** Position actuelle, uniquement si le suivi est actif. Null sinon. */
  currentPosition: { lat: number; lng: number; at: string } | null;
  steps: DepotTripStepDto[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. L'historique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les 4 KPI, CALCULES COTE SERVEUR.
 *
 * Un calcul cote client obligerait a servir toutes les missions de la periode pour
 * en deriver quatre nombres — soit exactement le contraire du principe du DTO
 * restreint (A3 § 8).
 */
export interface DepotHistoryKpisDto {
  /** Missions livrees sur la periode (statut DONE). */
  delivered: number;
  /**
   * Le « % a l'heure » : `actualEndAt <= endAt` sur les missions DONE.
   *
   * C'est la NOTE DU TRANSPORTEUR — l'indicateur que le depot regarde vraiment.
   * Null quand l'echantillon est trop petit pour qu'il veuille dire quelque chose ;
   * l'interface affiche alors un tiret EXPLIQUE, jamais « 0 % ».
   */
  onTimePercent: number | null;
  /** Taille de l'echantillon, pour ecrire « 2 missions seulement, un taux demande 5 ». */
  onTimeSampleSize: number;
  /** Duree moyenne reelle, en minutes. Null si aucune mission mesurable. */
  avgDurationMinutes: number | null;
  /** Retard moyen des missions EN RETARD (pas de toutes : la moyenne serait diluee). */
  avgDelayMinutes: number | null;
  /** Le « avec le nombre de cas » d'A3 § 3. */
  delayedCount: number;
}

/** Une ligne du tableau d'historique. */
export interface DepotHistoryRowDto {
  missionId: string;
  ref: string;
  origin: string;
  destination: string;
  /** ISO 8601 — la date de la mission (son `startAt` prevu). */
  date: string;
  /** Le creneau REEL. Null tant que la mission n'a pas ete cloturee. */
  actualStartAt: string | null;
  actualEndAt: string | null;
  plate: string;
  driverName: string | null;
  distanceKm: number | null;
  stops: number | null;
  /** Vrai = livree dans le creneau annonce. Null = incalculable (pas de cloture). */
  onTime: boolean | null;
  delayMinutes: number | null;
  /** Identifiant du trajet, pour ouvrir la modale de detail. Null si non rattache. */
  tripId: string | null;
}

export interface DepotHistoryDto {
  rows: DepotHistoryRowDto[];
  kpis: DepotHistoryKpisDto;
  /**
   * Total des missions du depot conservees, toutes periodes confondues.
   *
   * Sert le pied de tableau « 6 trajets sur 23 ». ⚠️ Ce 23 est un compte des
   * missions DU DEPOT, pas des trajets de la flotte : le depot ne doit rien pouvoir
   * deduire du volume d'activite de son transporteur (A3 § 7, regle 1).
   */
  totalRetained: number;
  /** Les plaques et destinations presentes dans l'historique, pour peupler les filtres. */
  plates: string[];
  destinations: string[];
  retentionMonths: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Les documents
// ─────────────────────────────────────────────────────────────────────────────

export type DepotDocumentKind = 'WEEKLY_REPORT' | 'DELIVERY_NOTE' | 'PERIOD_EXPORT';

export interface DepotDocumentDto {
  /** Identifiant OPAQUE de telechargement, pas une cle de base. */
  id: string;
  kind: DepotDocumentKind;
  label: string;
  /** ISO 8601 — la date que porte le document, pas celle de sa generation. */
  at: string;
  format: 'PDF' | 'CSV';
  /** Reference de mission, pour les bons de livraison. Null sinon. */
  missionRef: string | null;
}

export interface DepotDocumentsDto {
  documents: DepotDocumentDto[];
  /** Interrupteur « rapport automatique » — actif par defaut (A3 § 4). */
  weeklyReportEnabled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Les deux seules ecritures d'un depot
// ─────────────────────────────────────────────────────────────────────────────

/** Les motifs d'A3 § 5. Liste FERMEE : un motif libre serait ininterpretable. */
export type DepotIncidentReason = 'DELAY' | 'GOODS' | 'DEPOT_ACCESS' | 'OTHER';

export interface DepotIncidentInputDto {
  missionId: string;
  reason: DepotIncidentReason;
  /** Texte libre. Borne cote serveur : un depot ne remplit pas la base du transporteur. */
  message?: string;
}

export interface DepotIncidentDto {
  id: string;
  missionRef: string;
  reason: DepotIncidentReason;
  createdAt: string;
}

export type DepotExportFormat = 'PDF' | 'CSV';

export interface DepotExportInputDto {
  from: string;
  to: string;
  format: DepotExportFormat;
}

/**
 * Ce que l'ecran d'export affiche AVANT de generer : combien de trajets sont
 * concernes, et ce que pesera le fichier.
 *
 * Le poids n'est pas une coquetterie : un export lance en 4G sans avertissement est
 * une mauvaise surprise (A3 § 5). Regle deja posee pour `pdf-export-modal`.
 */
export interface DepotExportPreviewDto {
  missionCount: number;
  estimatedBytes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Le partage — lot A4
// ─────────────────────────────────────────────────────────────────────────────

/** Les trois durees d'A4 § 4. Pas de duree libre : un champ « minutes » finirait a
 *  43 200 le jour ou quelqu'un voudra « un lien pour le mois ». */
export type ShareDurationDto = 'MIN_15' | 'HOUR_1' | 'UNTIL_MISSION_END';

/** Nombre maximal de liens ACTIFS par mission (A4 § 3). Au-dela : revoquer d'abord. */
export const SHARE_MAX_ACTIFS_PAR_MISSION = 3;

/**
 * ┌─ LE CONTRAT LE PLUS IMPORTANT DU LOT A4 ──────────────────────────────────┐
 * │ Ce que le lien PUBLIC expose. Tout champ absent d'ici NE DOIT PAS quitter   │
 * │ le serveur. Le destinataire n'est ni authentifie, ni connu, ni consentant : │
 * │ c'est un numero de telephone a qui on a envoye une URL.                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Ce qu'il ne porte PAS, et pourquoi (A4 § 2) :
 *   - la plaque              → identifie un vehicule et son proprietaire
 *   - le nom du conducteur   → donnee personnelle, aucun motif
 *   - le telephone           → idem
 *   - la reference de mission→ permet de deviner le volume d'activite du depot
 *   - l'adresse exacte       → la ville suffit a confirmer « c'est ma livraison »
 *   - l'origine              → revele l'implantation du depot
 *   - le TRACE parcouru      → le piege classique : « d'ou vient le camion » revele
 *                              les points de livraison precedents, donc les AUTRES
 *                              clients. Le lien montre UN POINT, jamais une ligne.
 */
export interface PublicTrackingDto {
  /**
   * `DONE` et `CANCELLED` sont servis pendant une COURTE fenetre apres la cloture —
   * sans aucune position (A4 § 8). Le destinataire qui regardait lit l'issue de son
   * attente (« livraison effectuee a 11:34 », « cette livraison a ete annulee »)
   * plutot que de tomber sur un ecran de lien mort au moment ou elle aboutit.
   */
  status: 'PLANNED' | 'IN_PROGRESS' | 'LATE' | 'DONE' | 'CANCELLED';
  /** Un point, jamais une ligne. Null avant le depart ou si le boitier s'est tu. */
  position: { lat: number; lng: number } | null;
  /** ISO 8601. Heure d'arrivee estimee — ce que le destinataire vient chercher. */
  etaAt: string | null;
  /** La VILLE (« Muret »), pas l'adresse exacte. */
  destinationLabel: string;
  /** Le transporteur assume sa livraison, et c'est sa vitrine. */
  carrierName: string;
  expiresAt: string;
  /** ISO 8601 — l'heure de la POSITION SERVIE. Null des qu'aucun point n'est servi. */
  lastUpdateAt: string | null;
  /**
   * Minutes ecoulees depuis la derniere position connue, quand elle existe mais est
   * TROP VIEILLE pour etre servie : « position indisponible depuis 6 min » (A4 § 8).
   *
   * ⚠️ Null quand le suivi est suspendu (vehicule en mode vie privee) : une duree
   * apprendrait au destinataire QUAND le conducteur est passe en prive. Meme regle
   * qu'en A3 — on dit l'absence, jamais sa raison ni son debut.
   */
  positionUnavailableSince: number | null;
  /** ISO 8601 — le debut annonce, pour « le suivi demarrera a 08:15 » (A4 § 8). */
  startAt: string;
}

/** Un lien tel que son CREATEUR le voit — avec son usage, pour revoquer en connaissance
 *  de cause. Le token n'y figure qu'a la creation : la liste sert a revoquer, pas a
 *  re-copier un lien qu'on aurait laisse filer. */
export interface MissionShareLinkDto {
  id: string;
  duration: ShareDurationDto;
  expiresAt: string;
  createdAt: string;
  /** « ouvert 3 fois, derniere il y a 4 min » (A4 § 4). */
  openCount: number;
  lastOpenedAt: string | null;
  /** Vrai tant qu'il n'est ni expire ni revoque. */
  active: boolean;
}

/** Le retour de la CREATION — le seul moment ou le token transite. */
export interface MissionShareCreatedDto extends MissionShareLinkDto {
  token: string;
  /** L'URL complete, prete a coller dans un SMS. */
  url: string;
}
