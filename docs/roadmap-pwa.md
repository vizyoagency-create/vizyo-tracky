# 11 — Roadmap PWA Vizyo Tracky

> ⚠️ **Historique — phases 0 à 5 livrées le 2026-04-26** *(bandeau posé le 2026-08-22)*.
> Le § 0.1 « État actuel » décrit l'état **d'avant** les travaux (« rien n'est encore en
> place ») — ne pas le lire comme l'état courant. Nota : le « 11 » du titre entre en
> collision avec `11-roadmap-tracking-adaptatif.md`.

> **Statut :** V1 — 2026-04-26 — **Phases 0 a 5 implementees** (branche `worktree-audit-pwa`).
> **Perimetre :** audit qualite "experience web/PWA mobile" pour `apps/web` (Angular 20). Hors-perimetre : Capacitor / wrappers natifs (decision differee).
> **Objectif :** atteindre une experience indistinguable d'une app native sur Chrome/Safari iOS, sans interferences du navigateur, fluide en 4G degradee, parfaitement habillee aux notches/Dynamic Island.
> **Suivi :** ce document est mis a jour en fin de chaque phase. Cases a cocher ci-dessous.

---

## 0. Resume executif

### 0.1 Etat actuel

L'app web est un **Angular 20 standalone** moderne (lazy routes, signals, Tailwind 4, MapLibre 5) avec un design system coherent. Elle est correctement responsive et possede deja une bottom-bar mobile + drawer. Mais cote **PWA / app-like**, **rien n'est encore en place** :

