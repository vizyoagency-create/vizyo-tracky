/**
 * Garde-fou COMMUN à toutes les purges de données (règle permanente, 21/07/2026).
 *
 * Une purge dont la fenêtre configurée est inférieure à 30 jours est REFUSÉE : le job échoue
 * bruyamment (erreur → centre d'alerte) plutôt que de supprimer massivement des données à cause
 * d'une variable d'environnement mal saisie (`POSITIONS_RETENTION_DAYS=6` au lieu de `60`…).
 * Les suppressions étant IRRÉVERSIBLES, l'échec est toujours préférable au doute.
 *
 * Convention partagée : `0` = purge DÉSACTIVÉE (rétention infinie). C'est aussi l'arrêt d'urgence
 * en production, où le drapeau d'armement ne peut plus désactiver la purge.
 */
export const MIN_RETENTION_WINDOW_DAYS = 30;

/** Erreur dédiée : reconnaissable dans les tests et dans le centre d'alerte. */
export class RetentionWindowTooShortError extends Error {
  constructor(source: string, days: number) {
    super(
      `[${source}] fenêtre de rétention configurée à ${days} j < ${MIN_RETENTION_WINDOW_DAYS} j : ` +
        `purge REFUSÉE (garde-fou anti-purge accidentelle). Corrigez la configuration, ` +
        `ou posez 0 pour désactiver complètement la purge.`,
    );
    this.name = 'RetentionWindowTooShortError';
  }
}

/**
 * Vérifie la fenêtre AVANT toute suppression. Jette `RetentionWindowTooShortError` si la fenêtre
 * est strictement positive et < 30 j, ou si la valeur est aberrante (négative / non finie).
 * `days === 0` passe : la purge est alors désactivée par l'appelant (rétention infinie).
 */
export function assertRetentionWindow(days: number, source: string): void {
  if (!Number.isFinite(days) || days < 0) throw new RetentionWindowTooShortError(source, days);
  if (days === 0) return; // désactivé — aucune suppression ne sera tentée
  if (days < MIN_RETENTION_WINDOW_DAYS) throw new RetentionWindowTooShortError(source, days);
}

/**
 * Armement de la purge. En PRODUCTION la purge est toujours armée : le drapeau ne peut la
 * désactiver qu'en développement/test (exigence de conformité — une prod ne doit pas dériver
 * silencieusement vers « on ne purge plus »). Arrêt d'urgence en production : fenêtre = 0.
 * Retourne aussi `forced` pour que l'appelant puisse le tracer.
 */
export function resolvePurgeArmed(
  flagValue: string | undefined,
  nodeEnv: string,
): { armed: boolean; forced: boolean } {
  const flag = flagValue === 'true';
  if (nodeEnv === 'production' && !flag) return { armed: true, forced: true };
  return { armed: flag, forced: false };
}
