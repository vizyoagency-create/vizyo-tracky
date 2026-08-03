import { swallow } from '../../core/error/swallow';
import { apiFetchRaw } from './api-fetch';
import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { UserPermissions, UserRoleSlug } from '@vizyo/tracky-shared';

/** Preferences UI per-user persistees en DB (User.preferences JSONB).
 *  V1.12 — uiMode permet a chaque user de choisir entre l'UI Tracky riche
 *  (dashboard + sidebar) et l'UI Baanool simplifiee (post-login direct map,
 *  navigation via burger). Extensible pour d'autres prefs futures. */
export interface UserUiPreferences {
  uiMode?: 'tracky' | 'baanool';
}

export interface AuthUser {
  sub: string;
  email: string;
  role: UserRoleSlug;
  /** Owner plateforme : niveau au-dessus des SUPER_ADMIN, invisible aux autres
   *  super-admins. Renseigné par /api/users/me + la réponse de login. Absent =
   *  compte normal. L'invisibilité est de toute façon appliquée côté serveur. */
  isOwner?: boolean;
  fleetId: string | null;
  /**
   * Contact prévenu si CET utilisateur n'acquitte pas une alerte critique à temps.
   * Renvoyé par `/api/users/me` — il n'était simplement pas déclaré ici, faute
   * d'écran qui l'utilise. C'est ce qui rendait l'escalade invisible côté client.
   */
  escalationContactUserId?: string | null;
  permissions: UserPermissions | null;
  preferences?: UserUiPreferences | null;
}

const TOKEN_KEY = 'vizyo-tracky-token';
const REFRESH_KEY = 'vizyo-tracky-refresh';
const USER_KEY = 'vizyo-tracky-user';
/** « Rester connecté » : '1' (défaut) = localStorage persistant ; '0' = sessionStorage (session-only). */
const REMEMBER_KEY = 'vizyo-tracky-remember';

