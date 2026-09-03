/**
 * Lot V5 — UN SEUL format d'adresse pour ouvrir un trajet précis.
 *
 * Le format existait déjà côté écran (lien « N avec excès » des scores → fiche véhicule,
 * onglet Rapports, trajet mis en évidence). Le serveur doit produire exactement le même
 * pour la notification push : le clic ouvre alors le trajet, et non une liste d'alertes.
 */

/** Paramètres de requête d'un trajet ciblé — la forme attendue par `routerLink`. */
export function parametresTrajet(tripId: string, tripStartedAt: string, alertId?: string | null): Record<string, string> {
  const params: Record<string, string> = { tab: 'reports', trip: tripId, tripDate: tripStartedAt };
  if (alertId) params['alert'] = alertId;
  return params;
}

/** Adresse relative complète, prête pour une notification ou `navigateByUrl`. */
export function urlDuTrajet(vehicleId: string, tripId: string, tripStartedAt: string, alertId?: string | null): string {
  const q = new URLSearchParams(parametresTrajet(tripId, tripStartedAt, alertId));
  return `/vehicles/${vehicleId}?${q.toString()}`;
}
