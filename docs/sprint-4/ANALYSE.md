# Sprint 4 — Écoute audio à distance — ANALYSE (Phase 1)

> **Phase 1 : analyse seule, AUCUN code.** Cartographie du système réel (réutilise S2/S3) +
> placement des 8 garde-fous + risques. **STOP** ensuite pour validation avant Phase 2.
> Branche : `feat/sprint-4-ecoute-audio`. Environnement : LOCAL.

---

## 0. ⚠️ RISQUE D'ARCHITECTURE #1 — à trancher AVANT de coder

**Le modèle « snapshot enregistré renvoyé au serveur » du brief ne correspond pas à ce que décrit la doc protocole du repo pour ce hardware.**

- **Brief** : `commande → ~15 s → réception du vocal enregistré → stockage`. C'est un **clip enregistré uploadé au serveur**.
- **Repo — `docs/03-protocol-coban-gps403d.md:29-36`** : le mode `monitor` du Coban GPS403D = **« micro ouvert, le boîtier se laisse appeler pour écouter la cabine (pas de positions GPRS) »**. C'est un **appel vocal GSM live** (on **appelle** la SIM du boîtier, il décroche en silence, on écoute en direct) — **PAS** un fichier uploadé.

**Conséquence** : sur le hardware tel que documenté dans le repo, il n'existe **ni commande d'enregistrement-clip, ni canal de retour de fichier audio**. Le brief dit « déjà fait sur Baanool » — mais **le code Tracky ne contient AUCUNE implémentation Baanool de snapshot audio** (vérifié, cf §2). Il manque la **source autoritaire** (doc Coban/Baanool « voice monitor » + comment le clip revient : callback HTTP ? port dédié ? cloud Baanool ? format/taille).