@Injectable({ providedIn: 'root' })
export class AuthService {
  /**
   * ⚠️ `HttpClient` est injecté ici alors que `authInterceptor` injecte `AuthService`.
   * Ce n'est PAS un cycle : les intercepteurs sont résolus par requête, pas à la
   * construction du client. Le cycle n'existerait que si `HttpClient` avait besoin
   * d'`AuthService` pour être construit — ce qui n'est pas le cas.
   */
  private readonly http = inject(HttpClient);
  private readonly _user = signal<AuthUser | null>(this.loadUser());
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());
  /** Sprint 3 — true si l'utilisateur courant est un veilleur de nuit (rôle restreint NIGHT_WATCHMAN). */
  readonly isWatchman = computed(() => this._user()?.role === 'NIGHT_WATCHMAN');
  /** feat/comptes-conducteurs — true si l'utilisateur courant est un conducteur (rôle restreint DRIVER). */
  readonly isDriver = computed(() => this._user()?.role === 'DRIVER');
  private refreshPromise: Promise<string | null> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // « Rester connecté » — refresh PROACTIF : on renouvelle l'access token AVANT
    // son expiration (toutes les ~15 min), pour ne JAMAIS bouncer l'utilisateur en
    // pleine action (fix « on se reconnecte tout le temps »).
    if (this.token) this.scheduleProactiveRefresh();
  }

  /** true (défaut) = session persistante (localStorage) ; false = session-only (sessionStorage). */
  private remember(): boolean {
    try {
      return localStorage.getItem(REMEMBER_KEY) !== '0';
    } catch {
      return true;
    }
  }

  private store(): Storage {
    try {
      return this.remember() ? localStorage : sessionStorage;
    } catch {
      return localStorage;
    }
  }

  private safeGet(key: string): string | null {
    try {
      return this.store().getItem(key);
    } catch {
      return null;
    }
  }

  get token(): string | null {
    return this.safeGet(TOKEN_KEY);
  }

  get refreshToken(): string | null {
    return this.safeGet(REFRESH_KEY);
  }

  setSession(token: string, user: AuthUser, refreshToken?: string, remember = true): void {
    try {
      localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
    } catch {
      /* private mode */
    }
    const store = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    try {
      store.setItem(TOKEN_KEY, token);
      if (refreshToken) store.setItem(REFRESH_KEY, refreshToken);
      store.setItem(USER_KEY, JSON.stringify(user));
      // Nettoie l'autre store (pas de tokens obsolètes qui traînent).
      other.removeItem(TOKEN_KEY);
      other.removeItem(REFRESH_KEY);
      other.removeItem(USER_KEY);
    } catch {
      /* private mode : on garde au moins le signal en mémoire */
    }
    this._user.set(user);
    this.scheduleProactiveRefresh();
  }

  updateToken(token: string, refreshToken?: string): void {
    try {
      const store = this.store();
      store.setItem(TOKEN_KEY, token);
      if (refreshToken) store.setItem(REFRESH_KEY, refreshToken);
    } catch {
      /* ignore */
    }
    this.scheduleProactiveRefresh();
  }

  /** V1.12 — Met a jour les preferences UI per-user en DB et synchronise le
   *  signal local. Merge partiel : seules les cles fournies sont updatees,
   *  les autres preferences existantes sont preservees. */
  async updatePreferences(partial: UserUiPreferences): Promise<void> {
    const { preferences } = await firstValueFrom(
      this.http.patch<{ preferences: UserUiPreferences | null }>(
        '/api/users/me/preferences',
        partial,
      ),
    );
    const current = this._user();
    if (current) {
      const updated: AuthUser = { ...current, preferences };
      try {
        this.store().setItem(USER_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      this._user.set(updated);
    }
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
      // ⚠️⚠️ CET APPEL DOIT RESTER EN `fetch` NATIF — NE PAS LE MIGRER VERS `HttpClient`.
      //
      // C'est `authInterceptor` qui appelle `tryRefresh()` lorsqu'il reçoit un 401. Si le
      // rafraîchissement passait lui-même par `HttpClient`, il traverserait cet
      // intercepteur : un refresh qui répond 401 (jeton expiré — le cas NORMAL au bout de
      // quelques jours) redéclencherait un refresh, qui redéclencherait un refresh…
      // Récursion infinie, sur le chemin critique de la connexion de TOUS les comptes.
      //
      // Les deux autres appels de ce service ont été migrés (2026-08-03) ; celui-ci est
      // l'exception, et c'est une exception de conception, pas un oubli.
      const res = await apiFetchRaw('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      }, 'Rafraichissement de session');

      if (!res.ok) return null;

      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      this.updateToken(data.accessToken, data.refreshToken);
      return data.accessToken;
    } catch (err) {
      swallow('auth:doRefresh', err);
      return null;
    }
  }

  logout(): void {
    this.stopProactiveRefresh();
    for (const s of [localStorage, sessionStorage]) {
      try {
        s.removeItem(TOKEN_KEY);
        s.removeItem(REFRESH_KEY);
        s.removeItem(USER_KEY);
      } catch {
        /* ignore */
      }
    }
    this._user.set(null);
  }

  /** V1.12 — Refetch le profil utilisateur depuis l'API et synchronise le
   *  signal local + storage. Utile pour rafraichir les preferences (ex:
   *  uiMode change depuis une autre tab/session, ou admin a modifie le role
   *  via UI). Appele au mount du shell + au regain de focus de l'onglet. */
  async refreshMe(): Promise<void> {
    if (!this.token) return;
    try {
      const fresh = await firstValueFrom(this.http.get<Partial<AuthUser>>('/api/users/me'));
      const current = this._user();
      if (current) {
        const updated: AuthUser = { ...current, ...fresh };
        try {
          this.store().setItem(USER_KEY, JSON.stringify(updated));
        } catch {
          /* ignore */
        }
        this._user.set(updated);
      }
    } catch (err) {
      // silence : non bloquant, on garde l'etat local en cas d'echec reseau
      swallow('auth:refreshMe', err);
    }
  }

  // ── Refresh proactif ────────────────────────────────────────────────────────

  /** Programme un refresh ~60 s avant l'expiration de l'access token courant. */
  private scheduleProactiveRefresh(): void {
    this.stopProactiveRefresh();
    const token = this.token;
    if (!token) return;
    const exp = this.tokenExp(token);
    if (!exp) return;
    const msUntilExpiry = exp * 1000 - Date.now();
    // 60 s de marge, plancher 5 s (évite une boucle serrée si le token est déjà court/expiré).
    const delay = Math.max(5_000, msUntilExpiry - 60_000);
    this.refreshTimer = setTimeout(() => {
      void this.proactiveTick();
    }, delay);
  }

  private async proactiveTick(): Promise<void> {
    const t = await this.tryRefresh();
    if (t) {
      this.scheduleProactiveRefresh(); // reprogramme sur le nouveau token
    }
    // sinon : on s'arrête ; un 401 ultérieur gèrera la déconnexion via l'interceptor.
  }

  private stopProactiveRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private tokenExp(token: string): number | null {
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const decoded = JSON.parse(atob(payload));
      return typeof decoded.exp === 'number' ? decoded.exp : null;
    } catch {
      return null;
    }
  }

  private loadUser(): AuthUser | null {
    const stored = this.safeGet(USER_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        /* fall through */
      }
    }
    // Fallback: decode JWT (for backward compat)
    const token = this.safeGet(TOKEN_KEY);
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
        preferences: decoded.preferences ?? null,
      };
    } catch {
      return null;
    }
  }
}
