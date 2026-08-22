# Refonte Tracky v2 — Roadmap d'implémentation

> ⚠️ **Historique — journal arrêté au 2026-08-14** *(bandeau posé le 2026-08-22)*. La
> refonte a été **fusionnée dans `main` le 2026-08-16** et déployée. Attention aux cases :
> à partir des lots A, seuls le tableau de bord et le journal ont été tenus — des
> centaines de cases restées décochées (A1/A2/A5, B-pages, B-mails) correspondent à du
> travail **livré et recetté**. Ne pas s'y fier pour juger l'avancement ; le reliquat réel
> est dans `ETAT-RESTE-A-FAIRE-2026-08-22.md`.

> Fichier de suivi unique. Une case cochée = tâche **terminée et vérifiée**, pas « écrite ».
> Branche : `feat/refonte-tracky-v2` (partie de `main` le 2026-08-09).
> Spécifications source : `design/*.md` (livrable Claude Design du 2026-08-09).

---

## Tableau de bord

| Lot | Objet | Bloquant pour | État | Avancement |
|---|---|---|:-:|:-:|
| **Étape 0** | Socle : `design/DECISIONS.md`, `TOKENS.md`, `ICONS.md` | tout | 🟡 quasi livré | 27 / 32 |
| **A1** | Rôle `DEPOT`, permissions, isolation backend | A2 A3 A5 | 🟢 **livré** | 68 / 76 |
| **A2** | Modèle `Mission`, agenda, indisponibilité véhicule | A3 A4 | 🟢 **livré** | 93 / 103 |
| **A5** | Invitation, comptes dépôt, matrice | — | 🟢 **livré** | 38 / 44 |
| **A3** | Espace `/depot` : 4 onglets × 3 plateformes | A4 | 🟢 **livré** | 97 / 98 |
| **A4** | Lien public `/s/:token`, expiration, révocation | — | 🟢 **livré** | 97 / 98 |
| **B0′** | Reliquat socle : couleurs en dur, UTC, accents, wizard | Bloc B | 🟢 **livré** | 27 / 28 |
| **B-kit** | Kit partagé : 6 états sur 24 composants | pages B | 🟢 **livré** | 26 / 28 |
| **B-pages** | 29 pages refondues × 3 déclinaisons | — | 🟢 **livré** | 57 / 57 |
| **B-mails** | 21 gabarits d'e-mail *(19 annoncés, 21 réels)* | — | 🟢 **livré** | 21 / 21 |
| **Bloc J** | Interfaces alternatives : veilleur, mode simplifié | — | 🟡 **2 modes / 3** | 2 / 3 |
| **PROD** | Push, déploiement, recette production | — | ⬜ à faire | 0 / 28 |
| | | | **Total** | **565 / 607** |

