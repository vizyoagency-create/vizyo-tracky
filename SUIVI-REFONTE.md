# Suivi de la refonte Tracky v2

> **À quoi sert ce fichier.** C'est le point d'entrée unique pour reprendre le chantier
> dans une nouvelle session, sans rien réapprendre et sans repayer un piège déjà payé.
> Il remplace la lecture de tout l'historique.
>
> Écrit le **2026-08-13**, mis à jour le **2026-08-14**, branche
> `feat/refonte-tracky-v2`, worktree `D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky`.
>
> **Les trois autres fichiers à connaître :**
> | Fichier | Rôle |
> |---|---|
> | `design/B1-PAGES.md` | La spec des pages, bloc par bloc. **L'ordre des blocs y est imposé.** |
> | `REPRISE-B-PAGES.md` | Le journal détaillé, séance par séance. Les découvertes y sont racontées. |
> | `REFONTE-TRACKY-V2.md` | La feuille de route générale + le journal de bord global. |
>
> ⚠️ Le compteur « B-pages 23/57 » du tableau de `REFONTE-TRACKY-V2.md` est **périmé** :
> **B-pages est clos au 2026-08-14**, les 7 blocs sont livrés et mesurés (§ 5.2).
>
> ⚠️ Ce compteur compte des **lignes de `B1-PAGES.md`**, pas des pages, et il a été tenu
> à la main de séance en séance. **Il donne un ordre de grandeur, pas une preuve.** La
> seule preuve est le § 5.2 ci-dessous, et la mesure au navigateur.
>
> Il passe à **57/57** au 2026-08-14, non pas parce que les lignes ont été recomptées,
> mais parce que **les 7 blocs du § 5.2 sont tous 🟢 et mesurés au navigateur** — la
> preuve est ce tableau, pas ce nombre. Ce qui reste de B-pages n'est pas du travail
> non fait : ce sont des **décisions** et des **contrats d'API**, tous listés au § 12.

---

## 1. Le prompt à coller en première demande

> Reprends le lot **B-pages** de la refonte Tracky, branche `feat/refonte-tracky-v2`
> (worktree `D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky`).
> Lis d'abord `SUIVI-REFONTE.md` à la racine — il contient tout l'état.
>
> **Trois règles non négociables :**
>
> 1. **Une maquette est une référence de conception, pas du code.** Les 28 planches sont
>    dans `design/maquettes/`. Traduis la DÉCISION de la planche en classes Tailwind et
>    composants du kit existants. Ne recopie jamais un style en ligne.
> 2. **On reprend la décision de la planche, pas sa valeur, dès qu'elle tombe sous 4,5:1
>    sur du texte.**
> 3. **Vérifie chaque page DANS LE NAVIGATEUR, à 375 px, dans les DEUX thèmes.** Pas de
>    conclusion sur lecture de code seule.
>
> Ne modifie AUCUN DTO ni contrat d'API existant sans me demander.

---

## 2. Périmètre — ce qu'il ne faut pas toucher

| Interdit | Pourquoi |
|---|---|
| `apps/api/src/tracker-fix-mode/` | Travail d'un tiers, **non commité**, présent en modifications locales. Ne pas committer, ne pas corriger. |
| `docs/centre-alerte/`, `docs/vps-audit/` | Autre session. Elle **commite sur la même branche** (cf. § 4). |
| La branche `feat/depot-partage` et le VPS | **La production tourne dessus.** Recette en cours côté client. Ne rien déployer. |
| `apps/api/.env` (et tout `.env`) | Fichier de l'utilisateur. Charger les variables dans l'environnement du processus si besoin, ne pas éditer. |
| Tout DTO / contrat d'API | Demander d'abord. Cinq points sont déjà bloqués là-dessus (§ 7). |

---

## 3. Remonter l'environnement

```bash
docker compose up -d
```

Puis `preview_start` sur **`api-refonte`** (3000) et **`web-refonte`** (4205).

⚠️ **Le `launch.json` lu par `preview_start` est celui du PARENT** :
`D:\www\vizyo-agency\vizyo-tracky\.claude\launch.json` — **pas** celui du dépôt.

**Jeton d'authentification.** Le script n'auto-charge pas le `.env` : il faut poser les
trois variables dans l'environnement du processus d'abord.

```bash
pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts <authUserId>
```

Variables requises : `VIZYO_AUTH_JWT_ACCESS_SECRET`, `VIZYO_AUTH_JWT_ISSUER`,
`VIZYO_AUTH_APP_INTERNAL_ID`. Le jeton vaut **24 h**.

Puis, dans la console du navigateur :

```js
await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); // le cookie PRIME sur le Bearer
localStorage.setItem('vizyo-tracky-token', JETON);
localStorage.setItem('tracky.perms.onboarded', '1');                        // sinon la porte masque tout l'écran
```

**Comptes utiles :**

| `authUserId` | Compte | Note |
|---|---|---|
| `cmnusapj5000f07s7ipjkdcf4` | `tracky1@gmail.com`, FLEET_ADMIN | Le seul qui ouvre `/integrations`. |

⚠️ **LE JETON SEUL NE SUFFIT PAS** *(payé le 2026-08-14)*. `gen-test-token.ts` ne met que
`{sub, aud, typ, appId}` dans le JWT — **ni `role`, ni `permissions`**. Or `AuthService`
retombe sur `decodeJwt()` quand `vizyo-tracky-user` est absent, et `PermissionsService.can()`
ne bypasse que sur `role === 'FLEET_ADMIN' | 'SUPER_ADMIN'`. Sans rôle : **toutes les pages
gardées redirigent vers `/dashboard`** — silencieusement. Poser aussi :

```js
const me = await (await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + JETON } })).json();
localStorage.setItem('vizyo-tracky-user', JSON.stringify(
  { sub: me.id, email: me.email, role: me.role, fleetId: me.fleetId, permissions: null, preferences: null }));
```

> Sans ça, on mesure `/dashboard` en croyant mesurer `/reports`. **C'est exactement ce que
> le réflexe « lire `location.pathname` DANS le relevé » (§ 9.3) a rattrapé** — sinon
> 6 échecs du shell étaient attribués à `/reports`.

⚠️ L'identifiant de seed `cdef31-admin` **ne marche pas** (`/api/auth/me` répond 500) —
prendre un `authUserId` en forme de cuid.
⚠️ `POST /api/auth/logout` répond **500** mais **fait bien le travail** (il efface le
cookie qui prime sur le Bearer). Ne pas s'y arrêter : vérifier `/api/auth/me` ensuite.
⚠️ **Aucun compte DRIVER en base de dev** (4 FLEET_ADMIN, 3 DEPOT, 3 SUPER_ADMIN,
2 FLEET_MANAGER, 1 VIEWER, **0 DRIVER**).

**Basculer le thème pour mesurer.** La préférence est **serveur** : `applyFromPrefs()`
réécrit `localStorage['vizyo-theme']` au boot. Pour une mesure CSS, poser directement
l'attribut, c'est lui qui pilote les jetons :

```js
document.documentElement.setAttribute('data-theme', 'dark');   // ou 'light'
```

**Autres points d'environnement :**

- `curl` est **bloqué par le bac à sable** (code 000 sur tout) → `Invoke-WebRequest`.
- Docker Desktop **s'arrête parfois seul** ; symptôme : Prisma **et** Redis échouent
  *ensemble*. Vérifier `wsl -l -v` (la distro `docker-desktop` doit être *Running*)
  avant d'accuser l'IPv6.
- **`localhost` vs `127.0.0.1`** : la panne IPv6 documentée **ne s'est pas reproduite**
  le 2026-08-13 (`localhost`, `127.0.0.1` et `::1` répondent tous en 0-2 ms sur 5436).
  Garder le réflexe, mais **mesurer avant de conclure**.
- Les serveurs de préversion **s'arrêtent** au bout d'un moment : `preview_list` renvoie
  `[]`, il faut les relancer.
- Le **panneau navigateur peut être masqué** : ni capture d'écran ni clic natif
  (`computer` échoue en délai). Tout piloter en `javascript_tool` — les gestionnaires
  Angular se déclenchent normalement.

---

## 4. ⚠️ Deux sessions travaillent sur ce dépôt

Une autre session commite **sur la même branche**. Sur la séance du 2026-08-13, elle a
poussé `53902f5 docs(centre-alerte)` et `5b260cd docs(vps-audit)` **au milieu** des
commits de refonte.

**Conséquences pratiques :**
- Toujours `git log --oneline -5` avant de commencer, la branche a pu bouger.
- Ne stager que **ses propres fichiers**, jamais `git add -A`.
- Elle fait aussi tourner l'API du worktree **dépôt-partage** (`nest start --watch`).
  Ce worktree bind **3011**, la refonte **3000** : pas de collision.

---

## 5. État du chantier

### 5.1 Vue générale

