/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA VUE D'ENSEMBLE DES LIENS PUBLICS — TOUTES SOCIÉTÉS, LES DEUX MÉCANISMES
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le produit ouvre des accès publics par deux portes : le PARTAGE DE TRAJET (replay envoyé à
 * un conducteur, un assureur, un client) et le SUIVI DE LIVRAISON (mission suivie par un
 * dépôt). Chacune a son écran de surveillance, par société. Aucune ne répond à la question
 * du propriétaire : « qu'est-ce qui est ouvert, en ce moment, chez TOUS mes clients ? »
 *
 * Sans cette vue, un lien oublié n'est visible que par quelqu'un qui pense à aller le
 * chercher, dans la bonne société, sur le bon écran. C'est la définition d'un accès fantôme.
 *
 * ── CE QUE CETTE VUE SAIT, ET CE QU'ELLE NE SAIT PAS ────────────────────────────────────
 *
 * ⚠️ ELLE NE SAIT PAS QUI A OUVERT UN LIEN, et ce n'est pas une lacune : un destinataire n'a
 * pas de compte, il n'y a personne à nommer. Ce qui est connu, et suffit à décider :
 *
 *   · QUI L'A OUVERT AU SENS DE « QUI L'A CRÉÉ » — un accès public sans auteur n'est assumé
 *     par personne, d'où `creePar` ;
 *   · COMBIEN DE FOIS il a été consulté, et quand pour la première et la dernière fois ;
 *   · UNE EMPREINTE TRONQUÉE de l'appelant (« 92.184.x.x ») — de quoi distinguer deux
 *     destinataires, jamais de quoi identifier une personne.
 *
 * L'écran doit dire cette limite plutôt que de laisser croire qu'il nomme des visiteurs.
 */

/** Les deux portes d'accès public du produit. */
export type TypeLienPartage = 'TRAJET' | 'MISSION';

/**
 * L'état d'un lien, tel qu'on le décide — jamais stocké, toujours dérivé à l'heure serveur.
 *
 * ⚠️ `EXPIRE` et `REVOQUE` sont distincts alors que tous deux refusent l'accès : le premier
 * est arrivé tout seul, le second est une DÉCISION de quelqu'un. Les confondre effacerait la
 * seule information qui permet de dire si un accès a été coupé exprès.
 */
export type EtatLienPartage = 'ACTIF' | 'EXPIRE' | 'REVOQUE';

/** Ce qu'un lien désigne, réduit à ce qui permet de le reconnaître dans une liste. */
export interface CibleLienPartage {
  /** Trajet : la plaque. Mission : la plaque du véhicule affecté, si elle existe. */
  plaque: string | null;
  /** Mission : sa référence (« M-241 »). Trajet : `null`. */
  reference: string | null;
  /** Début du trajet ou de la mission — ce qui date la cible pour l'œil. */
  debutAt: string | null;
}

/** Une ligne de la vue d'ensemble. ⚠️ Le token n'y est JAMAIS : voir plus bas. */
export interface LienPartageAdminDto {
  id: string;
  type: TypeLienPartage;
  etat: EtatLienPartage;

  /** La société propriétaire — la vue est cross-société, la colonne est donc obligatoire. */
  fleetId: string;
  fleetNom: string | null;

  cible: CibleLienPartage;

  /** Qui a ouvert cet accès. `null` seulement si le compte a disparu depuis. */
  creePar: string | null;
  creeAt: string;

  /** L'échéance qui fait foi — prolongations comprises. */
  expireAt: string;
  /** La durée choisie à la CRÉATION, conservée telle quelle pour lire l'histoire du lien. */
  dureeOrigine: string;

  /** « Ouvert 4 fois, la dernière il y a 2 h » — de quoi révoquer en connaissance de cause. */
  nbOuvertures: number;
  premiereOuvertureAt: string | null;
  derniereOuvertureAt: string | null;
  /** Empreinte TRONQUÉE du dernier appelant. Jamais l'adresse complète. */
  derniereOuvertureDe: string | null;

  /** Combien de fois l'échéance a été repoussée — 0 pour un lien jamais prolongé. */
  nbProlongations: number;
  derniereProlongationAt: string | null;
  derniereProlongationPar: string | null;

  revoqueAt: string | null;
  revoquePar: string | null;
}

/**
 * ⚠️ POURQUOI LE TOKEN N'EST PAS DANS CE DTO.
 *
 * Un écran de surveillance qui affiche les jetons est un écran depuis lequel on peut OUVRIR
 * n'importe quel lien surveillé. La surveillance servirait alors exactement à ce qu'elle
 * prétend empêcher. Le jeton ne transite qu'une fois, à la création, chez celui qui partage.
 */

/** Les compteurs de tête : ce qu'on veut savoir avant même de lire la liste. */
export interface ResumeLiensPartagesDto {
  actifs: number;
  /** Actifs ET consultés au moins une fois — un lien vivant que personne n'a ouvert est une
   *  question différente d'un lien vivant qui circule. */
  actifsConsultes: number;
  /** Actifs qui expirent dans moins de 24 h : la colonne « à surveiller aujourd'hui ». */
  actifsExpirantSous24h: number;
  expires: number;
  revoques: number;
  /** Nombre de sociétés ayant au moins un lien actif. */
  societesConcernees: number;
}

export interface VueLiensPartagesDto {
  resume: ResumeLiensPartagesDto;
  liens: LienPartageAdminDto[];
  /** Vrai si la liste a été bornée — l'écran doit le DIRE plutôt que d'avoir l'air complet. */
  tronquee: boolean;
}

/**
 * ── LA PROLONGATION ─────────────────────────────────────────────────────────────────────
 *
 * Les durées offertes sont celles de la création : pas de champ libre, qui finirait à « un
 * an » un jour de presse.
 */
export type DureeProlongation = 'HOUR_1' | 'HOUR_24' | 'DAY_7';

export const DUREES_PROLONGATION: readonly DureeProlongation[] = ['HOUR_1', 'HOUR_24', 'DAY_7'];

/**
 * ⚠️ LE PLAFOND DE VIE TOTALE — 30 JOURS DEPUIS LA CRÉATION.
 *
 * Sans borne, « prolonger » devient « publier » : trois clics et un lien censé durer 24 h vit
 * un trimestre. Le plafond est compté depuis la CRÉATION et non depuis la dernière
 * prolongation, sinon il suffirait de repousser régulièrement pour ne jamais l'atteindre.
 *
 * Au-delà, l'API refuse et l'écran l'explique : il faut alors créer un nouveau lien — geste
 * volontaire, qui laisse une nouvelle trace et un nouveau compteur.
 */
export const PLAFOND_VIE_LIEN_MS = 30 * 24 * 60 * 60 * 1000;

/** Le corps d'une demande de prolongation. */
export interface DemandeProlongationDto {
  duree: DureeProlongation;
}
