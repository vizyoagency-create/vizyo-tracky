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
