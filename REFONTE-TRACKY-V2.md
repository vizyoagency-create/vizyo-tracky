# Refonte Tracky v2 — Roadmap d'implémentation

> Fichier de suivi unique. Une case cochée = tâche **terminée et vérifiée**, pas « écrite ».
> Branche : `feat/refonte-tracky-v2` (partie de `main` le 2026-08-09).
> Spécifications source : `design/*.md` (livrable Claude Design du 2026-08-09).

---

## Tableau de bord

| Lot | Objet | Bloquant pour | État | Avancement |
|---|---|---|:-:|:-:|
| **Étape 0** | Socle : `design/DECISIONS.md`, `TOKENS.md`, `ICONS.md` | tout | 🟡 quasi livré | 27 / 32 |
| **A1** | Rôle `DEPOT`, permissions, isolation backend | A2 A3 A5 | 🟢 **livré** | 68 / 76 |
| **A2** | Modèle `Mission`, agenda, indisponibilité véhicule | A3 A4 | ⬜ à faire | 0 / 103 |
| **A5** | Invitation, comptes dépôt, matrice | — | ⬜ à faire | 0 / 44 |
| **A3** | Espace `/depot` : 4 onglets × 3 plateformes | A4 | ⬜ à faire | 0 / 98 |
| **A4** | Lien public `/s/:token`, expiration, révocation | — | ⬜ à faire | 0 / 98 |
| **B0′** | Reliquat socle : couleurs en dur, UTC, accents, wizard | Bloc B | ⬜ à faire | 0 / 19 |
| **B-kit** | Kit partagé : 6 états sur 24 composants | pages B | 🔴 bloqué¹ | 0 / 28 |
| **B-pages** | 29 pages refondues × 3 déclinaisons | — | 🔴 bloqué¹ | 0 / 57 |
| **B-mails** | 19 gabarits d'e-mail | — | 🔴 bloqué¹ | 0 / 12 |
| **PROD** | Push, déploiement, recette production | — | ⬜ à faire | 0 / 28 |
| | | | **Total** | **3 / 590** |

¹ **Bloqué en attente des 27 maquettes `.dc.html`** — cf. « Écart 1 » ci-dessous. Le bloc A ne
dépend d'aucune maquette : ses documents sont auto-suffisants. B0′ n'en dépend pas non plus
et peut être fait dès maintenant.

**Légende d'état** : ⬜ à faire · 🟡 en cours · 🟢 livré et vérifié · 🔴 bloqué · ⏸️ en attente de validation

---

## Ce que l'analyse a révélé — trois écarts entre la spec et le dépôt

À lire avant toute implémentation. Ces trois points modifient le livrable ; ils sont
tranchés ici une fois pour toutes.

### Écart 1 — Les 27 maquettes ne sont pas dans le livrable

`00-LISEZ-MOI.md` et `PROMPT-CLAUDE-CODE.md` § 0 les listent comme à copier dans
`design/maquettes/`. Le livrable reçu ne contient que les 10 `.md`. Or `B1-PAGES.md` dit
lui-même : « *Il ne remplace pas les maquettes : il dit ce qu'on y cherche.* »

**Décision (2026-08-09, validée)** : le bloc A s'implémente maintenant — ses six documents
portent modèles Prisma, DTO exacts, endpoints, règles métier et critères de recette, sans
dépendance visuelle. Le bloc B attend la livraison des `.dc.html` dans `design/maquettes/`.
Ses tâches sont écrites intégralement ci-dessous mais restent **bloquées**.

- [ ] Les 27 fichiers `.dc.html` sont présents dans `design/maquettes/` → débloque le bloc B

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
- [x] Vérification complète : **typecheck 3/3 · smoke 5/5 · 277 partagés · 1727 API · 19 intégration**
- [ ] **Commit** `feat(depot): role DEPOT, isolation par mission et gardes API`
- [ ] ⏸️ **Point de contrôle client** — les 12 tests montrés verts

### Ce qui est reporté d'A1, et pourquoi

- [ ] **Shell mode dépôt — 3 entrées de nav sur 4.** Seule « Mes missions » est déclarée. Missions / Historique / Documents pointeraient vers des routes inexistantes jusqu'au lot A3. Un menu qui promet ce qu'il ne tient pas est exactement le défaut que B1 § J relève sur le mode simplifié
- [ ] **Shell — retrait du sélecteur de société, de la cloche, de la recherche globale ; marque du transporteur en tête ; pied « Propulsé par Vizyo Tracky »** → lot A3, avec les écrans qu'ils habillent
- [ ] **`assertNoVehicleAccess` est écrit et testé mais pas encore branché** sur la création / modification de compte → lot A5, qui possède ces parcours
- [ ] **5 endpoints d'A1 § 4 sur 8** — historique, exports, documents, incidents → lot A3. Les 3 livrés (liste, détail, position) sont ceux qui rendent l'isolation vérifiable

---

## Lot A2 — Les missions

> `design/A2-MISSIONS.md`. La mission est le pivot du bloc A : c'est elle qui ouvre l'accès
> au dépôt, et sa fenêtre horaire qui le referme. Décision client : **elle vit dans
> l'agenda**, pas dans une page à part.

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

- [ ] `pnpm verify` vert
- [ ] **Commit** `feat(missions): modele, agenda, indisponibilite vehicule et notification depot`
- [ ] ⏸️ **Point de contrôle client** — une mission créée bloque un véhicule

