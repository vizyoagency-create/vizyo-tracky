# Sprint 2 — Fiabilisation du start/stop · ANALYSE (Phase 1)

> **Base** : `main` @ `a316347` · Worktree isolé `feat/sprint-2-fiabilisation-commande`.
> **Données** : prod **live** consultées en **lecture seule** (VPS `tracky-postgres`/`tracky_prod`). **Aucune commande envoyée.**
> **Criticité** : le start/stop pilote une **coupe-circuit moteur physique**. Toute conclusion ici est étayée par le code (file:line) et/ou les données réelles.

---

## 0. TL;DR — l'insight central

**Le boîtier Coban n'accuse PAS réception de J/K de façon fiable.** Sur ~169 commandes app en prod, **1 seule** a reçu un vrai ACK fil (latence 2.1 s). Le système le sait déjà : depuis V1.15, un timeout d'ACK n'est **pas** un échec — la commande reste `SENT` (« livrée »).

→ **La seule preuve réelle d'exécution = la transition d'ignition de la trame de position suivante.** Ce signal est **déjà détecté et fonctionne** : `positions.service.handleIgnitionTransition` crée 591 lignes `DEVICE_OBSERVED` en prod. Mais il est **découplé du statut de la commande** et **exclu de l'état affiché**.

**Conséquence pour le sprint** : la « confirmation réelle » (obj. 2) et la « source de vérité = device » (obj. 3) ne se construisent **pas** sur un ACK fil inexistant, mais sur **l'état d'ignition réel** — en **reliant** la machinerie de détection existante au cycle de vie de la commande et à l'affichage. On **durcit l'existant**, on ne réinvente rien.

---

## 1. Architecture réelle — deux sous-systèmes, une infra partagée

| Sous-système | Rôle | Modèle | Voie |
|---|---|---|---|
| **EngineControl** (`engine-control/*`) | **LA** voie coupe-circuit (CUT/RESTORE, relais J/K) | `EngineControlCommand` | TCP (prioritaire) → **fallback SMS** |
| **TrackerCommands** (`tracker-commands/*`) | catalogue générique (status, reset, fix, geofence…) — **moteur INTERDIT ici** (`tracker-commands.service.ts:44-48`) | `TrackerCommand` | TCP via registry |