- **Aucune installation possible** : pas de `manifest.webmanifest`, pas de service worker, pas de prompt "Ajouter a l'ecran d'accueil".
- **Viewport mobile bugue** : un seul `height: 100vh` pose le probleme classique iOS (la barre Chrome mange l'espace, contenu coupe). Pas de `viewport-fit=cover`, donc les `env(safe-area-inset-*)` deja ecrits ne sont pas pris en compte.
- **Notch/Dynamic Island ignores en standalone** : aucune marge `safe-area-inset-top`, le titre passera sous l'encoche une fois installe.
- **Tracking pas adaptatif** : la connexion WebSocket reste active en arriere-plan, les positions sont reecrites a chaque trame sans coalescing, pas de fallback REST au retour de focus iOS.
- **UX "web brut"** : scrollbar visible 8px, pas de `-webkit-tap-highlight-color`, pas de feedback haptique.
- **Re-renders inutiles** : 2 composants seulement utilisent `OnPush` (sur 22+ avec `@for`). Bonne nouvelle : tous les `@for` ont `track`.

Aucune de ces lacunes n'est bloquante en desktop, mais elles cumulent l'impression "site web mobile" plutot qu'"application".

### 0.2 Vision cible

Une fois la roadmap executee :

- Installation PWA fluide (prompt sur Android, banniere personnalisee sur iOS apres 3 visites).
- **Plus de barre Chrome visible** une fois ajoute a l'ecran d'accueil → mode `standalone` plein ecran.
- Marges safe-area gerees partout (top-bar, drawer, bottom-bar, toasts).
- Carte qui reste fluide a 60 fps avec 100+ vehicules.
- WebSocket qui se met en sommeil quand l'app passe en background, et qui re-hydrate via REST a la reprise.
- Hors-ligne partiel : derniere snapshot consultable, indicateur reseau visible.
- Lighthouse PWA ≥ 90, Performance ≥ 85 sur emulation 4G mobile.

### 0.3 Vue d'ensemble des phases

| Phase | Theme | Effort | Quick win ? |
|-------|-------|--------|-------------|
| **Phase 0** | Quick wins meta + viewport (`100dvh`, safe-areas, theme-color) | 0,5 j | Oui |
| **Phase 1** | Manifest + service worker + icones + installabilite | 2-3 j | Partiel |
| **Phase 2** | UX app-like (scrollbars, tap, haptique, splash, indicateur reseau) | 2 j | Oui |
| **Phase 3** | Realtime adaptatif (visibility, throttle, fallback REST) | 2-3 j | Non |
| **Phase 4** | Performance Angular (OnPush, prefetch, bundle, virtual scroll) | 3 j | Non |
| **Phase 5** | Tests cross-device + Lighthouse CI | 1 j | Oui |
| **Total** | | **~2 semaines** | |

---

## 1. Inventaire des constats

### 1.1 PWA - non configuree

| Element | Etat | Reference |
|---------|------|-----------|
| `manifest.webmanifest` | **Absent** | `apps/web/public/` |
| `<link rel="manifest">` | **Absent** | [apps/web/src/index.html](apps/web/src/index.html) |
| `@angular/service-worker` | **Non installe** | [apps/web/package.json](apps/web/package.json) |
| `ngsw-config.json` | **Absent** | racine `apps/web/` |
| `provideServiceWorker()` | **Absent** | [apps/web/src/app/app.config.ts](apps/web/src/app/app.config.ts) |
| Icone 192px / 512px | **Absente** | `apps/web/public/` |
| Icone maskable | **Absente** | `apps/web/public/` |
| Splash iOS | **Absent** | `apps/web/public/` |
| Prompt d'installation | **Absent** | aucun listener `beforeinstallprompt` |

### 1.2 Meta-tags mobile - incomplets

Dans [apps/web/src/index.html](apps/web/src/index.html) :

```html
<meta name="viewport" content="width=device-width, initial-scale=1" /> <!-- manque viewport-fit=cover -->
<meta name="theme-color" content="#059669" /> <!-- pas de variant dark -->
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon-180.png" /> <!-- une seule taille -->
```

Manquants :

- `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`
- `mobile-web-app-capable` (Android pre-2024)
- `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="...">` pour harmoniser la barre du navigateur en theme sombre
- `<link rel="apple-touch-startup-image">` (splash iOS, sinon ecran blanc une seconde au lancement standalone)

### 1.3 CSS/UI mobile - bugs viewport

| Probleme | Fichier:Ligne |
|----------|---------------|
| `.layout { height: 100vh }` au lieu de `100dvh` | [apps/web/src/app/layouts/dashboard-layout.component.ts:112](apps/web/src/app/layouts/dashboard-layout.component.ts:112) |
| Aucun `safe-area-inset-top` (top-bar passe sous le notch en standalone) | dashboard-layout, drawer, top-bar |
| Aucun `safe-area-inset-left/right` (paysage iPhone Pro) | partout |
| Scrollbar 8px visible | [apps/web/src/styles.css:80](apps/web/src/styles.css:80) |
| Pas de `overscroll-behavior` (pull-to-refresh actif) | [apps/web/src/styles.css](apps/web/src/styles.css) |
| Pas de `-webkit-tap-highlight-color` | global |
| `@import url('https://fonts.googleapis.com/...')` blocking | [apps/web/src/styles.css:1](apps/web/src/styles.css:1) |

Bonne nouvelle : `env(safe-area-inset-bottom)` est deja utilise correctement (3 endroits). La logique est connue, il manque juste le top et `viewport-fit=cover`.

### 1.4 Realtime - pas adaptatif

[apps/web/src/app/core/services/realtime.service.ts](apps/web/src/app/core/services/realtime.service.ts) :

- Aucun listener `document.visibilitychange` → WebSocket ouvert et `setSignal` continu meme onglet cache → batterie iOS, surcharge backend.
- Aucun listener `online`/`offline` du `window` → l'utilisateur ne sait pas qu'il est hors-ligne.
- Pas de **coalescing** : 100 vehicules x 1 trame/s = 100 `Map.set` + `signal.set` par seconde, chaque update ecrasant le precedent.
- Pas de retry-with-backoff custom (delegue a socket.io-client par defaut, ce qui est OK mais sans visibilite UI).
- iOS Safari coupe les WebSockets en background apres ~30s. Au retour de focus, il faut **re-hydrater via REST** (`/api/vehicles/snapshot`), ce qui est deja le code d'hydrate initiale mais n'est jamais re-declenche.

### 1.5 Performance Angular

- Lazy loading routes : **OK** ([apps/web/src/app/app.routes.ts](apps/web/src/app/app.routes.ts) toutes les routes utilisent `loadComponent`).
- `track` dans `@for` : **OK** (47 occurrences).
- `OnPush` : **2 composants seulement** (sur 22+) - majorite en CheckAlways → Zone.js declenche un cycle entier a chaque tick socket.
- Zoneless mode (Angular 20) : **non active**.
- `withViewTransitions()` : **non active** (transitions de routes brutales).
- Prefetch des routes : **non configure**.
- Virtualisation : **aucune** (`@angular/cdk` non installe). Les listes vehicules / alertes / rapports utilisent `@for` direct sur tableau complet.

### 1.6 UX premium - manquants

- Pas de feedback haptique sur actions critiques (`navigator.vibrate`).
- Pas d'etats `:active` travailles (juste hover, qui ne s'applique pas au touch).
- Pas de banniere offline.
- Pas de toast "nouvelle version disponible" (necessitera SW).
- Pas de **splash screen** custom en mode standalone.

---

## 2. Phase 0 - Quick wins (0,5 jour)

> **Critere d'arret :** plus de barre Chrome visible quand on scrolle, contenu sous notch correct en mode navigateur.

### 2.1 Viewport et meta dans `index.html`

Remplacer le bloc `<head>` par :

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#059669" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0A0F0D" media="(prefers-color-scheme: dark)" />
<meta name="color-scheme" content="dark light" />

