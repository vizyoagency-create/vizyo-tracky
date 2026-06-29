# Sprint 8 — Réservation & optimisation de flotte — PLAN

> **Phase 2 (plan).** S'appuie sur `ANALYSE.md` (Phase 1, validée). Détaille les extensions
> de schéma, le modèle de réservation + conflits, la dérivation dispo, l'auto-complétion, la
> prévision, le dashboard, les fichiers touchés, le plan de test et la perf. **Livraison par
> paliers, relue à chaque palier.**

Branche : `feat/sprint-8-reservation-optimisation`.

---

## 0. Décisions validées (STOP Phase 1)

1. **Flux = Demande → validation.** Un user `reservations_request` dépose une demande (`REQUESTED`, non bloquant) dans son périmètre ; un user `reservations_manage` valide (`CONFIRMED`, bloquant) / refuse / édite / annule. Un manager peut créer directement en `CONFIRMED`.
2. **Permissions granulaires dédiées** (nouvelles), défaut **super + fleet admin** (qui gèrent aussi les perms users), accordables par user :
   - `reservations_view` — voir réservations & disponibilités.
   - `reservations_request` — demander une réservation.
   - `reservations_manage` — valider / refuser / éditer / annuler / supprimer / auto-affecter.
   *(Granularité bundle dans `manage` = valider+éditer+annuler+supprimer+auto-affecter. Si tu veux scinder `delete` plus tard, c'est extensible — on reste à 3 perms pour l'instant.)*
3. **Statuts** : `VehicleEventStatus += REQUESTED, CONFIRMED`. Bloquant = `CONFIRMED` + `IN_PROGRESS`.
4. **Véhicule** : `seats Int?`, `childSeats Int?`, `features String[]`.
5. **Conflit** : `btree_gist` + contrainte EXCLUDE (race-proof) + pré-check 409.
6. **Prévision = dérivée** (non stockée, non bloquante).

---

## 1. Extensions de schéma & migrations

### Migration A (Palier A) — `add_vehicle_characteristics`
```prisma
model Vehicle {
  // … existant …
  seats      Int?       // capacité passagers
  childSeats Int?       // nb sièges enfants / pouponnière
  features   String[]   @default([])  // tags équipement extensibles
}
```
SQL : `ALTER TABLE vehicles ADD COLUMN "seats" INT, ADD COLUMN "childSeats" INT, ADD COLUMN "features" TEXT[] DEFAULT '{}';`

### Migration B (Palier B) — `add_reservation_status_and_exclusion`
```sql
ALTER TYPE "VehicleEventStatus" ADD VALUE 'REQUESTED';
ALTER TYPE "VehicleEventStatus" ADD VALUE 'CONFIRMED';
-- (ADD VALUE hors transaction : précédent S7 AlertType OK sur PG16)
CREATE EXTENSION IF NOT EXISTS "btree_gist";
ALTER TABLE vehicle_events ADD CONSTRAINT no_overlap_reservation
  EXCLUDE USING gist ("vehicleId" WITH =, tsrange("startAt","endAt",'[)') WITH &&)
  WHERE ("type" = 'RESERVATION' AND "status" IN ('CONFIRMED','IN_PROGRESS'));
```
> Prisma ne gère ni les valeurs d'enum ajoutées hors `schema.prisma`, ni les EXCLUDE → on déclare les 2 valeurs dans `schema.prisma` et on écrit la contrainte en **SQL brut** dans le fichier de migration.

### Permissions (pas de migration — `UserVehicleAccess.permissions` Json)
`packages/shared/src/permissions/permissions.ts` : ajouter les 3 constantes + les défauts super/fleet admin.

---

## 2. PALIER A — Visibilité (lecture seule, faible risque)

**Valeur : on *voit* l'activité réelle et la sous-utilisation immédiatement.**

