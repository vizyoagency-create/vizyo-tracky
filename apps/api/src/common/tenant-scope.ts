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
