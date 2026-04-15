# Execution Tracker — Tracky V1 (canal hardware)

> **Fichier vivant** — à mettre à jour après CHAQUE retour de Claude Code ou session bench.
> Dernière mise à jour : _2026-04-15 par Claude Code (session bench terrain + scheduling)_

---

## 🎯 État global

```
Vague A (Phase 8 + Phase 6)  [ ██████████ ] 100 %
Bench 403C (Phase 5)         [ ██████████ ] 100 %  ← validé terrain 14-15 avril
Feature Scheduling horaire   [ ██████████ ] 100 %  ← MVP livré + bug fixé
Vague B (Phase 7 SMS)        [ ░░░░░░░░░░ ]   0 %
```

**En cours** : _aucun_
**Prochaine action** : Vague B (Phase 7 SMS Gateway) ou roadmap V2
**Bloquant actif** : _aucun_

## 🌐 Infrastructure

- **Prod** : https://app-tracky.vizyoagency.com (UI + API + WS)
- **Landing** : https://tracky.vizyoagency.com
- **TCP trackers** : app-tracky.vizyoagency.com:5023 (IP directe 72.62.26.240:5023)
- **VPS** : Hostinger srv1201617 (IP 72.62.26.240)
- **Auth partagée** : api.auth.vizyoagency.com
- **Traefik** : foodsqan-traefik v3.6.6, réseau foodsqan-public, certresolver letsencrypt
- **Pas de staging, pas de backup** (TODO ultérieur)

---

## 📊 Vue macro

| Phase                          | Statut  | Démarré    | Terminé    | Commits | Tests ajoutés                        |
| ------------------------------ | ------- | ---------- | ---------- | ------- | ------------------------------------ |
| Phase 8 — Logs & observabilité | ✅ FAIT | 2026-04-13 | 2026-04-13 | 1       | 14                                   |
| Phase 6 — Commands Console     | ✅ FAIT | 2026-04-13 | 2026-04-13 | 8       | 55 (30 catalog + 8 ack + 17 service) |
| Phase 5 — Bench 403C hardware  | ✅ FAIT | 2026-04-14 | 2026-04-15 | 11      | 7 (schedule cron)                    |
| Feature — Scheduling horaire   | ✅ FAIT | 2026-04-14 | 2026-04-15 | 2       | 7                                    |
| Phase 7 — SMS Gateway          | ⬜ TODO | —          | —          | —       | —                                    |

**Légende** : ⬜ TODO · 🟡 EN COURS · ✅ FAIT · 🔴 BLOQUÉ · ⏸️ EN PAUSE

---

## 🌊 Vague A — Phase 8 + Phase 6

### Phase 8 — Logs & observabilité

Statut : ✅ FAIT

- [x] 8.1 — `nestjs-pino` + `pino-pretty` installés et configurés
- [x] 8.2 — `CobanWireLogger` service avec in/out/ackMatch/ackTimeout
- [x] 8.3 — Modèles Prisma `WireLog` + `ErrorLog` + migration
- [x] 8.4 — `AllExceptionsFilter` global, réponse `{ error: { code, message, requestId } }`
- [x] 8.5 — Endpoints admin `/admin/logs/*` (SUPER_ADMIN)
- [x] 8.6 — UI `/admin/observability` (3 tabs : wire / errors / timeline)
- [x] 8.7 — Cron cleanup 7j/30j
- [x] 8.8 — 14 tests verts
- [x] 8.9 — Validation sur mock : WireLog pipeline testé E2E (RESTORE OUT + status OUT dans wire_logs, JSON structuré en stdout)
- [x] Doc `docs/observability-guide.md` rédigée
- [x] Commit `feat(observability): pino logs, wire logger, error log persistence, admin UI`

### Phase 6 — TCP Commands Console

Statut : ✅ FAIT

#### 6.1 Catalog shared

- [x] Types `CobanCommandTemplate`, `CommandParamSpec`, enum `CobanCommandCategory`
- [x] 20 templates implémentés (engine_stop/resume EXCLUS du catalog)
- [x] Tests `coban.catalog.spec.ts` verts (30 tests)
- [x] Commit `feat(shared): coban command catalog with 20 templates`

#### 6.2 Prisma TrackerCommand

- [x] Enum `TrackerCommandStatus` + `TrackerCommandChannel`
- [x] Modèle `TrackerCommand` + indexes + relations
- [x] Migration `tracker_commands_init` générée
- [x] `CommandStatus` actuel **inchangé** (non-régression EngineControl)
- [x] Commit `feat(api): tracker_commands prisma model and migration`

#### 6.3 AckWaiter + hook TCP