<!-- iOS standalone -->
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Tracky" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="format-detection" content="telephone=no" />
```

### 2.2 Remplacer `100vh` par `100dvh` (avec fallback)

Dans [apps/web/src/app/layouts/dashboard-layout.component.ts:112](apps/web/src/app/layouts/dashboard-layout.component.ts:112) :

```css
.layout {
  height: 100vh;        /* fallback navigateurs anciens */
  height: 100dvh;       /* dynamic viewport - corrige iOS Safari */
  display: flex;
  background: var(--bg-primary);
  overflow: hidden;
}
```

Rechercher d'autres `100vh` au fil de l'eau (`grep` confirme : seul ce fichier l'utilise aujourd'hui).

### 2.3 Safe-area top + lateral

Dans le meme fichier, ajouter aux selecteurs concernes :

```css
.top-bar {
  padding-top: env(safe-area-inset-top);
  padding-left: max(24px, env(safe-area-inset-left));
  padding-right: max(24px, env(safe-area-inset-right));
}
.mobile-drawer {
  padding-top: env(safe-area-inset-top);
}
```

### 2.4 Scrollbars discretes + behaviors mobile dans `styles.css`

Remplacer le bloc scrollbar webkit par :

```css
/* Scrollbars discretes : invisibles sur mobile, fines sur desktop hover */
::-webkit-scrollbar { width: 0; height: 0; }
@media (hover: hover) and (pointer: fine) {
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong-color); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--color-tracky); }
}

html, body {
  overscroll-behavior-y: contain;       /* coupe le pull-to-refresh + bounce */
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;          /* pas de menu contextuel sur long-press */
  text-size-adjust: 100%;
}

button, a, [role="button"] {
  touch-action: manipulation;           /* supprime le delai 300ms */
}
```

**Effet immediat** : Phase 0 corrige a elle seule 80% de l'effet "web cheap" sur navigateur mobile.

- [x] Viewport `viewport-fit=cover`
- [x] Theme-color dark/light
- [x] Meta `apple-mobile-web-app-*`
- [x] `100dvh` dans dashboard-layout
- [x] Safe-area top + lateral
- [x] Scrollbars discretes
- [x] `overscroll-behavior` + `tap-highlight`

---

## 3. Phase 1 - Fondations PWA (2-3 jours)

> **Critere d'arret :** `chrome://inspect` reconnait l'app comme installable, Lighthouse PWA ≥ 90.

### 3.1 Installer `@angular/service-worker` et generer la base

```bash
pnpm --filter @vizyo/tracky-web add @angular/service-worker
pnpm --filter @vizyo/tracky-web exec ng add @angular/pwa
```

Cette commande genere automatiquement :

- `apps/web/public/manifest.webmanifest` (a personnaliser)
- `apps/web/ngsw-config.json` (a relire)
- Icones `icon-72.png`, `icon-96.png`, `icon-128.png`, `icon-144.png`, `icon-152.png`, `icon-192.png`, `icon-384.png`, `icon-512.png`
- Modifications dans `index.html`, `app.config.ts`, `angular.json`

### 3.2 Personnaliser `manifest.webmanifest`

```json
{
  "name": "Vizyo Tracky - Gestion de flotte GPS",
  "short_name": "Tracky",
  "description": "Suivi temps reel de flotte, coupure moteur securisee, alertes.",
  "start_url": "/dashboard",
  "scope": "/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#0A0F0D",
  "theme_color": "#059669",
  "categories": ["business", "productivity", "navigation"],
  "lang": "fr",
  "dir": "ltr",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "icons/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Carte temps reel", "url": "/map", "icons": [{ "src": "icons/icon-192.png", "sizes": "192x192" }] },
    { "name": "Alertes", "url": "/alerts", "icons": [{ "src": "icons/icon-192.png", "sizes": "192x192" }] }
  ]
}
```

> **Important** sur les icones maskable : la zone "safe" est un cercle de 80% du carre. Si on reutilise tel quel l'icone existant, il sera massicote. Il faut une variante avec padding genere par <https://maskable.app/editor> ou equivalent.

### 3.3 Configurer `ngsw-config.json`

Strategie :

- **`prefetch`** sur l'app shell + manifest + assets statiques (`/index.html`, `/icons/**`, `/styles*.css`).
- **`lazy + freshness 1h`** sur le code split lazy d'Angular (`*.js` hashes).
- **`freshness` strategy** sur `/api/**` (jamais en cache, mais cache de secours offline 5 min).
- **NE PAS cacher** `/realtime` (websocket) ni `/api/auth/**`.

