# Décisions de conception — refonte Tracky v2

> Étape 0 du livrable (`B0-SOCLE.md`). Ce fichier est **le contrat** : toute séance
> ultérieure y fait référence. Une décision écrite ici ne se rediscute pas au détour d'un
> écran.
>
> Branche `feat/refonte-tracky-v2` · ouvert le 2026-08-09.

---

## D1 — La police : la planche de contrôle est sans objet

**Ce que dit le livrable.** `B0-SOCLE.md` § « Écart 1 — La police » pose que les maquettes
sont en Manrope et l'application en Poppins, que Poppins est métriquement plus large, et que
tout libellé qui tient juste dans une maquette peut déborder dans l'application. Il en fait
le **premier jalon du projet** : recréer la nav latérale, 10 pastilles et 4 tuiles de KPI en
Poppins, mesurer, puis choisir entre réduire les tailles de 0,02–0,04 rem ou élargir la nav
de 244 à 260 px.

**Ce que dit le dépôt.** L'application tourne **déjà en Manrope**.

| Preuve | Emplacement |
|---|---|
| `--font-display: 'Manrope', system-ui, sans-serif;` | `apps/web/src/styles.css:17` |
| `--font-sans: 'Manrope', system-ui, sans-serif;` | `apps/web/src/styles.css:18` |
| `@fontsource/manrope: "^5"` en dépendance | `apps/web/package.json:25` |
| Les 5 graisses importées (400 → 800) | `apps/web/src/styles.css:3-7` |
| Commit de bascule | `ec20139 feat(ui): refonte tokens design étape 1 (Manrope + palette DS émeraude)` |

Les commentaires `/* était Poppins */` et `/* était Inter */` laissés en place aux lignes 17
et 18 datent cette migration.

Poppins n'est installé nulle part : aucun `@fontsource/poppins`, aucun `<link>` Google
Fonts, aucun `@font-face` local.

**Décision.** L'écart de police n'existe pas — maquettes et application partagent Manrope.
Le risque de débordement décrit par B0 disparaît avec sa cause. La planche de contrôle
mesurée n'est **pas** réalisée : elle mesurerait une police qui n'est plus employée.

**Ce qui la remplace.** Deux tâches réelles, à coût quasi nul :

1. La purge des 22 fallbacks morts (cf. D2).
2. Un contrôle de non-débordement passé malgré tout sur les trois zones à risque que B0
   nommait — nav latérale complète, les 10 pastilles d'état les plus longues, les 4 tuiles
   de KPI. Coût nul, filet de sécurité conservé.

**Conséquence sur le reste du projet.** Aucun ajustement global de taille d'interface,
aucun élargissement de la nav. Le `244px` de la sidebar est conservé. La règle 3 du prompt
d'ouverture (« Poppins est plus large que Manrope, vérifie après chaque écran ») devient
sans objet ; la vigilance sur les débordements reste, mais comme critère de recette normal,
pas comme risque structurel.

---

## D2 — Les 22 fallbacks `Poppins` sont morts et trompeurs

**Le constat.** 23 occurrences de `Poppins` subsistent dans `apps/web/src`. Une seule est
légitime : le commentaire historique de `styles.css:17`. Les 22 autres sont un fallback CSS
de motif strictement identique :

```css
font-family: var(--font-display, Poppins, sans-serif);
```

**Pourquoi elles sont mortes — deux fois.**

1. `--font-display` est déclaré dans le bloc `@theme` de `styles.css`, qui l'émet sur
   `:root`. Il est donc toujours défini au moment où la règle s'applique. La valeur de repli
   d'une `var()` n'est atteinte que si la variable est **absente**. Ces 22 déclarations
   résolvent invariablement vers Manrope.
2. Et quand bien même le repli serait atteint : **Poppins n'est pas chargée**. Aucun
   `@fontsource/poppins`, aucun `@font-face`. Le navigateur passerait au maillon suivant,
   `sans-serif`. `Poppins` n'est donc pas seulement inatteignable — il ne désigne rien.

