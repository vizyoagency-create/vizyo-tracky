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

export type UserRoleSlug = 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' | 'NIGHT_WATCHMAN';

export interface UserPermissions {
  vehicles_view: boolean;
  vehicles_create: boolean;
  vehicles_edit: boolean;
  vehicles_delete: boolean;
  /** Couper / redemarrer le moteur du vehicule. Validation metier en plus : vitesse < 20 km/h, position fraiche, fix GPS valide. */
  engine_control: boolean;
  /** Sprint 3 — gerer les horaires (schedules) marche/coupure d'un vehicule. Toggle per-user (veilleur de nuit, OFF par defaut). */
  schedules_manage: boolean;
  groups_view: boolean;
  groups_manage: boolean;
  geofences_view: boolean;
  geofences_manage: boolean;
  alerts_view: boolean;
  alerts_acknowledge: boolean;
  /** Configurer les regles d'alertes (seuils, canaux, escalade) pour la flotte ou par vehicule. */
  alerts_configure: boolean;
  reports_view: boolean;
  users_view: boolean;
  users_manage: boolean;
  /** Voir la liste des conducteurs et leur affectation aux vehicules. */
  drivers_view: boolean;
  /** Creer/modifier/archiver des conducteurs et les affecter aux vehicules. */
  drivers_manage: boolean;
  /** Voir le parc de cartes SIM (de sa flotte) et leur conso data. */
  sims_view: boolean;
  /** Assigner / detacher une carte SIM a un tracker. */
  sims_assign: boolean;
  /**
   * Sprint 4 — Declencher l'ecoute audio a distance du vehicule (micro). Capacite
   * LEGALEMENT SENSIBLE : OFF par defaut PARTOUT sauf admin, gate env supplementaire
   * (desactivee en production sans flag explicite, cf. AudioMonitoringGuard).
   */
  audio_monitoring: boolean;
}

const VIEWER_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: false,
  schedules_manage: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: true,
  geofences_manage: false,
  alerts_view: true,
  alerts_acknowledge: false,
  alerts_configure: false,
  reports_view: true,
  users_view: false,
  users_manage: false,
  drivers_view: true,
  drivers_manage: false,
  sims_view: false,
  sims_assign: false,
  audio_monitoring: false,
};

const FLEET_MANAGER_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  engine_control: false,
  schedules_manage: true,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  alerts_configure: false,
  reports_view: true,
  users_view: false,
  users_manage: false,
  drivers_view: true,
  drivers_manage: true,
  sims_view: true,
  sims_assign: false,
  audio_monitoring: false,
};

const ADMIN_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  engine_control: true,
  schedules_manage: true,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  alerts_configure: true,
  reports_view: true,
  users_view: true,
  users_manage: true,
  drivers_view: true,
  drivers_manage: true,
  sims_view: true,
  sims_assign: true,
  audio_monitoring: true,
};

/**
 * Sprint 3 — « veilleur de nuit » : voit les vehicules et peut couper/redemarrer
 * le moteur (bloquer/debloquer), rien d'autre. `schedules_manage` est OFF par
 * defaut (toggle per-user accorde par un admin). Aucune autre capacite.
 */
const NIGHT_WATCHMAN_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: true,
  schedules_manage: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: false,
  geofences_manage: false,
  alerts_view: false,
  alerts_acknowledge: false,
  alerts_configure: false,
  reports_view: false,
  users_view: false,
  users_manage: false,
  drivers_view: false,
  drivers_manage: false,
  sims_view: false,
  sims_assign: false,
  audio_monitoring: false,
};

export function getDefaultPermissions(role: UserRoleSlug): UserPermissions {
  switch (role) {
    case 'VIEWER':
      return { ...VIEWER_DEFAULTS };
    case 'FLEET_MANAGER':
      return { ...FLEET_MANAGER_DEFAULTS };
    case 'NIGHT_WATCHMAN':
      return { ...NIGHT_WATCHMAN_DEFAULTS };
    case 'FLEET_ADMIN':
    case 'SUPER_ADMIN':
      return { ...ADMIN_DEFAULTS };
    default:
      // Role inconnu/absent : on retombe sur le set le plus restrictif.
      return { ...VIEWER_DEFAULTS };
  }
}

export const PERMISSION_KEYS = Object.keys(VIEWER_DEFAULTS) as (keyof UserPermissions)[];

/**
 * Permissions effectives d'un "granter" (inviteur / editeur) pour borner ce
 * qu'il peut accorder a autrui. SUPER_ADMIN et FLEET_ADMIN sont privilegies
 * (bypass = toutes permissions true). Les autres roles partent de leurs defauts
 * de role, surcharges par leur set explicite (User.permissions).
 */
