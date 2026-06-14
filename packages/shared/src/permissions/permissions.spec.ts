import {
  clampPermissions,
  effectiveGranterPermissions,
  getDefaultPermissions,
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