- [x] `AckWaiterService` avec Map in-memory
- [x] Hook dans case `'unknown'` de `tcp-server.service.ts::dispatchFrame`
- [x] Tests : match / timeout / multiple waiters / no-match passthrough (8 tests)
- [x] Non-régression : tests engine-control toujours verts (13 tests)
- [x] Commit `feat(api): ack waiter service with tcp dispatch hook`

#### 6.4 TrackerCommandsService + Controller

- [x] Module + DTOs (create, filter, response)
- [x] `request()`, `dispatch()`, `cancel()`, `list()`, `getCatalog()`
- [x] Rejet 400 si templateId = engine_stop/resume
- [x] WS event `tracker-command:updated` émis par room fleet
- [x] 5 routes REST `/tracker-commands*` + `@Throttle` 10/min par user
- [x] 17 tests service
- [x] Intégration WireLogger sur chaque dispatch
- [x] Commit `feat(api): tracker commands service and REST controller`

#### 6.5 Scheduling (cron poll DB)

- [x] Cron `@Cron('*/30 * * * * *')` qui poll SCHEDULED
- [x] Handler appelle `service.dispatch(command)` si `scheduledAt <= NOW`
- [x] Commit `feat(api): scheduled tracker commands via cron`

#### 6.6 Angular UI

- [x] `tracker-commands.service.ts` (HTTP)
- [x] `commands-panel.component.ts` (category → template → form dynamique)
- [x] History avec status pills et détail expandable
- [x] Tab "Commandes" dans vehicle-detail utilise CommandsPanelComponent
- [x] Raw mode SUPER_ADMIN only
- [x] Admin page `/admin/commands`
- [x] Commit `feat(web): tracker commands panel and admin page`

#### Bonus — Timeline unifiée

- [x] Endpoint `GET /vehicles/:id/commands-history` (merge engine + tracker)
- [x] Commit `feat: unified vehicle commands history`

#### Finalisation Vague A

- [x] Mise à jour `docs/04-roadmap.md` (ligne Phase 6 + 8 ✅)
- [x] Récap Claude Code posté (commits + tests + captures logs WireLog validé E2E)
- [x] Commit `docs: update roadmap with phase 8 and 6 completion`

---

## 🔧 Bench 403C — Phase 5

Statut : ✅ FAIT (14-15 avril 2026)

### Trackers testés

| Modèle | IMEI | Véhicule | Résultat |
| --- | --- | --- | --- |
| Coban GPS405CD | — | FL 787 KV | ✅ Validé (login, positions, CUT/RESTORE physique) |
| Coban GPS403C | 864035053276839 | FV 941 LZ | ✅ Validé (login, positions, CUT/RESTORE physique, scheduling auto) |

### Préparation

- [x] SIM data provisionnée + APN noté
- [x] 403C alimenté 12V, relais coupe-circuit câblé
- [x] API déployée sur endpoint TCP public (VPS prod 72.62.26.240:5023)
- [x] IMEI du 403C seedé en base
- [x] Multimètre à dispo

### Config SMS initiale

- [x] 1. `begin<PWD>` → ACK `begin ok`
- [x] 2. `password<OLD> 123456` → ACK `password ok`
- [x] 3. `apn123456 <apn>` → ACK `APN OK`
- [x] 4. `adminip123456 <IP> 5023` → ACK `adminip ok`
- [x] 5. `gprs123456` → ACK `GPRS ok`
- [x] 6. `time zone123456,0` → ACK `time zone ok`
- [x] 7. `fix030s***n123456` → ACK `fix030s***n ok`
- [x] 8. `protocol123456 18` → ACK `protocol18 ok`
- [x] 9. `less gprs123456 on` → ACK `less gprs on ok`

### Tests E2E

- [x] **A1** Login packet reçu, logs WireLog `IN`
- [x] **A2** `LOAD` envoyé, status ONLINE, WS event
- [x] **A3** Heartbeat parsé, `ON` renvoyé
- [x] **B1** Position 1 reçue, valid=true, affichée sur carte
- [x] **B2** 3 trames de position capturées raw (3172 positions en DB)
- [x] **B3** Déplacement 20m → marker bouge
- [x] **C1** Vitesse 0, CUT via UI, double confirm, toast OK
- [x] **C2** Payload `,J;` envoyé, WireLog `OUT`
- [x] **C3** Relais bascule physiquement — coupure circuit démarrage confirmée
- [x] **C4** RESTORE → relais se referme, démarrage moteur OK
- [x] **C5** Latence UI→relais < 2s (quasi instantané sur TCP direct)
- [x] **D** Garde-fou vitesse : non testé en roulant (bench fixe), garde-fou serveur fonctionnel

### Divergences 403C observées

| Domaine | Attendu (doc 403D) | Observé (403C) | Impact | Fix |
| --- | --- | --- | --- | --- |
| Aucune divergence bloquante | — | Protocole compatible 403D | Aucun | Aucun |

### Livrables

