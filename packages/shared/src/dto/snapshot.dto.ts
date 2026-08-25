/**
 * Snapshot d'un vehicule : metadonnees + derniere position connue (denormalisee).
 * Utilise pour l'hydratation immediate de la carte au login (chantier 1 — V1.4).
 *
 * Source : `Tracker.last*` (mis a jour a chaque ingest dans `PositionsService.ingest`).
 */
export interface VehicleSnapshotDto {
  vehicleId: string;
  fleetId: string;
  plate: string;
  type: string;
  brand: string | null;
  model: string | null;

  trackerId: string | null;
  trackerImei: string | null;
  trackerStatus: 'ONLINE' | 'OFFLINE' | 'IDLE' | null;
  lastSeenAt: string | null;

  lastLat: number | null;
  lastLng: number | null;
  lastSpeedKmh: number | null;
  lastHeading: number | null;
  lastIgnition: boolean | null;
  lastValid: boolean | null;
  lastPositionAt: string | null;

  /**
   * Incident FS-253 — ISO de la dernière trame `no_fix` (boîtier vivant SANS lock GPS).
   * Couplé à un `lastPositionAt` périmé, permet à l'UI de détecter l'état `GPS_LOST`
   * (cf. getVehicleConnectivityState) au lieu d'afficher une vitesse figée comme du live.
   */
  lastNoFixAt: string | null;

  /**
   * V1.7 — Indique si le fil ACC du tracker est connecte. Si false, l'app
   * frontend sait que `lastIgnition` peut etre inferee depuis la vitesse
   * (mode degrade, fiabilite reduite a l'arret). Default null si pas de tracker.
   */
  accConnected: boolean | null;

  /**
   * Date d'ajout du tracker (ISO), proxy de la date d'installation. Permet de
   * détecter une « installation à revoir » : boîtier posé depuis < 1 mois qui
   * se déconnecte (cf. isInstallationToReview). Null si pas de tracker.
   */
  trackerCreatedAt: string | null;

  /**
   * V1.7 — true si une commande CUT (SENT/ACKNOWLEDGED) est active sur ce tracker
   * sans RESTORE posterieure. Permet au popup carte d'afficher le bon bouton
   * des le chargement, sans attendre un event WS.
   */
  engineCutActive: boolean | null;

  /**
   * Sprint 2 (revue #2) — état coupe TRI-ÉTAT (null si le véhicule n'a pas de tracker) :
   *   'normal'  = pas de coupure active
   *   'pending' = coupure commandée mais non encore confirmée (ex. véhicule à l'arrêt,
   *               non vérifiable par ignition) — à distinguer visuellement de "normal"
   *   'cut'     = coupure confirmée (ignition tombée, ou coupure externe DEVICE_OBSERVED)
   * `engineCutActive` reste le booléen « coupé confirmé » (= engineCutState === 'cut').
   */
  engineCutState?: 'normal' | 'pending' | 'cut' | null;

  /** V1.7 — true si un schedule horaire est actif sur ce véhicule. */
  scheduleEnabled: boolean;

  /**
   * Mode vie privée — quand true, la collecte des positions est en pause pour ce
   * véhicule (la dernière position connue reste figée). Permet d'afficher un badge
   * « Mode privé » sur la carte / la liste. Défaut false.
   */
  privacyModeEnabled?: boolean;
  /** ISO — depuis quand le mode privé est actif (null si inactif). */
  privacyModeSince?: string | null;

  /**
   * Sprint 1 (Fondation Groupes) — groupe (unique) du véhicule, ou null si sans
   * groupe. Optionnel pour la backward-compat des consommateurs existants.
   */
  group?: { id: string; name: string } | null;

  /**
   * TRK-046 — libellé du lieu quand le véhicule est CONSIDÉRÉ STATIONNÉ : hors champ GPS,
   * dernière position dans un parking VALIDÉ (souterrain/couvert), aucun soupçon de coupure
   * d'alimentation. `null`/absent sinon. Dérivé serveur au read-time, jamais persisté.
   */
  presumedParkedZone?: string | null;
}

export interface FleetSnapshotResponse {
  items: VehicleSnapshotDto[];
}