> **✅ DÉCISION 2026-06-27 — Scénario A retenu (appel live).** Implémenté en Phase 3 (commande + 8 garde-fous + audit + activation/attestation + mail + front, **device mocké** ; la commande d'armement Coban réelle reste un **TODO en attente de la source Baanool**). Pas de clip / réception / stockage / rétention → **garde-fou #8 sans objet**. L'écoute = appel vers la SIM du boîtier. Les deux scénarios initiaux restent ci-dessous pour mémoire.
>
> **Décision (historique) avant Phase 2** : confirmer le modèle réel du hardware avec la doc/réf Baanool —
> - **Scénario A — appel live** : pas de fichier serveur. L'« écoute » = un appel vers la SIM du boîtier. Le serveur **envoie la commande monitor** + trace ; il n'y a **rien à stocker/purger** (garde-fou #8 sans objet, mais audit #7 toujours requis). Garde-fous 1-7 inchangés.
> - **Scénario B — clip enregistré uploadé** (le brief) : il faut **le canal de retour** (endpoint callback + réception binaire — **inexistant aujourd'hui**, à construire) + stockage + rétention. **Bloqué tant que le format/canal Baanool n'est pas fourni** — sinon on code à l'aveugle un sous-système de réception qui ne matchera pas le device.

**Recommandation** : la partie **ENVOI de commande + tous les garde-fous + l'audit + l'attestation + le mail** est cartographiée et implémentable **sans risque** (réutilise S2/S3). La partie **RÉCEPTION/STOCKAGE du vocal** dépend du scénario A/B et **nécessite la source Baanool**. Je propose de construire la commande + les garde-fous d'abord (avec le device **mocké**), et de brancher la réception **quand le canal réel est confirmé**.

---

## 1. Pipeline de commande device S2 (réutilisé, NON dupliqué)

L'écoute = **une commande de plus** dans le pipeline fiabilisé en S2. Tout est réutilisable.

| Brique | Fichier:ligne | Réutilisation Sprint 4 |
|---|---|---|
| Encodage trame sortante | `packages/shared/src/protocol/coban.encoder.ts:6-41` (`encodeCommand`, union `CobanCommand`) | **+1 type** `voice_monitor` + 1 case encoder (format exact = inconnu, cf §2) |
| Envoi TCP (socket live) | `apps/api/src/socket-registry/socket-registry.service.ts:64-84` (`send()`) | identique |
| Fallback SMS | `engine-control.service.ts:503-517` (`trySmsFallback`) | identique (le monitor Coban s'arme **par SMS** d'ailleurs — cohérent) |
| Corrélation ACK | `apps/api/src/tracker-commands/ack-waiter.service.ts` (`waitForAck`/`tryMatch`, priorité) | identique (pattern + priorité dédiés) |
| Émission WS | `engine-control.service.ts:450-471` (`emitUpdate` → gateway) | identique (nouvel event type) |
| Cycle de vie commande (DB) | modèle `EngineControlCommand` (`schema.prisma:944-976`) + enum `CommandStatus` | **modèle dédié** `AudioMonitoringCommand` (miroir, cf §5) |
| Scope tenant / anti-IDOR | `engine-control.service.ts:88-99` + `common/tenant-scope.ts:29-36` (fail-closed) | identique |
| **Précédent direct** | la commande moteur est **volontairement isolée** du catalogue générique pour ses garde-fous (`coban.catalog.ts:6-11`) | **on fait pareil** : module `AudioMonitoringModule` isolé, jamais dans le catalogue générique |

**Verdict** : le pipeline est **extensible proprement**. L'écoute s'ajoute comme un module isolé (façon `EngineControlModule`) qui réutilise socket-registry, ack-waiter, le gateway WS et la résolution de scope — **zéro duplication**.

**Différence clé vs moteur** : le moteur attend un simple ACK (ou rien). L'audio (scénario B) attendrait un **payload** (le clip) ~15 s plus tard → ce n'est pas un ACK, c'est une **réception de données binaires** → **mécanisme inexistant** (cf §2/§6).

---

## 2. Commande audio Coban + canal retour — EXISTANT vs INCONNU

### Ce qui EXISTE dans le code
- **Rien** pour la voix/audio. Aucun type `voice/audio/monitor` dans `CobanCommand` (`coban.types.ts:91-101`), aucun encoder (`coban.encoder.ts`), aucun template (`coban.catalog.ts`, 20 templates, **pas** de monitor), aucun parseur de trame audio (`coban.parser.ts`).
- **Référence « Baanool »** = uniquement un **overlay UI carte** (`apps/web/.../baanool/baanool-map-overlay.component.ts`) — **aucune** intégration fonctionnelle de voice monitoring.
- **Doc protocole** `docs/03-protocol-coban-gps403d.md:29-36` : mentionne le mode `monitor` (**appel live**, cf §0) **sans** décrire de commande ni de retour de fichier. `docs/06-tcp-commands-console.md:42` liste `monitor/tracker toggle` comme **TODO**, non implémenté.
- **Réception device→serveur** : le serveur TCP est **texte uniquement** (trames ASCII `;`/`\r\n`, cf `tcp-server.service.ts`). **Aucun** récepteur binaire, **aucun** endpoint callback, **aucune** ingestion de fichier.

### Ce qui est INCONNU / EXTERNE (source autoritaire requise)
1. **Commande d'armement** du monitor/snapshot (code TCP exact `**,imei:X,?;` et/ou SMS `monitor<pass>` ?), avec/sans paramètres (durée, numéro destinataire).
2. **Canal de retour** du vocal (scénario B) : callback HTTP du device ? nouvelle connexion TCP ? SMS base64 ? cloud Baanool ?
3. **Format** du clip (codec, fréquence, durée, taille, framing).
4. **URL/auth** du callback éventuel.
5. **Désarmement** (retour en mode tracker).

> **Sans 1-5, on ne code pas la réception** (on inventerait un sous-système qui ne matche pas le device). À fournir : manuel Coban GPS403D (section voice monitor) **ou** la réf Baanool qui l'a fait.

---

## 3. Placement des 8 garde-fous (le cœur de la revue)

| # | Garde-fou | Point d'enforcement (existant réutilisé) | Fichier:ligne |
|---|---|---|---|
| **1** | **OFF par défaut** (toutes flottes) | nouvelle perm `audio_monitoring: false` dans **tous** les `ROLE_DEFAULTS` + activation **par flotte** (modèle `FleetAudioConfig`, `enabled=false` défaut) | `packages/shared/src/permissions/permissions.ts:20,50-145,251` |
| **2** | **Flag prod inactivable** | env `AUDIO_MONITORING_ENABLED` (défaut `'false'`), câblé en dur dans le service de déclenchement : `if (NODE_ENV==='production' && flag!=='true')` → écoute **impossible**. Pattern = `MockPositionEmitter` | `apps/api/src/config/env.validation.ts:3,27` + pattern `mock-position-emitter` (`if nodeEnv==='production' return`) |
| **3** | **Super-admin NE déclenche PAS en prod** | **guard dédié** `AudioMonitoringGuard` : `if (NODE_ENV==='production' && role===SUPER_ADMIN)` → `ForbiddenException`. En dev/test : super-admin autorisé. Distinction **par environnement**, pas que par rôle | nouveau guard, modèle `roles.guard.ts` + `ConfigService<Env>` |
| **4** | **Motif obligatoire** | DTO `reason` **requis non-vide** (`@IsString @IsNotEmpty @MaxLength`), validé serveur ; pas de création de commande sans motif | modèle `request-engine-command.dto.ts` (mais `reason` y est **optionnel** → ici **obligatoire**) |
| **5** | **Attestation à l'activation** (générique, client) | écran d'activation par flotte : case **« j'atteste, au nom de mon organisation, avoir informé occupants/conducteurs + posé la signalétique »** → stocké (`attestedBy/attestedAt/attestationVersion`) sur `FleetAudioConfig`. Activation **refusée** sans attestation | nouveau modèle + endpoint `PATCH /fleets/:id/audio-config` |
| **6** | **Mail automatique à la flotte** | à l'activation → `EmailService.send()` à **tous les users actifs** de la flotte (`user.findMany({fleetId, isActive:true})`) avec un template **obligations** | `apps/api/src/email/email.service.ts:1-225` + pattern `users.controller.ts:295-309` (query flotte) |
| **7** | **Audit immuable** (qui/quand/véhicule/motif) | modèle `AudioMonitoringCommand` **append-only** (miroir `EngineControlCommand`) + historique admin (réutilise le pattern `/admin/activity/engine-commands`). Jamais modifiable/supprimable par l'usage | `schema.prisma:944-976` (miroir) + `user-activity.service.ts:246-321` (pattern audit) |
| **8** | **Rétention courte + purge auto** | env `AUDIO_RETENTION_DAYS` (défaut court, ex. 7) + cron purge (miroir `LogCleanupService`). **NB : sans objet en scénario A (appel live, pas de fichier)** | `apps/api/src/observability/log-cleanup.service.ts:1-40` + `env.validation.ts:96` (pattern jours configurables) |

**Tests de sécurité (priorité absolue, modèle `night-watchman.security.spec.ts`)** : super-admin bloqué en prod (#3), motif obligatoire (#4), flag off → écoute impossible (#2), scope tenant strict, perm requise. Reflète les `@Roles`/guards réellement posés.

---

## 4. DEV vs PROD (le pivot des garde-fous #2 et #3)
- `NODE_ENV` (`env.validation.ts:3`, enum `development|production|test`).
- Pattern de flag : `WIRE_LOG_ENABLED`/`MOCK_POSITIONS` = `z.string().default('false')`, lus via `config.get('X',{infer:true})==='true'`.
- Pattern « désactivé en prod » déjà utilisé : `MockPositionEmitter` → `if (!enabled || nodeEnv==='production') return`.
- `ConfigService<Env, true>` injecté dans les services → **on a tout** pour un flag OFF + un gate prod.

---

## 5. Modèle de données (esquisse — à figer en Phase 2 / PLAN.md)
- **`AudioMonitoringCommand`** (miroir `EngineControlCommand`, append-only) : `trackerId`, `vehicleId`, `fleetId`, `status` (PENDING/SENT/ACKNOWLEDGED/FAILED…), **`reason` (NOT NULL)**, `requestedBy`, `requestedInEnv` (dev/prod, traçabilité garde-fou #3), `source`, timestamps. = **l'audit immuable** (#7).
- **`FleetAudioConfig`** : `fleetId` (unique), `enabled` (défaut false), `attestedBy`, `attestedAt`, `attestationVersion`, `retentionDays`. = activation #1/#5.
- **`AudioClip`** (scénario B uniquement) : `commandId`, stockage (bytea / clé objet), `recordedAt`, `expiresAt`. Soumis à la purge #8. **N'existe pas en scénario A.**

---

## 6. Stockage + rétention
- **Stockage binaire : INEXISTANT** dans Tracky (ni S3, ni multer, ni disque, ni bytea ; wire_logs = texte). À **construire uniquement en scénario B**, et **seulement** une fois le canal/format Baanool connu.
- **Rétention/purge : pattern complet existant** (`LogCleanupService`, `DataRetentionService`, `user-activity purgeOld` + env jours configurables) → un `AudioRetentionService` (cron 3h45, `AUDIO_RETENTION_DAYS`) se calque dessus en quelques lignes.

---

## 7. Stratégie de test SANS PROD (jamais d'écoute réelle)
- **Device mocké** : `socket-registry.send()` mocké (ou sim Coban TCP local comme en S2/S3) → on vérifie que la **trame de commande** est bien formée + dispatchée, **sans** boîtier réel.
- **Garde-fous testés en unitaire** (modèle `night-watchman.security.spec.ts`) : `NODE_ENV='production'` ⇒ super-admin → 403 (#3) ; flag off ⇒ déclenchement impossible (#2) ; DTO sans motif ⇒ rejet (#4) ; scope tenant ; perm requise ; reflète les guards posés.
- **Activation** testée : sans attestation ⇒ refus (#5) ; activation ⇒ mail flotte envoyé (EmailService mocké) (#6).
- **Rétention** : insère un clip « vieux » ⇒ le cron le purge (#8, scénario B).
- **Aucune** commande monitor envoyée à un véhicule réel pendant le dev.

---

## 8. Risques
1. **#1 Modèle hardware (live call vs clip) — bloquant pour la réception/stockage** (cf §0). Sans source Baanool, la partie « réception du vocal » est à l'aveugle.
2. **Juridique** (hors sprint, responsabilité exploitant) : mandat client, information occupants, signalétique, AIPD/CNIL, DPO. Le code empêche l'abus mais ne remplace pas la conformité. La fonction reste **inactive en prod via le flag #2** tant que ce volet n'est pas acté.
3. **Réception binaire** (scénario B) : nouveau sous-système (endpoint callback + auth device + ingestion) — surface d'attaque + à sécuriser (qui peut pousser un clip ?).
4. **Confusion de priorités ACK** : le pattern audio ne doit pas voler l'ACK moteur (priorité dédiée, comme engine=10).
5. **« Déployé et oublié actif »** : couvert par #2 (flag) — à ne jamais retirer.

---

## 9. Questions à trancher AVANT Phase 2 (le STOP)
1. **Scénario A (appel live) ou B (clip uploadé) ?** → fournis la **doc Coban/Baanool** (commande monitor + canal/format de retour). Détermine §5/§6 et le garde-fou #8.
2. **Durée de rétention par défaut** (#8, si B) : 7 j ? configurable par flotte ?
3. **Rôles autorisés à déclencher en prod** : confirmé = **fleet admin du client uniquement** (super-admin bloqué en prod). FLEET_MANAGER autorisé ou non ?
4. **Périmètre Phase 2 immédiat** : je propose de construire **commande + 8 garde-fous + attestation + mail + audit (device mocké)** maintenant, et de **différer la réception/stockage** au scénario confirmé. OK ?

---

**STATUT : Phase 1 (analyse) terminée. STOP — j'attends ta validation de l'analyse + du placement des garde-fous, et surtout la réponse au §0/§9.1 (modèle A/B + source Baanool), avant de produire le PLAN.md et de coder.**
