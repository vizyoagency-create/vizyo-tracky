# V1.16 — Gestion du parc SIM + intégration WhereverSIM

Espace de gestion des cartes SIM M2M dans Tracky, piloté par l'**API GraphQL WhereverSIM**.
Le super admin gère tout le parc ; le fleet admin voit ses SIM et les assigne à ses trackers.

## Objectif

Tracky devient le poste de pilotage unique du parc SIM (au lieu du dashboard fournisseur) :
inventaire, statut opérateur, conso data, cycle de vie, SMS — le tout relié aux trackers/flottes.

## Rôles & permissions

| Action | Qui |
|---|---|
| Voir le parc (scopé à sa flotte) + conso/événements | `sims_view` (FLEET_ADMIN/SUPER_ADMIN bypass ; délégable à manager/viewer) |
| Assigner / détacher une SIM d'un tracker | `sims_assign` (idem) |
| Sync, allocation flotte, cycle de vie, plafond data, SMS, create/delete | **SUPER_ADMIN** uniquement |

Les permissions `sims_view` / `sims_assign` sont ajoutées à `@vizyo/tracky-shared` ; la matrice de
permissions du web les rend automatiquement (groupe « Cartes SIM »).

## Architecture

```
WhereverSIM (GraphQL)  ──listSims/updateSim/…──►  WhereverSimClient
                                                        │
                                       SimsSyncService (cron 30min + manuel)
                                                        │  upsert par iccid (champs miroir only)
                                                        ▼
                                   table `sims` (cache miroir + couche Tracky)
                                                        │
                                              SimsService / SimsController
                                                        │
                              ┌─────────────────────────┴───────────────────────┐
                         /admin/sims (super admin)                       /sims (flotte)
```

- **`Sim`** = miroir des champs WhereverSIM (`statusId` brut, `msisdn`, `imsi`, `imei`, conso, `apn`,
  `ipAddress`, `customField1`…) **+** couche Tracky : `fleetId` (allocation société), `trackerId`
  (assignation 1:1). Le sync n'écrase **jamais** `fleetId`/`trackerId`/`label`/`notes`.
- **Assignation** (cœur) : recopie `msisdn` → `Tracker.simPhoneNumber`, réémet l'event
  `tracker.sim-changed` (resync allowlist vizyo-texto, infra existante), et écrit l'IMEI du tracker
  dans `custom_field_1` côté WhereverSIM (lien bidirectionnel, best-effort). Auto-allocation de la
  flotte si on pose une SIM « en stock » sur un tracker déjà rattaché à une flotte.
- **Détachement** : ne vide `Tracker.simPhoneNumber` que s'il vaut encore le `msisdn` de la SIM
  (ne pas écraser un numéro saisi manuellement).

## Contrat API WhereverSIM (vérifié en live)

- Endpoint : `POST https://graphql.api.whereversim.com/graphql` — auth header `Authorization: <token>`
  (**token brut, sans `Bearer`**). Env : `WHEREVER_SIM_API_URL`, `WHEREVER_SIM_TOKEN` (vide ⇒ no-op).
- Statuts (`statusid`) : 2=Activated, 3=Issued, 5=Deactivated, 6=TestReady, 7=Retired, 8=ActivationReady,
  9=Inventory, 12=Suspended. Volumes en octets ; timestamps en **millisecondes**.
- Opérations utilisées : `listSims` (paginé `nextToken`, max 100), `updateSim` (statut/plafond/`custom_field_1`),
  `getDataConsumptionReport`, `getStatistics`, `listSimEvents`, `sendSms`.

## Endpoints (`/api/sims`)

`GET /` (liste scopée) · `GET /assignable-trackers` · `GET /stats` · `GET /:id` ·
`GET /:id/consumption` · `GET /:id/events` · `POST /:id/assign` · `POST /:id/unassign` ·
`POST /sync` · `POST /` · `POST /bulk` · `PATCH /:id` · `DELETE /:id` ·
`POST /:id/status` · `POST /:id/data-limit` · `POST /:id/sms`.

## Fichiers

- Backend : `apps/api/src/sims/` (`whereversim.client.ts`, `sims-sync.service.ts`, `sims.service.ts`,
  `sims.controller.ts`, `sims.module.ts`, `dto/`, `sims.service.spec.ts`) ; migration
  `apps/api/prisma/migrations/20260607120000_add_sim_management/` ; `config/env.validation.ts`.
- Partagé : `packages/shared/src/dto/sim.dto.ts`, `permissions/permissions.ts`.
- Front : `apps/web/src/app/core/services/sims.service.ts`, `features/sims/*`, routes/nav/hub.
- Smoke-test : `scripts/whereversim-smoke.mjs`.

## Vérification effectuée (hors runtime DB)

- Connectivité API live confirmée (`scripts/whereversim-smoke.mjs` : 30 SIM, stats OK).
- `prisma generate` (Prisma 6.19) · build `@vizyo/tracky-shared` · `tsc` API · `nest build` · `ng build` (web).
- **Jest : 293/293** (25 suites), dont 10 nouveaux tests `SimsService`. Un test pré-existant cassé
  (`tracker-provisioning.spec`, providers DI manquants) a été réparé au passage.

## ✅ Checklist de merge

- [x] Branche `c-ia-agent/stupefied-curie-3a97e2` : **0 commit derrière `main`, merge propre** (zéro conflit).
- [x] Additif uniquement (1 table `sims`, FK `ON DELETE SET NULL` ; aucune table existante modifiée).
- [x] Build + typecheck + tests verts.
- [x] Permissions par défaut sûres (manager/viewer n'ont pas `sims_assign` ; super/fleet admin OK).

## ▶️ Runbook post-merge (runtime — nécessite Docker + DB)

1. **Appliquer la migration** : `pnpm --filter ./apps/api exec prisma migrate deploy` (table `sims`).
2. **Vérifier le token** : `WHEREVER_SIM_API_URL` + `WHEREVER_SIM_TOKEN` dans le `.env` de prod, puis
   `node scripts/whereversim-smoke.mjs` ⇒ doit lister le parc.
3. **Sync initial** : se connecter en super admin → `/admin/sims` → « Synchroniser » (ou `POST /api/sims/sync`).
   Le parc (≈30 SIM) apparaît en cache.
4. **Test bout-en-bout** : allouer une SIM à une flotte → l'assigner à un tracker → vérifier que
   `Tracker.simPhoneNumber` se renseigne (fiche tracker / `/admin/trackers`) et que l'allowlist
   vizyo-texto se synchronise ; tester suspendre/réactiver + l'affichage conso/événements.

## Différé (schéma/API déjà prêts)

Temps réel via subscriptions WS (`updatedSim`) ; UI d'actions en masse (batch jobs ≤1000) ;
géolocalisation (`getLocationData`) ; facturation (`listBillingData`).