**Pourquoi elles nuisent.** Elles sont la seule raison pour laquelle une lecture de la
source donne aujourd'hui l'impression que l'application est en Poppins — c'est précisément
la lecture qui a produit l'« Écart 1 » du livrable. Les laisser, c'est garantir que la même
erreur d'analyse se reproduira.

**Décision.** Purge. `var(--font-display, Poppins, sans-serif)` → `var(--font-display)`
dans les 13 fichiers. Le commentaire de `styles.css:17` est **conservé** : il documente une
migration réelle et ne trompe personne.

**Les 13 fichiers concernés** (22 occurrences)

| Fichier | Occ. |
|---|:-:|
| `features/observability/admin-ai-usage.component.ts` | 3 |
| `features/observability/admin-hub.component.ts` | 3 |
| `features/installations/installation-editor.component.ts` | 2 |
| `features/installations/installations-client.component.ts` | 2 |
| `features/sims/admin-sims.component.ts` | 2 |
| `features/trip-analysis/trip-automation.component.ts` | 2 |
| `features/vehicles/vehicle-detail.component.ts` | 2 |
| `features/agenda/agenda.component.ts` | 1 |
| `features/installations/installations-list.component.ts` | 1 |
| `features/places/place-automation.component.ts` | 1 |
| `features/settings/ai-billing-card.component.ts` | 1 |
| `features/vehicles/vehicle-maintenance-tab.component.ts` | 1 |
| `features/vehicles/vehicle-reports-tab.component.ts` | 1 |

Le remplacement est purement textuel et sans effet visuel : le rendu était déjà Manrope.

---

## D3 — `DEPOT` est un rôle latéral, pas un rang

**Le risque.** Les rôles existants forment une échelle implicite : `SUPER_ADMIN` >
`FLEET_ADMIN` > `FLEET_MANAGER` > `VIEWER`, avec `NIGHT_WATCHMAN` et `DRIVER` en périmètres
restreints. Le réflexe naturel est de glisser `DEPOT` « sous `VIEWER` ».

**Pourquoi c'est faux.** Le périmètre d'un dépôt n'est pas un sous-ensemble de la flotte :
c'est un **axe différent**. Un `VIEWER` voit N véhicules de la flotte en permanence ; un
`DEPOT` voit un véhicule **pendant une fenêtre horaire**, parce qu'une mission l'y autorise,
et rien du tout en dehors. Aucune relation d'inclusion ne relie les deux.

**Décision.** `'DEPOT'` est ajouté **en dernière position** de `UserRoleSlug`, et n'entre
dans **aucune** comparaison de niveau, tri hiérarchique ou test d'ordre existant. Son
périmètre se calcule à chaque requête depuis `Mission`, jamais depuis `UserVehicleAccess` ni
`Fleet`.

Corollaire testé : un `DEPOT` n'a **jamais** de ligne `UserVehicleAccess`, et
`effectiveGranterPermissions({ role: 'DEPOT' })` renvoie toutes les permissions à `false` —
un dépôt n'invite personne et ne délègue rien.

---

## D4 — Les maquettes absentes : le bloc B est différé

**Le constat.** `00-LISEZ-MOI.md` § « Les maquettes de référence » et
`PROMPT-CLAUDE-CODE.md` § 0 listent 27 fichiers `.dc.html` à copier dans
`design/maquettes/`. Le livrable reçu le 2026-08-09 ne contient que les 10 documents `.md`.

`B1-PAGES.md` est explicite sur son propre statut : « *Il ne remplace pas les maquettes : il
dit ce qu'on y cherche.* » Il décrit les intentions page par page, pas les compositions.

**Décision (validée par le client le 2026-08-09).** Le bloc A s'implémente immédiatement :
ses six documents portent les modèles Prisma complets, les DTO au champ près, les endpoints,
les règles métier et 45 critères de recette — aucune dépendance visuelle. Le bloc B attend
la livraison des `.dc.html`.

