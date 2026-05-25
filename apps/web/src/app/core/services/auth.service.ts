import { computed, Injectable, signal } from '@angular/core';
import type { UserPermissions, UserRoleSlug } from '@vizyo/tracky-shared';

export interface AuthUser {
  sub: string;
  email: string;
  role: UserRoleSlug;
  fleetId: string | null;
  permissions: UserPermissions | null;
}

const TOKEN_KEY = 'vizyo-tracky-token';
const REFRESH_KEY = 'vizyo-tracky-refresh';
const USER_KEY = 'vizyo-tracky-user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _user = signal<AuthUser | null>(this.loadUser());
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());
  private refreshPromise: Promise<string | null> | null = null;

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  get refreshToken(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  }

  setSession(token: string, user: AuthUser, refreshToken?: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this._user.set(user);
  }

  updateToken(token: string, refreshToken?: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  }

  /** Tente un refresh du token. Retourne le nouveau accessToken ou null si échec. */
  async tryRefresh(): Promise<string | null> {
    // Éviter les refreshs en parallèle
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh();
    const result = await this.refreshPromise;
    this.refreshPromise = null;
    return result;
  }

  private async doRefresh(): Promise<string | null> {
    const rt = this.refreshToken;
    if (!rt) return null;

    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });

      if (!res.ok) return null;

      const data = await res.json() as { accessToken: string; refreshToken: string };
      this.updateToken(data.accessToken, data.refreshToken);
      return data.accessToken;
    } catch {
      return null;
    }
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    this._user.set(null);
  }

  private loadUser(): AuthUser | null {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) {
      try { return JSON.parse(stored); } catch { /* fall through */ }
    }
    // Fallback: decode JWT (for backward compat)
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    return this.decodeJwt(token);
  }

  private decodeJwt(token: string): AuthUser | null {
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const decoded = JSON.parse(atob(payload));
      return {
        sub: decoded.sub,
        email: decoded.email,
        role: decoded.role,
        fleetId: decoded.fleetId ?? null,
        permissions: decoded.permissions ?? null,
      };
    } catch {
      return null;
    }
  }
}
