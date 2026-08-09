import {
  clampPermissions,
  effectiveGranterPermissions,
  getDefaultPermissions,
  isClosedRole,
  permissionsForTargetRole,
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
    // DRIVER manquait a l'appel : le garde-fou ne le couvrait pas alors qu'il a ses
    // propres defauts. Ajoute avec DEPOT — la liste doit etre exhaustive, sinon un
    // role peut partir en production avec une permission `undefined`.
    'DRIVER',
    'DEPOT',
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

// ---------------------------------------------------------------------------
// Espace dépôt (2026-08) — le rôle DEPOT. Cf. design/A1-ROLE-DEPOT.md § 2.
//
// Ces tests fixent le CONTRAT du rôle côté source partagée. Ils ne remplacent pas
// les 12 tests d'isolation d'API (depot-isolation.e2e-spec.ts) : ici on vérifie ce
// que le rôle PEUT en théorie, là-bas ce que le serveur SERT réellement.
// ---------------------------------------------------------------------------
describe('permissions — rôle DEPOT', () => {
  const OUVERTES: (keyof UserPermissions)[] = [
    'missions_view',
    'trips_view',
    'mission_share',
    'driver_contact_view',
  ];

  it('exactement 4 permissions ouvertes, toutes les autres fermées', () => {
    const perms = getDefaultPermissions('DEPOT');
    const ouvertes = PERMISSION_KEYS.filter((k) => perms[k] === true).sort();
    expect(ouvertes).toEqual([...OUVERTES].sort());
  });

  it.each([
    // Le cœur du rôle : aucun accès flotte, aucune écriture sur un véhicule.
    'vehicles_view',
    'engine_control',
    'privacy_manage',
    'schedules_manage',
    // L'export dépôt passe par un endpoint dédié, pas par /reports.
    'reports_view',
    'reports_export',
    // Hors périmètre, sans exception.
    'users_view',
    'users_manage',
    'drivers_view',
    'sims_view',
    'billing_manage',
    'alerts_view',
    'geofences_view',
    'groups_view',
    'places_view',
    'audio_monitoring',
    'qr_manage',
    // L'agenda est l'outil du transporteur.
    'agenda_view',
    'reservations_view',
    'reservations_request',
    'reservations_manage',
    // Un dépôt ne crée pas de mission : il en est le destinataire.
    'missions_manage',
  ] as (keyof UserPermissions)[])('%s est fermée pour un DEPOT', (key) => {
    expect(getDefaultPermissions('DEPOT')[key]).toBe(false);
  });

  it('un DEPOT n\'accorde RIEN : effectiveGranterPermissions est intégralement à false', () => {
    const granter = effectiveGranterPermissions({ role: 'DEPOT' });
    expect(Object.values(granter).every((v) => v === false)).toBe(true);
  });

  it('un DEPOT ne peut pas s\'auto-accorder une capacité via un set explicite', () => {
    // Un `User.permissions` falsifié en base ou par une route mal gardée ne doit pas
    // suffire : le clamp borne au granter, et un DEPOT ne détient rien à accorder.
    const escalade = clampPermissions(
      { vehicles_view: true, engine_control: true, users_manage: true },
      { role: 'DEPOT', permissions: { vehicles_view: true, engine_control: true } },
      getDefaultPermissions('VIEWER'),
    );
    expect(escalade.vehicles_view).toBe(false);
    expect(escalade.engine_control).toBe(false);
    expect(escalade.users_manage).toBe(false);
  });

  it('personne ne peut accorder vehicles_view à un compte DEPOT (A5 § 9, critère 4)', () => {
    // Le cas qui compte : un FLEET_ADMIN (qui détient TOUT) demande explicitement
    // d'ouvrir la flotte à un dépôt. `clampPermissions` seul laisserait passer —
    // il borne au granter, et le granter a tout. C'est le rôle CIBLE qui refuse.
    const ecrit = permissionsForTargetRole(
      'DEPOT',
      { vehicles_view: true, engine_control: true, users_manage: true, reports_export: true },
      { role: 'FLEET_ADMIN' },
    );
    expect(ecrit.vehicles_view).toBe(false);
    expect(ecrit.engine_control).toBe(false);
    expect(ecrit.users_manage).toBe(false);
    expect(ecrit.reports_export).toBe(false);
    // …et les 4 capacités légitimes du rôle restent ouvertes.
    expect(ecrit.missions_view).toBe(true);
    expect(ecrit.mission_share).toBe(true);
  });

  it('permissionsForTargetRole n\'altère PAS les rôles ouverts (non-régression)', () => {
    // Le court-circuit ne doit toucher que les rôles fermés : pour tous les autres,
    // le comportement reste exactement celui de clampPermissions.
    const attendu = clampPermissions(
      { reports_export: true },
      { role: 'FLEET_MANAGER' },
      getDefaultPermissions('VIEWER'),
    );
    const obtenu = permissionsForTargetRole(
      'VIEWER',
      { reports_export: true },
      { role: 'FLEET_MANAGER' },
    );
    expect(obtenu).toEqual(attendu);
    expect(obtenu.reports_export).toBe(true);
  });

  it('un DEPOT reste fermé même si le granter est un autre DEPOT', () => {
    const ecrit = permissionsForTargetRole(
      'DEPOT',
      { vehicles_view: true },
      { role: 'DEPOT', permissions: { vehicles_view: true } },
    );
    expect(ecrit.vehicles_view).toBe(false);
  });

  it('DEPOT est le seul rôle fermé — les autres restent modifiables', () => {
    expect(isClosedRole('DEPOT')).toBe(true);
    for (const r of ['SUPER_ADMIN', 'FLEET_ADMIN', 'FLEET_MANAGER', 'VIEWER', 'NIGHT_WATCHMAN', 'DRIVER'] as UserRoleSlug[]) {
      expect(isClosedRole(r)).toBe(false);
    }
  });

  it('DEPOT n\'est pas un rang : ses permissions ne sont pas un sous-ensemble de VIEWER', () => {
    // L'invariant de D3. Si DEPOT était « sous VIEWER », toute permission ouverte au
    // dépôt serait aussi ouverte au lecteur. Ce n'est pas le cas — mission_share et
    // driver_contact_view sont fermées au VIEWER et ouvertes au DEPOT. Un test qui
    // casse ici signale qu'on a glissé DEPOT dans une hiérarchie.
    const depot = getDefaultPermissions('DEPOT');
    const viewer = getDefaultPermissions('VIEWER');
    const ouvertesAuDepotFermeesAuViewer = PERMISSION_KEYS.filter(
      (k) => depot[k] && !viewer[k],
    );
    expect(ouvertesAuDepotFermeesAuViewer.sort()).toEqual(
      ['driver_contact_view', 'mission_share'].sort(),
    );
  });
});

describe('permissions — missions : défauts par rôle (A1 § 2)', () => {
  const TABLE: Array<[UserRoleSlug, boolean, boolean, boolean, boolean]> = [
    // rôle,             missions_view, missions_manage, mission_share, driver_contact_view
    ['SUPER_ADMIN', true, true, true, true],
    ['FLEET_ADMIN', true, true, true, true],
    ['FLEET_MANAGER', true, true, true, true],
    ['VIEWER', true, false, false, false],
    ['NIGHT_WATCHMAN', false, false, false, false],
    ['DRIVER', true, false, false, false],
    ['DEPOT', true, false, true, true],
  ];

  it.each(TABLE)('%s', (role, view, manage, share, contact) => {
    const p = getDefaultPermissions(role);
    expect(p.missions_view).toBe(view);
    expect(p.missions_manage).toBe(manage);
    expect(p.mission_share).toBe(share);
    expect(p.driver_contact_view).toBe(contact);
  });

  it('le veilleur de nuit reste à zéro sur les missions', () => {
    // Son métier est nocturne, les missions sont diurnes, et il travaille sans
    // aucune donnée de conducteur. Invariant explicite d'A1 § 2.
    const p = getDefaultPermissions('NIGHT_WATCHMAN');
    expect([p.missions_view, p.missions_manage, p.mission_share, p.driver_contact_view]).toEqual([
      false,
      false,
      false,
      false,
    ]);
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
