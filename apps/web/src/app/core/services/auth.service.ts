import { computed, Injectable, signal } from '@angular/core';

export interface AuthUser {
  sub: string;
  email: string;
  role: string;
  fleetId: string | null;
}

const TOKEN_KEY = 'vizyo-tracky-token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _user = signal<AuthUser | null>(this.loadUser());
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    this._user.set(this.decodeJwt(token));
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    this._user.set(null);
  }

  private loadUser(): AuthUser | null {
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
      };
    } catch {
      return null;
    }
  }
}