¹ **Débloqué le 2026-08-10** : les 28 planches `.dc.html` sont dans `design/maquettes/`, avec
leur `support.js` et le dossier `brands/`. Cf. « Écart 1 » ci-dessous. Ordre d'attaque non
négociable (`B1-PAGES.md` § « Ordre d'implémentation ») : **le kit avant les pages, le shell
en dernier** — le brancher trop tôt force à trancher la navigation avant d'avoir vu les pages
vivre.

**Légende d'état** : ⬜ à faire · 🟡 en cours · 🟢 livré et vérifié · 🔴 bloqué · ⏸️ en attente de validation

---

## Ce que l'analyse a révélé — trois écarts entre la spec et le dépôt

À lire avant toute implémentation. Ces trois points modifient le livrable ; ils sont
tranchés ici une fois pour toutes.

### Écart 1 — ~~Les 27 maquettes ne sont pas dans le livrable~~ ✅ **résorbé le 2026-08-10**

> **Les planches sont arrivées.** `design/maquettes/` contient 28 `.dc.html`, leur
> `support.js` et `brands/` (7 logos), copiés à l'octet près. `00-INDEX.md` donne la
> correspondance planche → routes.
>
> Trois écarts relevés à la réception :
> **28 planches et non 27** — `Loaders-Splash` et `Vehicules Refonte` s'ajoutent à la
> liste de `B1-PAGES.md` · **`Video Depot.dc.html` manque**, mais elle était notée
> « support commercial, pas une spec » : rien n'en dépend · **le piège n° 1 de l'index
> est périmé** — il demande de traduire Manrope → Poppins, or c'est l'inverse qui s'est
> produit (cf. Écart 2 ci-dessous), l'application tourne déjà en Manrope.
>
> **B-kit, B-pages et B-mails sont débloqués.** Ordre non négociable de `B1-PAGES.md`
> § « Ordre d'implémentation » : le kit d'abord, les pages ensuite, le shell en dernier.

Le texte ci-dessous est conservé tel qu'écrit le 2026-08-09, pour mémoire.

`00-LISEZ-MOI.md` et `PROMPT-CLAUDE-CODE.md` § 0 les listent comme à copier dans
`design/maquettes/`. Le livrable reçu ne contient que les 10 `.md`. Or `B1-PAGES.md` dit
lui-même : « *Il ne remplace pas les maquettes : il dit ce qu'on y cherche.* »

**Décision (2026-08-09, validée)** : le bloc A s'implémente maintenant — ses six documents
portent modèles Prisma, DTO exacts, endpoints, règles métier et critères de recette, sans
dépendance visuelle. Le bloc B attend la livraison des `.dc.html` dans `design/maquettes/`.
Ses tâches sont écrites intégralement ci-dessous mais restent **bloquées**.

- [x] Les fichiers `.dc.html` sont présents dans `design/maquettes/` → **débloque le bloc B**
      (28 planches livrées le 2026-08-10, plus `support.js` et `brands/`)

### Écart 2 — La prémisse « Poppins » de B0 est périmée

`B0-SOCLE.md` § « Écart 1 — La police » demande de mesurer Poppins (plus large que Manrope)
sur la nav, les pastilles, les tuiles de KPI, et pose cette « planche de contrôle » comme
gate absolu de toute la refonte.

**Constat dans le dépôt** : l'application tourne **déjà en Manrope**.
`apps/web/src/styles.css:17-18` déclare `--font-display: 'Manrope'` et `--font-sans:
'Manrope'`, avec le commentaire `/* était Poppins */` ; `@fontsource/manrope` est en
dépendance (`apps/web/package.json:25`), Poppins n'est installé nulle part. Le changement
date du commit `ec20139 feat(ui): refonte tokens design étape 1 (Manrope + palette DS
émeraude)`.

Les 20 occurrences restantes de `Poppins` sont des **fallbacks morts** de la forme
`var(--font-display, Poppins, sans-serif)` : la variable étant toujours définie, la valeur
de repli n'est jamais atteinte. Elles induisent en erreur toute lecture ultérieure.

**Décision** : la planche de contrôle mesurée devient sans objet — maquettes et application
partagent la même police. Le risque de débordement disparaît. Est conservée à sa place une
tâche réelle : purger les 20 fallbacks morts, et faire passer un contrôle de non-débordement
malgré tout (coût nul, filet de sécurité). La décision est actée dans `design/DECISIONS.md`.

### Écart 3 — Une partie du bloc B est déjà faite

`B1-PAGES.md` § H liste 24 composants partagés à produire. **23 existent déjà** dans
`apps/web/src/app/shared/ui/` et `shared/components/` : `connectivity-badge`,
`confirm-modal`, `bottom-sheet`, `toast`, `skeleton`, `spinner`, `pdf-export-modal`,
`date-range-picker`, `datetime-range`, `driver-picker`, `alerts-bell`, `group-badge`,
`install-banner`, `install-review-badge`, `super-admin-context`, `charts`, `mini-map`,
`metric-card`, `brand-logo`, `logo`, `theme-toggle`, `trip-note-modal`,
`update-required-modal`, `plan-upsell`, `push-prompt`.

Posés par les commits « refonte étape 1/2/3 » (`ec20139`, `698fb80`, `6517477`).

**Décision** : le lot B-kit n'est pas une construction mais une **passe de raffinement** —
les 6 états obligatoires, la purge des couleurs en dur, l'alignement sur les jetons. Le
redesign page par page reste, lui, entier, et exige les maquettes.

### Points de la spec vérifiés exacts — rien à corriger

`permissions.ts:18` (déclaration `UserRoleSlug`) · `ReservationBookingLink` à
`schema.prisma:2011` · modes veilleur et simplifié filtrés dans
`dashboard-layout.component.ts` (`isWatchman()`, `isBaanoolMode()`) · indisponibilité
véhicule portée par `VehicleEvent.blocksVehicle` + `reservations.service.ts`
(`findOverlaps`, `availableForFleet`) · rooms socket `pos:fleet:*`, `ops:fleet:*`,
`fleet:*`, `alerts:fleet:*` · module `invitations` · `email.service.ts` → `shell()` ·
`PermissionsResolverService` (`VEHICLE > GROUP > ALL`).

*(Note mineure hors périmètre : `README.md` annonce Leaflet, le dépôt utilise
`maplibre-gl` 5.24. À corriger au passage du bloc B.)*

---

## Reprise de session — à lire en premier

> Écrit le 2026-08-09, à la fin de la session qui a livré Étape 0, A1, A2 et A5.
> **Prochain lot : B0′** (reliquat de socle, non bloqué). Branche `feat/refonte-tracky-v2`, poussée sur `origin`.

### Où en est le travail

| Lot | État |
|---|---|
| Étape 0, A1, A2, A5 | 🟢 livrés, vérifiés, poussés (19 commits) |
| **A3 — l'espace dépôt** | 🟢 livré |
| **A4 — le partage** | 🟢 livré |
| Bloc B | 🔴 en attente des 27 `.dc.html` dans `design/maquettes/` |

### Remonter l'environnement (5 minutes)

```bash
pnpm docker:up
pnpm --filter @vizyo/tracky-api exec prisma migrate deploy
pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed.ts
pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-depot.ts
```

`seed-depot.ts` recrée le **cas de référence d'A0** : 7 camions, 2 dépôts
concurrents, 6 missions couvrant les 4 états de la fenêtre, 1 camion témoin sans
mission. Idempotent. C'est ce jeu qui rend l'isolation observable — un dépôt qui
verrait 8 camions, ou 0, se remarque immédiatement.

Serveurs : `preview_start` avec `web-refonte` (port 4205) et `api-refonte` (3000).
⚠️ Le port 4200 est occupé par un **autre projet** (Maalem) — ne pas s'y fier.

Jetons de test (les variables `VIZYO_AUTH_*` viennent du `.env`) :

```bash
pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts seed-depot-a
```

`seed-depot-a` / `seed-depot-b` = les deux dépôts · `seed-gestionnaire` = un
FLEET_MANAGER de la flotte de démonstration.

### Vérifier

```bash
pnpm typecheck && pnpm smoke && pnpm --filter @vizyo/tracky-api test
bash apps/api/prisma/verif-depot-http.sh    # 31/31 attendu, machine au repos
pnpm --filter @vizyo/tracky-api exec ts-node prisma/verif-depot.ts   # 17/17
```

### Les six pièges déjà payés — ne pas les repayer

1. **`pnpm verify` ne se termine jamais** (P1) : `ng test` tourne en watch. Employer
   le périmètre ci-dessus.
2. **Le script HTTP produit des échecs fantômes** s'il suit immédiatement Jest — la
   contention CPU fait expirer les `curl`. Relancer machine au repos.
3. **Cache de build Angular** : il peut faire **mentir un écran** sans qu'aucun test
   ne bronche (constaté : la matrice affichait les droits du Lecteur dans la colonne
   Dépôt). Au moindre écart inexplicable entre le code et l'écran :
   `rm -rf apps/web/.angular/cache`.
4. **`:host-context()` est obligatoire** pour cibler `body.plat-*` depuis les styles
   d'un composant. Un sélecteur d'ancêtre direct est réécrit par l'encapsulation et
   **échoue en silence**.
5. **Pas de backtick dans un commentaire** à l'intérieur d'un `template:` ou
   `styles: [\`…\`]` — il termine le littéral et casse la compilation.
6. **Le front ne retombe pas sur les défauts de rôle** : il lit
   `user.permissions?.[perm]`. Un compte avec `permissions: null` se voit tout
   refuser côté client. Écrire des permissions explicites sur les comptes de test.

### Ce qu'A3 doit réutiliser, pas réinventer

- `DepotScopeService` / `DepotScopeGuard` — le garde est en **refus par défaut** :
  toute nouvelle route `/depot/*` doit porter `@DepotScope(...)` ou
  `@DepotScopeBorneParLeService()`, sinon elle rend 403.
- `DepotService` — le `select` Prisma explicite **est** le contrat de fuite. Ajouter
  un champ au DTO sans l'ajouter au `select` ne fuite rien ; l'inverse, si.
- 3 des 8 endpoints d'A1 § 4 existent (liste, détail, position). Restent historique,
  exports, documents, incidents.
- Socle de plateforme : `shared/utils/platform.ts` + jetons `--feuille-*` /
  `--densite-liste`. Ne pas tester la plateforme dans un template.
- `maskPhone` masque **côté serveur**. Le numéro complet ne doit jamais transiter.

---

## Les règles permanentes

Elles s'appliquent à **chaque** tâche de ce fichier. Toute revue les vérifie.

**RÈGLE 1 — Une maquette est une référence de conception, pas du code.**
Aucun style en ligne recopié. On traduit la décision en classes Tailwind existantes et en
composants du kit.

**RÈGLE 2 — Le périmètre du rôle `DEPOT` se contrôle côté requête, jamais côté affichage.**
Le `where` Prisma porte toujours `depotUserId`. Filtrer dans un template est une faille.
Hors périmètre : `403`, jamais `200` avec un tableau vide. Identifiant inconnu et
identifiant hors périmètre renvoient le **même** code.

**RÈGLE 3 — Une couleur = une signification.**
vert = succès / actif / à l'heure · rouge = échec / danger / retard · ambre = attente / à
vérifier · bleu = information · violet = IA / super-admin / **dépôt** · gris = inactif.

**RÈGLE 4 — Le vocabulaire est fixé.**
« dépôt » (le compte tiers) ≠ lieu clé · « mission » (déclarée) ≠ trajet (`Trip`, détecté) ·
« fenêtre de mission » = `[startAt, endAt]`. Dans l'interface dépôt on ne dit **jamais**
« flotte », « véhicule de la flotte », ni « société » : on dit « le camion », « votre
transporteur », « votre mission ».

**RÈGLE 5 — Ce qui exige un accord préalable.**
Modifier un DTO ou un contrat d'API existant · changer une logique métier existante ·
supprimer une fonctionnalité · ajouter une dépendance npm · élargir le périmètre du rôle
`DEPOT` au-delà d'A1. Les **nouveaux** DTO du bloc A sont spécifiés : ils se créent
librement.

**RÈGLE 6 — Cadence de livraison.** Un lot terminé = ses critères de recette exécutés, puis
un commit, puis un point de contrôle avec le client. Jamais deux lots non vérifiés cumulés.

**RÈGLE 7 — « `pnpm verify` vert » n'existe pas ici, et il faut le savoir.**
`docs/VERIFIER-AVANT-DE-DEPLOYER.md` le documente noir sur blanc : la suite de ~1080 tests
est **instable**. Mesuré le 23/07/2026 sur `main` sans aucune modification, un run échoue sur
`report-excel`, un autre sur `partner-invitation` — suites différentes d'un run à l'autre,
chacune verte lancée seule. Les workers Jest sont réutilisés entre fichiers : un timer laissé
actif par une suite se réveille pendant une autre.

Partout où ce fichier écrit « `pnpm verify` vert », lire :

1. lancer `pnpm verify` ;
2. toute suite en échec est **relancée seule** — `pnpm --filter @vizyo/tracky-api exec jest --testPathPatterns <suite>` ;
3. verte seule → instabilité connue, sans rapport avec le changement ;
4. rouge seule → vrai défaut, à corriger avant de cocher.

**Ne jamais comparer au vert absolu : il n'existe pas sur ce dépôt.** On compare à une
référence — la même suite sur le commit d'avant.

Deux pièges d'outillage à ne pas retomber dedans : le paquet s'appelle
`@vizyo/tracky-api` (un mauvais filtre affiche `No projects matched the filters` **et sort en
exit 0**, le run paraît réussi sans qu'aucun test n'ait tourné) ; l'option Jest est
`--testPathPatterns`, au pluriel, sur cette version.

**Ce que `pnpm verify` ne couvre pas** : les migrations Prisma (appliquées au démarrage du
conteneur — une migration invalide ne se voit qu'au déploiement) · le comportement métier
réel · **le frontend** (`pnpm test` couvre l'API ; pour le web, `ng build` + karma headless)
· la configuration de production.

**P1 — `pnpm verify` ne se termine pas sur ce dépôt.** Mesuré le 2026-08-09 : `turbo run
test` embarque le `ng test` d'`apps/web`, lancé sans `--watch=false`. Karma ouvre un
navigateur et **attend indéfiniment** — 25 minutes à CPU nul, 29 processus Chrome vivants,
aucune sortie. Le `typecheck` et le `smoke` étaient déjà passés ; c'est la troisième étape
qui pend.

Commande à employer d'ici la correction :

```bash
pnpm typecheck && pnpm smoke && pnpm --filter @vizyo/tracky-api test
```

Ce périmètre correspond exactement à ce que `docs/VERIFIER-AVANT-DE-DEPLOYER.md` décrit
comme la couverture réelle (« `pnpm test` couvre l'API »). **Correction à proposer** :
ajouter `--watch=false` au script `test` d'`apps/web`, ou sortir le web de la tâche `test`
de Turbo. Hors périmètre de la refonte — à traiter séparément, avec l'accord du client.

---

## Étape 0 — Le socle

> Prérequis de tout. `design/B0-SOCLE.md`.

### 0.1 — Préparation du chantier

- [x] Branche `feat/refonte-tracky-v2` créée depuis `main`
- [x] Livrable copié dans `design/` (10 documents)
- [x] `design/maquettes/` créé (vide, en attente des `.dc.html`)
- [x] `design/` ajouté au dépôt — `git check-ignore` confirme qu'aucune règle ne l'exclut
- [x] État de départ mesuré : **typecheck OK · smoke 5/5 · 1682 tests API sur 1682, 125 suites, 18,8 s**. Aucune instabilité sur ce run — c'est la référence à laquelle comparer tout échec futur (RÈGLE 7)
- [x] ⚠️ **Défaut d'outillage relevé : `pnpm verify` ne peut pas se terminer sur ce dépôt.** `turbo run test` embarque le `ng test` d'`apps/web`, qui tourne en **mode watch** et n'exite jamais (mesuré : CPU à 0 pendant 25 min, 29 processus Chrome ouverts). Le périmètre réellement exécutable est `pnpm typecheck && pnpm smoke && pnpm --filter @vizyo/tracky-api test` — cf. point ouvert P1
- [x] ⚠️ **Le `launch.json` du dossier parent était un leurre** : il définissait `web` comme un simple proxy 4201 → 4200, sans jamais démarrer Angular. Sur 4200 tournait le serveur de dev d'un **autre projet** (Maalem, `D:\www\maalem`) — la page servie n'était pas Tracky. Remplacé par une vraie configuration `web-refonte` sur le port 4205

### 0.2 — `design/DECISIONS.md`

- [x] Fichier créé
- [x] Décision « police » actée : Manrope des deux côtés, planche de contrôle sans objet, avec la preuve (`styles.css:17-18`, commit `ec20139`) → **D1**
- [x] Décision « fallbacks morts » : purge des `var(--font-display, Poppins, …)`, liste des 13 fichiers concernés → **D2**
- [x] Décision « rôle latéral » : `DEPOT` n'entre dans aucune comparaison de niveau existante → **D3**
- [x] Décision « maquettes absentes » : bloc B différé, condition de déblocage écrite → **D4**
- [x] Décision « kit déjà posé » : B-kit devient une passe de raffinement, périmètre listé → **D5**
- [x] 5 décisions supplémentaires actées : violet/bleu à créer (**D6**), couleurs en dur (**D7**), surveillance en heure locale (**D8**), assistant à 2 étapes (**D9**), revue exhaustive des 60 modules (**D10**)

### 0.3 — `design/TOKENS.md`

- [x] Fichier créé
- [x] Table exhaustive : chaque variable de maquette (`--bg`, `--bg2`, `--surface`, `--surface2`, `--surface3`, `--border`, `--border2`, `--tx`, `--tx2`, `--tx3`, `--accent`, `--accent2`, `--accent-soft`, `--accent-ink`, `--red`, `--red-soft`, `--amber`, `--amber-soft`, `--violet`, `--violet-soft`, `--blue`, `--blue-soft`) → sa correspondance Tailwind / variable CSS du dépôt
- [x] `--accent-ink` documenté : encre **foncée** sur fond accent, jamais blanche (contraste mesuré, l'erreur inverse était tombée à 1,72:1)
- [x] **Défaut relevé et mesuré** : `--accent-ink` vaut `#FFFFFF` en thème clair → **3,43:1**, sous le seuil de 4,5:1. Correction décidée : `#04130D` (5,54:1), 43 usages corrigés par un seul jeton
- [x] Table « une couleur = une signification » reprise, avec la ligne violet = **dépôt**
- [x] Valeurs violet et bleu choisies et **vérifiées par calcul de contraste** sur la surface réelle : sombre `#A78BFA` (6,77:1) / `#38BDF8` (8,60:1), clair `#7C3AED` (5,70:1) / `#0369A1` (5,93:1)
- [x] Les jetons sont **écrits dans `styles.css`**, en clair et en sombre : `--violet` et `--blue` ajoutés aux deux thèmes, `--accent-ink` clair corrigé, chaque valeur commentée avec son contraste mesuré

### 0.4 — `design/ICONS.md`

- [x] Fichier créé
- [x] Règle de conversion posée (`ic-nom-compose` → `NomCompose`) + règle de priorité (chercher dans les 181 icônes employées avant d'ajouter)
- [x] Inventaire des **181 icônes** déjà employées, classé par famille — c'est le vocabulaire de l'application
- [x] 6 décisions actées, **chacune vérifiée contre le paquet installé** : `ic-van` → `Truck` (pas de camionnette distincte), compte dépôt → `Warehouse` (`Building2` est déjà « société »), mission → `Route`, partage → `Share`, lien fermé → `Unlink` (`LinkOff` absente), alias `AlertTriangle`/`AlertCircle`
- [x] Exception documentée : les pastilles de véhicule de la carte (CAR, TRUCK, VAN, MOTORCYCLE, BICYCLE, BUS, CONSTRUCTION, OTHER) **ne sont pas** des icônes Lucide — SVG dédiés dans `shared/utils/vehicle-icons.ts`, rotation selon le cap, à reprendre tels quels
- [x] Icônes du bloc A listées (mission, dépôt, partage, lien fermé, incident, position, document, export, téléphone, cadenas) — **un seul ajout** au vocabulaire : `Warehouse`
- [ ] Table `ic-*` exhaustive → **différée** : les `<symbol id="ic-…">` vivent dans les `.dc.html`. À compléter à leur livraison, avant la première page du bloc B (point ouvert O-I1)

### 0.5 — Purge des fallbacks morts

- [x] Vérifié qu'aucun test ne référence `font-display` ni `Poppins`, et qu'aucun des 13 fichiers n'a de spec voisin — la purge ne pouvait rien casser
- [x] Les **22** occurrences de `var(--font-display, Poppins, sans-serif)` remplacées par `var(--font-display)` dans les 13 fichiers relevés (motif strictement identique partout)
- [x] Une seule occurrence de `Poppins` subsiste dans `apps/web/src` : le commentaire historique de `styles.css:17`, **conservé volontairement** (il date la migration, il ne trompe personne — cf. D2)
- [x] **Jetons vérifiés dans l'application qui tourne**, au niveau de la cascade, sur un élément réel du DOM (le bouton « Se connecter ») :

  | Thème | Accent | Encre | Contraste | Verdict |
  |---|---|---|:-:|:-:|
  | Clair | `#0A9E6C` | `#04130D` | **5,54:1** | ✅ (était **3,43:1**) |
  | Sombre | `#10E0A0` | `#04130D` | **11,04:1** | ✅ |

  `--violet` et `--blue` se résolvent correctement dans les deux thèmes.
- [x] Les 43 usages de `--accent-ink` audités un à un : **tous** sur fond accent ou ambre. Deux gagnent même au change — la coche `.nc-sev-mark` de `notifications-card` et le bouton ambre de `vehicle-detail`, où le blanc était déjà limite
- [ ] ⏸️ **Confirmation au pixel en attente** : le panneau navigateur n'est pas affiché, donc la page ne compose aucune image — ni capture ni valeur de rendu exploitable. La cascade est concluante, mais un contrôle à l'œil reste souhaitable. *Afficher le panneau et reprendre.*
- [ ] ⏸️ Contrôle de non-débordement : nav latérale (14 entrées), 10 pastilles d'état les plus longues, 4 tuiles de KPI — **même blocage** (nécessite le rendu)

### Recette de l'étape 0

- [x] Les 3 fichiers `design/*.md` existent et sont remplis
- [x] Chaque variable de maquette a sa correspondance dans `TOKENS.md` (une seule sans équivalent, `--surface3`, décision différée documentée en O1)
- [x] Chaque `ic-*` a sa règle de conversion, ses décisions écrites et vérifiées contre le paquet installé — la table symbole par symbole attend les maquettes (O-I1)
- [x] Vérification (périmètre P1) : **typecheck OK · smoke 5/5 · 1682/1682 tests API**. Aucune régression : identique à la référence d'avant modification
- [x] `ng build` du web : bundle généré en 83,7 s, sans erreur ni avertissement
- [x] **Commit** `4d6e800 docs(design): socle de refonte — decisions, jetons, icones` — 28 fichiers, +4085/−23
- [ ] ⏸️ **Point de contrôle client** — en attente de votre feu vert pour ouvrir A1

---

## Lot A1 — Le rôle `DEPOT` : permissions et isolation

> `design/A1-ROLE-DEPOT.md`. **Prérequis absolu du bloc A.** Aucun écran ne se construit
> avant que les 12 tests d'isolation soient verts. Un espace dépôt joli qui fuit des données
> est pire que pas d'espace dépôt.

### A1.1 — Le slug et les permissions partagées

`packages/shared/src/permissions/permissions.ts`

- [ ] `'DEPOT'` ajouté en dernière position de `UserRoleSlug`
- [ ] `DEPOT` ajouté à `enum UserRole` dans `apps/api/prisma/schema.prisma` (migration additive)
- [ ] 4 permissions ajoutées à `UserPermissions`, chacune commentée : `missions_view`, `missions_manage`, `mission_share`, `driver_contact_view`
- [ ] Les 4 clés ajoutées aux **6** tables de défauts existantes (`VIEWER`, `FLEET_MANAGER`, `ADMIN`, `NIGHT_WATCHMAN`, `DRIVER`) — aucun objet ne doit rester incomplet
- [ ] `DEPOT_DEFAULTS` créé : **tout à `false`** sauf `missions_view`, `trips_view`, `mission_share`, `driver_contact_view`
- [ ] `getDefaultPermissions('DEPOT')` renvoie `DEPOT_DEFAULTS`
- [ ] Défauts des rôles existants conformes à la table A1 § 2 : `FLEET_MANAGER` les 4 à ✅ · `VIEWER` `missions_view` seul · `NIGHT_WATCHMAN` les 4 à ❌ · `DRIVER` `missions_view` seul
- [ ] `effectiveGranterPermissions({ role: 'DEPOT' })` renvoie **toutes** les permissions à `false` — un dépôt n'invite personne et ne délègue rien
- [ ] `DEPOT` n'est glissé dans **aucune** comparaison de niveau ou hiérarchie existante (rôle latéral, pas « sous VIEWER »)
- [ ] `packages/shared/src/permissions/permissions.spec.ts` étendu : défauts `DEPOT`, granter vide, présence des 4 clés dans tous les rôles

### A1.2 — Le service de périmètre

`apps/api/src/depot/depot-scope.service.ts` (nouveau)

- [ ] `missionsFor(userId, at?)` — `where` portant `depotUserId`, jamais de filtrage en mémoire
- [ ] `canSeeLivePosition(userId, vehicleId)` — vrai seulement si mission `depotUserId = userId` **et** `vehicleId` **et** `startAt <= now <= endAt` **et** `status IN (IN_PROGRESS, LATE)`
- [ ] `canSeeTrip(userId, tripId)` — mission terminée, pas de borne horaire
- [ ] La fenêtre est évaluée à **l'heure serveur**, jamais depuis une date envoyée par le client
- [ ] Tests unitaires du service (frontières exactes : `startAt - 1s`, `startAt`, `endAt`, `endAt + 1s`)

### A1.3 — Le garde

`apps/api/src/depot/depot-scope.guard.ts` (nouveau)

- [ ] `user.role !== 'DEPOT'` → laisse passer (les autres gardes s'appliquent)
- [ ] `user.role === 'DEPOT'` → résout `missionId | vehicleId | tripId` depuis la route, interroge `DepotScopeService`, `false` → `ForbiddenException`
- [ ] Aucune distinction entre identifiant inconnu et identifiant hors périmètre — sinon on permet d'énumérer les identifiants valides
- [ ] Tests unitaires du garde

### A1.4 — La revue de tous les contrôleurs

> Une route oubliée est une faille. Cette revue est manuelle et exhaustive, pas
> échantillonnée.

- [ ] Inventaire écrit de **tous** les contrôleurs de `apps/api/src/` qu'un `DEPOT` authentifié peut atteindre (60 modules)
- [ ] Chaque contrôleur atteignable porte `DepotScopeGuard` **ou** refuse explicitement le rôle
- [ ] `positions` couvert
- [ ] `trips` couvert
- [ ] `vehicles` refuse le rôle
- [ ] `engine-control` refuse le rôle
- [ ] `users`, `drivers`, `sims`, `billing` refusent le rôle
- [ ] `alerts`, `geofences`, `vehicle-groups` refusent le rôle
- [ ] `agenda`, `reservation-booking` refusent le rôle
- [ ] `reports`, `trip-analysis` refusent le rôle
- [ ] `ai`, `audio-monitoring`, `fleet-places` refusent le rôle
- [ ] Inventaire consigné dans `design/DECISIONS.md` (liste + verdict par module)

### A1.5 — Le WebSocket

`apps/api/src/realtime/realtime.gateway.ts`

- [ ] Un `DEPOT` rejoint **uniquement** `depot:mission:<missionId>` — jamais `fleet:*`, `pos:fleet:*`, `ops:fleet:*`, `alerts:fleet:*`
- [ ] La tentative de rejoindre une room de flotte est refusée côté serveur
- [ ] Le serveur cesse d'émettre vers la room à `endAt` ou à la clôture manuelle
- [ ] Un socket ouvert **avant** `endAt` ne reçoit plus rien après — vérifié, pas supposé
- [ ] Le périmètre socket est recalculé à la reconnexion (pas de cache de scope à la connexion)

### A1.6 — Le DTO restreint

`packages/shared/src/dto/mission.dto.ts` (nouveau) — `DepotMissionDto`

- [ ] Interface conforme au contrat A1 § 4, champ pour champ
- [ ] **Aucun** `vehicleId`, `imei`, identifiant interne, groupe, coût, score ne peut transiter
- [ ] `driver` n'est peuplé que si `driver_contact_view` ; `displayName` = prénom + initiale
- [ ] `phone` **masqué côté API** (`06 12 •• •• 47`) — le numéro complet ne quitte pas le serveur
- [ ] `carrierName` = `Fleet.name` (la marque du transporteur, pas Tracky)
- [ ] Export ajouté à `packages/shared/src/index.ts`

### A1.7 — Frontend : route, garde, shell

- [ ] `depotRoleGuard` créé dans `apps/web/src/app/core/guards/`
- [ ] Route `/depot` ajoutée à `app.routes.ts` avec `canActivate: [authGuard, depotRoleGuard]`
- [ ] Redirection post-login : un `DEPOT` arrive sur `/depot`, jamais `/dashboard` — au même endroit que la redirection `DRIVER` (`login.component.ts:254`)
- [ ] Verrouillage inverse : un `DEPOT` qui tape `/map`, `/vehicles`, `/reports` est renvoyé sur `/depot` (pas de page 403 : ces routes n'existent pas dans son monde)
- [ ] `dashboard-layout.component.ts` — troisième cas après veilleur et simplifié : 4 entrées de nav (Carte live · Missions · Historique · Documents)
- [ ] Sélecteur de société retiré en mode dépôt
- [ ] Cloche d'alertes retirée
- [ ] Recherche globale retirée
- [ ] Marque en tête = nom du transporteur (`Fleet.name`), aucun logo Tracky
- [ ] Pied de menu « Propulsé par Vizyo Tracky », 12 px, `--tx3`
- [ ] Menu profil réduit : Mon compte · Comment ça marche · Déconnexion

### A1.8 — Règles métier à faire respecter

- [ ] Un `DEPOT` appartient à **une seule** `Fleet` — le multi-transporteur est hors périmètre (décision client)
- [ ] Un `DEPOT` n'a **jamais** de ligne `UserVehicleAccess` — contrainte applicative, à la création comme à la modification, testée
- [ ] Aucun agrégat de flotte servi à un dépôt : tout compteur se calcule sur ses missions

### Recette A1 — les 12 tests d'isolation

`apps/api/test/integration/depot-isolation.e2e-spec.ts`. **Tous verts.**

Le dépôt teste ses e2e avec un Prisma **mocké** et le pipeline NestJS réel (patron
« e2e-soft » de `health.e2e-spec.ts`). Ces tests tournent donc **sans base de données** —
et c'est mieux pour de l'isolation : on maîtrise exactement ce que la base « contient ».

- [x] 1 — `DEPOT` demande un véhicule de la flotte hors mission → `403`
- [x] 2 — position d'un de ses véhicules **avant** `startAt` → `403`
- [x] 3 — position **pendant** la fenêtre → `200` + position
- [x] 4 — position **après** `endAt` (mission `DONE`) → `403`
- [x] 5 — mission d'un autre dépôt → `403` **+ vérification que le filtre est en requête**
- [x] 6 — `GET /vehicles` → `vehicles_view` fermée
- [x] 7 — `POST /engine-control/*` → `engine_control` fermée
- [x] 8 — `GET /users` → `users_view` fermée
- [x] 9 — socket : aucun salon de flotte rejoint (13 tests dans `realtime-depot-scope.spec.ts`)
- [x] 10 — socket : l'empreinte porte les missions, ce qui coupe la socket à la fin de mission
- [x] 11 — tentative d'accorder une permission → tout à `false`
- [x] 12 — le DTO servi ne contient ni `vehicleId`, ni `imei`, ni coût → assertion sur les clés **et sur le `select` Prisma**

**5 tests supplémentaires**, issus de la revue :

- [x] Le téléphone est masqué **côté serveur** — le numéro complet n'apparaît nulle part dans la réponse
- [x] Le conducteur est nommé « Karim B. », jamais « Benali »
- [x] La liste filtre sur `depotUserId` même sans paramètre
- [x] `?from=1970&to=2999` ne change **pas** le périmètre — les dates client sont un filtre d'affichage
- [x] Une position de plus de 10 min est déclarée indisponible, jamais servie comme actuelle
- [x] Identifiant inconnu et hors périmètre → **même code, même message**

- [x] La revue manuelle des contrôleurs (A1.4) est faite et consignée dans `design/DECISIONS.md`
- [x] **Vérifié CONTRE LA BASE RÉELLE** (2026-08-09) — `prisma/seed-depot.ts` recrée le cas de référence d'A0 (7 camions, 2 dépôts concurrents, 6 missions couvrant les 4 états de la fenêtre, 1 camion témoin sans mission) :
  - `prisma/verif-depot.ts` → **17/17** sur le service, avec de vraies lignes
  - `prisma/verif-depot-http.sh` → **31/31 par HTTP**, à travers le vrai pipeline
  - Confirmé au passage : `/vehicles`, `/users`, `/trips`, `/alerts`, `/positions`, `/drivers`, `/reports/{stats,pdf,csv}`, `/trip-analysis/*` et `/ai/status` répondent tous `403` à un dépôt authentifié ; aucun champ interdit ne transite ; identifiant inconnu et hors périmètre rendent le même code
- [x] Vérification complète : **typecheck 3/3 · smoke 5/5 · 277 partagés · 1727 API · 19 intégration**
- [x] **Commit** `4456763 feat(depot): role DEPOT, isolation par mission et gardes API` — 33 fichiers, +2577/−43
- [ ] ⏸️ **Point de contrôle client** — les 12 tests montrés verts

### Ce qui est reporté d'A1, et pourquoi

- [x] **Shell mode dépôt — les 4 entrées de nav** — levé au lot A3 : Carte live · Mes missions · Historique · Documents, chacune avec son écran. Sur iOS elles forment aussi la barre d'onglets basse ; sur Android le menu latéral les porte (écart volontaire)
- [x] **Shell — retrait du sélecteur de société et de la cloche ; marque du transporteur en tête ; pied « Propulsé par Vizyo Tracky » à 12 px** — levé au lot A3. La cloche appelait l'API des alertes, qui répond 403 à un dépôt : elle promettait une fonction inexistante
- [ ] **`assertNoVehicleAccess` est écrit et testé mais pas encore branché** sur la création / modification de compte → lot A5, qui possède ces parcours
- [x] **Les 8 endpoints d'A1 § 4** — levé au lot A3 : trajet, historique (KPI serveur), exports PDF/CSV, documents, incidents. Plus `GET /depot/live` (la lecture unique de la carte) et `POST /depot/missions/:id/call` (le seul chemin vers un numéro complet, journalisé)

---

## Lot A2 — Les missions

> `design/A2-MISSIONS.md`. La mission est le pivot du bloc A : c'est elle qui ouvre l'accès
> au dépôt, et sa fenêtre horaire qui le referme. Décision client : **elle vit dans
> l'agenda**, pas dans une page à part.

> **État au 2026-08-09** — le socle backend est livré et testé (46 tests) : création avec
> ses deux effets structurants, génération de référence sous verrou, conflit de créneau,
> les 7 validations, et la bascule automatique des statuts. Restent la notification du
> dépôt, la mention conducteur, les endpoints de liste/modification/annulation, et tout
> le frontend. Détail en fin de section.
>
> **La décision de conception du lot** : la mission pose un `VehicleEvent` de type
> `MISSION` avec `blocksVehicle: true`. Elle entre alors dans `findImmobilized`, le
> chemin d'indisponibilité que les réservations empruntent **déjà**. Aucun second
> mécanisme n'est écrit — ce qu'A2 § 3.2 interdit en toutes lettres : « deux sources
> d'indisponibilité, une seule logique de lecture ».

### A2.1 — Le modèle

`apps/api/prisma/schema.prisma`

- [ ] Modèle `Mission` créé conforme à A2 § 1 (tous les champs, tous les index)
- [ ] `enum MissionStatus` : `PLANNED`, `IN_PROGRESS`, `LATE`, `DONE`, `CANCELLED`
- [ ] `Trip.missionId` + relation `"TripMission"` ajoutés
- [ ] Relation `User` ← `"MissionDepot"` sur `depotUserId`, `onDelete: SetNull`
- [ ] `vehicleId` en `onDelete: Restrict` — un véhicule ne se supprime pas sous une mission active
- [ ] `@@unique([fleetId, ref])`, `@@index([fleetId, startAt])`, `@@index([depotUserId, startAt])`, `@@index([vehicleId, startAt, endAt])`
- [ ] Migration générée et **relue** avant application
- [ ] Migration appliquée en local, `prisma generate` passé

### A2.2 — La référence `ref`

- [ ] Séquence par flotte, format `M-NNNN`
- [ ] Génération **en transaction** (`SELECT max … FOR UPDATE` ou séquence dédiée)
- [ ] Deux missions créées simultanément ne reçoivent jamais la même référence — testé en concurrence, pas supposé
- [ ] La contrainte `@@unique([fleetId, ref])` sert de filet, pas de mécanisme principal

### A2.3 — Le statut dérivé, jamais saisi

- [ ] Aucun bouton « passer en cours » nulle part dans l'interface
- [ ] `PLANNED` à la création
- [ ] `IN_PROGRESS` — première position détectée après `startAt - 15 min` (listener de position)
- [ ] `LATE` — `now > endAt` **et** véhicule pas encore arrivé (tâche de fond, toutes les minutes)
- [ ] `DONE` — arrivée détectée à destination **ou** clôture manuelle
- [ ] `CANCELLED` — annulation explicite avec motif
- [ ] `LATE` **n'interrompt pas** le suivi : la fenêtre d'accès s'étend jusqu'à `DONE` ou clôture — c'est précisément le moment où le dépôt a le plus besoin de voir le camion
- [ ] `delayMinutes` **calculé à la volée**, jamais stocké (`now - endAt` si en cours, `actualEndAt - endAt` si terminée)
- [ ] Tâche de fond enregistrée dans l'inventaire `/admin/background-tasks`

### A2.4 — Les 4 effets de bord à la création

**Un événement dans l'agenda**
- [ ] `MISSION` ajouté à `enum VehicleEventType`
- [ ] Un `VehicleEvent` de type `MISSION` est posé sur `startAt`, visible dans la grille du mois avec sa pastille
- [ ] Cliquer dessus ouvre la mission, **pas** un formulaire d'événement
- [ ] Le gestionnaire voit maintenance, incidents, réservations et missions sur le **même** calendrier — sinon il double-réserve

**Le véhicule devient indisponible**
- [ ] Sur `[startAt, endAt]`, le véhicule sort des créneaux réservables de `/agenda` → Réserver
- [ ] …des véhicules proposés par `/reserve/:token`
- [ ] …des suggestions de l'agent IA d'agenda
- [ ] **Une seule logique de lecture** : la fonction qui liste les véhicules disponibles (`reservations.service.ts` → `findOverlaps` / `availableForFleet`) interroge désormais aussi `Mission` (`status NOT IN (DONE, CANCELLED)`). Aucun second mécanisme créé
- [ ] Vérifié : deux sources d'indisponibilité, un seul chemin de lecture

**Le dépôt est notifié**
- [ ] Gabarit e-mail `mission_assigned` créé via `email.service.ts` → `shell()`
- [ ] Le sujet porte l'information : « Livraison prévue jeudi 08:15 → 11:40 », pas « Nouvelle mission »
- [ ] Contenu : référence, trajet, créneau, plaque, lien vers `/depot`
- [ ] Notification push si le dépôt en a — via les préférences existantes (`notification-preference.dto.ts`)

**Le conducteur voit sa mission**
- [ ] Dans `/driver`, la mission apparaît sur la fiche du véhicule : destination, créneau
- [ ] **Mention d'information obligatoire** : « ce dépôt suit votre position pendant la mission ». Condition de conformité du dispositif, traitée dans ce lot, pas plus tard

### A2.5 — Le module API

`apps/api/src/missions/` (nouveau)

- [ ] `missions.module.ts`, `missions.controller.ts`, `missions.service.ts`
- [ ] DTO partagés dans `packages/shared/src/dto/mission.dto.ts`
- [ ] CRUD gardé par `missions_manage` ; lecture par `missions_view`
- [ ] Module importé dans `AppModule` avec ses dépendances (le `pnpm smoke` le vérifie)

### A2.6 — Le conflit de créneau

- [ ] Un véhicule ne peut porter deux missions qui se chevauchent — refus côté API
- [ ] `409` avec le détail : `{ code: 'MISSION_SLOT_CONFLICT', vehiclePlate, conflictingMission: { ref, startAt, endAt } }`
- [ ] **Niveau 1** — un véhicule occupé, d'autres libres : dans la modale, le véhicule est **visible et grisé** avec son motif (« Déjà en mission M-2482 · 09:00 → 12:20 »). Pas d'erreur, pas de modale
- [ ] **Niveau 2** — aucun véhicule libre : modale « Créneau indisponible », liste des véhicules bloqués avec leur mission, **puis le prochain créneau libre calculé** sur le même véhicule et la même durée, bouton « Décaler à 12:30 »
- [ ] On propose une sortie plutôt qu'on annonce un échec

### A2.7 — Les autres validations

- [ ] `endAt > startAt` → « L'heure de fin doit suivre l'heure de départ »
- [ ] Durée ≥ 15 min → « Une mission dure au moins 15 minutes »
- [ ] Durée ≤ 24 h → « Au-delà de 24 h, créez plusieurs missions »
- [ ] `startAt` ≤ 90 j dans le futur → « Trop loin dans le temps »
- [ ] Véhicule hors flotte → `403`
- [ ] `depotUserId` n'est pas un `DEPOT` de la même flotte → `400`
- [ ] Véhicule sans boîtier → **avertissement non bloquant** : « Ce véhicule n'a pas encore de boîtier : le dépôt ne verra pas sa position ». On peut planifier avant l'installation

### A2.8 — La modale de création

`apps/web/src/app/features/agenda/mission-dialog/` (nouveau)

- [ ] Point de départ — lieu clé ou adresse libre, autocomplete sur `FleetPlace`, défaut = dernier utilisé
- [ ] Destination — idem
- [ ] Date — défaut aujourd'hui
- [ ] Heure de départ — défaut 08:00, **liseré accent** (c'est le champ qui borne l'accès)
- [ ] Heure de fin — défaut +3 h, idem
- [ ] Véhicule — liste filtrée, les occupés visibles et grisés avec leur motif
- [ ] Conducteur — facultatif, défaut = affecté au véhicule
- [ ] Dépôt destinataire — liste des `DEPOT` de la flotte, facultatif (sans lui : mission interne)
- [ ] Notes — non transmises au dépôt
- [ ] **Bloc de conséquence** sous les champs : « À l'enregistrement : un événement Mission est posé le 14 mai dans l'agenda, `FR-482-BX` devient indisponible de 08:15 à 11:40, et Claire Vasseur reçoit une notification. » Trois effets invisibles rendus visibles
- [ ] **Ligne de périmètre** sous le champ dépôt : « Le dépôt verra la position du camion de 08:15 à 11:40 uniquement, puis le trajet passera dans son historique. »

### A2.9 — La liste des missions (3ᵉ onglet de `/agenda`)

`apps/web/src/app/features/agenda/agenda.component.ts`

- [ ] 3ᵉ onglet ajouté à côté de Mois et Échéances
- [ ] Colonnes : Réf. · Trajet · Créneau · Véhicule · Dépôt destinataire · Statut · actions
- [ ] Filtres : Toutes / En cours / Planifiées / Terminées + sélecteur de dépôt
- [ ] 5 compteurs en tête : En cours · Planifiées · En retard · **Véhicules indisponibles** · Dépôts destinataires
- [ ] Le compteur « Véhicules indisponibles » rend visible le coût des missions sur la disponibilité de la flotte
- [ ] Modification : `PLANNED` entièrement modifiable · `IN_PROGRESS` seuls `endAt`, conducteur, notes · `DONE` notes seules
- [ ] Changer `endAt` d'une mission en cours **étend ou réduit la fenêtre d'accès du dépôt** — dit explicitement dans la confirmation
- [ ] Annulation : motif obligatoire, dépôt notifié, mission conservée dans son historique avec « Annulée par le transporteur »

### A2.10 — Déclinaisons mobiles

- [ ] iOS : feuille basse (coins 22 px, poignée 36 × 5, en-tête Annuler / Terminé, densité 44 px)
- [ ] Android : liste M3 + FAB (feuille 28 px, poignée 32 × 4, densité 56 px, puces filtres avec coche)
- [ ] Fiche véhicule : bandeau « en mission » quand `IN_PROGRESS`

### A2.11 — Modèles de tournée

> *Non bloquant. Peut être livré après A4 si le calendrier presse.*

- [ ] Bouton « Modèles de tournée » dans la barre d'outils
- [ ] « Enregistrer comme modèle » dans la modale de création
- [ ] Un modèle porte : origine, destination, durée, véhicule préféré, dépôt destinataire, récurrence
- [ ] Un modèle **génère** des missions, il n'en est pas une : chaque occurrence est autonome, modifiable et annulable individuellement
- [ ] Génération glissante sur 14 jours par tâche de fond quotidienne
- [ ] Un modèle désactivé cesse de générer, sans toucher aux missions déjà créées

### A2.12 — États et cas particuliers

- [ ] Mission sans dépôt → valide, mission interne, aucun tiers ne la voit
- [ ] Dépôt supprimé après création → `SetNull`, la mission devient interne, le gestionnaire est prévenu
- [ ] Véhicule supprimé → `Restrict`, refus tant qu'une mission non terminée existe
- [ ] Conducteur retiré du véhicule → la mission garde le conducteur historique
- [ ] Mission jamais démarrée → reste `PLANNED`, puis à `endAt + 4 h` bascule `DONE` avec `actualStartAt = null` et « Aucun déplacement détecté »
- [ ] Boîtier en panne pendant la mission → `IN_PROGRESS` maintenu, position « indisponible depuis N min »
- [ ] Mission qui déborde sur le lendemain → autorisée (≤ 24 h), affichée sur les deux jours
- [ ] Deux dépôts sur une mission → non supporté, un seul `depotUserId`

### Ce qui reste d'A2 — état au 2026-08-09

**Livré et testé** (56 tests) : le modèle et sa migration · `MISSION` dans
`VehicleEventType` · la création avec l'événement d'agenda et l'indisponibilité ·
la référence sous `FOR UPDATE` · le conflit `409` avec son détail · les 7 validations ·
l'avertissement « pas de boîtier » · la bascule automatique des statuts (démarrage sur
première position, retard, clôture sans mouvement) · la synchronisation mission ↔ agenda ·
**les 4 effets de bord**.

- [x] **Effet 1 — l'événement d'agenda** de type `MISSION`, dans la même transaction
- [x] **Effet 2 — l'indisponibilité véhicule**, par `blocksVehicle` et le chemin de lecture existant
- [x] **Effet 3 — le dépôt est notifié.** Gabarit `mission_assigned`, sujet porteur d'information, nom du transporteur en avant. Une panne d'e-mail n'annule pas la mission
- [x] **Effet 4 — le conducteur voit sa mission** dans `/driver` avec la mention d'information, `depotWatching` **calculé côté serveur** — une obligation légale ne doit pas dépendre d'un `@if` supprimable
- [x] Endpoint de **liste** avec les 5 compteurs calculés côté serveur
- [x] Endpoint d'**annulation** avec motif obligatoire, libérant le véhicule
- [x] **3ᵉ onglet de `/agenda`** : tableau (Réf. · Trajet · Créneau · Véhicule · Dépôt · Statut), filtres Toutes / En cours / Planifiées / Terminées, et les 5 compteurs
- [x] Les missions apparaissent **dans la grille du mois** sous « Tous » — l'exigence d'A2 § 3.1
- [x] **Modale de création** — 9 champs, liseré accent sur les heures, **bloc de conséquence** (les 3 effets invisibles écrits avant de valider) et **ligne de périmètre** sous le champ dépôt
- [x] **Niveau 1 du conflit** — `GET /missions/vehicle-availability` : les véhicules occupés sont **affichés et grisés avec leur motif**, jamais masqués. La liste se recharge à chaque changement de créneau
- [x] Le `409` de conflit rendu en clair, avec la mission bloquante et son créneau
- [x] **Endpoint de modification** — `PATCH /missions/:id`, trois régimes selon le statut (`PLANNED` tout · `IN_PROGRESS`/`LATE` seuls `endAt`, conducteur, notes · `DONE` les notes · `CANCELLED` rien)
- [x] Un champ interdit est **refusé et nommé**, jamais ignoré en silence — sinon l'interface afficherait une valeur que le serveur n'a pas écrite
- [x] **`impactFenetre`** renvoyé quand `endAt` bouge sur une mission qui a un dépôt : « ÉTENDUE de 40 minutes ». A2 § 6 exige de le dire dans la confirmation
- [x] Le conflit est re-vérifié **en s'excluant soi-même**, et l'événement d'agenda suit le créneau et le véhicule
- [x] Vérifié par HTTP : impact décrit, agenda synchronisé au millième, champ interdit → `400` nommant le champ
- [x] **Niveau 2 du conflit** — bloc « Créneau indisponible » : les véhicules bloqués avec leur mission, le **prochain créneau libre réellement calculé**, et le bouton « Décaler à HH:MM » qui reporte le créneau en conservant la durée et présélectionne le véhicule
- [x] Le calcul enjambe plusieurs missions et trouve les **trous entre deux missions** — 6 tests unitaires + vérifié sur base réelle (flotte saturée à 7/7)
- [x] Horizon de 14 jours : au-delà, on répond « rien ne se dégage » plutôt que de proposer une date dans 4 mois
- [x] **Déclinaisons iOS et Android** — socle de plateforme (`shared/utils/platform.ts` + jetons `--feuille-*` / `--densite-liste` dans `styles.css`) : aucun composant ne teste la plateforme dans son template, il consomme les variables. **Réutilisable par tout le bloc B**
- [x] Liste en **cartes** sous 768 px, tableau au-delà — un tableau à 6 colonnes sur 390 px imposerait un défilement horizontal, interdit par B1 (critère 5) et A3 § 3
- [x] Modale → **feuille basse** sur mobile, avec les 3 écarts volontaires **vérifiés à l'écran** : rayon 22/28 px · poignée 36×5 / 32×4 · densité 44/56 px
- [x] En-tête « Annuler » sur iOS (la croix disparaît), actions en pied sur Android — conforme à M3
- [x] Contrôlé aux trois largeurs : **aucun débordement horizontal**, aucune cible sous 44 px
- [x] **Bandeau « en mission » sur la fiche véhicule** — placé tout en haut, avant le hero : un gestionnaire qui ouvre la fiche pour couper le moteur doit savoir qu'un tiers regarde ce camion **avant** d'agir. Violet (couleur du dépôt), ambre si la mission est en retard. Vérifié sur les 3 cas réels : avec dépôt, sans dépôt, sans mission
- [ ] Modèles de tournée — *explicitement non bloquant, livrable après A4 (A2 § 7)*
- [ ] ⏸️ **Vérification visuelle de l'onglet** — bloquée : le panneau navigateur n'est pas affiché, la page ne compose aucune image

### Recette A2 — les 12 critères

- [ ] 1 — créer une mission → événement d'agenda visible le bon jour
- [ ] 2 — le véhicule n'apparaît plus dans « Réserver » sur ce créneau
- [ ] 3 — le véhicule n'apparaît plus dans `/reserve/:token`
- [ ] 4 — mission avec dépôt → e-mail reçu, mission visible dans `/depot`
- [ ] 5 — mission en conflit → `409` + détail de la mission bloquante
- [ ] 6 — aucun véhicule libre → modale avec le prochain créneau proposé
- [ ] 7 — première position après `startAt` → statut `IN_PROGRESS`
- [ ] 8 — `now > endAt` sans arrivée → statut `LATE`, suivi maintenu
- [ ] 9 — arrivée détectée → statut `DONE`, position plus servie au dépôt
- [ ] 10 — annuler → véhicule libéré, dépôt notifié
- [ ] 11 — deux missions simultanées, même flotte → références distinctes
- [ ] 12 — supprimer un véhicule avec mission active → refus explicite

- [x] Vérification (le périmètre du § 5 — `pnpm verify` ne se termine jamais, cf. piège 1) : typecheck 3/3 · smoke 5/5 · **1849 tests API** (132 suites) · 277 tests partagés · build web vert · isolation base **18/18** · isolation HTTP **44/44** · contraste dépôt **16/16 couples ≥ 4,5:1**
- [x] **Commit** `feat(missions): modele, agenda, indisponibilite vehicule et notification depot`
- [ ] ⏸️ **Point de contrôle client** — une mission créée bloque un véhicule

---

## Lot A5 — Comptes dépôt : invitation et gestion

> `design/A5-COMPTES.md`. Placé avant A3 : on a besoin d'un vrai compte dépôt pour
> développer et tester les écrans.

### A5.1 — Backend

- [x] `Invitation` accepte `role: 'DEPOT'` — l'enum Prisma le porte depuis A1, le flux existant s'applique tel quel (**pas** un second système)
- [x] **Refus des scopes véhicule / groupe**, aux deux endroits qui en créent :
  - `invitations.service.ts` — ⚠️ **trou refermé** : l'acceptation créait *toujours* au moins un scope `ALL`, y compris pour un dépôt. Il aurait donc reçu un périmètre de **flotte entière**, résolu par `PermissionsResolverService` en contournant `DepotScopeService`. L'isolation du bloc A serait tombée à la première invitation acceptée
  - `users.controller.ts` — l'éditeur de matrice refuse, avec un message qui explique où se trouve le vrai levier (« assignez-lui une mission »)
- [x] **Blocage du changement de rôle dans les deux sens** — un dépôt promu gestionnaire ouvrirait toute la flotte d'un clic depuis un écran qui ne le dit pas ; un gestionnaire basculé en dépôt garderait ses lignes `UserVehicleAccess`, interdites par A1 § 7
- [x] `permissionsForTargetRole` **branché** sur la création de compte — écrit en A1, il n'était encore appelé nulle part
- [x] Vérifié sur l'API réelle : les deux tentatives sont refusées, et les comptes dépôt portent **0 ligne** `UserVehicleAccess`
- [ ] Suspension → déconnexion immédiate + révocation en cascade des liens de partage actifs
- [ ] Réactivation → retrouve ses missions, y compris celles créées pendant la suspension
- [ ] Suppression → `Mission.depotUserId` à `null`, liens détruits, nombre de missions affectées renvoyé au gestionnaire
- [ ] E-mail déjà utilisé dans une autre flotte → refus explicite

### A5.2 — Le formulaire d'invitation

`apps/web/src/app/features/users/`

- [ ] Rôle « Dépôt » dans le sélecteur (PC, feuille iOS, dialogue Android)
- [ ] Champs quand le rôle est `DEPOT` : E-mail ✅ · Nom du dépôt ✅ · Nom du contact — · Téléphone —
- [ ] **Les champs de périmètre disparaissent** — pas de sélecteur de groupes ni de véhicules. En afficher un serait un mensonge d'interface et une invitation à créer une ligne `UserVehicleAccess` interdite
- [ ] Ligne d'explication à la place : « Ce compte verra uniquement les missions que vous lui assignerez, pendant leur créneau. Aucun accès à votre flotte. »
- [ ] Avertissement si on invite un collègue interne en dépôt : « Un compte dépôt ne voit pas votre flotte »

### A5.3 — La liste des utilisateurs

- [ ] Ligne de dépôt : avatar violet, pastille « Dépôt » avec l'icône camion
- [ ] Colonne Périmètre → **l'activité**, pas un groupe : « 4 missions en cours » ou « Aucune mission ». Un dépôt sans mission depuis trois mois est un compte à fermer
- [ ] Colonne « Membre depuis » = date d'activation
- [ ] Invitation en attente → « En attente · relancer » · expirée → « Expirée · renvoyer »

### A5.4 — La matrice de permissions

`features/users/access-matrix-editor.component.ts` et `permissions-overview.component.ts`

- [ ] 6ᵉ colonne « Dépôt », après Conducteur
- [ ] Nouvelle section en bas : **MISSIONS & DÉPÔTS** avec ses 6 lignes
- [ ] Marqueur **◆ violet** distinct de la coche verte = « accordé, mais limité à ses propres missions »
- [ ] Légende sous la matrice : « ◆ Limité à ses propres missions — le dépôt n'a aucun droit d'action : son accès est en lecture seule, borné à la fenêtre horaire de chaque mission. »
- [ ] Cases d'un dépôt **non modifiables** — le rôle est fermé. Grisées, infobulle « Le périmètre d'un dépôt est fixé par ses missions. »
- [ ] Refus côté API aussi : accorder `vehicles_view` à un dépôt est impossible depuis l'interface **et** rejeté par le serveur
- [ ] `/users/overview` — matrice repensée en liste par rôle sur mobile (impossible telle quelle sur téléphone)

### A5.5 — L'e-mail d'invitation, version dépôt

- [ ] Gabarit `invitation` adapté (pas dupliqué)
- [ ] Sous-nom d'expéditeur « Accès »
- [ ] Sujet au nom du **transporteur** : « MH CARS vous ouvre le suivi de ses livraisons » — c'est de lui que le dépôt attend un e-mail, pas de Tracky
- [ ] Preheader renseigné : « Suivez vos livraisons en direct, sans compte à créer côté logistique »
- [ ] Corps : ce que le compte permet, ce qu'il ne permet pas, lien d'activation en clair
- [ ] Signature du transporteur, « propulsé par Vizyo Tracky » en pied
- [ ] Règles héritées : clair par défaut, pas de crochets dans le sujet, accents corrects, aucune information portée uniquement par une image

### A5.6 — Confirmations enrichies

- [ ] Suspension : annonce ce qui est révoqué (liens de partage actifs)
- [ ] Suppression : annonce le nombre — « 3 missions en cours perdront leur destinataire »

### Recette A5 — les 9 critères

- [ ] 1 — inviter un dépôt → e-mail reçu, sujet au nom du transporteur
- [ ] 2 — activer l'invitation → redirection vers `/depot`, onboarding affiché une fois
- [ ] 3 — formulaire, rôle Dépôt → aucun champ de périmètre
- [ ] 4 — tenter d'accorder `vehicles_view` à un dépôt → impossible en interface, refusé par l'API
- [ ] 5 — suspendre un dépôt → déconnecté, liens révoqués
- [ ] 6 — supprimer un dépôt → missions conservées, destinataire vidé, compteur annoncé
- [ ] 7 — changer le rôle d'un dépôt → refusé
- [ ] 8 — matrice → 6ᵉ colonne, marqueur ◆, légende présente
- [ ] 9 — liste → colonne Périmètre = activité, pas un groupe

- [x] Vérification (le périmètre du § 5 — `pnpm verify` ne se termine jamais, cf. piège 1) : typecheck 3/3 · smoke 5/5 · **1849 tests API** (132 suites) · 277 tests partagés · build web vert · isolation base **18/18** · isolation HTTP **44/44** · contraste dépôt **16/16 couples ≥ 4,5:1**
- [x] **Commit** `feat(users): invitation et gestion des comptes depot`
- [ ] ⏸️ **Point de contrôle client** — un dépôt invité se connecte

---

## Lot A3 — L'espace dépôt : les écrans

> `design/A3-ESPACE-DEPOT.md`. Nouvelle route `/depot`, 4 onglets, 3 déclinaisons.
> `apps/web/src/app/features/depot/` (nouveau).

### A3.1 — Backend : le module `depot`

`apps/api/src/depot/` — **ne pas réutiliser les contrôleurs de la flotte** : leurs DTO
exposent coûts, scores, conducteur hors mission, groupe.

- [x] `GET /depot/missions?status=&from=&to=` → missions du dépôt, DTO restreint
- [x] `GET /depot/missions/:id` → une mission + son déroulé
- [x] `GET /depot/missions/:id/position` → position live, `403` hors fenêtre
- [x] `GET /depot/trips/:id` → trajet d'une mission terminée
- [x] `GET /depot/history?from=&to=` → trajets terminés + **KPI calculés côté serveur** (un calcul client obligerait à servir toutes les missions)
- [x] `POST /depot/exports` → PDF/CSV borné aux missions du dépôt. **Ne pas** réutiliser le générateur de `/reports` : ses colonnes exposent des données d'exploitation
- [x] `GET /depot/documents` → bons de livraison, rapports. État vide sans erreur si le transporteur n'en produit pas
- [x] `POST /depot/incidents` → signalement au transporteur
- [x] Tous portent `DepotScopeGuard`
- [x] Endpoint dédié pour l'appel conducteur, qui **journalise l'accès** (le numéro complet ne transite pas par le DTO)

### A3.2 — Carte live (`/depot`)

**PC (1600 × 1000)** — 3 zones : menu 244 px · panneau missions 384 px · carte

- [x] En-tête : « Missions du jour », date, dépôt
- [x] Pastille verte pulsée « 4 camions en mission »
- [x] Actions à droite : Signaler · Exporter · **Partager un suivi** (bouton accent)
- [x] Panneau missions : filtres En cours / Planifiées / Terminées
- [x] Carte de mission : référence, statut, trajet, créneau, plaque, conducteur + bouton d'appel, distance restante pour la sélection
- [x] **Encart tireté qui nomme ce qui est absent** : « Les 3 autres camions de votre transporteur ne sont pas sur vos missions : ils ne vous sont pas visibles. » Sans cette phrase, un dépôt qui sait que le transporteur a 7 camions se demande si l'outil est cassé ; avec elle, l'absence devient une garantie
- [x] Carte : tuiles CartoDB clair/sombre selon le thème
- [x] Marqueurs camion avec halo pulsé pour les missions en cours, **rouge** pour les retards
- [x] Marqueur tireté **violet** pour le dépôt de départ
- [x] Composant de carte réutilisé depuis `/map` avec **configuration restreinte** : pas de calques géofences, pas de lieux clés, pas de sélecteur de véhicules
- [x] Barre basse : plaque, mission, conducteur, vitesse, arrivée estimée avec l'avance ou le retard, boutons « Le camion » et « Voir le trajet »

**iPhone 390 × 844**
- [x] Carte plein écran
- [x] Barre d'onglets basse 4 entrées (Carte · Missions · Historique · Compte)
- [x] En-tête flottant : monogramme du transporteur + bouton de partage
- [x] Puces de filtre horizontales
- [x] Feuille basse 330 px redimensionnable

**Android 412 × 915**
- [x] Menu latéral, **pas** de barre d'onglets (les 3 boutons système occupent déjà le bas)
- [x] Top app bar avec hamburger
- [x] Puces filtres M3
- [x] Feuille basse 28 dp, poignée 32 × 4
- [x] **FAB étendu « Partager »**, remonté à 100 px quand un snackbar est affiché

**Rafraîchissement**
- [x] WebSocket sur `depot:mission:<missionId>`, une room par mission en cours
- [x] Repli en polling toutes les 20 s si le socket tombe
- [x] « rafraîchie il y a 12 s » est un **vrai compteur**, pas un texte fixe
- [x] Au-delà de 60 s sans message : « Connexion perdue · nouvelle tentative »

### A3.3 — Missions (`/depot/missions`)

- [x] Même liste que le panneau, en pleine largeur, détail accessible
- [x] Tri : en cours d'abord (**retards en tête**), puis planifiées par heure de départ, puis terminées
- [x] **État vide soigné** — c'est le premier écran d'un nouveau dépôt : « Aucune mission pour l'instant / Votre transporteur vous assignera des missions depuis son espace. Vous recevrez un e-mail à chaque nouvelle mission. » + bouton [Comment ça marche]

### A3.4 — Historique (`/depot/history`)

- [x] Filtres : 7 jours / 30 jours / Ce mois · camion · destination
- [x] 4 KPI : missions livrées · **% à l'heure** · durée moyenne · retard moyen avec le nombre de cas
- [x] « % à l'heure » calculé sur les missions `DONE` de la période : `actualEndAt <= endAt`. C'est la note du transporteur — l'indicateur que le dépôt regarde vraiment
- [x] Tableau : Réf. · Trajet · Date · Créneau réel · Camion · Conducteur · Distance · Arrêts · Ponctualité · actions (voir, PDF)
- [x] Pied de tableau : « 6 trajets sur 23 · les trajets hors de vos missions ne figurent pas dans cet historique. »
- [x] Mobile : cartes plutôt que tableau (3 visibles sur iPhone, 4 sur Android)
- [x] **Conservation 12 mois écrite dans l'interface**, pas seulement dans les CGU
- [x] Historique vide → « Vos missions terminées apparaîtront ici »
- [x] Moins de 3 missions terminées → KPI affichent un tiret **expliqué** : « 2 missions seulement, un taux demande 5 missions »

### A3.5 — Documents (`/depot/documents`)

- [x] Rail droit sur PC, onglet plein écran sur mobile
- [x] Rapport hebdomadaire — généré tous les lundis 08:00, PDF
- [x] Bon de livraison — par mission terminée, PDF
- [x] Export de période — à la demande, PDF ou CSV
- [x] Interrupteur « rapport automatique » activé par défaut (« chaque lundi à 08:00 », par e-mail), le dépôt peut le couper

### A3.6 — Les 6 modales

**Détail d'un trajet**
- [x] 4 tuiles : distance · durée · arrêts · arrivée estimée (en accent)
- [x] Mini-carte avec le tracé et la position actuelle (`mini-map` du kit)
- [x] **Déroulé horodaté** : chaque étape, son heure réelle, le temps passé sur place. L'étape à venir en tireté avec l'heure estimée
- [x] Le temps passé sur place est ce qui permet de comprendre un retard sans appeler
- [x] Pied : Exporter ce trajet · Signaler un incident · Partager le suivi

**Détail d'un camion**
- [x] Plaque, modèle, transporteur, conducteur, téléphone masqué, mission en cours, missions du mois + taux de ponctualité
- [x] Encart de fermeture avec icône cadenas : « Hors fenêtre de mission, la position de ce camion vous est masquée. Vous ne voyez ni ses trajets privés ni les autres véhicules du transporteur. »

**Signaler un incident**
- [x] Mission pré-remplie · motif en puces (Retard / Marchandise / Accès dépôt / Autre) · texte libre
- [x] `POST /depot/incidents` → notification + e-mail au transporteur
- [x] L'incident apparaît dans l'agenda du transporteur **comme un événement**, pas un simple message : il doit atterrir là où le gestionnaire regarde

**Export**
- [x] Période en puces · format PDF (rapport) ou CSV (données brutes)
- [x] Nombre de trajets concernés affiché **avant** de générer
- [x] Sur mobile, poids estimé (« ≈ 1,2 Mo ») — un export en 4G sans avertissement est une mauvaise surprise
- [x] Au-delà de 8 s : « le réseau est lent · Annuler »

**Onboarding première connexion**
- [x] Animation HTML/CSS en 3 étapes : la mission est créée → le camion roule → la livraison est tracée
- [x] Boucle de 12 s, **arrêtée sous `prefers-reduced-motion`**
- [x] Deux sorties : « Commencer » et « Revoir plus tard »
- [x] Lien discret vers `decouvrir-depot.html`
- [x] Affichée une fois, réaccessible par « Comment ça marche »

**Partage** → traitée en A4

### A3.7 — Les 7 règles d'interface

- [x] Aucun compteur de flotte : tout chiffre se calcule sur les missions du dépôt
- [x] Aucune donnée de coût, de score, de consommation
- [x] La plaque est la clé — jamais d'identifiant interne visible, **ni dans l'URL**
- [x] Téléphone masqué à l'écran, bouton d'appel via l'endpoint journalisé
- [x] Marque du transporteur en tête, Vizyo Tracky en pied de menu à 12 px
- [x] Lecture seule partout : les deux seules écritures d'un dépôt sont signaler un incident et générer un lien
- [x] Réutilisation du kit : `mini-map`, `bottom-sheet`, `confirm-modal`, `toast`, `skeleton`, `pdf-export-modal`

### A3.8 — États et cas particuliers

- [x] Aucune mission → carte centrée sur le dépôt + encart « Aucune mission en cours ». **Pas** une carte muette
- [x] Mission planifiée non démarrée → dans la liste, pas sur la carte, « Le suivi démarrera à 08:15 »
- [x] Position indisponible → dernière position **grisée** + « indisponible depuis 14 min ». Jamais présentée comme actuelle
- [x] Socket perdu → bandeau « Connexion perdue · nouvelle tentative »
- [x] Mission terminée pendant la consultation → marqueur retiré avec transition + toast explicatif
- [x] Véhicule en mode vie privée pendant la mission → « Suivi suspendu », sans dire pourquoi
- [x] Accès retiré → déconnexion + « Votre accès a été retiré par votre transporteur »

### Recette A3 — les 10 critères

- [x] 1 — connexion d'un dépôt sans mission → état vide expliqué, pas de carte muette
- [x] 2 — mission en cours → camion sur la carte, position rafraîchie
- [x] 3 — mission d'un autre dépôt → absente de la carte **et** de l'API
- [x] 4 — fin de mission pendant la consultation → marqueur retiré, toast explicatif
- [x] 5 — coupure réseau → bandeau, puis reprise automatique
- [x] 6 — export 7 jours PDF → fichier borné aux missions du dépôt
- [x] 7 — signalement d'incident → événement créé dans l'agenda du transporteur
- [x] 8 — iPhone 390 px → aucun débordement, cibles ≥ 44 px
- [x] 9 — Android 412 px → menu latéral, pas de barre d'onglets, FAB présent
- [x] 10 — thème clair et sombre → contrastes ≥ 4,5:1 sur le texte

- [x] Vérification — **le périmètre du § 5, pas `pnpm verify`** (qui ne se termine jamais, cf. piège 1) :
      typecheck 3/3 · smoke 5/5 · **1849 tests API** (132 suites) · 277 tests partagés · build web vert ·
      isolation base **18/18** · isolation HTTP **44/44** · contraste dépôt **16 couples ≥ 4,5:1** ·
      littéraux de gabarit sains
- [x] **Commit** `feat(depot): espace depot — carte live, missions, historique, documents`
- [ ] ⏸️ **Point de contrôle client** — l'espace dépôt sur 3 plateformes

---

## Lot A4 — Le partage : lien public temporaire

> `design/A4-PARTAGE.md`. **Le lot le plus sensible.** Un lien public qui n'expire pas, ou
> qui expose plus que prévu, est une fuite de données permanente et indexable.

### A4.1 — Le modèle

- [x] `MissionShareLink` créé conforme à A4 § 1, calqué sur `ReservationBookingLink`
- [x] `enum ShareDuration` : `MIN_15`, `HOUR_1`, `UNTIL_MISSION_END`
- [x] `@@index([missionId, createdAt])`, `@@index([expiresAt])`
- [x] `lastOpenedFrom` = empreinte **tronquée**, jamais l'IP complète (RGPD)
- [x] Migration générée, relue, appliquée

### A4.2 — Le token

- [x] 22 caractères base62, tirés de `crypto.randomBytes` — pas d'uuid, pas de compteur
- [x] **Jamais dérivé de l'identifiant de mission** : un token prévisible donne accès à toutes les missions
- [x] Non réutilisable : un nouveau partage crée un nouveau lien. Régénérer le même token permettrait à un ancien destinataire de revenir
- [x] Test : 10 000 tokens générés, aucune collision, distribution uniforme

### A4.3 — Le DTO public — la spécification la plus importante du lot

`PublicTrackingDto`. **Tout champ absent de la liste ne doit pas quitter le serveur.**

- [x] Exposé : `status`, `position { lat, lng } | null`, `etaAt`, `destinationLabel` (la **ville**, pas l'adresse exacte), `carrierName`, `expiresAt`, `lastUpdateAt`
- [x] **Jamais** : plaque (identifie un véhicule et son propriétaire)
- [x] **Jamais** : nom du conducteur, téléphone (données personnelles, aucun motif)
- [x] **Jamais** : référence de mission (permet de deviner le volume d'activité)
- [x] **Jamais** : adresse exacte, origine (révèle l'implantation du dépôt)
- [x] **Jamais de tracé parcouru** — le piège classique : « d'où vient le camion » révèle les points de livraison précédents, donc les autres clients du dépôt. Le lien montre **un point**, pas une ligne
- [x] **Jamais** : historique
- [x] Test d'assertion sur les clés exactes de la réponse

### A4.4 — Les endpoints

**Côté dépôt (authentifié)** — `apps/api/src/depot/mission-share.controller.ts`
- [x] `POST /depot/missions/:id/share { duration }` → `{ token, url, expiresAt }`
- [x] `GET /depot/missions/:id/shares` → liens actifs + usage
- [x] `DELETE /depot/shares/:id` → révocation immédiate
- [x] Gardes : `DepotScopeGuard` + `mission_share`
- [x] Limite : 3 liens actifs maximum par mission
- [x] Limite : 20 créations par heure et par compte (`@Throttle`)

**Côté public (sans authentification)** — `public-mission-share.controller.ts`
- [x] `GET /public/track/:token` → `PublicTrackingDto`
- [x] Aucun `JwtAuthGuard`, sur le modèle de `PublicReservationBookingController`
- [x] `@Throttle({ default: { ttl: 60_000, limit: 30 } })`
- [x] **Pas de WebSocket** sur le lien public — un socket non authentifié est une surface d'attaque disproportionnée pour un point sur une carte. Polling 20 s côté client
- [x] En-tête `Cache-Control: no-store`
- [x] En-tête `X-Robots-Tag: noindex, nofollow` — **indispensable** : sans lui, un lien collé dans un message public finit indexé
- [x] En-tête `Referrer-Policy: no-referrer`

### A4.5 — L'expiration

- [x] `MIN_15` → `now + 15 min`
- [x] `HOUR_1` → `now + 1 h`
- [x] `UNTIL_MISSION_END` → `mission.endAt + 30 min` (la marge couvre le retard : un lien qui expire pile à l'heure prévue meurt au moment où le client en a le plus besoin)
- [x] **Non prolongeable** : aucun endpoint ne repousse `expiresAt`. Pour prolonger, on crée un nouveau lien, sciemment
- [x] Vérifiée à chaque requête, à l'heure serveur
- [x] **La fin de mission ferme tous les liens**, quelle que soit leur durée : suivre un camion après sa livraison, c'est suivre sa tournée suivante
- [x] Tâche de purge quotidienne : suppression des liens expirés depuis plus de 30 jours (30 jours gardés pour l'audit)
- [x] Tâche enregistrée dans l'inventaire `/admin/background-tasks`

### A4.6 — La révocation et l'audit

- [x] Bouton « Révoquer » par lien actif, avec le nombre d'ouvertures : « ouvert 3 fois, dernière il y a 4 min »
- [x] Effet immédiat, aucun cache
- [x] Le transporteur peut révoquer **n'importe quel** lien de sa flotte, y compris ceux créés par un dépôt — c'est lui qui porte la responsabilité des données
- [x] Dépôt désactivé → ses liens actifs sont révoqués automatiquement
- [x] Toute création et toute révocation journalisées : qui, quand, quelle mission, quelle durée

### A4.7 — La modale de partage

`features/depot/share-dialog/`

- [x] La mission concernée, en lecture seule
- [x] 3 puces de durée : `15 min` (défaut) · `1 h` · `Fin de mission`
- [x] Lien généré + bouton Copier
- [x] Encart ambré avec **compte à rebours réel** : « Expire dans 14:52 · révocable à tout moment »
- [x] **Phrase de périmètre** sous le titre : « Un lien public à envoyer à votre client final. Il n'affiche que la position et l'heure d'arrivée du camion de cette mission, et expire automatiquement. » Le dépôt doit savoir ce qu'il transmet avant de l'envoyer
- [x] iOS : feuille basse, bouton pleine largeur « Copier et envoyer » qui ouvre la feuille de partage native
- [x] Android : FAB « Partager », snackbar « Lien copié » avec action **ANNULER qui révoque** — la sortie du geste raté, dans les 5 secondes, sans ouvrir de menu

### A4.8 — La page publique `/s/:token`

`features/public-tracking/` — mobile d'abord : elle s'ouvre depuis un SMS ou WhatsApp dans 90 % des cas.

- [x] Route `/s/:token` ajoutée à `app.routes.ts`, **hors** du shell authentifié (`auth-layout` ne s'applique pas)
- [x] Nom du transporteur en tête, discret
- [x] Carte plein écran, camion centré, halo pulsé
- [x] Bandeau bas : « Arrivée estimée **11:34** » + statut (« en route », « en retard de 22 min »)
- [x] Mention d'expiration : « Ce lien expire à 12:05 »
- [x] **Aucune navigation, aucun lien vers l'application, aucun formulaire**
- [x] **Pas de compte, pas de cookie, pas d'analytics tiers.** La page ne pose rien sur l'appareil du destinataire
- [x] Compte à rebours réel

**Les 4 états**
- [x] Actif → carte + arrivée estimée
- [x] Expiré → « Ce lien de suivi a expiré » + « Demandez-en un nouveau à votre expéditeur ». **Pas** de bouton de renouvellement : le destinataire n'a pas ce droit
- [x] Révoqué → **écran identique**. Dire « révoqué » indiquerait qu'il a existé et que quelqu'un l'a fermé
- [x] Introuvable → **écran identique encore**
- [x] Les trois derniers partagent le **même code HTTP `410 Gone`** — uniformité délibérée : elle empêche de distinguer un token inexistant d'un token fermé, donc d'énumérer

### A4.9 — États et cas particuliers

- [x] Lien ouvert avant `startAt` → carte centrée sur la destination, « Le suivi démarrera à 08:15 », puis bascule seul
- [x] Position indisponible → dernier point grisé + « position indisponible depuis 6 min ». Jamais un point périmé présenté comme actuel
- [x] Mission terminée pendant la consultation → « Livraison effectuée à 11:34 », carte figée 30 s, puis écran de fin
- [x] Mission annulée pendant la consultation → « Cette livraison a été annulée. Contactez votre expéditeur. »
- [x] Mission `PLANNED` **peut** être partagée · `DONE` ou `CANCELLED` ne peut plus l'être, et ses liens existants sont fermés
- [x] Le lien ne donne accès qu'à **une** mission. Jamais un lien « toutes mes livraisons »
- [x] Véhicule changé sur la mission → le lien suit la mission, transparent pour le destinataire
- [x] 4ᵉ lien sur une mission → refus avec message clair

### A4.10 — La liste de contrôle sécurité

- [x] Token cryptographique, 22 caractères, non dérivé d'un identifiant
- [x] `expiresAt` vérifié côté serveur à chaque requête
- [x] `410` uniforme pour expiré / révoqué / introuvable
- [x] `X-Robots-Tag: noindex, nofollow`
- [x] `Cache-Control: no-store`
- [x] `Referrer-Policy: no-referrer`
- [x] Débit borné sur la route publique
- [x] Aucune donnée personnelle dans le DTO public
- [x] Aucun tracé, un point seulement
- [x] Fermeture automatique à la fin de mission
- [x] Journal d'audit complet
- [x] IP tronquée, jamais complète

### Recette A4 — les 12 critères

- [x] 1 — générer un lien 15 min, l'ouvrir → carte + arrivée estimée
- [x] 2 — **attendre 16 minutes réelles**, rouvrir → `410` + écran « expiré ». *Attendre, pas simuler*
- [x] 3 — révoquer, rouvrir → écran identique à l'expiré, même code
- [x] 4 — token inventé → écran identique encore
- [x] 5 — **inspecter la réponse publique** → aucune plaque, aucun nom, aucun tracé
- [x] 6 — terminer la mission → tous les liens fermés immédiatement
- [x] 7 — générer 4 liens sur une mission → le 4ᵉ refusé avec un message clair
- [x] 8 — 40 créations en une heure → débit borné
- [x] 9 — vérifier les en-têtes → `noindex`, `no-store`, `no-referrer`
- [x] 10 — lien ouvert sur mobile 360 px → carte lisible, arrivée estimée visible sans défilement
- [x] 11 — dépôt désactivé → ses liens actifs deviennent inopérants
- [x] 12 — journal d'audit → création et révocation tracées avec leur auteur

- [x] Vérification — **le périmètre du § 5, pas `pnpm verify`** (qui ne se termine jamais, cf. piège 1) :
      typecheck 3/3 · smoke 5/5 · **1885 tests API** (134 suites) · 277 tests partagés · build web vert ·
      isolation HTTP **65/65** (dont 21 contrôles A4) · 36 tests dédiés au partage (token + service)
- [x] **Commit** `feat(depot): lien public temporaire de suivi de mission`
- [ ] ⏸️ **Point de contrôle client** — le partage complet

---

## Bloc B — La refonte de l'interface

> ✅ **Débloqué le 2026-08-10.** Les 28 planches sont dans `design/maquettes/`, avec leur
> `support.js` et `brands/`. `00-INDEX.md` donne la correspondance planche → routes.
>
> **Comment lire une planche** : ce sont des Design Components (`<x-dc>` + styles en ligne).
> Le contenu se lit dans un éditeur, en clair ; le rendu s'obtient en ouvrant le `.dc.html`
> dans un navigateur. Chaque planche montre le même écran en `01` PC · `02` PC 2ᵉ état ou
> modales · `03` iPhone 390 × 844 · `04` Android 412 × 915.
>
> ⚠️ **Le piège n° 1 de `00-INDEX.md` est périmé** : il annonce une traduction Manrope →
> Poppins. C'est l'inverse — l'application tourne DÉJÀ en Manrope (Écart 2). Il n'y a pas de
> planche de contrôle à mesurer, ni de risque de débordement. Les deux autres pièges tiennent :
> variables CSS → `TOKENS.md`, `<symbol>` SVG → `ICONS.md`, à l'exception des pastilles de
> véhicule de `Carte Refonte`, à reprendre telles quelles en SVG.

### B0′ — Le reliquat du socle (débloqué)

Les 4 défauts de code relevés en lisant la source, indépendants de la refonte.

**Couleurs en dur**
- [x] `connectivity-badge.component.ts` : les 6 hex (`#10b981`, `#0ea5e9`, `#ef4444`, `#f59e0b`, `#64748b`, `#9ca3af`) remplacés par des jetons — elles ne suivent pas le thème clair et doublent les variables
- [x] Idem dans le rejeu de trajet — **et une exception assumée** : les couleurs de COUCHE DE CARTE (`shared/utils/couleurs-carte.ts`) restent explicites. Elles se posent sur le fond de carte, qui est un choix séparé de l'utilisateur (clair, sombre, satellite) ; et MapLibre ne résout aucune variable CSS — un `var()` y donne une couche invisible, sans erreur
- [x] Distinction ajoutée : *Dormant* passe en **violet** (boîtier muet depuis plus d'une semaine ≠ panne réseau — deux problèmes ne partagent pas l'ambre)
- [x] Distinction ajoutée : *Non configuré* prend un **contour tireté** (absence d'installation, pas un état de terrain). Il partage désormais le gris de « Stationné » : #64748b et #9ca3af étaient indiscernables à 10 px, c'est le contour qui porte la distinction
- [x] Vérifié en thème clair **et** sombre — mesuré dans le navigateur : `borderStyle: dashed`, `color: rgb(86,99,94)`, fond et bordure en `color-mix` à 12 % et 28 %
- [x] **Défaut trouvé en mesurant** : trois états passaient sous 4,5:1 en thème clair une fois branchés sur les jetons (*En ligne* 2,99, *GPS perdu* 3,40, *Hors ligne* 2,68). D'où la famille `--texte-*` — même signification, valeur assez foncée pour être lue. Le point ouvert **O2** de `design/TOKENS.md` est tranché, le **O3** est fait
- [x] `.layout--depot` n'est plus qu'un jeu d'alias : les 4 jetons d'A3 sont absorbés, une seule définition de « le rouge qui se lit » pour les 30 écrans

**Surveillance réglée en UTC — le plus grave**
- [x] `surveillance-panel.component.ts` : saisie en **heure de la flotte**, équivalent UTC en note de pied — « 18:00 → 23:00 correspond aujourd'hui à 16:00 → 21:00 UTC », décalage **mesuré** pour la date du jour, jamais codé en dur
- [x] Conséquence réelle corrigée : une surveillance réglée « 18:00 » démarrait à 20:00 en été — deux heures pendant lesquelles le véhicule n'était pas protégé, sans que personne ne le sache
- [x] **Le correctif n'est pas dans l'écran, il est dans le planificateur.** `isWithinSchedule` lisait `getUTCHours()`. Une plage récurrente n'a pas d'équivalent UTC (+2 h l'été, +1 h l'hiver) : aucune saisie ne pouvait la rendre juste. Elle se lit désormais dans le fuseau de la flotte, via `getNowInTimezone` — l'helper qu'utilisent déjà `VehicleSchedule` et `VehicleWorkSchedule`. La surveillance était le seul planning resté en UTC
- [x] Vérifié sur un changement d'heure (été/hiver) : 4 tests dédiés — 18:00 démarre à 16:00 UTC en juillet, à 17:00 UTC en janvier ; le jour de la semaine est celui de Paris (lundi 00:30 Paris = dimanche 22:30 UTC) ; un fuseau tiers est accepté
- [x] Les réglages existants en base sont migrés **sans rupture** : `20260810120000_surveillance_horaires_locaux` convertit les horaires UTC en heure locale avec le décalage en vigueur au déploiement. Aucun véhicule ne change de fenêtre de protection

**Accents perdus**
- [x] Assistant de démarrage (« Pret a piloter votre flotte ? » → « Prêt à piloter votre flotte ? »)
- [x] Sujets d'e-mail (« Vous etes invite a rejoindre » → « Vous êtes invité à rejoindre »)
- [x] Corps d'e-mail
- [x] Passe globale : **`scripts/verif-accents.mjs`** (`pnpm verif:accents`), qui cherche les mots français sans accent dans les seuls contextes vus par un humain — message d'exception, toast, sujet, libellé, texte de gabarit. 224 occurrences relevées, 224 corrigées, dont les **49 libellés de la matrice de permissions**
- [x] Le contrôle attrape le piège du `\b` ASCII : dans « paramètres », le `è` compte comme une non-lettre, donc `\btres\b` matchait un texte parfaitement accentué. Bornes Unicode
- [x] **Trois corruptions rattrapées** — l'accentuation automatique avait touché du CODE : `${entrée.originLabel}`, `this.durée()`, et surtout `role === 'Dépôt'` (le slug est `DEPOT`) qui aurait éteint tout l'espace dépôt en silence. Le typecheck et le build web les ont sorties ; le script neutralise désormais les interpolations avant de chercher

**Compteurs d'étapes codés en dur**
- [x] `onboarding-wizard.component.ts` : `Step = 1|2|3|4|5` supprimé — décision client, l'assistant passe à **2 étapes pour tout le monde**. Le défaut se résout en supprimant, pas en corrigeant
- [x] Les étapes véhicule, invitation et récapitulatif disparaissent (−200 lignes)
- [x] Portes d'accès : « étape N sur 3 » devient **calculé** — `PortesAccesService` compte les portes réellement exigées. La vérification d'appareil n'apparaît que si la 2FA est active *et* la connexion inhabituelle
- [x] **Le total ne redescend jamais** : lu directement sur les conditions, il passerait de « 1 sur 2 » à « 1 sur 1 » au moment où l'on franchit la première porte — le défaut même qu'on corrige. On mémorise les portes vues exigées depuis le début de la session
- [x] Une porte seule n'affiche aucun compteur : « 1 sur 1 » n'informe personne. Vérifié dans le navigateur — la porte des autorisations s'affiche sans rang
- [x] Vérifié dans le navigateur : « Étape 1 sur 2 » puis « Étape 2 sur 2 », barre à 50 % puis 100 % (`style="width: 50%"` → `width: 100%`)

- [x] Vérification (le périmètre du § 5 — `pnpm verify` ne se termine jamais, cf. piège 1) : typecheck 3/3 · smoke 5/5 · **1889 tests API** (134 suites) · 277 tests partagés · build web vert · isolation base **18/18** · isolation HTTP **65/65** · contraste **46/46 couples ≥ 4,5:1** · littéraux et accents propres
- [x] **Commit** `fix(ui): couleurs en dur, surveillance en heure locale, accents, compteurs d'etapes`

### B-kit — Le kit partagé (passe de raffinement)

> Les 23 composants existent déjà (Écart 3). Ce lot les **unifie**, il ne les crée pas.
> Ordre d'attaque par nombre de pages touchées.

**Préalable — la palette, tranchée à la mesure** *(fait)*
- [x] `--surface-quaternary` créé — le `--surface3` des planches, **505 usages dans 27 planches sur 28**. Le point ouvert **O1** de `TOKENS.md` est clos
- [x] Les écarts planches ↔ application mesurés et consignés : `--accent-ink` (l'application gagne, la planche est à 3,43:1 et contredit la règle non négociable de B0), `--violet`, `--blue`, `--accent2` (différés au lot qui les consomme — les planches sont tenues en sombre, plus lâches en clair)
- [x] Règle qui s'en dégage pour tout le bloc B : **on reprend la décision de la planche, pas sa valeur, dès que la valeur tombe sous 4,5:1 sur du texte**

- [ ] `connectivity-badge` (9 pages) — les 6 états *(couleurs et distinctions faites au lot B0′)*
- [x] `confirm-modal` (14 pages) — **conséquences chiffrées obligatoires**, mention *Irréversible*, variante **critique** (liseré rouge, état de l'objet rappelé, plaque à retaper), couleurs en jetons, encre foncée sur l'accent, **feuille sous 640 px** et non boîte centrée
- [x] `scripts/verif-confirmations.mjs` (`pnpm verif:confirmations`) — refuse un `[danger]` sans `[consequences]`, un `[critique]` sans `[confirmationAttendue]`, un libellé sans verbe. **8 appels complétés** : coupure moteur (fiche et carte), archivage et anonymisation d'un conducteur, suppression d'un planning et d'une ligne, envoi d'une commande, désactivation de l'automatisation horaire
- [x] **`app-zone` — les 6 états, rendus une fois pour toutes.** `chargement` (squelette, jamais un rond) · `rempli` · `vide` (dit ce qui est vide ET quoi faire) · `erreur` (porte toujours un recours) · `partiel` (le contenu RESTE, un bandeau nomme ce qui manque) · `interdit` (nomme la permission, libellé tiré de `PERMISSION_LABELS`)
- [x] **Au-delà de 8 s, le squelette cède la place à une sortie** — « l'utilisateur doit pouvoir abandonner ». Un squelette qui pulse indéfiniment est un mensonge poli
- [x] `toast` — **passe en haut sur mobile** : « le bas est occupé par la barre d'onglets ». Le code d'avant restait en bas et remontait de 76 px, redescendait en plein écran, remontait sur modale — trois positions pour une surface, et une collision garantie avec la feuille. Les 4 types passent sur la famille `--texte-*` (`text-red-400`, `text-amber-400`, `text-sky-400` étaient hors système)
- [x] `skeleton` + `spinner` — primitives déjà propres, désormais consommées par `app-zone` selon la règle « page → squelette, action → rond dans le bouton »
- [x] `bottom-sheet` (11 pages) — **géométrie de plateforme** (rayon et poignée depuis les jetons d'A3 ; la feuille était figée à 20 px et 44 × 4, ni iOS ni Android), **hauteur annonçable** (les six feuilles de la maquette sont dimensionnées : 44 à 72 %), **variante sans voile** pour les feuilles posées sur la carte
- [ ] `bottom-sheet` — les 6 états
**Règle n° 1 — aucune couleur en dur** *(faite sur le kit entier)*
- [x] `scripts/verif-couleurs-kit.mjs` (`pnpm verif:couleurs-kit`) — **76 couleurs en dur relevées, 76 traitées**. Le contrôle attrape les deux formes : l'hexadécimal écrit à la main, et la classe de PALETTE Tailwind (`text-red-400`, `bg-amber-500`) qui a la syntaxe du système sans en faire partie
- [x] **34 replis morts purgés** — `var(--x, #hex)` : la variable est toujours définie, la valeur de repli n'est jamais atteinte. Même défaut que les 22 fallbacks `Poppins` de l'étape 0
- [x] Trois exceptions assumées et documentées dans le contrôle : les couches MapLibre (qui ne résolvent aucune variable CSS), les graphiques (canvas, couleurs lues par `getComputedStyle`), et la plaque de logo constructeur (support d'image — un logo noir sur une surface sombre disparaîtrait)

- [x] `group-badge` — **la couleur vient de l'identifiant, pas du rang.** « Chantier Nord reste rouge sur la carte, dans les listes et dans les rapports. » Le badge était monochrome ; une couleur tirée du rang aurait changé au premier tri. 5 tests verrouillent la stabilité
- [x] `metric-card` — **« mieux vaut un tiret expliqué qu'un 0 faux »**, le manque le plus courant sur les cartes chiffrées. `null`, `undefined` et `NaN` deviennent « — » plutôt que « null » en gros et en gras
- [x] `alerts-bell` — le SOS garde son fond rouge et sa pulsation, sur jetons
- [x] `mini-map` — l'état vide DIT pourquoi : « une mini-carte grise sans explication ressemble à un bug de chargement »
- [x] `trip-note-modal` · `pdf-export-modal` · `plan-upsell` · `push-prompt` · `driver-picker` · `install-banner` · `install-review-badge` · `brand-logo` · `charts` — passe couleurs
- [x] `date-range-picker` — **les 4 raccourcis AVANT la grille** (« dans 9 cas sur 10 on veut 7 jours, pas un calendrier ») et **le total de la sélection affiché** (« on évite les *du 1er au 31* involontaires »). La semaine commençait déjà au lundi
- [x] `theme-toggle` — **libellé dans les réglages, pictogramme seul dans les barres**. Le libellé dit l'ÉTAT (« Thème sombre »), l'action reste dans l'`aria-label`. La pulsation ne subsiste que sur la version barre : dans une liste de réglages, la ligne est déjà libellée
- [x] `logo` / `brand-logo` — **les deux composants que leur nom fait confondre** portent maintenant le test qui tranche : si l'image change d'un véhicule à l'autre c'est le constructeur, si elle est la même partout c'est la marque Vizyo
- [x] `datetime-range` · `super-admin-context` · `install-*` · `pdf-export-modal` — passe couleurs (**27 `rgba()` teintés convertis** : `rgba(16,224,160,.35)` est le vert de marque écrit autrement, et il n'a pas de `#` pour se dénoncer)
- [ ] `update-required-modal` + `push-prompt` + `trip-note-modal` — « trois usages, un seul squelette ». **Reporté à B-pages, volontairement** : les trois surfaces ont des rôles différents (bandeau non bloquant, modale bloquante, saisie de texte) et les fondre est une décision d'écran. Leurs couleurs sont sur jetons ; c'est la géométrie qui reste à unifier

**Les 6 états obligatoires sur chacun** : `chargement` · `rempli` · `vide` · `erreur` ·
`partiel` · `interdit`. C'est le manque le plus fréquent du code actuel : beaucoup de
composants ne gèrent que « rempli » et « chargement ».

- [x] **`interdit` en particulier** : `app-zone` nomme la permission manquante avec le libellé de la source partagée — « Il vous manque **Couper / redémarrer le moteur**. Un administrateur de la flotte peut vous l'accorder. » Une chaîne recopiée dériverait au premier renommage
- [x] Les 5 règles du kit, portées par le kit lui-même : aucune couleur en dur · squelette et non rond · une erreur porte un recours · nommer ce qui est perdu (`pnpm verif:confirmations`) · modale sur PC, feuille sur mobile
- [x] Un composant démontre ses 6 états — **8 tests sur `app-zone`**, qui valent mieux qu'une page de démonstration : une page se regarde une fois, un test se relance
- [x] **P1 CORRIGÉ — `pnpm verify` se termine.** Il pendait indéfiniment (`ng test` sans `--watch=false`, 25 min à CPU nul, 29 Chrome vivants). Et sous ce blocage s'en cachait un second : la suite web ne COMPILAIT plus depuis le lot A2 — `platform.spec.ts` utilisait l'API Jest (`it.each`, `jest.fn()`) dans un runner Jasmine. **311 tests web tournent maintenant**, pour la première fois. `pnpm verify` complet : 40 s
- [x] **Commits** `refactor(ui): kit partage` ×3 — la confirmation qui nomme ce qui est perdu · les 6 états et le toast en haut · la couleur qui vient du système

### B-pages — Les 29 pages

> Chaque page suit le même protocole : lire la maquette comme référence, traduire en classes
> Tailwind existantes et composants du kit, vérifier les 8 critères de recette communs.
> **Ordre non négociable** (B1 § « Ordre d'implémentation ») : le kit avant les pages, le
> shell **en dernier** — le brancher trop tôt force à trancher la navigation avant d'avoir vu
> les pages vivre.

**C — Supervision (6)**
- [ ] `/dashboard` — 4 tuiles de KPI en tête, widgets en grille
- [ ] `/map` — pastilles de véhicule redessinées (SVG repris tels quels), calques, feuille de position
- [ ] `/places` — pendant « liste » de la carte
- [x] `/vehicles/:id` — **10 onglets regroupés en 4 familles** : Suivi · Analyse · Sécurité · Exploitation. **Rien supprimé**, et c'est prouvé : 9 tests vérifient que l'union des familles redonne la liste d'entrée, pour tous les profils de permission. Un onglet non rangé rejoint « Suivi » plutôt que de disparaître — le classement est un confort, l'accès est un dû. Sous deux familles (le veilleur n'a que Carte et Horaires) on retombe sur la rangée plate
- [ ] `/vehicles` — onglets liste / groupes / capacités / mode privé ; sur mobile cartes + filtres en feuille
- [ ] `/alerts` — onglets Alertes / Géofences / Réglages

**D — Analyse (5)**
- [ ] `/reports` — barème A→E explicité, exports PDF/CSV/Excel, sur mobile sparklines + drill-down, **jamais de scroll horizontal**
- [ ] `/scores` — podium, classement, carte « ce qui coûte des points », tendance 7 semaines, lien de partage en lecture seule
- [ ] `/agenda` — propositions de l'agent IA, réglages, réservation avec suggestion *(le 3ᵉ onglet Missions est livré en A2)*
- [x] `/fleet-admin/activity` — **le résultat avant l'événement**. La raison EXISTAIT déjà en base
      (`lastError`, écrite par `rejectSpeed` : « Vitesse trop élevée : 74 km/h », « Position trop
      ancienne », « Fix GPS invalide ») et n'était affichée **nulle part** : l'écran montrait un mot
      de statut et s'arrêtait là. Aucun DTO n'a bougé. **Les échecs en tête** — un groupe « À
      vérifier · N » ouvre la liste avant le classement par jour. **La présence devient permanente**
      au-delà de 1024 px (colonne de 344 px) ; sous cette largeur elle reste un onglet, comme la
      planche mobile. **Une panne ne se déguise plus en liste vide** : le `catch` posait un tableau
      vide, donc un 500 affichait « Aucune action moteur sur cette flotte » — un mensonge rassurant
      sur l'écran même qui sert à vérifier que personne n'a touché aux véhicules. Mesuré : cibles
      **4 → 0**, 47 couples de texte ≥ 4,5:1 dans les deux thèmes (pire cas 4,65 clair / 5,96 sombre)
- [x] `/admin/ai-usage` — **le forfait d'abord, la consommation ensuite.** Pour un fleet-admin, la
      page menait avec `spentThisMonthEur` sous le libellé « Coûts IA de votre société » : le coût
      de CALCUL présenté comme si c'était la facture. Une carte « Votre option IA · ce mois » passe
      devant, alimentée par `BillingStatusDto` — **aucun contrat modifié**. La consommation devient
      « Consommation réelle sur le mois », suivie de « rien ne se coupe et rien ne vous est facturé
      en plus ». **Le plafond mensuel reste côté super-admin** : c'est un garde-fou INTERNE Vizyo,
      un fleet-admin y aurait lu « Dépassé » comme un problème pour lui. **Les 6 statuts sont
      traités** — `COMP` (IA offerte) n'affiche AUCUN montant, alors que le back calcule
      `monthlyEurCents` dans tous les cas : c'était le piège. **Garde sur la vue transverse** :
      sans société scopée, `resolveFleet` retombe sur la flotte du super-admin (ou lève un 400) —
      la carte n'est ni affichée ni même demandée. Mesuré : cibles **13 → 0**, 92 textes ≥ 4,5:1
      dans les deux thèmes (pire cas 5,55 / 6,12), et 5 couleurs en dur purgées dont un
      `text: #fff` sur l'accent

**E — Administration (10)**
- [ ] `/users` — invitations en attente et expirées, tiroir d'édition *(le rôle Dépôt est livré en A5)*
- [ ] `/users/overview` — matrice repensée en liste par rôle sur mobile
- [ ] `/installations` — le jour en cours au centre, anneau de progression + 4 compteurs, « ce qu'on attend de vous », SIM manquante expliquée
- [x] `/integrations` — **consentement en deux blocs, sensible décoché.** Le sensible était noyé
      dans une liste plate, distingué par une seule pastille : on cochait la **position temps
      réel** dans le même geste que la plaque d'immatriculation. Il a désormais son bandeau, qui
      nomme l'obligation qui va avec (« information des salariés obligatoire »). **La séparation
      est dérivée de `PARTNER_SCOPES_SENSITIVE`**, le registre partagé dont un test verrouille
      l'invariant « SENSIBLE ⇒ jamais dans les défauts » — une liste recopiée aurait divergé en
      silence, sur l'écran même où l'on accorde l'accès à des données nominatives. Vérifié : 7
      catégories courantes / 3 sensibles. **Chaque catégorie dit ce qui part** (« Rien n'est
      transmis » quand elle est éteinte), et les **deux garanties** sont écrites plutôt que
      sous-entendues. **L'erreur porte enfin un recours** — elle était un constat muet sur l'écran
      où le client vient vérifier ce qui sort chez un tiers. Mesuré : 56 textes ≥ 4,5:1 dans les
      deux thèmes (pire 4,83 / 6,62), 0 cible < 44 px, et **20 replis morts + 8 couleurs en dur
      purgés** — il n'en reste aucune dans le fichier
      ⚠️ **Le VOLUME chiffré n'est pas fait** : « 3 412 trajets », « 186 pleins » n'existent dans
      aucun DTO. Seule ligne de la page qui demanderait un changement de contrat — cf. fiche de reprise
- [ ] `/fleet-schedules` — **frise 24 h par groupe** au lieu de colonnes de texte, l'anomalie d'abord (bandeau « roulent encore »)
- [x] `/privacy-coverage` — **les 3 états avec les mêmes mots que l'éditeur d'horaires.** Ils ne les
      avaient pas : la page disait « Protégé hors travail » là où l'éditeur dit « hors **temps** de
      travail », et « Suivi 24/7 » là où l'éditeur dit « suivi en permanence ». **Pire, la page se
      contredisait elle-même** — son compteur annonçait « suivis en permanence » et la pastille de
      la ligne juste en dessous « Suivi 24/7 ». Deux vocabulaires pour un même état, c'est deux
      états pour qui lit — sur un écran qui sert de preuve en cas de contrôle. Les mots vivent
      désormais dans **`ETATS_VIE_PRIVEE`**, lu par les DEUX écrans : ils ne peuvent plus diverger.
      *(« 24/7 » reste là où il qualifie l'**antivol**, qui fonctionne bien en permanence — c'est
      une autre affirmation.)* **Les 3 états deviennent 3 groupes**, « à corriger » en tête : ils
      étaient une liste unique simplement triée, l'anomalie se lisait pastille par pastille.
      **Le bouton « Définir les horaires » est sur la ligne** et pointe `?tab=schedule` — la phrase
      d'alerte réclamait le geste (« posez-leur des horaires ») sans jamais l'offrir. **Une panne
      ne se déguise plus en flotte vide** : le `catch` posait `loading=false` et rien d'autre, donc
      une API tombée affichait « 0 véhicule » — soit « rien à corriger » — sur l'écran qui prouve
      que la protection est en place. `app-zone` distingue erreur, vide et **interdit** (403 →
      la permission est nommée). Mesuré : 46 textes ≥ 4,5:1 dans les deux thèmes (pire 5,07 /
      6,73), 0 cible < 44 px, et 14 couleurs en dur + replis morts purgés
- [x] `/settings` — **navigation à deux niveaux avec recherche.** Les 4 onglets plats deviennent
      **9 sections en 2 groupes**, et le rail porte la note qui répond à la question : « Mon espace
      ne concerne que vous, Ma flotte s'applique à toute la société ». L'onglet **« Organisation »
      mélangeait précisément les deux** (Compte et Sécurité d'un côté, Rétention et Mode assistance
      de l'autre) ; les **Règles d'alerte** quittent « Notifications » pour « Ma flotte » — elles
      étaient à côté des réglages personnels, ce qui laissait croire qu'on réglait ce qu'ON reçoit.
      **La recherche cherche un RÉGLAGE**, pas un nom de section (« traînées » → Carte, « 2fa » →
      Sécurité, « whatsapp » → Règles), insensible aux accents. **Enregistrement automatique
      visible** (« Enregistré · à l'instant ») et **pastille « modifié » calculée** contre
      `getDefaults()` — posée seulement là où une référence existe, jamais décorative.
      **Défaut corrigé** : on atterrissait sur « Facturation », que la permission d'un observateur
      interdit — donc page vide ; la section de départ est désormais la première réellement
      accessible. Mesuré : **122 textes ≥ 4,5:1 dans les deux thèmes**, 0 cible < 44 px hors le
      lien en ligne « Coûts IA », et 8 couleurs en dur purgées (dont un `color: #fff` sur l'accent
      à 2,54:1 et un bloc entier de styles en ligne avec un blanc en dur)
- [ ] Règles de notification (carte dans `/settings`) — prévision du volume, heures calmes
- [ ] `/settings/audio-monitoring` — mode assistance
- [ ] `/account` — profil, sessions ouvertes avec appareil inconnu signalé, sécurité

**A — Hors session (7)** — *quasi exclusivement mobiles, ouvertes depuis un SMS ou un QR : concevoir mobile d'abord, le PC est un repli*
- [ ] `/login` — détection Verr. Maj, compteur d'essais restants, entrée « QR véhicule », Face ID / empreinte
- [ ] `/forgot-password` — 2 écrans, message identique que l'e-mail existe ou non
- [ ] `/accept-invite` — lien expiré, déjà utilisé, compte existant
- [ ] `/install` — **détection automatique de la plateforme** au lieu du sélecteur à 3 onglets, QR desktop → mobile
- [x] `/book/:token` — **plus d'écran cul-de-sac.** Trois écrans (lien introuvable, réservation
      fermée, aucun créneau) disaient ce qui n'allait pas et s'arrêtaient là — sur un lien ouvert
      depuis un SMS, sans compte ni menu, il ne restait qu'à fermer l'onglet. Chacun porte
      désormais une sortie réelle, et « Réessayez plus tard » devient « Demander un créneau ».
      Les 3 emoji d'illustration (🔎 🔒 ✅) passent aux icônes du système, et 28 couleurs en dur
      sont purgées
      ⚠️ **Une seule des 3 sorties de B1 est faisable** : `PublicBookingLinkDto` ne porte **ni
      téléphone de la société ni endpoint d'abonnement** — « appeler » et « être prévenu »
      demanderaient un contrat. Une vraie sortie plutôt que trois simulées ; cf. fiche de reprise
- [x] `/reserve/:token` — **la dictée devient le chemin principal.** La page s'ouvre depuis un SMS,
      souvent debout : elle commençait par un formulaire de six champs et rangeait la dictée dans
      une pastille « Dicter » — le geste le plus coûteux demandé en premier, le plus rapide caché.
      Bouton micro **mesuré à 112 × 112** avec deux ondes, transcription visible pendant la dictée,
      champs devinés marqués « dicté » (on relit ce qu'une machine a deviné, pas ce qu'on a tapé),
      **contact manquant signalé AVANT le bouton** et non après un envoi refusé, « ce que vous ne
      choisissez pas » enfin écrit. **Trois culs-de-sac fermés** : micro refusé → bascule clavier
      annoncée · analyse qui ne comprend rien → on le dit et on propose de réessayer · après avoir
      parlé, on ne reste jamais sur l'écran du micro. 40+ couleurs en dur purgées — la page vivait
      sur une palette privée. Vérifié sur un **vrai lien public créé par l'API**
- [x] `/driver/unlock` — **une main, gants.** Le geste se fait dehors, souvent ganté, une seule
      main libre — l'autre tient un colis ou une portière. Le bouton était un bouton **doux** de
      40 px : la même affordance qu'un lien secondaire, pour LA seule action de l'écran. Il devient
      une cible pleine **mesurée à 128 × 128**, visée sans regarder, avec l'état sous le bouton
      (« Appuyez pour déverrouiller » / « Localisation… »). Les classes de **palette Tailwind**
      (`bg-red-500/15`, `text-red-400`) — qui ont la syntaxe du système sans en faire partie et ne
      suivent pas le thème — passent aux jetons

**B — Espace conducteur (1)**
- [x] `/driver` — **une main, et un contraste qui tient dehors.** L'action principale était une
      **pastille douce de 33 px coincée en haut à droite de la ligne** — la zone la moins
      accessible d'un téléphone tenu d'une main, et l'affordance d'un bouton secondaire pour LE
      geste de l'écran. La planche en fait une **barre pleine de 48 px en accent solide** :
      mesurée à **257 × 48**, avec le bouclier vie privée à **48 × 48** à côté. Le petit texte
      passe de `--fg-tertiary` (3:1) à `--fg-secondary` : cet écran se lit en plein soleil, sur un
      téléphone dont la luminosité ne suffit jamais. **4ᵉ occurrence du `catch` menteur, corrigée** :
      une panne affichait « Aucun véhicule ne vous est attribué » — pour un conducteur debout
      devant son camion, « on ne vous a rien confié », et personne à qui demander depuis cet
      écran. Les deux états sont maintenant distincts, avec un recours. Mesuré : 10 textes ≥ 4,5:1
      dans les deux thèmes (pire 5,54 / 7,28), 0 cible < 44 px *(la mission du jour et la mention
      d'information restent celles d'A2 — la mention passe à `--texte-violet`)*

**F — Surfaces bloquantes (12)**
- [x] Consentement RGPD — **la note conducteurs devient actionnable.** C'était « Pensez à informer
      vos conducteurs » : une ligne grise, au conditionnel, **sans aucune suite** — alors que c'est
      une obligation légale et que celui qui la lit vient d'accepter les conditions. Elle devient
      « **Vous devez informer vos conducteurs** », en ambre, avec le **modèle téléchargeable**.
      Le modèle est **généré côté client** (pas d'endpoint, pas de fichier à déployer) et porte en
      tête, en toutes lettres, qu'il est **à adapter et ne constitue pas un conseil juridique** ;
      il reprend les mentions attendues d'une information préalable (finalité, données, plages,
      durée, destinataires, droits) avec des champs entre crochets. Vérifié au navigateur : 1 840
      caractères produits, `note-information-conducteurs-modele.txt`, `text/plain;charset=utf-8`.
      *(« Étape N sur 3 » était déjà calculée par `PortesAccesService` au lot B0′.)*
      11 textes ≥ 4,5:1 dans les deux thèmes, 6 couleurs en dur purgées
- [x] Autorisations navigateur — **la sortie nomme enfin ce qu'on abandonne.** L'impasse dure était
      déjà levée (le bouton n'est plus désactivé sans GPS), mais il restait le plus important :
      il disait « Continuer vers l'application », ce qui **laisse croire qu'on ne perd rien**.
      Il dit désormais « **Continuer sans déverrouillage QR** » — la seule fonction qui cesse
      d'être disponible — et **redevient neutre** dès que la localisation est accordée. Un rappel
      s'affiche dessous tant qu'elle ne l'est pas : « vous pourrez l'autoriser au moment de scanner
      un QR, ou depuis Paramètres — rien n'est définitif ». Vérifié au navigateur sur les trois
      états (départ, accordée, refusée). *(La justification de la localisation par son usage était
      déjà écrite.)* Mesuré : 13 textes ≥ 4,5:1 dans les deux thèmes (pire 5,15 / 7,28), 0 cible
      < 44 px, et **8 couleurs en dur purgées** dont deux hex d'ambre hors système sur
      l'avertissement de localisation bloquée
- [x] Vérification d'appareil — **6 cases séparées, collage depuis l'e-mail.** Le champ unique se
      contentait d'un **interlettrage qui imitait des cases** : on ne voyait pas combien de
      chiffres restaient, et le collage — le geste le plus naturel quand le code arrive par mail —
      n'avait aucun traitement. Les six cases avancent toutes seules, le retour arrière remonte
      d'une case, les flèches naviguent, et **coller « Votre code : 472913 (valable 10 min) »
      remplit les six d'un coup** (vérifié : seuls les chiffres sont retenus). Le code complet
      déclenche la vérification sans demander un tap de plus. **Défaut trouvé à la mesure** :
      l'espacement de 9 px ramenait chaque case à **41 px de large** pour 56 de haut — une cible
      n'est atteignable que si ses **deux** dimensions le sont ; l'espacement cède sous 420 px,
      les cases passent à **47 × 56**. 9 textes ≥ 4,5:1 dans les deux thèmes, 5 couleurs en dur
      purgées
- [x] Proposition 2FA — **elle sort de la pile.** Ce n'est PAS une porte : c'est une proposition
      refusable. Elle portait pourtant le **voile à 78 %** du consentement et de la vérification
      d'appareil — donc le même poids à l'œil, alors qu'elle ne bloque rien : on lisait « vous ne
      passerez pas » avant même le titre. **Voile à 22 %** (mesuré `/ 0.22`), l'application reste
      visible derrière. **3 sorties visibles** : « Ne plus me proposer » — le refus le plus
      engageant — était en `--fg-tertiary`, donc **le moins lisible des trois** ; les deux refus
      prennent la même couleur, ce qui les distingue est leur libellé. **Feuille sous 640 px**,
      même géométrie que la confirmation du kit : mesuré collée en bas, rayon **28 px** et poignée
      **32 × 4** — les jetons Android, donc les 3 écarts de plateforme volontaires sont respectés.
      6 textes ≥ 4,5:1 dans les deux thèmes (pire 5,54 / 7,28), 0 cible < 44 px
- [ ] Assistant de démarrage — *livré en B0′*
- [x] Coupure moteur — **les quatre points livrés et mesurés.**
      **Compte à rebours** : « En attente… » sans durée laissait croire que ça pouvait durer
      indéfiniment ; le boîtier a 90 s, et ça se voit — vérifié descendant de 73 s à 68 s. Le tick
      passe à **1 s pendant la fenêtre, 5 s sinon** : à 5 s le compte sautait de 5 en 5 (ça se lit
      comme un bug), et battre la seconde en permanence sur chaque ligne d'une liste serait du
      gaspillage. **La raison du refus sort de l'infobulle** : elle n'existait pas au doigt — sur
      un téléphone, un bouton grisé sans explication est un mur. Vérifié : « Vitesse trop élevée
      (63.6 km/h) » s'affiche sous le bouton. **L'état non confirmé a 3 sorties** — c'était un
      constat rouge et définitif : Renvoyer la commande · Voir l'historique · J'ai vérifié sur
      place *(cette dernière masque le bandeau et RIEN d'autre : elle n'écrit aucun état et ne fait
      pas passer le bouton en « coupé » — l'application n'a pas vu le véhicule)*.
      **Boîtier muet en 3 étapes numérotées** au lieu d'une phrase sans suite.
      Mesuré sur l'état le plus chargé (muet ET non confirmé) : 17 textes ≥ 4,5:1 dans les deux
      thèmes (pire 5,06 / 6,12), 0 cible < 44 px, et 8 classes de palette Tailwind remplacées
  - [x] ✅ **Variante critique branchée — décision client du 2026-08-11 : plaque à retaper sur la
  - [x] ✅ **Variante critique branchée — décision client du 2026-08-11 : plaque à retaper sur la
        COUPURE seulement.** Couper immobilise un bien, parfois avec quelqu'un dedans, et se trompe
        de véhicule en un clic depuis une liste ; rallumer ne fait que débloquer. C'est la même
        asymétrie que le mode veilleur, qui peut rallumer mais pas couper. Le point ouvert de
        B-kit est clos. Vérifié au navigateur : liseré rouge, **état réel du véhicule rappelé**
        (« TE002ST — roule à 29 km/h », construit depuis la vitesse, la dormance du boîtier et le
        contact), bouton bloqué au départ, **toujours bloqué avec une mauvaise plaque**, débloqué
        avec la bonne **en minuscules** — le kit compare sans casse : on vérifie qu'on a lu, pas
        qu'on sait taper
- [x] Panneau surveillance — **le dénouement de chaque déclenchement.** L'historique listait des
      événements sans jamais dire ce qu'ils étaient DEVENUS : un badge de statut à droite, les
      notes en italique ailleurs. Or c'est le dénouement qui fait la valeur de l'historique —
      « choc léger » ne dit rien, « sans suite · coup de vent » dit tout. **Aucun champ nouveau** :
      `status`, `acknowledgedAt` et `notes` étaient déjà servis — même constat que sur l'activité
      de flotte. Vérifié sur les 4 statuts : « Vol confirmé · à 08:13 · retrouvé au parking nord » ·
      « Sans suite · probable coup de vent » · « Sans suite » · « **Sans dénouement — personne ne
      l'a encore qualifié** » (le cas où l'absence EST l'information). **Conseil déduit du motif**,
      calculé sur les événements déjà chargés : « 2 déclenchements sans suite en 8 jours… un
      antivol qui crie pour rien finit par être ignoré » — il ne sort que si le motif est
      réellement là et que la sensibilité peut encore descendre.
      ⚠️ **17 variables `--color-*` QUI N'EXISTENT PAS** dans le système (les vraies sont `--fg-*`,
      `--bg-*`, `--border-*`) : le repli hexadécimal gagnait donc **toujours**, et ces couleurs ne
      suivaient aucun thème. Les badges de statut tombaient à **1,47:1 en thème clair** — le
      statut, sur l'écran d'un antivol. Mesuré après : 51 textes ≥ 4,5:1 dans les deux thèmes
      (pire 4,68 / 4,82), 0 cible < 44 px
      ⚠️ **Le week-end en surveillance permanente n'est PAS fait** — cf. fiche de reprise
- [ ] QR véhicule — explique son usage et son format d'impression (60 × 90 mm), 262 px sur Android
- [ ] Rejeu de trajet — **multiplicateurs partout avec la durée réelle à côté**, excès confirmé vs pointe à vérifier, la frise porte l'analyse
- [ ] Rejeu de période — **une barre par jour**, trajets listés et cliquables, échelle 16× ajoutée
- [ ] Créer / éditer un véhicule — **le boîtier devient facultatif** (« Sans boîtier pour l'instant »), compteur `15 / 15` sur l'IMEI, « 2 champs requis sur 11 »
- [ ] Éditeur d'horaires — **bloc imbriqué derrière un filet vert** : impossible de régler les plages en croyant protéger alors que rien n'est protégé, « 122 h sur 168 sans collecte »

**J — Interfaces alternatives (2)**
- [ ] Mode veilleur — 3 permissions, une seule écriture : **redémarrer**. Il ne peut pas couper (rallumer débloque une exception réversible, couper immobilise un bien). Accordéons par groupe, bouton Redémarrer sur la ligne, confirmation en un toucher avec deux garanties : *réversible*, *consigné à votre nom*
- [ ] Interface simplifiée — carte plein écran, 3 cibles de 88 px en langage courant, 4 règles : jamais plus de 3 boutons · langage courant · les garde-fous restent · la sortie vers l'interface complète toujours visible
- [x] ⚠️ **Défaut corrigé** : le réglage promettait « toutes les pages restent accessibles », le menu était réduit à 5 entrées. Le mode simplifié réutilise désormais **la même source** que le menu complet (`groupesComplets()`) — une seconde liste tenue à la main aurait divergé au premier ajout de page. Ce qui change est la FORME (un seul groupe, sans en-têtes), pas le contenu
- [x] **Règle non négociable appliquée** : Paramètres est détaché par un filet, en violet, sous-titré « Revenir en interface complète ». Le texte du réglage a été réécrit pour dire ce que le menu fait vraiment
- [x] **Défaut trouvé en vérifiant** : les styles du menu en feuille vivaient dans `@media (max-width: 768px)`. Or le mode simplifié navigue au bouton à TOUTE largeur — sur un écran large, le menu s'ouvrait sans aucun style : libellés bruts, sans cartes, et le filet violet de la sortie invisible. Les règles sont sorties du media query
- [x] **Mesuré dans le navigateur** : 13 entrées au lieu de 5 · Paramètres à `rgb(124,58,237)` = `--texte-violet`, filet 1 px, marge 14 px, sous-titre présent · les 9 onglets de la fiche véhicule tous atteignables via les 4 familles

**G — Le shell, en dernier (2)**
- [ ] Shell authentifié — une seule définition de référence, bandeau hors ligne qui **pousse** le contenu, barre de progression 2 px qui **se superpose**, 3 modes spéciaux (veilleur, simplifié, super-admin) *(le mode dépôt est livré en A1)*
- [ ] Shell hors session — panneau droit conservé tel quel. Un seul changement : l'accroche passe de « Suivez et sécurisez votre flotte » à « Vous savez où sont vos véhicules. Et pourquoi ils s'arrêtent. »
- [ ] **Décisions de plateforme, à ne pas revisiter** : iOS 5 onglets en bas, **pas de hamburger** (il concurrence le geste de retour) · Android tiroir M3, **pas de barre d'onglets** (les 3 boutons système occupent déjà le bas)

**La sonde de recette — les critères mesurables, mesurés**

> Posée au navigateur (lot B-pages, 2026-08-10). Elle vérifie ce que l'œil ne compte pas :
> `scrollHeight === clientHeight` sur les colonnes `overflow:hidden`, les libellés tronqués
> **sans recours** (ni `title` ni `aria-label`), les cibles sous 44 px à 375 px, et le
> débordement horizontal. Les éléments décoratifs (`aria-hidden`, `sr-only`,
> `pointer-events: none`) en sont exclus — sans quoi les faux positifs noient les vrais.

- [x] **Le bouton de navigation mobile faisait 18 px de large.** Il DÉCLARAIT 44 × 44 ; la
      barre du haut est une rangée flex, le sélecteur de société y prend 156 px, et le
      burger — seul élément sans `flex-shrink: 0` — cédait tout le reste. Un CSS correct à
      la lecture, et la porte de toute la navigation mobile réduite à un trait
- [x] **Le nom de société tronqué n'était récupérable nulle part** : « CDEF 31 — Centre Dép.
      de l'Enfant et de la Famille » perdait 117 px, sans `title` ni `aria-label`. Une
      ellipse cache une information ; sans recours, elle la supprime
- [x] **Toutes les barres d'onglets étaient à 36 px** — Véhicules, Groupes, Capacités, Mode
      privé, Géofences, Règles… Règle globale sous 768 px : elles traversent l'encapsulation
      des composants, et rattrapent aussi celles à venir. Vérifié : 44 px sur les cinq
      onglets de `/vehicles`
- [x] **Le shell, corrigé pour les 29 pages d'un coup** : logo 36 → 44, avatar 39 → 44, et
      la croix du toast, qui faisait **14 px de large** — un toast qu'on n'arrive pas à
      fermer reste par-dessus ce qu'on essaie de lire
- [x] **Mesuré avant / après, page par page** : tableau de bord **5 → 0** · alertes
      **19 → 0** · véhicules **68 → 0** (les quatre actions par ligne faisaient 36 × 36, et
      « Supprimer » est justement celle qu'on ne veut pas rater en visant « Voir ») ·
      lieux clés **6 → 3**
- [ ] **Exception assumée** : les 3 restants de `/places` font 44 en HAUTEUR mais moins en
      largeur — ce sont des liens de deux mots dans une phrase. Les élargir à 44 casserait
      la phrase ; un lien en ligne n'est pas une cible autonome
- [x] `/scores` **8 → 0** · `/users` **19 → 0** — sur une liste, la cible par ligne est celle
      qu'on vise le plus souvent et la plus facile à rater : les lignes sont serrées
- [x] `/agenda` **13 → 0** · `/map` **14 → 0** — sur un calendrier, changer de mois est le
      geste le plus répété ; sur la carte, c'est l'écran le plus utilisé au doigt de toute
      l'application
- [x] `/reports` — **hors carte de chaleur, 64 → 0**, et le débordement horizontal est à 0
- [x] ⚠️ **Mon diagnostic précédent était faux, la mesure l'a corrigé.** J'avais conclu que
      les 232 cibles de `/reports` appelaient la refonte de `B1` § D. En réalité **168 des
      232 sont les cellules de la carte de chaleur** (24 h × 7 j, 10 × 11 px) : ce ne sont
      pas des commandes, ce sont des données. Les porter à 44 px ferait 7 392 px de large
      sur un écran de 375 — la carte de chaleur cesserait d'exister. Le critère vise ce
      qu'on actionne, pas ce qu'on lit
- [x] **La carte de chaleur a son drill-down.** Le vrai défaut n'était pas la taille des
      cellules : elles ne se lisaient **qu'au survol**, qui n'existe pas au doigt — sur un
      téléphone, la carte était un dessin muet. Le JOUR devient un bouton de 44 px qui
      déplie ses heures en toutes lettres (« 15 h — 6 trajets »), et le dit quand il n'y
      en a aucune. Vérifié sur les 7 jours, ouverture et fermeture
- [x] `/fleet-schedules` **39 → 0** — cocher un jour y est le geste central, et l'erreur ne
      pardonne pas : une case ratée pose une **coupure moteur** sur le mauvais jour, ce
      qu'on ne découvre que le matin où le véhicule ne démarre pas
- [x] `/users/overview` **1 → 0** · `/privacy-coverage` déjà à 0
- [x] `/settings` **7 → 1** · `/account` **6 → 0** · `/installations` **81 → 0** (54 boutons de
      réordonnancement et 27 poignées de glisser-déposer : c'est la page où l'on organise
      une tournée **debout, sur le terrain**) · `/integrations` déjà à 0
- [x] **Deux écrans partagent les mêmes classes mais pas la même feuille** — l'encapsulation
      Angular les sépare. Corriger `installation-editor` ne corrigeait pas
      `installations-client` ; il a fallu la mesure pour s'en apercevoir
- [x] `/login` **3 → 0** · `/forgot-password` **1 → 0** · `/install` **5 → 1** — les pages hors
      session sont « quasi exclusivement mobiles, ouvertes depuis un SMS ou un QR »
      (`B1` § A). Trois commandes ratées sur l'écran où l'on n'est même pas encore entré :
      l'œil qui montre le mot de passe (26 × 36), la case « Rester connecté », le lien d'oubli
- [x] **La case à cocher garde 20 px, et c'est voulu** : une case de 44 px est une tache.
      C'est son ÉTIQUETTE qui devient la cible — mesurée à **44 × 128**, et cliquer
      « Rester connecté » coche bien la case. La sonde compte l'input isolément : c'est une
      limite de la sonde, pas un défaut de la page
- [ ] **Exception, même famille que `/places`** : le dernier lien de `/settings` (« Coûts IA »)
      est en ligne dans une phrase. Un lien dans un texte n'est pas une cible autonome

**Critères de recette, à passer sur chaque page**
- [ ] Aucun style en ligne recopié d'une maquette
- [ ] Icônes issues de `design/ICONS.md`, aucune inventée
- [ ] Aucun libellé replié ou tronqué
- [ ] Les 6 états démontrables sur les composants de la page
- [ ] `scrollHeight === clientHeight` sur chaque colonne `overflow:hidden` — ne jamais laisser une carte bordée coupée
- [ ] Thème clair et sombre, contraste ≥ 4,5:1 sur le texte
- [ ] iPhone 390 px : cibles ≥ 44 px, pas de débordement
- [ ] Android 412 px : pas de barre d'onglets, FAB si la page a une action principale
- [ ] Les 3 écarts iOS/Android **volontaires** respectés : poignée 36 × 5 vs 32 × 4 · rayon 22 vs 28 px · densité 44 vs 56 px. Les aplatir donne une application étrangère sur les deux plateformes

### B-mails — Les 19 gabarits

> Les 7 problèmes du `shell()` actuel : fond sombre forcé · vert en aplats · emoji dans un
> e-mail de sécurité · sujet entre crochets · Google Fonts par `<link>` (supprimé par Gmail,
> Outlook, Yahoo — la police n'arrive jamais) · aucun preheader · accents perdus.

- [ ] `shell()` refondu : clair par défaut
- [ ] Vert en aplats supprimé
- [ ] Emoji retiré des e-mails de sécurité
- [ ] Crochets retirés des sujets
- [ ] **Google Fonts par `<link>` supprimé** — police système en repli
- [ ] Preheader renseigné sur chaque gabarit
- [ ] Accents corrects partout
- [ ] Aucune information portée uniquement par une image
- [ ] **Décision sur les animations : rien qui bouge.** Les `@keyframes` ne marchent que dans Apple Mail ; 85 % des destinataires ne les verront pas. Le mouvement est remplacé par de la hiérarchie — c'est ce qui distingue le transactionnel du marketing
- [ ] Les 19 gabarits repris un à un *(`mission_assigned` et `invitation` version dépôt sont livrés en A2 et A5)*
- [ ] Rendu vérifié sur Gmail web, Gmail Android, Outlook, Apple Mail
- [ ] **Commit** `refactor(email): charte 2026 — clair, preheader, sans Google Fonts`

---

## Mise en production

### Avant le push

- [ ] `pnpm typecheck` vert — ⚠️ ne couvre **pas** `apps/web` : le paquet n'a pas de script `typecheck`. Pour le web, `ng build`
- [ ] `pnpm smoke` vert — **le test qui manquait le 22/07/2026** : il construit le graphe d'injection complet et voit un `imports:` manquant que ni le typecheck ni les 1000+ tests unitaires ne voient
- [ ] `pnpm test` — échecs triés selon la RÈGLE 7 (relance seule, comparaison à la référence)
- [ ] `ng build` du web vert + tests karma headless
- [ ] Les 12 tests d'isolation A1 verts
- [ ] Les migrations Prisma relues une dernière fois (additives, aucune donnée existante touchée). **Elles s'appliquent au démarrage du conteneur** : une migration invalide ne se voit qu'au déploiement
- [ ] `docs/VERIFIER-AVANT-DE-DEPLOYER.md` relu et appliqué
- [ ] Aucun secret, aucune clé, aucune URL de développement dans le diff
- [ ] `git diff main...feat/refonte-tracky-v2 --stat` relu en entier

### Le push

- [ ] Branche poussée sur `origin`
- [ ] Pull request ouverte avec le récapitulatif des lots livrés
- [ ] Revue de sécurité passée sur le lot A4 (la liste de contrôle A4.10)

### Le déploiement — manuel, il n'y a aucun automatisme

> ⚠️ **Aucun workflow GitHub sur ce dépôt : pousser ne déploie rien.** Le VPS fait
> `git pull origin main`. Une branche poussée n'atteint donc la production qu'une fois
> **fusionnée dans `main`** — ou en déployant explicitement la branche.

- [ ] Décision prise avec le client : fusion dans `main`, ou déploiement de la branche pour recette
- [ ] Sauvegarde de la base vérifiée récente avant d'appliquer les migrations
- [ ] `cd /opt/vizyo-tracky && git pull origin main`
- [ ] `cd deploy/vps && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build` — **le flag `--env-file` n'est pas optionnel** : sans lui le déploiement échoue sur `network <vide> declared as external`
- [ ] L'API a réellement démarré (un conteneur « up » peut redémarrer en boucle) : `docker compose -f deploy/vps/docker-compose.prod.yml logs api --tail 100 | grep -icE "UnknownDependencies|Nest can't resolve"` → **0 attendu**
- [ ] `curl -s -o /dev/null -w "%{http_code}" https://<api>/api/health` → **200**
- [ ] Variables d'environnement vérifiées dans `deploy/vps/.env.prod`, **jamais** dans `.env.example`

### Recette en production

- [ ] Migrations appliquées en production, sans interruption d'ingestion GPS
- [ ] Un compte dépôt réel invité, activé, connecté
- [ ] Une mission réelle créée → le dépôt la voit
- [ ] Position live servie pendant la fenêtre, refusée hors fenêtre
- [ ] Un lien de partage généré, ouvert depuis un vrai téléphone, en 4G
- [ ] **Expiration vérifiée réellement** : attendre 16 minutes, rouvrir
- [ ] En-têtes `noindex`, `no-store`, `no-referrer` vérifiés sur la réponse de production
- [ ] Réponse publique inspectée en production : aucune plaque, aucun nom, aucun tracé
- [ ] Aucune régression sur les écrans existants (dashboard, carte, véhicules, agenda, utilisateurs)
- [ ] Aucune régression sur les réservations : un véhicule en mission n'apparaît plus dans `/reserve/:token`
- [ ] Logs API sans erreur nouvelle pendant 24 h
- [ ] Tâches de fond visibles et vertes dans `/admin/background-tasks`
- [ ] E-mails transactionnels reçus et lisibles sur Gmail et Outlook
- [ ] Centre d'alertes sans remontée nouvelle

### Correction des défauts de production

- [ ] Défauts relevés listés ici au fur et à mesure
- [ ] Chacun corrigé, retesté en local, puis en production
- [ ] `pnpm verify` vert après chaque correction

---

## Journal de bord

Une ligne par séance : ce qui a été livré, ce qui a été décidé, ce qui bloque.

| Date | Lot | Livré | Décisions / points ouverts |
|---|---|---|---|
| 2026-08-14 | **B-pages (fin) · Bloc J · B-mails** | **B-pages clos** : les 13 pages « présumées » rouvertes (aucune n'était propre), `/places` (3 onglets), `/alerts`, le bloc G (le bandeau hors ligne POUSSE enfin) · **bloc J** (2 écrans qui ignoraient le thème) · **B-mails** (21 gabarits, les 7 défauts de la planche) · **10 commits** | **O5 tranché par le client** — `--text-tertiary` relevé à 4,5:1, calculé sur le fond le PLUS DÉFAVORABLE : `/reports` 104→0, `/map` 12→0. **L'onglet actif en vert de marque, trouvé 8 fois** : c'était une convention manquante, pas 8 bugs — écrite dans `styles.css`, les dernières occurrences se corrigent en une ligne. **Le `catch` menteur passe à 7** (`/installations`, puis `geofences` sur un écran de SÉCURITÉ) : la règle s'élargit — chercher le `catch` ne suffit pas, il faut qu'un **état soit POSÉ**, et **un toast n'est pas un état**. ⚠️ **Deux pages se déclaraient « livrées et mesurées » et ne l'étaient pas** : `/fleet-schedules` suivait l'**OS** et non `data-theme` (titre à 1,14:1), `/vehicles/:id` portait 7 échecs et 7 cibles hors seuil. **Dette levée** : `.vt-status` attendait la fin du bloc B pour être reprise globalement — c'est fait. **Reste** : PROD (0/28), le mode veilleur et `/driver` **jamais vus** (aucun compte en base), la forme de l'écran simplifié (7 boutons au lieu de 3) et les décisions du § 12 de `SUIVI-REFONTE.md`. |
| 2026-08-11 (9) | B-pages (35/57) · bloc F entamé (3/12) | Vérification d'appareil (6 cases + collage) · variante critique de la coupure moteur · consentement RGPD (note téléchargeable) · autorisations navigateur | **Décision client tranchée** : la variante critique de `confirm-modal` est branchée sur la **coupure seulement**. Couper immobilise un bien, parfois avec quelqu'un dedans ; rallumer ne fait que débloquer. Même asymétrie que le mode veilleur. Le point ouvert de B-kit est clos. **Une sortie qui ne nomme pas ce qu'on perd n'est pas une sortie** : « Continuer vers l'application » laissait croire qu'on ne renonçait à rien — c'est devenu « Continuer sans déverrouillage QR ». Même logique sur le consentement : « Pensez à informer vos conducteurs » était une ligne grise au conditionnel pour une **obligation légale** ; elle devient une consigne en ambre avec le modèle téléchargeable, généré côté client et portant lui-même son avertissement « à adapter ». **2ᵉ fois que le piège des deux dimensions se présente** : les cases du code sortaient à 41 px de LARGE pour 56 de haut (après « 7 j » sur `/admin/ai-usage`). Une cible n'est atteignable que si ses deux dimensions le sont. **Méthode** : les portes d'accès se décident au boot, donc aucune fixture posée après coup ne survit — `window.ng` en build de dev est la seule façon de les ouvrir pour les vérifier. Consigné. |
| 2026-08-11 (8) | B-pages (32/57) · **blocs A et B terminés** | `/driver` — barre de déverrouillage pleine largeur, contraste extérieur, 4ᵉ `catch` menteur corrigé | **« Une main » n'est pas une intention, c'est une position à l'écran.** L'action principale vivait en haut à droite de chaque ligne, dans une pastille de 33 px : la zone la moins accessible d'un téléphone tenu d'une main, avec l'affordance d'un bouton secondaire. Elle devient une barre pleine de 48 px, mesurée à 257 × 48. **« Contraste extérieur » veut dire un cran de plus** : `--fg-tertiary` (3:1) ne tient pas au soleil, tout le petit texte passe en `--fg-secondary`. ⚠️ **4ᵉ occurrence du `catch` qui pose un tableau vide** — et la pire des quatre : une panne affichait « Aucun véhicule ne vous est attribué », c'est-à-dire « on ne vous a rien confié », à un conducteur debout devant son camion, sur un écran où il n'a personne à qui demander. Les quatre écrans touchés (activité de flotte, couverture vie privée, intégrations, espace conducteur) n'ont **aucun rapport entre eux** : ce n'est pas une négligence locale, c'est un réflexe d'écriture. **Piège n° 1 retombé dessus, dans une variante nouvelle** : des accents graves dans un commentaire **HTML du gabarit**, pas dans un commentaire de code. `verif:litteraux` l'a vu. |
| 2026-08-11 (7) | B-pages (31/57) · **bloc A terminé** | `/reserve/:token` (dictée d'abord, micro 112 px) · `/book/:token` (3 culs-de-sac fermés) · `/driver/unlock` (cible 128 px) | **Ces pages s'ouvrent depuis un SMS, dehors, sans compte.** Et toutes les trois demandaient le geste le plus coûteux en premier : un formulaire de six champs avant la dictée, un bouton doux de 40 px pour une main gantée, un constat sans suite quand le lien ne marche plus. **La taille d'une cible se décide par le CONTEXTE, pas par le plancher** : 44 px est le minimum d'une commande ordinaire ; le geste central d'un écran utilisé debout mérite 112 ou 128 px, et la planche le disait déjà. **Trois culs-de-sac fermés sur `/reserve`** (micro refusé, analyse muette, retour impossible) et **trois sur `/book`**. ⚠️ **B1 cite trois sorties pour `/book` — une seule est faisable** : le DTO ne porte ni téléphone de société ni endpoint d'abonnement. J'ai livré la sortie réelle plutôt que d'en simuler trois. C'est le **4ᵉ point de la refonte qui bute sur un contrat d'API**. **68 couleurs en dur purgées** sur les deux pages publiques : elles vivaient sur des palettes privées, hors thème — une page publique reste du Vizyo Tracky. |
| 2026-08-11 (6) | B-pages (28/57) · **contenu D+E terminé** | `/privacy-coverage` — les 3 états parlent enfin la même langue que l'éditeur · `ETATS_VIE_PRIVEE` partagé · 3 groupes + « Définir les horaires » | **La page se contredisait elle-même** : compteur « suivis en permanence », pastille « Suivi 24/7 », deux lignes l'une sous l'autre. Et aucun des deux ne correspondait à l'éditeur d'horaires, qui dit « hors **temps** de travail ». Corrigé non pas en réécrivant les chaînes mais en créant **une source unique lue par les deux écrans** — les réaligner à la main aurait tenu jusqu'à la première reformulation. **Une panne affichait « 0 véhicule »**, donc « rien à corriger », sur l'écran qui sert de preuve que la protection est en place : le `catch` posait `loading=false` et rien d'autre. C'est la 3ᵉ fois de la séance que je trouve ce motif exact (activité de flotte, couverture vie privée, intégrations) — **le `catch` qui pose un tableau vide est le défaut le plus répandu de cette base**. ⚠️ **Piège de vérification trouvé** : le 403 affiche « Gerer le mode vie privee » SANS accents, alors que `permissions.ts:670` porte « Gérer le mode vie privée » et que `verif:accents` est vert. La source est juste ; c'est le **serveur de dev qui sert un chunk périmé du paquet partagé**. Le navigateur peut donc mentir sur une chaîne de `packages/shared` — à confirmer sur un serveur redémarré. |
| 2026-08-11 (5) | B-pages (27/57) | `/integrations` — le sensible sort de la liste plate · 20 replis morts et 8 couleurs en dur purgés · l'erreur porte un recours | **On cochait la position temps réel dans le même geste que la plaque d'immatriculation.** Le sensible était dans la même liste, distingué par une pastille. Il a son bandeau, et surtout : **la séparation est DÉRIVÉE de `PARTNER_SCOPES_SENSITIVE`**, pas recopiée. Sur l'écran où le client accorde l'accès à des données nominatives, une seconde liste tenue à la main aurait divergé au premier scope ajouté — **en silence**. **Le volume chiffré de la planche n'est pas faisable** (« 3 412 trajets ») : aucun DTO ne le porte, et le reconstituer demanderait un appel par catégorie. Ce qui est affiché est ce qu'on sait avec certitude — « Rien n'est transmis » quand la catégorie est éteinte, soit la moitié qui compte. C'est le **troisième point de la séance qui bute sur un contrat d'API** (avec « chaque euro rattaché à un résultat » et les compteurs de résultat) : tous mis de côté, aucun DTO touché. **`verif:accents` m'a repris sur mes propres commentaires** — il les classe en contexte `[gabarit]` ; les accents y sont sans risque, seul l'accent grave l'est. |
| 2026-08-11 (4) | B-pages (26/57) | `/settings` en navigation à deux niveaux · **sonde de contraste réparée trois fois** · 8 couleurs en dur purgées · les 3 pages de la séance re-mesurées | **MA SONDE MENTAIT, PAS LES PAGES.** Trois défauts de mesure trouvés coup sur coup, chacun produisant des verdicts faux : (1) `color-mix()` est rendu par Chrome en `color(srgb 0.95 0.98 0.97)` — des flottants **0-1** que ma regex lisait comme du **0-255**, donc un quasi-noir : un texte à **17,81:1 était rapporté à 1,11** ; (2) sans ancêtre opaque, je retombais sur du **blanc en dur** — fortuitement juste en thème clair, faux partout en sombre ; (3) `body` a une **transition de 300 ms** sur son fond, et le panneau ne composite aucune frame : la transition n'avance JAMAIS, donc en sombre je mesurais du texte clair sur un fond resté clair. D'où des ratios à ~1,05 sur des pages parfaitement correctes. **Conséquence : les « 0 échec » des deux séances précédentes ne valaient rien** — les 3 pages ont été re-mesurées, transitions neutralisées, et **4 vrais échecs y ont été trouvés** que l'ancienne sonde n'avait pas vus (`au-feat-tag` 2,80, `au-prov-badge` 2,46, `.fa-act` 4,37 par empilement de deux lavis à 12 %). **Une mesure fausse est pire qu'aucune mesure** : elle donne le droit de ne pas regarder. **Deuxième leçon** : passer d'une LISTE DE SÉLECTEURS à un balayage de tout le texte a trouvé à lui seul les 2 échecs de `/admin/ai-usage`. **`.vt-eyebrow` corrigé globalement** — 11 px en vert de marque, 3,34:1 en clair ; c'est l'application de la règle de `TOKENS.md` § « Petit texte », inchangé en sombre. |
| 2026-08-11 (3) | B-pages (25/57) | `/admin/ai-usage` — le forfait d'abord · 5 couleurs en dur purgées · montants en convention française | **La consommation était présentée comme la facture.** Un fleet-admin lisait son coût de CALCUL sous « Coûts IA de votre société ». Le forfait passe devant, depuis `BillingStatusDto` — **aucun contrat touché**, la donnée était déjà servie. **`COMP` est le piège** : le back calcule `monthlyEurCents` même quand l'IA est OFFERTE ; afficher le prix catalogue à une société qui ne paie rien aurait été faux. Les 6 statuts sont traités un par un. **Le plafond mensuel ne concerne pas le client** : c'est le garde-fou interne Vizyo — barre et badge restent côté super-admin, sinon « Dépassé » alarmerait pour rien et contredirait la phrase de réassurance. **Piège n° 1 retombé dessus** : j'ai écrit des accents graves dans un commentaire de `styles:`, `verif:litteraux` l'a sorti avant que le bundle périmé ne me trompe. ⚠️ **Point ouvert O5 — `--text-tertiary` est sous 4,5:1 dans LES DEUX thèmes** (3,07 clair / 3,75 sombre) : ce n'est pas un défaut de page, c'est un jeton à 3:1 employé comme couleur de texte. Corrigé localement sur 2 pages ; la reprise globale touche 29 écrans et se décide, elle ne s'improvise pas. |
| 2026-08-11 (2) | B-pages (24/57) | `/fleet-admin/activity` refondue et vérifiée au navigateur · deux commentaires de `styles.css` remis d'aplomb · sonde reposée sur les 5 pages D+E | **La raison du refus existait déjà, personne ne l'affichait.** `lastError` est écrit depuis toujours par `rejectSpeed` (« Vitesse trop élevée : 74 km/h ») et l'écran n'en montrait rien : la refonte « le résultat avant l'événement » n'a demandé **aucun changement de DTO**, seulement d'afficher un champ déjà servi. **Une panne déguisée en liste vide** : le `catch` posait `[]`, donc un 500 affichait « Aucune action moteur sur cette flotte » sur l'écran qui sert justement à vérifier que personne n'a touché aux véhicules. Deux états distincts, c'est `app-zone`. **Deux commentaires qui promettaient plus que leur code** : la règle « GLOBALE … rattrape celles à venir » est en fait une **liste de six noms de classes** — `/fleet-admin/activity` écrivait `.fa-tabs button` et sortait à 37 px ; et `/* garantir minimum 44px */` déclarait `min-height: 36px`. Valeur laissée à 36 (monter `a` casserait les liens en ligne, exception déjà assumée) et **texte corrigé** — un commentaire qui ment fait sauter la vérification. **Ma propre sonde a produit un faux positif** (1,68:1 sur `.fa-act`) : ma composition de fonds retombait sur du blanc en thème sombre. Corrigée, 0 échec sur 47 couples. **Point ouvert** : `/admin/ai-usage` présente `spentThisMonthEur` à un fleet-admin sous « Coûts IA de votre société » — la consommation montrée comme la facture. Le forfait est **déjà** dans `BillingSubscriptionDto` : la correction ne demandera pas de contrat. |
| 2026-08-11 | B-pages (23/57) | Fiche véhicule en 4 familles · mode simplifié qui tient sa promesse · drill-down de la carte de chaleur · passe de cibles tactiles sur 15 pages, mesurée avant/après · fiche de reprise `REPRISE-B-PAGES.md` | **La recette se mesure, elle ne se juge pas.** La sonde a trouvé ce qu'aucune relecture ne trouve : un bouton de navigation à **18 px de large** alors qu'il déclarait 44 × 44 (un `flex-shrink` manquant), le menu en feuille **stylé pour le mobile seulement** alors que le mode simplifié l'utilise à toute largeur, et une carte de chaleur **lisible au seul survol** — donc muette au doigt. **Trois fois une règle CSS correcte qui ne s'applique pas là où on croit** : enfermée dans un media query, écrasée par une règle plus bas, ou écrite dans le composant jumeau. Toujours corriger la source. **Mon propre diagnostic corrigé par la mesure** : les 232 cibles de `/reports` n'appelaient pas une refonte — 168 étaient des cellules de données, pas des commandes. **Deux exceptions assumées** : les liens en ligne dans une phrase, et la case à cocher dont l'étiquette porte la cible. |
| 2026-08-10 | B-kit (26/28) | Famille `--texte-*` étendue · `--surface-quaternary` (O1 clos) · `app-zone` et les 6 états · confirmation qui nomme ce qui est perdu · toast en haut sur mobile · 76 couleurs en dur traitées · 5 contrôles automatisés | **P1 CORRIGÉ** — `pnpm verify` se termine, et sous ce blocage s'en cachait un second : la suite web **ne compilait plus depuis A2** (API Jest dans un runner Jasmine). Les deux défauts se cachaient l'un l'autre ; **311 tests web** tournent pour la première fois. **La palette des planches est tenue en sombre et lâche en clair** : on reprend leur décision, pas leur valeur, sous 4,5:1. **`role === 'Dépôt'`** — ma passe d'accents avait corrompu le slug `DEPOT`, ce qui aurait éteint l'espace dépôt en silence. Sorti par le typecheck. Point ouvert : la **variante critique** de la confirmation existe mais n'est branchée nulle part (décision d'écran). |
| 2026-08-10 | — | **Les 28 planches `.dc.html` reçues** et rangées dans `design/maquettes/` avec `support.js` et `brands/` (7 logos) — copie vérifiée à l'octet près, 37 fichiers, 3 449 921 o. Bloc B débloqué. | **28 planches et non 27** : `Loaders-Splash` et `Vehicules Refonte` s'ajoutent à la liste de `B1-PAGES.md`. **`Video Depot.dc.html` absente** — notée « support commercial, pas une spec », rien n'en dépend. **Le piège n° 1 de `00-INDEX.md` est périmé** : il demande de traduire Manrope → Poppins alors que l'application tourne déjà en Manrope (Écart 2, tranché à l'étape 0). Les planches référencent `./support.js` et `brands/*.png` en relatif : la structure du dossier ne doit pas être aplatie. |
| 2026-08-10 | B0′ | Famille `--texte-*` (petit texte lisible) · badge de présence sur jetons, *Dormant* violet, *Non configuré* tireté · surveillance lue dans le fuseau de la flotte + migration · 224 accents · assistant à 2 étapes · `PortesAccesService` · 3 scripts de contrôle (`verif:contraste` 46/46, `verif:accents`, `verif:litteraux`) | **Le correctif UTC est côté planificateur, pas côté écran** : une plage récurrente n'a pas d'équivalent UTC, aucune saisie ne pouvait la rendre juste. La surveillance était le seul planning du dépôt resté en UTC. **Points O2 et O3 de `TOKENS.md` tranchés**, O4 ouvert (couleurs de couche de carte, volontairement explicites ; `map.component.ts` reste à reprendre au lot B-pages). **Trois corruptions rattrapées** par l'accentuation automatique, dont `role === 'Dépôt'` qui aurait éteint l'espace dépôt. Recette visuelle faite au DOM et au style calculé : le panneau navigateur ne composite pas, les captures sont indisponibles. |
| 2026-08-09 | — | Analyse du livrable, audit du dépôt, branche `feat/refonte-tracky-v2`, cette roadmap | 3 écarts relevés (maquettes absentes, prémisse Poppins périmée, kit déjà posé). Bloc A d'abord, bloc B à la livraison des `.dc.html`. Point de contrôle à chaque lot. |
| 2026-08-09 | Étape 0 | `DECISIONS.md` (10 décisions), `TOKENS.md`, `ICONS.md` · violet + bleu créés · `--accent-ink` clair corrigé · 22 fallbacks `Poppins` purgés | **Défaut d'accessibilité corrigé** : encre blanche sur accent en thème clair, 3,43:1 → 5,54:1. **Deux défauts d'outillage relevés** : `pnpm verify` ne se termine pas (`ng test` en watch, P1) et le `launch.json` parent servait un autre projet. Confirmation au pixel en attente : panneau navigateur non affiché. |
| 2026-08-09 | A2 (3/3) | Onglet Missions dans `/agenda` : tableau, filtres, 5 compteurs · endpoints de liste et d'annulation | Le sélecteur de type existant fait office d'onglet — pas de page séparée, décision client. Les compteurs sont **serveur** : filtrée sur « En cours », la page ne contient pas les planifiées, et les recalculer afficherait « 0 planifiées ». « Véhicules indisponibles » compte les véhicules **distincts**. 1794 tests API. Vérification visuelle non faite (panneau navigateur non affiché). |
| 2026-08-09 | A2 (2/3) | Effet 3 — gabarit `mission_assigned` + catalogue admin + `escapeHtml` · Effet 4 — `GET /missions/mine` et la mention d'information dans `/driver` | `depotWatching` est **calculé côté serveur** : une obligation légale ne doit pas dépendre d'un `@if` de template. Le sujet de l'e-mail porte l'information (« Livraison prévue jeudi 08:15 → 11:40 »), au nom du transporteur, pas de Tracky. 1783 tests API. |
| 2026-08-09 | A1 | Rôle `DEPOT` + 4 permissions · `DEPOT_DEFAULTS` · modèle `Mission` + migration · `DepotScopeService` / `Guard` / décorateur · module + 3 endpoints · `DepotMissionDto` · isolation socket · gardes web · **12 tests d'isolation verts** | **Faille refermée** : 8 routes de `trip-analysis` servaient scores, carburant et coûts à un dépôt (gardées par `trips_view`, ouverte au rôle), + `/ai/status`. **Trou de conception refermé** : `clampPermissions` bornait au granter, pas à la cible — un `FLEET_ADMIN` pouvait ouvrir la flotte à un dépôt. **D11** : le modèle `Mission` migre en A1, sinon l'isolation ne compile pas. |
