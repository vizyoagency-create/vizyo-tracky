# Sprint 5 — Rapports & filtres v2 — PLAN (Phase 2)

> Suite de `ANALYSE.md`. Branche `feat/sprint-5-rapports-filtres`. LOCAL.
> Décisions validées : **`exceljs`** pour le super-rapport Excel ; refonte **UX** des filtres (on garde l'archi signaux + `DateRangePicker` + filtre groupe existants).

## Ordre d'implémentation (commits atomiques)
1. **Sécurité — scope périmètre user** (back) → c'est le socle, à faire d'abord.
2. **Filtre groupe fiabilisé** (back+front, réutilise #1).
3. **Période** (auto-fill + cohérence) (front).
4. **Refonte filtres UX** (front).
5. **KPIs cliquables + tri** (front).
6. **Export Excel `exceljs`** (back+front) — le gros morceau.

---

## 1. 🔒 Sécurité — scoper les rapports au périmètre véhicules (le point clé)

**Problème (cf ANALYSE §4)** : `/reports/stats`, `/trips`, `/csv`, et le futur `/excel` scopent par `fleetId`, pas par les **véhicules accessibles** de l'user → un VIEWER scopé groupe verrait toute la flotte.

**Fix** : brancher `VehicleAccessService.getAccessibleVehicleIds(user)` comme **borne par défaut** :
- Si `=== 'ALL'` (FLEET_ADMIN/SUPER_ADMIN) → comportement actuel (toute la flotte).
- Sinon (liste de véhicules) → **intersecter** le `where` des requêtes trips/stats/export avec ces IDs, ET **rejeter** tout `vehicleId`/`groupId` demandé hors de ce périmètre (403/400, pas juste « hors flotte »).
- Endpoints concernés : `reports.controller` (stats/csv/pdf/excel) + `trips.controller` (`GET /trips`, `GET /trips/daily-summary`).
- **Tests IDOR** : un user scopé groupe G1 ne récupère QUE les véhicules de G1 (stats, trips, csv, excel) ; un `vehicleId` hors G1 → refus. Mock du `VehicleAccessService`.

> Risque maîtrisé : `getAccessibleVehicleIds` est mémoïsé par requête + déjà utilisé ailleurs. Pas de N+1.

---

## 2. Filtre groupe (réutilise S1)
- **Front** : le `selectedGroupId` existe déjà → fiabiliser (sélecteur scopé aux groupes que l'user peut voir, via `GET /vehicle-groups` déjà scopé). Réutiliser `GroupBadgeComponent`. Le filtre envoie les `vehicleIds` du groupe (déjà le cas).
- **Back** : le scope (#1) garantit qu'un groupe hors périmètre est rejeté.
- Pas de nouveau modèle (S1 réutilisé tel quel).

---

## 3. Période — auto-fill + cohérence (front)
- **Existant gardé** : blocage futur + max 365 j (`applyCustomRange`).
- **Ajout** : quand « à partir de » est saisi et « jusqu'à » vide → auto-remplir « jusqu'à » = **aujourd'hui** (borné), ou `from + 30j` si < aujourd'hui (choix : aujourd'hui, plus intuitif). Réciproquement, si `from > to` → corriger/avertir (message clair).
- **Cohérence** : `from ≤ to ≤ now`. Centraliser la validation dans un petit helper testable (`reports.utils`).
- Tests unitaires sur la logique (auto-fill, no-future, from>to).

---

## 4. Refonte filtres UX (front)
- **Barre de filtres compacte** (Groupe · Véhicule · Période) mobile-first, application **immédiate** (déjà le cas via les `onSelect*`), **reset** facile (bouton « Réinitialiser » → all/all/7j).
- **Defaults sensés** : période 7 j (déjà), tous véhicules. (Pas de persistance localStorage pour rester simple — option future.)
- **Mobile** : la barre passe en pile, le `DateRangePicker` garde le fallback input natif. Ne pas casser le chargement trips/KPIs/charts/replay.
- Réutiliser le design system (tokens CSS, dropdowns existants).

---

## 5. KPIs cliquables + tri (front, client-side)
- **Tri tableau** : clic sur en-têtes (Départ, Durée, Distance, V.moy, **V.max**) → `sortBy`/`sortDir` signaux → `sortedTrips()` computed (tri en mémoire sur ~100 trajets, zéro serveur). Indicateur visuel (flèche) + affordance (curseur pointer).
- **KPI « Vitesse max » cliquable** : `(click)` → set `sortBy='maxSpeed'`, `sortDir='desc'` → scroll vers le tableau + **highlight** de la 1ʳᵉ ligne (le trajet à la vitesse max) qq secondes. Affordance : la carte KPI devient cliquable (hover, curseur, petite icône).
- Étendre le pattern aux autres KPIs si pertinent (Distance → tri distance).
- Tests : la fonction de tri (ordre stable, asc/desc) + le mapping KPI→colonne.

---

## 6. 📊 Export Excel `exceljs` — super-rapport PAR VÉHICULE (le gros morceau)
- **Dépendance** : ajouter `exceljs` (pur JS) à `apps/api`.
- **Endpoint** : `POST /api/reports/excel` body `{ vehicleId, from, to }` (par véhicule) — `@Roles` cohérent + scope #1 (le `vehicleId` doit être dans le périmètre). Stream Buffer (comme le PDF).
- **Service** `ReportExcelService` : réutilise `reports-stats.compute` (KPIs) + `Trip.findMany({vehicleId, startedAt∈[from,to]}, capé)` — pas de nouveau calcul, **pas de positions brutes** (le full-scan dangereux).
- **Structure du classeur** (mise en forme pro) :
  - **Feuille « Synthèse »** : en-tête (plaque, marque/modèle, période), KPIs (nb trajets, distance totale, durée totale, vitesse moy/max, conso estimée), stylés (titres, bordures, formats nombre/durée).
  - **Feuille « Trajets »** : 1 ligne/trajet — départ, arrivée, durée, distance, V.moy, V.max, conducteur, notes. En-tête gelé, largeurs, formats, lignes alternées, total en bas.
  - **Feuille « Par jour »** : daily-summary (date, nb trajets, km, durée, V.max) — base d'un mini-graphe lisible.
- **Nommage** : `tracky-{plaque}-{from}_{to}.xlsx`.
- **Front** : bouton « Export Excel » (à côté de PDF/CSV), **feedback spinner** (`exporting` signal), `triggerDownload` existant. Désactivé si aucun véhicule sélectionné (l'export est par véhicule).
- **Perf** : borné à 1 véhicule + trajets capés ; génération Buffer en mémoire (un véhicule = petit). Pas de positions. Risque faible.

---

## 7. Fichiers touchés (prévision)
**Back** : `reports.controller.ts` (+ `/excel`, scope), `reports-stats.service.ts` (scope), `trips.controller.ts`/`trips.service.ts` (scope), nouveau `report-excel.service.ts`, `reports.module.ts`, `vehicle-access.service.ts` (réutilisé), `package.json` (+exceljs), specs (scope IDOR, excel).
**Front** : `reports.component.ts` (filtres UX, période, tri, KPI cliquable, bouton Excel), `reports.utils.ts` (helpers période + tri, tests), `reports.service.ts` (web, +`downloadExcel`), réutilise `DateRangePicker`/`GroupBadge`.
**Shared** : DTO si besoin (excel request).

## 8. Plan de test
- **Scoping IDOR** (prioritaire) : user scopé groupe → stats/trips/csv/excel limités à ses véhicules ; vehicleId/groupId hors périmètre → refus. (jest, Prisma + VehicleAccessService mockés.)
- **Période** : auto-fill, no-future, from>to (unitaires `reports.utils`).
- **Tri** : ordre asc/desc stable, mapping KPI→colonne (unitaires).
- **Excel** : le service génère un Buffer non vide avec les 3 feuilles + colonnes attendues (mock data) ; le scope rejette un vehicleId hors périmètre.
- **Vérif** : `pnpm -w typecheck` + jest api + build web. Export testé sur une période réaliste (perf).

## 9. Points perf (signalés)
- ✅ KPIs/tri/KPI-cliquable = **client-side** (sur trajets déjà chargés) → zéro charge serveur ajoutée.
- ✅ Stats = SQL-pushed (existant). Export Excel = **1 véhicule, trajets capés, pas de positions** → faible.
- ⚠️ Ne JAMAIS inclure les positions brutes dans l'Excel (c'est le full-scan qui a saturé en S0). Si un jour demandé : capé + optionnel + warning.

---
**Phase 2 terminée. J'enchaîne la Phase 3 (implémentation), en commençant par le socle sécurité (#1).**
