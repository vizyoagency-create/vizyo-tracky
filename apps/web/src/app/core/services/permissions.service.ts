import { HttpClient } from '@angular/common/http';
import { effect, inject, Injectable, signal } from '@angular/core';
import type { UserPermissions } from '@vizyo/tracky-shared';
import { AuthService } from './auth.service';

/**
 * V1.11 Phase 1 — Entree d'acces utilisateur, miroir cote frontend de la matrice
 * UserVehicleAccess backend. Charge une seule fois au login via GET /users/me/access.
 */
export interface AccessEntry {
  id: string;
  accessType: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId: string | null;
  vehicleId: string | null;
  permissions: Partial<UserPermissions> | null;
  createdAt: string;
  updatedAt: string;
  group: { id: string; name: string; vehicles: { vehicleId: string }[] } | null;
  vehicle: { id: string; plate: string } | null;
}

/** Tri "specifique gagne" : VEHICLE > GROUP > ALL. */
const ACCESS_TYPE_PRIORITY: Record<AccessEntry['accessType'], number> = {
  VEHICLE: 3,
  GROUP: 2,
  ALL: 1,
};

@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  private readonly _accessEntries = signal<AccessEntry[]>([]);
  readonly accessEntries = this._accessEntries.asReadonly();

  constructor() {
    // Charge / recharge les entries quand l'user change (login, refresh, logout).
    effect(() => {
      const user = this.auth.user();
      if (user) {
        this.refreshAccessEntries();
      } else {
        this._accessEntries.set([]);
      }
    });

    // Refetch au regain de focus (l'admin a pu modifier les perms entre temps).
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.auth.user()) {
          this.refreshAccessEntries();
        }
      });
    }
  }

  /**
   * Verifie si l'utilisateur a une permission donnee.
   *
   * - **Sans `vehicleId`** : resolution globale. Lit `user.permissions[perm]`.
   *   Utilise pour montrer/cacher des boutons hors contexte vehicule
   *   (ex: "Ajouter un vehicule", liens sidebar).
   *
   * - **Avec `vehicleId`** : resolution per-vehicle, regle "specifique gagne"
   *   (VEHICLE > GROUP > ALL). Miroir du PermissionsResolverService backend.
   *   Utilise pour les actions sensibles ciblees (couper moteur, modifier
   *   ce vehicule precis).
   *
   * FLEET_ADMIN et SUPER_ADMIN bypass — toujours true.
   */
  can(permission: keyof UserPermissions, vehicleId?: string): boolean {
    const user = this.auth.user();
    if (!user) return false;
    if (user.role === 'FLEET_ADMIN' || user.role === 'SUPER_ADMIN') return true;

    if (vehicleId === undefined) {
      return user.permissions?.[permission] === true;
    }

    // Resolution per-vehicle
    const matching = this._accessEntries().filter((e) => this.entryCoversVehicle(e, vehicleId));
    if (matching.length === 0) return false;

    matching.sort((a, b) => ACCESS_TYPE_PRIORITY[b.accessType] - ACCESS_TYPE_PRIORITY[a.accessType]);
    const winning = matching[0];

    // Permissions resolues : scope prevaut, fallback user.permissions, puis false par defaut.
    if (winning.permissions && permission in winning.permissions) {
      return winning.permissions[permission] === true;
    }
    return user.permissions?.[permission] === true;
  }

  /** Force le rechargement des entries (apres modif par admin par exemple). */
  async refreshAccessEntries(): Promise<void> {
    try {
      const response = await this.http
        .get<{ entries: AccessEntry[] }>('/api/users/me/access', { withCredentials: true })
        .toPromise();
      this._accessEntries.set(response?.entries ?? []);
    } catch {
      // Echec silencieux : on garde les entries en cache. Si jamais loaded, vide
      // → can(perm, vehicleId) retourne false (failsafe).
    }
  }

  private entryCoversVehicle(entry: AccessEntry, vehicleId: string): boolean {
    if (entry.accessType === 'ALL') return true;
    if (entry.accessType === 'VEHICLE') return entry.vehicleId === vehicleId;
    if (entry.accessType === 'GROUP') {
      return entry.group?.vehicles.some((v) => v.vehicleId === vehicleId) ?? false;
    }
    return false;
  }
}
