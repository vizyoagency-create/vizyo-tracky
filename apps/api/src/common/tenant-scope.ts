import { UserRole } from '@prisma/client';

/**
 * V1.16 (audit A3/B1/B2/D9) — Résolution **fail-closed** du périmètre tenant.
 *
 * Problème corrigé : le pattern récurrent `where.fleetId = user.fleetId ?? undefined`
 * (ou `if (role !== SUPER_ADMIN && user.fleetId) { ... }`) laissait fuiter
 * **toutes les flottes** dès qu'un utilisateur non-SUPER_ADMIN avait `fleetId`
 * null (compte mal provisionné, rôle changé sans flotte, etc.) : Prisma supprime
 * un filtre `undefined`, ou le bloc conditionnel est entièrement sauté.
 *
 * Cette fonction centralise la décision en 3 cas explicites. La règle clé :
 * **un non-SUPER_ADMIN sans fleetId ne voit RIEN** (`DENY`), jamais « toutes
 * flottes ». Chaque appelant doit traiter `DENY` par un retour vide immédiat.
 *
 * Usage type :
 * ```ts
 * const scope = resolveTenantScope(user);
 * if (scope.mode === 'DENY') return [];          // (ou zéros / page vide)
 * if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;
 * // 'ALL' (SUPER_ADMIN) → aucun filtre de flotte
 * ```
 */
export type TenantScope =
  | { mode: 'ALL' }
  | { mode: 'FLEET'; fleetId: string }
  | { mode: 'DENY' };

export function resolveTenantScope(user: {
  role: UserRole;
  fleetId: string | null | undefined;
}): TenantScope {
  if (user.role === UserRole.SUPER_ADMIN) return { mode: 'ALL' };
  if (!user.fleetId) return { mode: 'DENY' };
  return { mode: 'FLEET', fleetId: user.fleetId };
}

/**
 * Identifiant de flotte IMPOSSIBLE, pour matcher zéro ligne.
 *
 * ── Pourquoi une valeur plutôt qu'une absence ────────────────────────────────────────
 * Plusieurs écrans écrivaient `if (role !== SUPER_ADMIN && user.fleetId) { where.fleetId = … }`.
 * Quand `fleetId` est `null`, le bloc est SAUTÉ : la clause disparaît et la requête devient
 * globale. Le compte le moins légitime obtient la vue la plus large — l'exact inverse de
 * l'intention. C'est un **fail-open** : il ne se voit pas, parce que l'écran s'affiche
 * normalement, simplement avec les données de tout le monde.
 *
 * Le cas n'est pas théorique : `Fleet.onDelete: SetNull` met à `null` le `fleetId` de TOUS
 * les membres d'une société supprimée, administrateur compris.
 *
 * En posant cette valeur, l'écran se vide — un vide se remarque et se corrige ; une fuite
 * se découvre par le client.
 */
export const NO_FLEET = '00000000-0000-0000-0000-000000000000';

/**
 * Flotte à laquelle une lecture doit être bornée.
 *
 * `undefined` = aucune borne, et c'est réservé au SUPER_ADMIN.
 * `NO_FLEET`  = compte non-super-admin sans société : il ne voit rien.
 */
export function requiredFleetScope(
  user: { role: UserRole; fleetId: string | null | undefined },
  requestedFleetId?: string,
): string | undefined {
  const scope = resolveTenantScope(user);
  if (scope.mode === 'ALL') return requestedFleetId || undefined;
  if (scope.mode === 'FLEET') return scope.fleetId;
  return NO_FLEET;
}
