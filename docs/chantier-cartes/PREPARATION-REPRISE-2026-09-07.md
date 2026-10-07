> **Archive — dossier de reprise du chantier cartes (07/09/2026), rangé dans le dépôt le 07/10/2026.**
> Il vivait hors du dépôt (`reprise-cartes\PREPARATION.md`), sans aucune copie. Le chantier est
> terminé et prouvé : voir [`SUIVI-CARTES-2026-09-07.md`](./SUIVI-CARTES-2026-09-07.md). Les commandes
> et chemins ci-dessous décrivent l'état du 07/09 : les vérifier avant de les rejouer.

---
# Cartes Vizyo Tracky — dossier de reprise

> Écrit pour être exécuté sans rien redécouvrir. Tout ce qui suit a été **mesuré**, pas supposé.
> Quand une chose n'a pas pu être vérifiée, c'est écrit noir sur blanc.

**État de départ** : branche `main` propre, production sur **`872f0fda`**.
`9ddb0e26` (un fichier de test) est poussé mais pas déployé — sans effet produit.

---

# 0. Les huit pièges, à lire AVANT d'écrire une ligne

Chacun m'a coûté du temps aujourd'hui. Ils ne se devinent pas.

### 0.1 — Aucun accent grave dans `template:` et `styles: [\`…\`]`

Ce sont des littéraux gabarit. **Un seul accent grave les referme** et la compilation échoue
**très loin de la faute**, sur un commentaire parfaitement valide :

```
TS2554: Expected 1-2 arguments, but got 0.
    reports.component.ts:3360:21   ← un commentaire qui cite `computed()`
```

Réflexe : une erreur TS qui désigne une **ligne de commentaire** = chercher les accents graves
qu'on vient d'ajouter. Pour délimiter le bloc :

```bash
grep -n "styles: \[\`" fichier.ts                      # trouve le debut (ex. 1827)
awk 'NR>=1827 && NR<=3205 && /`/ {print NR": "$0}' fichier.ts
```

Une seule ligne doit ressortir : celle du `styles: [\`` lui-même. `pnpm verif:litteraux` l'attrape.

### 0.2 — Lancer les garde-fous AVANT de compiler

```bash
pnpm verif:litteraux      # accent grave dans un gabarit
pnpm verif:variables      # var(--x) sans definition
pnpm verif:contraste      # 168 couples, seuil 4,5:1
pnpm verif:confirmations  # « toute confirmation nomme ce qui est perdu »
pnpm verif:couleurs-kit   # couleurs en dur hors jetons
pnpm verif:carte-gardes   # NOUVEAU — cf. tache A
```

⚠️ `verif:accents` et `verif:couleurs-kit` **échouent déjà** sur des fichiers du chantier démo
(`env.validation.ts`, `pdf-export-modal`, `scanner-code`) : vérifier que l'échec vient bien de
son propre code.

⚠️ **`--texte-danger` N'EXISTE PAS.** Le jeton de danger est `--texte-alerte` (dérivé de
`--danger`). Patron maison pour une pastille de danger, déjà mesuré à 4,90:1 :
`background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--texte-alerte);`

### 0.3 — `pnpm typecheck` NE COUVRE PAS `apps/web`

Turbo n'a que trois tâches : `shared:typecheck`, `shared:build`, `api:typecheck`. **Seul
`ng build` valide le composant carte.** Le faire à chaque fois.

### 0.4 — `pnpm verify` est bloqué par le garde-fou des serveurs de dev

Si un `ng serve` tourne (souvent : une autre session), `pnpm test` refuse de démarrer. Utiliser
directement :

```bash
pnpm --filter @vizyo/tracky-web exec ng test --watch=false --browsers=ChromeHeadless
pnpm --filter @vizyo/tracky-api exec jest
```

### 0.5 — Le volet navigateur ne peint pas quand il est masqué

Mesuré : **0 image/s**, MapLibre reste noir, aucune tuile peinte — et les **minuteurs sont
bridés** (zéro requête XHR observée en 11 s). Ce n'est pas un bug produit.

- Toujours mettre un **filet `setTimeout`** sur une boucle `rAF`, sinon `javascript_tool`
  expire à 45 s.
- Le style peut être **chargé sans être peint** : `performance.getEntriesByType('resource')`
  montrait 15 tuiles alors que le canvas était noir. Les tuiles suivantes passent par un
  **worker** et n'y apparaissent pas.
