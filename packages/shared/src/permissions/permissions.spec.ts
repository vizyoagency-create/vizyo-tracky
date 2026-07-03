import {
  clampPermissions,
  effectiveGranterPermissions,
  getDefaultPermissions,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  type UserPermissions,
  type UserRoleSlug,
} from './permissions';

describe('permissions — effectiveGranterPermissions', () => {
  it('SUPER_ADMIN / FLEET_ADMIN = bypass (toutes permissions true)', () => {
    const sa = effectiveGranterPermissions({ role: 'SUPER_ADMIN' });
    const fa = effectiveGranterPermissions({ role: 'FLEET_ADMIN' });
    expect(Object.values(sa).every((v) => v === true)).toBe(true);
    expect(Object.values(fa).every((v) => v === true)).toBe(true);
  });

  it('FLEET_MANAGER part des defauts du role, surcharge par le set explicite', () => {
    const eff = effectiveGranterPermissions({
      role: 'FLEET_MANAGER',
      permissions: { users_manage: true },
    });
    expect(eff.users_manage).toBe(true); // surcharge explicite
    expect(eff.engine_control).toBe(false); // defaut manager conserve
    expect(eff.vehicles_view).toBe(true); // defaut manager
  });

  it('permissions null -> defauts du role', () => {
    const eff = effectiveGranterPermissions({ role: 'FLEET_MANAGER', permissions: null });
    expect(eff).toEqual(getDefaultPermissions('FLEET_MANAGER'));
  });
});

describe('permissions — clampPermissions (anti-escalade de privileges)', () => {
  const viewerDefaults = getDefaultPermissions('VIEWER');
  // Un FLEET_MANAGER a qui un admin a accorde users_manage (pour inviter), mais
  // qui n'a NI engine_control NI alerts_configure (defauts manager = false).
  const managerWithUsersManage = {
    role: 'FLEET_MANAGER' as const,
    permissions: { ...getDefaultPermissions('FLEET_MANAGER'), users_manage: true },
  };

  it('un FLEET_MANAGER ne peut PAS accorder une capacite qu\'il n\'a pas', () => {
    // Le scenario exact de l'audit : invite un VIEWER avec engine_control=true.
    const granted = clampPermissions(
      { ...viewerDefaults, engine_control: true, alerts_configure: true },
      managerWithUsersManage,
      viewerDefaults,
    );
    expect(granted.engine_control).toBe(false);
    expect(granted.alerts_configure).toBe(false);
  });

  it('un FLEET_MANAGER peut accorder une capacite qu\'il possede', () => {
    const granted = clampPermissions(
      { ...viewerDefaults, vehicles_view: true, drivers_manage: true, users_manage: true },
      managerWithUsersManage,
      viewerDefaults,
    );
    expect(granted.vehicles_view).toBe(true); // le manager l'a
    expect(granted.drivers_manage).toBe(true); // defaut manager = true
    expect(granted.users_manage).toBe(true); // accorde au manager
  });

  it('SUPER_ADMIN / FLEET_ADMIN ne sont pas bornes (peuvent tout accorder)', () => {
    const full = getDefaultPermissions('SUPER_ADMIN'); // tout true
    for (const role of ['SUPER_ADMIN', 'FLEET_ADMIN'] as const) {
      const granted = clampPermissions(full, { role }, viewerDefaults);
      expect(granted).toEqual(full);
    }
  });

  it('cles absentes du `requested` retombent sur `fallback`, puis bornees', () => {
    const granted = clampPermissions(
      { engine_control: true }, // partiel : seul engine_control demande (refuse)
      managerWithUsersManage,
      viewerDefaults,
    );
    expect(granted.engine_control).toBe(false);
    expect(granted.vehicles_view).toBe(viewerDefaults.vehicles_view);
    expect(granted.reports_view).toBe(viewerDefaults.reports_view);
  });

  it('requested null -> fallback borne au granter (jamais d\'escalade)', () => {
    const granted = clampPermissions(null, managerWithUsersManage, viewerDefaults);
    expect(granted.engine_control).toBe(false);
    expect(granted.vehicles_view).toBe(true);
  });

  it('renvoie toujours un objet exhaustif (toutes les cles de permission)', () => {
    const granted = clampPermissions({}, managerWithUsersManage, viewerDefaults);
    expect(Object.keys(granted).sort()).toEqual(Object.keys(viewerDefaults).sort());
  });
});

