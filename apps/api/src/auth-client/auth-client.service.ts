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
    const payload = `${timestamp}.${JSON.stringify(body ?? {})}`;
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
    const headers: Record<string, string> = this.signHeaders(body);
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
    return this.request<void>(
      'DELETE',
      `/v1/apps/${this.appId}/users/${authUserId}`,
    );
  }
}