---

## Lot A5 — Comptes dépôt : invitation et gestion

> `design/A5-COMPTES.md`. Placé avant A3 : on a besoin d'un vrai compte dépôt pour
> développer et tester les écrans.

### A5.1 — Backend

- [ ] `Invitation` accepte `role: 'DEPOT'` (module `apps/api/src/invitations/` étendu, **pas** un second système)
- [ ] Refus des scopes véhicule / groupe pour ce rôle, à la création **comme** à la modification
- [ ] Blocage du changement de rôle **depuis et vers** `DEPOT` — un dépôt ne devient pas gestionnaire, et l'inverse non plus
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

- [ ] `pnpm verify` vert
- [ ] **Commit** `feat(users): invitation et gestion des comptes depot`
- [ ] ⏸️ **Point de contrôle client** — un dépôt invité se connecte

---

## Lot A3 — L'espace dépôt : les écrans

> `design/A3-ESPACE-DEPOT.md`. Nouvelle route `/depot`, 4 onglets, 3 déclinaisons.
> `apps/web/src/app/features/depot/` (nouveau).

### A3.1 — Backend : le module `depot`

`apps/api/src/depot/` — **ne pas réutiliser les contrôleurs de la flotte** : leurs DTO
exposent coûts, scores, conducteur hors mission, groupe.

- [ ] `GET /depot/missions?status=&from=&to=` → missions du dépôt, DTO restreint
- [ ] `GET /depot/missions/:id` → une mission + son déroulé
- [ ] `GET /depot/missions/:id/position` → position live, `403` hors fenêtre
- [ ] `GET /depot/trips/:id` → trajet d'une mission terminée
- [ ] `GET /depot/history?from=&to=` → trajets terminés + **KPI calculés côté serveur** (un calcul client obligerait à servir toutes les missions)
- [ ] `POST /depot/exports` → PDF/CSV borné aux missions du dépôt. **Ne pas** réutiliser le générateur de `/reports` : ses colonnes exposent des données d'exploitation
- [ ] `GET /depot/documents` → bons de livraison, rapports. État vide sans erreur si le transporteur n'en produit pas
- [ ] `POST /depot/incidents` → signalement au transporteur
- [ ] Tous portent `DepotScopeGuard`
- [ ] Endpoint dédié pour l'appel conducteur, qui **journalise l'accès** (le numéro complet ne transite pas par le DTO)

### A3.2 — Carte live (`/depot`)

**PC (1600 × 1000)** — 3 zones : menu 244 px · panneau missions 384 px · carte

- [ ] En-tête : « Missions du jour », date, dépôt
- [ ] Pastille verte pulsée « 4 camions en mission »
- [ ] Actions à droite : Signaler · Exporter · **Partager un suivi** (bouton accent)
- [ ] Panneau missions : filtres En cours / Planifiées / Terminées
- [ ] Carte de mission : référence, statut, trajet, créneau, plaque, conducteur + bouton d'appel, distance restante pour la sélection
- [ ] **Encart tireté qui nomme ce qui est absent** : « Les 3 autres camions de votre transporteur ne sont pas sur vos missions : ils ne vous sont pas visibles. » Sans cette phrase, un dépôt qui sait que le transporteur a 7 camions se demande si l'outil est cassé ; avec elle, l'absence devient une garantie
- [ ] Carte : tuiles CartoDB clair/sombre selon le thème
- [ ] Marqueurs camion avec halo pulsé pour les missions en cours, **rouge** pour les retards
- [ ] Marqueur tireté **violet** pour le dépôt de départ
- [ ] Composant de carte réutilisé depuis `/map` avec **configuration restreinte** : pas de calques géofences, pas de lieux clés, pas de sélecteur de véhicules
- [ ] Barre basse : plaque, mission, conducteur, vitesse, arrivée estimée avec l'avance ou le retard, boutons « Le camion » et « Voir le trajet »

**iPhone 390 × 844**
- [ ] Carte plein écran
- [ ] Barre d'onglets basse 4 entrées (Carte · Missions · Historique · Compte)
- [ ] En-tête flottant : monogramme du transporteur + bouton de partage
- [ ] Puces de filtre horizontales
- [ ] Feuille basse 330 px redimensionnable

**Android 412 × 915**
- [ ] Menu latéral, **pas** de barre d'onglets (les 3 boutons système occupent déjà le bas)
- [ ] Top app bar avec hamburger
- [ ] Puces filtres M3
- [ ] Feuille basse 28 dp, poignée 32 × 4
- [ ] **FAB étendu « Partager »**, remonté à 100 px quand un snackbar est affiché

**Rafraîchissement**
- [ ] WebSocket sur `depot:mission:<missionId>`, une room par mission en cours
- [ ] Repli en polling toutes les 20 s si le socket tombe
- [ ] « rafraîchie il y a 12 s » est un **vrai compteur**, pas un texte fixe
- [ ] Au-delà de 60 s sans message : « Connexion perdue · nouvelle tentative »

### A3.3 — Missions (`/depot/missions`)

