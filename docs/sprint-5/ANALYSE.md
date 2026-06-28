# Sprint 5 — Rapports & filtres v2 — ANALYSE (Phase 1)

> Cartographie de l'existant (3 explorations) + ce qui se refond vs se réutilise + décisions.
> Branche `feat/sprint-5-rapports-filtres`. LOCAL. **Pas de criticité device** — lecture/UX/export.

---

## 0. Résumé exécutif — beaucoup existe déjà

| Objectif | État de l'existant | Verdict |
|---|---|---|
| #1 Refonte filtres UX | Filtres présents (groupe + véhicule + période) mais friction | **Refondre l'UX**, garder la mécanique |
| #2 Période auto-fill + no-future | **No-future + max 365j DÉJÀ codés** (`applyCustomRange`) ; auto-fill « jusqu'à » manquant | **Ajouter l'auto-fill** + cohérence |
| #3 Filtre groupe | **Filtre groupe DÉJÀ présent** (`selectedGroupId` → `vehicleIds`) | **Fiabiliser le scope** (cf §4 gap) |
| #4 KPIs cliquables + tri | **Aucun tri / aucun drilldown** aujourd'hui | **À construire** (client-side) |
| #5 Export Excel soigné | CSV (`papaparse`) + PDF (`pdfkit`) existent ; **PAS de vrai .xlsx** | **Ajouter `exceljs`** (le gros morceau) |

**3 décisions structurantes** : (a) on **garde l'archi filtres** (signaux, computed) et on refond l'UX ; (b) le **tri + KPI-cliquable se font côté client** (les trajets sont déjà chargés, ~100) ; (c) le **« super rapport Excel »** = nouvelle lib **`exceljs`** + endpoint dédié, **par véhicule**, mis en forme (≠ le CSV brut existant).

---

## 1. Page Rapports (front) — `apps/web/.../features/reports/reports.component.ts` (~1700 l.)

- Standalone, **signal-based, OnPush**. Route `/reports` gardée par `permissionGuard('reports_view')`.
- **Filtres** : dropdown **Groupe** (`selectedGroupId`) → dropdown **Véhicule** (`selectedVehicleId`, options filtrées par groupe via `visibleVehicles()`) → **Période** (5 presets en dur + plage perso). Plage perso : `DateRangePickerComponent` (calendrier 2 mois desktop) / inputs natifs mobile.
- **Données** : `TripsApiService.list({vehicleId|vehicleIds, from, to, limit:100})` → `trips()` ; `.dailySummary(...)` → charts. KPIs calculés **côté client** depuis `trips()` via `aggregateKpis()` (`reports.utils.ts`).
- **KPIs** (cartes) : Trajets, Distance, Durée, **Vitesse max** (max des `trip.maxSpeed`, clampé). → **aucun lien KPI→trajet** (il faut retrouver le trajet à la main).
- **Tableau** : Départ/Arrivée/Durée/Distance/V.moy/V.max/Conducteur/Note/Replay. **Aucun tri.** `overflow-x-auto` (scroll horizontal mobile = friction).
- **Frictions identifiées** : pas de tri tableau, pas de drilldown KPI, pas de vrai Excel, tableau mobile en scroll, presets période non rafraîchis après minuit (mitigé avant export).

**À garder** : `aggregateKpis` (défensif, testable), `DateRangePickerComponent`, `GroupBadgeComponent`, l'état signaux. **À refondre** : l'ergonomie (defaults, application rapide, tri, mobile).

---

## 2. Backend — `apps/api/src/reports/`

- **Endpoints** (`reports.controller.ts`) : `GET /stats` (KPIs agrégés `FleetStatsReport`), `GET/POST /pdf` (pdfkit, sections configurables), `GET /csv?type=positions|trips|alerts|commands` (papaparse), `GET /speed-analysis/:tripId`.
- **Trips** : modèle Prisma `Trip` (maxSpeed, avgSpeed, distanceKm, durationSeconds, polyline…). Segmentation **live** (`trips.service`) + **recompute** batch (`trip-segmenter`). Indexes `Trip[fleetId, startedAt]`, `[vehicleId, startedAt]`.
- **KPIs** : `reports-stats.service` — **agrégations SQL-pushed** (`Trip.aggregate` + `groupBy`), recent trips capés (30–500). (Perf fix V1.10 déjà appliqué.)
- **Données trajets liste** : `GET /trips` (`trips.service` front) — c'est la **source du tableau + des KPIs côté client**.

---

## 3. Groupes (S1) — réutilisation

- `VehicleGroup` (scopé `fleetId`) + `VehicleGroupAssignment` (M2M). `GET /vehicle-groups` (scopé tenant via `resolveTenantScope`).
- **Le filtre groupe existe déjà sur Rapports** : `selectedGroupId` filtre `visibleVehicles()` et envoie les `vehicleIds` du groupe à l'API. Sur `/vehicles`, le filtre groupe est **client-side** (`groupFilter` signal + `groupOptions` computed) — réutilisable comme pattern UI.
- Helper backend `VEHICLE_GROUP_SELECT` / `vehicleGroupOf()` (`common/vehicle-group.ts`) — déjà utilisé dans les exports CSV (colonne « group »).
- **Accès scopé** : `VehicleAccessService.getAccessibleVehicleIds(user)` résout les véhicules permis (ALL / GROUP→véhicules / VEHICLE) via `UserVehicleAccess`. **C'est l'outil à brancher** pour scoper le filtre groupe au périmètre user.

---

## 4. Scoping tenant + ⚠️ GAP à vérifier/corriger

