/**
 * Contexte d'activité courant (route + identifiant de session client), partagé
 * SANS DI pour être lu par l'intercepteur HTTP et le GlobalErrorHandler sans
 * créer de cycle de dépendances avec ActivityTrackerService (qui dépend de
 * HttpClient, lui-même passe par l'intercepteur).
 *
 * Écrit par ActivityTrackerService, lu partout. Sert à attacher à chaque erreur
 * « où » (page) et « quelle session » elle s'est produite.
 */
export const activityContext: { sessionId: string | null; route: string | null } = {
  sessionId: null,
  route: null,
};
