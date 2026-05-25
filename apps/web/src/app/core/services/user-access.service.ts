import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { UserPermissions } from '@vizyo/tracky-shared';

/**
 * V1.11 Phase 1 — API client pour la matrice user x scope x permissions.
 * Miroir des endpoints PR 2 (users.controller.ts).
 */

export interface AccessEntryDto {
  id: string;
  accessType: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId: string | null;
  vehicleId: string | null;
  permissions: Partial<UserPermissions> | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserAccessResponse {
  entries: AccessEntryDto[];
  // Format legacy en parallele (compat ancien front).
  type: 'ALL' | 'CUSTOM';
  groupIds: string[];
  vehicleIds: string[];
}

export interface SetAccessEntryInput {
  type: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId?: string;
  vehicleId?: string;
  permissions?: Partial<UserPermissions>;
}

@Injectable({ providedIn: 'root' })
export class UserAccessService {
  private readonly http = inject(HttpClient);

  getAccess(userId: string): Observable<UserAccessResponse> {
    return this.http.get<UserAccessResponse>(`/api/users/${userId}/access`, {
      withCredentials: true,
    });
  }

  /** PUT — remplace toutes les lignes d'acces du user. */
  setAccess(userId: string, entries: SetAccessEntryInput[]): Observable<UserAccessResponse> {
    return this.http.put<UserAccessResponse>(
      `/api/users/${userId}/access`,
      { entries },
      { withCredentials: true },
    );
  }

  /** PATCH — modifie les permissions d'une seule ligne (toggle case dans la matrice). */
  updateEntryPermissions(
    userId: string,
    accessId: string,
    permissions: Partial<UserPermissions>,
  ): Observable<AccessEntryDto> {
    return this.http.patch<AccessEntryDto>(
      `/api/users/${userId}/access/${accessId}`,
      { permissions },
      { withCredentials: true },
    );
  }

  /** DELETE — retire une ligne (refus si c'est la derniere). */
  deleteEntry(userId: string, accessId: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/users/${userId}/access/${accessId}`, {
      withCredentials: true,
    });
  }
}
