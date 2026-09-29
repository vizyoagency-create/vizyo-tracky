/**
 * Sprint 8 (Palier B) — Réservations de véhicules (créneau + critères) portées par le modèle
 * d'événement S7 (`VehicleEvent` type=RESERVATION). Flux Demande → validation :
 *   REQUESTED (déposée, non bloquant) → CONFIRMED (ferme, bloquant) → IN_PROGRESS → DONE ;
 *   CANCELLED couvre refus/annulation. La réservation est représentée par `VehicleEventDto`
 *   (metadata porte demandeur + critères + motif). Types partagés API ↔ web.
 */

/**
 * Sièges auto (2026-09-28) — deux types, JAMAIS interchangeables : un enfant « bébé » ne peut pas
 * aller dans un siège « enfant », ni l'inverse. La société POSSÈDE des sièges ; chacun est soit
 * INSTALLÉ dans un véhicule (à bord, prêt), soit dans le STOCK (mobile, à installer dans le
 * véhicule retenu). Réglé dans « Paramètres de l'agenda » : le total possédé, la politique, et les
 * sièges à bord de chaque véhicule.
 */
export type ChildSeatType = 'BABY' | 'CHILD';
export const CHILD_SEAT_LABELS: Record<ChildSeatType, string> = { BABY: 'Bébé', CHILD: 'Enfant' };

/**
 * Si le véhicule choisi n'a pas les sièges à bord, le stock peut-il compléter ?
 * - `STOCK_OR_INSTALLED` (défaut) : les sièges à bord comptent, et le stock fournit ce qui manque —
 *   borné par le stock encore disponible sur le créneau ;
 * - `INSTALLED_ONLY` : seuls les sièges déjà installés dans le véhicule comptent ; le stock n'est
 *   jamais promis (personne ne peut installer un siège avant le départ, ou on ne veut pas le gérer).
 */
export type ChildSeatPolicy = 'STOCK_OR_INSTALLED' | 'INSTALLED_ONLY';
export const CHILD_SEAT_POLICY_LABELS: Record<ChildSeatPolicy, string> = {
  STOCK_OR_INSTALLED: 'Sièges installés + stock',
  INSTALLED_ONLY: 'Sièges installés seulement',
};

/** Un compte par type de siège. */
export interface ChildSeatCounts {
  baby: number;
  child: number;
}

/** Sièges installés à bord d'un véhicule de la société. */
export interface VehicleChildSeatsDto {
  vehicleId: string;
  plate: string | null;
  installed: ChildSeatCounts;
  /** Déclaré hors service : ses sièges à bord ne servent à personne tant qu'il ne roule pas. */
  outOfService: boolean;
}

/** L'état des sièges d'une société : possédés, installés (où), en stock, et la politique. */
export interface ChildSeatStockDto {
  fleetId: string;
  policy: ChildSeatPolicy;
  /** Ce que la société possède, par type. */
  total: ChildSeatCounts;
  /** Somme des sièges installés dans ses véhicules. */
  installed: ChildSeatCounts;
  /** En stock (mobiles) = possédés − installés. */
  stock: ChildSeatCounts;
  /** Tous les véhicules de la société (équipés en premier), pour régler ce qui est à bord. */
  vehicles: VehicleChildSeatsDto[];
}

export interface SetChildSeatStockDto {
  /** Société ciblée (super-admin) ; sinon celle du compte. */
  fleetId?: string;
  /** Possédés, par type. Refusé sous ce qui est installé dans des véhicules. */
  baby: number;
  child: number;
  policy?: ChildSeatPolicy;
}

/** Régler les sièges à bord d'un véhicule. Si la société en possède moins, le total est relevé. */
export interface SetVehicleChildSeatsDto {
  baby: number;
  child: number;
}

/**
 * Ce que le créneau permet : le stock (possédés − installés) moins ce que les réservations fermes
 * chevauchantes prennent dessus (leur besoin − les sièges à bord de leur véhicule). Avec un
 * véhicule visé, `vehicleInstalled` dit ce qu'il a déjà à bord : le stock ne fournit que le reste.
 */
export interface ChildSeatAvailabilityDto {
  startAt: string;
  endAt: string;
  policy: ChildSeatPolicy;
  total: ChildSeatCounts;
  installed: ChildSeatCounts;
  stock: ChildSeatCounts;
  engaged: ChildSeatCounts;
  available: ChildSeatCounts;
  vehicleInstalled?: ChildSeatCounts | null;
  vehiclePlate?: string | null;
}

/**
 * Le groupe qui UTILISE le véhicule pour cette réservation (refonte UX du 28/09, point 9).
 *
 * ⚠️ Ce n'est PAS le groupe du véhicule, et il ne l'écrit jamais : un groupe peut prêter son
 * véhicule à un autre — le véhicule reste rattaché à son groupe d'origine, la réservation dit qui
 * s'en sert. Par défaut, c'est le groupe du véhicule au moment où le véhicule est fixé (demande
 * avec véhicule, attribution automatique, validation) ; modifiable à la demande, à la validation
 * et à l'édition. `id` null = un groupe saisi en texte libre (pas un groupe de la société).
 * Rangé dans `metadata.group` de l'évènement.
 */
export interface ReservationGroupDto {
  id: string | null;
  name: string;
}