**Infra partagée** :
- **`SocketRegistryService`** (`socket-registry/*`) — `Map<imei, socket>`, `.send()` = unique chemin d'écriture sûr (vérifie `destroyed`/`writable`).
- **`AckWaiterService`** (`tracker-commands/ack-waiter.service.ts`) — `Map<imei, PendingAck[]>` **en mémoire**. `waitForAck(imei, pattern, timeoutMs, commandId, priority)` (l.24), `tryMatch` résout le waiter de **plus haute priorité** dont le pattern matche (l.58-88), `cancelAll(imei)` rejette tout à la déconnexion (l.94). **Aucun token de corrélation sur le fil** : matching = IMEI + regex + priorité.
- **`TcpServerService`** (`tracker-tcp/tcp-server.service.ts`) — écoute TCP, décode les trames, appelle `ackWaiter.tryMatch` (cas `position` l.289 **et** `unknown` l.316, #10). Traitement **sérialisé par socket** (chaîne de promesses, l.87/123, #2/#3) ; `markOffline` re-vérifie `registry.has()` (anti-TOCTOU, l.200, #11).
- **`PositionsService`** — ingère les positions, résout l'ignition, et **synthétise** les CUT/RESTORE `DEVICE_OBSERVED` sur transition d'ignition (voir §4).
- **`SmsGatewayService`** + **vizyo-texto** — transport SMS sortant (vizyo-texto → Twilio → noop) ; **`SmsWebhookController`** = entrée SMS HMAC-vérifiée.

---

## 2. Réponses aux pré-requis d'analyse

### 2.1 Pipeline actuel (du clic au device, et retour)

```
[UI bouton] --POST /api/engine-control/trackers/:id/commands {action,reason,disableSchedule}-->
  EngineControlController (JwtAuthGuard, RolesGuard, PermissionsGuard ;
                           @RequireVehiclePermission('engine_control'))
  -> EngineControlService.requestCommand
       1. lookup tracker SCOPÉ TENANT (where.vehicle.fleetId, anti-IDOR)   [l.66-74]
       2. CUT only : garde-fous sécurité                                   [l.86-164]
            - aucune position -> REJECTED_SPEED
            - position stale (>60s) si en mouvement -> REJECTED_SPEED
            - fix invalide -> REJECTED_SPEED
            - vitesse > 20 km/h -> REJECTED_SPEED
       3. MANUAL -> neutralise le schedule (override 1h ou désactive)      [l.167-190]
       4. persiste EngineControlCommand status=PENDING                     [l.192-201]
       5. dispatchCommand :
            encode J (CUT) / K (RESTORE)  -> `**,imei:<15>,J;`             [coban.encoder]
            registry.send(imei, payload)  (TCP)                            [l.224]
              -- si TCP OK  -> status=SENT, sentAt=now, wireLog.out        [l.258-261]
              -- si TCP KO  -> trySmsFallback (`stop123456`/`resume123456`)[l.358]
                                ok  -> SENT (lastError="via SMS")          [l.230-233]
                                ko  -> FAILED + ErrorLogger + 503          [l.239-252]
            background : ackWaiter.waitForAck(J|K, 15s, priority=10)       [l.269]
              -- .then(echo)  -> status=ACKNOWLEDGED, ackedAt              [l.277-281]   (≈ jamais, cf §3)
              -- .catch(timeout) -> NE FAIT RIEN (reste SENT)              [l.291-306]   (volontaire V1.15)
  <-- réponse HTTP = la commande (souvent status=SENT)
[retour réel] trame de position suivante -> ignition OFF -> DEVICE_OBSERVED (§4) + WS
```

**Comment l'app considère que ça a réussi ?** → **Présomption à l'envoi.** `SENT` est posé sur **succès d'écriture socket**, pas sur un ACK device. `ACKNOWLEDGED` n'arrive que si un écho J/K revient dans 15 s — ce qui n'arrive quasiment jamais (§3). Le front traite `SENT` comme « coupé » (bascule le bouton).

### 2.2 Source de vérité de l'état coupé/normal

**Dérivée, pas stockée.** `engineCutActive` est calculé à la lecture dans le snapshot (`vehicles.service.ts:506-524,549`) : dernière `EngineControlCommand` par tracker **où `source != DEVICE_OBSERVED`** et statut `SENT`/`ACKNOWLEDGED` (ou `FAILED` < 30 min) → `engineCutActive = (action === CUT)`. Le front `engine-control-button.isCutActive()` applique **la même règle** (exclut DEVICE_OBSERVED).
**Rafraîchie indépendamment des actions app ?** Oui pour la **détection** (DEVICE_OBSERVED via ignition), **NON pour l'affichage** : l'état affiché **ignore** DEVICE_OBSERVED → **une coupure hors app n'apparaît pas dans le badge** (gap obj. 3, §5).

### 2.3 Synchro SMS manuel → app

Mécanisme = **transition d'ignition** (`handleIgnitionTransition`, `positions.service.ts:481-588`) :
- ignition **ON→OFF** sans CUT app récent (≤5 min `CUT_DETECTION_WINDOW_MS`) → crée `DEVICE_OBSERVED` CUT (ACKNOWLEDGED) + WS `engine-command:updated` (l.500-524).
- ignition **OFF→ON** avec CUT actif non suivi de RESTORE → crée `DEVICE_OBSERVED` RESTORE + WS (l.543-585).

**Marche-t-elle dans les deux sens aujourd'hui ?** **Détection : oui** (591 lignes prod, WS émis). **Reflet dans l'app : non** — l'affichage exclut DEVICE_OBSERVED. Et la détection **dépend d'un vrai signal d'ignition** : sur les boîtiers `accConnected=false`, l'ignition est **inférée de la vitesse** → un véhicule garé est déjà « OFF », donc une coupure externe à l'arrêt **ne produit aucune transition** détectable.

### 2.4 Idempotence existante

**Absente sur le chemin de commande.** Grep complet : aucun verrou « une commande en vol », aucun id d'idempotence, aucune dédup sur le dispatch moteur.
- `EngineControlController` : **aucun throttle**. Double-clic → 2 lignes + 2 trames J.
- Seules protections *adjacentes* : `TrackerCommandsController @Throttle 10/60s` (rate-limit, pas un verrou) ; `TrackerProvisioning` refuse une 2ᵉ séquence PENDING/IN_PROGRESS (provisioning only) ; fix-mode anti-flapping. **Aucune ne couvre le moteur.**
- **Front** : garde `loading` par instance de bouton (`engine-control-button.onConfirm` : `if (this.loading()) return`), + modale boutons désactivés pendant l'envoi. Mais **par composant** : carte + détail + autre onglet = instances distinctes ; et ça ne protège pas le back.
- **Cross-voies** : rien ne bloque app-CUT vs fix-mode vs scheduler vs SMS manuel sur le même tracker.

### 2.5 Cartographie des voies (matrice)

| Voie | Quand | Prérequis | ACK | Latence réaliste |
|---|---|---|---|---|
| **TCP J/K (moteur)** | primaire CUT/RESTORE | socket live dans le registry | `SENT` à l'écriture ; `ACKNOWLEDGED` si écho J/K < 15 s (**≈ jamais**) ; timeout ≠ FAILED | écriture ~ms ; relais quelques s ; écho ~jamais |
| **SMS fallback (moteur)** | si `registry.send` renvoie false | `simPhoneNumber` + provider actif | `SENT` à l'acceptation gateway ; **jamais ACKNOWLEDGED** (l'ACK waiter est TCP-only) | 15-60 s |
| **vizyo-texto** | transport SMS réel (V1.14) | `VIZYO_TEXTO_URL`+`API_KEY` | HTTP 2xx + statut non-failed | ms à envoyer, livraison s |
| **Twilio / noop** | fallback legacy / dev | env | statut Twilio / audit noop | s / n.a. |
| **TCP (TrackerCommands génériques)** | catalogue (status/fix/raw…) — **moteur exclu** | socket live | `SENT`→`ACKNOWLEDGED` sur match, **FAILED au timeout** (15/30 s) | ms-s |
| **DEVICE_OBSERVED (synthétique)** | transition d'ignition entrante | signal ignition présent | créé déjà `ACKNOWLEDGED` ; pas d'envoi fil | reflète la trame suivante (s-min) |