- [ ] Même liste que le panneau, en pleine largeur, détail accessible
- [ ] Tri : en cours d'abord (**retards en tête**), puis planifiées par heure de départ, puis terminées
- [ ] **État vide soigné** — c'est le premier écran d'un nouveau dépôt : « Aucune mission pour l'instant / Votre transporteur vous assignera des missions depuis son espace. Vous recevrez un e-mail à chaque nouvelle mission. » + bouton [Comment ça marche]

### A3.4 — Historique (`/depot/history`)

- [ ] Filtres : 7 jours / 30 jours / Ce mois · camion · destination
- [ ] 4 KPI : missions livrées · **% à l'heure** · durée moyenne · retard moyen avec le nombre de cas
- [ ] « % à l'heure » calculé sur les missions `DONE` de la période : `actualEndAt <= endAt`. C'est la note du transporteur — l'indicateur que le dépôt regarde vraiment
- [ ] Tableau : Réf. · Trajet · Date · Créneau réel · Camion · Conducteur · Distance · Arrêts · Ponctualité · actions (voir, PDF)
- [ ] Pied de tableau : « 6 trajets sur 23 · les trajets hors de vos missions ne figurent pas dans cet historique. »
- [ ] Mobile : cartes plutôt que tableau (3 visibles sur iPhone, 4 sur Android)
- [ ] **Conservation 12 mois écrite dans l'interface**, pas seulement dans les CGU
- [ ] Historique vide → « Vos missions terminées apparaîtront ici »
- [ ] Moins de 3 missions terminées → KPI affichent un tiret **expliqué** : « 2 missions seulement, un taux demande 5 missions »

### A3.5 — Documents (`/depot/documents`)

- [ ] Rail droit sur PC, onglet plein écran sur mobile
- [ ] Rapport hebdomadaire — généré tous les lundis 08:00, PDF
- [ ] Bon de livraison — par mission terminée, PDF
- [ ] Export de période — à la demande, PDF ou CSV
- [ ] Interrupteur « rapport automatique » activé par défaut (« chaque lundi à 08:00 », par e-mail), le dépôt peut le couper

### A3.6 — Les 6 modales

**Détail d'un trajet**
- [ ] 4 tuiles : distance · durée · arrêts · arrivée estimée (en accent)
- [ ] Mini-carte avec le tracé et la position actuelle (`mini-map` du kit)
- [ ] **Déroulé horodaté** : chaque étape, son heure réelle, le temps passé sur place. L'étape à venir en tireté avec l'heure estimée
- [ ] Le temps passé sur place est ce qui permet de comprendre un retard sans appeler
- [ ] Pied : Exporter ce trajet · Signaler un incident · Partager le suivi

**Détail d'un camion**
- [ ] Plaque, modèle, transporteur, conducteur, téléphone masqué, mission en cours, missions du mois + taux de ponctualité
- [ ] Encart de fermeture avec icône cadenas : « Hors fenêtre de mission, la position de ce camion vous est masquée. Vous ne voyez ni ses trajets privés ni les autres véhicules du transporteur. »

**Signaler un incident**
- [ ] Mission pré-remplie · motif en puces (Retard / Marchandise / Accès dépôt / Autre) · texte libre
- [ ] `POST /depot/incidents` → notification + e-mail au transporteur
- [ ] L'incident apparaît dans l'agenda du transporteur **comme un événement**, pas un simple message : il doit atterrir là où le gestionnaire regarde

**Export**
- [ ] Période en puces · format PDF (rapport) ou CSV (données brutes)
- [ ] Nombre de trajets concernés affiché **avant** de générer
- [ ] Sur mobile, poids estimé (« ≈ 1,2 Mo ») — un export en 4G sans avertissement est une mauvaise surprise
- [ ] Au-delà de 8 s : « le réseau est lent · Annuler »

**Onboarding première connexion**
- [ ] Animation HTML/CSS en 3 étapes : la mission est créée → le camion roule → la livraison est tracée
- [ ] Boucle de 12 s, **arrêtée sous `prefers-reduced-motion`**
- [ ] Deux sorties : « Commencer » et « Revoir plus tard »
- [ ] Lien discret vers `decouvrir-depot.html`
- [ ] Affichée une fois, réaccessible par « Comment ça marche »

**Partage** → traitée en A4

### A3.7 — Les 7 règles d'interface

- [ ] Aucun compteur de flotte : tout chiffre se calcule sur les missions du dépôt
- [ ] Aucune donnée de coût, de score, de consommation
- [ ] La plaque est la clé — jamais d'identifiant interne visible, **ni dans l'URL**
- [ ] Téléphone masqué à l'écran, bouton d'appel via l'endpoint journalisé
- [ ] Marque du transporteur en tête, Vizyo Tracky en pied de menu à 12 px
- [ ] Lecture seule partout : les deux seules écritures d'un dépôt sont signaler un incident et générer un lien
- [ ] Réutilisation du kit : `mini-map`, `bottom-sheet`, `confirm-modal`, `toast`, `skeleton`, `pdf-export-modal`

### A3.8 — États et cas particuliers

- [ ] Aucune mission → carte centrée sur le dépôt + encart « Aucune mission en cours ». **Pas** une carte muette
- [ ] Mission planifiée non démarrée → dans la liste, pas sur la carte, « Le suivi démarrera à 08:15 »
- [ ] Position indisponible → dernière position **grisée** + « indisponible depuis 14 min ». Jamais présentée comme actuelle
- [ ] Socket perdu → bandeau « Connexion perdue · nouvelle tentative »
- [ ] Mission terminée pendant la consultation → marqueur retiré avec transition + toast explicatif
- [ ] Véhicule en mode vie privée pendant la mission → « Suivi suspendu », sans dire pourquoi
- [ ] Accès retiré → déconnexion + « Votre accès a été retiré par votre transporteur »

