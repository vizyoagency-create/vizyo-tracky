import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface TrackyUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  fleetId: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface MeProfile {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: string;
  permissions: Record<string, unknown> | null;
  fleetId: string | null;
  isActive: boolean;
  onboardingCompletedAt: string | null;
  escalationContactUserId: string | null;
  createdAt: string;
}

export interface CreateUserPayload {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  role: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER';
  fleetId: string | null;
  permissions?: Record<string, boolean> | null;
  expiresAt: string;
  status?: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
  acceptedAt?: string | null;
  acceptUrlForDevDebug?: string | null;
}

export interface InvitationAccessScopeDto {
  type: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId?: string | null;
  vehicleId?: string | null;
  permissions?: Record<string, boolean> | null;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  fleetId: string | null;
  status: 'PENDING' | 'EXPIRED';
  permissions: Record<string, boolean> | null;
  /** Scopes d'accès (matrice) configurés à l'invitation. Null = legacy (scope ALL implicite). */
  accessScopes?: InvitationAccessScopeDto[] | null;
  expiresAt: string;
  createdAt: string;
}

export interface AcceptInvitationResult {
  authUserId: string;
  email: string;
  fleetId: string | null;
  role: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * ── MIGRÉ VERS `HttpClient` (2026-08-03) ─────────────────────────────────────────────
 *
 * Ce service appelait l'API en `fetch` natif. `fetch` ne traverse AUCUN intercepteur
 * Angular : ses 14 appels échappaient donc aux deux mécanismes qui protègent tout le
 * reste de l'application —
 *
 *   - l'affichage de la panne et la gestion de la session expirée (un 401 ne
 *     déconnectait même pas) ;
 *   - la remontée des pannes réseau au centre d'alerte.
 *
 * Chaque méthode devait donc réimplémenter à la main ce que l'intercepteur fait une fois
 * pour toutes — et le faisait de façon inégale : certaines vérifiaient `res.ok`, d'autres
 * l'avaient perdu au fil des réécritures et rendaient le corps d'une réponse 500 comme
 * s'il s'agissait d'un succès.
 *
 * Les signatures publiques sont INCHANGÉES (des `Promise`, via `firstValueFrom`) : aucun
 * appelant n'a été modifié. Seule l'implémentation change.
 *
 * ⚠️ Plus aucun en-tête `Authorization` posé à la main : `authInterceptor` s'en charge,
 * ainsi que du cookie `withCredentials`. Le poser ici en double ne cassait rien, mais
 * masquait le fait que ces appels ne passaient PAS par l'intercepteur.
 */
@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly http = inject(HttpClient);

  async findAll(
    includeArchived = false,
    includePending = false,
  ): Promise<{ users: TrackyUser[]; pendingInvitations: PendingInvitation[] }> {
    let params = new HttpParams();
    if (includeArchived) params = params.set('includeArchived', 'true');
    if (includePending) params = params.set('includePending', 'true');
    const body = await firstValueFrom(this.http.get<unknown>('/api/users', { params }));
    // Compatibilité ascendante : sans `includePending`, l'API rend un tableau simple.
    if (Array.isArray(body)) return { users: body as TrackyUser[], pendingInvitations: [] };
    return body as { users: TrackyUser[]; pendingInvitations: PendingInvitation[] };
  }

  create(payload: CreateUserPayload): Promise<TrackyUser> {
    return firstValueFrom(this.http.post<TrackyUser>('/api/users', payload));
  }

  update(
    id: string,
    data: {
      firstName?: string;
      lastName?: string;
      role?: string;
      isActive?: boolean;
      permissions?: Record<string, boolean>;
      fleetId?: string | null;
    },
  ): Promise<TrackyUser> {
    return firstValueFrom(this.http.patch<TrackyUser>(`/api/users/${id}`, data));
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/users/${id}`));
  }

  async resetPassword(id: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/users/${id}/reset-password`, {}));
  }

  // ─── /me — Sprint J ──────────────────────────────────────────

  me(): Promise<MeProfile> {
    return firstValueFrom(this.http.get<MeProfile>('/api/users/me'));
  }

  /**
   * ⚠️ `escalationContactUserId` était accepté ICI et validé par l'API (même flotte,
   * jamais soi-même) depuis toujours… mais AUCUN écran ne l'envoyait. Constat prod
   * 2026-07-28 : 0 utilisateur sur 15 en avait un, donc le cron d'escalade tournait
   * chaque minute sans jamais pouvoir agir. Toute la plomberie existait — il ne
   * manquait qu'un champ de formulaire.
   */
  updateMe(data: {
    firstName?: string;
    lastName?: string;
    phone?: string | null;
    escalationContactUserId?: string | null;
  }): Promise<MeProfile> {
    return firstValueFrom(this.http.patch<MeProfile>('/api/users/me', data));
  }

  completeOnboarding(): Promise<{ id: string; onboardingCompletedAt: string }> {
    return firstValueFrom(
      this.http.post<{ id: string; onboardingCompletedAt: string }>(
        '/api/users/me/onboarding-complete',
        {},
      ),
    );
  }

  // ─── /invitations — Sprint J ─────────────────────────────────

  invite(payload: {
    email: string;
    role: string;
    fleetId?: string | null;
    permissions?: Record<string, boolean>;
    /** Scopes d'accès (matrice) configurés dès l'invitation. */
    accessScopes?: {
      type: 'ALL' | 'GROUP' | 'VEHICLE';
      groupId?: string;
      vehicleId?: string;
      permissions?: Record<string, boolean>;
    }[];
  }): Promise<InvitationDto> {
    return firstValueFrom(this.http.post<InvitationDto>('/api/users/invitations', payload));
  }

  resendInvitation(id: string): Promise<InvitationDto> {
    return firstValueFrom(
      this.http.post<InvitationDto>(`/api/users/invitations/${id}/resend`, {}),
    );
  }

  async listInvitations(): Promise<InvitationDto[]> {
    const body = await firstValueFrom(
      this.http.get<{ items: InvitationDto[] }>('/api/users/invitations'),
    );
    return body.items;
  }

  async updateInvitation(
    id: string,
    data: {
      fleetId?: string | null;
      role?: string;
      permissions?: Record<string, boolean>;
      accessScopes?: InvitationAccessScopeDto[];
    },
  ): Promise<void> {
    await firstValueFrom(this.http.patch(`/api/users/invitations/${id}`, data));
  }

  async revokeInvitation(id: string): Promise<void> {
    await firstValueFrom(this.http.post(`/api/users/invitations/${id}/revoke`, {}));
  }

  acceptInvitation(payload: {
    token: string;
    password: string;
    displayName: string;
  }): Promise<AcceptInvitationResult> {
    // Route PUBLIQUE (pré-connexion) : aucun token à joindre, l'intercepteur n'ajoutera
    // rien puisqu'il n'y a pas de session. Elle passe quand même par HttpClient pour
    // bénéficier de la remontée des pannes réseau au centre d'alerte.
    return firstValueFrom(
      this.http.post<AcceptInvitationResult>('/api/auth/accept-invitation', payload),
    );
  }
}
