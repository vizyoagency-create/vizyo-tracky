# Reprise — Lot A3 : l'espace dépôt

> ⚠️ **Historique — passation consommée** *(bandeau posé le 2026-08-22)*. A3 et A4 ont été
> **livrés** (97/98 et 97/98 au tableau de bord de `REFONTE-TRACKY-V2.md`), le bloc B a
> été débloqué le 2026-08-10, et la refonte est fusionnée dans `main` depuis le
> 2026-08-16. Le prompt de démarrage ci-dessous ne doit plus être exécuté.

> Document de passation, écrit le 2026-08-09 à la fin de la session qui a livré
> l'Étape 0, A1, A2 et A5. **Tout ce qu'il faut pour reprendre sans relire 20 commits.**
>
> Branche : `feat/refonte-tracky-v2`, poussée sur `origin`.
> Roadmap complète : `REFONTE-TRACKY-V2.md` (590 cases à cocher).
> Spécifications : `design/*.md`.

---

## 1. Le prompt à coller

```
Reprends la refonte Tracky sur la branche feat/refonte-tracky-v2.

Lis REPRISE-A3.md en entier — il contient l'état du chantier, l'environnement,
les pièges déjà payés et ce qu'il faut réutiliser. Puis lis design/A3-ESPACE-DEPOT.md,
qui est la spécification du lot à implémenter.

Implémente le lot A3 (l'espace dépôt : route /depot, 4 onglets, 6 modales, en
3 déclinaisons PC / iOS / Android). Coche les tâches dans REFONTE-TRACKY-V2.md
au fur et à mesure. Termine par les 10 critères de recette de la section 9 d'A3,
puis commite.

Trois règles non négociables :
1. Le périmètre du rôle DEPOT se contrôle CÔTÉ REQUÊTE, jamais côté affichage.
   Hors périmètre, l'API répond 403 — jamais 200 avec un tableau vide.
2. Aucun compteur de flotte, aucune donnée de coût, de score ou de consommation
   ne doit apparaître dans un écran dépôt.
3. Vérifie chaque écran DANS LE NAVIGATEUR avec le jeu d'essai réel
   (prisma/seed-depot.ts). Les tests unitaires ne voient pas ce qui compte ici.

Ne modifie aucun DTO ni contrat d'API existant sans me demander.
```

---

## 2. Le projet en trois phrases

**Vizyo Tracky** est une plateforme de gestion de flottes GPS. Monorepo pnpm :
`apps/api` (NestJS 11 + Prisma 7 + PostgreSQL/PostGIS), `apps/web` (Angular 20
standalone + signals + Tailwind 4 + MapLibre), `packages/shared` (DTO et permissions
partagés — **source unique de vérité**).

Le chantier en cours est une refonte en deux blocs, spécifiée dans `design/` :
**bloc A** = l'espace dépôt (fonctionnalité neuve), **bloc B** = la refonte des
29 pages existantes.

**Le besoin du bloc A** : un transporteur veut ouvrir un accès en lecture à ses
donneurs d'ordre. Pas un accès à sa flotte — un accès **aux camions engagés sur les
missions de ce dépôt, pendant ces missions**. Cas de référence : 7 camions, un dépôt
doit en voir 4 le matin, aucun le soir, et jamais les 3 autres.

---

## 3. Ce qui est déjà livré

| Lot | État | Contenu |
|---|:-:|---|
| Étape 0 | 🟢 | `design/DECISIONS.md` (11 décisions), `TOKENS.md`, `ICONS.md` · jetons violet/bleu créés · `--accent-ink` corrigé (3,43 → 5,54:1) |
| **A1** | 🟢 | Rôle `DEPOT`, 4 permissions, `DepotScopeService` + garde, modèle `Mission`, isolation socket, gardes web, **12 tests d'isolation verts** |
| **A2** | 🟢 | Missions complètes : création, statut dérivé, 4 effets de bord, conflit niveaux 1 et 2, onglet agenda, modale, déclinaisons mobiles, bandeau fiche véhicule |
| **A5** | 🟢 | Verrous des comptes, invitation, liste, matrice à 6 colonnes avec ◆, e-mail version dépôt |
| **A3** | ⬜ | **Le lot à faire** |
| A4 | ⬜ | Le lien public de partage — après A3 |
| Bloc B | 🔴 | Bloqué : il manque les 27 `.dc.html` dans `design/maquettes/` |

**Vérification au dernier commit** : typecheck 3/3 · smoke 5/5 · **1841 tests API**
(131 suites) · 277 tests partagés · build web vert · **isolation 31/31** contre la
base réelle.

---

## 4. Les décisions déjà prises — ne pas les rouvrir

Toutes sont écrites et motivées dans `design/DECISIONS.md`. Les cinq qui pèsent
sur A3 :

**D1 — la police.** Le livrable dit que l'app est en Poppins et demande de tout
mesurer. C'est faux : elle est en **Manrope** depuis le commit `ec20139`. La planche
de contrôle est sans objet.

**D3 — `DEPOT` est un rôle latéral**, pas un rang. Il n'entre dans aucune comparaison
de niveau. Son périmètre n'est pas un sous-ensemble de la flotte : c'est un axe
différent (la mission).