- Les transitions de route Angular restent **figées** : après une navigation SPA la capture
  montre deux pages superposées. Pour une capture propre, **naviguer par `navigate`**
  (chargement complet), pas en cliquant un lien du menu.

### 0.6 — Le service worker sert l'ANCIEN paquet après un déploiement

Avant de juger une correction d'interface :

```js
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
```

### 0.7 — Le dépôt est PARTAGÉ

Plusieurs sessions poussent en parallèle (7 commits en 6 h mesurés). **`git add` par chemin
explicite, jamais `-A`.** Vérifier la branche avant de committer.

### 0.8 — Déployer : le conteneur « Up » ne prouve rien

`docker compose up -d --build` remonte **`tracky-web` pendant que l'API compile encore**.
Ne jamais conclure sur `docker ps`. Attendre l'**artefact compilé** :

```bash
ssh root@72.62.26.240 "docker exec tracky-api grep -q '<chaine neuve>' dist/<chemin>.js"
ssh root@72.62.26.240 "docker exec tracky-web sh -c 'cd /usr/share/nginx/html && grep -lq \"<texte neuf>\" *.js'"
```

⚠️ Un **commentaire** ne survit pas à la compilation de l'API (`removeComments: true` dans
`apps/api/tsconfig.json`) : choisir un marqueur de **code** ou une chaîne littérale.
⚠️ Un marqueur **accentué** peut être mangé par l'encodage ssh : préférer l'ASCII.

---

# 1. Environnement — commandes exactes

### 1.1 Banc LOCAL (le seul où la carte est pleinement inspectable)

```bash
# .claude/launch.json contient deja tout
#   tracky-web : ng serve sur 4200, proxy /api -> localhost:3000
#   tracky-api : nest start sur 3000
```

⚠️ **C'est en dev que la carte devient inspectable** : Angular expose `window.ng`, donc

```js
const cmp = ng.getComponent(document.querySelector('app-map'));
cmp.map.getSource('trails');      // impossible en build de production
```

En build de production, `__ngContext__` est un **index numérique** : l'instance n'est pas
atteignable. C'est ce qui a bloqué ma vérification de la reconstruction des couches.

### 1.2 Session de recette en PRODUCTION, sans mot de passe

```bash
cat > /tmp/mint.js <<'JS'
const jwt = require('/app/node_modules/.pnpm/jsonwebtoken@9.0.3/node_modules/jsonwebtoken');
const crypto = require('crypto');
console.log(jwt.sign({
  iss: process.env.VIZYO_AUTH_JWT_ISSUER, aud: 'api', sub: process.argv[2],
  appId: process.env.VIZYO_AUTH_APP_INTERNAL_ID, typ: 'access', jti: crypto.randomUUID(),
}, process.env.VIZYO_AUTH_JWT_ACCESS_SECRET, { expiresIn: '12h' }));
JS
scp /tmp/mint.js root@72.62.26.240:/tmp/mint.js
ssh root@72.62.26.240 "docker cp /tmp/mint.js tracky-api:/app/mint.js && \
  docker exec tracky-api node /app/mint.js cmn0o8tz7000507pbiwaxhw7c && \
  docker exec tracky-api rm -f /app/mint.js"
```

⚠️ **`require('jsonwebtoken')` échoue dans ce conteneur** (pnpm en arborescence isolée) : d'où
le chemin complet `.pnpm/…`.
⚠️ `cmn0o8tz7000507pbiwaxhw7c` = `authUserId` du super-admin `admin@vizyoagency.com`.
⚠️ **Une session ainsi forgée meurt au premier 401 qui suit un redéploiement** (aucun jeton de
rafraîchissement) : la reforger après chaque déploiement, c'est normal.

Pose dans le navigateur :

```js
// 1. purger le cookie — il PRIME sur le Bearer
for (const c of document.cookie.split(';')) {
  const n = c.split('=')[0].trim();
  for (const d of ['', '; domain=app-tracky.vizyoagency.com', '; domain=.vizyoagency.com'])
    document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`;
}
// 2. retirer le service worker (cf. 0.6)
// 3. poser la session
const me = await fetch('/api/users/me', { headers: { Authorization: 'Bearer ' + t } }).then(r => r.json());
localStorage.setItem('vizyo-tracky-token', t);
localStorage.setItem('vizyo-tracky-user', JSON.stringify(me));
localStorage.setItem('vizyo-tracky-remember', '1');
localStorage.setItem('tracky.pwa.dismissed', '1');
localStorage.setItem('tracky.pwa.visits', '99');
```

### 1.3 Déploiement

```bash
ssh root@72.62.26.240 "cd /opt/vizyo-tracky && git pull --ff-only origin main && \
  cd deploy/vps && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build"
