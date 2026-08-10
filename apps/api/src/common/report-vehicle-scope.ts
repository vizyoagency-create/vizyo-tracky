import { ForbiddenException } from '@nestjs/common';

/**
 * Sprint 5 (Rapports & filtres v2) — borne de périmètre véhicule, EXACTE, pour
 * les rapports / exports / trips.
 *
 * Problème corrigé (cf. docs/sprint-5/ANALYSE.md §4) : les rapports/trips
 * scopaient par `fleetId` SEULEMENT. Un utilisateur scopé à un groupe ou à des
 * véhicules (VIEWER/FLEET_MANAGER avec règles `UserVehicleAccess`) qui possède
 * `reports_view` pouvait lire/exporter TOUTE la flotte s'il ne passait pas de
 * `vehicleIds` — IDOR de périmètre intra-flotte.
 *
 * Ce helper centralise la décision pour que `reports-stats`, `report-csv`,
 * `report-excel` ET `trips` appliquent EXACTEMENT la même règle (pas de drift) :
 *
 *  1. `accessibleVehicleIds === 'ALL'` (FLEET_ADMIN/SUPER_ADMIN, ou règle
 *     AccessType.ALL) → aucune borne véhicule ajoutée. Le filtre `fleetId`
 *     (défense en profondeur, conservé par chaque appelant) reste la seule
 *     borne. Comportement historique inchangé.
 *
 *  2. Sinon (liste de véhicules permis) :
 *     - si l'appelant a demandé des véhicules précis (`requested`), on REJETTE
 *       (ForbiddenException) dès qu'UN seul de ces IDs sort du périmètre permis
 *       — plus strict que l'ancien check « hors flotte » (qui retournait juste
 *       un sous-ensemble vide / 400). C'est la barrière anti-IDOR.
 *     - sinon (aucune demande explicite), on borne par DÉFAUT au périmètre
 *       complet permis.
 *
 * Le résultat `'ALL'` signifie « ne pas ajouter de borne `vehicleId` » ; un
 * `string[]` signifie « ajouter `where.vehicleId = { in: [...] }` ». La liste
 * est dédupliquée et garantie non vide quand ≠ 'ALL' (un utilisateur sans aucun
 * véhicule accessible mène à `['__none__']` côté trips ; ici on garde la
 * sémantique « borne explicite » et on laisse l'appelant matcher zéro ligne).
 */
export function resolveReportVehicleScope(
  accessibleVehicleIds: string[] | 'ALL',
  requested?: string[] | undefined,
): 'ALL' | string[] {
  // Normalise la demande explicite : trim, dédup, ignore les chaînes vides.
  const requestedNorm = Array.from(
    new Set((requested ?? []).map((id) => id?.trim()).filter((id): id is string => !!id)),
  );

  if (accessibleVehicleIds === 'ALL') {
    // Périmètre illimité : si une demande explicite existe, on la restitue telle
    // quelle (l'appelant valide l'appartenance à la flotte de son côté — défense
    // en profondeur existante). Sinon, pas de borne véhicule.
    return requestedNorm.length > 0 ? requestedNorm : 'ALL';
  }

  const allowed = new Set(accessibleVehicleIds);

  if (requestedNorm.length > 0) {
    // Barrière anti-IDOR : tout ID demandé hors périmètre permis ⇒ 403.
    const outside = requestedNorm.filter((id) => !allowed.has(id));
    if (outside.length > 0) {
      throw new ForbiddenException(
        'Accès refusé à un ou plusieurs véhicules hors de votre périmètre',
      );
    }
    return requestedNorm;
  }

  // Aucune demande explicite ⇒ borne par défaut au périmètre complet permis.
  return [...allowed];
}