**Legacy** : il n'y a **pas** de vieux contrôleur moteur séparé — `EngineControlModule` est l'unique voie relais ; le catalogue **exclut** explicitement engine_stop/resume. La « TCP prioritaire » = la **priorité de résolution d'ACK** (`ENGINE_ACK_PRIORITY=10` vs 0), pas un transport distinct.

### 2.6 Modèle d'ACK fiable par voie ?

- **TCP moteur** : ACK fil **non fiable** (Coban exécute silencieusement). Le vrai ACK = ignition (§4).
- **TCP générique** : ACK par pattern, mais **327/327 FAILED en prod** → voie peu fiable (hors périmètre moteur).
- **SMS** : pas d'ACK applicatif relié à l'ACK waiter (TCP-only). Le provisioning a son propre matching de mots-clés (45 s, hors moteur).

### 2.7 Protections entrantes à préserver (NE PAS régresser)

- **Webhook SMS** (`sms/sms-webhook.controller.ts`) : HMAC-SHA256 `${ts}.${rawBody}` + **anti-replay** (|now-ts|>300s rejeté) + compare **timing-safe** + **fail-closed en prod** si secret absent. Corps stocké verbatim, **jamais** ré-émis ni interprété comme IMEI.
- **Sortant `raw`** (`coban.catalog.ts`) : `RAW_PAYLOAD_MAX_LEN=120`, charset sans `:`/`;`/CRLF (anti override `imei:` + injection trame), re-wrap systématique sur l'IMEI résolu (`tcpWrap`).
- **Liaison IMEI entrante** (`tcp-server.service.ts`) : trames rejetées si IMEI ≠ IMEI du socket ; login IMEI inconnu → socket fermé ; `tryMatch` clé par `currentImei`.