**Condition de déblocage.** Les 27 fichiers présents dans `design/maquettes/`. Les tâches
B-kit, B-pages et B-mails de `REFONTE-TRACKY-V2.md` restent marquées 🔴 jusque-là.

**Exception.** Le lot B0′ (les 4 défauts de code relevés par B0 § « Les 4 défauts de code à
corriger au passage ») ne dépend d'aucune maquette et n'est pas bloqué.

---

## D5 — Le kit partagé existe déjà : B-kit est un raffinement

**Le constat.** `B1-PAGES.md` § H liste 24 composants partagés. 23 existent déjà dans
`apps/web/src/app/shared/` :

`ui/` — `alerts-bell`, `bottom-sheet`, `brand-logo`, `charts`, `confirm-modal`,
`connectivity-badge`, `date-range-picker`, `datetime-range`, `driver-picker`, `group-badge`,
`install-banner`, `install-review-badge`, `logo`, `mini-map`, `pdf-export-modal`,
`plan-upsell`, `push-prompt`, `skeleton`, `spinner`, `super-admin-context`, `toast`,
`trip-note-modal`, `update-required-modal`

`components/` — `metric-card`, `theme-toggle`

Posés par les commits `ec20139` (jetons), `698fb80` (shell + kit), `6517477` (splash +
loaders).

**Décision.** B-kit n'est pas une construction mais une passe de raffinement, de périmètre
défini :

1. les 6 états obligatoires (`chargement`, `rempli`, `vide`, `erreur`, `partiel`,
   `interdit`) sur chaque composant — c'est le manque réel du code actuel, beaucoup ne
   gèrent que « rempli » et « chargement » ;
2. la purge des couleurs en dur (cf. D7) ;
3. l'alignement sur les jetons de `TOKENS.md`.

Aucun composant n'est réécrit de zéro, aucun n'est renommé.

---

## D6 — Violet et bleu n'existent pas dans le système : ils sont à créer

**Le constat.** `B0-SOCLE.md` § « Écart 2 » impose « une couleur = une signification » sur
six familles : vert, rouge, ambre, bleu, violet, gris. Le dépôt n'en définit que quatre.

`styles.css` déclare aujourd'hui `--color-tracky*` (vert), `--danger` (rouge), `--warning`
(ambre) et les surfaces neutres (gris). **Aucun jeton violet, aucun jeton bleu.** Les rares
usages sont des hex isolés — par exemple `#3b82f6` en dur dans `.tk-popup-btn--info`
(`styles.css:888`).

**Pourquoi c'est bloquant pour le bloc A.** Le violet est la couleur du **dépôt** (règle 3
du livrable, reprise en A5 § 3 pour l'avatar, en A5 § 4 pour le marqueur ◆ de la matrice, et
en A3 § 1 pour le marqueur tireté du dépôt de départ sur la carte). Sans jeton, chaque écran
inventera son violet.

**Décision.** Les deux familles sont créées dans `styles.css`, en clair **et** en sombre,
avec leurs déclinaisons `-soft`, avant le premier écran du bloc A. Valeurs et
correspondances : `TOKENS.md`.

---

## D7 — Les couleurs en dur de `connectivity-badge` et deux distinctions à ajouter

**Le constat** (`B0-SOCLE.md` § « Les 4 défauts de code »). `connectivity-badge.component.ts`
renvoie ses propres hex : `#10b981`, `#0ea5e9`, `#ef4444`, `#f59e0b`, `#64748b`, `#9ca3af`.
Même défaut dans le rejeu de trajet. Elles ne suivent pas le thème clair et doublent les
jetons.

**Décision.** Purge au profit des jetons, et deux distinctions sémantiques ajoutées au
passage :

- ***Dormant*** passe en **violet**. Un boîtier muet depuis plus d'une semaine n'est pas une
  panne réseau : deux problèmes différents ne partagent pas l'ambre.
- ***Non configuré*** prend un **contour tireté**. C'est une absence d'installation, pas un
  état de terrain — le tireté dit « rien à diagnostiquer ici ».

---

## D8 — La surveillance passe en heure locale