- **Tenant (flotte)** : solide. `resolveTenantScope` fail-closed (non-SUPER_ADMIN sans fleetId ⇒ DENY). `reports-stats.compute` refuse si `requestedBy.fleetId ≠ fleetId` (403) et **valide que les `vehicleIds` appartiennent à la flotte** (anti-IDOR sur le paramètre).
- ⚠️ **GAP périmètre user (per-vehicle/group)** : les rapports scopent par **`fleetId`**, pas par les **véhicules accessibles** de l'utilisateur. Donc un **VIEWER scopé à un groupe** qui a `reports_view` pourrait voir/exporter **toute la flotte** (pas seulement ses groupes) s'il ne passe pas de `vehicleIds`. **L'objectif #3 exige le contraire** (« un user scopé groupe ne filtre que ses groupes »). → **À corriger** : appliquer `getAccessibleVehicleIds(user)` comme borne par défaut sur `/reports/stats`, `/trips`, `/csv` et le futur `/excel` (si ≠ ALL ⇒ intersecter le where avec les véhicules permis). **C'est le point sécurité du sprint** (à confirmer côté `/trips` aussi).

---

## 5. Export — CSV+PDF existent, le « soigné Excel » = `exceljs` (nouveau)

- **Existant** : `report-csv.service` (papaparse, `;` + BOM, caps 50–100k + suffixe `-PARTIEL`) ; `report-pdf.service` (pdfkit, sections). Front : `triggerDownload(blob)` (ancre). Deps : `papaparse@5.5.3`, `pdfkit@0.18.0`. **Pas de `xlsx`/`exceljs`.**
- **Pour le #5 (Excel soigné, visuel, par véhicule)** : le CSV est un **dump brut** (≠ « soigné »), le PDF n'est pas éditable. → **Ajouter `exceljs`** (pur JS, pas de dépendance native) :
  - Nouvel endpoint **`POST /reports/excel`** (ou GET), **par véhicule** (1 véhicule + période → 1 `.xlsx` soigné).
  - **Structure** : feuille **Synthèse** (KPIs : distance, durée, vitesses, nb trajets, conso estimée — réutilise `reports-stats`/`compute`) + feuille **Trajets** (1 ligne/trajet, colonnes formatées : durée, km, vitesses, conducteur, notes) + feuille **Par jour** (daily-summary).
  - **Mise en forme** : en-têtes stylés, largeurs de colonnes, formats nombre/durée, gel de l'en-tête, total. Nommage `tracky-{plaque}-{from}_{to}.xlsx`.
  - **Réutilise** la donnée existante (`reports-stats.compute` + `Trip.findMany` capé) — pas de nouveau calcul.

---

## 6. Objectif par objectif — refondre vs réutiliser

1. **Filtres UX** : *garder* l'archi signaux + `DateRangePicker` + le filtre groupe ; *refondre* l'ergonomie (barre de filtres compacte, defaults, application immédiate, reset, mobile).
2. **Période** : *réutiliser* la validation no-future/max-365 ; *ajouter* l'auto-fill « jusqu'à » (ex. = today, ou from+30j borné à today) + message clair si début>fin.
3. **Filtre groupe** : *réutiliser* le `selectedGroupId` existant + `GroupBadge` ; *corriger* le scope (§4) + (option) un vrai sélecteur de groupe scopé.
4. **KPIs cliquables + tri** : *construire* — tri client-side du tableau (clic en-têtes, `sortBy`/`sortDir`) + KPI « Vitesse max » cliquable → tri par `maxSpeed` desc + scroll/highlight de la 1ʳᵉ ligne. Affordance visible (curseur, icône).
5. **Excel soigné** : *construire* avec `exceljs` (§5), réutiliser `reports-stats` + `Trip`.

---

## 7. Risques

1. **Perf / volume (rappel S0)** : l'export Excel **par véhicule** est borné (trajets d'1 véhicule sur la période, capé) → faible risque. **Éviter** d'inclure les positions brutes (c'est le full-scan dangereux — le garder optionnel/capé si demandé). Les KPIs sont SQL-pushed (OK). Le tri/KPI-cliquable sont **client-side** (sur ~100 trajets déjà chargés) → zéro charge serveur.
2. **Scoping (§4)** : le vrai risque sécu du sprint = ne pas oublier de borner les rapports/exports au **périmètre véhicules** de l'utilisateur (pas juste la flotte). Tests d'IDOR à ajouter (un VIEWER scopé groupe ne récupère que ses véhicules).
3. **Ne pas casser l'existant** : la page Rapports est grosse (~1700 l.) ; refondre les filtres sans casser le chargement trips/KPIs/charts/replay. Refonte incrémentale + vérifs.
4. **`exceljs`** : nouvelle dépendance (poids ~1 Mo, pur JS) — OK, pas de natif. Générer en Buffer + stream (comme le PDF).

---

## 8. Mécanisme d'export retenu
**`exceljs`** côté backend, nouvel endpoint **par véhicule**, réutilisant `reports-stats.compute` + `Trip.findMany` (capé, scopé périmètre). Front : bouton « Export Excel » + feedback (spinner), `triggerDownload` existant. Le CSV/PDF restent.

---

**Phase 1 terminée.** Prochaine étape : `PLAN.md` (refonte filtres détaillée, logique période, correction scope #4, tri/KPI-cliquable, conception des feuilles Excel + perf, fichiers touchés, plan de test). Je peux enchaîner — **le point à valider avec toi = la décision `exceljs` (vrai .xlsx soigné) vs rester sur le CSV**, et le **périmètre de la refonte filtres** (jusqu'où on pousse l'UX).