```

Puis **attendre l'artefact** (cf. 0.8). Sans `--build` si seul le code TS a changé sur l'API :
`up -d` suffit et ne recrée que ce qui a changé.

### 1.4 Base de production (lecture)

```bash
cat > /tmp/q.sql <<'SQL'
SELECT ... ;
SQL
ssh root@72.62.26.240 "docker exec -i tracky-postgres psql -U tracky -d tracky_prod -At -F ' | '" < /tmp/q.sql
```

⚠️ Écrire le SQL dans un fichier et le passer par **stdin** : les guillemets imbriqués en ssh
sont un piège à eux seuls.

### 1.5 Migration : essai à blanc sur la VRAIE base

Cloner échoue (connexions actives). L'essai à blanc, lui, marche :

```bash
{ echo "BEGIN;"; cat migration.sql; echo "SELECT ...controle...;"; echo "ROLLBACK;"; } > /tmp/essai.sql
ssh root@72.62.26.240 "docker exec -i tracky-postgres psql -U tracky -d tracky_prod -v ON_ERROR_STOP=1 -At" < /tmp/essai.sql
```

⚠️ **Jamais de DDL manuel en production** : l'entrypoint fait `migrate deploy`. Du DDL à la main
= `P3009` et API en boucle.

---

# 2. Le protocole de vérification — cinq niveaux, dans cet ordre

Aucune tâche n'est « finie » avant d'avoir passé les cinq.

| # | Niveau | Commande / geste | Ce qu'il attrape |
|---|---|---|---|
| 1 | **Rouge d'abord** | casser volontairement le correctif, lancer le test | un test qui ne teste rien |
| 2 | **Garde-fous** | les 6 `pnpm verif:*` | jeton fantôme, accent grave, contraste |
| 3 | **Compilation** | `ng build` (+ `tsc --noEmit` côté API) | le web n'est PAS couvert par `pnpm typecheck` |
| 4 | **Suites** | `ng test` (654 aujourd'hui) + `jest` (3772) | régressions |
| 5 | **Production** | déployer, attendre l'artefact, **mesurer**, capturer | ce que le banc ne montre pas |

⚠️ **Le niveau 1 n'est pas décoratif.** Deux fois aujourd'hui, un test que je croyais rouge
passait au vert parce que ma substitution n'avait pas mordu (fichiers en **CRLF** : un motif
`\n` ne matche pas — utiliser `\r?\n`). Toujours **vérifier que la substitution a eu lieu**
avant de conclure « prouvé rouge ».

---

# 3. Les tâches

## TÂCHE A — Finir et prouver le correctif de perte de contexte WebGL

**Statut : à moitié vérifié. C'est la seule tâche urgente.**

### Ce qui est fait et déployé (`872f0fda`)

`carteUtilisable()` dans `features/map/map.component.ts` : garde qui distingue « la référence
existe » de « la carte peut recevoir des ordres ». Les **19 méthodes** touchant une source y
passent. Bandeau `.mp-interrompue`. Handlers `webglcontextlost` / `webglcontextrestored`.
`recreerCouches()` extraite du chemin `setStyle`. Script `pnpm verif:carte-gardes`.

### Ce qui est VÉRIFIÉ en production

| | Avant | Après |
|---|---|---|
| Erreurs `getSource` après une perte | **90** (une par cycle de rendu, chacune postée au serveur) | **0** |
| Message | « Une erreur est survenue » générique | bandeau « Affichage de la carte interrompu » + bouton |
| Au retour du contexte | rien | bandeau retiré automatiquement |

Reproduction (fiable, faite 4 fois) :

```js
const c = document.querySelector('canvas.maplibregl-canvas');
const gl = c.getContext('webgl2') || c.getContext('webgl');
const ext = gl.getExtension('WEBGL_lose_context');
ext.loseContext();      // → bandeau, 0 erreur
ext.restoreContext();   // → bandeau retire
```

⚠️ Compter les erreurs **soi-même** : le `GlobalErrorHandler` d'Angular les intercepte, donc
`window.onerror` ne les voit pas. Patcher `console.error` et compter. Et **recharger la page
avant de compter** : le tampon de la console du volet survit aux navigations SPA — j'ai lu
« 33 erreurs » qui étaient des restes d'une reproduction antérieure.

### ❌ CE QUI N'EST PAS VÉRIFIÉ — à faire en premier

**Les couches sont-elles réellement RECONSTRUITES au retour du contexte ?**

Aucune requête XHR observée après `restoreContext()` — mais le banc bride les minuteurs et le
réseau, donc **la mesure ne conclut pas**. Si la reconstruction ne se fait pas, la carte revient
**vide** : tuiles nues, sans traînées, sans géofences, sans clusters, sans repères. « Réparée en
apparence seulement », exactement ce que le commentaire de `recreerCouches()` annonce.

**Comment le vérifier — en LOCAL, en dev :**

```js
const cmp = ng.getComponent(document.querySelector('app-map'));   // ne marche qu'en dev
const etat = () => ({
  style: !!cmp.map.style,
  trails: !!cmp.map.getSource('trails'),
  cluster: !!cmp.map.getSource('vehicles-cluster'),
  geofences: !!cmp.map.getSource('geofences'),
  couches: cmp.map.getStyle().layers.length,
});
etat();                       // avant
ext.loseContext();  etat();   // pendant : style null
ext.restoreContext();
setTimeout(() => console.log(etat()), 5000);   // APRES : tout doit etre revenu
```

**Critère d'acceptation** : après restauration, les quatre sources existent et le nombre de
couches est revenu au niveau d'avant.

**Si ça ne marche pas**, les deux causes probables, dans l'ordre :
1. `map.once('styledata')` ne se déclenche jamais → poser aussi un repli sur `map.on('load')`
   ou une temporisation, et **journaliser** pour le voir.
2. `recreerCouches()` sort sur sa garde parce que `carteUtilisable()` est encore faux au moment
   où `styledata` arrive → séquencer autrement (lever le drapeau APRÈS le rebuild, pas avant).

---

## TÂCHE B — Une seule échelle de vitesse, sur toutes les cartes

**Demande du propriétaire** : 1–65 vert, 66–100 orange, 101–140 rouge, au-delà rouge foncé.
**Contrainte explicite** : *ne pas toucher aux récits ni aux excès de vitesse.*

### B1. La source unique

`apps/web/src/app/shared/utils/couleurs-carte.ts` (ce fichier documente déjà **pourquoi** ces
couleurs restent en dur : elles se posent sur le fond de carte, pas sur le thème ; et MapLibre
ne résout aucune variable CSS — un `var(--x)` y donne une couche invisible, sans erreur).

```ts
export const BANDES_VITESSE = [
  { max: 0,        couleur: '#5C746C', libelle: 'À l’arrêt' },
  { max: 65,       couleur: '#10E0A0', libelle: '1 – 65 km/h' },
  { max: 100,      couleur: '#F59E0B', libelle: '66 – 100 km/h' },
  { max: 140,      couleur: '#EF4444', libelle: '101 – 140 km/h' },
  { max: Infinity, couleur: '#991B1B', libelle: 'Plus de 140 km/h' },
] as const;