**Le constat.** `surveillance-panel.component.ts` affiche `Début (HH:mm UTC)`. On demande au
gestionnaire une conversion mentale — et cette conversion change deux fois par an.

**La conséquence réelle**, telle que la nomme B0 : une surveillance réglée « 18:00 » démarre
à 20:00 en été. **Deux heures pendant lesquelles le véhicule n'est pas protégé, sans que
personne ne le sache.** C'est le défaut le plus grave des quatre.

**Décision.** Saisie en heure locale, UTC relégué en note de pied. La migration des réglages
déjà en base est traitée explicitement dans le lot B0′ : aucune valeur existante ne doit
changer de comportement sans qu'on l'ait décidé.

---

## D9 — L'assistant de démarrage : supprimer plutôt que corriger

**Le constat.** `onboarding-wizard.component.ts` déclare `Step = 1|2|3|4|5` alors que le
parcours réel dépend du rôle : un non-admin fait 1 → 2 → 5, et la barre de progression bondit
de 40 % à 100 %.

**Décision** (décision client rapportée par B0). L'assistant passe à **2 étapes pour tout le
monde** : les étapes véhicule, invitation et récapitulatif disparaissent. Le compteur codé en
dur n'est donc pas corrigé, il est supprimé avec ce qu'il comptait.

**En revanche**, les portes d'accès gardent un compteur, qui devient **calculé** : la
vérification d'appareil n'apparaît que si la 2FA est active *et* la connexion inhabituelle.
Un utilisateur habituel doit lire « 1 sur 2 », pas « 1 sur 3 ».

---

## D10 — La revue des contrôleurs est manuelle et exhaustive

**Pourquoi.** `A1-ROLE-DEPOT.md` § 3 le dit sans détour : « À appliquer sur **tous** les
contrôleurs qu'un dépôt peut atteindre, y compris ceux qui existent déjà. Une route oubliée
est une faille. » L'API compte 60 modules.

**Décision.** Le lot A1 ne se clôt pas sur ses 12 tests d'isolation seuls. Une revue
manuelle parcourt les 60 modules de `apps/api/src/`, et **l'inventaire est consigné dans ce
fichier** (section ci-dessous), module par module, avec son verdict : porte
`DepotScopeGuard`, refuse le rôle, ou inatteignable par construction.

Un test vert prouve qu'un chemin est fermé. Il ne prouve rien des chemins qu'on n'a pas
pensé à tester — d'où l'inventaire.

### Inventaire des contrôleurs — revue A1.4, faite le 2026-08-09

**Méthode.** Les 80 contrôleurs de `apps/api/src` ont été dépouillés **route par route**
(et non fichier par fichier : un contrôleur dont quatre méthodes sur cinq sont gardées
serait classé « fermé » à tort). Pour chaque route : décorateurs de classe **plus**
décorateurs de méthode, puis la question « un compte `DEPOT` authentifié franchit-il
`@Roles`, `@RequirePermissions` et `@RequireVehiclePermission` ? ».

Le critère d'appartenance au périmètre est **`JwtAuthGuard`**. Une route sans garde de
session (webhook, page publique à token, `InternalSecretGuard`) est ouverte à tout le
monde, authentifié ou non : c'est une autre question de sécurité, hors du remit d'A1.

Rappel du piège : `trips_view` est **ouverte** à un dépôt (A1 § 2, pour qu'il voie les
trajets de ses missions). Toute route gardée par cette seule permission lui est donc
accessible — c'est là qu'était la fuite.

#### Le résultat

| | Routes |
|---|:-:|
| Fermées par `@Roles` ou par une permission hors de `DEPOT_DEFAULTS` | la grande majorité |
| **Ouvertes et fuyantes → refermées dans ce lot** | **9** |
| Ouvertes et légitimes (gestion du compte du dépôt lui-même) | 31 |

#### Les 9 routes refermées