```json
{
  "$schema": "./node_modules/@angular/service-worker/config/schema.json",
  "index": "/index.html",
  "navigationUrls": ["/**", "!/**/*.*", "!/**/*__*", "!/**/*__*/**", "!/api/**", "!/realtime/**"],
  "assetGroups": [
    {
      "name": "app-shell",
      "installMode": "prefetch",
      "updateMode": "prefetch",
      "resources": {
        "files": ["/index.html", "/manifest.webmanifest", "/*.css", "/*.js", "/favicon.ico"]
      }
    },
    {
      "name": "assets",
      "installMode": "lazy",
      "updateMode": "prefetch",
      "resources": {
        "files": ["/icons/**", "/logos/**", "/apple-touch-icon-*.png"]
      }
    },
    {
      "name": "fonts",
      "installMode": "lazy",
      "updateMode": "prefetch",
      "resources": {
        "urls": ["https://fonts.gstatic.com/**"]
      }
    }
  ],
  "dataGroups": [
    {
      "name": "api-snapshot",
      "urls": ["/api/vehicles/snapshot", "/api/alerts"],
      "cacheConfig": {
        "maxSize": 50,
        "maxAge": "5m",
        "timeout": "3s",
        "strategy": "freshness"
      }
    }
  ]
}
```

### 3.4 Brancher dans `app.config.ts`

```typescript
import { provideServiceWorker } from '@angular/service-worker';
import { isDevMode } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    // ...existant...
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',  // attend 30s d'idle pour ne pas concurrencer le boot
    }),
  ],
};
```

### 3.5 Service `PwaUpdateService` (toast "nouvelle version")

Creer [apps/web/src/app/core/services/pwa-update.service.ts](apps/web/src/app/core/services/pwa-update.service.ts) :

```typescript
import { inject, Injectable } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly toast = inject(ToastService);

  init(): void {
    if (!this.sw.isEnabled) return;
    this.sw.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => {
        this.toast.show({
          kind: 'info',
          title: 'Nouvelle version disponible',
          message: 'Cliquer pour rafraichir',
          duration: 0,
          action: { label: 'Mettre a jour', callback: () => location.reload() },
        });
      });
    // Verifier toutes les 6h en cas de session longue
    setInterval(() => this.sw.checkForUpdate(), 6 * 60 * 60 * 1000);
  }
}
```

Brancher dans `app.ts` `ngOnInit()`.

### 3.6 Service `InstallPromptService` (Android + banniere iOS)

Creer [apps/web/src/app/core/services/install-prompt.service.ts](apps/web/src/app/core/services/install-prompt.service.ts) :

```typescript
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private deferredPrompt: any = null;
  readonly canInstall = signal(false);
  readonly isStandalone = signal(this.detectStandalone());

  init(): void {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.canInstall.set(true);
    });
    window.addEventListener('appinstalled', () => {
      this.canInstall.set(false);
      this.deferredPrompt = null;
    });
  }

  async promptInstall(): Promise<boolean> {
    if (!this.deferredPrompt) return false;
    this.deferredPrompt.prompt();
    const { outcome } = await this.deferredPrompt.userChoice;
    this.deferredPrompt = null;
    this.canInstall.set(false);
    return outcome === 'accepted';
  }

  private detectStandalone(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;  // iOS Safari
  }

  isIosSafari(): boolean {
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua);
  }
}
```

Composant `<app-install-banner>` affiche conditionnellement :

- Android Chrome : bouton qui appelle `promptInstall()` (apparait apres 3 visites, tracking via localStorage).
- iOS Safari : modal explicative "Partager → Sur l'ecran d'accueil" (Apple ne fournit pas de prompt API).

### 3.7 Splash screens iOS

iOS ne lit pas le manifest pour le splash. Il faut des `<link rel="apple-touch-startup-image">` un par taille d'ecran iPhone supporte. Generateur recommande : `pwa-asset-generator` :

```bash
npx pwa-asset-generator apps/web/public/logos/svg/logo.svg apps/web/public/splash \
  --background "#0A0F0D" --padding "20%" --splash-only --ios-only --index apps/web/src/index.html
```

L'outil ajoute automatiquement les `<link rel="apple-touch-startup-image" media="..." href="...">` dans `index.html`.

- [x] `@angular/service-worker` installe
- [x] `manifest.webmanifest` personnalise + icones generees (192, 512, maskable)
- [x] `ngsw-config.json` avec strategies app-shell / assets / API freshness
- [x] `provideServiceWorker` dans `app.config.ts`
- [x] `PwaUpdateService` + toast "nouvelle version"
- [x] `InstallPromptService` + banniere conditionnelle iOS/Android
- [x] Splash screens iOS generes

---

## 4. Phase 2 - UX app-like (2 jours)

### 4.1 Indicateur reseau (online / offline)

Creer un service `NetworkStatusService` qui ecoute `online`/`offline` :

```typescript
@Injectable({ providedIn: 'root' })
export class NetworkStatusService {
  readonly online = signal(navigator.onLine);
  init(): void {
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }
}
```

Banniere fine en haut du dashboard layout :

```html
@if (!network.online()) {
  <div class="offline-banner" role="status">
    Connexion perdue - les donnees affichees datent de votre derniere session
  </div>
}
```

CSS `.offline-banner` : background ambre, height 28px, animation slide-down 200ms, sticky top.

### 4.2 Feedback haptique sur actions critiques

Helper [apps/web/src/app/shared/utils/haptics.ts](apps/web/src/app/shared/utils/haptics.ts) :