| Lot | État | |
|---|:-:|---:|
| Étape 0 · A1 · A2 · A5 · A3 · A4 | 🟢 livrés | — |
| **B0′** — reliquat du socle | 🟢 livré | 27/28 |
| **B-kit** — kit partagé | 🟢 livré | 26/28 |
| **B-pages** | 🟢 **livré** — blocs A→G | **57/57** |
| **Bloc J** — interfaces alternatives | 🟡 **2 modes sur 3** *(2026-08-14)* | 2/3 |
| **B-mails** | 🟢 **livré** *(2026-08-14)* | **21/21** *(le compteur « 12 » était faux : 21 gabarits réels)* |
| **PROD** | ⬜ à faire — push, déploiement, recette | 0/28 |

> ⚠️ **`B1-PAGES.md` a DIX blocs (A→J), ce tableau n'en suivait que sept.** Les blocs
> **H** (kit partagé, 23 composants → couvert par le lot B-kit) et surtout **J**
> (interfaces alternatives) n'apparaissaient nulle part. Le bloc J a été mesuré et repris
> le 2026-08-14 (§ 6quater) — **il portait deux écrans qui ignoraient le thème**.

### 5.2 B-pages, bloc par bloc — **l'ordre est imposé par `B1-PAGES.md`**

⚠️ **La mise en garde qui a produit ce tableau, gardée parce qu'elle resservira.** Le
journal notait « Bloc A ✅ terminé » en ne citant que **3 pages sur les 7** que
`B1-PAGES.md` liste au bloc A, et « contenu propre de D et E ✅ terminé » en n'en citant
que **5 sur 14**. Le tableau a donc séparé le **nommément livré et mesuré** du **présumé**.

Les 13 « présumées » ont été rouvertes le 2026-08-14 : **aucune n'était propre**, et deux
cachaient un défaut de fond (une page qui ignorait le thème, un `catch` qui mentait).
**La leçon vaut au-delà de ce tableau : un bloc coché sans que ses pages soient nommées
n'est pas un bloc fini.** À réappliquer tel quel à B-mails et à PROD.

| Bloc | Nommément livré et mesuré | Reste à faire |
|---|---|---|
| **A** — Entrée & conducteur (7) | 🟢 **7/7** — `/book/:token` · `/reserve/:token` · `/driver/unlock` · **`/login`** · **`/forgot-password`** · **`/accept-invite`** · **`/install`** *(les 4 dernières mesurées ET closes le 2026-08-14, à **0 échec**)* | — |
| **B** — Espace conducteur (1) | `/driver` 🟢 | — *(⚠️ mesuré avec un compte fleet-admin : aucun compte DRIVER en base, le périmètre réel d'un conducteur n'a **pas** été vérifié)* |
| **C** — Supervision (6) | 🟢 **6/6** — `/dashboard` · `/vehicles/:id` · `/map` · `/vehicles` · **`/places`** · **`/alerts`** *(les 2 dernières livrées le 2026-08-14)* | — *(la file d'attente à seuil de `/places` reste bloquée par l'API, § 7.1)* |
| **D** — Analyse (5) | 🟢 **5/5** — `/fleet-admin/activity` · `/admin/ai-usage` · **`/reports`** · **`/scores`** · **`/agenda`** *(les 3 dernières mesurées ET closes le 2026-08-14)* | — |
| **E** — Administration (9) | 🟢 **9/9** — `/settings` · `/integrations` · `/privacy-coverage` · **`/users`** · **`/users/overview`** · **`/installations`** · **`/fleet-schedules`** · **`/settings/audio-monitoring`** · **`/account`** *(les 6 dernières mesurées ET closes le 2026-08-14)* | — |
| **F** — Surfaces bloquantes (12) | 🟢 **clos 12/12**, séance du 2026-08-11 | — |
| **G** — Le shell (2) | 🟢 **2/2** — shell authentifié · shell hors session *(2026-08-14)* | — |