---

## 3. « Réussi » — la réalité prod (lecture seule)

```
engine_control_commands par STATUS :  ACKNOWLEDGED 592 | FAILED 126 | SENT 25 | REJECTED_SPEED 17
                       par SOURCE  :  DEVICE_OBSERVED 591 | MANUAL 159 | SCHEDULER 10
ACK fil RÉEL (non DEVICE_OBSERVED, ackedAt-sentAt) :  1 commande  (latence 2.1 s)
10 dernières commandes : TOUTES DEVICE_OBSERVED (sent=false, ackd=true)

tracker_commands : 327 / 327 FAILED  (catalogue générique non fiable — hors moteur)
```

**Lecture** : sur **169** commandes app moteur (159 MANUAL + 10 SCHEDULER), **1** vrai ACK fil. 591 des 592 `ACKNOWLEDGED` sont des `DEVICE_OBSERVED` (créés déjà ACK). → **l'écho J/K est un mythe en prod ; l'ignition est la vérité.** Et `tracker_commands` 100 % FAILED confirme qu'on ne doit **pas** router le moteur par cette voie.

---

## 4. Le cœur de la confirmation (déjà presque là)

`handleIgnitionTransition` (`positions.service.ts:481`) — branche **ON→OFF** :
```
recentCut = EngineControlCommand{ action:CUT, status in (SENT,ACKNOWLEDGED), createdAt >= now-5min }
if (recentCut)  ->  /* ne fait RIEN aujourd'hui */            <-- ICI : c'est la CONFIRMATION RÉELLE
else            ->  crée DEVICE_OBSERVED CUT (coupure externe)
```
Quand l'ignition tombe **et** qu'une commande app CUT récente existe, **la coupure est physiquement confirmée**. Le code se contente d'éviter le doublon ; il **ne marque pas** la commande comme confirmée. **C'est le levier n°1 du sprint** : relier ce signal au cycle de vie de la commande (`SENT` → *confirmé*) + WS → l'UI montre « coupure confirmée par le boîtier ».

---

## 5. Risques (dont double exécution)

1. **Faux succès (CRITIQUE).** `SENT` = écriture socket OK, traité comme succès par l'UI ; timeout volontairement non-FAILED. Aucune **confirmation positive** de l'actionnement réel. Une écriture peut réussir dans un buffer TCP sans que le relais agisse. → obj. 2.
2. **Pas d'idempotence (toutes voies).** Pas de throttle moteur, pas de verrou « 1 en vol ». Double-clic = 2 trames ; app-CUT peut courir avec fix-mode/scheduler/SMS sur le même tracker. → obj. 1.
3. **Gap synchro hors app.** Coupure SMS manuelle détectée (DEVICE_OBSERVED + WS) mais **exclue de l'affichage** (`vehicles.service.ts:513`, front idem) → badge faux. Détection dépendante d'une vraie transition d'ignition (faible sur `accConnected=false`). → obj. 3.
4. **Cross-talk d'ACK générique.** La priorité (#7) protège l'écho moteur (10) des patterns larges (0), mais deux commandes génériques larges sur un IMEI restent à égalité → mauvaise attribution possible. Pas de token fil. (Hors moteur, mais à garder en tête.) → obj. 4/5.
5. **Fallback SMS moteur sans confirmation.** Une CUT partie en SMS arme quand même le waiter TCP J/K → jamais ACKNOWLEDGED ; et la confirmation par ignition reste le seul recours. → obj. 2/4.
6. **Observabilité moteur pauvre vs générique.** `TrackerCommand` a `expectedResult/observedResult/diagnosticHint/outcomeReason/contextSnapshot` ; `EngineControlCommand` n'a que `status/lastError/sentAt/ackedAt`. Pas d'**id de corrélation** traversant UI→back→voie→ignition. → obj. 5.