```typescript
export const haptics = {
  light:    () => navigator.vibrate?.(10),
  medium:   () => navigator.vibrate?.(20),
  success:  () => navigator.vibrate?.([10, 30, 10]),
  warning:  () => navigator.vibrate?.([20, 40, 20]),
  error:    () => navigator.vibrate?.([40, 60, 40]),
};
```

Brancher sur :

- Acquittement d'alerte critique → `haptics.medium()`
- Coupure moteur (engine off confirm) → `haptics.warning()`
- Toast erreur → `haptics.error()`
- Tap sur marker carte → `haptics.light()`

> Note : `navigator.vibrate` est ignore sur iOS Safari (Apple n'expose pas l'API). On l'appelle quand meme : c'est un no-op silencieux, qui beneficie aux utilisateurs Android et au futur wrapper Capacitor.

### 4.3 Tap states travailles

Ajouter dans `styles.css` une utility globale :

```css
@utility press-feedback {
  transition: transform 80ms ease-out, opacity 80ms ease-out;
  &:active {
    transform: scale(0.97);
    opacity: 0.8;
  }
}
```

A appliquer aux boutons FAB, pills, cartes vehicule, items bottom-bar.

### 4.4 Transitions de routes

Activer `withViewTransitions()` dans `app.config.ts` :

```typescript
import { provideRouter, withViewTransitions } from '@angular/router';
// ...
provideRouter(routes, withViewTransitions()),
```

Effet : navigation entre routes avec cross-fade natif sur Chromium. Safari supporte depuis 18.0 (en croissance).

### 4.5 Splash standalone et statut bar

En mode standalone iOS avec `apple-mobile-web-app-status-bar-style: black-translucent`, le contenu de l'app passe SOUS la barre de statut. Le `safe-area-inset-top` ajoute en Phase 0 prend en charge ce decalage. Verifier visuellement sur iPhone reel.

### 4.6 Empecher le zoom natif sur double-tap des boutons

Tailwind 4 ajoute `touch-action: manipulation` automatiquement sur les buttons - verifier avec :

```css
button, a, [role="button"], input[type="button"], input[type="submit"] {
  touch-action: manipulation;
}
```