**D6 — violet et bleu ont été créés** dans `styles.css`, en clair et en sombre.
Le **violet est la couleur du dépôt** dans tout le système.

**D11 — le modèle `Mission` a migré en A1**, pas en A2 : sans lui, l'isolation ne
compilait pas.

**Le socle de plateforme existe** (`shared/utils/platform.ts` + jetons CSS). Les
3 écarts iOS/Android sont **volontaires** : poignée 36×5 vs 32×4 · rayon 22 vs 28 px ·
densité 44 vs 56 px. Aucun composant ne teste la plateforme dans son template.

---

## 5. Remonter l'environnement (5 minutes)

```bash
pnpm docker:up
pnpm --filter @vizyo/tracky-api exec prisma migrate deploy
pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed.ts
pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-depot.ts
```

### Le jeu d'essai est l'outil principal

`prisma/seed-depot.ts` recrée le **cas de référence d'A0** et il est idempotent :

| Élément | Détail |
|---|---|
| 7 camions | avec boîtier et position fraîche |
| **2 dépôts concurrents** | `depot.fenouillet@exemple.fr` (A) et `depot.muret@exemple.fr` (B) |
| 6 missions | en cours, planifiée, terminée, en retard, celle du dépôt B, une interne |
| **1 camion témoin** | `FR-903-HC` — aucune mission, invisible de tout dépôt |

C'est ce jeu qui rend l'isolation **observable** : un dépôt qui verrait 8 camions,
ou 0, se remarque immédiatement. Le second dépôt est indispensable — sans lui, on ne
peut pas vérifier qu'un dépôt ne voit pas les missions d'un autre.

Ce qu'on doit observer : dépôt A → 4 missions, 2 positions servies · dépôt B →
1 mission · onglet Missions → 5 véhicules indisponibles.

### Serveurs et jetons

`preview_start` avec `web-refonte` (port **4205**) et `api-refonte` (port 3000).
⚠️ Le port 4200 est occupé par un **autre projet** (Maalem) — ne pas s'y fier.

```bash
pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts seed-depot-a
```

`seed-depot-a` / `seed-depot-b` = les deux dépôts · `seed-gestionnaire` = un
FLEET_MANAGER de la flotte de démonstration (les variables `VIZYO_AUTH_*` viennent
du `.env`).

### Vérifier

```bash
pnpm typecheck && pnpm smoke && pnpm --filter @vizyo/tracky-api test
bash apps/api/prisma/verif-depot-http.sh                              # 31/31
pnpm --filter @vizyo/tracky-api exec ts-node prisma/verif-depot.ts    # 17/17
```

---

## 6. Les six pièges déjà payés

1. **`pnpm verify` ne se termine JAMAIS.** `turbo run test` embarque le `ng test`
   d'`apps/web`, lancé sans `--watch=false` : karma ouvre un navigateur et attend
   indéfiniment (mesuré : 25 min à CPU nul). Employer le périmètre du § 5.

2. **Le script HTTP produit des échecs fantômes sous charge.** Lancé juste après
   Jest, les `curl` expirent et de faux échecs apparaissent. Relancer machine au
   repos — constaté trois fois.

3. **Le cache de build Angular peut faire MENTIR un écran.** La matrice affichait les
   droits du *Lecteur* dans la colonne Dépôt alors que la source et le `dist` étaient
   corrects : le bundle portait un `getDefaultPermissions` sans le cas `DEPOT`.
   Aucun test, aucun typecheck ne bronche. Au moindre écart inexplicable entre le code
   et l'écran : `rm -rf apps/web/.angular/cache`.

4. **`:host-context()` est obligatoire** pour cibler `body.plat-*` depuis les styles
   d'un composant. L'encapsulation émulée réécrit un sélecteur d'ancêtre en
   `body.plat-ios[_ngcontent-xxx]` — attribut collé sur `body`, qui ne le porte pas.
   La règle **échoue en silence**.

5. **Pas de backtick dans un commentaire** à l'intérieur d'un `template:` ou
   `styles: [\`…\`]` : il termine le littéral et casse la compilation. Erreur faite
   deux fois.

6. **Le front ne retombe pas sur les défauts de rôle.** Il lit
   `user.permissions?.[perm] === true`. Un compte avec `permissions: null` se voit
   **tout refuser** côté client, contrairement au backend. Écrire des permissions
   explicites sur les comptes de test.

---

## 7. Ce qu'A3 doit réutiliser, pas réinventer

### Backend

| Existant | À savoir |
|---|---|
| `DepotScopeService` | `missionsFor`, `canSeeLivePosition`, `canSeeTrip`, `canSeeMission`, `activeMissionIds` |
| `DepotScopeGuard` | **Refus par défaut** : toute route `/depot/*` doit porter `@DepotScope(...)` ou `@DepotScopeBorneParLeService()`, sinon elle rend 403 |
| `DepotService` | Le `select` Prisma explicite **EST** le contrat de fuite. Ce qui n'est pas sélectionné ne peut pas fuir |
| `maskPhone` | Masque **côté serveur**. Le numéro complet ne doit jamais transiter |
| `DepotMissionDto` | Le contrat exact de ce qu'un dépôt reçoit (A1 § 4) |

