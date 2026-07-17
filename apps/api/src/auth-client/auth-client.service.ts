import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { Env } from '../config/env.validation';

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterResponse {
  id?: string;
  ok?: boolean;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface MeResponse {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

@Injectable()
export class AuthClientService {
  private readonly logger = new Logger(AuthClientService.name);
  private readonly apiUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.apiUrl = this.config.get('VIZYO_AUTH_API_URL', { infer: true });
    this.appId = this.config.get('VIZYO_AUTH_APP_ID', { infer: true });
    this.appSecret = this.config.get('VIZYO_AUTH_APP_SECRET', { infer: true });
  }

  private signHeaders(body: unknown): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const payload = `${timestamp}.${bodyStr}`;
    const signature = createHmac('sha256', this.appSecret)
      .update(payload)
      .digest('hex');

    return {
      'Content-Type': 'application/json',
      'X-App-Id': this.appId,
      'X-App-Timestamp': timestamp,
      'X-App-Signature': signature,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    bearerToken?: string,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    // Pour GET, signer avec '' (pas de body) pour matcher le AppGuard de Vizyo Auth
    const hmacBody = method === 'GET' ? '' : body;
    const headers: Record<string, string> = this.signHeaders(hmacBody);
    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '(body unreadable)');
      this.logger.warn(`Vizyo Auth ${method} ${path} → ${res.status}: ${text}`);
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException('Authentication failed');
      }
      throw new Error(`Vizyo Auth error ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('POST', '/v1/auth/login', {
      email,
      password,
    });
  }

  async register(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<RegisterResponse> {
    return this.request<RegisterResponse>('POST', '/v1/auth/register', {
      email,
      password,
      displayName,
    });
  }

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    return this.request<RefreshResponse>('POST', '/v1/auth/refresh', {
      refreshToken,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    return this.request<void>('POST', '/v1/auth/logout', { refreshToken });
  }

  async me(accessToken: string): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/v1/auth/me', undefined, accessToken);
  }

  async suspendUser(authUserId: string): Promise<void> {
    return this.request<void>(
      'PATCH',
      `/v1/apps/${this.appId}/users/${authUserId}/status`,
      { status: 'suspended' },
    );
  }

  async activateUser(authUserId: string): Promise<void> {
    return this.request<void>(
      'PATCH',
      `/v1/apps/${this.appId}/users/${authUserId}/status`,
      { status: 'active' },
    );
  }

  async removeUserFromApp(authUserId: string): Promise<void> {
    // Body explicite {} pour que la signature HMAC (calculee sur JSON.stringify(body))
    // corresponde au body reellement envoye dans la requete fetch.
    return this.request<void>(
      'DELETE',
      `/v1/apps/${this.appId}/users/${authUserId}`,
      {},
    );
  }

  async listAppUsers(): Promise<Array<{ id: string; email: string; displayName: string | null; status: string; createdAt: string }>> {
    try {
      const result = await this.request<{ users: Array<{ id: string; email: string; displayName: string | null; status: string; createdAt: string }> }>(
        'GET',
        `/v1/apps/${this.appId}/users`,
      );
      return result.users ?? [];
    } catch {
      return [];
    }
  }

  async requestPasswordReset(email: string): Promise<{ token: string | null }> {
    return this.request<{ token: string | null }>(
      'POST',
      '/v1/auth/request-password-reset',
      { email },
    );
  }

  // ── Vérification e-mail des nouveaux appareils (2FA app) ────────────────────
  // Vizyo Auth GÉNÈRE + VÉRIFIE le code ; Tracky envoie l'e-mail (même partage que
  // le reset mot de passe). `sendLoginCode` retourne le code à envoyer par e-mail.

  /** Génère un code e-mail côté Vizyo Auth et le retourne (Tracky l'envoie). */
  async sendLoginCode(email: string): Promise<{ code: string; expiresIn: number }> {
    return this.request<{ code: string; expiresIn: number }>(
      'POST',
      '/v1/auth/email-otp/send',
      { email },
    );
  }

  /**
   * Vérifie un code e-mail. Renvoie { ok } sans lever d'exception sur code
   * invalide/expiré (un 401 propagé jusqu'au front déclencherait une
   * déconnexion) : on interroge Vizyo Auth en direct et on mappe l'échec en
   * { ok: false }. Les vraies erreurs réseau sont, elles, relancées.
   */
  async verifyLoginCode(email: string, code: string): Promise<{ ok: boolean }> {
    const url = `${this.apiUrl}/v1/auth/email-otp/verify`;
    const body = { email, code };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.signHeaders(body),
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return { ok: data?.ok === true };
    }
    // 400/401/429 = code invalide/expiré/trop de tentatives → échec « métier »,
    // pas une erreur d'auth de l'app. On ne propage PAS (éviterait un logout front).
    if (res.status === 400 || res.status === 401 || res.status === 429) {
      return { ok: false };
    }
    const text = await res.text().catch(() => '(body unreadable)');
    this.logger.warn(`Vizyo Auth POST /v1/auth/email-otp/verify → ${res.status}: ${text}`);
    throw new Error(`Vizyo Auth error ${res.status}: ${text}`);
  }
}