| Route | Ce qu'elle servait à un dépôt | Parade |
|---|---|---|
| `GET /trip-analysis/scores` | Les scores de conduite de **toute la flotte** | `DepotScopeGuard` |
| `GET /trip-analysis/scores/:scope/:id` | Le détail d'un score | idem |
| `GET /trip-analysis/vehicle/:vehicleId` | L'analyse de **n'importe quel** véhicule | idem |
| `GET /trip-analysis/fuel-report/:vehicleId` | Consommation et **coûts** carburant | idem |
| `GET /trip-analysis/fuel-calibration/:vehicleId` | La calibration des pleins | idem |
| `GET /trip-analysis/fuel-fill-ups/:vehicleId` | L'historique des pleins | idem |
| `GET /trip-analysis/fuel-stations/map` | La carte des stations fréquentées | idem |
| `GET /trip-analysis/:tripId` | **N'importe quel** trajet de la flotte | idem |
| `GET /ai/status` | La configuration IA du transporteur | `DepotScopeGuard` |

Les huit premières sont gardées par `@RequirePermissions('trips_view')` **sans `@Roles`**.
Elles exposent précisément ce que le livrable interdit deux fois : A1 § 4 (« leurs DTO
exposent des champs qu'un dépôt ne doit pas voir — coûts, scores ») et A3 § 7, règle 2
(« aucune donnée de coût, de score, de consommation »).

La neuvième n'exigeait rien du tout — « pour TOUT utilisateur authentifié ». Un dépôt n'a
aucune fonctionnalité IA ; lui servir la configuration de son transporteur tombe sous la
règle 6 d'A1 § 3 (« pas d'agrégat qui fuit »).

**La parade employée** : ajouter `DepotScopeGuard` au `@UseGuards` du contrôleur. Le garde
est en **refus par défaut** — sans décorateur `@DepotScope` sur la route, il rend `403` à un
`DEPOT` et **laisse passer tous les autres rôles sans rien changer**. C'est le correctif le
plus chirurgical possible : aucune liste de rôles à maintenir, aucun risque de rompre
l'accès d'un compte à qui `trips_view` aurait été accordée explicitement.

Le dépôt consultera ses trajets par son endpoint dédié `/depot/trips/:id` (lot A3), dont le
DTO est restreint.

#### Les 31 routes ouvertes, et pourquoi elles le restent

Toutes portent sur **le compte du dépôt lui-même**. Aucune ne lit de donnée de flotte.

| Contrôleur | Routes | Motif |
|---|:-:|---|
| `auth` | 1 | `GET /auth/me` — sans elle, impossible de se connecter |
| `consent` | 3 | Son propre consentement RGPD. Le refuser bloquerait l'application derrière le gate `CONSENT_REQUIRED` |
| `notifications` | 7 | Ses préférences et ses abonnements push. A2 § 3.3 prévoit qu'il reçoive une notification à chaque mission |
| `security` | 8 | Sa vérification d'appareil et sa 2FA |
| `users` | 5 | Son profil (`/users/me*`). `GET /users/me/access` renvoie ses scopes véhicule — vide par invariant, ce qui est précisément ce qu'on veut pouvoir constater |
| `user-activity` | 2 | Sa propre télémétrie d'usage |
| `geocode` | 1 | `reverse` — utilitaire d'affichage, nécessaire à sa carte |
| `realtime` | 1 | `POST /realtime/incident` — remontée d'erreur client, en écriture seule |
| `reservation-booking` | 3 | `/public/reserve/:token` — borné par le token, pas par le compte |

**Deux observations reportées, hors périmètre d'A1** — consignées pour ne pas les perdre :

- `/public/reserve/:token` porte un `JwtAuthGuard` alors que son nom et son usage la
  déclarent publique. Elle n'ouvre rien à un dépôt (le token borne tout), mais l'intention
  et le code se contredisent. À clarifier hors de ce chantier.
- `/geocode/reverse` est un appel externe facturé, atteignable par tout compte authentifié
  sans permission ni débit borné. Ce n'est pas une fuite de données ; c'est un coût
  potentiellement abusable. À traiter séparément.

#### Ce que cette revue ne prouve pas