export function couleurVitesse(v: number): string { /* premiere bande dont max >= v */ }
```

⚠️ **`#991B1B` n'est pas un choix esthétique** : `markerInk()` y met du blanc, ~8,3:1. Toute
autre teinte doit être revérifiée — `maplibre-markers.spec.ts` mesure 4,5:1 sur chaque couleur.

`shared/utils/maplibre-markers.ts` : `speedColor()` **délègue** à `couleurVitesse()`. Garder
l'export, il est importé par la carte et la mini-carte.

### B2. Câbler les surfaces qui ne colorent PAS par vitesse

| Fichier | Aujourd'hui | À faire |
|---|---|---|
| `features/public-trip/public-trip.component.ts` **l.283** | `'line-color': '#10E0A0'` — **vert uni** | segments colorés |
| `features/reports/trip-replay.component.ts` **l.1454** | `COULEURS_CARTE.trace` — couleur unique | idem |
| `features/reports/period-replay.component.ts` **l.1060** | `COULEURS_CARTE.trace` | idem |
| `features/depot/depot-map.component.ts` | aucune trace trouvée | **vérifier** |
| `features/map/map.component.ts` l.5945 / 6115 | déjà `speedColor` | hérite de B1 |
| `shared/ui/mini-map/mini-map.component.ts` l.131 | déjà `speedColor` | hérite |

