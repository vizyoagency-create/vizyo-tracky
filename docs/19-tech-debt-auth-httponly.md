# Dette technique : JWT en localStorage → httpOnly cookies

**Date** : 2026-05-20 (Sprint 5 stabilite)
**Severite** : 🟠 Haute (sécurité)
**Effort estimé** : 2-3 jours (full-stack + déploiement)

## Le problème

Aujourd'hui, le JWT d'accès et le refresh token sont stockés en `localStorage` :

```ts
// apps/web/src/app/core/services/auth.service.ts:11-34
localStorage.setItem(TOKEN_KEY, token);
```

`localStorage` est **lisible par tout script JavaScript** qui s'exécute dans le contexte de l'origine. Donc :

- Une faille XSS (ex: injection via un champ texte mal échappé, dependency compromise, extension navigateur malveillante) suffit à exfiltrer le token.
- Aucune contre-mesure côté serveur ne peut empêcher ça — la défense doit être en profondeur.
- Le PWA service worker peut lire localStorage, multipliant les surfaces.

## Le fix recommandé

Migrer vers des **cookies `Secure` + `HttpOnly` + `SameSite=Lax`** posés par le backend :

1. **Backend (`apps/api`)** :
   - Endpoint `/auth/login` : au lieu de retourner `{token, refreshToken}` dans le body, poser deux cookies via `res.cookie()`.
   - Endpoint `/auth/refresh` : lire `refresh_token` du cookie, regénérer, re-poser.
   - Endpoint `/auth/logout` : `res.clearCookie()`.
   - Ajouter `withCredentials: true` côté CORS config.
   - Middleware lit le cookie au lieu du header `Authorization`.

2. **Frontend (`apps/web`)** :
   - `auth.interceptor.ts` : retirer le `setHeaders.Authorization`. Les cookies sont envoyés automatiquement avec `withCredentials: true`.
   - `auth.service.ts` : retirer `localStorage.setItem/getItem(TOKEN_KEY)`. Le token n'est plus accessible en JS — un getter `isAuthenticated()` se base sur l'expiration d'un cookie *non-httpOnly* compagnon (`session_active`) ou sur une route `/auth/me`.
   - Multi-tab logout sync : déjà géré par le navigateur (cookies partagés).

3. **Déploiement** :
   - Backend en HTTPS strict (déjà OK en prod).
   - `SameSite=Lax` suffit si frontend et backend partagent le même domaine racine. Si CDN/sous-domaine différent, passer en `SameSite=None; Secure` + protection CSRF (token CSRF custom, ou double-submit cookie).
   - Vérifier que l'API ne lit pas le JWT depuis le body / query (pas de fallback dangereux).
   - Tester la rotation du refresh token (le navigateur doit accepter le nouveau cookie sans souci).

## Effets de bord à valider

- Service Worker `ngsw-worker` : les requêtes initiées depuis le SW envoient les cookies. OK.
- Push subscription endpoints (`POST /api/notifications/push/subscribe`) : doivent être authentifiés. OK, cookies envoyés.
- Tests E2E Playwright : ajouter `context.setExtraHTTPHeaders` ou utiliser `context.addCookies` pour les fixtures de login.

## Pourquoi pas dans Sprint 5

Le sprint 5 visait des fixes de stabilité **sans casser l'authentification existante**. Migrer le mode de transport du JWT touche :

- Tous les endpoints API (lecture du token).
- Tous les services frontend qui auraient besoin du token (très peu en réalité — c'est l'interceptor qui le fait).
- La config CORS (potentiellement les variables d'env).
- Les tests E2E (login fixture).
- La doc deployment (HTTPS strict, SameSite).

C'est un sprint dédié, à planifier prioritaire dans le prochain trimestre. En attendant, garder un **CSP strict** (déjà en place ?) limite la fenêtre XSS exploitable.

## Checklist avant le sprint dédié

- [ ] Audit XSS du frontend (DOMPurify sur les inputs HTML, échappement Angular natif vérifié partout).
- [ ] Audit CSP du backend (Helmet, headers).
- [ ] Vérifier que toutes les requêtes API passent par `auth.interceptor` (pas de fetch direct qui set Authorization manuellement).
- [ ] Documenter les routes publiques (sans cookie) — `/auth/login`, `/auth/register`, `/health`, etc.