---

## 6. Stratégie de test SANS PROD (obligatoire)

**Aucune commande réelle ne sera envoyée à un véhicule. Flotte CDEF et tout tracker lié à un device réel = interdits.**

- **Tests automatisés (100 % mocks, zéro I/O réel)** — c'est le mode principal. Les specs existants (`engine-control.service.spec.ts`, `ack-waiter.service.spec.ts`, `tcp-server.service.spec.ts`, `tracker-commands.service.spec.ts`) mockent déjà `PrismaService` + `SocketRegistryService` + `AckWaiterService` + `SmsGatewayService`. On teste :
  - idempotence (2ᵉ commande rejetée tant qu'une est en vol) — mock prisma/registry ;
  - confirmation par ignition — on injecte une position synthétique (ignition ON→OFF) avec un CUT app mocké récent et on vérifie la transition de statut ;
  - timeout → état « non confirmé » explicite + pas de faux succès ;
  - synchro bidirectionnelle (DEVICE_OBSERVED → état affiché) ;
  - scoping tenant (IDOR) ;
  - non-régression sanitisation (webhook HMAC/anti-replay, charset `raw`).
- **`registry.send` renvoie `false`** pour tout IMEI sans socket → on simule « device offline » sans rien envoyer ; le provider SMS en **`noop`** (dev) n'émet aucun vrai SMS (écrit juste une ligne d'audit).
- **Vérif manuelle éventuelle = staging uniquement**, avec un **tracker de test** (ligne `Tracker` à IMEI factice non lié à un boîtier réel) ou un **socket simulé**. Jamais le endpoint contre un tracker dont le socket appartient à un device de prod.
- **DB prod = lecture seule** pour valider les hypothèses (comme cette analyse). Jamais d'écriture.

---

## 7. Décisions de conception à VALIDER (changements de comportement)

Ces points changent le comportement de la commande → à acter avant de coder (cf. PLAN.md) :

- **D1 — Confirmation par ignition.** Introduire un état **« confirmé »** distinct de `SENT` : une CUT app passe *confirmée* quand l'ignition tombe (≤ fenêtre réaliste) ; sinon reste **« envoyée, non confirmée »** (jamais faux succès). Cas « véhicule déjà à l'arrêt » → confirmation par ignition impossible → libellé explicite, pas de bascule trompeuse.
- **D2 — Source de vérité = device.** Faire **entrer DEVICE_OBSERVED** dans le calcul de `engineCutActive` (back + front) pour refléter les coupures hors app. (Dé-dup déjà gérée par la fenêtre 5 min.)
- **D3 — Idempotence back.** Verrou « une commande moteur en vol par tracker » (rejet propre 409 d'une 2ᵉ tant que la 1ʳᵉ n'est pas résolue), couvrant toutes les voies, + id de corrélation pour l'observabilité.

---

## Fichiers clés (référence)
- Back moteur : `engine-control/engine-control.{controller,service}.ts`, `tracker-commands/ack-waiter.service.ts`, `socket-registry/socket-registry.service.ts`, `tracker-tcp/tcp-server.service.ts`, `positions/positions.service.ts` (handleIgnitionTransition), `vehicles/vehicles.service.ts` (snapshot engineCutActive), `realtime/realtime.gateway.ts`, `sms/{sms-gateway,sms-webhook}.*`, `coban.{encoder,catalog}` (shared).
- Front : `features/engine-control/engine-control-button.component.ts`, `core/services/{engine-control,realtime}.service.ts`, `features/map/map.component.ts` (patch optimiste + carte), `shared/ui/confirm-modal/*`.
- Modèles : `EngineControlCommand`, `TrackerCommand` (+ enums `EngineAction`, `CommandStatus`, `TrackerCommandStatus`, `TrackerCommandChannel`).