export function effectiveGranterPermissions(granter: {
  role: UserRoleSlug;
  permissions?: Partial<UserPermissions> | null;
}): UserPermissions {
  if (granter.role === 'SUPER_ADMIN' || granter.role === 'FLEET_ADMIN') {
    return { ...ADMIN_DEFAULTS };
  }
  const out = getDefaultPermissions(granter.role);
  const explicit = granter.permissions;
  if (explicit) {
    for (const key of PERMISSION_KEYS) {
      if (typeof explicit[key] === 'boolean') {
        out[key] = explicit[key] as boolean;
      }
    }
  }
  return out;
}

/**
 * Borne (clamp) un set de permissions demande pour qu'AUCUNE permission ne
 * depasse ce que le granter detient lui-meme. Invariant de securite : un
 * inviteur/editeur ne peut jamais accorder une capacite qu'il n'a pas — ce qui
 * empeche l'escalade de privileges via un compte-pantin (ex: un FLEET_MANAGER
 * sans engine_control qui inviterait un VIEWER avec engine_control=true).
 *
 * `requested` peut etre partiel ou non-fiable (corps de requete) : les cles
 * absentes retombent sur `fallback` (typiquement les defauts du role cible),
 * puis l'ensemble est borne au granter. Renvoie un UserPermissions exhaustif.
 */
export function clampPermissions(
  requested: Partial<UserPermissions> | null | undefined,
  granter: { role: UserRoleSlug; permissions?: Partial<UserPermissions> | null },
  fallback: UserPermissions,
): UserPermissions {
  const granterPerms = effectiveGranterPermissions(granter);
  const out = {} as UserPermissions;
  for (const key of PERMISSION_KEYS) {
    const wanted =
      requested && typeof requested[key] === 'boolean'
        ? (requested[key] as boolean)
        : fallback[key];
    out[key] = wanted && granterPerms[key];
  }
  return out;
}

/**
 * Variante "partielle" du clamp, pour les overrides par scope
 * (UserVehicleAccess.permissions). Ne touche QUE les cles presentes dans
 * `requested` — preserve la semantique d'heritage (cle absente = herite, on ne
 * la materialise pas) — et borne chaque cle presente aux permissions du granter
 * (anti-escalade). Pas de `fallback` : ne depend donc pas du role cible.
 */
export function clampPartialPermissions(
  requested: Partial<UserPermissions>,
  granter: { role: UserRoleSlug; permissions?: Partial<UserPermissions> | null },
): Partial<UserPermissions> {
  const granterPerms = effectiveGranterPermissions(granter);
  const out: Partial<UserPermissions> = {};
  for (const key of PERMISSION_KEYS) {
    if (typeof requested[key] === 'boolean') {
      out[key] = (requested[key] as boolean) && granterPerms[key];
    }
  }
  return out;
}

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
  schedules_manage: {
    group: 'Horaires',
    label: 'Gerer les horaires marche/coupure',
    description: 'Definir les plages horaires d\'allumage/coupure automatique d\'un vehicule.',
  },
  groups_view: { group: 'Groupes', label: 'Voir les groupes de vehicules' },
  groups_manage: { group: 'Groupes', label: 'Gerer les groupes (creer, renommer, supprimer)' },
  geofences_view: { group: 'Geofences', label: 'Voir les geofences' },
  geofences_manage: { group: 'Geofences', label: 'Gerer les geofences' },
  alerts_view: { group: 'Alertes', label: 'Voir les alertes' },
  alerts_acknowledge: { group: 'Alertes', label: 'Acquitter les alertes' },
  alerts_configure: { group: 'Alertes', label: 'Configurer les regles d\'alertes', description: 'Creer, modifier et supprimer les regles de notification et seuils par vehicule.' },
  reports_view: { group: 'Rapports', label: 'Voir les rapports' },
  users_view: { group: 'Utilisateurs', label: 'Voir les utilisateurs' },
  users_manage: { group: 'Utilisateurs', label: 'Gerer les utilisateurs (inviter, editer)' },
  drivers_view: { group: 'Conducteurs', label: 'Voir les conducteurs' },
  drivers_manage: { group: 'Conducteurs', label: 'Gerer les conducteurs' },
  sims_view: {
    group: 'Cartes SIM',
    label: 'Voir les cartes SIM',
    description: 'Voir le parc SIM de la flotte et la conso data.',
  },
  sims_assign: {
    group: 'Cartes SIM',
    label: 'Assigner une carte SIM a un tracker',
    description: 'Poser / detacher une SIM sur un boitier de la flotte.',
  },
  audio_monitoring: {
    group: 'Audio',
    label: 'Écouter l\'audio du véhicule',
    description:
      'Capacite legalement sensible (micro embarque). Desactivee en production sans flag dedie, attestation flotte requise. OFF par defaut.',
  },
};

/** Ordre d'affichage canonique des groupes dans l'UI. */
export const PERMISSION_GROUP_ORDER: readonly string[] = [
  'Vehicules',
  'Horaires',
  'Groupes',
  'Geofences',
  'Alertes',
  'Rapports',
  'Utilisateurs',
  'Conducteurs',
  'Cartes SIM',
  'Audio',
] as const;