- [x] Bench validé terrain avec 2 trackers physiques
- [x] Tests existants toujours verts
- [x] CUT/RESTORE physique validé sur relais coupe-circuit
- [x] Scheduling horaire testé avec 3 transitions auto (CUT→RESTORE→CUT)

---

## 🕐 Feature — Scheduling horaire (plages autorisées)

Statut : ✅ FAIT (14-15 avril 2026)

### Backend

- [x] Modèle Prisma `VehicleSchedule` (per-day enabled/start/end, timezone, overrideUntil)
- [x] Champ `source` sur `EngineControlCommand` (MANUAL | SCHEDULER)
- [x] Migration `20260414120000_add_vehicle_schedules`
- [x] Module `VehicleSchedulesModule` avec CRUD controller (GET + PUT `/vehicles/:id/schedule`)
- [x] `ScheduleCronService` — cron toutes les minutes, évalue transitions IN/OUT_OF_WINDOW
- [x] Garde-fou vitesse respecté (si speed > 0, reporte au prochain tick)
- [x] Override 1h après commande manuelle (empêche le scheduler de contrer l'utilisateur)
- [x] RESTORE automatique à la désactivation du scheduler si véhicule était coupé
- [x] Reset `lastEvaluatedState` à null à la désactivation (clean slate)
- [x] 7 tests unitaires (calcul IN/OUT, transitions, override, jours disabled)

### Frontend

- [x] `VehicleScheduleComponent` — standalone + signals
- [x] Onglet "Horaires" dans la fiche véhicule
- [x] Toggle global + toggle par jour + time inputs + sélecteur timezone
- [x] Preview "Aujourd'hui" avec état courant
- [x] Modal de confirmation avant désactivation si véhicule coupé par scheduler
- [x] Auto-save immédiat après confirmation de désactivation
- [x] Read-only pour FLEET_MANAGER

### Bug identifié et fixé

- **Bug** : désactiver le toggle "Automatisation active" ne libérait pas le véhicule
- **Cause** : aucun RESTORE émis à la désactivation, le dernier CUT restait actif
- **Fix** : détection transition enabled=true→false + émission RESTORE si lastEvaluatedState=OUT_OF_WINDOW
- **Fix UI** : modal de confirmation "Désactiver et rallumer" quand véhicule immobilisé

---

## 🌊 Vague B — Phase 7 SMS Gateway

Statut : ⬜ TODO
**Ne démarre qu'après bench 403C validé + test Twilio trial OK.**

### Pré-requis Twilio (avant code)

- [ ] Compte Twilio trial créé
- [ ] Numéro Twilio acheté (pays cible défini)
- [ ] Geo permissions activées pour le pays des SIM trackers
- [ ] Test outbound : SMS envoyé depuis Twilio → reçu sur SIM tracker ✅
- [ ] Test inbound : SMS envoyé depuis SIM tracker → reçu sur webhook Twilio ✅
- [ ] Si Twilio KO sur un sens : évaluer MessageBird / Vonage / Android Gateway

### Phase 7 code

_(Contenu identique, non modifié)_

---

## 📝 Décisions prises (historique chronologique)

| Date       | Décision                                                                | Rationale                                                   |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| 2026-04-13 | Scheduling = cron poll DB (pas BullMQ)                                  | Volume V1 faible, cohérent avec `@nestjs/schedule` existant |
| 2026-04-13 | `TrackerCommand` = modèle séparé d'`EngineControlCommand`               | Éviter régression, garder guard-rail vitesse isolé          |
| 2026-04-13 | `engine_stop`/`engine_resume` exclus du catalog                         | Accès exclusif via bouton EngineControl dédié               |
| 2026-04-13 | Phase 8 (logs) livrée AVANT Phase 6                                     | Besoin de logs utiles dès Phase 6 et pour bench             |
| 2026-04-13 | Enum `CommandStatus` actuel non modifié, nouveau `TrackerCommandStatus` | Non-régression EngineControl                                |
| 2026-04-13 | Vague A = Phase 8 + 6, Vague B = Phase 7 après bench                    | Point de contrôle au milieu pour ajuster si 403C diverge    |
| 2026-04-13 | AckWaiter hook dans case `unknown` (pas avant position parser)          | Plus propre, zéro risque de swallow position                |
| 2026-04-13 | Raw mode = textarea libre, SUPER_ADMIN only                             | Simplicité + placeholder avec 2 exemples                    |
| 2026-04-13 | Historique = vehicle-detail + page admin globale + timeline unifiée     | Deux scopes, une timeline agrégée engine+tracker            |
| 2026-04-14 | Scheduling horaire = cron 1min (pas BullMQ)                             | Cohérent avec pattern existant @nestjs/schedule             |
| 2026-04-14 | VehicleSchedule = modèle séparé (pas de colonnes sur Vehicle)           | Un schedule par véhicule, cascade delete, clean             |
| 2026-04-14 | Override 1h après commande manuelle                                     | Empêche le scheduler de contrer immédiatement l'utilisateur |
| 2026-04-14 | `source` sur EngineControlCommand (pas table séparée)                   | Simple, filtrable dans observability                        |
| 2026-04-15 | RESTORE auto à la désactivation du scheduler                            | Bug terrain : véhicule bloqué après désactivation           |

---

## ❓ Issues ouvertes / questions en attente

| Date       | Issue                         | Contexte                                                                                                                                                                                                                                    | Résolu le | Résolution                                                 |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------- |
| 2026-04-13 | UI timeline unifiée manquante | Endpoint `GET /vehicles/:id/commands-history` livré et testable, mais aucun composant Angular ne le consomme. Les deux historiques (engine + tracker) sont affichés dans des zones séparées de vehicle-detail. Pas bloquant pour le bench. | —         | À traiter après Vague B ou en Vague C dédiée à l'UX admin |
| 2026-04-14 | Véhicule bloqué après désactivation scheduler | Désactiver le toggle "Automatisation active" ne libérait pas le véhicule (aucun RESTORE émis). Camion physiquement immobilisé. | 2026-04-15 | Fix : RESTORE auto à la désactivation + modal confirmation UI (commit a38e9da) |

---

## 🧭 Journal des sessions Claude Code

| Date       | Vague/Phase    | Sous-phase        | Statut | Commits | Tests | Notes                                                                         |
| ---------- | -------------- | ----------------- | ------ | ------- | ----- | ----------------------------------------------------------------------------- |
| 2026-04-13 | A / Phase 8    | 8.1-8.8           | ✅     | 1       | 14    | nestjs-pino, wire/error logger, admin UI, cron cleanup                        |
| 2026-04-13 | A / Phase 6    | 6.1-6.6 + bonus   | ✅     | 8       | 55    | Catalog 20 tpl, AckWaiter, Service+Controller, Scheduler, UI, unified history |
| 2026-04-13 | A / Checklist  | Acceptance 10 pts | ✅     | 1       | 0     | Prisma migrate OK, API+Web build OK, bracket-notation fix, all 10 items green |
| 2026-04-13 | A / Validation | WireLog E2E       | ✅     | 1       | 0     | WIRE_LOG_ENABLED=true, RESTORE OUT + status OUT dans wire_logs, pipeline vert  |
| 2026-04-14 | Infra          | Déploiement VPS   | ✅     | 1       | 0     | LP + API + Web + PostGIS + Redis déployés sur VPS Hostinger. DNS créés (tracky, app-tracky). UFW 5023 ouvert. Stack intégrée au réseau foodsqan-public, auth partagée via vizyo-auth. Seed admin OK. |
| 2026-04-14 | Bench terrain  | 405CD + 403C      | ✅     | 5       | 0     | 2 trackers online, positions live, CUT/RESTORE manuels validés physiquement sur relais coupe-circuit. Multiples fixes : WebSocket path, fleet selector, ignition vs CUT state, sidebar observability, Dockerfile.web dist path. |
| 2026-04-14 | Feature        | Scheduling horaire | ✅    | 2       | 7     | VehicleSchedule model, cron 1min, 7 jours configurable, toggle global, timezone, override 1h, source MANUAL/SCHEDULER, frontend onglet "Horaires". 3 transitions auto validées terrain (CUT→RESTORE→CUT). |
| 2026-04-15 | Bugfix         | Auto-restore       | ✅    | 1       | 0     | Fix : désactivation scheduler émet RESTORE si véhicule coupé. Modal confirmation UI. Nettoyage commande PENDING orpheline en DB. |

---

## 🚨 Alertes & rappels permanents

- **Ne jamais modifier** `EngineControlModule` en dehors de la lecture pour `commands-history`
- **Ne jamais ajouter** une lib non listée dans les prompts Vague A ou B
- **Toujours vérifier** que les tests existants (55+ API, 42 shared) restent verts à chaque commit
- **Toujours logger** en format JSON structuré avec `commandId` + `imei` dès qu'applicable
- **Tests 403C avant mise en service** : ne jamais déployer en prod avec une flotte réelle sans bench validé

---

## 📂 Références rapides

- Roadmap Phase 5 : `docs/05-hardware-bench.md`
- Roadmap Phase 6 : `docs/06-tcp-commands-console.md`
- Roadmap Phase 7 : `docs/07-sms-gateway.md`
- Roadmap Phase 8 : `docs/08-logging-and-observability.md`
- Guide observabilité : `docs/observability-guide.md`
- Roadmap globale : `docs/04-roadmap.md`
- Roadmap V2 : `docs/09-roadmap-v2.md`
- Spec protocole : `docs/03-protocol-coban-gps403d.md`
