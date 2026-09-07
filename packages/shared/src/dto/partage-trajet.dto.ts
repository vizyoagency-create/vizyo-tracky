/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LE PARTAGE PUBLIC D'UN TRAJET (2026-09-07)
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le bouton « Partager » du replay copiait l'URL INTERNE de l'application
 * (`/reports?from=…&to=…&trip=…`). Envoyée au conducteur concerné — qui n'a pas de compte
 * Tracky — elle affichait un écran de connexion. Le lien ne partageait rien, et l'écran
 * annonçait pourtant « Lien copié ».
 *
 * ⚠️ CE CONTRAT EST CALQUÉ SUR CELUI DU SUIVI DE LIVRAISON (`depot.dto`), délibérément. Même
 * token opaque, même expiration serveur, même révocation, même suivi d'usage. Un second
 * mécanisme de lien public aurait fini par avoir sa propre idée de la sécurité.
 */

/** Les durées offertes. Pas de durée libre : elle finirait à « un an » un jour de presse. */
export type TripShareDurationDto = 'HOUR_1' | 'HOUR_24' | 'DAY_7';

export const TRIP_SHARE_DUREES: readonly TripShareDurationDto[] = ['HOUR_1', 'HOUR_24', 'DAY_7'];

/**
 * La durée par DÉFAUT.
 *
 * ⚠️ 24 h et non la plus courte, contrairement au suivi de livraison qui protège par défaut.
 * Les deux usages n'ont pas le même rythme : un suivi de livraison se regarde pendant la
 * livraison, un trajet se relit le lendemain — « je te l'envoie ce soir, tu regarderas
 * demain ». Un défaut d'un quart d'heure aurait fait générer trois liens pour un seul partage,
 * ce qui protège moins, pas plus.
 */
export const TRIP_SHARE_DUREE_DEFAUT: TripShareDurationDto = 'HOUR_24';

/**
 * Combien de liens VIVANTS un même trajet peut porter.
 *
 * ⚠️ Une borne, parce que « partager » est un geste qu'on répète sans y penser : sans elle,
 * un trajet finit avec quinze liens ouverts dont personne ne sait à qui ils ont été envoyés.
 * Le plafond force à révoquer avant de re-partager — donc à regarder la liste.
 */
export const TRIP_SHARE_MAX_ACTIFS_PAR_TRAJET = 3;

/** Ce qu'un lien montre à son propriétaire. Le token n'y est JAMAIS : cf. `TripShareCreatedDto`. */
export interface TripShareLinkDto {
  id: string;
  tripId: string;
  duration: TripShareDurationDto;
  expiresAt: string;
  createdAt: string;
  /** Le nom de qui a créé le lien — un accès public sans auteur n'est assumé par personne. */
  createdByName: string | null;
  /** « ouvert 3 fois, dernière il y a 4 min ». */
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  /** Empreinte TRONQUÉE (« 92.184.x.x ») : distinguer deux destinataires, pas identifier. */
  lastOpenedFrom: string | null;
  revokedAt: string | null;
  /** Vrai tant qu'il n'est ni expiré ni révoqué. */
  active: boolean;
}

/**
 * Le retour de la CRÉATION — le SEUL moment où le token transite.
 *
 * ⚠️ La liste ne le renvoie jamais. Un écran de surveillance qui affiche les tokens est un
 * écran depuis lequel on peut rouvrir n'importe quel lien : la surveillance servirait alors
 * exactement à ce qu'elle prétend empêcher.
 */
export interface TripShareCreatedDto extends TripShareLinkDto {
  token: string;
  /** L'URL complète, prête à coller dans un message. */
  url: string;
}

/** Une ligne de l'écran de surveillance : le lien, et de quel trajet il parle. */
export interface TripShareLinkAvecTrajetDto extends TripShareLinkDto {
  trip: {
    startedAt: string;
    endedAt: string | null;
    distanceKm: number;
    plate: string;
  } | null;
}

/**
 * ── CE QUE VOIT LE DESTINATAIRE ─────────────────────────────────────────────────────────
 *
 * Un trajet, et RIEN d'autre. Ni le nom de la société, ni les autres véhicules, ni le moindre
 * lien vers l'application : le destinataire n'a pas de compte et n'a pas à savoir qu'il en
 * existe une.
 *
 * ⚠️ LE CONDUCTEUR N'Y EST PAS. Un lien envoyé à un tiers — un client, un assureur, un
 * collègue — nommerait sinon une personne qui n'a pas consenti à ce partage. La plaque suffit
 * à identifier le trajet pour qui le reçoit légitimement.
 */
export interface PartageTrajetPublicDto {
  plate: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  distanceKm: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  /** Le tracé, en [lng, lat] — l'objet même du partage. */
  path: [number, number][];
  /** Quand ce lien cesse de fonctionner : le destinataire doit le savoir avant de le ranger. */
  expiresAt: string;
}
