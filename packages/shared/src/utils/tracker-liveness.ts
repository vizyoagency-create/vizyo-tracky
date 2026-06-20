/**
 * Liveness d'un tracker basée sur la FRAÎCHEUR de son dernier signal.
 *
 * Pourquoi ce helper existe (Sprint 0.1) : la colonne `Tracker.status` en base
 * est COLLANTE — mise à `ONLINE` à la première trame ingérée, JAMAIS remise à
 * `OFFLINE` (aucun sweep côté serveur, invariant vérifié par grep). Elle ne
 * reflète donc pas l'état live : un tracker mort depuis des heures reste
 * `ONLINE`, et un tracker qui n'a jamais émis reste `OFFLINE` (défaut) même s'il
 * communique sans fix valide.
 *
 * Ce prédicat, calculé au read-time (non destructif, aucune écriture DB), donne
 * la seule définition fiable de « online maintenant » : le boîtier nous a parlé
 * récemment. C'est la source de vérité d'affichage partagée par l'admin
 * Trackers et la chip « actif » de la carte — cf. docs/sprint-0.1.
 */

/**
 * Seuil de fraîcheur (ms) au-delà duquel un tracker est considéré offline.
 *
 * 15 min : un véhicule à l'arrêt émet jusqu'à toutes les ~300 s (intervalle de
 * fix adaptatif maximal, cf. PositionSamplingService). 15 min tolère ~2 trames
 * manquées sans faux-offline, tout en détectant un vrai silence en moins d'un
 * quart d'heure. Ajustable sans changer la logique.
 */
export const TRACKER_ONLINE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Retourne `true` si le tracker a émis depuis moins de `thresholdMs`.
 *
 * @param lastSeenAt  dernier signal connu (`Date`, ISO string, epoch ms) ou null.
 * @param now         instant de référence en ms epoch. Défaut : `Date.now()`.
 * @param thresholdMs fenêtre de fraîcheur. Défaut : {@link TRACKER_ONLINE_THRESHOLD_MS}.
 */
export function isTrackerOnline(
  lastSeenAt: Date | string | number | null | undefined,
  now: number = Date.now(),
  thresholdMs: number = TRACKER_ONLINE_THRESHOLD_MS,
): boolean {
  if (lastSeenAt == null) return false;
  const ms =
    lastSeenAt instanceof Date
      ? lastSeenAt.getTime()
      : typeof lastSeenAt === 'number'
        ? lastSeenAt
        : new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ms)) return false;
  // age < 0 (horloge boîtier dans le futur, skew GPRS) : on considère online —
  // le boîtier vient de parler, on ne le pénalise pas pour un décalage d'horloge.
  return now - ms <= thresholdMs;
}

/**
 * État de connectivité d'un véhicule vis-à-vis de l'application, vu côté UI.
 *
 * Tri-état dérivé (read-time, aucune écriture) qui répond à : « ce véhicule est-il
 * réellement suivi en ce moment ? ». Il distingue les deux causes de
 * non-suivi que l'exploitant doit traiter différemment :
 *  - `ONLINE`         : boîtier vivant, signal frais (< seuil) ET position GPS connue → suivi direct.
 *  - `AWAITING_GPS`   : boîtier vivant (signal frais) mais SANS aucune position GPS valide →
 *                       connecté, pas encore de lock satellite (rapport LBS / démarrage à froid / antenne).
 *  - `PARKED`         : silencieux > seuil MAIS contact coupé à la dernière trame →
 *                       garé, boîtier en veille (silence NORMAL, pas une panne).
 *  - `OFFLINE`        : silencieux > seuil alors que le contact était ON (coupé en
 *                       roulant) ou ignition inconnue → débranché / vraie perte de signal.
 *  - `NOT_CONFIGURED` : aucun boîtier affecté, OU boîtier affecté qui n'a JAMAIS
 *                       émis → pas (encore) installé / mal configuré pour Tracky.
 */
export type VehicleConnectivityState =
  | 'ONLINE'
  | 'AWAITING_GPS'
  | 'PARKED'
  | 'OFFLINE'
  | 'NOT_CONFIGURED';

export interface VehicleConnectivityInput {
  /** Présence d'un tracker affecté au véhicule. null/undefined = aucun tracker. */
  trackerId?: string | null;
  /** Dernier signal reçu du boîtier (trame TCP). Source de fraîcheur primaire. */
  lastSeenAt?: Date | string | number | null;
  /** Dernière position valide connue. Repli si `lastSeenAt` absent. */
  lastPositionAt?: Date | string | number | null;
  /**
   * Dernier état ignition connu. `false` (contact coupé) → un silence prolongé est
   * une mise en veille NORMALE du boîtier garé (→ PARKED), pas un débranchement.
   */
  lastIgnition?: boolean | null;
}

