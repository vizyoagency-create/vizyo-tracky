import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { Env } from '../config/env.validation';

/**
 * Delai au-dela duquel Vizyo Auth est declare injoignable. Un rafraichissement de jeton se fait
 * pendant que la personne attend devant son ecran : au-dela de quelques secondes, echouer VITE et
 * le DIRE vaut mieux que faire patienter sur une dependance qui ne repondra pas.
 */
const DELAI_APPEL_MS = 8_000;

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
  /** publicId (`app_xxx`) — va dans l'en-tete X-App-Id. */
  private readonly appId: string;
  /**
   * cuid interne (`cmnu...`) — va dans les CHEMINS /v1/apps/:appId/...
   *
   * ⚠️ Les deux identifiants ne sont PAS interchangeables : cote Vizyo Auth,
   * `AppGuard` resout l'en-tete X-App-Id via findByPublicId() puis pose
   * `req.appEntity` (dont `.id` est le cuid interne), et `checkAppAccess()`
   * compare ce cuid au parametre d'URL. Passer le publicId dans le chemin
   * donne un 403 « Access denied: you can only access users of your own
   * application » qui laisse croire a un probleme de droits alors que c'est
   * un probleme d'identifiant.
   */
  private readonly appInternalId: string;
  private readonly appSecret: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.apiUrl = this.config.get('VIZYO_AUTH_API_URL', { infer: true });
    this.appId = this.config.get('VIZYO_AUTH_APP_ID', { infer: true });
    this.appInternalId = this.config.get('VIZYO_AUTH_APP_INTERNAL_ID', { infer: true });
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

  /**
   * TRK-068 — TOUT appel sortant vers Vizyo Auth passe par ici, et aucun ne peut durer.
   *
   * Le cas « le serveur repond une erreur » etait deja instruit (401/403 -> refus
   * d'authentification, autre -> erreur nommee portant le code). C'est UNIQUEMENT le rejet de
   * TRANSPORT — DNS, connexion coupee, TLS, pas de reponse — qui remontait nu : `fetch failed`,
   * sans capture ni delai d'expiration. NestJS en faisait un 500, et le filtre d'exceptions un
   * `CRITICAL`, parce qu'une exception qui n'est pas une `HttpException` est par definition une
   * faute serveur non maitrisee.
   *
   * Trois choses etaient fausses dans cette seule ligne :
   *   1. le MESSAGE ne nommait ni la dependance, ni l'operation, ni la consequence ;
   *   2. le CODE disait « nous avons un bug » (500) la ou une dependance injoignable est un 503 —
   *      le client ne pouvait pas distinguer « reessaie » de « ta session est morte » ;
   *   3. le NIVEAU criait `CRITICAL` pour une panne de transport d'un tiers.
   *
   * Lever une `ServiceUnavailableException` corrige les trois d'un geste : c'est une
   * `HttpException`, donc le filtre la classe en `ERROR` et rend un 503.
   *
   * 🔑 Le motif technique est DEPLACE en fin de phrase, jamais efface : on change l'ordre de
   * lecture, on ne perd pas la preuve. *Un message qui nettoie l'ecran au lieu de traduire
   * l'incident n'est pas un correctif.*
   */
  private async appelerVizyoAuth(
    url: string,
    init: RequestInit,
    /** Ce qu'on tentait, en clair : « l'appel POST /v1/auth/refresh ». */
    operation: string,
    /** Ce que la personne va constater. C'est la moitie qui manque toujours aux messages bruts. */
    consequence: string,
  ): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(DELAI_APPEL_MS) });
    } catch (e) {
      const expire = e instanceof Error && e.name === 'TimeoutError';
      const motif = expire
        ? `aucune reponse en ${DELAI_APPEL_MS / 1000} s`
        : e instanceof Error
          ? e.message
          : String(e);
      this.logger.warn(`Vizyo Auth injoignable (${operation}) : ${motif}`);
      throw new ServiceUnavailableException(
        `Vizyo Auth est injoignable : ${operation} n'a pas pu aboutir. ${consequence} Motif technique : ${motif}.`,
      );
    }
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

    const res = await this.appelerVizyoAuth(
      url,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      `l'appel ${method} ${path}`,
      "La session de l'utilisateur ne peut pas etre verifiee : il va etre deconnecte.",
    );

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
      `/v1/apps/${this.appInternalId}/users/${authUserId}/status`,
      { status: 'suspended' },
    );
  }

  async activateUser(authUserId: string): Promise<void> {
    return this.request<void>(
      'PATCH',
      `/v1/apps/${this.appInternalId}/users/${authUserId}/status`,
      { status: 'active' },
    );
  }

  async removeUserFromApp(authUserId: string): Promise<void> {
    // Body explicite {} pour que la signature HMAC (calculee sur JSON.stringify(body))
    // corresponde au body reellement envoye dans la requete fetch.
    return this.request<void>(
      'DELETE',
      `/v1/apps/${this.appInternalId}/users/${authUserId}`,
      {},
    );
  }

  async listAppUsers(): Promise<Array<{ id: string; email: string; displayName: string | null; status: string; createdAt: string }>> {
    try {
      const result = await this.request<{ users: Array<{ id: string; email: string; displayName: string | null; status: string; createdAt: string }> }>(
        'GET',
        `/v1/apps/${this.appInternalId}/users`,
      );
      return result.users ?? [];
    } catch (err) {
      // Repli volontaire sur une liste vide : cette methode alimente un ecran
      // d'appoint, elle ne doit pas faire echouer la requete appelante.
      // ⚠️ Mais un echec DOIT rester visible : c'est ce `catch` muet qui a
      // masque pendant des mois le 403 « publicId dans le chemin » — l'ecran
      // affichait « aucun utilisateur » au lieu de signaler une erreur.
      this.logger.error(
        `listAppUsers a échoué — retour d'une liste VIDE (ce n'est PAS « aucun utilisateur »): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
    // Le JUMEAU de `request()` : meme angle mort, meme correctif. Un defaut corrige d'un seul
    // cote revient toujours par l'autre (lecon de TRK-004).
    const res = await this.appelerVizyoAuth(
      url,
      { method: 'POST', headers: this.signHeaders(body), body: JSON.stringify(body) },
      "la verification du code recu par e-mail",
      "Le code n'a pas pu etre verifie : il faut reessayer dans un instant.",
    );
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