/** Critères de réservation (matching véhicule + sièges auto pris sur le stock). */
export interface ReservationCriteria {
  minSeats?: number;
  /** Sièges auto « bébé » à installer (pris sur le stock de la société, sur le créneau). */
  childSeatsBaby?: number;
  /** Sièges auto « enfant » à installer (idem — jamais substituable au type bébé). */
  childSeatsChild?: number;
  /** Équipements requis : TOUS doivent être présents sur le véhicule (insensible à la casse). */
  requiredFeatures?: string[];
}

/** Demande de réservation : créneau + critères (+ véhicule si déjà choisi). */
export interface RequestReservationDto {
  /** Véhicule visé. Absent = demande « ouverte » sur critères (à affecter à la validation). */
  vehicleId?: string;
  /** Société ciblée pour une demande OUVERTE (sans véhicule) — requis côté super-admin pour
   *  ne pas auto-affecter un véhicule d'une autre société. Ignoré si `vehicleId` est fourni. */
  fleetId?: string;
  startAt: string; // ISO
  endAt: string; // ISO
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
  /** Consigner une réservation DÉJÀ EFFECTUÉE mais non enregistrée (créneau passé). Réservé aux
   *  gestionnaires : entre CONFIRMÉE à sa date réelle, sans bloquer sur le trajet réel (attendu). */
  retroactive?: boolean;
  /** Groupe qui utilise le véhicule. Absent = celui du véhicule retenu ; `null` = aucun groupe (choix explicite). */
  group?: ReservationGroupDto | null;
}

/** Véhicule proposé par l'auto-complétion : libre sur le créneau ET conforme aux critères. */
export interface SuggestedVehicleDto {
  vehicleId: string;
  vehiclePlate: string | null;
  seats: number | null;
  features: string[];
  /** 0..1 — utilisation récente (tri : sous-utilisés d'abord = mutualisation). */
  utilizationRatio: number;
  underutilized: boolean;
  /** Sièges auto déjà À BORD de ce véhicule (2026-09-28). */
  childSeatsInstalled?: ChildSeatCounts;
  /** Ce que le STOCK devrait fournir pour couvrir le besoin avec ce véhicule (besoin − à bord). Zéro = rien à installer. */
  childSeatsFromStock?: ChildSeatCounts;
}

export interface SuggestReservationResultDto {
  startAt: string;
  endAt: string;
  vehicles: SuggestedVehicleDto[];
  /**
   * Sièges auto sur ce créneau (stock de la société − engagés), quand la société est connue.
   * Un véhicule libre ne suffit pas : si le stock ne couvre pas le besoin, la réservation est
   * refusée — et l'IA de placement le sait (elle le lit dans son payload).
   */
  childSeats?: ChildSeatAvailabilityDto | null;
  /**
   * Véhicules libres mais écartés parce que le besoin de sièges auto ne peut pas être couvert avec
   * eux : pas assez à bord et le stock ne complète pas (politique « installés seulement ») ou ne
   * suffit plus sur le créneau. Compté pour ne pas faire baisser un chiffre en silence.
   */
  excludedChildSeats?: number;
  /** Véhicules écartés faute de capacité renseignée (places NULL avec critère de places).
   *  Rendus visibles pour ne pas fausser silencieusement les résultats. */
  excludedUnknownCapacity: number;
  /** Véhicules conformes mais immobilisés (incident/maintenance bloquant sur le créneau). */
  excludedImmobilized: number;
  /** Véhicules conformes mais DORMANTS : boîtier muet depuis plus de 7 jours (seuil « arrêter de
   *  compter »). Écartés du vivier — on ne propose pas un véhicule qu'on ne sait plus localiser —
   *  mais toujours consultables sur leur fiche, et de retour dans le vivier dès la trame suivante.
   *  Exposé pour ne pas faire baisser un chiffre client EN SILENCE. Donnée INTERNE : jamais
   *  renvoyée au demandeur du lien public de réservation. */
  excludedDormant: number;
  /**
   * 29/09 (« 12 places ») — véhicules écartés parce qu'ils ont MOINS de places que `minSeats`
   * (conducteur compris). Sans ce compte, « aucun véhicule libre » se lisait comme un agenda plein
   * alors que le parc n'avait simplement pas de véhicule assez grand. Donnée INTERNE (lien public : jamais).
   */
  excludedTooSmall?: number;
  /** Plus grand nombre de places parmi les véhicules en service du périmètre (null = aucun renseigné). */
  largestSeats?: number | null;
}

/** Validation d'une demande : fixe le véhicule (si « ouverte ») et passe CONFIRMED. */
export interface ConfirmReservationDto {
  vehicleId?: string;
  /**
   * Groupe qui utilise le véhicule. Absent = celui déjà posé sur la demande, sinon celui du véhicule ;
   * `null` = aucun groupe (choix explicite du valideur).
   */
  group?: ReservationGroupDto | null;
}

/** Mise à jour d'une réservation (créneau / critères / libellé / véhicule). */
export interface UpdateReservationDto {
  startAt?: string;
  endAt?: string;
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
  /** Réaffecter la réservation à un autre véhicule (re-vérifie les conflits sur la cible). */
  vehicleId?: string;
  /** Marque/maintient la réservation comme « déjà effectuée » (autorise un créneau passé à l'édition). */
  retroactive?: boolean;
  /** Groupe qui utilise le véhicule : un objet remplace, `null` retire, absent ne touche à rien. */
  group?: ReservationGroupDto | null;
}
