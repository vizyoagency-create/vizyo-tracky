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
 *  - `ONLINE`         : boîtier vivant, signal frais (< seuil) → suivi en direct.
 *  - `OFFLINE`        : boîtier déjà vu mais silencieux depuis > seuil → DÉBRANCHÉ
 *                       / hors-ligne (alim coupée, remorquage, zone sans réseau).
 *  - `NOT_CONFIGURED` : aucun boîtier affecté, OU boîtier affecté qui n'a JAMAIS
 *                       émis → pas (encore) installé / mal configuré pour Tracky.
 */
export type VehicleConnectivityState = 'ONLINE' | 'OFFLINE' | 'NOT_CONFIGURED';

export interface VehicleConnectivityInput {
  /** Présence d'un tracker affecté au véhicule. null/undefined = aucun tracker. */
  trackerId?: string | null;
  /** Dernier signal reçu du boîtier (trame TCP). Source de fraîcheur primaire. */
  lastSeenAt?: Date | string | number | null;
  /** Dernière position valide connue. Repli si `lastSeenAt` absent. */
  lastPositionAt?: Date | string | number | null;
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
  const { trackerId, lastSeenAt, lastPositionAt } = input;
  // Aucun boîtier affecté → véhicule pas équipé pour Tracky.
  if (!trackerId) return 'NOT_CONFIGURED';
  // Le boîtier a parlé récemment → suivi en direct.
  if (isTrackerOnline(lastSeenAt, now, thresholdMs)) return 'ONLINE';
  // Boîtier affecté mais JAMAIS aucun signal ni position → affecté mais jamais
  // connecté (SIM/APN/provisioning KO). On le traite comme « non configuré »
  // plutôt que « hors-ligne » : il n'a jamais fonctionné, ce n'est pas un débranchement.
  if (lastSeenAt == null && lastPositionAt == null) return 'NOT_CONFIGURED';
  // A déjà émis par le passé mais silencieux depuis > seuil → débranché / hors-ligne.
  return 'OFFLINE';
}
