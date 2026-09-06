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

  /**
   * Le dernier rafraîchissement a-t-il échoué parce que le SERVEUR était injoignable ?
   *
   * ⚠️ POURQUOI CE DRAPEAU EXISTE (constat du 2026-08-03). `tryRefresh()` renvoyait `null`
   * dans DEUX situations que rien ne distinguait :
   *
   *   - le jeton est refusé (401/403) — définitif, il FAUT déconnecter ;
   *   - le serveur ne répond pas (5xx, réseau coupé) — temporaire, la session est
   *     parfaitement valide.
   *
   * L'intercepteur lisait ce `null` comme un refus et déconnectait dans les deux cas.
   * Conséquence observée deux fois dans la même journée : CHAQUE redéploiement de l'API
   * éjectait les utilisateurs connectés, le temps du redémarrage. Un simple hoquet de wifi
   * produisait le même effet.
   *
   * C'est le motif corrigé partout ailleurs aujourd'hui : deux situations différentes
   * traitées à l'identique, et c'est la plus grave qui l'emporte à tort.
   *
   * ⚠️ Un drapeau plutôt qu'un changement de signature : `tryRefresh()` a CINQ appelants
   * (intercepteur, refresh proactif, trois chemins du temps réel). Élargir son type les
   * aurait tous forcés à traiter un cas qui ne concerne que la décision de déconnecter.
   */
  private readonly _refreshUnavailable = signal(false);
  readonly refreshUnavailable = this._refreshUnavailable.asReadonly();

  private readonly _user = signal<AuthUser | null>(this.loadUser());
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());
  /** Sprint 3 — true si l'utilisateur courant est un veilleur de nuit (rôle restreint NIGHT_WATCHMAN). */
  readonly isWatchman = computed(() => this._user()?.role === 'NIGHT_WATCHMAN');
  /** feat/comptes-conducteurs — true si l'utilisateur courant est un conducteur (rôle restreint DRIVER). */
  readonly isDriver = computed(() => this._user()?.role === 'DRIVER');
  /**
   * Espace dépôt (2026-08) — true si l'utilisateur courant est un compte dépôt.
   * Rôle LATÉRAL : il ne se compare pas aux autres, il vit dans `/depot` et nulle part
   * ailleurs. Cosmétique côté client ; le vrai périmètre est garanti serveur (403).
   */
  readonly isDepot = computed(() => this._user()?.role === 'DEPOT');
  private refreshPromise: Promise<string | null> | null = null;
  /**
   * Délai avant le second essai du rafraîchissement proactif (TRK-002). Un appareil qui se
   * réveille rétablit sa route en bien moins que ça ; assez court pour ne pas retarder la
   * détection d'une vraie panne.
   */
  private static readonly PROACTIVE_RETRY_MS = 3_000;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * La marge avant expiration : on renouvelle 60 s avant l'échéance, jamais à la seconde.
   *
   * ⚠️ NOMMÉE, parce que DEUX endroits doivent s'accorder — la programmation du minuteur et
   * le contrôle au retour au premier plan. Deux littéraux auraient fini par diverger, et le
   * second serait devenu soit bavard (il renouvellerait trop tôt), soit inutile (trop tard).
   */
  private static readonly MARGE_EXPIRATION_MS = 60_000;

  constructor() {
    // « Rester connecté » — refresh PROACTIF : on renouvelle l'access token AVANT
    // son expiration (toutes les ~15 min), pour ne JAMAIS bouncer l'utilisateur en
    // pleine action (fix « on se reconnecte tout le temps »).
    if (this.token) this.scheduleProactiveRefresh();
    this.surveillerLeRetourAuPremierPlan();
  }

  /**
   * ── LE MINUTEUR NE SUFFIT PAS : IL DORT QUAND L'ONGLET DORT ──────────────────────────
   *
   * `proactiveTick` explique déjà (TRK-002) qu'un `setTimeout` est GELÉ en arrière-plan.
   * Ce qui manquait, c'est la conséquence : au retour, il se déclenche EN RETARD, et
   * l'application a déjà eu le temps de partir avec un jeton mort. Le cas n'a rien
   * d'exotique — c'est le geste le plus banal du mobile : on verrouille son téléphone, on
   * le rouvre vingt minutes plus tard, la page reprend et lance ses requêtes.
   *
   * Le rattrapage par 401 existe (l'intercepteur renouvelle puis rejoue), mais il arrive
   * APRÈS l'échec : dans le meilleur des cas quelques requêtes perdues et un écran qui
   * clignote, dans le pire une déconnexion si le renouvellement rate à ce moment-là.
   *
   * On contrôle donc au moment précis où l'onglet redevient visible, AVANT que la page ne
   * reparle. Et seulement si le jeton est effectivement à bout de course : sans ce garde,
   * chaque va-et-vient entre deux onglets déclencherait un appel réseau.
   *
   * ⚠️ Aucune déconnexion ici, jamais. Si le renouvellement échoue, `proactiveTick` s'arrête
   * et laisse un 401 ultérieur trancher — un réseau encore endormi au réveil de l'appareil
   * ne doit pas coûter sa session à l'utilisateur.
   */
  private surveillerLeRetourAuPremierPlan(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Déconnecté, ou sans de quoi renouveler : rien à faire.
      if (!this.token || !this.refreshToken) return;
      if (!this.jetonEnFinDeVie()) {
        // Le jeton tient encore : on reprogramme simplement le minuteur, qui a pu dériver
        // pendant le sommeil de l'onglet.
        this.scheduleProactiveRefresh();
        return;
      }
      void this.proactiveTick();
    });
  }

  /** Le jeton d'accès est-il expiré, ou sur le point de l'être ? */
  private jetonEnFinDeVie(): boolean {
    const token = this.token;
    if (!token) return false;
    const exp = this.tokenExp(token);
    // Un jeton dont on ne sait pas lire l'échéance n'est pas déclaré mourant : on ne
    // renouvelle pas dans le vide à chaque retour d'onglet.
    if (!exp) return false;
    return exp * 1000 - Date.now() < AuthService.MARGE_EXPIRATION_MS;
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

  /**
   * Tente un refresh du token. Retourne le nouveau accessToken ou null si échec.
   *
   * `silentNetworkFailure` : ne pas remonter un échec de transport au centre d'alerte sur
   * cette tentative — réservé au premier essai du rafraîchissement PROACTIF, qui réessaie
   * (TRK-002).
   */
  async tryRefresh(opts?: { silentNetworkFailure?: boolean }): Promise<string | null> {
    // Éviter les refreshs en parallèle
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh(opts?.silentNetworkFailure === true);
    const result = await this.refreshPromise;
    this.refreshPromise = null;
    return result;
  }

  private async doRefresh(silentNetworkFailure = false): Promise<string | null> {
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
      }, 'Rafraichissement de session', { silentNetworkFailure });

      if (!res.ok) {
        // ⚠️ UN SERVEUR INJOIGNABLE N'EST PAS UN JETON REFUSÉ.
        //
        // 5xx = l'API redémarre ou la passerelle ne répond pas. La session est parfaitement
        // valide ; il n'y a aucune raison de déconnecter. Seuls 401/403 disent réellement
        // « ce jeton n'est plus accepté ».
        this._refreshUnavailable.set(res.status === 0 || res.status >= 500);
        return null;
      }

      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      this.updateToken(data.accessToken, data.refreshToken);
      this._refreshUnavailable.set(false);
      return data.accessToken;
    } catch (err) {
      // Réseau coupé, DNS, API injoignable : `apiFetchRaw` jette avant toute réponse.
      // Même raisonnement — on ne déconnecte pas quelqu'un parce que le wifi a hoqueté.
      this._refreshUnavailable.set(true);
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
    // Marge partagée avec le contrôle au retour au premier plan (cf. `MARGE_EXPIRATION_MS`),
    // plancher 5 s (évite une boucle serrée si le token est déjà court/expiré).
    const delay = Math.max(5_000, msUntilExpiry - AuthService.MARGE_EXPIRATION_MS);
    this.refreshTimer = setTimeout(() => {
      void this.proactiveTick();
    }, delay);
  }

  private async proactiveTick(): Promise<void> {
    // TRK-002 — CE MINUTEUR EST LA SOURCE DU BRUIT, ET IL FAUT SAVOIR POURQUOI.
    //
    // Un `setTimeout` est GELÉ quand l'onglet passe en arrière-plan ou que l'appareil dort,
    // puis tiré AU RÉVEIL — c'est-à-dire à l'instant précis où la connectivité n'est pas
    // encore rétablie. Le rafraîchissement part dans le vide et échoue au niveau transport.
    //
    // Personne ne perd sa session pour autant (`doRefresh` ne déconnecte pas sur un échec
    // réseau), mais chaque réveil laissait une ligne ERREUR au centre d'alerte. On laisse
    // donc sa chance au réseau : premier essai SILENCIEUX, un délai, puis un second essai
    // qui, lui, remonte normalement. Un vrai serveur injoignable produit toujours sa ligne.
    let token = await this.tryRefresh({ silentNetworkFailure: true });

    if (!token && this._refreshUnavailable()) {
      await new Promise((resolve) => setTimeout(resolve, AuthService.PROACTIVE_RETRY_MS));
      token = await this.tryRefresh();
    }

    if (token) {
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
