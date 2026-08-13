# Suivi de la refonte Tracky v2

> **À quoi sert ce fichier.** C'est le point d'entrée unique pour reprendre le chantier
> dans une nouvelle session, sans rien réapprendre et sans repayer un piège déjà payé.
> Il remplace la lecture de tout l'historique.
>
> Écrit le **2026-08-13**, branche `feat/refonte-tracky-v2`, worktree
> `D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky`.
>
> **Les trois autres fichiers à connaître :**
> | Fichier | Rôle |
> |---|---|
> | `design/B1-PAGES.md` | La spec des pages, bloc par bloc. **L'ordre des blocs y est imposé.** |
> | `REPRISE-B-PAGES.md` | Le journal détaillé, séance par séance. Les découvertes y sont racontées. |
> | `REFONTE-TRACKY-V2.md` | La feuille de route générale + le journal de bord global. |
>
> ⚠️ Le compteur « B-pages 23/57 » du tableau de `REFONTE-TRACKY-V2.md` est **périmé** ;
> le compteur à jour est **46/57**. Ne pas se fier au premier.
>
> ⚠️ Ce compteur compte des **lignes de `B1-PAGES.md`**, pas des pages, et il a été tenu
> à la main de séance en séance. **Il donne un ordre de grandeur, pas une preuve.** La
> seule preuve est le § 5.2 ci-dessous, et la mesure au navigateur.

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

⚠️ L'identifiant de seed `cdef31-admin` **ne marche pas** (`/api/auth/me` répond 500) —
prendre un `authUserId` en forme de cuid.
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
| **B-pages** | 🟡 **en cours** | **46/57** |
| **B-mails** | ⬜ à faire | 0/12 |
| **PROD** | ⬜ à faire | 0/28 |

### 5.2 B-pages, bloc par bloc — **l'ordre est imposé par `B1-PAGES.md`**

⚠️ **Lire d'abord cette mise en garde.** Le journal note « Bloc A ✅ terminé » en ne
citant que **3 pages sur les 7** que `B1-PAGES.md` liste au bloc A, et « contenu propre
de D et E ✅ terminé » en n'en citant que **5 sur 14**. Le tableau ci-dessous distingue
donc ce qui est **nommément confirmé livré et mesuré** de ce qui est **présumé** — et il
ne faut pas traiter un « présumé » comme fait sans l'avoir rouvert au navigateur.

| Bloc | Nommément livré et mesuré | Présumé / à re-vérifier |
|---|---|---|
| **A** — Entrée & conducteur (7) | `/book/:token` · `/reserve/:token` · `/driver/unlock` | `/login` · `/forgot-password` · `/accept-invite` · `/install` — le journal les dit couvertes mais ne les nomme pas |
| **B** — Espace conducteur (1) | `/driver` 🟢 | — *(⚠️ mesuré avec un compte fleet-admin : aucun compte DRIVER en base, le périmètre réel d'un conducteur n'a **pas** été vérifié)* |
| **C** — Supervision (6) | `/dashboard` · `/vehicles/:id` · **`/map`** · **`/vehicles`** | **`/places` 🟠 partiellement bloqué** · **`/alerts` ⬜ pas commencé** |
| **D** — Analyse (5) | `/fleet-admin/activity` · `/admin/ai-usage` | `/reports` *(seule la carte de chaleur est citée)* · `/scores` · `/agenda` |
| **E** — Administration (9) | `/settings` · `/integrations` · `/privacy-coverage` | `/users` · `/users/overview` · `/installations` · `/fleet-schedules` · `/settings/audio-monitoring` · `/account` |
| **F** — Surfaces bloquantes (12) | 🟢 **clos 12/12**, séance du 2026-08-11 | — |
| **G** — Le shell (2) | — | ⬜ **EN DERNIER**, ordre non négociable |

> **Première chose à faire dans la nouvelle session** : passer la sonde de recette et la
> sonde de contraste sur les **11 pages de la colonne « présumé »**, à 375 px dans les
> deux thèmes. C'est rapide (une page ≈ 2 min) et ça transforme une incertitude en fait.
> Vu le taux de trouvailles des séances précédentes — O5 touche ~29 écrans et le `catch`
> menteur a été trouvé 5 fois — il est **peu probable** qu'elles soient toutes propres.

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
| **O5 — `--text-tertiary`** | Jeton **3:1** employé comme couleur de texte. C'est **la source de la quasi-totalité des échecs de contraste restants** (3,16 en clair / 3,75 en sombre). Touche ~29 écrans. `verif:contraste` ne le verra jamais : il vérifie les 46 couples **déclarés**, pas les usages. |
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