**3 des 8 endpoints d'A1 § 4 existent** : `GET /depot/missions`, `/depot/missions/:id`,
`/depot/missions/:id/position`. **Restent à créer** : `/depot/history`,
`POST /depot/exports`, `GET /depot/documents`, `POST /depot/incidents`,
`GET /depot/trips/:id`.

### Frontend

`features/depot/` existe avec `depot.routes.ts` et `depot-home.component.ts` (l'état
vide). Le shell a un mode dépôt (`auth.isDepot()`), pour l'instant **une seule entrée
de nav** — les trois autres arrivent avec leurs écrans.

Kit à réutiliser : `mini-map`, `bottom-sheet`, `confirm-modal`, `toast`, `skeleton`,
`pdf-export-modal`. Le composant de carte se réutilise depuis `/map` **avec une
configuration restreinte** : pas de géofences, pas de lieux clés, pas de sélecteur de
véhicules.

Socle de plateforme : `shared/utils/platform.ts`, jetons `--feuille-rayon`,
`--feuille-poignee-l/h`, `--densite-liste`.

---

## 8. Ce qu'A3 demande — résumé

Lire `design/A3-ESPACE-DEPOT.md` en entier. L'essentiel :

**4 onglets** : Carte live (`/depot`) · Missions · Historique · Documents.
**6 modales** : détail trajet, détail camion, incident, export, onboarding, partage
(le partage relève d'A4).

**Les points que la spec insiste à ne pas rater :**

- **L'encart qui NOMME ce qui est absent** — « Les 3 autres camions de votre
  transporteur ne sont pas sur vos missions : ils ne vous sont pas visibles. » Sans
  cette phrase, un dépôt qui sait que le transporteur a 7 camions croit l'outil cassé.
  Avec elle, l'absence devient une garantie. C'est l'argument qui a permis au
  transporteur d'ouvrir l'accès.
- **L'état vide est le plus important à soigner** : c'est le premier écran d'un
  nouveau dépôt.
- **Jamais une position périmée présentée comme actuelle** : « indisponible depuis
  14 min ».
- **Les KPI de l'historique sont calculés côté serveur** ; le « % à l'heure » est la
  note du transporteur.
- **Conservation 12 mois écrite dans l'interface**, pas seulement dans les CGU.
- **Aucun identifiant interne**, ni à l'écran ni dans l'URL. La plaque est la clé.
- **Lecture seule partout** : les deux seules écritures d'un dépôt sont signaler un
  incident et générer un lien de partage.

**Les 10 critères de recette** sont en section 9 du document.

---

## 9. Les règles permanentes du chantier

**RÈGLE 1** — Une maquette est une référence de conception, pas du code. Aucun style
en ligne recopié.

**RÈGLE 2** — Le périmètre du rôle `DEPOT` se contrôle **côté requête**, jamais côté
affichage. Le `where` Prisma porte toujours `depotUserId`. Hors périmètre : `403`,
jamais `200 []`. Identifiant inconnu et hors périmètre rendent le **même** code.

**RÈGLE 3** — Une couleur = une signification. vert = succès · rouge = échec/retard ·
ambre = attente · bleu = information · **violet = dépôt** · gris = inactif.

**RÈGLE 4** — Le vocabulaire est fixé. Dans l'interface du dépôt on ne dit **jamais**
« flotte », « véhicule de la flotte » ni « société » : on dit « le camion », « votre
transporteur », « votre mission ».

**RÈGLE 5** — Exigent un accord préalable : modifier un DTO ou un contrat d'API
existant · changer une logique métier · supprimer une fonctionnalité · ajouter une
dépendance npm · élargir le périmètre du rôle `DEPOT` au-delà d'A1.

**RÈGLE 6** — Un lot terminé = ses critères de recette exécutés, puis un commit, puis
un point de contrôle. Jamais deux lots non vérifiés cumulés.

**RÈGLE 7** — « `pnpm verify` vert » n'existe pas ici (cf. piège 1). Un échec de test
se trie en relançant la suite seule et en comparant à une référence.

---

## 10. La leçon de la session précédente

Les 1841 tests et le typecheck ont validé le code. Ce sont **les écrans et la base
réelle** qui ont trouvé ce qui comptait :

- 8 routes de `trip-analysis` servaient scores, carburant et coûts à un dépôt
- `clampPermissions` bornait au *granter*, jamais à la *cible*
- l'acceptation d'invitation créait un scope `ALL` pour tout le monde, dépôt compris —
  toute l'isolation serait tombée à la première invitation acceptée
- le rôle qui possède les missions ne pouvait pas atteindre son propre écran
- une course entre requêtes affichait un camion occupé alors qu'il était libre

**A3 est le lot où l'isolation devient visible.** Jusqu'ici elle était prouvée par des
`403` ; désormais elle se voit — ou ne se voit pas — dans une carte, une liste et un
historique. Vérifier dans le navigateur, avec le jeu d'essai, n'est pas optionnel.
