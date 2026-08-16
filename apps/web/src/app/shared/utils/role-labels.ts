/**
 * V1.15 — Libellés FR centralisés des rôles applicatifs.
 *
 * Avant, trois composants (users-list, permissions-overview, settings) plus la
 * page compte avaient chacun leur propre map, avec des libellés divergents
 * ("Super Admin" vs "Admin" vs "Manager"). Source unique de vérité ici.
 *
 * Convention : tout en français cohérent.
 *   VIEWER → Lecteur · FLEET_MANAGER → Gestionnaire
 *   FLEET_ADMIN → Administrateur · SUPER_ADMIN → Super-Administrateur
 */
export type AppRole = 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' | 'NIGHT_WATCHMAN' | 'DRIVER' | 'DEPOT';

const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: 'Super-Administrateur',
  FLEET_ADMIN: 'Administrateur',
  FLEET_MANAGER: 'Gestionnaire',
  VIEWER: 'Lecteur',
  NIGHT_WATCHMAN: 'Veilleur de nuit',
  DRIVER: 'Conducteur',
  // Espace dépôt (2026-08) — « Dépôt », jamais « Client » ni « Partenaire » : le
  // vocabulaire est fixé une fois pour toutes par A0 § Le vocabulaire.
  DEPOT: 'Dépôt',
};

/**
 * Libellé FR d'un rôle. Renvoie '' si null/undefined (champs vides propres),
 * et la valeur brute si le rôle est inconnu (jamais perdu silencieusement).
 */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '';
  return ROLE_LABELS[role as AppRole] ?? role;
}