### Backend
- **Caractéristiques véhicule** : migration A + `vehicle.dto` (seats/childSeats/features) + `vehicles.service` (expose + update via l'endpoint existant) + validation.
- **`availability.service.ts`** (nouveau, module agenda) :
  - `getVehicleActivity(user, from, to, vehicleIds?)` → par véhicule, les `trips` chevauchant la fenêtre (`startedAt < to AND endedAt > from`), projection minimale (id/startedAt/endedAt/distanceKm). Scope via `getAccessibleVehicleIds`.
- **`optimization.service.ts`** (nouveau) :
  - `getUtilization(user, period)` → `groupBy(vehicleId)` + agrégation par bucket **jour-de-semaine × tranche horaire** (matin/après-midi/soir), poussée en SQL. Retourne la heatmap + flags « sous-utilisé » (buckets systématiquement libres).
- **Endpoints** (controller agenda + nouveau `optimization.controller`), tous `@RequirePermissions('reservations_view')` :
  - `GET /agenda/availability?from&to[&vehicleIds]`
  - `GET /optimization/utilization?from&to`

### Frontend
- **Agenda — couche « activité réelle »** : `agenda.service` appelle `availability`; le calendrier affiche les trajets comme couche factuelle distincte (teinte neutre, non interactive). Légende mise à jour.
- **Vue « Disponibilité »** (onglet agenda ou section) : frise par véhicule (occupé d'après trajets / libre) sur la période visible.
- **Dashboard « Optimisation »** (nouvelle page + nav, gardé `reservations_view`) : heatmap utilisation (véhicule × bucket) + liste des véhicules sous-utilisés + opportunités de mutualisation.
- **Fiche véhicule** : édition `seats`/`childSeats`/`features` dans `vehicle-dialog` (chips pour features).

### Tests A
- `availability.service.spec` : overlap trajets (bornes), scoping (un user GROUP ne voit que son périmètre).
- `optimization.service.spec` : agrégation buckets correcte, flag sous-utilisé.
- Non-régression agenda S7.

---

## 3. PALIER B — Réservation + auto-complétion (cœur transactionnel)

### Backend
- Migration B (statuts + btree_gist + EXCLUDE).
- **`reservations.service.ts`** (nouveau, module agenda) :
  - `findOverlaps(vehicleId, from, to, excludeId?)` — extrait de l'overlap de `list()`. Réutilisé par dispo + conflit.
  - `request(user, dto)` — perm `reservations_request` ; scope (`assertVehicleAccess` si véhicule visé, sinon demande « ouverte » sur critères) ; crée `VehicleEvent type=RESERVATION status=REQUESTED`, `metadata={ requesterId, minSeats, minChildSeats, requiredFeatures, reason }`.
  - `suggest(user, slot, criteria)` — perm `reservations_view` ; véhicules **du périmètre** matchant critères (`seats≥`, `childSeats≥`, `features⊇`) **ET** libres (pas de réservation CONFIRMED/IN_PROGRESS chevauchante, pas de trajet chevauchant si créneau présent/passé) ; **triés en préférant les sous-utilisés** (réutilise `optimization.service`).
  - `confirm(user, id, vehicleId?)` — perm `reservations_manage` ; fixe le véhicule (depuis la suggestion), passe `CONFIRMED` ; pré-check `findOverlaps` → 409 ; capture l'erreur EXCLUDE (`23P01`) → 409 lisible.
  - `reject/cancel(user, id)` — perm `reservations_manage` → `CANCELLED`.
  - `update(user, id, dto)` — perm `reservations_manage` (édite créneau/critères, re-check conflit).
  - `list(user, filters)` — perm `reservations_view`, scopé ; vue « demandes en attente » = `status=REQUESTED`.
- **Débrancher** le rejet `RESERVATION` dans `vehicle-events.service.create()` (les réservations passent par `reservations.service`).
- **Endpoints** `reservations.controller` : `POST /reservations/request`, `GET /reservations/suggest`, `POST /reservations/:id/confirm|reject|cancel`, `PATCH /reservations/:id`, `GET /reservations`.

### Frontend
- **Modale « Demander un véhicule »** : créneau + critères (places, sièges enfants, équipements) → appelle `suggest` → liste des véhicules libres correspondants (avec badge « sous-utilisé ») → Demander / (si manage) Réserver directement.
- **File « Demandes en attente »** (vue manage) : `REQUESTED` → Valider (choix du véhicule suggéré) / Refuser.
- **Réservations dans l'agenda** : déjà bleu/type-agnostique → s'affichent ; bloc créneau (non all-day). Détail au clic (demandeur, critères, statut).
- **Anti-409** : UI gère le conflit (créneau déjà pris) avec message clair + re-suggestion.
- Gardes de perms (`perms.can('reservations_request'|'reservations_manage')`) sur les boutons.

### Tests B
- `reservations.service.spec` : `findOverlaps` bornes (inclus/exclus) ; **double-réservation refusée** (pré-check + simulation contrainte) ; scoping IDOR (request/confirm hors périmètre → 403) ; `suggest` ne renvoie que matchant+libre ; cohérence trajet réel (créneau chevauchant un trajet → bloqué/alerté).
- Test perms : `request` sans `reservations_request` → 403 ; `confirm` sans `reservations_manage` → 403.

---

## 4. PALIER C — Prévision / récurrence (intelligence, dérivée)

### Backend
- **`forecast.service.ts`** (nouveau) :
  - `getForecast(user, from, to)` → pour chaque véhicule du périmètre, analyse les `trips` des **N dernières semaines** (borné, ex. 10), `groupBy` **jour-de-semaine × tranche horaire** en **TZ flotte (Europe/Paris)** ; retient les motifs **consistants** (≥ seuil k/N) ; projette sur `[from,to]` comme `ForecastSlotDto { vehicleId, startAt, endAt, basis: "8/10 lundis", confidence }`.
  - **Jamais** d'écriture en base ; cache court (mémoire, clé scope+semaine).
- **Endpoint** : `GET /agenda/forecast?from&to` (perm `reservations_view`).

### Frontend
- **Couche « usage prévu »** dans l'agenda : créneaux **fantômes/pointillés**, teinte distincte, libellé « Usage habituel prévu » + base (« observé 8/10 lundis »). Toggle de visibilité. **Jamais cliquable comme une réservation.**
- Légende agenda finale : Maintenance · Incident · **Réservation (ferme)** · **Usage prévu (fantôme)** · Activité réelle.

### Tests C
- `forecast.service.spec` : détection récurrence (motif net détecté, bruit ignoré), **TZ** (lundi 10h local ≠ décalage UTC), **jamais bloquant** (un forecast chevauchant n'empêche pas une réservation, n'apparaît pas dans `findOverlaps`).

---

## 5. Fichiers touchés (synthèse)

**Shared** : `permissions/permissions.ts` (+3 perms) ; `dto/reservation.dto.ts`, `dto/availability.dto.ts`, `dto/forecast.dto.ts` (nouveaux) ; `dto/vehicle.dto.ts` (+characteristics) ; `index.ts` (exports).
**API** : `schema.prisma` (+champs, +statuts) ; migrations A & B ; `agenda/availability.service.ts`, `agenda/reservations.service.ts`, `agenda/forecast.service.ts`, `optimization/optimization.service.ts` + controllers + modules (nouveaux) ; `agenda/vehicle-events.service.ts` (débrancher rejet RESERVATION + extraire findOverlaps) ; `vehicles/vehicles.service.ts` (characteristics) ; specs.
**Web** : `core/services/agenda.service.ts` (+availability/forecast/reservations) ; `features/agenda/*` (couches activité/prévision, légende, filtre type) ; `features/optimization/*` (dashboard, nouveau) ; `features/reservations/*` (modale demande + file demandes, nouveau) ; `features/vehicles/vehicle-dialog` (characteristics) ; `features/users/access-permissions-matrix` (afficher les 3 perms) ; nav + routes + guards.

---

## 6. Performance (rappel + garanties)

- Dispo/activité : overlap `trips` borné par fenêtre + index `[vehicleId, startedAt]` → ~5-10 ms. **Pas de full-scan.**
- Dashboard : `groupBy` poussé en SQL, borné par période.
- Prévision : agrégation sur N semaines bornée + cache court ; **dérivée des `trips`** (conservés par S6), jamais des `positions` (purgées).
- Conflit : index dédié + contrainte EXCLUDE (la base tranche, pas l'app).
- Charge prod actuelle ~6,7k trajets → trivial ; le motif tient à l'échelle (CDEF & grosses flottes).

---

## 7. Séquencement & checkpoints

| Palier | Contenu | Risque | Checkpoint |
|---|---|---|---|
| **A** | Caractéristiques véhicule + activité/dispo agenda + dashboard optimisation | Faible (lecture) | **Relecture A** avant B |
| **B** | Statuts + contrainte + reservations.service + auto-complétion + UI demande/validation + perms | Moyen (transactionnel) | **Relecture B** avant C |
| **C** | Moteur prévision dérivé + rendu fantôme | Moyen (algo) | **Relecture C** finale |

À chaque palier : commits atomiques (`feat:`/`test:`/`docs:`), `pnpm typecheck` + jest + `ng build` verts, **pas de merge** (branche prête pour relecture). Recap court à chaque fin de palier.

---

## 8. Definition of Done (rappel brief)
- [ ] Modèle S7 étendu proprement (extensions ci-dessus, signalées).
- [ ] Agenda : dispo/activité réelle (trajets).
- [ ] Réservation créneau + critères, calée dans l'agenda, **conflits gérés** (EXCLUDE + 409 + cohérence trajets).
- [ ] Auto-complétion : véhicule libre matchant critères + dispo.
- [ ] Prévision détectée + affichée, **distincte d'une réservation ferme**, jamais bloquante.
- [ ] Dashboard optimisation/mutualisation (sous-utilisés).
- [ ] Scoping tenant strict + 3 perms granulaires, pas d'IDOR.
- [ ] Perf bornée + cohérence S6.
- [ ] `ANALYSE.md` + `PLAN.md` + tests.
- [ ] Branche prête pour relecture.