### Recette A3 — les 10 critères

- [ ] 1 — connexion d'un dépôt sans mission → état vide expliqué, pas de carte muette
- [ ] 2 — mission en cours → camion sur la carte, position rafraîchie
- [ ] 3 — mission d'un autre dépôt → absente de la carte **et** de l'API
- [ ] 4 — fin de mission pendant la consultation → marqueur retiré, toast explicatif
- [ ] 5 — coupure réseau → bandeau, puis reprise automatique
- [ ] 6 — export 7 jours PDF → fichier borné aux missions du dépôt
- [ ] 7 — signalement d'incident → événement créé dans l'agenda du transporteur
- [ ] 8 — iPhone 390 px → aucun débordement, cibles ≥ 44 px
- [ ] 9 — Android 412 px → menu latéral, pas de barre d'onglets, FAB présent
- [ ] 10 — thème clair et sombre → contrastes ≥ 4,5:1 sur le texte

- [ ] `pnpm verify` vert
- [ ] **Commit** `feat(depot): espace depot — carte live, missions, historique, documents`
- [ ] ⏸️ **Point de contrôle client** — l'espace dépôt sur 3 plateformes

---

## Lot A4 — Le partage : lien public temporaire

> `design/A4-PARTAGE.md`. **Le lot le plus sensible.** Un lien public qui n'expire pas, ou
> qui expose plus que prévu, est une fuite de données permanente et indexable.

### A4.1 — Le modèle

- [ ] `MissionShareLink` créé conforme à A4 § 1, calqué sur `ReservationBookingLink`
- [ ] `enum ShareDuration` : `MIN_15`, `HOUR_1`, `UNTIL_MISSION_END`
- [ ] `@@index([missionId, createdAt])`, `@@index([expiresAt])`
- [ ] `lastOpenedFrom` = empreinte **tronquée**, jamais l'IP complète (RGPD)
- [ ] Migration générée, relue, appliquée

### A4.2 — Le token

- [ ] 22 caractères base62, tirés de `crypto.randomBytes` — pas d'uuid, pas de compteur
- [ ] **Jamais dérivé de l'identifiant de mission** : un token prévisible donne accès à toutes les missions
- [ ] Non réutilisable : un nouveau partage crée un nouveau lien. Régénérer le même token permettrait à un ancien destinataire de revenir
- [ ] Test : 10 000 tokens générés, aucune collision, distribution uniforme

### A4.3 — Le DTO public — la spécification la plus importante du lot

`PublicTrackingDto`. **Tout champ absent de la liste ne doit pas quitter le serveur.**

