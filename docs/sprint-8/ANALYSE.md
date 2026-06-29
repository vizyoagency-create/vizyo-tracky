# Sprint 8 — Réservation & optimisation de flotte — ANALYSE

> **Phase 1 (analyse).** Vérifie l'adéquation du modèle d'événement générique S7 pour la
> réservation, cartographie la dérivation dispo/activité depuis les trajets, pose le modèle
> de réservation + conflits + prévision, et liste perf & risques. **Aucune ligne de code
> produit avant validation (STOP).**

Branche : `feat/sprint-8-reservation-optimisation` (depuis `main` @ 446baca, S7 mergé).

---

## 0. Verdict express

| Question | Réponse |
|---|---|
| Le modèle `VehicleEvent` (S7) tient-il pour la réservation ? | **OUI**, sans refonte. `startAt/endAt/allDay` = créneau, `metadata` = critères, `createdBy` = demandeur, index `[vehicleId, startAt]` = base des conflits. |
| Faut-il l'étendre ? | **OUI, à la marge** : 2 valeurs de statut (`REQUESTED`, `CONFIRMED`), 3 champs véhicule (`seats`, `childSeats`, `features`), 1 extension Postgres (`btree_gist`) + 1 contrainte anti-chevauchement. **Aucune table nouvelle.** |
| La prévision (usage habituel) est-elle un événement ? | **NON** — c'est une **projection dérivée des trajets**, jamais stockée, jamais bloquante. Séparation ferme/prévu structurelle. |
| Risque sur la rétention S6 ? | **Aucun** : S6 ne purge que `positions`. Les `trips` (source de la dispo ET de la prévision) sont **conservés** → fiable dans le temps. |

---

## 1. Adéquation du modèle d'événement S7 (+ ce qu'il faut ajouter)

### 1.1 Ce qui existe déjà et suffit (rien à faire)
- `VehicleEvent.type` inclut **`RESERVATION`** (stub S7) — *(schema.prisma:365)*.
- `startAt` + `endAt` + `allDay=false` = **créneau de réservation** (ex. 15/07 08:00→18:00) — *(393-395)*.
- `metadata Json?` = **critères + demandeur + motif** sans migration — *(403)*.
- `createdBy String` = **qui réserve** (User.id) ; `source` = MANUAL/AUTO/SYSTEM — *(405-406)*.
- Index `[vehicleId, startAt desc]`, `[fleetId, type, startAt]`, `[fleetId, status]` = **base des requêtes de conflit/dispo** — *(412-414)*.
- Front agenda **déjà type-agnostique** : `eventColor()` mappe `RESERVATION → bleu (#38BDF8)` et `eventTypeLabel() → « Réservation »` *(agenda.utils.ts)*. Le calendrier itère `eventColor()` → **aucune refonte de rendu**.
- `create()` **rejette** aujourd'hui `type=RESERVATION` *(vehicle-events.service.ts:144 « Les réservations seront gérées au Sprint 8 »)* → **à débrancher en S8**.
- Scoping anti-IDOR **réutilisable tel quel** : `assertVehicleAccess`, `scopedWhere`, `groupVehicleIds`, `VehicleAccessService.getAccessibleVehicleIds() → 'ALL'|string[]`.

### 1.2 Extensions nécessaires (signalées, comme imposé)

**(E1) Statuts de réservation — `VehicleEventStatus += REQUESTED, CONFIRMED`.**
Réutiliser PLANNED/OPEN serait piégeux : la logique agenda S7 « en retard = status PLANNED & startAt < now » compterait une réservation passée comme un entretien en retard. On isole donc le cycle réservation :