Elle est **statique** : elle lit les décorateurs, pas le comportement. Elle établit qu'aucune
route n'est ouverte par oubli. Elle ne prouve pas que les services filtrent correctement une
fois la route franchie — c'est le rôle des 12 tests d'isolation d'A1 § 8, qui interrogent
l'API réelle.

Les deux se complètent et ne se remplacent pas : un test vert prouve qu'un chemin est fermé,
il ne dit rien des chemins auxquels on n'a pas pensé.

---

## D11 — Le modèle `Mission` est créé en A1, pas en A2

**Le problème d'ordonnancement.** `A0` impose A1 avant A2, et fait des 12 tests d'isolation
la condition de passage. Mais tout A1 § 3 repose sur `Mission` :

```ts
missionsFor(userId, at?)            // where: { depotUserId }
canSeeLivePosition(userId, vehicleId) // mission IN_PROGRESS|LATE couvrant l'instant
canSeeTrip(userId, tripId)            // trajet rattaché à une mission du dépôt
```

Or `A2` § 9 range la migration `Mission` dans **ses** impacts. En suivant les deux documents
à la lettre, A1 ne peut ni compiler ni être testé.

**Décision.** La migration Prisma du bloc A — `UserRole.DEPOT`, `Mission`, `MissionStatus`,
`Trip.missionId` — est portée par **A1**. Le modèle est repris tel quel de `A2` § 1, sans
rien inventer : il y est spécifié au champ près, index compris.

A2 garde tout le reste, qui est l'essentiel de son travail : le module `missions`, la
génération de `ref` en transaction, le statut dérivé, les 4 effets de bord, le conflit de
créneau, l'onglet d'agenda et les modales.

**Pourquoi ce découpage et pas l'inverse.** Un modèle sans service ne fait rien et ne risque
rien — c'est une table vide. L'inverse, écrire l'isolation contre un modèle qui n'existe pas,
n'est pas faisable. Et différer les tests d'isolation jusqu'à A2 reviendrait à supprimer la
condition de passage qu'`A0` § « Le risque principal » justifie en une phrase : « une fuite
de données entre transporteur et dépôt tue la fonctionnalité et la confiance ».

**Conséquence sur la recette.** Les 12 tests d'A1 s'exécutent sur des missions créées
directement en base par le harnais de test, sans passer par le module `missions` — qui
n'existe pas encore. C'est voulu : ils testent l'isolation, pas la création.

---

## Journal des décisions

| # | Date | Décision | Origine |
|---|---|---|---|
| D1 | 2026-08-09 | Planche de contrôle Poppins sans objet — l'app est déjà en Manrope | Audit du dépôt |
| D2 | 2026-08-09 | Purge des 22 fallbacks `Poppins` morts | Conséquence de D1 |
| D3 | 2026-08-09 | `DEPOT` est un rôle latéral, hors de toute hiérarchie | `A1-ROLE-DEPOT.md` § 1 |
| D4 | 2026-08-09 | Bloc B différé — maquettes absentes du livrable | Validée par le client |
| D5 | 2026-08-09 | B-kit devient une passe de raffinement | Audit du dépôt |
| D6 | 2026-08-09 | Violet et bleu à créer dans le système | `B0-SOCLE.md` § Écart 2 |
| D7 | 2026-08-09 | Couleurs en dur purgées + Dormant violet, Non configuré tireté | `B0-SOCLE.md` § défaut 1 |
| D8 | 2026-08-09 | Surveillance en heure locale | `B0-SOCLE.md` § défaut 2 |
| D9 | 2026-08-09 | Assistant de démarrage à 2 étapes — supprimer, pas corriger | `B0-SOCLE.md` § défaut 4 |
| D10 | 2026-08-09 | Revue manuelle exhaustive des 60 modules API en A1 | `A1-ROLE-DEPOT.md` § 3 |
| D11 | 2026-08-09 | Le modèle `Mission` migre en A1 — sans lui, l'isolation ne compile pas | Conflit A1 § 3 / A2 § 9 |