- [ ] Exposé : `status`, `position { lat, lng } | null`, `etaAt`, `destinationLabel` (la **ville**, pas l'adresse exacte), `carrierName`, `expiresAt`, `lastUpdateAt`
- [ ] **Jamais** : plaque (identifie un véhicule et son propriétaire)
- [ ] **Jamais** : nom du conducteur, téléphone (données personnelles, aucun motif)
- [ ] **Jamais** : référence de mission (permet de deviner le volume d'activité)
- [ ] **Jamais** : adresse exacte, origine (révèle l'implantation du dépôt)
- [ ] **Jamais de tracé parcouru** — le piège classique : « d'où vient le camion » révèle les points de livraison précédents, donc les autres clients du dépôt. Le lien montre **un point**, pas une ligne
- [ ] **Jamais** : historique
- [ ] Test d'assertion sur les clés exactes de la réponse

### A4.4 — Les endpoints

**Côté dépôt (authentifié)** — `apps/api/src/depot/mission-share.controller.ts`
- [ ] `POST /depot/missions/:id/share { duration }` → `{ token, url, expiresAt }`
- [ ] `GET /depot/missions/:id/shares` → liens actifs + usage
- [ ] `DELETE /depot/shares/:id` → révocation immédiate
- [ ] Gardes : `DepotScopeGuard` + `mission_share`
- [ ] Limite : 3 liens actifs maximum par mission
- [ ] Limite : 20 créations par heure et par compte (`@Throttle`)

**Côté public (sans authentification)** — `public-mission-share.controller.ts`
- [ ] `GET /public/track/:token` → `PublicTrackingDto`
- [ ] Aucun `JwtAuthGuard`, sur le modèle de `PublicReservationBookingController`
- [ ] `@Throttle({ default: { ttl: 60_000, limit: 30 } })`
- [ ] **Pas de WebSocket** sur le lien public — un socket non authentifié est une surface d'attaque disproportionnée pour un point sur une carte. Polling 20 s côté client
- [ ] En-tête `Cache-Control: no-store`
- [ ] En-tête `X-Robots-Tag: noindex, nofollow` — **indispensable** : sans lui, un lien collé dans un message public finit indexé
- [ ] En-tête `Referrer-Policy: no-referrer`

### A4.5 — L'expiration

- [ ] `MIN_15` → `now + 15 min`
- [ ] `HOUR_1` → `now + 1 h`
- [ ] `UNTIL_MISSION_END` → `mission.endAt + 30 min` (la marge couvre le retard : un lien qui expire pile à l'heure prévue meurt au moment où le client en a le plus besoin)
- [ ] **Non prolongeable** : aucun endpoint ne repousse `expiresAt`. Pour prolonger, on crée un nouveau lien, sciemment
- [ ] Vérifiée à chaque requête, à l'heure serveur
- [ ] **La fin de mission ferme tous les liens**, quelle que soit leur durée : suivre un camion après sa livraison, c'est suivre sa tournée suivante
- [ ] Tâche de purge quotidienne : suppression des liens expirés depuis plus de 30 jours (30 jours gardés pour l'audit)
- [ ] Tâche enregistrée dans l'inventaire `/admin/background-tasks`

### A4.6 — La révocation et l'audit

- [ ] Bouton « Révoquer » par lien actif, avec le nombre d'ouvertures : « ouvert 3 fois, dernière il y a 4 min »
- [ ] Effet immédiat, aucun cache
- [ ] Le transporteur peut révoquer **n'importe quel** lien de sa flotte, y compris ceux créés par un dépôt — c'est lui qui porte la responsabilité des données
- [ ] Dépôt désactivé → ses liens actifs sont révoqués automatiquement
- [ ] Toute création et toute révocation journalisées : qui, quand, quelle mission, quelle durée

### A4.7 — La modale de partage

`features/depot/share-dialog/`

- [ ] La mission concernée, en lecture seule
- [ ] 3 puces de durée : `15 min` (défaut) · `1 h` · `Fin de mission`
- [ ] Lien généré + bouton Copier
- [ ] Encart ambré avec **compte à rebours réel** : « Expire dans 14:52 · révocable à tout moment »
- [ ] **Phrase de périmètre** sous le titre : « Un lien public à envoyer à votre client final. Il n'affiche que la position et l'heure d'arrivée du camion de cette mission, et expire automatiquement. » Le dépôt doit savoir ce qu'il transmet avant de l'envoyer
- [ ] iOS : feuille basse, bouton pleine largeur « Copier et envoyer » qui ouvre la feuille de partage native
- [ ] Android : FAB « Partager », snackbar « Lien copié » avec action **ANNULER qui révoque** — la sortie du geste raté, dans les 5 secondes, sans ouvrir de menu

### A4.8 — La page publique `/s/:token`

`features/public-tracking/` — mobile d'abord : elle s'ouvre depuis un SMS ou WhatsApp dans 90 % des cas.

- [ ] Route `/s/:token` ajoutée à `app.routes.ts`, **hors** du shell authentifié (`auth-layout` ne s'applique pas)
- [ ] Nom du transporteur en tête, discret
- [ ] Carte plein écran, camion centré, halo pulsé
- [ ] Bandeau bas : « Arrivée estimée **11:34** » + statut (« en route », « en retard de 22 min »)
- [ ] Mention d'expiration : « Ce lien expire à 12:05 »
- [ ] **Aucune navigation, aucun lien vers l'application, aucun formulaire**
- [ ] **Pas de compte, pas de cookie, pas d'analytics tiers.** La page ne pose rien sur l'appareil du destinataire
- [ ] Compte à rebours réel

**Les 4 états**
- [ ] Actif → carte + arrivée estimée
- [ ] Expiré → « Ce lien de suivi a expiré » + « Demandez-en un nouveau à votre expéditeur ». **Pas** de bouton de renouvellement : le destinataire n'a pas ce droit
- [ ] Révoqué → **écran identique**. Dire « révoqué » indiquerait qu'il a existé et que quelqu'un l'a fermé
- [ ] Introuvable → **écran identique encore**
- [ ] Les trois derniers partagent le **même code HTTP `410 Gone`** — uniformité délibérée : elle empêche de distinguer un token inexistant d'un token fermé, donc d'énumérer

### A4.9 — États et cas particuliers

- [ ] Lien ouvert avant `startAt` → carte centrée sur la destination, « Le suivi démarrera à 08:15 », puis bascule seul
- [ ] Position indisponible → dernier point grisé + « position indisponible depuis 6 min ». Jamais un point périmé présenté comme actuel
- [ ] Mission terminée pendant la consultation → « Livraison effectuée à 11:34 », carte figée 30 s, puis écran de fin
- [ ] Mission annulée pendant la consultation → « Cette livraison a été annulée. Contactez votre expéditeur. »
- [ ] Mission `PLANNED` **peut** être partagée · `DONE` ou `CANCELLED` ne peut plus l'être, et ses liens existants sont fermés
- [ ] Le lien ne donne accès qu'à **une** mission. Jamais un lien « toutes mes livraisons »
- [ ] Véhicule changé sur la mission → le lien suit la mission, transparent pour le destinataire
- [ ] 4ᵉ lien sur une mission → refus avec message clair

### A4.10 — La liste de contrôle sécurité

- [ ] Token cryptographique, 22 caractères, non dérivé d'un identifiant
- [ ] `expiresAt` vérifié côté serveur à chaque requête
- [ ] `410` uniforme pour expiré / révoqué / introuvable
- [ ] `X-Robots-Tag: noindex, nofollow`
- [ ] `Cache-Control: no-store`
- [ ] `Referrer-Policy: no-referrer`
- [ ] Débit borné sur la route publique
- [ ] Aucune donnée personnelle dans le DTO public
- [ ] Aucun tracé, un point seulement
- [ ] Fermeture automatique à la fin de mission
- [ ] Journal d'audit complet
- [ ] IP tronquée, jamais complète

### Recette A4 — les 12 critères

- [ ] 1 — générer un lien 15 min, l'ouvrir → carte + arrivée estimée
- [ ] 2 — **attendre 16 minutes réelles**, rouvrir → `410` + écran « expiré ». *Attendre, pas simuler*
- [ ] 3 — révoquer, rouvrir → écran identique à l'expiré, même code
- [ ] 4 — token inventé → écran identique encore
- [ ] 5 — **inspecter la réponse publique** → aucune plaque, aucun nom, aucun tracé
- [ ] 6 — terminer la mission → tous les liens fermés immédiatement
- [ ] 7 — générer 4 liens sur une mission → le 4ᵉ refusé avec un message clair
- [ ] 8 — 40 créations en une heure → débit borné
- [ ] 9 — vérifier les en-têtes → `noindex`, `no-store`, `no-referrer`
- [ ] 10 — lien ouvert sur mobile 360 px → carte lisible, arrivée estimée visible sans défilement
- [ ] 11 — dépôt désactivé → ses liens actifs deviennent inopérants
- [ ] 12 — journal d'audit → création et révocation tracées avec leur auteur

- [ ] `pnpm verify` vert
- [ ] **Commit** `feat(depot): lien public temporaire de suivi de mission`
- [ ] ⏸️ **Point de contrôle client** — le partage complet

---

## Bloc B — La refonte de l'interface

> 🔴 **Bloqué** jusqu'à la livraison des 27 `.dc.html` dans `design/maquettes/`, sauf B0′ qui
> ne dépend d'aucune maquette et peut être fait dès maintenant.

### B0′ — Le reliquat du socle (débloqué)

Les 4 défauts de code relevés en lisant la source, indépendants de la refonte.

**Couleurs en dur**
- [ ] `connectivity-badge.component.ts` : les 6 hex (`#10b981`, `#0ea5e9`, `#ef4444`, `#f59e0b`, `#64748b`, `#9ca3af`) remplacés par des jetons — elles ne suivent pas le thème clair et doublent les variables
- [ ] Idem dans le rejeu de trajet
- [ ] Distinction ajoutée : *Dormant* passe en **violet** (boîtier muet depuis plus d'une semaine ≠ panne réseau — deux problèmes ne partagent pas l'ambre)
- [ ] Distinction ajoutée : *Non configuré* prend un **contour tireté** (absence d'installation, pas un état de terrain)
- [ ] Vérifié en thème clair **et** sombre

**Surveillance réglée en UTC — le plus grave**
- [ ] `surveillance-panel.component.ts` : saisie en **heure locale**, UTC en note de pied
- [ ] Conséquence réelle corrigée : une surveillance réglée « 18:00 » démarrait à 20:00 en été — deux heures pendant lesquelles le véhicule n'était pas protégé, sans que personne ne le sache
- [ ] Vérifié sur un changement d'heure (été/hiver)
- [ ] Les réglages existants en base sont migrés ou réinterprétés sans rupture

**Accents perdus**
- [ ] Assistant de démarrage (« Pret a piloter votre flotte ? » → « Prêt à piloter votre flotte ? »)
- [ ] Sujets d'e-mail
- [ ] Corps d'e-mail
- [ ] Passe globale : recherche des mots français sans accent dans les chaînes affichées

**Compteurs d'étapes codés en dur**
- [ ] `onboarding-wizard.component.ts` : `Step = 1|2|3|4|5` supprimé — décision client, l'assistant passe à **2 étapes pour tout le monde**. Le défaut se résout en supprimant, pas en corrigeant
- [ ] Les étapes véhicule, invitation et récapitulatif disparaissent
- [ ] Portes d'accès : « étape N sur 3 » devient **calculé** — la vérification d'appareil n'apparaît que si la 2FA est active *et* la connexion inhabituelle. Un utilisateur habituel voit « 1 sur 2 »
- [ ] Vérifié pour un non-admin (le parcours 1 → 2 → 5 qui faisait bondir la barre de 40 % à 100 %)

- [ ] `pnpm verify` vert
- [ ] **Commit** `fix(ui): couleurs en dur, surveillance en heure locale, accents, compteurs d'etapes`

### B-kit — Le kit partagé (passe de raffinement)

> Les 23 composants existent déjà (Écart 3). Ce lot les **unifie**, il ne les crée pas.
> Ordre d'attaque par nombre de pages touchées.

- [ ] `connectivity-badge` (9 pages) — les 6 états
- [ ] `confirm-modal` (14 pages) — les 6 états
- [ ] `toast` + `skeleton` (toutes) — les 6 états
- [ ] `bottom-sheet` (11 pages) — les 6 états
- [ ] `trip-note-modal`
- [ ] `pdf-export-modal`
- [ ] `update-required-modal`
- [ ] `plan-upsell`
- [ ] `push-prompt`
- [ ] `date-range-picker`
- [ ] `datetime-range`
- [ ] `driver-picker`
- [ ] `spinner`
- [ ] `alerts-bell`
- [ ] `group-badge`
- [ ] `install-banner`
- [ ] `install-review-badge`
- [ ] `super-admin-context`
- [ ] `charts`
- [ ] `mini-map`
- [ ] `metric-card`
- [ ] `brand-logo`
- [ ] `logo`
- [ ] `theme-toggle`

**Les 6 états obligatoires sur chacun** : `chargement` · `rempli` · `vide` · `erreur` ·
`partiel` · `interdit`. C'est le manque le plus fréquent du code actuel : beaucoup de
composants ne gèrent que « rempli » et « chargement ».

- [ ] **`interdit` en particulier** : aujourd'hui on masque silencieusement, il faut **nommer la permission manquante**. Un bouton qui disparaît sans explication produit un ticket de support ; un bouton désactivé qui dit « demande la permission *Couper le moteur* » n'en produit aucun
- [ ] Les 5 règles du kit appliquées : aucune couleur en dur · squelette et non rond · une erreur porte un recours · nommer ce qui est perdu · modale sur PC, feuille sur mobile
- [ ] Un composant démontre ses 6 états (page de démonstration ou tests visuels)
- [ ] **Commit** `refactor(ui): kit partage — les 6 etats sur les 24 composants`

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
- [ ] `/vehicles/:id` — **10 onglets regroupés en 4 familles** : Suivi (Carte, Historique) · Analyse (Rapports, Scores) · Sécurité (Alertes, Surveillance, Géofences) · Exploitation (Maintenance, Horaires, Commandes). **Rien supprimé**
- [ ] `/vehicles` — onglets liste / groupes / capacités / mode privé ; sur mobile cartes + filtres en feuille
- [ ] `/alerts` — onglets Alertes / Géofences / Réglages

**D — Analyse (5)**
- [ ] `/reports` — barème A→E explicité, exports PDF/CSV/Excel, sur mobile sparklines + drill-down, **jamais de scroll horizontal**
- [ ] `/scores` — podium, classement, carte « ce qui coûte des points », tendance 7 semaines, lien de partage en lecture seule
- [ ] `/agenda` — propositions de l'agent IA, réglages, réservation avec suggestion *(le 3ᵉ onglet Missions est livré en A2)*
- [ ] `/fleet-admin/activity` — **le résultat avant l'événement** (« refusée · véhicule en mouvement 74 km/h » au lieu d'un mot de statut), les échecs en tête, la présence devient un panneau permanent
- [ ] `/admin/ai-usage` — le forfait d'abord, la consommation ensuite, « en cas de dépassement, rien ne se coupe et rien n'est facturé en plus », chaque euro rattaché à un résultat

**E — Administration (10)**
- [ ] `/users` — invitations en attente et expirées, tiroir d'édition *(le rôle Dépôt est livré en A5)*
- [ ] `/users/overview` — matrice repensée en liste par rôle sur mobile
- [ ] `/installations` — le jour en cours au centre, anneau de progression + 4 compteurs, « ce qu'on attend de vous », SIM manquante expliquée
- [ ] `/integrations` — volume réellement transmis par catégorie, consentement en deux blocs, sensible décoché
- [ ] `/fleet-schedules` — **frise 24 h par groupe** au lieu de colonnes de texte, l'anomalie d'abord (bandeau « roulent encore »)
- [ ] `/privacy-coverage` — les 3 états avec les mêmes mots que dans l'éditeur d'horaires, bouton *Définir les horaires* sur les véhicules « mixte sans cadre »
- [ ] `/settings` — **navigation à deux niveaux avec recherche** (« Mon espace » vs « Ma flotte », la question la plus posée), enregistrement automatique visible, pastille « modifié » par section
- [ ] Règles de notification (carte dans `/settings`) — prévision du volume, heures calmes
- [ ] `/settings/audio-monitoring` — mode assistance
- [ ] `/account` — profil, sessions ouvertes avec appareil inconnu signalé, sécurité

**A — Hors session (7)** — *quasi exclusivement mobiles, ouvertes depuis un SMS ou un QR : concevoir mobile d'abord, le PC est un repli*
- [ ] `/login` — détection Verr. Maj, compteur d'essais restants, entrée « QR véhicule », Face ID / empreinte
- [ ] `/forgot-password` — 2 écrans, message identique que l'e-mail existe ou non
- [ ] `/accept-invite` — lien expiré, déjà utilisé, compte existant
- [ ] `/install` — **détection automatique de la plateforme** au lieu du sélecteur à 3 onglets, QR desktop → mobile
- [ ] `/book/:token` — 4 réponses avec sortie : être prévenu, appeler, redemander un lien. Plus d'écran cul-de-sac
- [ ] `/reserve/:token` — **la dictée devient le chemin principal** : bouton 112 px avec ondes, le formulaire ne sert qu'à corriger, transcription visible, interprétation des dates explicitée, contact manquant signalé **avant** le bouton, « vous ne choisissez pas le véhicule » enfin dit, 4 cas d'échec avec sortie
- [ ] `/driver/unlock` — déverrouillage de proximité, une main, gants

**B — Espace conducteur (1)**
- [ ] `/driver` — usage 100 % téléphone, cibles ≥ 44 px, contraste extérieur, une main *(la mission du jour + la mention d'information sont livrées en A2)*

**F — Surfaces bloquantes (12)**
- [ ] Consentement RGPD — **la séquence devient visible** (« étape N sur 3 », calculée), note conducteurs actionnable avec modèle téléchargeable
- [ ] Autorisations navigateur — localisation justifiée par son usage, **fin de l'impasse** : « Continuer sans déverrouillage QR »
- [ ] Vérification d'appareil — code à 6 cases séparées, collage depuis l'e-mail
- [ ] Proposition 2FA — sort de la pile : voile à 22 %, 3 sorties visibles, feuille iOS, dialogue M3
- [ ] Assistant de démarrage — *livré en B0′*
- [ ] Coupure moteur — **compte à rebours pendant les 90 s**, la raison du refus sort du `title`, l'état non confirmé a 3 sorties, avertissement boîtier muet en 3 étapes numérotées
- [ ] Panneau surveillance — week-end en surveillance permanente, dénouement de chaque déclenchement *(l'heure locale est livrée en B0′)*
- [ ] QR véhicule — explique son usage et son format d'impression (60 × 90 mm), 262 px sur Android
- [ ] Rejeu de trajet — **multiplicateurs partout avec la durée réelle à côté**, excès confirmé vs pointe à vérifier, la frise porte l'analyse
- [ ] Rejeu de période — **une barre par jour**, trajets listés et cliquables, échelle 16× ajoutée
- [ ] Créer / éditer un véhicule — **le boîtier devient facultatif** (« Sans boîtier pour l'instant »), compteur `15 / 15` sur l'IMEI, « 2 champs requis sur 11 »
- [ ] Éditeur d'horaires — **bloc imbriqué derrière un filet vert** : impossible de régler les plages en croyant protéger alors que rien n'est protégé, « 122 h sur 168 sans collecte »

**J — Interfaces alternatives (2)**
- [ ] Mode veilleur — 3 permissions, une seule écriture : **redémarrer**. Il ne peut pas couper (rallumer débloque une exception réversible, couper immobilise un bien). Accordéons par groupe, bouton Redémarrer sur la ligne, confirmation en un toucher avec deux garanties : *réversible*, *consigné à votre nom*
- [ ] Interface simplifiée — carte plein écran, 3 cibles de 88 px en langage courant, 4 règles : jamais plus de 3 boutons · langage courant · les garde-fous restent · la sortie vers l'interface complète toujours visible
- [ ] ⚠️ **Défaut à corriger** : le réglage promet « toutes les pages restent accessibles » mais `dashboard-layout.component.ts` filtre le menu à 5 entrées — Rapports, Scores, Agenda et le tableau de bord disparaissent. La promesse et le code se contredisent. **Le menu doit tout garder**
- [ ] **Règle non négociable** : en mode simplifié, Paramètres reste toujours dans le menu, détaché, en violet, sous-titré « Revenir en interface complète ». Sans cette garantie, l'utilisateur est enfermé dans un mode qu'il n'a pas compris

**G — Le shell, en dernier (2)**
- [ ] Shell authentifié — une seule définition de référence, bandeau hors ligne qui **pousse** le contenu, barre de progression 2 px qui **se superpose**, 3 modes spéciaux (veilleur, simplifié, super-admin) *(le mode dépôt est livré en A1)*
- [ ] Shell hors session — panneau droit conservé tel quel. Un seul changement : l'accroche passe de « Suivez et sécurisez votre flotte » à « Vous savez où sont vos véhicules. Et pourquoi ils s'arrêtent. »
- [ ] **Décisions de plateforme, à ne pas revisiter** : iOS 5 onglets en bas, **pas de hamburger** (il concurrence le geste de retour) · Android tiroir M3, **pas de barre d'onglets** (les 3 boutons système occupent déjà le bas)

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
| 2026-08-09 | — | Analyse du livrable, audit du dépôt, branche `feat/refonte-tracky-v2`, cette roadmap | 3 écarts relevés (maquettes absentes, prémisse Poppins périmée, kit déjà posé). Bloc A d'abord, bloc B à la livraison des `.dc.html`. Point de contrôle à chaque lot. |
| 2026-08-09 | Étape 0 | `DECISIONS.md` (10 décisions), `TOKENS.md`, `ICONS.md` · violet + bleu créés · `--accent-ink` clair corrigé · 22 fallbacks `Poppins` purgés | **Défaut d'accessibilité corrigé** : encre blanche sur accent en thème clair, 3,43:1 → 5,54:1. **Deux défauts d'outillage relevés** : `pnpm verify` ne se termine pas (`ng test` en watch, P1) et le `launch.json` parent servait un autre projet. Confirmation au pixel en attente : panneau navigateur non affiché. |
| 2026-08-09 | A1 | Rôle `DEPOT` + 4 permissions · `DEPOT_DEFAULTS` · modèle `Mission` + migration · `DepotScopeService` / `Guard` / décorateur · module + 3 endpoints · `DepotMissionDto` · isolation socket · gardes web · **12 tests d'isolation verts** | **Faille refermée** : 8 routes de `trip-analysis` servaient scores, carburant et coûts à un dépôt (gardées par `trips_view`, ouverte au rôle), + `/ai/status`. **Trou de conception refermé** : `clampPermissions` bornait au granter, pas à la cible — un `FLEET_ADMIN` pouvait ouvrir la flotte à un dépôt. **D11** : le modèle `Mission` migre en A1, sinon l'isolation ne compile pas. |