> ✅ **B-PAGES EST CLOS** — blocs A→G livrés et mesurés. Séance du **2026-08-14** : les 13
> pages « présumées » rouvertes (aucune n'était propre), puis `/places`, `/alerts`, le
> bloc G, et enfin le **bloc J** qui ne figurait dans aucun tableau. **Toutes les surfaces
> mesurées sont à 0 échec de contraste dans les deux thèmes, à 375 px**, sans cible sous
> 44 px.
>
> ⚠️ **Deux interfaces restent livrées SANS AVOIR ÉTÉ VUES** : `/driver` et le mode
> veilleur — aucun compte `DRIVER` ni `NIGHT_WATCHMAN` en base de dev. Ce n'est pas une
> décision, c'est une dette d'environnement (§ 12, point 10).

### 5.3 Ce qui reste, dans l'ordre

1. **`/places`** — partiellement bloqué (§ 7.1). La partie faisable : onglets
   *À valider / Lieux validés / Zones GPS*, `<app-zone>`, mesure des deux thèmes.
2. **`/alerts`** — onglets *Alertes / Géofences / Réglages*. **Pas commencé.**
3. **`/vehicles`** — reliquat : la **liste groupée par groupe avec en-têtes**
   (« Groupe Sud · 5 véhicules ») que la planche montre sur les trois plateformes. Le
   mode `grouped` existe mais reste une option du sélecteur de vue, pas le défaut. En
   faire le défaut est une **décision de comportement** — non tranchée.
4. **Bloc G — le shell.** En dernier, ordre non négociable.
5. **B-mails** — 12 lignes, 0 faite, planche `Emails Refonte.dc.html`.

---

## 6. Ce qui a été livré à la séance du 2026-08-13

**11 commits** (+ 2 de l'autre session). Branche **15 commits en avance sur `origin`,
non poussés**.

### 6.1 Portage de 4 correctifs depuis `feat/depot-partage`

Ils n'existaient que sur la branche de production ; la refonte aurait réintroduit les bugs.

```bash
git cherry-pick 6a0044b 1159b0a dbaaac6 abed805
```

| Commit | Ce qu'il corrige |
|---|---|
| `ccf539f` | Un dépôt invité sans flotte donnait un compte inerte |
| `d70ded7` | L'onglet Missions annonçait une flotte vide pour une panne |
| `f3cdbdf` | Le module missions entier était fermé aux comptes SUPER_ADMIN |
| `71601c4` | Quatre défauts d'affichage mobile (dvh, min-width:0, grille /users, filtre) |

Les quatre sont passés **sans conflit**. Vérifié ensuite que l'auto-merge n'avait pas
laissé de CSS mort (les 45 sélecteurs `.u-*` et le paramètre `aligne` du filtre
d'activité sont bien en place).

### 6.2 `/map` — 4 commits

| Commit | Objet |
|---|---|
| `a298507` | La **feuille de position** était une surface claire en dur |
| `4246794` | La carte mobile n'avait **aucune liste de véhicules** |
| `bbdda44` | **Calques & lisibilité** — le tri-état des lieux |
| `be8cf0c` | Les **pastilles de véhicule** reprises en SVG |

**Mesures avant / après, à 375 px :**

| Élément | Avant | Après |
|---|---:|---:|
| « Contact ON » (fiche, sombre) | 1,36:1 | 6,97 |
| Vitesse `2 km/h` (fiche, sombre) | 2,40:1 | 9,00 |
| Pastille active du menu (clair) | 1,56:1 | 4,65 |
| Icône de marqueur sur vert (clair) | 1,72:1 | 10,43 |
| Croix de fermeture de la fiche | 30 × 36 | **44 × 44** |

Bilan contraste `/map` : **16 → 12 échecs en clair, 16 → 11 en sombre**. Tous les
restants sont hors de ce que je pouvais trancher (§ 7).

**Nouveau fichier testé** : `apps/web/src/app/features/map/flotte-lignes.ts`
(fonction pure + **11 tests**) — la règle « une vitesse ne s'affiche que si le boîtier
est `ONLINE` ».

### 6.3 `/vehicles` — 2 commits

| Commit | Objet |
|---|---|
| `c9c83b0` | Filtres en feuille + le `catch` qui posait un tableau vide |
| `734f8ef` | Du petit texte en couleur sémantique, illisible en thème clair |

- Le **`catch` qui pose un tableau vide**, trouvé une **5ᵉ** fois : sur une panne d'API,
  la page annonçait « Aucun véhicule dans votre flotte » **avec** « Ajouter votre
  premier véhicule ». Remplacé par `<app-zone>` (`erreur` / `partiel` / `vide`).
- **Filtres en feuille** : la barre d'outils mettait un champ de recherche de
  **294 × 20** et un `select` de **122 × 20** à 375 px.
- Contraste : **14 → 10 échecs en clair**.

### 6.4 `6a35bd3` — correction d'un défaut que j'avais introduit le matin même

La légende « Cycle de vie d'un lieu » livrée sur `/map` annonçait **trois** états repris
de la planche. **Deux tiers étaient faux** : il n'y a pas d'anneau qui se remplit (la
pastille *grossit*), et « Seuil atteint » n'existe nulle part dans les données. Ramenée
à **deux** états. Voir § 8.1 — c'est la leçon la plus importante de la séance.

---

## 6bis. Séance du 2026-08-14 — les 13 pages « présumées » rouvertes

**2 commits.** Les deux décisions bloquantes O5 et « onglet actif » ont été **tranchées
par le client** et livrées dans la foulée.

### 6bis.1 Le relevé — aucune des 13 n'était propre, toutes les 13 sont closes

Sonde de contraste + sonde de recette, 375 px, deux thèmes, **écran entier** (§ 8.2).

| Page | Avant | Après O5 + onglet actif | **Fin de séance** |
|---|---:|---:|---:|
| `/reports` | **104 / 99** | 3 / 0 | **1 / 0** |
| `/agenda` | 33 / 27 | 6 / 1 | **1 / 0** |
| `/users` | 25 / 17 | 8 / 0 | **1 / 0** |
| `/users/overview` | 20 / 17 | 4 / 1 | **1 / 0** |
| `/account` | 18 / 16 | 1 / 0 | **1 / 0** |
| `/scores` | 16 / 13 | 1 / 0 | **1 / 0** |
| `/fleet-schedules` | 12 / 6 | 7 / 1 🔴 | **1 / 0** |
| `/installations` | 8 / 7 | 1 / 0 | **1 / 0** |
| `/settings/audio-monitoring` | 7 / 6 | 1 / 0 | **1 / 0** |
| `/install` | 6 / 4 | 1 / 0 | **0 / 0** |
| `/login` | 5 / 3 | 1 / 0 | **0 / 0** |
| `/forgot-password` | 3 / 2 | 1 / 0 | **0 / 0** |
| `/accept-invite` | 3 / 2 | 1 / 0 | **0 / 0** |

> **Le « 1 » qui reste partout est le MÊME élément** : le logotype de la top-bar
> (`top-bar-brand-name`, 3,18:1). Il appartient au shell → **bloc G**. Les 4 pages sans
> shell sont donc à **zéro**.

Recette : **aucun débordement horizontal, aucune coupe verticale** sur les 13. Les deux
troncatures sans `title` et les deux cibles sous 44 px sont corrigées. **Plus aucune
cible sous 44 px** sur ces écrans, à l'exception documentée des **168 cellules de carte
de chaleur à 10×11** de `/reports` — décision en attente (§ 12).

**Non-régression** sur les écrans déjà livrés, remesurés après O5 : `/map` 12/11 → **2/2**,
`/vehicles` 10 → **2**, `/dashboard` 6 → **2**.

> ⚠️ **Le shell pèse 6 échecs en clair sur CHACUNE des 9 pages internes** — soit ~54
> occurrences qui ne sont qu'**un seul** défaut, à traiter au bloc G. Les compter par
> page gonfle les totaux d'un facteur 9. Les relevés ci-dessus les isolent.

### 6bis.2 ⭐ `/fleet-schedules` ne suivait pas le thème de l'application — `7acade4`

Le journal la comptait couverte. Le titre H1 rendait **1,14:1** et « Aperçu & appliquer »
**1,48:1 dans les DEUX thèmes**. Ce n'était pas un défaut de contraste à retoucher :

**La page portait sa PROPRE palette `--fs-*`, qui basculait sur
`@media (prefers-color-scheme: dark)` — la préférence de l'OS.** Or l'application ne pilote
pas son thème par l'OS : c'est `data-theme` sur `<html>` qui commande. **Les deux sont
indépendants.** Mesuré, sur une machine dont l'OS est en sombre et l'app en clair :

```
--fs-text = #e8efec  en data-theme=light   ← la variante SOMBRE
--fs-text = #e8efec  en data-theme=dark
fond du body        = clair
```

Un blanc cassé sur du blanc. **Un utilisateur en thème clair avec un OS sombre ne pouvait
pas lire la page.**

> ⚠️ **À chercher ailleurs** : tout composant qui contient `prefers-color-scheme` est
> suspect du même défaut. C'est un `grep` d'une seconde et ça ne se voit pas autrement —
> la page paraît normale tant que l'OS et l'app sont d'accord.

Corrigé en faisant des `--fs-*` des **alias des jetons du kit**. Deux leçons transférables :

- **DEUX jetons par couleur, pas un** : celui qui *porte du texte* (`--texte-*`) et celui
  qui *remplit une surface* (la couleur pleine). Les confondre est exactement ce qui
  donnait le bouton primaire à 1,48:1.
- **L'encre sur un fond de couleur se choisit par MESURE, pas par règle.** Sur l'accent
  vert, le blanc échoue et `--accent-ink` passe. Sur les gris moyens des avatars, c'est
  **l'inverse** : blanc 4,76:1 contre 3,99 pour l'encre foncée. La règle « l'encre est
  foncée sur un fond accent » vaut pour l'accent, pas pour tout fond coloré.

Résultat : **12 / 6 → 1 / 0**, et `--fs-text` vaut enfin `#0A1311` en clair, `#EAEFED` en
sombre.

### 6bis.3 Le `catch` qui pose un tableau vide — **6ᵉ occurrence, 6ᵉ écran sans rapport**

`/installations` s'ajoute à la liste du § 8.5, avec une **variante inédite** : le `catch`
n'écrase pas un tableau, il laisse `plans` à sa valeur initiale `[]` et ne pose **aucun
état** — juste un `toast.error` **éphémère**.

Vérifié au navigateur, pas sur lecture de code : en faisant échouer `api.list()`, la page
affichait « **Aucun planning d'installation publié pour le moment.** » pendant que le toast
passait et disparaissait. **Le mensonge rassurant restait seul à l'écran.**

> Corollaire pour la suite : chercher le `catch` **ne suffit pas** — il faut regarder si
> un état d'erreur est **posé**, pas seulement si l'erreur est *signalée*. Un toast n'est
> pas un état. `/scores` fait bien `error.set()` et l'affiche (vérifié) ; `/places` aussi.

✅ **Corrigé — `9325d49`.** `<app-zone>` rend les trois états ; l'ordre compte, une erreur
n'est pas un vide et prime sur lui. Vérifié après coup, au navigateur :

| Situation | Ce que la page dit |
|---|---|
| API en panne | « Impossible de charger votre planning » + **Réessayer** — « Aucun planning » **absent** |
| API saine, 0 plan | « Aucun planning d'installation publié » — le message d'origine, intact |

> ⚠️ **Le premier test n'a rien prouvé et a failli passer pour une preuve** : patcher
> `window.fetch` a intercepté **0 appel** — le client API ne passe pas par là. Seul le
> compteur `appelsBloques: 0` l'a signalé. **Une sonde qui n'inspecte rien ne dit rien** ;
> il a fallu remplacer `api.list()` sur l'instance du composant.

### 6bis.4 `verif:accents` est verte et le défaut est à l'écran

[`login.component.ts:126`](apps/web/src/app/features/auth/login.component.ts) écrit
« Mot de passe **oublie** ? » — sans accent — alors que `forgot-password.component.ts:62`
écrit « oublié » correctement, à deux écrans d'écart.

La garde ne le voit pas : `oublie` n'est pas dans sa liste `MOTS`, et **volontairement**,
car « il oublie » est un verbe valide sans accent. C'est le **§ 8.8 appliqué à une autre
garde** : *une garde-liste ne rattrape que ce qu'on y inscrit.* Ne pas conclure d'un
`verif:accents` vert que les accents sont bons — c'est un filet, pas une preuve.

✅ Corrigé (`4ac4b5a`). **La liste n'a PAS été enrichie** : y ajouter `oublie` signalerait
tous les « il oublie » légitimes, et une garde qui crie à tort finit ignorée.

### 6bis.5 Deux motifs transverses que seul un relevé groupé fait apparaître

Aucun n'est visible en regardant une page à la fois :

- **Le logotype « Tracky »** en `text-tracky-light` : 3,34:1 sur les 4 pages auth et
  3,18:1 dans la top-bar du shell. **Un seul motif, 5 écrans.** ✅ Les 4 pages auth sont
  corrigées (`4ac4b5a`) ; **la top-bar reste au bloc G**, avec le même jeton.
- **Les pastilles de rôle et avatars** de `/users` + `/users/overview` : 2,19 à 3,43 en
  clair, et `po-user-avatar admin` tombait à **1,72 en sombre**. ✅ Les deux pages
  reprises **ensemble** (`4ac4b5a`) — même famille, mêmes jetons.

### 6bis.6 ⭐ Deux pièges neufs, payés le 2026-08-14

**1. `min-h-[44px]` ne remonte PAS une cible.** Le plancher global de `styles.css`
(`button, a { min-height: 36px }` sous `pointer: coarse`) est écrit **hors couche**, et
une règle sans couche bat **toujours** une règle placée dans `@layer utilities` — *quelle
que soit la spécificité*. La classe est bien dans le DOM, `getComputedStyle` renvoie
`36px`, et rien ne le signale. **Pour remonter une cible, écrire la règle dans le
composant**, jamais avec un utilitaire Tailwind.

**2. Le panneau ÉMULE `pointer: coarse` à 375 px** — le § 8.10 dit l'inverse et il a été
corrigé. `resize_window` sous 768 px active l'émulation mobile complète (agent Android,
5 points tactiles). **Conséquence directe** : le plancher de 36 px ci-dessus *s'applique*
dans nos mesures, alors qu'on le croyait inerte. C'est lui qui écrasait la classe.

**3. L'accent grave a été payé une 5ᵉ fois** — par moi, dans mes propres commentaires
d'explication, en 5 endroits d'un coup. `pnpm verif:litteraux` les a tous nommés en une
seconde. Le réflexe du § 8.3 fonctionne : **au premier `NG1002`, lancer la garde avant de
chercher quoi que ce soit d'autre.**

---

## 6ter. Fin de B-pages — `/places`, `/alerts`, bloc G (2026-08-14)

### 6ter.1 `/places` — les trois onglets, sans inventer le seuil — `7b617f5`

La planche sépare les deux sections empilées en trois onglets. **Vérifié avant d'écrire**
(§ 8.1) que la donnée pouvait les tenir :

| Onglet | Source | Verdict |
|---|---|---|
| À valider | `stations()` filtrées sur `placeId === null` | ✅ |
| Lieux validés | `places()` | ✅ |
| Zones GPS | `GpsDeadZonesApiService.listForMap(fleetId)` | ✅ **existait déjà, aucun changement de contrat** |

**Toujours PAS fait, et toujours pour la même raison** : la file d'attente « 8/8 · PRÊT À
VALIDER », « 6/8 · EN COURS », « À QUALIFIER » et « Tout valider (3 sûrs) ». Le point est
maintenant **écrit dans le code**, là où la prochaine main regardera.

Deux effets de la séparation, traités : les **passages d'une station validée** auraient
disparu (« À valider » ne montre que ce qui reste à faire) — ils sont rendus sur le lieu
qui en est issu ; et le badge « Lieu de la flotte » a été **retiré** de l'onglet, où plus
rien de validé ne figure.

> ⚠️ **Une cible se mesure DANS LES DEUX SENS.** La règle des 44 px de la page ne posait
> que `min-height` : les boutons à icône seule sortaient à **35 × 44** sans que rien ne le
> signale.

### 6ter.2 `/alerts` — le `catch` menteur sur un écran de SÉCURITÉ — `771832f`

**7ᵉ occurrence du motif du § 8.5**, et la pire de la série. `geofences-list` faisait
`this.geofences.set([])` dans son `catch`. Vérifié au navigateur en partant d'une liste
**non vide** :

| | Liste | Ce que l'écran dit |
|---|---:|---|
| Avant | 1 → **0** | « Aucune géofence configurée » + « Créer votre première zone » |
| Après | 1 → **1** | « Impossible de charger vos géofences » + **Réessayer** |

Faire croire à un exploitant qu'**aucune zone ne surveille sa flotte** est le pire des deux
sens d'erreur. La liste est désormais **laissée intacte** — ce qu'on avait reste vrai.

**Trois classes orphelines** dans l'onglet Règles : `.rs-note`, `.rs-link` et `.rs-off`
étaient posées dans le gabarit sans qu'**aucune règle n'existe nulle part** dans le dépôt.
`.rs-off`, censée montrer qu'une règle est **désactivée**, ne montrait rien.

> C'est le § 8.8 dans sa version la plus discrète : **la classe est bien là, elle ne fait
> rien.** Un `grep` de la classe dans les feuilles de style est le seul moyen de le voir.

### 6ter.3 Bloc G — le shell — `3c3c912`

`B1-PAGES.md § G` **oppose exprès** deux comportements : le bandeau hors ligne **POUSSE**
le contenu, la barre de progression **SE SUPERPOSE**. La barre était conforme ; le bandeau
**se superposait** et masquait les 28 px hauts — la top-bar et le titre de page.

| | top-bar | bandeau | chevauchement |
|---|---:|---:|---:|
| Avant | y = 0 | 0 → 28 | **28 px** |
| Après | y = 28 | 0 → 28 | **0** |

Le bandeau reste absolu (il couvre la sidebar et gère l'encoche) ; c'est le layout qui lui
cède la place — pas un niveau de DOM en plus.

L'accroche hors session est passée à « **Vous savez où sont vos véhicules. Et pourquoi ils
s'arrêtent.** » — le seul changement demandé sur ce shell.

Et la **légende de `/map` ne ressemblait pas aux marqueurs qu'elle décrit** : les pastilles
« P » et « ! » posaient `text-white` en dur alors que `markerInk()` existe, est testé sur
les six couleurs, et encre les vrais marqueurs. **Le jumeau était double** — la même
légende est rendue deux fois (feuille mobile + panneau bureau).

### 6ter.4 ~~Le mode Baanool, NON MESURÉ~~ — ❌ **ce paragraphe était FAUX**

> J'ai écrit ici que le mode « dépend d'une préférence **serveur** que le navigateur ne
> peut pas poser » et je l'ai classé non mesurable. **C'est faux.** Le réglage est un
> bouton dans **`/settings` → Apparence → « Mode interface simplifiée »**. C'est un usage
> normal de l'app, réversible par le même bouton.
>
> **La leçon vaut plus que l'erreur** : « je ne peux pas le mesurer » est une conclusion
> qui se vérifie, exactement comme une mesure. J'avais lu le `computed` qui lit
> `preferences.uiMode` et je me suis arrêté là, sans chercher **qui écrit** cette
> préférence — un `grep uiMode` de dix secondes donnait la réponse.

✅ Mesuré et repris le 2026-08-14 → **§ 6quater**.

---

## 6quater. Bloc J — les interfaces alternatives (2026-08-14) — `6b9a72b`

**Ce bloc n'était dans aucun tableau du suivi.** `B1-PAGES.md § J` couvre trois
interfaces : le **mode veilleur**, le **mode simplifié**, et le menu qui les accompagne.

### 6quater.1 Deux écrans qui ignoraient le thème — corrigés

Même défaut que `/fleet-schedules`, et **même signature au relevé** : des ratios
**identiques en clair et en sombre**, parce qu'une palette figée ne bouge pas avec
`data-theme`.

| Écran | Élément | Avant *(les deux thèmes)* | Après |
|---|---|---:|---:|
| Centre de messages | « Message d'alarme » (onglet actif) | **2,16:1** | ✅ |
| | « Notification » · « Aucune donnée » | 2,85:1 | ✅ |
| Panneau véhicules | « Total(2) » (onglet actif) | **2,16:1** | ✅ |
| | « 53 km/h » | 2,85:1 | ✅ |

**~30 valeurs en dur** reprises sur les jetons. Bilan : **3/3 → 0/0** sur les deux écrans.

> **Le relevé le confirme autrement** : les *ratios distincts* passaient de **5/5**
> (identiques) à **4/4 et 5/6**. Quand les deux thèmes donnent le même nombre de valeurs
> distinctes, c'est déjà un signe — la page ne suit pas le thème.

### 6quater.2 ⭐ Une règle qui faisait l'INVERSE du critère

Les boutons de la carte simplifiée sont déclarés à **44 × 44**… puis un
`@media (max-width: 480px)` les ramenait à **40 × 40**. Sous le plancher, **sur mobile**,
et sur le mode destiné aux utilisateurs qui ont le moins de marge d'erreur.

> **Une règle responsive qui RÉDUIT une cible est un défaut, pas une adaptation.** Les
> espacements se compressent, la cible non. À chercher ailleurs : `grep -n "@media" ` puis
> lire ce que la règle *retire*, pas seulement ce qu'elle ajoute.

Idem « acquitter une alerte » (32 × 32) et les deux boutons d'en-tête (36 × 36).

### 6quater.3 Vérifié conforme — le défaut que la spec nommait est bien corrigé

`B1-PAGES § J` relève : « le réglage promet *toutes les pages restent accessibles*, mais
`dashboard-layout` filtre le menu à 5 entrées ». **Mesuré au navigateur** : le menu garde
**tout** — Tableau de bord, Rapports, Scores et Agenda sont là — et « Paramètres · Revenir
en interface complète » est bien détaché, comme l'exige la règle non négociable.

C'est `groupesComplets()` qui le garantit : le mode simplifié **réutilise la même liste**,
il n'en tient pas une seconde. Une page ajoutée ne peut plus disparaître du mode simplifié.

### 6quater.4 🟠 NON MESURÉ — le mode veilleur

Aucun compte `NIGHT_WATCHMAN` dans la flotte de dev (**1 VIEWER, 1 FLEET_MANAGER, 1
FLEET_ADMIN**, vérifié par `GET /api/users`). Même limite que le rôle DRIVER pour
`/driver` (§ 5.2). Le code est là (`navItems()` réduit la navigation à Véhicules), il n'a
**jamais été vu à l'écran**.

> Pour le mesurer, il faut **un compte veilleur en base**. C'est la même dette que pour le
> conducteur, et elle se réglerait une fois pour les deux.

### 6quater.5 🟠 NON FAIT — l'écran simplifié n'a pas la forme de la planche

La planche `Veilleur et Mode Simplifie Refonte` pose quatre règles pour cet écran :

1. **« Jamais plus de 3 boutons »** — *« une quatrième fonction entre DERRIÈRE l'une des
   trois, jamais à côté »*.
2. **Du langage courant** — *« Où est mon véhicule ? », pas « Carte ». « Anti-vol », pas
   « Surveillance ».*
3. Les garde-fous restent · 4. la sortie vers l'interface complète est toujours visible.

**Mesuré : l'écran porte SEPT boutons ronds**, étiquetés « Menu », « Recentrer »,
« Alertes », « Mon compte », « Véhicules », « Ma position », « Vue satellite » — du
langage d'application, pas du langage courant. La planche montre des boutons **larges
(62-66 px) portant un libellé**, pas des ronds d'icônes.

> ⚠️ **Non fait volontairement : c'est une décision d'écran, pas une correction.** Passer
> de 7 commandes à 3 + une feuille change ce que ces utilisateurs peuvent faire d'un
> geste, et il faut choisir LESQUELLES trois. La planche n'en nomme que deux
> explicitement. **À trancher** (§ 12). Les cibles et les couleurs, elles, étaient
> objectives et sont faites.

---

## 6quinquies. B-mails — les 7 défauts corrigés à la source (2026-08-14) — `a355164`

**21 gabarits réels**, pas 12 (le compteur du § 5.1) ni 19 (la spec § I). La planche
disait l'essentiel : *« une seule fonction `shell()` : corriger là corrige les 19 »*.

| # | Défaut | Correctif |
|---|---|---|
| 1 | Fond sombre **forcé** | Clair par défaut, sombre **seulement** si le client le demande |
| 2 | Vert en aplats | Réservé au filet, au bouton et au logo |
| 3 | **Emoji** (9, dont 3 en e-mail de sécurité) | Supprimés |
| 4 | **15 sujets** en `[Vizyo Tracky] …` | Retirés |
| 5 | Google Fonts par `<link>` | Piles système inline |
| 6 | **2 preheaders sur 19** | 17 ajoutés, un par gabarit |
| 7 | Accents perdus (**texte brut**) | Rétablis |

**Mesuré, pas lu** : les 21 gabarits rendus par la route de prévisualisation
(`/api/admin/emails/templates/:id/preview`, SUPER_ADMIN), sonde de contraste passée sur
le HTML réel → **0 échec**. Avant : `weekly_report` 8, `audio_activation` 6,
`lead_welcome` 6, `quote_client` 5, `alert` 4…

> 💡 **La route de prévisualisation rend les e-mails mesurables.** Injecter le HTML dans
> la page et lui passer la sonde donne un vrai relevé. C'est la seule façon de vérifier un
> e-mail sans l'envoyer.

### ⚠️ Ce qui a été vérifié AVANT d'agir

Retirer `[Vizyo Tracky]` du sujet ne perd la marque que si l'expéditeur la porte.
**Vérifié** : `RESEND_FROM = "Vizyo Tracky <contact@vizyoagency.com>"`. La décision tient.

**Les SMS et les notifications push GARDENT leur préfixe** : leur expéditeur n'a pas de
nom, le préfixe y identifie la source — et deux tests l'exigent. La règle de la planche
vise les **sujets d'e-mail**. `[ESCALADE]` reste aussi : ce n'est pas de la marque, c'est
une information.

### ⚠️ Deux pièges payés, tous deux le même

1. **J'ai basculé les couleurs avec une liste écrite de tête.** Elle a laissé passer
   `#C7CFCB` (**1,59:1**, 9 usages) et un fond `#0C110F`. Corrigé en **énumérant toutes
   les couleurs et en laissant le calcul trancher**. C'est le § 8.8, une troisième fois :
   *une liste ne rattrape que ce qu'on y inscrit.*
2. **Une variable `accent` servait de filet ET de couleur de texte** — « CRITICAL » à
   2,71:1. Exactement le défaut de `/fleet-schedules` (§ 6bis.2) : **deux jetons par
   couleur**. D'où `EMAIL_TEXTE_ALERTE / ATTENTE / SECOND` et `EMAIL_ACCENT_TEXTE`.

`leads.service.ts` **réutilise `shell()`** mais écrivait ses corps en palette sombre :
gabarit clair, contenu sombre, 1,59:1. Le « jumeau » du § 8.7, aligné dans la foulée.

---

## 6sexies. ✅ VÉRIFICATION AVANT PROD (2026-08-14) — l'état réel, mesuré

> Passe demandée avant tout déploiement. **Elle a trouvé une page entière qui se
> déclarait livrée et ne l'était pas** — c'est la justification de l'exercice.

### 6sexies.1 Les contrôles qui n'avaient JAMAIS été lancés

| Contrôle | Résultat |
|---|---|
| **`ng build --configuration production`** | 🟢 **passe** — jamais testé de la refonte, seul `development` l'était |
| `nest build` (API, production) | 🟢 passe |
| `pnpm typecheck` (les 3 paquets) | 🟢 passe |
| `pnpm smoke` | 🟢 5 tests |
| `pnpm lint` | 🔴 **CASSÉ — et depuis toujours** |

> 🔴 **`pnpm lint` ne peut pas tourner.** `apps/api` déclare un script `lint` qui
> appelle `eslint`, mais **eslint n'est ni installé ni déclaré** ; `apps/web` n'a
> **pas de script `lint` du tout**. Ce n'est pas une régression de la refonte — ça
> n'a jamais fonctionné. **Sans impact aujourd'hui** (aucune CI dans le dépôt), mais
> toute CI qui appellerait `pnpm lint` échouerait au premier coup.

**Trois budgets CSS dépassés** au build production (`vehicle-detail` +3,6 ko,
`vehicles-list` +1,3 ko, `map` +6,5 ko). **Préexistants** : vérifié, les deux premiers
fichiers sont identiques à leur état d'avant la séance, et mes ajouts sur `map` sont
dans le gabarit, pas dans `styles:`. Ce sont des *warnings*, le build passe.

### 6sexies.2 ⚠️ `/vehicles/:id` se déclarait « livrée et mesurée »

Le § 5.2 la classe en **nommément livré et mesuré** (bloc C). Elle n'avait jamais été
rouverte depuis O5 : **7 échecs et 7 cibles sous 44 px**, jusqu'à 2,73:1.

> **C'est exactement le défaut que le § 5.2 dénonçait pour les autres blocs**, sur une
> page qui, elle, était nommée. **« Nommément livré » ne veut pas dire « encore
> propre »** : un correctif transverse (O5) change l'état de pages déjà closes.
> **Après un changement de socle, remesurer TOUT — pas seulement ce qu'on a touché.**

Corrigée (`38d3092`) → **0/0**, plus aucune cible hors seuil.

### 6sexies.3 ⭐ Une dette levée parce que sa condition était enfin remplie

`styles.css` portait, mot pour mot : *« On ne retouche pas la classe globale
`.vt-status` : elle habille 29 autres pages, et leur reprise est le chantier du bloc
B. On la RESSERRE dans l'espace dépôt. »*

**Le bloc B est fini.** La règle est remontée dans la classe elle-même, et les quatre
surcharges `.layout--depot` sont parties — elles pointaient sur `--depot-succes`, un
**alias** de `--texte-succes` : elles ne changeaient plus rien.

> **Une dette écrite avec sa condition de levée est une dette qui se solde.** Celle-ci
> le disait : « quand le bloc B sera fini ». Sans cette phrase, la surcharge dépôt
> serait restée pour toujours, et personne n'aurait su pourquoi.

### 6sexies.4 Le relevé complet — 22 surfaces, deux thèmes, 375 px

**Toutes à 0 échec de contraste, 0 cible sous 44 px, 0 débordement, 0 coupe :**

`/dashboard` · `/map` · `/vehicles` · **`/vehicles/:id`** · `/places` · `/alerts` ·
`/reports` · `/scores` · `/agenda` · `/users` · `/users/overview` · `/installations` ·
`/fleet-schedules` · `/settings` · `/settings/audio-monitoring` · `/account` ·
`/integrations` · `/privacy-coverage` · `/fleet-admin/activity` · `/admin/ai-usage` ·
`/login` · `/install` · `/forgot-password` · `/accept-invite` — plus les **21 gabarits
d'e-mail** et les **2 écrans du mode simplifié**.

Seule exception connue et documentée : les **168 cellules 10×11** de la carte de
chaleur `/reports` (§ 12, décision en attente).

### 6sexies.5 ⚠️ Piège d'environnement neuf

**`nest build` casse le `nest start --watch` en cours.** Il réécrit `dist/`, le watch
perd son point d'entrée et l'API meurt sur `Cannot find module dist/main` — sans que
rien ne le signale côté navigateur, sinon des 500 partout.

> Après un `nest build` manuel : **redémarrer l'API**. Et si `/api/health` ne répond
> plus alors que le code compile, c'est la première chose à regarder.

---

## 7. Décisions en attente d'arbitrage — **ne pas trancher seul**

### 7.1 Bloqués par un contrat d'API (5)

| Page | Ce que la planche demande | Ce qui manque |
|---|---|---|
| `/places` | La file d'attente « **8/8 · PRÊT À VALIDER** », « 6/8 · EN COURS », « À QUALIFIER », « Tout valider (3 sûrs) » | `StationGroupDto` porte `passages`, `distinctVehicles`, `avgStopMin`, `lastPriceEur` — **ni seuil, ni statut**. Aucune constante partagée ne définit le « 8 ». |
| `/admin/ai-usage` | « 418 trajets analysés ce mois » sous chaque fonction | `AiUsageBreakdownRowDto` n'a **aucun compteur de résultat** |
| `/admin/ai-usage` | Le ratio consommation / forfait (« 45 % ») | Calculable, mais **expose la marge** — décision commerciale |
| `/integrations` | Le volume par catégorie (« 3 412 trajets ») | Ni `PartnerLinkStatus` ni `PartnerScopeOption` ne le portent |
| `/book/:token` | 3 sorties : être prévenu, appeler, redemander un lien | `PublicBookingLinkDto` n'a **ni téléphone ni endpoint d'abonnement** |

> Pour `/places`, ce qu'il faudrait sur `GET /fleet-places/station-groups` :
> `seuilPassages` **et** un `statut` dérivé **côté serveur**. Inventer le « 8 » côté
> client poserait un nombre qui doit rester d'accord avec la règle de détection du
> serveur — il dériverait en silence.

### 7.2 Décisions d'écran ou de comportement (6)

| Point | Détail |
|---|---|
| ~~**O5 — `--text-tertiary`**~~ | ✅ **TRANCHÉ le 2026-08-14** — *relever le jeton à 4,5:1*. Livré (`8a7c611`). `#8A938F → #656F68` en clair, `#69736E → #848F8A` en sombre, **calculés sur `--surface-quaternary`** (le fond le plus défavorable), pas sur le fond nominal. Gain mesuré : `/reports` 104→5, `/map` 12→2, `/vehicles` 10→2, **zéro échec en sombre sur 11 des 13 pages**. Aucune régression sur les écrans déjà livrés. |
| ~~**Onglet actif**~~ | ✅ **TRANCHÉ le 2026-08-14** — *correctif unique au kit*. Livré (`aa0630a`). Les 5 sélecteurs segmentés pointent sur `--texte-succes`. Convention écrite dans `styles.css`. |
| **Week-end en surveillance permanente** | Moitié de la ligne B1 du panneau surveillance. Touche `scheduleDays`/`scheduleStartTime`/`scheduleEndTime` **et l'armement serveur** — comportement, pas mise en page. |
| **Contrôles de zoom MapLibre** | 29 × 29 px, sous le plancher de 44. |
| **Poignée `.bs-handle-wrap`** | 375 × 36 — sous 44 px en hauteur, mais pleine largeur. Partagée par **toutes** les feuilles de l'app : à trancher au niveau du kit. |
| **Étiquettes de plaque sur téléphone** | La planche les masque (`.mfrm .vk-plate { display: none }`). Non appliqué : `showPlates` est une préférence **persistée** de l'utilisateur. |
| **Liste groupée par défaut sur `/vehicles`** | Cf. § 5.3 n° 3. |
| **Variante critique de `confirm-modal`** | Existe (liseré rouge, plaque à retaper) mais **branchée nulle part**. `B1-PAGES.md` § F la spécifie pour la coupure moteur. Ajouter une saisie à un geste d'urgence est une décision d'écran. |
| **Regroupement des lieux « Discrets »** | La planche écrit « regroupe les plus proches ». **Non livré** — les lieux et zones mortes sont des marqueurs DOM, qui ne se regroupent pas nativement. La phrase affichée a été réécrite pour ne dire que ce qui est fait. |

### 7.3 Non terminé, connu

**La coupure moteur n'est faite qu'à moitié.** Seule la variante critique est branchée.
Reste : compte à rebours pendant les 90 s, raison du refus hors du `title`, 3 sorties sur
l'état non confirmé, avertissement boîtier muet en 3 étapes numérotées.

---

## 8. Les pièges — tous payés au moins une fois

### 8.1 ⭐ Le piège de méthode le plus coûteux : traduire une planche sans vérifier la donnée

Le 2026-08-13, j'ai écrit une légende reprise mot pour mot de la planche. **Deux tiers
étaient faux** parce que ni la donnée ni le rendu ne suivaient. C'est le même défaut que
`MIXTE_SANS_CADRE` (une phrase partagée qui disait l'inverse du système), réintroduit par
excès de fidélité à la maquette.

> **Une décision de planche ne s'écrit pas avant d'avoir vérifié que le code peut la
> tenir.** Et une phrase affichée ne doit promettre que ce qui est implémenté.

Corollaire mesuré le même jour : **une décision de planche se vérifie sur toute la
donnée, pas sur les cas qu'elle illustre.** L'encre sombre des icônes de marqueur, juste
sur les 5 fonds vifs que la planche montre, **régressait** sur le 6ᵉ (le gris « à
l'arrêt », déjà sombre : 5,04 → 3,85). D'où `markerInk()`, qui choisit par **luminance**.

### 8.2 ⭐ Mesurer la surface ajoutée ne suffit pas — mesurer **l'écran**

Sur `/vehicles`, j'ai mesuré la feuille de filtres (0 échec) et je m'en suis contenté.
L'écran entier en avait **14**. Une feuille propre au-dessus d'une liste qui échoue reste
un écran qui échoue.

### 8.3 Les accents graves cassent le build — **6 fois**

Un accent grave dans un commentaire de `template:` ou `styles:` **ferme le littéral**.
`tsc` passe, Angular échoue avec un `NG1002` incompréhensible, et le serveur sert un
bundle périmé. **Écrire `92vh`, jamais entouré d'accents graves.**
→ `pnpm verif:litteraux` le nomme immédiatement. **Le lancer au premier échec de build
inexpliqué.**

> ⚠️ **Et même quand le symptôme ne ressemble PAS à un échec de build** *(payé le
> 2026-08-14)*. `ng serve` était tombé en échec de compilation **et continuait de servir
> le CSS d'avant** : une règle ajoutée était absente du navigateur, ce qui ressemblait
> trait pour trait à un problème de cascade CSS. Dix minutes cherchées du mauvais côté.
> **Une règle qu'on vient d'écrire et que le navigateur ignore : regarder les logs du
> serveur AVANT la cascade.**

### 8.4 « On ne sait pas encore » n'est pas un état connu — **3 fois**

- L'ACC d'un marqueur : télémétrie périmée → **inconnu**, ni « allumé » ni « éteint ».
- La vitesse : hors direct, c'est un **souvenir** → « hors ligne », pas un chiffre.
- Les puces de `/vehicles` : `liveStatus()` vaut `null` tant qu'aucune position live n'est
  arrivée → **ce n'est pas « à l'arrêt »**. Repli sur le drapeau `moving` du REST.

### 8.5 Le `catch` qui pose un tableau vide — **7 fois**, 7 écrans sans rapport

`/fleet-admin/activity` · `/privacy-coverage` · `/integrations` · `/driver` · `/vehicles`
· **`/installations`** · **`/alerts` → géofences** *(les deux le 2026-08-14)*.
À chaque fois le mensonge est **rassurant** et tombe sur l'écran qui sert à vérifier que
tout va bien. **Premier réflexe en reprenant une page : chercher le `catch` et regarder
ce qu'il pose.** `app-zone` existe pour ça — `erreur`, `vide`, `partiel` et `interdit`
sont des états distincts.

> ⚠️ **Chercher le `catch` ne suffit pas — regarder si un ÉTAT est POSÉ.** `/installations`
> ne pose rien du tout : il laisse `plans` à `[]` et signale par un `toast.error`
> **éphémère**. L'erreur est donc *signalée* et l'écran ment quand même, dès que le toast
> s'efface. **Un toast n'est pas un état.**

> `/places` et `/scores` gèrent correctement (`this.error.set(...)`, vérifié à l'écran).

### 8.6 Le même élément qui dit deux choses — **2 fois sur le même marqueur**

- Pastille **rouge** portant « TE002ST · **18** » : la teinte lisait `colorSpeedKmh`, le
  chiffre `speedKmh`.
- Pastille **verte** portant « TE001ST · **0** » : à 0,4 km/h, `speedColor` répond « en
  mouvement » pendant que l'étiquette arrondit à 0.

→ `vitesseAffichee()` : **un seul nombre, arrondi AVANT de choisir la couleur.**
Règle générale : **une valeur dérivée et son affichage partent de la même source.**

### 8.7 Le « jumeau » — une règle corrigée d'un côté seulement

Le panneau desktop et la feuille mobile de `/map` portaient **deux copies identiques** de
la liste des calques. Idem `installation-editor` vs `installations-client`. **Toujours
corriger la source** — un `ng-template` unique rendu par `ngTemplateOutlet`.

### 8.8 Les règles CSS qui cessent de s'appliquer

- **Renommage de classe dans une feuille GLOBALE** → `grep` sur l'ANCIEN nom, pas
  seulement sur le fichier modifié. Trois règles étaient devenues mortes après la reprise
  des marqueurs en SVG.
- **Les listes de noms de classes ne sont pas des garanties.** La règle des 44 px de
  `styles.css` et celle de `map.component.ts` sont des **listes** : elles ne rattrapent
  que ce qu'on pense à y inscrire. Toute nouvelle barre d'onglets doit porter `.tab-btn`.
- Une règle enfermée dans un `@media` qui ne s'applique pas · écrasée plus bas dans la
  même feuille · écrite dans le composant jumeau.

### 8.9 Variables CSS — les quatre formes refusées

`pnpm verif:variables` couvre tout `apps/web/src`.

| Forme | Ce que fait le navigateur |
|---|---|
| `var(--surface)` (inexistante) | déclaration **jetée** — la bordure disparaît |
| `var(--x, #94a3b8)` | l'hexadécimal gagne **toujours** — plus aucun thème |
| `var(--surface, var(--bg-secondary))` | s'affiche juste, mais le nom de tête est mort |
| `var(--color-fg-tertiary)` | déclarée dans `@theme inline` → **non émise dans `:root`** |

> Une variable **posée au rendu** (`setProperty`) doit avoir son **défaut déclaré dans la
> feuille**, pas un repli en ligne. C'est pour ça que `--tracky-color` passe.
> Faux positifs légitimes : `--pill`, `--u`, `--driver-color`, `--chart-height`.

### 8.10 Divers, déjà payés

- **Ne JAMAIS réécrire un fichier source via PowerShell `Set-Content`** — encodage
  corrompu, 47 accents en mojibake, « File appears to be binary ». Utiliser l'outil
  d'édition ou Node (`fs.writeFileSync(p, t, 'utf8')`).
- **`ng test` du web = Karma/Jasmine, pas Jest.** `it.each` et `jest.fn()` ne compilent
  pas et cassent **toute** la suite.
- **Enfants de grille et de flex : `min-width: 0`**, sinon défilement horizontal.
- **Feuilles mobiles : toujours `max-height: Xvh; max-height: Xdvh;`.**
- **Le navigateur peut servir un chunk périmé de `packages/shared`** : pour tout ce qui
  vient du paquet partagé, **la source fait foi**, redémarrer `ng serve` avant de conclure.
- ⚠️ **CORRIGÉ le 2026-08-14 — le panneau ÉMULE BIEN `pointer: coarse`.** `resize_window`
  sous 768 px active l'émulation mobile complète. La règle
  `@media (max-width: 768px) and (pointer: coarse)` **s'applique donc** dans nos mesures.
  Conséquence : le plancher `button, a { min-height: 36px }` de `styles.css` est actif, et
  comme il est écrit **hors couche**, il **écrase les utilitaires Tailwind** (`@layer
  utilities`) quelle que soit leur spécificité. `min-h-[44px]` sur un `<a>` est donc sans
  effet — il faut une règle de composant.
- **Un changement de point de rupture ne se teste qu'en RECHARGEANT** à la largeur voulue
  (le redimensionnement CDP n'émet pas d'événement `change`).

---

## 9. Les sondes — à reposer au début de chaque séance

### 9.1 Sonde de recette (cibles, coupes, débordement)

Le code complet est dans `REPRISE-B-PAGES.md` § « La sonde de recette ».

⚠️ **Trois angles morts à connaître :**
1. Elle **écarte tout ce qui est `position: fixed`** — sur une carte, presque toute
   l'interface. Mesurer les conteneurs fixes séparément.
2. Une **case à cocher enveloppée dans son `<label>`** se signale à 18 × 36 alors que la
   cible réelle est le libellé. Remonter au `closest('label')`.
3. Elle signale les **liens en ligne dans une phrase** : les élargir casserait le texte.

### 9.2 Sonde de contraste — les cinq corrections obligatoires

1. **`color-mix()` se calcule en `color(srgb 0.95 0.98 0.97)`** — des flottants **0-1**,
   pas du 0-255. Toute la palette y passe.
2. **Ne jamais retomber sur du blanc en dur** : lire le fond réel de `body`.
3. **Injecter `*{transition:none!important;animation:none!important}` AVANT toute
   mesure** — le panneau ne composite aucune frame, donc une `transition: all` n'avance
   jamais. *(A produit un faux défaut le 2026-08-13 : une fiche mesurée à
   `translateY(181,7px)` semblait s'ouvrir hors de l'écran.)*
4. **Lire l'alpha et COMPOSER la pile de fonds** jusqu'au premier opaque.
5. **Un élément créé en JS ne reçoit AUCUN style de composant** (pas d'attribut
   `_ngcontent-*`). Exception : les styles **globaux** de `styles.css` s'appliquent bien —
   c'est le cas des marqueurs MapLibre.

### 9.3 ⭐ Les trois réflexes qui rattrapent une sonde menteuse

1. **Lire `document.title` ET `location.pathname` DANS le relevé.** L'onglet dérive — un
   jour, 86 faux défauts rapportés sur la mauvaise page. Arrivé **3 fois** le 2026-08-13.
2. **Vérifier que les valeurs VARIENT.** Un relevé où toutes les lignes portent la même
   valeur mesure la sonde, pas la page. *(Six bandes de couleur toutes à « 8,53 » : la
   boucle temps réel réécrivait ma variable entre l'écriture et la lecture.)*
3. **Vérifier que la sonde avait de la MATIÈRE** (`elementsInspectes > 0`). *(Un
   `inspectes: 0` venait de ce que je mesurais une autre instance d'`app-bottom-sheet`.)*

⚠️ **Ne jamais conclure sur une mesure après une série de rechargements à chaud** : le
HMR remplace la feuille avec un nouvel identifiant d'encapsulation tandis que le DOM
porte encore l'ancien. **Recharger complètement d'abord.**

---

## 10. Contrôles avant commit

```bash
pnpm --filter @vizyo/tracky-web exec ng build --configuration development
pnpm --filter @vizyo/tracky-web exec ng test --watch=false --browsers=ChromeHeadless
pnpm verif:litteraux && pnpm verif:accents && pnpm verif:variables && pnpm verif:couleurs-kit && pnpm verif:confirmations && pnpm verif:contraste
```

**Références au 2026-08-14** : build **développement ET production** verts ·
**`TOTAL: 364 SUCCESS`** (web) · **1918 tests API, 136 suites** · les six gardes vertes.

⚠️ **`pnpm lint` est cassé et l'a toujours été** (§ 6sexies.1) : `eslint` n'est pas
installé côté API, et le web n'a pas de script `lint`. Ne pas l'ajouter à un
enchaînement de contrôles sans le réparer d'abord.

⚠️ **Le build PRODUCTION n'avait jamais été lancé** avant le 2026-08-14. Il passe. Le
lancer **avant chaque déploiement** : `development` ne prouve rien sur les budgets, les
optimisations ni l'AOT strict.

⚠️ **`nest build` tue le `nest start --watch` en cours** — redémarrer l'API après.

⚠️ Un `verify` vert ne prouve rien si la suite web n'affiche pas `TOTAL: <n> SUCCESS`.
⚠️ `api-fetch.spec` est **instable** (état de visibilité du document en headless) :
relancer avant de conclure à une régression.

| Garde | Ce qu'elle attrape |
|---|---|
| `verif:litteraux` | l'accent grave qui ferme un littéral de gabarit |
| `verif:contraste` | les 46 couples **déclarés** (⚠️ **pas** les usages — cf. O5) |
| `verif:accents` | mots français sans accent dans les chaînes affichées |
| `verif:confirmations` | une modale de danger sans `[consequences]` |
| `verif:couleurs-kit` | hex, classes de palette et `rgba()` teintés dans `shared/ui` et `shared/components` |
| `verif:variables` | les `var()` fantômes sur tout `apps/web/src` |

**Commit** : ne stager que ses propres fichiers (§ 4). `apps/api/src/tracker-fix-mode/`
doit rester en modifications locales non commitées.

---

## 11. Le kit — à utiliser, pas à réinventer

- **`<app-zone>`** — les **6 états** rendus une fois : `chargement` (squelette) ·
  `rempli` · `vide` · `erreur` (toujours un recours) · `partiel` (le contenu reste, un
  bandeau nomme ce qui manque) · `interdit` (**nomme la permission**).
  **Le brancher dans les écrans qui gèrent encore leurs états à la main est le vrai
  travail de fond de B-pages.**
- **`<app-bottom-sheet>`** — `[open]`, `ariaLabel`, `hauteur`, **`sansVoile`** (pour les
  feuilles posées sur la carte), `(closed)`. Géométrie de plateforme via `--feuille-*` et
  `--densite-liste` (44 iOS / 56 Android).
- **`<app-confirm-modal>`** — `consequences` chiffrées obligatoires sur un danger.
- **Jetons `--texte-*`** — **le petit texte lisible dans les deux thèmes** :
  `--texte-succes`, `--texte-alerte`, `--texte-attente`, `--texte-info`,
  `--texte-violet`, `--texte-inactif`.
  ⚠️ **`--texte-secondaire` et `--texte-tertiaire` N'EXISTENT PAS** — vérifier avant
  d'employer un nom de cette famille.
  > Règle apprise : un libellé de 10-13 px prend un jeton `--texte-*`, **jamais** la
  > couleur sémantique (`--warning`, `--tracky`, `--danger`) ni le vert de marque.
  > `#10E0A0` en texte donne **1,57:1** en clair ; `--warning` **2,65:1**.
- **`--surface-quaternary`** — ce qui se pose **sur** une carte.
- **`--accent-ink`** — le texte **sur** l'accent.

---

## 12. Prochaines actions, dans l'ordre

- [x] ~~**0. Se remettre en état**~~ · ~~**1. Rouvrir les 13 pages « présumées »**~~ —
      fait le 2026-08-14 (§ 6bis). ⚠️ Le § 3 a gagné **le piège du jeton sans rôle**.
- [x] ~~**2. Les reliquats du § 6bis**~~ — **tous faits** le 2026-08-14, en 3 commits
      (`7acade4` `/fleet-schedules` · `9325d49` `/installations` · `4ac4b5a` les 9 autres).
      **Les 13 pages sont à 0 échec**, hors le logotype de la top-bar qui relève du bloc G.
      Seule exception laissée en décision : les 168 cellules de carte de chaleur (§ 12.5).
- [x] ~~**3. `/places`**~~ · ~~**4. `/alerts`**~~ · ~~**6. Bloc G**~~ — faits le
      2026-08-14 (§ 6ter). **B-pages est clos.**
- [ ] **5. `/vehicles`** — la liste groupée par groupe avec en-têtes. **Bloqué** : c'est
      une décision de comportement, non tranchée (§ 7.2). Le mode `grouped` existe déjà
      comme option du sélecteur de vue ; seul son passage en **défaut** est en attente.
- [x] ~~**7. B-mails**~~ — **livré le 2026-08-14** (§ 6quinquies). 21 gabarits, les
      7 défauts de la planche corrigés, 0 échec de contraste mesuré.
- [x] ~~**8. Le mode Baanool**~~ — mesuré et repris le 2026-08-14 (§ 6quater). Restent
      deux points, tous deux nommés : le **mode veilleur** non mesuré faute de compte
      (§ 6quater.4) et la **forme de l'écran simplifié** (§ 6quater.5), qui est une
      décision d'écran.
- [ ] **9. PROD** — 0/28, jamais commencé : push, déploiement, recette production.
      ⚠️ Le VPS porte **la production** — consigne permanente : ne rien déployer sans
      demande explicite.
      **C'est le SEUL lot restant.** Tout le contenu est livré ET vérifié (§ 6sexies).
      **Prêt côté code** : build production vert, 22 surfaces + 21 e-mails à 0 échec,
      1918 tests API, 364 tests web, six gardes vertes.
      **Deux choses à savoir avant de lancer** : `pnpm lint` est cassé depuis toujours
      (§ 6sexies.1), et **35 commits ne sont pas poussés**.

**Décisions encore à demander — la liste COMPLÈTE, rien d'autre n'est en suspens :**

1. ~~**O5**~~ ✅ tranché le 2026-08-14. · 2. ~~**Onglet actif**~~ ✅ tranché le 2026-08-14.
3. **Le contrat d'API de `/places`** (`seuilPassages` + `statut`) — sinon la page ne peut
   pas montrer le cycle de vie que la planche décrit. **Toujours bloquant** (§ 7.1), et
   c'est le seul point de B-pages livré volontairement incomplet.
4. **La liste groupée par défaut sur `/vehicles`** — décision de comportement.
5. Les **168 cellules 10×11** de la carte de chaleur `/reports` : une grille de données
   dense tombe-t-elle sous le plancher de 44 px ? Les élargir détruirait la lecture
   d'ensemble, qui est tout l'intérêt de l'objet.
6. Les **4 autres points d'API** du § 7.1 (`/admin/ai-usage` ×2, `/integrations`,
   `/book/:token`) — inchangés.
7. Les **6 décisions d'écran** du § 7.2 (week-end en surveillance, zoom MapLibre,
   poignée de feuille, plaques sur téléphone, variante critique de `confirm-modal`,
   regroupement des lieux discrets) — inchangées.
8. La **coupure moteur à moitié faite** (§ 7.3) — inchangée.
9. *(nouveau)* **La forme de l'écran simplifié** (§ 6quater.5) : la planche impose
   « jamais plus de 3 boutons » en langage courant, l'écran en porte **sept** en langage
   d'application. Quelles trois commandes garder — et lesquelles passent derrière ?
10. *(dette d'environnement, pas une décision)* **Aucun compte `NIGHT_WATCHMAN` ni
    `DRIVER`** en base de dev : deux interfaces entières (`/driver`, mode veilleur) sont
    livrées **sans avoir jamais été vues à l'écran**. Un compte de chaque réglerait les
    deux d'un coup.

**Et le rappel qui compte maintenant** : **35 commits ne sont pas poussés.** C'est le
seul obstacle entre le travail fait, vérifié, et la recette.

---

## 13. Annexe — la sonde de contraste, prête à coller

Version validée le 2026-08-13, elle intègre les cinq corrections du § 9.2. À coller dans
`javascript_tool`, puis appeler `__c('app-map')`, `__c('.bs-content')`, etc.

```js
window.__c = (function () {
  const parse = (s) => { if (!s) return null; let m = s.match(/^color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+%?))?\)$/); if (m) { const a = m[4]==null?1:(m[4].endsWith('%')?parseFloat(m[4])/100:parseFloat(m[4])); return {r:parseFloat(m[1])*255,g:parseFloat(m[2])*255,b:parseFloat(m[3])*255,a}; } m = s.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; } if (s==='transparent') return {r:0,g:0,b:0,a:0}; return null; };
  const lum = (c) => { const f=(v)=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);}; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
  const comp = (t,b) => ({r:t.r*t.a+b.r*(1-t.a),g:t.g*t.a+b.g*(1-t.a),b:t.b*t.a+b.b*(1-t.a),a:1});
  const fond = (el) => { const pile=[]; let n=el; while(n&&n.nodeType===1){const c=parse(getComputedStyle(n).backgroundColor); if(c&&c.a>0){pile.push(c); if(c.a>=0.999)break;} n=n.parentElement;} if(!pile.length||pile[pile.length-1].a<0.999){const bb=parse(getComputedStyle(document.body).backgroundColor); pile.push(bb&&bb.a>=0.999?bb:{r:255,g:255,b:255,a:1});} let base=pile[pile.length-1]; for(let i=pile.length-2;i>=0;i--) base=comp(pile[i],base); return base; };
  return function (racine) {
    // Correction n° 3 : sans ça, une transition n'avance jamais (le panneau ne composite pas).
    let s=document.getElementById('__nt'); if(!s){s=document.createElement('style');s.id='__nt';s.textContent='*{transition:none!important;animation:none!important}';document.head.appendChild(s);}
    const h=document.querySelector(racine)||document.body;
    const res={titre:document.title,chemin:location.pathname,largeur:innerWidth,theme:document.documentElement.getAttribute('data-theme'),inspectes:0,ratios:0,echecs:[]};
    const vus=new Set();
    for(const el of h.querySelectorAll('*')){
      if(el.closest('.maplibregl-marker'))continue;           // créés en JS
      const cs=getComputedStyle(el);
      if(cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0')continue;
      const r=el.getBoundingClientRect(); if(!r.width||!r.height)continue;
      const txt=[...el.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
      if(!txt)continue;
      res.inspectes++;
      let fg=parse(cs.color); if(!fg)continue;
      const bg=fond(el); if(fg.a<0.999)fg=comp(fg,bg);
      const l1=lum(fg),l2=lum(bg); const k=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      vus.add(k.toFixed(2));
      const px=parseFloat(cs.fontSize), gras=(parseInt(cs.fontWeight,10)||400)>=700;
      const seuil=(px>=24||(px>=18.66&&gras))?3:4.5;
      if(k<seuil) res.echecs.push({txt:txt.slice(0,28),ratio:+k.toFixed(2),px:Math.round(px),cls:(el.className||'').toString().slice(0,32)});
    }
    res.ratios=vus.size; res.echecs.sort((a,b)=>a.ratio-b.ratio);
    return res;   // ⚠️ vérifier inspectes > 0 ET ratios > 1 avant de croire le résultat
  };
})(); 'sonde posee'
```

**Les deux thèmes en un seul relevé** *(recharger d'abord si des rechargements à chaud
ont eu lieu)* :

```js
(async () => {
  const dodo = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  document.documentElement.setAttribute('data-theme','light'); await dodo(400);
  out.clair = __c('app-map');
  document.documentElement.setAttribute('data-theme','dark'); await dodo(400);
  out.sombre = __c('app-map');
  return out;
})()
```

**Savoir si un échec est à soi ou relève d'O5** — comparer la couleur calculée au jeton :

```js
const sonde = document.createElement('span');
sonde.style.cssText = 'position:absolute;left:-9999px';
document.body.appendChild(sonde);
const resoudre = (e) => { sonde.style.color=''; sonde.style.color=e; return getComputedStyle(sonde).color; };
resoudre('var(--text-tertiary)') === getComputedStyle(document.querySelector('.ma-classe')).color; // true → O5, ne pas toucher
```

---

## 14. Journal de bord

`REFONTE-TRACKY-V2.md` se termine par un tableau « Journal de bord », une ligne par
séance. **Le tenir à jour** : c'est lui qui porte les décisions d'une séance à l'autre.
Le détail des découvertes va dans `REPRISE-B-PAGES.md`.
