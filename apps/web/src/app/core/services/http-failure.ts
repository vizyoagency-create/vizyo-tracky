/**
 * Une panne HTTP qui PORTE SON STATUT.
 *
 * ── Pourquoi ce type existe (audit du 2026-08-03) ────────────────────────────────────
 * Plusieurs services appellent l'API avec `fetch` natif et signalent l'échec par un
 * `new Error('Failed to load users')`. Le statut est alors **perdu**, et l'écran ne peut
 * plus distinguer :
 *
 *   401 — la session a expiré, il faut se reconnecter ;
 *   403 — le compte n'a pas le droit, c'est une question de permissions ;
 *   5xx — le serveur est en panne, il faut réessayer.
 *
 * Faute de pouvoir les distinguer, l'écran des utilisateurs affichait « Aucun utilisateur
 * dans votre flotte » pour les trois — c'est-à-dire **la réponse métier d'une flotte
 * vide**. L'utilisateur en concluait que son parc était vide, et ne rappelait personne.
 *
 * ⚠️ `fetch` natif ne traverse PAS les intercepteurs Angular : un 401 ne déclenche donc
 * ni déconnexion ni message « Session expirée ». Tant que ces appels n'auront pas migré
 * vers `HttpClient`, c'est à l'appelant de le dire.
 */
export class HttpFailure extends Error {
  constructor(
    /** Statut HTTP. `0` quand la requête n'a même pas abouti (réseau coupé). */
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

/**
 * Statut d'une erreur, quelle que soit sa provenance.
 *
 * L'application mélange deux mondes : `fetch` natif (qui jette un {@link HttpFailure}) et
 * `HttpClient` (qui jette un `HttpErrorResponse`). Les deux portent un `status` numérique ;
 * on le lit sans dépendre du type, pour qu'un écran n'ait pas à savoir par quel chemin son
 * service appelle l'API.
 *
 * `0` = la requête n'a pas abouti (réseau coupé) — c'est aussi ce que renvoie
 * `HttpErrorResponse` dans ce cas, donc les deux mondes coïncident.
 */
export function httpStatusOf(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

/**
 * Message destiné à l'utilisateur, dérivé du statut.
 *
 * Centralisé pour que deux écrans ne racontent pas deux histoires différentes de la même
 * panne — et pour que la distinction soit testable sans monter un composant.
 */
export function httpFailureMessage(err: unknown, sujet: string): string {
  const status = httpStatusOf(err);
  if (status === 401) return `Votre session a expiré. Reconnectez-vous pour voir ${sujet}.`;
  if (status === 403) return `Vous n’avez pas l’autorisation de consulter ${sujet}.`;
  if (status === 0) return `Connexion au serveur impossible. Vérifiez votre réseau.`;
  return `Impossible de charger ${sujet}. Réessayez dans un instant.`;
}