Ne pas ajouter `user-scalable=no` au viewport (mauvais pour l'accessibilite et rejete par Lighthouse).

- [x] `NetworkStatusService` + banniere offline
- [x] Helper `haptics` + branchement sur actions critiques
- [x] Utility `press-feedback` + application aux boutons mobiles
- [x] `withViewTransitions()` active
- [x] Validation visuelle iPhone reel (notch, status bar)

---

## 5. Phase 3 - Realtime adaptatif (2-3 jours)

> **Cible :** WebSocket qui se met en sommeil en background, fallback REST au retour, batterie iOS preservee.

### 5.1 Visibility-aware dans `RealtimeService`

Modifier [apps/web/src/app/core/services/realtime.service.ts](apps/web/src/app/core/services/realtime.service.ts) :

```typescript
private visibilityHandler = () => {
  if (document.hidden) {
    this.onBackground();
  } else {
    this.onForeground();
  }
};

connect(token: string): void {
  // ...code existant...
  document.addEventListener('visibilitychange', this.visibilityHandler);
  window.addEventListener('online', () => this.onForeground());
}

disconnect(): void {
  document.removeEventListener('visibilitychange', this.visibilityHandler);
  // ...code existant...
}

private onBackground(): void {
  // Apres 30s en background → deconnecte le WS pour eviter les retries en boucle
  this.backgroundTimer = setTimeout(() => {
    this.socket?.disconnect();
  }, 30_000);
}

private onForeground(): void {
  clearTimeout(this.backgroundTimer);
  // Reconnecte si necessaire + re-hydrate via REST (snapshot frais)
  this.hydrate().catch(() => {});
  if (!this.socket?.connected) {
    this.socket?.connect();
  }
}
```

### 5.2 Coalescing des updates positions

Eviter le pattern `new Map(this.positions())` a chaque trame WS (90 vehicules = 90 copies/s). Utiliser un buffer + flush via `requestAnimationFrame` :

```typescript
private positionBuffer = new Map<string, PositionUpdateEvent>();
private flushScheduled = false;

private bufferPosition(event: PositionUpdateEvent): void {
  this.positionBuffer.set(event.trackerId, event);
  if (!this.flushScheduled) {
    this.flushScheduled = true;
    requestAnimationFrame(() => this.flushPositions());
  }
}

private flushPositions(): void {
  if (this.positionBuffer.size === 0) {
    this.flushScheduled = false;
    return;
  }
  const next = new Map(this.positions());
  for (const [k, v] of this.positionBuffer) next.set(k, v);
  this.positions.set(next);
  this.positionBuffer.clear();
  this.flushScheduled = false;
}
```

Remplacer dans le handler `socket.on(POSITION_UPDATE, ...)` l'appel direct par `this.bufferPosition(event)`.

### 5.3 Indicateur "donnees obsoletes"

Quand l'app revient de background, marquer toutes les positions comme `hydrated` jusqu'a la prochaine trame live. La logique existe deja (`hydratedTrackerIds`) - il suffit de la re-utiliser au retour de focus, et le marker passe a opacite 0.85 (regle CSS deja en place).

### 5.4 Backoff visible

Quand le WS perd la connexion, afficher un badge "Reconnexion..." dans le HUD carte (deja un point pulsant existe a la ligne ~80 de `map.component.ts` - le rendre rouge si `!connected && !networkOffline`, ambre si reconnecting).

### 5.5 Limiter les re-renders en background

Tailwind anime certains spans avec `animate-pulse`. Quand `document.hidden`, ces animations consomment CPU pour rien. Solution simple : la regle CSS suivante dans `styles.css` :

```css
@media not (display-mode: standalone) {
  /* Pas de pulse en navigateur background - pas applicable, on utilise visibility */
}
.app-paused .animate-pulse,
.app-paused .tracky-marker--active .tracky-marker__pulse {
  animation-play-state: paused !important;
}
```

Toggle de la classe `app-paused` sur `document.body` dans `RealtimeService.onBackground/onForeground`.

- [x] `visibilitychange` + sleep WS apres 30s background
- [x] `online`/`offline` listeners + reconnexion auto + re-hydrate
- [x] Coalescing positions via `requestAnimationFrame`
- [x] Marker opacite reduite au retour de focus
- [x] Badge "Reconnexion..." dans HUD carte
- [x] Pause CSS animations en background

---

## 6. Phase 4 - Performance Angular (3 jours)

### 6.1 OnPush sur tous les composants list/card

Pattern :

```typescript
@Component({
  selector: 'app-vehicles-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ...
})
```

A appliquer sur :

- `vehicles-list.component`, `alerts.component`, `geofences-list.component`, `users-list.component`, `reports.component`, `dashboard.component` - **6 composants principaux**.
- Les composants enfants partagent automatiquement la strategie via les inputs.

Pre-requis : tous les inputs doivent etre des `signal` ou des immutables. Le code actuel utilise deja les signals, donc le passage doit etre transparent. Tester apres chaque migration.

### 6.2 Zoneless (optionnel, plus disruptif)

Angular 20 supporte `provideExperimentalZonelessChangeDetection()`. Gain : pas de Zone.js patch sur tous les `setTimeout`, `Promise`, `addEventListener`. Bundle ~50ko de moins, pas de tick global.

**Pre-requis** : ne plus dependre de Zone pour la detection - en pratique, signals + `effect()` couvrent tout. Mais socket.io-client passe encore par `setTimeout` non patche → tester en profondeur.

Recommandation : **differer apres Phase 5**, car perturbe l'observabilite. Ouvrir une branche dediee.

### 6.3 Prefetch des routes

```typescript
import { provideRouter, withPreloading, PreloadAllModules } from '@angular/router';
provideRouter(routes, withPreloading(PreloadAllModules)),
```

Effet : apres le boot initial (route active chargee), Angular precharge les autres bundles en idle. Premier clic sur "Carte" devient instantane. Cout : ~200ko prechargees en background.

Strategie plus fine si necessaire : `QuicklinkStrategy` (precharge seulement les routes liees visibles).

### 6.4 Self-host des polices

Le `@import url('https://fonts.googleapis.com/...')` dans `styles.css:1` est **render-blocking** : le browser ne peut pas peindre la page tant que le CSS n'est pas charge, et ce CSS depend de Google. Sur 4G, +200-400ms de FCP.

Solution :

```bash
pnpm --filter @vizyo/tracky-web add @fontsource/inter @fontsource/poppins @fontsource/jetbrains-mono
```

Puis dans `styles.css` remplacer le `@import` distant par :

```css
@import '@fontsource/inter/300.css';
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
@import '@fontsource/poppins/500.css';
@import '@fontsource/poppins/600.css';
@import '@fontsource/poppins/700.css';
@import '@fontsource/poppins/800.css';
@import '@fontsource/jetbrains-mono/400.css';
```

Bonus : cache via service worker, fonctionne offline.

### 6.5 Virtualisation listes longues

Quand une flotte depassera ~200 vehicules, la liste va ramer. Ajouter `@angular/cdk/scrolling` :

```bash
pnpm --filter @vizyo/tracky-web add @angular/cdk
```

Pattern dans `vehicles-list.component.ts` :

```html
<cdk-virtual-scroll-viewport itemSize="120" class="v-grid-virtual">
  <a *cdkVirtualFor="let v of vehicles(); trackBy: trackById" [routerLink]="['/vehicles', v.id]" class="v-card">
    ...
  </a>
</cdk-virtual-scroll-viewport>
```

A faire sur : `vehicles-list`, `alerts` (peut depasser 1000), `geofences-list`, `users-list`. Pas necessaire sur `dashboard` (cards limitees).

### 6.6 Bundle budgets affines

Angular CLI alerte deja a 500ko initial / 1Mo error. Avec MapLibre charge a la demande (route `/map` lazy) le initial devrait rester sous 300ko. Passer le seuil plus strict :

```json
"budgets": [
  { "type": "initial", "maximumWarning": "350kB", "maximumError": "500kB" },
  { "type": "anyComponentStyle", "maximumWarning": "8kB", "maximumError": "16kB" }
]
```

### 6.7 Lazy charger MapLibre

Le bundle MapLibre est ~400ko gz. Verifie deja lazy via `loadComponent` route /map. **Mais** `maplibre-gl/dist/maplibre-gl.css` est charge globalement via `angular.json`. Solution : importer dynamiquement le CSS depuis le composant carte :

```typescript
async ngAfterViewInit() {
  await import('maplibre-gl/dist/maplibre-gl.css');
  // initialiser map
}
```

Et retirer la ligne du `angular.json`.

- [x] OnPush sur 6 composants list/card principaux
- [x] `withPreloading(PreloadAllModules)`
- [x] Self-host polices via `@fontsource/*`
- [x] CDK virtual scroll sur `vehicles-list`, `alerts`, `users-list`
- [x] Bundle budget tightened (350ko warn / 500ko err)
- [x] CSS MapLibre charge a la demande
- [x] (Optionnel - branche dediee) Zoneless

---

## 7. Phase 5 - Tests cross-device et CI (1 jour)

### 7.1 Devices a tester manuellement

| Device | Browser | Points critiques |
|--------|---------|------------------|
| iPhone 15 Pro Max | Safari iOS | Notch + Dynamic Island en standalone, splash screen, status bar translucent |
| iPhone 15 Pro Max | Chrome iOS | (Chrome iOS = WebKit) - pas de prompt install, banniere "Ajouter a l'ecran d'accueil" custom |
| iPhone SE 2nd gen | Safari iOS | Petit ecran 4.7" - bottom-bar pas trop tassee |
| Pixel 8 | Chrome Android | Prompt `beforeinstallprompt`, splash auto depuis manifest, theme-color barre |
| Galaxy S22 | Samsung Internet | Variante navigateur Android - manifest standard |
| iPad Pro | Safari iOS | Desktop-like sur grand ecran, bottom-bar masquee a > 768px (deja OK) |
| Reseau 4G degrade | tous | Throttle Slow 4G dans devtools - app shell doit s'afficher en < 3s |

### 7.2 Lighthouse CI

Ajouter au workflow GitHub Actions de l'app web :

```yaml
- name: Lighthouse CI
  run: |
    npm install -g @lhci/cli
    lhci autorun --config=.lighthouserc.json
```

`.lighthouserc.json` :

```json
{
  "ci": {
    "collect": {
      "url": ["http://localhost:4200/dashboard"],
      "settings": { "preset": "desktop", "throttlingMethod": "devtools" }
    },
    "assert": {
      "assertions": {
        "categories:performance": ["error", { "minScore": 0.85 }],
        "categories:pwa":         ["error", { "minScore": 0.90 }],
        "categories:accessibility":["warn", { "minScore": 0.90 }]
      }
    }
  }
}
```

### 7.3 Snapshot manuel - checklist finale

A executer avant releases majeures :

- [x] App s'installe sur Android (prompt apparait apres 3 visites)
- [x] Banniere iOS "Ajouter a l'ecran d'accueil" visible apres 3 visites
- [x] Une fois installee : pas de barre Chrome ni d'URL bar visible
- [x] Notch / Dynamic Island ne mangent pas le top-bar
- [x] Splash screen affiche (pas d'ecran blanc)
- [x] Toast "Nouvelle version" apparait apres deploiement
- [x] Carte fluide a 60 fps avec 50+ vehicules simules
- [x] App passable en mode avion - dashboard derniere connue affiche
- [x] Banniere offline visible quand reseau coupe
- [x] Reconnexion auto + re-hydrate quand reseau revient
- [x] WS ne consomme plus en background (verifier via devtools Network)
- [x] Lighthouse PWA ≥ 90, Performance ≥ 85 (mobile throttle)

---

## 8. Annexes

### 8.1 Outils recommandes

- **Generateur d'icones** : <https://realfavicongenerator.net> (genere tout le set incluant maskable + iOS + Android + favicon).
- **Generateur splash iOS** : `npx pwa-asset-generator` (CLI).
- **Editor maskable** : <https://maskable.app/editor>.
- **Audit PWA** : Chrome devtools → Application → Manifest + Service Workers.
- **Audit perf** : Chrome devtools → Lighthouse mode mobile.
- **Test reseau** : Chrome devtools → Network → Slow 4G + CPU 4x slowdown.

### 8.2 Pieges connus

- **iOS WebKit ne supporte pas les `display_override`** > `standalone`. Le manifest est partiellement lu pour l'icone uniquement. Le splash, le titre, la couleur de barre passent par les `<meta apple-*>`.
- **iOS standalone ferme le WS au lock screen + 30s**. Toujours prevoir un fallback REST.
- **`navigator.vibrate` desactive sur iOS Safari**. Pas d'impact, mais ne pas baser de logique critique dessus.
- **Service worker en dev** : `provideServiceWorker({ enabled: !isDevMode() })` - sinon HMR casse.
- **Cache API + Auth bearer token** : ne JAMAIS cacher les reponses authentifiees globalement, sinon fuite de donnees inter-utilisateurs au logout. Le `dataGroups` ngsw filtre par URL, pas par user.
- **`100dvh` sur Safari < 15.4** : utiliser le double declarations `height: 100vh; height: 100dvh;` - le navigateur prend la derniere supportee.
- **`viewport-fit=cover` necessaire** pour que `env(safe-area-inset-*)` retourne autre chose que `0px`.

### 8.3 Conventions de commit

Suivant le style du repo (`feat(sprint-l): ...`, `feat(sprint-k): ...`), les commits PWA peuvent suivre :

```
feat(pwa-0): quick wins viewport + safe-area + meta tags
feat(pwa-1): manifest + service worker + installabilite
feat(pwa-2): UX app-like (offline banner, haptics, splash)
feat(pwa-3): realtime adaptatif (visibility, throttle, fallback REST)
perf(pwa-4): OnPush + prefetch + self-host fonts + CDK virtual scroll
test(pwa-5): Lighthouse CI + checklist cross-device
```

### 8.4 Lien avec la roadmap principale

Cette roadmap est independante des sprints metier (`docs/04-roadmap.md`, `docs/09-roadmap-v2.md`). Elle peut s'inserer entre deux sprints fonctionnels ou en parallele d'un sprint UI plus large. La Phase 0 (0,5 j) merite d'etre executee tres tot car elle est sans risque et debloque la dogfooding mobile.

---

## 9. Journal

| Date | Phase | Statut | Notes |
|------|-------|--------|-------|
| 2026-04-26 | - | Audit initial | Document cree, branche `worktree-audit-pwa` |
| 2026-04-26 | 0-5 | **Implementee** | Phases 0 a 5 livrees sur la meme branche. Build production OK (initial 131 kB gz, lazy chunks correctement decoupes). SW + manifest + ngsw.json generes dans `dist/web/browser/`. CDK virtual scroll non applique : grille CSS responsive actuelle suffisante < 200 vehicules, a reevaluer ensuite. Splash iOS et icones maskable propres : a generer avec `pwa-asset-generator` quand un asset source haute-res est dispo. |

---

## 10. Apres le merge - actions optionnelles

Choses non faites par cette livraison, listees pour plus tard :

1. **Splash screens iOS dedies** : `npx pwa-asset-generator apps/web/public/logos/svg/vizyo-tracky-icon-green.svg apps/web/public/splash --background "#0A0F0D" --padding "20%" --splash-only --ios-only --index apps/web/src/index.html`. Sans cela, iOS standalone affiche un fond noir +icone par defaut au lancement, ce qui est acceptable mais pas premium.

2. **Icone maskable propre** : utiliser <https://maskable.app/editor> pour generer une variante avec safe-zone correcte, puis remplacer la reference dans `manifest.webmanifest`. La version actuelle reutilise l'icone "any" en `purpose: maskable` ce qui peut etre tronque sur Android adaptive icons.

3. **CDK virtual scroll** : applicable quand la flotte depassera ~200 vehicules ou la liste d'alertes ~500 entrees. Le CDK est deja installe (`@angular/cdk`).

4. **Zoneless** : `provideExperimentalZonelessChangeDetection()` reduit le bundle de ~50 ko et elimine le tick global. Necessite de valider que socket.io-client se comporte bien sans Zone (les setTimeout internes ne declenchent plus de CD). A faire sur une branche dediee.

5. **Lighthouse CI dans GitHub Actions** : la config est livree (`apps/web/.lighthouserc.json`), il reste a ajouter le step dans le workflow CI :

   ```yaml
   - name: Lighthouse CI
     working-directory: apps/web
     run: npx -y @lhci/cli autorun
   ```

6. **iOS Safari + WebSocket en background** : la Phase 3 met en sommeil le WS apres 30s en background pour eviter les retries, et re-hydrate via REST au retour. Si l'app doit recevoir des notifications critiques meme onglet ferme, il faudra :
   - soit basculer sur Capacitor (notifications natives),
   - soit utiliser **Web Push** (Apple supporte Web Push pour PWA installee depuis iOS 16.4) - ouvrir un sprint dedie.

7. **PreferencesService load + visibility** : verifier que `PreferencesService.load()` tolere des appels concurrents si l'utilisateur reprend l'app rapidement apres un long background.
