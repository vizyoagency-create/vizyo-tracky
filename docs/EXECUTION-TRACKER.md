# Execution Tracker — Tracky V1 (canal hardware)

> **Fichier vivant** — à mettre à jour après CHAQUE retour de Claude Code ou session bench.
> Dernière mise à jour : _2026-04-13 par Claude Code_

---

## 🎯 État global

```
Vague A (Phase 8 + Phase 6)  [ ████████░░ ]  80 %
Bench 403C (Phase 5)         [ ░░░░░░░░░░ ]   0 %
Vague B (Phase 7 SMS)        [ ░░░░░░░░░░ ]   0 %
```

**En cours** : _Vague A terminée_
**Prochaine action** : bench 403C (Phase 5)
**Bloquant actif** : _aucun_

---

## 📊 Vue macro

| Phase | Statut | Démarré | Terminé | Commits | Tests ajoutés |
|-------|--------|---------|---------|---------|---------------|
| Phase 8 — Logs & observabilité | ✅ FAIT | 2026-04-13 | 2026-04-13 | 1 | 14 |
| Phase 6 — Commands Console | ✅ FAIT | 2026-04-13 | 2026-04-13 | 7 | 55 (30 catalog + 8 ack + 17 service) |
| Phase 5 — Bench 403C hardware | ⬜ TODO | — | — | n/a | n/a |
| Phase 7 — SMS Gateway | ⬜ TODO | — | — | — | — |

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
- [ ] 8.9 — Validation sur mock : 4 scénarios de vérification produisent des logs utiles
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
- [ ] Récap Claude Code posté (commits + tests + captures logs 8 scénarios)
- [x] Commit `docs: update roadmap with phase 8 and 6 completion`

---

## 🔧 Bench 403C — Phase 5

Statut : ⬜ TODO
**Ne démarre qu'après Vague A livrée.**

### Préparation

- [ ] SIM data provisionnée + APN noté
- [ ] 403C alimenté 12V, relais coupe-circuit câblé
- [ ] API déployée sur endpoint TCP public (VPS staging ou ngrok TCP)
- [ ] IMEI du 403C seedé en base
- [ ] Multimètre à dispo

### Config SMS initiale

- [ ] 1. `begin<PWD>` → ACK `begin ok`
- [ ] 2. `password<OLD> 123456` → ACK `password ok`
- [ ] 3. `apn123456 <apn>` → ACK `APN OK`
- [ ] 4. `adminip123456 <IP> 5023` → ACK `adminip ok`
- [ ] 5. `gprs123456` → ACK `GPRS ok`
- [ ] 6. `time zone123456,0` → ACK `time zone ok`
- [ ] 7. `fix030s***n123456` → ACK `fix030s***n ok`
- [ ] 8. `protocol123456 18` → ACK `protocol18 ok`
- [ ] 9. `less gprs123456 on` → ACK `less gprs on ok`

### Tests E2E

- [ ] **A1** Login packet reçu, logs WireLog `IN`
- [ ] **A2** `LOAD` envoyé, status ONLINE, WS event
- [ ] **A3** Heartbeat parsé, `ON` renvoyé
- [ ] **B1** Position 1 reçue, valid=true, affichée sur carte
- [ ] **B2** 3 trames de position capturées raw (à copier dans report)
- [ ] **B3** Déplacement 20m → marker bouge
- [ ] **C1** Vitesse 0, CUT via UI, double confirm, toast OK
- [ ] **C2** Payload `,J;` envoyé, WireLog `OUT`
- [ ] **C3** Relais bascule (multimètre) ✂️
- [ ] **C4** RESTORE → relais se referme
- [ ] **C5** Latence UI→relais mesurée (objectif < 3s)
- [ ] **D** Garde-fou vitesse testé (optionnel si bench fixe)

### Divergences 403C observées

_Remplir après bench — ajouter ligne par divergence._

| Domaine | Attendu (doc 403D) | Observé (403C) | Impact | Fix |
|---------|--------------------|----------------|--------|-----|
| — | — | — | — | — |

### Livrables

- [ ] `docs/bench-403c-report.md` rédigé
- [ ] Si divergences : PR parser/encoder avec tests sur fixtures réelles
- [ ] Tests existants toujours verts
- [ ] Mise à jour `docs/04-roadmap.md` ligne bench ✅

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

| Date | Décision | Rationale |
|------|----------|-----------|
| 2026-04-13 | Scheduling = cron poll DB (pas BullMQ) | Volume V1 faible, cohérent avec `@nestjs/schedule` existant |
| 2026-04-13 | `TrackerCommand` = modèle séparé d'`EngineControlCommand` | Éviter régression, garder guard-rail vitesse isolé |
| 2026-04-13 | `engine_stop`/`engine_resume` exclus du catalog | Accès exclusif via bouton EngineControl dédié |
| 2026-04-13 | Phase 8 (logs) livrée AVANT Phase 6 | Besoin de logs utiles dès Phase 6 et pour bench |
| 2026-04-13 | Enum `CommandStatus` actuel non modifié, nouveau `TrackerCommandStatus` | Non-régression EngineControl |
| 2026-04-13 | Vague A = Phase 8 + 6, Vague B = Phase 7 après bench | Point de contrôle au milieu pour ajuster si 403C diverge |
| 2026-04-13 | AckWaiter hook dans case `unknown` (pas avant position parser) | Plus propre, zéro risque de swallow position |
| 2026-04-13 | Raw mode = textarea libre, SUPER_ADMIN only | Simplicité + placeholder avec 2 exemples |
| 2026-04-13 | Historique = vehicle-detail + page admin globale + timeline unifiée | Deux scopes, une timeline agrégée engine+tracker |

---

## ❓ Issues ouvertes / questions en attente

_Rien pour l'instant._

---

## 🧭 Journal des sessions Claude Code

| Date | Vague/Phase | Sous-phase | Statut | Commits | Tests | Notes |
|------|-------------|-----------|--------|---------|-------|-------|
| 2026-04-13 | A / Phase 8 | 8.1-8.8 | ✅ | 1 | 14 | nestjs-pino, wire/error logger, admin UI, cron cleanup |
| 2026-04-13 | A / Phase 6 | 6.1-6.6 + bonus | ✅ | 7 | 55 | Catalog 20 tpl, AckWaiter, Service+Controller, Scheduler, UI, unified history |

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
- Spec protocole : `docs/03-protocol-coban-gps403d.md`
