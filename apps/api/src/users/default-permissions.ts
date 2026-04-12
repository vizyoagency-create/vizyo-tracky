import { UserRole } from '@prisma/client';

export interface UserPermissions {
  vehicles_view: boolean;
  vehicles_create: boolean;
  vehicles_edit: boolean;
  vehicles_delete: boolean;
  groups_view: boolean;
  groups_manage: boolean;
  geofences_view: boolean;
  geofences_manage: boolean;
  alerts_view: boolean;
  alerts_acknowledge: boolean;
  reports_view: boolean;
  users_view: boolean;
  users_manage: boolean;
}

const VIEWER_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: true,
  geofences_manage: false,
  alerts_view: true,
  alerts_acknowledge: false,
  reports_view: true,
  users_view: false,
  users_manage: false,
};

const FLEET_MANAGER_DEFAULTS: UserPermissions = {
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  reports_view: true,
  users_view: false,
  users_manage: false,
};

export function getDefaultPermissions(role: UserRole): UserPermissions {
  switch (role) {
    case UserRole.VIEWER:
      return { ...VIEWER_DEFAULTS };
    case UserRole.FLEET_MANAGER:
      return { ...FLEET_MANAGER_DEFAULTS };
    default:
      return { ...FLEET_MANAGER_DEFAULTS };
  }
}

export const PERMISSION_KEYS = Object.keys(VIEWER_DEFAULTS) as (keyof UserPermissions)[];