### 8.3 Les accents graves cassent le build — **4 fois**

Un accent grave dans un commentaire de `template:` ou `styles:` **ferme le littéral**.
`tsc` passe, Angular échoue avec un `NG1002` incompréhensible, et le serveur sert un
bundle périmé. **Écrire `92vh`, jamais entouré d'accents graves.**
→ `pnpm verif:litteraux` le nomme immédiatement. **Le lancer au premier échec de build
inexpliqué.**

### 8.4 « On ne sait pas encore » n'est pas un état connu — **3 fois**

- L'ACC d'un marqueur : télémétrie périmée → **inconnu**, ni « allumé » ni « éteint ».
- La vitesse : hors direct, c'est un **souvenir** → « hors ligne », pas un chiffre.
- Les puces de `/vehicles` : `liveStatus()` vaut `null` tant qu'aucune position live n'est
  arrivée → **ce n'est pas « à l'arrêt »**. Repli sur le drapeau `moving` du REST.

### 8.5 Le `catch` qui pose un tableau vide — **5 fois**, 5 écrans sans rapport

`/fleet-admin/activity` · `/privacy-coverage` · `/integrations` · `/driver` · **`/vehicles`**.
À chaque fois le mensonge est **rassurant** et tombe sur l'écran qui sert à vérifier que
tout va bien. **Premier réflexe en reprenant une page : chercher le `catch` et regarder
ce qu'il pose.** `app-zone` existe pour ça — `erreur`, `vide`, `partiel` et `interdit`
sont des états distincts.

> `/places` est le **seul** écran qui le gère correctement (`this.error.set(...)`).

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
- **Le panneau n'émule pas `pointer: coarse`** — la règle
  `@media (max-width: 768px) and (pointer: coarse)` n'est jamais appliquée dans nos
  mesures. C'est le cas défavorable, donc la mesure reste valable.
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

**Références au 2026-08-13** : build vert · **`TOTAL: 364 SUCCESS`** · les six gardes vertes.

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

- [ ] **0. Se remettre en état** — `git log --oneline -5` (la branche bouge, § 4) ·
      `docker compose up -d` · `preview_start` × 2 · frapper un jeton · poser les deux
      clés de `localStorage`.
- [ ] **1. Rouvrir les 11 pages « présumées »** du § 5.2 avec les deux sondes, à 375 px,
      dans les deux thèmes. **Ne rien corriger d'abord — relever.** Puis décider.
- [ ] **2. `/places`** — la partie faisable sans toucher à l'API : onglets
      *À valider / Lieux validés / Zones GPS*, `<app-zone>`, mesure des deux thèmes.
      ⚠️ La file d'attente avec seuil est **bloquée** (§ 7.1) — ne pas inventer le « 8 ».
- [ ] **3. `/alerts`** — onglets *Alertes / Géofences / Réglages*. Pas commencé.
- [ ] **4. `/vehicles`** — la liste groupée par groupe avec en-têtes, **si** la décision
      de comportement est tranchée (§ 7.2).
- [ ] **5. Bloc G — le shell.** En dernier, ordre non négociable de `B1-PAGES.md`.
- [ ] **6. B-mails** — 12 lignes, 0 faite.

**Décisions à demander avant de reprendre** — elles débloquent le reste :

1. **O5** (`--text-tertiary` employé comme couleur de texte). C'est la source de la
   quasi-totalité des échecs de contraste restants sur toutes les pages mesurées.
   **Tant qu'il n'est pas tranché, chaque page livrée gardera ses 8 à 10 échecs.**
2. **Le contrat d'API de `/places`** (`seuilPassages` + `statut`) — sinon la page ne peut
   pas montrer le cycle de vie que la planche décrit.
3. La liste groupée par défaut sur `/vehicles`.

**Et un rappel qui ne coûte rien** : **15 commits ne sont pas poussés.**

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