/**
 * Calcule le tri-état de connectivité. Réutilise {@link isTrackerOnline} (donc le
 * même seuil de 15 min) pour la définition d'« online maintenant ». Pur, non
 * destructif : c'est la source de vérité partagée par toutes les surfaces UI
 * (liste véhicules, carte, détail, rapports) pour marquer les véhicules « pas
 * dans l'app ».
 *
 * @param now         instant de référence ms epoch. Défaut : `Date.now()`.
 * @param thresholdMs fenêtre de fraîcheur. Défaut : {@link TRACKER_ONLINE_THRESHOLD_MS}.
 */
export function getVehicleConnectivityState(
  input: VehicleConnectivityInput,
  now: number = Date.now(),
  thresholdMs: number = TRACKER_ONLINE_THRESHOLD_MS,
): VehicleConnectivityState {
  const { trackerId, lastSeenAt, lastPositionAt, lastIgnition } = input;
  // Aucun boîtier affecté → véhicule pas équipé pour Tracky.
  if (!trackerId) return 'NOT_CONFIGURED';
  // Le boîtier a parlé récemment → vivant.
  if (isTrackerOnline(lastSeenAt, now, thresholdMs)) {
    // …mais s'il n'a JAMAIS eu de position GPS valide, il est connecté sans lock
    // satellite (rapport LBS sans fix : intérieur / démarrage à froid / antenne). On le
    // distingue d'ONLINE pour montrer qu'il est vivant mais pas encore localisable —
    // sinon ces boîtiers restaient « non configurés », donc invisibles.
    //
    // `=== null` (et non `== null`) est VOLONTAIRE : l'état est opt-in. Un appelant qui
    // ne fournit pas `lastPositionAt` (undefined) reste ONLINE — seuls ceux qui passent
    // explicitement `lastPositionAt: … ?? null` (liste/détail) obtiennent AWAITING_GPS.
    if (lastPositionAt === null) return 'AWAITING_GPS';
    return 'ONLINE';
  }
  // Boîtier affecté mais JAMAIS aucun signal ni position → affecté mais jamais
  // connecté (SIM/APN/provisioning KO). On le traite comme « non configuré »
  // plutôt que « hors-ligne » : il n'a jamais fonctionné, ce n'est pas un débranchement.
  if (lastSeenAt == null && lastPositionAt == null) return 'NOT_CONFIGURED';
  // Silencieux mais contact coupé à la dernière trame → garé, boîtier en veille
  // (le Coban dort quand l'ignition est OFF) : silence normal, pas une panne.
  if (lastIgnition === false) return 'PARKED';
  // Silencieux alors que le contact était ON (ou inconnu) → vraie perte de signal.
  return 'OFFLINE';
}

/**
 * Fenêtre « installation récente » : un boîtier ajouté il y a moins d'1 mois est
 * encore en période de rodage. Au-delà, une déconnexion n'est plus imputée à la pose.
 */
export const INSTALLATION_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * « Installation à revoir » : un boîtier installé depuis MOINS d'un mois, qui a
 * déjà communiqué (état OFFLINE = a émis puis devenu silencieux), mais qui est
 * actuellement hors-ligne → pose probablement bâclée, à revoir au plus vite.
 *
 * On ne flague PAS :
 *  - les `NOT_CONFIGURED` (jamais connectés — autre problème, pas une déconnexion) ;
 *  - les `ONLINE` ;
 *  - les installations de plus d'un mois (déconnexion = usure/externe, pas la pose).
 *
 * @param state             tri-état déjà calculé via {@link getVehicleConnectivityState}.
 * @param trackerCreatedAt  date d'ajout du tracker (proxy de date d'installation).
 */
export function isInstallationToReview(
  state: VehicleConnectivityState,
  trackerCreatedAt: Date | string | number | null | undefined,
  now: number = Date.now(),
  windowMs: number = INSTALLATION_REVIEW_WINDOW_MS,
): boolean {
  if (state !== 'OFFLINE') return false;
  if (trackerCreatedAt == null) return false;
  const ms =
    trackerCreatedAt instanceof Date
      ? trackerCreatedAt.getTime()
      : typeof trackerCreatedAt === 'number'
        ? trackerCreatedAt
        : new Date(trackerCreatedAt).getTime();
  if (!Number.isFinite(ms)) return false;
  // Installé il y a moins de `windowMs` → période où une déconnexion = pose suspecte.
  return now - ms <= windowMs;
}