```
REQUESTED  → (non bloquant) une demande déposée, en attente de validation
CONFIRMED  → (BLOQUANT)     réservation ferme, occupe le véhicule
IN_PROGRESS→ (BLOQUANT)     créneau en cours (le véhicule est pris maintenant)
DONE       →               créneau terminé
CANCELLED  →               annulée / refusée
```
« Bloquant » = compte dans les conflits et la dispo. `REQUESTED` ne bloque pas (c'est une demande, pas un engagement).

**(E2) Caractéristiques véhicule — 3 champs sur `Vehicle`.** Aucun critère n'existe aujourd'hui *(schema.prisma:316-356 : ni places, ni sièges enfants, ni équipement)*.
```prisma
seats     Int?       // nb de places (capacité passagers)
childSeats Int?      // nb de sièges enfants / pouponnière disponibles
features  String[]   // équipements, tags libres extensibles : ["wheelchair","ac","gps","towbar","fridge"…]
```
Match critères = `seats ≥ minSeats` ∧ `childSeats ≥ minChildSeats` ∧ `features ⊇ requiredFeatures`. Lean, extensible (features = tableau ouvert), éditable depuis la fiche véhicule (réutilise `vehicle-dialog`).

**(E3) Anti-double-réservation au niveau base — `btree_gist` + contrainte EXCLUDE.**
`btree_gist` **n'est pas activé** *(seuls pgcrypto/postgis/uuid-ossp le sont, migration init:1-9)*. On l'active et on pose une contrainte d'exclusion **race-proof** :
```sql
CREATE EXTENSION IF NOT EXISTS "btree_gist";
ALTER TABLE vehicle_events ADD CONSTRAINT no_overlap_reservation
  EXCLUDE USING gist ("vehicleId" WITH =, tsrange("startAt","endAt",'[)') WITH &&)
  WHERE ("type" = 'RESERVATION' AND "status" IN ('CONFIRMED','IN_PROGRESS'));
```
Garantit qu'**aucun** chevauchement de réservation ferme sur un même véhicule ne peut être inséré, **même en concurrence**. Doublé d'un **pré-check applicatif** (`findOverlaps`) pour renvoyer un **409 lisible** avant de toucher la base.

**(E4) Méthode `findOverlaps(vehicleId, from, to, excludeId?)`** — extraite de la clause d'overlap déjà présente dans `list()`. Cœur du conflit + de la dispo.

**(E5) Permissions — `reservations_view` + `reservations_manage`** (mêmes conventions que S7 : défaut super+fleet admin, **accordables par user** dans l'espace permissions). `view` = voir réservations & dispo + **déposer une demande** dans son périmètre ; `manage` = **confirmer/refuser/annuler/auto-affecter**.

> **Pas de nouvelle table.** Réservation = `VehicleEvent type=RESERVATION`. Prévision = dérivée (voir §4).

---

## 2. Dérivation disponibilité / activité (depuis les trajets)

**Source = `Trip`** *(schema.prisma:562-608)* : `vehicleId, fleetId, startedAt, endedAt, durationSeconds, distanceKm, driverId`, index `[vehicleId, startedAt desc]`, `[fleetId, startedAt desc]`.

- **Activité réelle** d'un véhicule sur une fenêtre = les trajets qui la chevauchent :
  `startedAt < to AND endedAt > from` → index `[vehicleId, startedAt]`, **~5-10 ms**, borné.
- **Dispo d'un créneau** = (aucune réservation **CONFIRMED/IN_PROGRESS** chevauchante) **ET** (pour maintenant/passé : aucun trajet chevauchant). Un créneau **futur** ne peut pas chevaucher un trajet (il n'existe pas encore) → seules les réservations comptent.
- **Vue agenda enrichie** = 3 couches distinctes par véhicule/jour :
  1. **Activité réelle** (trajets) — « a roulé de 9h à 11h » (couche factuelle).
  2. **Réservations fermes** (bleu, bloquant).
  3. **Usage prévu** (fantôme/pointillé, dérivé, non bloquant — §4).
  → on **voit** immédiatement les créneaux libres.

Agrégation utilisation (dashboard) : `groupBy(vehicleId)` + buckets jour-de-semaine × tranche horaire, **poussée en SQL** (motif déjà en place dans `reports-stats.service.ts:192-204`). Bornée par une période (ex. 4-8 semaines).

---

## 3. Modèle de réservation + gestion des conflits

### 3.1 Cycle de vie & rôles
- **Demande** (objectif 2) : un user `reservations_view` dépose une demande (créneau + critères) dans **son périmètre** → `REQUESTED` (non bloquant).
- **Auto-complétion** (objectif 3) : à partir du créneau + critères, le système **propose les véhicules libres correspondants** (match critères ∧ dispo), triés en **préférant les sous-utilisés** (sert la mutualisation).
- **Confirmation** : un user `reservations_manage` confirme (→ `CONFIRMED`, **bloque**) ou refuse (`CANCELLED`). Un admin peut aussi créer directement en `CONFIRMED` (réservation + auto-suggestion en un geste).
- **Cycle** : `IN_PROGRESS` au début du créneau, `DONE` à la fin (transitions douces, non bloquantes pour le MVP — peuvent rester manuelles ou via un cron léger).

### 3.2 Conflits (robustes)
- **Double-réservation** : impossible par construction (contrainte EXCLUDE E3) + pré-check 409 lisible (E4).
- **Cohérence trajets réels** : à la confirmation, si un **trajet réel** chevauche déjà le créneau (véhicule effectivement pris), on **bloque/alerte** (incohérence). Pour le futur, pas de trajet → pas de conflit trajet.
- **Prévision ≠ blocage** : un usage *prévu* (§4) chevauchant n'empêche **jamais** une réservation — il est affiché comme **avertissement informatif** (« ce véhicule roule habituellement à ce créneau »), pas comme conflit.

---

## 4. Prévision / récurrence — approche « ferme vs prévu »

**Choix de conception : la prévision est DÉRIVÉE, pas un événement stocké.**

- Un moteur calcule, à partir de l'**historique de trajets** (N dernières semaines), les **motifs récurrents** : `groupBy(vehicleId, jour-de-semaine, tranche-horaire)` → un motif est retenu s'il est **consistant** (ex. ≥ k occurrences sur N semaines au-dessus d'un seuil). Projeté sur la fenêtre visible comme **créneaux fantômes**.
- **Jamais stocké comme `VehicleEvent`, jamais bloquant** : la prévision n'est pas un objet réservable → **impossible de la confondre** avec une réservation ferme ou de bloquer un véhicule dessus (exigence forte du brief satisfaite *structurellement*).
- **Rendu agenda distinct** : pointillé/fantôme + libellé « Usage habituel prévu » + la **base** (« observé ~8 lundis sur 10 »). Couleur/teinte différente des réservations.
- **Pourquoi dérivé plutôt que matérialisé** : toujours frais (pas de churn de cron générant/nettoyant des événements), borné/cacheable, et la séparation ferme/prévu est garantie par le type même (un `ForecastSlotDto`, pas un `VehicleEvent`).
- **Fuseau horaire** : le bucketing « tous les lundis 10h » doit utiliser le TZ de la flotte (Europe/Paris), pas l'UTC brut — sinon décalage. À cadrer dans le PLAN.

---

## 5. Tableau de bord d'optimisation / mutualisation (objectif 5)

- **Heatmap d'utilisation** : véhicule (lignes) × bucket jour-de-semaine/tranche horaire (colonnes), intensité = taux d'occupation (trajets+réservations) sur la période. On **voit** d'un coup les zones froides.
- **Sous-utilisation** : véhicules avec des buckets systématiquement libres (« libre tous les matins ») mis en avant + **opportunités de mutualisation** (« le 344 est libre chaque matin, le 212 chaque après-midi → mutualisables »).
- Aide à la décision, **lecture seule** (faible risque) → idéal pour le **palier A** avec l'objectif 1.

---

## 6. Performance

- Toutes les requêtes trajets sont **bornées** (fenêtre temporelle + index `vehicleId`/`fleetId`) — **pas de full-scan**. Volume prod ~6,7k trajets → trivial, mais le motif tient à l'échelle.
- Dispo créneau = `findFirst` overlap → ~5-10 ms. Agenda d'une semaine/mois = `findMany` borné.
- Prévision = agrégation sur N semaines (bornée) + cache court. Dashboard = `groupBy` poussé en SQL.
- **Cohérence S6** : `data-retention.service.ts` ne purge que `positions` (cité : `DELETE FROM positions …`) → `trips` conservés → dispo & prévision **fiables long terme**. Une prévision ne s'appuie jamais sur des positions (purgées) mais sur des trajets (persistants).

---

## 7. Risques & parades

| Risque | Parade |
|---|---|
| Prisma ne modélise pas les contraintes EXCLUDE | Migration **SQL brute** (précédent : ALTER TYPE en S7) + capture de l'erreur DB → 409. |
| Concurrence (2 confirmations simultanées) | Contrainte EXCLUDE = garde **base** race-proof (le pré-check seul ne suffit pas). |
| Fuseau horaire sur la récurrence | Bucketing en TZ flotte (Europe/Paris), pas UTC. |
| Prévision = heuristique (faux positifs) | Seuils conservateurs + libellé « prévu » + base affichée ; **jamais** bloquante. |
| Scope creep (5 objectifs) | **Livraison par paliers** A (visibilité, lecture seule) → B (réservation+auto) → C (prévision). |
| IDOR réservations | `getAccessibleVehicleIds` + `fleetId` **dérivé du véhicule** (jamais du client), comme S5/S7. Un user ne réserve/voit que dans son périmètre. |
| Ne rien casser (agenda S7) | Réservations = nouveau type sur le modèle existant ; rendu déjà type-agnostique ; tests de non-régression agenda. |

---

## 8. Séquencement proposé (paliers)

- **Palier A — Visibilité** (obj. 1 + 5) : dispo/activité réelle dans l'agenda + dashboard d'optimisation. **Lecture seule, faible risque, valeur immédiate.** Champs véhicule (E2) inclus ici (édition fiche).
- **Palier B — Réservation** (obj. 2 + 3) : statuts (E1) + contrainte (E3) + `findOverlaps` (E4) + perms (E5) + auto-complétion. **Cœur transactionnel.**
- **Palier C — Intelligence** (obj. 4) : moteur de prévision dérivé + rendu fantôme.

Relecture **palier par palier** possible plutôt qu'en big-bang.

---

## 9. Extensions à valider AVANT de coder (récap STOP)

1. **Statuts** : ajouter `REQUESTED` + `CONFIRMED` à `VehicleEventStatus`. *(ou réutiliser PLANNED/OPEN — déconseillé : collisions sémantiques agenda)*
2. **Véhicule** : ajouter `seats`, `childSeats`, `features[]`.
3. **Conflit** : activer `btree_gist` + contrainte EXCLUDE (anti-double-réservation race-proof).
4. **Prévision** : **dérivée** (non stockée, non bloquante) — pas de type `USAGE_FORECAST` en base.
5. **Permissions** : `reservations_view` / `reservations_manage` (défaut super+fleet admin, accordables).
6. **Approche** : réservation **ferme** = `VehicleEvent` ; **prévision** = projection dérivée des trajets. Séparation structurelle.