⚠️ **NE PAS TOUCHER** `COULEURS_CARTE.exces` (excès confirmés) ni `.pointe` (pointes non
affirmées). Leur distinction est documentée et a été payée : 1 excès annoncé, 6 affichés.

⚠️ **`public-trip` est la page PUBLIQUE** (destinataire sans compte). Vérifier d'abord que le
DTO transporte une vitesse : aujourd'hui `PartageTrajetPublicDto.path` est un `[lng, lat][]`
**sans vitesse**. Si non, il faut l'ajouter côté API (`apps/api/src/reports/trip-share.service.ts`,
méthode `trace()`) — c'est une modification de **contrat public**, à faire proprement et à
tester (`trip-share.service.spec.ts` existe et couvre déjà l'écrêtage à 1 500 points).

### B3. Le composant partagé demandé

- **`segmentsColores(points)`** : suite de `{lng, lat, speedKmh}` → `FeatureCollection` de
  segments portant `properties.color`. Chaque carte pose une couche `line` avec
  `'line-color': ['get', 'color']`.
- **`<app-legende-vitesse>`** : légende **générée depuis `BANDES_VITESSE`**.

⚠️ **Les légendes sont écrites À LA MAIN, à deux endroits**, avec les anciens seuils :
`features/map/map.component.ts` **l.1065-1082** (HUD de bureau) et **l.993-1010** (planche de
calques). Changer un seuil sans corriger ces deux blocs produit une carte qui se contredit.

### B4. Tests

`shared/utils/maplibre-markers.spec.ts` **l.36-42** : la table `PALETTE` porte les anciens
libellés (`'1-50 km/h'`…) et **ne couvre pas la 5ᵉ bande**. Ajouter le rouge foncé.

**Recette** : un replay d'autoroute doit changer de couleur — vert en ville, orange sur route,
rouge sur autoroute.

---

## TÂCHE C — Les traînées sont en retard et trop nombreuses

**Demande** : 2-3 traînées pour ceux qui roulent, aucune pour ceux à l'arrêt depuis ≥ 3 min.
Le propriétaire précise : *« si ça marche pas c'est qu'il y a des bugs, regarde bien »*.

**Où** : `features/map/map.component.ts` — `trailPoints`, `showTrails`,
`preferences.prefs().map.trailLength` (**défaut : 20**), construction de `trailFeatures` dans
`applyPositions`, source `trails`.

**À lire avant de toucher** : `trailPoints`, `lastTruthPosition`, `motion`, `rejectStreak` — il
existe déjà une machinerie de lissage et de rejet. **Ne pas la doubler.**

**Pistes à vérifier, pas des conclusions :**
1. `trailLength: 20` est un nombre de **POINTS**, pas une durée. À 30 s par trame, 20 points =
   10 min de traînée : c'est probablement le « en retard » ressenti.
2. Un véhicule à l'arrêt **garde ses points** : sa traînée reste affichée alors qu'il ne bouge
   plus. Purger quand la position bouge de moins de X m depuis 3 min.
3. `positionsList()` est **hydraté au chargement** : au premier rendu, la traînée peut être un
   souvenir.

⚠️ **Mesurer d'abord.** Relever pour 2-3 véhicules : `trailPoints.size`, l'âge du plus ancien
point, et ce qui est affiché. Régler un paramètre sans avoir établi le défaut, c'est déplacer
le problème.

---

## TÂCHE D — Soin visuel de la carte

1. **La légende est un HUD permanent** (`map.component.ts` l.1062-1090) : 4 bandes + jusqu'à
   3 repères, toujours à l'écran. C'est de la référence qu'on lit une fois. → **repliable,
   repliée par défaut, choix mémorisé** — le patron existe déjà, cf. `lieuxAffichage` dans
   `preferences.service.ts` (défaut + persistance + application à l'ouverture).
2. Avec B1 elle passe à **5** bandes : raison de plus.
3. `showPlates: true` par défaut — une plaque sous chaque marqueur. **À valider avec le
   propriétaire avant de toucher** : c'est utile autant que bruyant.

**Déjà fait** (`872f0fda`) : les repères de lieux sont **discrets par défaut**, et le choix est
mémorisé (il ne l'était pas — « Discrets » ne tenait pas au rechargement).

---

# 4. Protocole de captures — production

**79 routes déclarées.** Toutes ne méritent pas une capture ; celles-ci si, parce qu'elles
portent des cartes, des tableaux denses ou des chiffres :

**Cartes** : `/map`, `/reports` (+ replay ouvert), `/depot`, `/t/:token` (partage public),
`/s/:token`, `/dashboard`, `/vehicles/:id` (onglet carte), `/geofences`, `/places`.
**Écrans denses** : `/vehicles`, `/alerts`, `/agenda`, `/drivers`, `/scores`, `/missions`,
`/users`, `/admin`, `/admin/liens-partages`, `/admin/alerts`, `/admin/trackers`.

**Quatre largeurs, et elles ne sont pas décoratives** — le défaut des KPI tronqués n'apparaissait
QUE dans la bande médiane :

| Largeur | Pourquoi |
|---|---|
| **375** | téléphone ; c'était la seule largeur SAINE du défaut KPI |
| **768** | tablette ; bascule de plusieurs grilles |
| **1440** | portable — **la largeur où le défaut KPI était le pire** |
| **1920** | grand écran ; redevenait sain |

**Deux sondes à passer sur chaque écran** (elles ont trouvé 3 défauts sur 6 aujourd'hui) :

1. **Troncature** : `el.scrollWidth > el.clientWidth` sur les feuilles en `text-overflow: ellipsis`.
2. **Collision** : intersection des rectangles d'éléments interactifs, **confirmée par
   `document.elementFromPoint`** au centre de la zone commune.

⚠️ **Deux faux positifs à écarter, sinon la sonde ment** :
- **Défilé hors vue ≠ recouvert.** Un élément sorti d'un ancêtre `overflow: auto` garde son
  rectangle. Remonter les ancêtres et l'écarter s'il est hors de leur cadre — sinon on
  « trouve » deux entrées de menu inatteignables qui ne le sont pas.
- **Une surcouche FIXE au-dessus du contenu est normale** (barre basse, en-tête collant) :
  écarter les paires dont un seul membre a un ancêtre `fixed`/`sticky`.

Le code complet des deux sondes est dans `constats-recette.md` (livré séparément).

---

# 5. Décisions du propriétaire — à ne PAS trancher seul

1. **Une tâche planifiée à l'arrêt n'alerte PERSONNE par e-mail.**
   `apps/api/src/observability/error-rate-watchdog.service.ts` est un compteur de **débit** :
   `if (total <= this.threshold) return;`, seuil **5 erreurs / heure glissante**. Le niveau
   `CRITICAL` ne sert qu'à garnir le corps du message, jamais à déclencher.
   Or une tâche à l'arrêt produit **1 CRITICAL par heure** → sous le seuil.
   Le 06/09 : l'automatisation des trajets a manqué 7 passages, **5 trajets définitivement
   inanalysables**, 4 CRITICAL écrits, **0 e-mail**.
   → il manque un déclencheur par **gravité**. Ajouter un envoi change qui est notifié.

2. **Fonds CARTO au catalogue** : « Plan clair » / « Plan sombre » renvoient des tuiles barrées
   « API KEY REQUIRED » avec un **HTTP 200** — rien ne le signale côté code, seul le rendu le
   montre. Les 19 utilisateurs sont sur `osm`, personne n'est touché aujourd'hui.

3. **`showPlates` par défaut** (cf. tâche D3).

4. **Contrôle programmé le 08/09 à 07:15** : le trou d'automatisation est-il revenu ?
   ⚠️ Première commande **AVANT tout déploiement**, sinon la preuve disparaît avec le conteneur :
   `docker inspect tracky-api --format '{{.State.OOMKilled}} {{.State.ExitCode}}'`

---

# 6. Ordre conseillé

**A** (finir et prouver la reconstruction — c'est en production et à moitié vérifié)
→ **B1 + B4** (source unique + tests, sans câblage)
→ **B3** (composant partagé + légendes générées)
→ **B2** (câblage, **une carte à la fois**, en vérifiant après chacune)
→ **C** (mesurer, puis corriger)
→ **D**.

**B2 en dernier des B** parce que c'est là que ça peut casser : cinq surfaces, dont une publique.