// ---------------------------------------------------------------------------
// Robustesse à l'ajout de futures permissions — filet anti "bug silencieux".
// TS force déjà la complétude (maps typées UserPermissions + PERMISSION_LABELS =
// Record exhaustif), mais ces tests échouent BRUYAMMENT en CI si une nouvelle
// permission est ajoutée à l'interface sans être câblée partout (défaut de rôle
// manquant, label manquant), plutôt que de laisser passer un `undefined` traître.
// ---------------------------------------------------------------------------
describe('permissions — complétude (garde-fou ajout de permissions)', () => {
  const ALL_ROLES: UserRoleSlug[] = [
    'SUPER_ADMIN',
    'FLEET_ADMIN',
    'FLEET_MANAGER',
    'VIEWER',
    'NIGHT_WATCHMAN',
  ];

  it.each(ALL_ROLES)('les défauts de %s couvrent EXACTEMENT toutes les clés (aucune manquante ni en trop)', (role) => {
    const defaults = getDefaultPermissions(role);
    expect(Object.keys(defaults).sort()).toEqual([...PERMISSION_KEYS].sort());
    // Aucune valeur non-booléenne (pas de undefined traître).
    for (const key of PERMISSION_KEYS) {
      expect(typeof defaults[key]).toBe('boolean');
    }
  });

  it('PERMISSION_LABELS couvre exactement toutes les clés de permission', () => {
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});

describe('permissions — reset au changement de rôle borné au granter (invariant users.controller)', () => {
  // Reproduit EXACTEMENT le pattern des routes create / update(role change) :
  // clampPermissions(defautsDuRoleCible, granter, defautsDuRoleCible).
  const resetForRole = (
    targetRole: UserRoleSlug,
    granter: { role: UserRoleSlug; permissions?: Partial<UserPermissions> | null },
  ) => clampPermissions(getDefaultPermissions(targetRole), granter, getDefaultPermissions(targetRole));

  it('un admin (bypass) obtient les défauts pleins du rôle cible', () => {
    for (const role of ['SUPER_ADMIN', 'FLEET_ADMIN'] as const) {
      expect(resetForRole('FLEET_MANAGER', { role })).toEqual(getDefaultPermissions('FLEET_MANAGER'));
      expect(resetForRole('NIGHT_WATCHMAN', { role })).toEqual(getDefaultPermissions('NIGHT_WATCHMAN'));
    }
  });

  it('un granter limité ne peut JAMAIS conférer une capacité au-delà de la sienne via un changement de rôle', () => {
    // Hypothèse défensive : si @Roles était un jour élargi à FLEET_MANAGER, promouvoir
    // quelqu'un vers un rôle dont les défauts incluent une capacité que le manager n'a pas
    // (ex. engine_control du NIGHT_WATCHMAN) NE doit PAS l'accorder.
    const manager = { role: 'FLEET_MANAGER' as const, permissions: getDefaultPermissions('FLEET_MANAGER') };
    const granted = resetForRole('NIGHT_WATCHMAN', manager);
    expect(granted.engine_control).toBe(false); // le manager ne l'a pas → clampé
    const granterPerms = effectiveGranterPermissions(manager);
    for (const key of PERMISSION_KEYS) {
      if (granted[key]) expect(granterPerms[key]).toBe(true); // aucune perm accordée au-delà du granter
    }
  });
});
