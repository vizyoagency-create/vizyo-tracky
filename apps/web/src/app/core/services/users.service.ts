import { apiFetch, apiFetchRaw } from './api-fetch';
import { HttpFailure } from './http-failure';
import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';

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

@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly auth = inject(AuthService);

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.auth.token}`,
    };
  }

  async findAll(
    includeArchived = false,
    includePending = false,
  ): Promise<{ users: TrackyUser[]; pendingInvitations: PendingInvitation[] }> {
    const params = new URLSearchParams();
    if (includeArchived) params.set('includeArchived', 'true');
    if (includePending) params.set('includePending', 'true');
    const qs = params.toString();
    const url = `/api/users${qs ? '?' + qs : ''}`;
    const res = await apiFetchRaw(url, { headers: this.headers });
    // ⚠️ Le statut DOIT voyager avec l'erreur. Sans lui, l'ecran ne peut pas distinguer
    // « session expiree » (401) d'« interdit » (403) ou d'une panne serveur — il affichait
    // donc « Aucun utilisateur dans votre flotte » pour les trois.
    //
    // ⚠️ Cet appel utilise `fetch` NATIF, donc il ne traverse PAS les intercepteurs HTTP :
    // le 401 ne declenche ni deconnexion ni message « Session expiree ». L'appelant doit
    // s'en charger, faute de quoi l'utilisateur reste devant un ecran vide et muet.
    if (!res.ok) throw new HttpFailure(res.status, 'Chargement des utilisateurs impossible');
    const body = await res.json();
    // Backward compat: without includePending the API returns a plain array
    if (Array.isArray(body)) return { users: body, pendingInvitations: [] };
    return body;
  }

  async create(payload: CreateUserPayload): Promise<TrackyUser> {
    const res = await apiFetchRaw('/api/users', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, string>;
      throw new HttpFailure(res.status, body['message'] ?? 'Failed to create user');
    }
    return res.json();
  }

  async update(id: string, data: { firstName?: string; lastName?: string; role?: string; isActive?: boolean; permissions?: Record<string, boolean>; fleetId?: string | null }): Promise<TrackyUser> {
    const res = await apiFetchRaw(`/api/users/${id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, string>;
      throw new HttpFailure(res.status, body['message'] ?? 'Failed to update user');
    }
    return res.json();
  }

  async remove(id: string): Promise<void> {
    const res = await apiFetchRaw(`/api/users/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok && res.status !== 204) throw new HttpFailure(res.status, 'Failed to archive user');
  }

  async resetPassword(id: string): Promise<void> {
    const res = await apiFetch(`/api/users/${id}/reset-password`, {
      method: 'POST',
      headers: this.headers,
    }, 'Failed to send password reset');
  }

  // ─── /me — Sprint J ──────────────────────────────────────────

  async me(): Promise<MeProfile> {
    const res = await apiFetch('/api/users/me', { headers: this.headers }, 'Failed to load profile');
    return res.json();
  }

  /**
   * ⚠️ `escalationContactUserId` était accepté ICI et validé par l'API (même flotte,
   * jamais soi-même) depuis toujours… mais AUCUN écran ne l'envoyait. Constat prod
   * 2026-07-28 : 0 utilisateur sur 15 en avait un, donc le cron d'escalade tournait
   * chaque minute sans jamais pouvoir agir. Toute la plomberie existait — il ne
   * manquait qu'un champ de formulaire.
   */
  async updateMe(data: {
    firstName?: string;
    lastName?: string;
    phone?: string | null;
    escalationContactUserId?: string | null;
  }): Promise<MeProfile> {
    const res = await apiFetch('/api/users/me', {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, string>;
      throw new HttpFailure(res.status, body['message'] ?? 'Failed to update profile');
    }
    return res.json();
  }

  async completeOnboarding(): Promise<{ id: string; onboardingCompletedAt: string }> {
    const res = await apiFetchRaw('/api/users/me/onboarding-complete', {
      method: 'POST',
      headers: this.headers,
    }, 'Failed to mark onboarding complete');
    return res.json();
  }

  // ─── /invitations — Sprint J ─────────────────────────────────

  async invite(payload: {
    email: string;
    role: string;
    fleetId?: string | null;
    permissions?: Record<string, boolean>;
    /** Scopes d'accès (matrice) configurés dès l'invitation. */
    accessScopes?: { type: 'ALL' | 'GROUP' | 'VEHICLE'; groupId?: string; vehicleId?: string; permissions?: Record<string, boolean> }[];
  }): Promise<InvitationDto> {
    const res = await apiFetch('/api/users/invitations', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errObj = body['error'] as Record<string, string> | undefined;
      throw new HttpFailure(res.status, errObj?.['message'] ?? (body['message'] as string) ?? 'Failed to send invitation');
    }
    return res.json();
  }

  async resendInvitation(id: string): Promise<InvitationDto> {
    const res = await apiFetchRaw(`/api/users/invitations/${id}/resend`, {
      method: 'POST',
      headers: this.headers,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errObj = body['error'] as Record<string, string> | undefined;
      throw new HttpFailure(res.status, errObj?.['message'] ?? (body['message'] as string) ?? 'Failed to resend invitation');
    }
    return res.json();
  }

  async listInvitations(): Promise<InvitationDto[]> {
    const res = await apiFetchRaw('/api/users/invitations', { headers: this.headers }, 'Failed to load invitations');
    const body = await res.json() as { items: InvitationDto[] };
    return body.items;
  }

  async updateInvitation(id: string, data: { fleetId?: string | null; role?: string; permissions?: Record<string, boolean>; accessScopes?: InvitationAccessScopeDto[] }): Promise<void> {
    const res = await apiFetch(`/api/users/invitations/${id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errObj = body['error'] as Record<string, string> | undefined;
      throw new HttpFailure(res.status, errObj?.['message'] ?? (body['message'] as string) ?? 'Failed to update invitation');
    }
  }

  async revokeInvitation(id: string): Promise<void> {
    const res = await apiFetchRaw(`/api/users/invitations/${id}/revoke`, {
      method: 'POST',
      headers: this.headers,
    }, 'Failed to revoke invitation');
  }

  async acceptInvitation(payload: {
    token: string;
    password: string;
    displayName: string;
  }): Promise<AcceptInvitationResult> {
    const res = await apiFetchRaw('/api/auth/accept-invitation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errObj = body['error'] as Record<string, string> | undefined;
      throw new HttpFailure(res.status, errObj?.['message'] ?? (body['message'] as string) ?? 'Failed to accept invitation');
    }
    return res.json();
  }
}
