/**
 * Source unique des permissions Tracky — partagee entre apps/api et apps/web.
 *
 * Les permissions JSON portent l'autorisation granulaire d'un user sur un scope
 * donne. Aujourd'hui un user a un set de permissions globales (User.permissions)
 * ET potentiellement un override per-scope via UserVehicleAccess.permissions
 * (Phase 1 refonte — cf. plan sharded-mixing-shore.md).
 *
 * Regle de resolution per-vehicle (PermissionsResolverService cote API) :
 *   1. Trouver la ligne UserVehicleAccess qui couvre ce vehicleId.
 *   2. Tri "specifique gagne" : VEHICLE > GROUP > ALL. Prendre la premiere.
 *   3. Si sa `permissions` est null → fallback User.permissions.
 *   4. Si toujours null → getDefaultPermissions(role).
 *
 * SUPER_ADMIN et FLEET_ADMIN bypass (tous booleens true).
 */

export type UserRoleSlug = 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER';

export interface UserPermissions {
  vehicles_view: boolean;
  vehicles_create: boolean;
  vehicles_edit: boolean;
  vehicles_delete: boolean;
  /** Couper / redemarrer le moteur du vehicule. Validation metier en plus : vitesse < 20 km/h, position fraiche, fix GPS valide. */
  engine_control: boolean;
  groups_view: boolean;
  groups_manage: boolean;
  geofences_view: boolean;
  geofences_manage: boolean;
  alerts_view: boolean;
  alerts_acknowledge: boolean;
  reports_view: boolean;
  users_view: boolean;
  users_manage: boolean;
  /** Voir la liste des conducteurs et leur affectation aux vehicules. */
  drivers_view: boolean;
  /** Creer/modifier/archiver des conducteurs et les affecter aux vehicules. */
  drivers_manage: boolean;
}

const VIEWER_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: true,
  geofences_manage: false,
  alerts_view: true,
  alerts_acknowledge: false,
  reports_view: true,
  users_view: false,
  users_manage: false,
  drivers_view: true,
  drivers_manage: false,
};

const FLEET_MANAGER_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  engine_control: false,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  reports_view: true,
  users_view: false,
  users_manage: false,
  drivers_view: true,
  drivers_manage: true,
};

const ADMIN_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  engine_control: true,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  reports_view: true,
  users_view: true,
  users_manage: true,
  drivers_view: true,
  drivers_manage: true,
};

export function getDefaultPermissions(role: UserRoleSlug): UserPermissions {
  switch (role) {
    case 'VIEWER':
      return { ...VIEWER_DEFAULTS };
    case 'FLEET_MANAGER':
      return { ...FLEET_MANAGER_DEFAULTS };
    case 'FLEET_ADMIN':
    case 'SUPER_ADMIN':
      return { ...ADMIN_DEFAULTS };
  }
}

export const PERMISSION_KEYS = Object.keys(VIEWER_DEFAULTS) as (keyof UserPermissions)[];

export interface PermissionLabel {
  group: string;
  label: string;
  /** Description courte affichee en tooltip dans la matrice 2D. */
  description?: string;
}

/**
 * Labels FR pour l'UI matrice (apps/web) et le drawer. Regroupes par module metier.
 * Toute nouvelle permission DOIT etre ajoutee ici sinon TS rale (Record exhaustif).
 */
export const PERMISSION_LABELS: Record<keyof UserPermissions, PermissionLabel> = {
  vehicles_view: { group: 'Vehicules', label: 'Voir les vehicules' },
  vehicles_create: { group: 'Vehicules', label: 'Ajouter un vehicule' },
  vehicles_edit: { group: 'Vehicules', label: 'Modifier un vehicule' },
  vehicles_delete: { group: 'Vehicules', label: 'Supprimer un vehicule' },
  engine_control: {
    group: 'Vehicules',
    label: 'Couper / redemarrer le moteur',
    description: 'Action sensible. Soumise aux contraintes metier (vitesse, fix GPS).',
  },
  groups_view: { group: 'Groupes', label: 'Voir les groupes de vehicules' },
  groups_manage: { group: 'Groupes', label: 'Gerer les groupes (creer, renommer, supprimer)' },
  geofences_view: { group: 'Geofences', label: 'Voir les geofences' },
  geofences_manage: { group: 'Geofences', label: 'Gerer les geofences' },
  alerts_view: { group: 'Alertes', label: 'Voir les alertes' },
  alerts_acknowledge: { group: 'Alertes', label: 'Acquitter les alertes' },
  reports_view: { group: 'Rapports', label: 'Voir les rapports' },
  users_view: { group: 'Utilisateurs', label: 'Voir les utilisateurs' },
  users_manage: { group: 'Utilisateurs', label: 'Gerer les utilisateurs (inviter, editer)' },
  drivers_view: { group: 'Conducteurs', label: 'Voir les conducteurs' },
  drivers_manage: { group: 'Conducteurs', label: 'Gerer les conducteurs' },
};

/** Ordre d'affichage canonique des groupes dans l'UI. */
export const PERMISSION_GROUP_ORDER: readonly string[] = [
  'Vehicules',
  'Groupes',
  'Geofences',
  'Alertes',
  'Rapports',
  'Utilisateurs',
  'Conducteurs',
] as const;
