# 19 — Contre-expertise indépendante du chantier « fiabilité coupe-circuit »

Date : 13 septembre 2026, 22 h 20 → 23 h 30 (Europe/Paris)
Auteur : audit automatisé indépendant (Claude), à la demande du propriétaire
Statut : **rapport de revue — n'autorise aucun changement de production**

Ce document contient **tout** ce qui a été fait, vu, mesuré et conclu pendant la contre-expertise :
le verdict, les notes, le plan d'action concret, la reconstitution de l'incident, chaque défaut avec
fichier et ligne, les réponses aux vingt questions posées, les preuves (tests exécutés, base relue,
VPS lu), et les annexes permettant de rejouer chaque vérification.

---

## 0. Périmètre, règles suivies et méthode

### 0.1 Ce qui a été audité

| Dépôt | Worktree | Branche | HEAD attendu | HEAD constaté | Base |
|---|---|---|---|---|---|
| Tracky | `D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky-reliability-sep2026` | `codex/tracky-cutoff-reliability-2026-09-12` | `b5ec9d19` | `b5ec9d19` ✅ | `909ea552` (merge-base avec `main`) |
| Texto | `D:\www\vizyo-agency\vizyo-texto-reliability-sep2026` | `codex/gateway-health-reliability-2026-09-13` | `549ac01` | `549ac01` ✅ | `1bd2def` ✅ |

Les six commits Tracky (`ab994ebd`, `c3e896b6`, `e2843c59`, `cd0a117a`, `ae61b4dc`, `b5ec9d19`) ont été
analysés comme une série et par rapport au code préexistant, pas seulement le dernier.

### 0.2 Règles respectées

- Aucun commit, aucun push, aucun déploiement, aucun redémarrage de service ou conteneur.
- Aucun SMS envoyé, aucune commande CUT/RESTORE déclenchée, aucun horaire activé.
- Aucun fichier modifié pendant la phase de revue. Un seul fichier de test **temporaire** a été créé
  ensuite pour prouver le défaut principal, exécuté, puis **supprimé** ; `git status --porcelain` est
  vide dans les deux worktrees à la fin.
- VPS consulté **strictement en lecture** (`docker ps`, `git log`, `SELECT`, `GET` sur l'API capcom6
  depuis l'environnement du conteneur du relais). Aucun secret affiché, aucune valeur de `.env` lue
  en clair (seuls les **noms** de variables ont été listés).
- Les documents 01 à 18 et le README du dossier ont été lus en entier, dans l'ordre conseillé.

### 0.3 Méthode, dans l'ordre

1. Vérification de l'état git des deux worktrees (branche, HEAD, propreté, `git worktree list`).
2. Lecture intégrale des 19 documents.
3. Diff par commit ; **normalisation prettier** de chaque fichier du dernier commit pour isoler le
   fonctionnel du reformatage (voir §16 et annexe D).
4. Lecture complète (pas d'extraits) des fichiers de cœur : `engine-control.service.ts` (2 275 l.),
   `sms-gateway.service.ts` (1 322 l.), `schedule-cron.service.ts`, `automatic-cut-queue.ts`,
   `vehicle-schedules.service.ts`, `fleet-schedules.service.ts`, `sms-gateway-watchdog.service.ts`,
   `sms-webhook.controller.ts`, `sms-admin.controller.ts`, `positions.service.ts` (diff),
   `vehicles.service.ts` (diff), migration SQL et `schema.prisma`, contrôleur et DTO moteur, composants
   web (`engine-control-button`, `confirm-modal`, `map`, `admin-sms`, `fleet-schedules`), côté Texto
   `env.ts`, `capcom6.service.ts`, `messages.service.ts`, `messages.controller.ts`,
   `webhooks.controller.ts`, `webhook-delivery.service.ts`, `api-key.guard.ts`, et les specs.
5. Exécution locale : typechecks, suites de tests complètes (API, Web, partagé, smoke, Texto), builds
   (API, Web, Texto), `prisma validate`, audits de dépendances.
6. Vérifications externes : contrat OpenAPI public de SMS Gateway (`swagger.json` v1.75.1) et sources
   amont du serveur (`android-sms-gateway/server`) pour la sémantique de `/health`, de `lastSeen`,
   des champs de `Device` et des options d'envoi (`ttl`, `priority`, `deviceId`, `DELETE`).
7. VPS en lecture seule : conteneurs et versions, commits déployés, statistiques des commandes moteur
   et des messages du relais, `GET /3rdparty/v1/health` et `/devices` du serveur capcom6 (trois relevés
   espacés pour mesurer la cadence de `lastSeen`).
8. Preuve exécutable du défaut principal (test temporaire contre le service réel), puis nettoyage.

---

## 1. VERDICT : **NO-GO**

- NO-GO pour la **fusion** de la branche Tracky en l'état.
- NO-GO pour le **déploiement** de la branche Tracky, **y compris « avec horaires désactivés »**.
- NO-GO pour la **réactivation des horaires automatiques**.
- Le relais Texto est **déployable sous conditions** (endpoint additif et sûr), mais il ne suffit pas
  seul et son seuil de fraîcheur doit d'abord être aligné sur la cadence réelle du téléphone.

La raison principale n'est pas un oubli : c'est une **régression introduite par la correction**.
Une RESTORE partie par SMS et jamais acquittée par le boîtier conserve sa clé d'unicité `activeKey`
**indéfiniment**. Toute RESTORE ultérieure sur ce boîtier — planning du lendemain **ou clic manuel** —
est « dédupliquée » vers la vieille commande : **rien n'est envoyé, rien n'est réarmé, aucune nouvelle
alerte n'est écrite, et le cron considère la transition comme aboutie**. La base de production
montre qu'une RESTORE par SMS sans accusé survient **presque chaque jour**. Le défaut a été démontré par
un test exécuté contre le code réel de la branche (§6, P0-1 ; annexe C).

### Notes

| Volet | Note |
|---|---|
| Qualité du diagnostic initial | **15 / 20** |
| Qualité des corrections Tracky | **15 / 30** |
| Qualité des corrections Texto/Android | **9 / 20** |
| Qualité des tests, de l'observabilité et de la procédure de déploiement | **14 / 30** |
| **Note globale** | **53 / 100** |

Le détail de chaque note (réussites et points perdus) est au §17.

---

## 2. Résumé exécutif (langage simple)

Le chantier a bien compris l'incident et a construit l'essentiel de ce qui manquait : une intention de
rallumage qui survit à tout, un worker qui retente, un secours SMS après un accusé TCP manquant, un
kill-switch, un interlock, une file anti-rafale, une interface qui ne dit plus « rallumé » quand rien
ne le prouve. Les suites de tests passent — je les ai relancées et j'obtiens exactement les chiffres
annoncés.

Mais le code, tel qu'il est, **ne peut pas partir en production** : la clé posée pour empêcher deux
rallumages simultanés n'est jamais libérée quand le rallumage part par SMS sans accusé du boîtier —
c'est le cas de loin le plus fréquent (2 accusés SMS en cinq semaines). Dès le lendemain, le rallumage
de ce véhicule, automatique ou manuel, est absorbé en silence. C'est exactement l'immobilisation
silencieuse que le chantier voulait rendre impossible, et elle se produirait environ **une fois par
jour** au rythme actuel des replis SMS.

À côté de ce point, quatre autres bloquent la réactivation des horaires : la branche est en conflit
avec `main` (qui a été **déployé ce soir même** en production) à cause d'un reformatage massif ; le
téléphone doit être configuré (ping ≤ 60 s) et le seuil de fraîcheur aligné, sinon la sentinelle
alerte en boucle et l'interlock reste rouge sans panne ; l'interlock exige un SMS « remis » depuis
moins de 24 h alors que la seule preuve régulière est hebdomadaire ; les SMS de coupure n'ont aucune
validité et peuvent s'exécuter après le rallumage du matin.

Une fois ces points corrigés — quelques jours de travail ciblé, testable en local pour l'essentiel —
le lot devient un bon candidat pour une recette réelle sur véhicule pilote.

---

## 3. CE QU'IL FAUT FAIRE CONCRÈTEMENT pour que tout refonctionne

Ordre obligatoire. Chaque phase a une condition de sortie vérifiable. Les estimations sont des ordres
de grandeur pour un développeur qui connaît le dépôt.

### Phase 0 — Tout de suite (lundi 14/09), sans code

La production tourne sur `main` `66d286f5` (relancé le 13/09 à 22:25) : **aucun des correctifs de la
branche n'y est**. Les défauts du 11/09 y sont donc intacts (`queued` = envoyé, pas de repli après
timeout d'ACK, pas de réconciliation, pas d'alerte).

1. Laisser CDEF31 (0/30) et MH Cars (0/7) **désactivés** ; `ENGINE_AUTOMATIC_CUT_ENABLED` n'existe pas
   encore en production (variable de la branche) — ne rien changer au `.env.prod`.
2. Dimanche soir / lundi 06:30 : contrôle **physique** des véhicules nécessaires ; tout RESTORE manuel
   parti par SMS doit être vérifié sur place (aucune preuve logicielle n'existe aujourd'hui).
3. Un opérateur d'astreinte avec la liste des plaques et la procédure manuelle (doc 06 §« véhicules
   ne redémarrent pas »).
4. Ne pas mettre à jour SMSGate ni Android sur l'unique téléphone (doc 08) tant que le second
   appareil n'existe pas.
5. Sur le téléphone, deux réglages sans risque et utiles dès maintenant : **ordre de traitement FIFO**
   (« older messages first ») et **délai minimum entre SMS 10-15 s** (Settings → Messages). Le ping
   sera réglé en phase 3.

### Phase 1 — Corrections Tracky (estimation : 2 à 3 jours)

**1.1 P0-1 — libérer/réarmer la clé RESTORE** (`apps/api/src/engine-control/engine-control.service.ts`)

- Dans le bloc de collision `P2002` (lignes 827-855) : si la commande active est une RESTORE en
  `SENT` **et** (`nextAttemptAt` nul **ou** `lastAttemptAt` plus vieux que N minutes, N = 10), la
  **réarmer** : `updateMany({ where: { id, ackedAt: null }, data: { nextAttemptAt: now, dispatchLeaseUntil: null, smsAttemptCount: 0, lastError: 'Intention réarmée par une nouvelle demande RESTORE' } })`,
  émettre l'événement WS, journaliser, et retourner la commande réarmée. Une RESTORE est idempotente :
  la renvoyer ne coûte qu'un SMS.
- Dans `cloturerCommandesPerimees` (lignes 222-254) : ajouter une branche RESTORE avec une échéance
  dédiée `ENGINE_RESTORE_EXPIRY_MIN` (défaut 120) : `status SENT, ackedAt null, sentAt < now − échéance`
  → `SENT_UNCONFIRMED`, `activeKey null`, `expiredAt now` (sans toucher `alertedAt`). La clé ne peut
  plus vivre plus de deux heures.
- Dans `positions.service.ts` ligne 32 : remplacer la fenêtre de 30 min par 24 h (une remontée
  d'ignition prouve que le moteur démarre, quel que soit le délai), ou par « RESTORE `SENT` plus récente
  que la dernière CUT du boîtier ».
- Dans le worker (lignes 1629-1651), après `delivered` : ne pas laisser `nextAttemptAt` nul pour
  toujours ; programmer une relance TCP unique à +10 min si aucune preuve n'est arrivée (elle sera
  gratuite si la socket est revenue, et sinon sans effet).
- UI (`engine-control-button.component.ts` lignes 823-861) : si `cmd.createdAt` est antérieur de plus
  de 60 s au clic, afficher « Un rallumage est déjà en cours depuis HH:MM (tentative n, canal X) — il
  vient d'être réarmé », jamais « Commande enregistrée ».
- Tests à écrire (obligatoires) : « RESTORE du lendemain après RESTORE SMS `delivered` non acquittée →
  un nouvel envoi part » ; « clic manuel sur RESTORE parquée → réarmement, `sms.send` appelé » ;
  « clôture des RESTORE `SENT` de plus de 120 min libère la clé ».

**1.2 P1-1 — relancer TCP à la reconnexion, ne jamais rendre une RESTORE terminale**

- Dans `SocketRegistryService` (ou le listener TCP qui enregistre le login d'un boîtier) : émettre
  `tracker.connected { imei }` via `EventEmitter2`.
- Dans `EngineControlService` : `@OnEvent('tracker.connected')` → pour la dernière commande du
  boîtier, si c'est une RESTORE non acquittée (`PENDING`/`SENT`/`FAILED`/`SENT_UNCONFIRMED`) **plus
  récente que la dernière CUT**, la remettre en `PENDING`, `channel null`, `nextAttemptAt now`,
  `activeKey` reposé si libéré (attention à l'unicité : si une autre RESTORE est active, réarmer
  celle-là). Le worker refera TCP puis SMS.
- Après épuisement des 3 SMS (lignes 1472-1486 et 1680-1691) : garder l'alerte CRITICAL, mais ne pas
  fermer l'intention : statut `SENT` avec `nextAttemptAt = +30 min` (relance TCP seulement, pas de SMS
  supplémentaire) jusqu'à preuve, réarmement humain ou reconnexion. Si le choix de conserver `FAILED`
  est maintenu, documenter que « jamais abandonnée » signifie « alertée » et corriger README/doc 03.
- Test : « boîtier hors ligne, 3 SMS échouent, reconnexion TCP → K envoyé et ACK → ACKNOWLEDGED ».

**1.3 P2-1 — garder l'ACK pendant l'envoi SMS**

- `dispatchSmsAttempt` (lignes 1450-1464) et le chemin SMS de `dispatchCommand` (1141-1165) :
  remplacer `update({ where: { id } })` par `updateMany({ where: { id, ackedAt: null, status: SENT|PENDING } })` ;
  si `count === 0`, relire la commande et ne rien écraser. Test : ACK simulé entre `send` et `update`.

**1.4 P2-4 — dispatcher une CUT `PENDING` orpheline**

- Dans le bloc `P2002` : si `active.status === PENDING` → appeler `dispatchCommand` sur cette commande
  au lieu de la retourner telle quelle. Test : CUT créée puis « crash », nouvelle CUT → envoi.

**1.5 P2-2 — cesser la tempête d'alertes du kill-switch**

- Ligne 404-411 : une ligne par (véhicule, cause) et par heure, niveau `WARNING` (c'est un état voulu,
  pas une panne) ; garder `CRITICAL` pour l'interlock (lignes 1030-1037) mais une fois par raison et
  par 15 min. Test : 10 appels bloqués en 5 min → 1 ligne.

**1.6 P2-5 — rappel des RESTORE qui traînent**

- `alertOverdueRestores` : tant qu'une RESTORE n'est pas terminale, ré-alerter toutes les 15 min
  (`alertedAt` plus vieux que 15 min ⇒ nouvelle ligne). Après 60 min en `queued`, retenter un SMS
  (nouvelle tentative) au lieu de repoller à l'infini.

**1.7 P2-3 — glissement réellement volontaire** (`confirm-modal.component.ts` lignes 340-355)

- Exiger un `pointerdown` sur le curseur puis au moins 8 événements `input` **croissants** partant de
  < 10 avant d'accepter ≥ 98 ; ignorer `End`, `PageUp`, `Home` au clavier (ou proposer une confirmation
  clavier explicite distincte). Test : `slider.value='100'` + `change` sans `input` progressifs → refusé.

**1.8 P2-6 — ne pas suspendre le clic derrière la file SMS**

- `requestCommand` (source `MANUAL`) : répondre après persistance + première tentative TCP ; si le
  repli SMS doit attendre la file, retourner la commande en `PENDING`/`SENT` et laisser le worker/WS
  finir. Bornage simple : `Promise.race` avec 20 s.

**1.9 Tests et schéma**

- Ajouter `engineDeliveryAttempt: { create, updateMany }` au harnais de `engine-control.service.spec.ts`
  (aujourd'hui le délégué vaut `undefined` : la table n'est jamais exercée).
- Ajouter `@@index([action, status, nextAttemptAt, dispatchLeaseUntil])` sur `EngineControlCommand`
  dans `schema.prisma` (l'index existe dans la migration, pas dans le schéma).
- Test du changement d'heure du 25/10/2026 sur l'évaluateur.

### Phase 2 — Corrections Texto (estimation : 1 jour)

**2.1 P0-2 — options d'envoi : validité, priorité, appareil**

- `SendSmsDto` : `ttlSeconds?`, `priority?` (0-127), `simNumber?` optionnels.
- `Capcom6Service.send(to, text, opts)` : passer `ttl`, `priority`, `deviceId` (nouvelle variable
  `CAPCOM6_DEVICE_ID`, l'identifiant du S21 vu dans `/3rdparty/v1/devices`), `withDeliveryReport: true`.
- Nouvelle route `DELETE /v1/texto/:id` (tenant authentifié) → `DELETE /3rdparty/v1/messages/{providerId}`
  (annulation d'un message encore en file sur le téléphone).
- Côté Tracky : `trySmsFallback` envoie `ttlSeconds: 900` pour une CUT et `priority: 100` pour une
  RESTORE ; le chemin « RESTORE supplante CUT » (lignes 790-810) appelle l'annulation pour chaque CUT
  supplantée qui a un `smsLogId` (best-effort, journalisé).
- Vérifier sur le serveur 1.43.0 (test sur numéro neutre) que `ttl`, `priority` et `DELETE` sont
  honorés ; sinon, mettre à jour le serveur capcom6 (conteneur, pas le téléphone) avant.

**2.2 P1-2 — fraîcheur crédible**

- `env.ts` : borner `deviceStaleSeconds` dans [30, 3600] ; séparer `CAPCOM6_SEND_TIMEOUT_MS` (défaut
  9 000, inférieur aux 10 s de Tracky) du délai de santé `CAPCOM6_REQUEST_TIMEOUT_MS` (5 000).
- `messages.service.ts` : évaluer la fraîcheur sur **l'appareil configuré** (`CAPCOM6_DEVICE_ID`),
  exposer `simCards` s'il est fourni, et renvoyer un état à quatre valeurs (`ONLINE`, `STALE`,
  `OFFLINE`, `UNKNOWN`) en plus du booléen.

**2.3 P1-3 — pousser les statuts sortants au tenant** (ou renoncer au webhook côté Tracky)

- `webhooks.controller.ts` `handleStatus` : retrouver le message, son tenant, et enfiler via
  `WebhookDeliveryService` un envoi signé vers `<callbackUrl>/status` (ou une colonne
  `statusCallbackUrl`) avec `{ providerId, id, status, errorCode, errorMessage }` — le récepteur Tracky
  (`POST /sms/webhook/status`) existe déjà. Persister `errorCode/errorMessage` du `sms:failed` (CC-013).

**2.4 Style** : remettre les guillemets simples (le reste du dépôt), par ex. `prettier --single-quote`
sur les cinq fichiers touchés.

### Phase 3 — Téléphone et configuration (estimation : ½ journée, avec le téléphone en main)

1. SMSGate → Settings → **Ping** : intervalle **60 s**. Vérifier 30 min écran éteint, application en
   arrière-plan, que `lastSeen` (via `/v1/texto/health`) avance à chaque minute. Si Android le diffère
   (c'est le mode de panne du 11/09), c'est justement ce que la sentinelle doit voir : ne pas masquer en
   augmentant le seuil au-delà de 5 min.
2. Settings → Messages : **FIFO**, délai min 10 s / max 15 s, limite active (par ex. 20 / 10 min),
   **SIM 1 fixée**.
3. Relais : `CAPCOM6_DEVICE_STALE_SECONDS=240` (2 pings manqués + persistance par lots ≤ 60 s),
   `CAPCOM6_SIM_NUMBER=1`, `CAPCOM6_DEVICE_ID=<id du S21>`, `CAPCOM6_REQUEST_TIMEOUT_MS=5000`,
   `CAPCOM6_SEND_TIMEOUT_MS=9000`.
4. Relever et conserver : version Android/One UI, SMSGate, serveur capcom6 (1.43.0 aujourd'hui),
   opérateur, SIM, `deviceId`.

### Phase 4 — Preuve quotidienne et interlock (estimation : ½ journée)

- Étendre `SmsHeartbeatService` : deux passages quotidiens à **04:30** et **06:30** Europe/Paris
  (T-30 min avant les fenêtres MH Cars 05:00 et CDEF 07:00), SMS court vers un numéro neutre — ou
  vers **la SIM du téléphone lui-même** (prouve émission + réception + webhook entrant) — puis
  vérification à +10 min par `reconcileOutboundStatus` jusqu'au terminal. Coût : ~2 SMS/jour.
- L'interlock lit déjà `lastTerminalSuccessAt` ; avec cette preuve il redevient vert chaque matin.
- Sentinelle Android : hystérésis (2 ticks mauvais pour ouvrir, 3 bons pour fermer).

### Phase 5 — Fusion et déploiement (dans cet ordre, rien avant)

1. Nettoyer le diff : pour les cinq fichiers reformatés par `b5ec9d19`, repartir de la version `main`
   et réappliquer **uniquement** les hunks fonctionnels (annexe D les liste) ; rebaser sur `main`
   (production = `66d286f5`, 27 commits depuis la base, 3 migrations `20260913*`) ; résoudre le conflit
   sur `background-tasks.service.ts` ; `pnpm verify` complet (suite en série si instable).
2. Sauvegarde des deux bases ; `.env.prod` complété (variables de la branche, kill-switch `false`).
3. Rejouer la migration `20260912110000_engine_delivery_reliability` sur une **copie** PostgreSQL de
   production **après** `20260913140000`, `20260913170000`, `20260913200000` (ordre non chronologique,
   accepté par `migrate deploy` — à démontrer, pas à supposer) ; rollback applicatif à blanc.
4. Téléphone (phase 3) **avant** le relais.
5. Déployer Texto ; `GET /v1/texto/health` avec la clé Tracky → `operational=true`, `device.fresh=true`,
   `device.count=1`, `sim.configuredNumber=1`.
6. Déployer Tracky **avec `deploy/vps/deploy.sh` uniquement** (règle D1 ; garde HH:42–HH:46 ; jamais
   `docker compose up` à la main), kill-switch `false` ; vérifier l'artefact compilé **dans le
   conteneur** ; 30 min sans alerte de la sentinelle ; écran SMS admin vert.
7. Preuve quotidienne active et observée `delivered` ; 24 h sans faux positif au centre d'alertes.
8. Recette sur boîtier de banc : RESTORE TCP avec ACK ; socket coupée → attente → SMS cadencé →
   statut terminal → ignition ; **RESTORE le lendemain sur le même boîtier** (le scénario P0-1) ;
   redémarrage de l'API avec une RESTORE en attente ; téléphone redémarré sans déverrouillage ; CUT
   puis RESTORE rapprochées avec SMS retardé (P0-2).
9. Canari : un véhicule MH Cars, puis un CDEF31, un à la fois, présence physique, kill-switch `true`
   **seulement** pendant la fenêtre, puis `false`.
10. Réactivation progressive par groupes de 3 à 5 ; jamais les 37 ; surveillance 04:45–05:30 et
    06:45–07:30 ; liste nominative des véhicules sans preuve à 05:10 et 07:10.
11. Rollback à tout moment : kill-switch `false`, horaires désactivés, `deploy.sh --repli <étiquette>`,
    migration et journaux conservés ; **ne jamais vider `engine_control_commands` pour « débloquer »
    une clé** — corriger le code.

### Phase 6 — Court terme (semaines suivantes)

- Second téléphone + seconde SIM (autre opérateur), enregistré sous un `deviceId` distinct, avec la
  santé multi-appareils corrigée (2.2) **avant** l'enregistrement ; bascule explicite par verdict.
- Lot séparé de mise à jour des dépendances (§14) — pas dans cette livraison.
- Campagne doc 05 (7 jours de préflight, 3 jours de canari, 100 cycles sur banc).

---

## 4. Reconstitution de l'incident du 11 septembre

### 4.1 Faits prouvés (code, base, documents, VPS)

- 07:00 : 22 RESTORE dues ; 10 ACK TCP ; 2 écritures TCP sans ACK (GS-138-LT, GS-878-NX) **sans aucun
  repli** ; 10 replis SMS créés en ~6 s ; 5 `Delivered`, 5 `RESULT_ERROR_GENERIC_FAILURE`.
- Base relue le 13/09 (7 jours) : `RESTORE|ACKNOWLEDGED|TCP` 157, `RESTORE|SENT_UNCONFIRMED|SMS` 19,
  `RESTORE|SENT_UNCONFIRMED|TCP` 4, `CUT|ACKNOWLEDGED|TCP` 109, `CUT|SENT_UNCONFIRMED|SMS` 5,
  `CUT|SENT_UNCONFIRMED|TCP` 3. Par jour (30 j), RESTORE sans accusé : 11/09 → 16 SMS + 3 TCP ;
  1er, 2, 3/09 → 6 SMS chacun ; 4, 5, 6, 7, 8, 9/09 → 1 SMS chacun. Les chiffres du document 14
  (« 23 RESTORE non confirmés dont 19 SMS ») sont **exacts**.
- Code d'origine : repli SMS uniquement si `registry.send()` rend `false` ; timeout d'ACK muet ; `queued`
  → `SENT` ; cron avançant `lastEvaluatedState` dès qu'aucune exception n'est levée (encore vrai dans
  la branche, `schedule-cron.service.ts:426-430`, et c'est voulu : le worker durable prend la suite).
- Le relais Texto **ne pousse aucun statut sortant** au tenant : `src/webhooks/webhooks.controller.ts:114-124`
  met à jour sa propre table et s'arrête ; `webhook-delivery.service.ts` ne transporte que les SMS
  entrants. Sa table connaît pourtant la vérité : sur 7 jours, 13 `failed`, 6 `sent`, 6 `delivered`.
  Tracky, lui, n'a vu qu'une seule preuve `delivered` (document 14).
- Téléphone (doc 10) : ping non configuré, LIFO, ni délai ni limite, SIM par défaut ; redémarrage
  vers 20:56 ; refus de service de premier plan à 21:55 ; reprise tardive (1 h 06) de FG-669-DQ.
- Serveur capcom6 en production : **1.43.0** (`releaseId` 1448) ; `/3rdparty/v1/health` renvoie
  `{"status":"pass","checks":{"db:ping":…}}` : **il ne teste que la base MariaDB**, rien du téléphone
  (confirmé aussi dans les sources amont : le seul fournisseur de santé est `modules/db/health.go`).
- Un seul appareil enregistré (`samsung/o1sxeea`). `lastSeen` = `2026-09-13T20:52:50Z` relevé à
  20:57:30, 20:59:32 et 21:02:02 (âge 280 → 400 → 552 s), téléphone au repos.

### 4.2 Hypothèses fortes

- La rafale de 10 SMS sans pacing côté téléphone a déclenché les erreurs génériques (succès et échecs
  dans la même seconde ; groupes d'échecs identiques les 31/08, 1er et 2/09).
- La chaîne décrite dans la mission (ACK TCP absent → bascule SMS → relais joignable → application
  Android non opérationnelle après reboot → confusion accepté/exécuté → rafale → visibilité nulle)
  est **confirmée** par le code et les données ; elle doit être complétée par un maillon : **le relais
  garde les statuts pour lui**, et **`/health` du fournisseur ne dit rien du téléphone**.

### 4.3 Non vérifié

- La couche exacte (modem, SIM, Free, Android) des `RESULT_ERROR_GENERIC_FAILURE` — pas de `logcat -b radio`.
- Les versions du serveur capcom6 et de l'application au 11/09 (seulement celles d'aujourd'hui).
- La cadence exacte de mise à jour de `lastSeen` en 1.43.0 (les sources amont actuelles la persistent
  par lots d'une minute à chaque appel authentifié de l'appareil ; la version déployée peut différer).
- L'idempotence de `stop123456`/`resume123456` sur le boîtier réel : idempotentes **par conception**
  (elles fixent un état, elles ne le basculent pas) ; non mesurée ici.

---

## 5. Corrections correctement réalisées (prouvées dans le code et les tests)

| Protection | Preuve (fichier:lignes, tests) |
|---|---|
| Intention persistée avant tout I/O, `nextAttemptAt` initialisé | `engine-control.service.ts:813-826` |
| Idempotence serveur : `idempotencyKey` unique, relecture limitée au même boîtier, action opposée refusée, collision inter-véhicule refusée | `:426-438`, `:827-855` ; tests spec 2189-2282 |
| Journal des tentatives (canal, statut, `providerId`, `smsLogId`, code brut, horodatages) | migration `20260912110000`, `:1043-1077` |
| Attente TCP courte avant de payer un SMS (RESTORE, socket absente) | `:1096-1121` ; test 2334 |
| Fallback SMS durable après timeout d'ACK TCP — le trou du 11/09 | `:1360-1383` → worker `:1609-1617` ; test 2284 |
| Worker RESTORE 15 s, lease 60 s, anti-chevauchement, reprise après redémarrage, retries bornés, alerte CRITICAL à 60 s réarmée si non persistée, FAILED remonté | `:1532-1803` ; tests 2379-2534 |
| RESTORE supplante toute CUT en vol ; ACK tardif d'une CUT supplantée ignoré | `:790-810`, `:1316-1325` |
| Kill-switch fail-closed (variable absente ou mal orthographiée = bloqué) ; `NODE_ENV=production` confirmé | `:398-415` ; `deploy/vps/Dockerfile.api:25`, `docker-compose.prod.yml:99` ; test 2106 |
| Interlock avant CUT automatique : relais joignable, téléphone frais, preuve de remise < 24 h, file < 10 ; cache 30 s (10 s sur erreur) | `:974-1041` ; test 2139 |
| File anti-rafale CUT : la base est la file (`lastEvaluatedState` non avancé), 1 départ / 10 s, RESTORE évaluées d'abord, bulk sans CUT dans la requête HTTP | `automatic-cut-queue.ts`, `schedule-cron.service.ts:155-219`, `:320-327`, `vehicle-schedules.service.ts:176-184` ; tests « 37 véhicules », « priorité » |
| File SMS locale cadencée 15 s (prod), priorité RESTORE 100 > CUT 50 > autres, FIFO à priorité égale | `sms-gateway.service.ts:226-239`, `:729-800` ; test « 22 RESTORE » |
| `queued`/`SENT` ne valent plus rallumage : projection API, WS, carte, fiche | `vehicles.service.ts:1125-1146`, `realtime.service.ts:487-492`, `engine-control-button.component.ts:392-400`, `:509-521` |
| Carte et fiche unifiées sur `EngineControlButtonComponent` | `map.component.ts:73`, `:1435` |
| `disableSchedule` refusé sur RESTORE, gardé par `schedules_manage` ; action manuelle = override jusqu'à la prochaine bascule, planning conservé | `engine-control.controller.ts:57-69`, `engine-control.service.ts:716-787` ; tests contrôleur et évaluateur |
| Sentinelle Android : aucun SMS, dédup par épisode, rappel 15 min, réarmement, anti-chevauchement ; ne peut pas faire tomber l'API (`ErrorLogger.record` ne lève jamais, `error-logger.service.ts:153-176`) ; démarrage vérifié | `sms-gateway-watchdog.service.ts` ; smoke-boot 5/5 |
| Texto : endpoint authentifié par le guard tenant, route `health` déclarée avant `:id`, compteurs isolés par tenant, échec fermé (HTTP non-2xx, JSON invalide, timeout, tableau vide, date absente/invalide, statut inconnu), aucun numéro ni message exposé, batterie/charge honnêtement indisponibles | `messages.controller.ts`, `messages.service.ts:168-267`, `capcom6.service.ts:68-80` |
| Webhook entrant fail-closed sans secret en production | `sms-webhook.controller.ts:86-98` |

---

## 6. Défauts trouvés

Échelle : **P0** danger immédiat (véhicule potentiellement immobilisé) · **P1** bloquant avant
réactivation des horaires · **P2** important, contournable · **P3** amélioration.

### P0-1 — Une RESTORE `SENT` sans accusé garde `activeKey` pour toujours ; la RESTORE suivante est avalée

- **Fichiers / lignes** : `apps/api/src/engine-control/engine-control.service.ts:789` (clé
  `${trackerId}:${action}`) ; `:827-855` (collision `P2002` → `return active`, sans dispatch ni
  réarmement) ; `:1629-1651` (statut SMS `delivered` → `nextAttemptAt: null`, statut `SENT` et clé
  conservés) ; `:1538-1561` (le worker n'accepte que `nextAttemptAt <= now` ou `PENDING`) ;
  `:222-254` (la clôture périodique exclut explicitement RESTORE) ; `apps/api/src/positions/positions.service.ts:32`
  (confirmation par ignition limitée à 30 min après création) ; `apps/api/src/vehicle-schedules/schedule-cron.service.ts:426-430`
  (aucune exception ⇒ transition aboutie).
- **Scénario concret** : J1 07:00, socket absente → attente 15 s → SMS `resume123456` accepté → statut
  relais `delivered` → commande parquée `SENT`, `nextAttemptAt=null`, `activeKey` gardé (le boîtier ne
  répond « Resume engine Succeed » qu'exceptionnellement ; le conducteur démarre à 08:30, hors fenêtre de
  30 min). J1 20:00 : CUT normale (clé CUT distincte). J2 07:00 : RESTORE → `create` viole `activeKey`
  → retour de la commande de J1 → **aucun TCP, aucun SMS, aucune alerte (déjà `alertedAt`), le cron
  avance `lastEvaluatedState`**. Le véhicule reste coupé. Le clic « Rallumer » d'un opérateur produit
  la même chose : 201, toast « Rallumage en cours — Commande xxxx » avec l'identifiant de la veille.
- **Impact** : immobilisation silencieuse, automatique **et** manuelle, d'au moins un véhicule par jour
  au rythme des replis SMS observés (30 jours relus). Rejoue l'incident du 11/09 par un autre chemin.
- **Raison technique** : `activeKey` n'a aucune durée de vie ; sa libération dépend d'une preuve (ACK
  TCP < 15 s, SMS d'accusé, ignition < 30 min) qui n'arrive pas dans le cas nominal du repli SMS.
- **Preuve exécutée** : test temporaire contre le service réel avec le harnais de mocks de la suite
  (annexe C) : `requestCommand(SCHEDULER, RESTORE)` avec une commande `SENT` de 24 h en base →
  `registry.send` jamais appelé, `sms.send` jamais appelé, `engineControlCommand.update` jamais appelé,
  résultat = commande de la veille ; le prédicat `findMany` du worker exclut `{status:'SENT', nextAttemptAt:null}`.
  3/3 assertions passées, fichier supprimé, worktree propre.
- **Correction** : phase 1.1. **Test** : « RESTORE du lendemain après RESTORE SMS non acquittée ».
- **Statut** : **BLOQUANT** (fusion et tout déploiement).

### P0-2 — Aucune validité sur les SMS CUT : une CUT en retard s'exécute après la RESTORE

- **Fichiers** : `vizyo-texto/src/capcom6/capcom6.service.ts:93-112` (corps `textMessage` +
  `phoneNumbers` [+ `simNumber`] ; ni `ttl`, ni `validUntil`, ni `priority`, ni `deviceId`) ; Tracky
  `engine-control.service.ts:790-810` (la CUT supplantée n'est marquée qu'en base, jamais rappelée du
  téléphone).
- **Scénario** : 20:00 CUT en SMS vers un téléphone endormi (retard de 1 h 06 observé le 11/09 ;
  polling de secours 15 min) ; 07:00 RESTORE en TCP acquittée ; 07:30 le téléphone se réveille et émet
  `stop123456` → véhicule coupé au départ.
- **Raison** : l'API SMS Gateway accepte `ttl`/`validUntil`, `priority` (> 99 contourne limites et
  délais) et `DELETE /3rdparty/v1/messages/{id}` (contrat public v1.75 ; support en 1.43.0 **non vérifié**) ;
  le relais n'utilise rien de cela.
- **Correction** : phase 2.1. **Test** : le relais reçoit `ttl` pour une CUT, jamais pour une RESTORE ;
  supplantation → `DELETE` appelé.
- **Statut** : **BLOQUANT avant réactivation des horaires** (non bloquant pour un déploiement horaires
  désactivés).

### P1-1 — Aucune relance TCP à la reconnexion ; RESTORE abandonnée après 3 SMS et jamais recréée

- **Fichiers** : aucun abonnement à une reconnexion (aucun `@OnEvent` hors `SMS_INBOUND_EVENT`, aucun
  `emit` dans `socket-registry`) ; `engine-control.service.ts:1106-1113` (attente = un seul créneau de
  15 s) ; `:1472-1486` et `:1680-1691` (`FAILED` terminal, clé libérée) ; `schedule-cron.service.ts:426-430`.
- **Scénario** : boîtier hors ligne, 3 SMS échouent (téléphone mort) → `FAILED` + alerte ; le boîtier
  revient en TCP à 07:40 : personne ne lui envoie K ; le cron a déjà avancé ; seul un humain rallume.
- **Contradiction documentaire** : README « une restauration ne doit jamais être abandonnée », doc 03
  §Orchestrateur point 8, doc 07 R4.1 coché, CC-003 « vider à la reconnexion ».
- **Correction** : phase 1.2. **Statut** : bloquant avant réactivation.

### P1-2 — Fraîcheur du téléphone incompatible avec sa cadence réelle ; sentinelle qui bat

- **Fichiers** : Texto `src/messages/messages.service.ts:225-231` (frais ⇔ `age ≤ deviceStaleSeconds`),
  `src/config/env.ts:39-46` (120 s, minimum 30, **sans maximum**) ; Tracky
  `sms-gateway-watchdog.service.ts:28-35` (un seul tick sain referme l'épisode et remet le rappel à zéro).
- **Preuve** : `lastSeen` figé 552 s au repos (§4.1) ; ping non configuré (doc 10) ; pull par défaut
  15 min (documentation SMS Gateway « Ping »). Attendu après déploiement en l'état :
  `operational=false` ~85 % du temps, CRITICAL à chaque nouvel épisode (jusqu'à 4/h), interlock rouge,
  écran admin rouge, **sans qu'aucune panne n'existe**.
- **Correction** : phases 2.2, 3 et 4. **Test** : succession sain/périmé/sain/périmé → une seule
  alerte ; valeur énorme refusée.
- **Statut** : bloquant avant réactivation (prérequis de déploiement + code).

### P1-3 — L'interlock exige une preuve `delivered` < 24 h que rien ne produit quotidiennement

- **Fichiers** : `engine-control.service.ts:987-1000` (`freshProof` 24 h, `deliveryProofAvailable`),
  `sms-gateway.service.ts:436-442` (`lastTerminalSuccessAt` = dernier `sms_logs` OUT `delivered`),
  `sms-heartbeat.service.ts:109` (lundi 09:00, hebdomadaire), Texto `webhooks.controller.ts:114-124`
  (aucun push), Tracky `sms-webhook.controller.ts:132-174` (endpoint `POST /sms/webhook/status`
  **sans aucun émetteur**).
- **Scénario** : semaine normale, TCP sain, aucune RESTORE par SMS → mardi soir « dernière preuve de
  remise SMS trop ancienne (> 24 h) » → toutes les CUT automatiques refusées, CRITICAL à chaque
  tentative (P2-2). Fail-closed, mais automatisation inopérante et bruyante, non anticipée.
- **Correction** : phases 2.3 et 4. **Statut** : bloquant avant réactivation.

### P1-4 — Branche en conflit avec `main` ; production déjà passée à `66d286f5`

- **Preuve** : `git merge-tree --write-tree main HEAD` → `CONFLICT (content)` sur
  `apps/api/src/background-tasks/background-tasks.service.ts` ; `git log 909ea552..main` = 27
  commits, dont 3 migrations (`20260913140000_trip_polyline_matched_at`, `20260913170000_pauses_agents_locaux`,
  `20260913200000_tracker_command_sent_unconfirmed`) et le nouveau statut `TrackerCommandStatus.SENT_UNCONFIRMED`
  (TRK-062) ; VPS : `tracky-api` « Up 31 minutes » à 22:56, `git -C /opt/vizyo-tracky log -1` = `66d286f5`.
- **Cause** : le commit `b5ec9d19` reformate intégralement (prettier, largeur 80, guillemets simples,
  virgules finales) des fichiers qu'il ne modifie que ponctuellement. Normalisation faite (les deux
  versions de chaque fichier passées par le même prettier, puis diff) :

  | Fichier | Lignes brutes du diff | Lignes fonctionnelles |
  |---|---:|---:|
  | `background-tasks/background-tasks.service.ts` | 1 315 | 16 (entrée de catalogue du watchdog) |
  | `engine-control/engine-control.service.ts` | 889 | 18 (`gatewayOperational` dans l'interlock) |
  | `engine-control/engine-control.service.spec.ts` | 1 226 | 65 |
  | `sms/sms-gateway.service.ts` | 522 | 103 (interfaces + appel `/v1/texto/health`) |
  | `sms/sms-gateway.service.spec.ts` | 282 | 114 |
  | `sms/sms-admin.controller.ts` | 54 | 9 |
  | `sms/sms.module.ts` | 9 | 4 |
  | `web …/admin-sms.component.ts` | 508 | 65 |
  | `web …/admin-sms.service.ts` | 77 | 27 |
  | `sms-gateway-watchdog.service.ts` (+ spec) | 71 + 65 | nouveaux |

  Aucune suppression involontaire détectée dans ces hunks, mais la revue humaine en est rendue
  impossible et le conflit est mécanique. Côté Texto, tout le diff passe en guillemets doubles alors que
  le dépôt est en simples.
- **Correction** : phase 5.1. **Statut** : bloquant pour la fusion.

### P1-5 — Procédure : `deploy.sh` ignoré, prérequis téléphone et env Texto absents

- Doc 13 (étapes 3-5) décrit migration + déploiement API/Web « à la main » ; la règle D1 du dépôt impose
  `deploy/vps/deploy.sh` (garde HH:42–HH:46, repères de repli, signalement des conteneurs hors script).
  Aucun document ne liste la configuration du téléphone (ping, FIFO, délais, limite, SIM) comme
  **prérequis** ; doc 18 n'énumère pas `CAPCOM6_DEVICE_STALE_SECONDS`/`CAPCOM6_REQUEST_TIMEOUT_MS` ;
  `CAPCOM6_SIM_NUMBER` n'est pas positionné en production (P0-4 du doc 11 « SIM explicitement
  sélectionnée » non réalisé — vérifié : la variable est absente de l'environnement du conteneur
  `texto-relay`).
- **Statut** : bloquant avant réactivation (procédure).

### P2-1 — Course ACK TCP pendant l'envoi SMS : `ACKNOWLEDGED` rétrogradé en `SENT`

- `engine-control.service.ts:1450-1464` (et `:1141-1165`) : `update({ where: { id } })` sans garde
  `ackedAt: null` ni `status`. Preuve exécutée : la mise à jour SMS ne porte aucune condition. Effet :
  commande `SENT` avec `ackedAt` renseigné ; UI « rallumage non confirmé » alors que le boîtier a
  acquitté ; le worker ne la reprend pas (`ackedAt` non nul). Fenêtre : durée de `trySmsFallback`
  (jusqu'à 10 s + attente de file). Correction : phase 1.3. Non bloquant.

### P2-2 — Tempête de CRITICAL quand un planning est actif kill-switch fermé

- `:404-411` et `:1030-1037` écrivent un CRITICAL **par appel** ; le cron retente avec backoff
  2/5/15/30 min ; dédup `ErrorLogger` de 60 s seulement (`error-logger.service.ts:90`) ; la vigie envoie
  un courriel par heure dès un CRITICAL. Un administrateur de flotte qui réactive lui-même ses horaires
  (droit `schedules_manage`) déclenche un flux nocturne de dizaines de lignes + « coupe impossible
  depuis N min » sans connaître le kill-switch. Correction : phase 1.5. Non bloquant.

### P2-3 — Glissement confirmable par un clic ou la touche `End`

- `apps/web/src/app/shared/ui/confirm-modal/confirm-modal.component.ts:102-109`, `:340-355` :
  `<input type="range">` natif ; un clic en bout de piste (le curseur saute) ou `End` au clavier produit
  `change` à 100 → `onConfirm()`. L'exigence « impossible de déclencher accidentellement » n'est pas
  tenue (la saisie de plaque l'était). Le test du spec fixe la valeur programmatiquement et ne le voit
  pas. Correction : phase 1.7. Non bloquant (garde-fous vitesse côté serveur ; modale à ouvrir d'abord),
  à corriger avant fusion si l'exigence est maintenue.

### P2-4 — CUT `PENDING` orpheline après crash : la CUT manuelle suivante est avalée

- `:848-852` retourne la commande active ; le dispatch `:857` n'est pas atteint. Une CUT créée puis
  non dispatchée (crash) reste `PENDING` avec sa clé jusqu'à la prochaine RESTORE (`:790-810`) ;
  entre-temps la CUT antivol manuelle rend 201 avec l'ancienne commande et n'envoie rien. Correction :
  phase 1.4. Non bloquant.

### P2-5 — RESTORE bloquée en `queued` : polling infini, une seule alerte

- `:1696-1703` (repoll toutes les 30 s sans fin), `:1737-1763` (`alertedAt` posé une fois). Un
  téléphone éteint plusieurs heures produit une alerte à 60 s puis le silence ; seule la sentinelle
  Android rappelle toutes les 15 min. Correction : phase 1.6. Non bloquant.

### P2-6 — Requête HTTP manuelle suspendue derrière la file SMS

- `sms-gateway.service.ts:746-759` : `send()` ne résout qu'au départ effectif ; `requestCommand`
  l'attend (`engine-control.service.ts:1129`). Avec N SMS en file (15 s chacun), le clic « Rallumer »
  peut dépasser le délai du proxy : toast « Rallumage refusé » alors que l'intention est persistée et
  suivie. Correction : phase 1.8. Non bloquant.

### P2-7 — Timeout capcom6 de 5 s appliqué à l'envoi (Texto)

- `capcom6.service.ts:112` : avant la branche, aucun délai ; maintenant 5 s. « Timeout mais accepté »
  n'est pas réconcilié : Tracky note `failed`, retente (SMS en double — anodin pour RESTORE, coût pour
  CUT), la ligne relais garde `failed` alors que le message est parti. Correction : phase 2.2. Non bloquant.

### P2-8 — Plusieurs appareils : le plus frais masque les autres ; SIM et appareil non identifiés

- Texto `messages.service.ts:214-224` : `Math.max` sur tous les appareils non supprimés. Un second
  téléphone de test enregistré sous le même compte rend le verdict « frais » même si le téléphone de
  production est mort ; `simCards` (fourni par l'API) ignoré ; `deviceId` jamais passé à l'envoi.
  Correction : phase 2.2. Non bloquant aujourd'hui (un seul appareil), **bloquant pour la procédure
  « second téléphone » (doc 12)**.

### P2-9 — Une RESTORE peut échouer sur l'allowlist Texto sans contournement

- Un 403 « hors allowlist » compte comme échec de soumission (`sms-gateway.service.ts:1015-1048`), trois
  fois, puis `FAILED`. La garde anti-suppression de masse existe côté relais (`ALLOWLIST_MAX_AUTO_REMOVALS`,
  présent en production) mais l'allowlist reste sur le chemin de la restauration. Correction : bypass
  pour `priority=critical_restore` vers un numéro connu de Tracky, ou contrôle de l'allowlist dans le
  préflight. Non bloquant.

### P2-10 — Journal des tentatives jamais exercé par les tests ; dérive schéma/migration

- `engine-control.service.ts:957-971` : délégué `engineDeliveryAttempt` lu en duck-typing →
  `undefined` dans tous les mocks → `beginAttempt`/`finishAttempt` inertes en test ; la contrainte
  `CHECK (status IN (… 'UNAVAILABLE' …))` et l'unicité `(commandId, attemptNumber)` n'ont jamais tourné.
  `engine_control_commands_restore_worker_idx` (migration lignes 25-26) absent de `schema.prisma` (le
  prochain `migrate dev` proposera de le supprimer). Correction : phase 1.9 + migration sur copie
  PostgreSQL. Non bloquant, mais condition avant GO.

### P3 — Améliorations

- `SMS_MIN_INTERVAL_MS=` (vide) → `Number('')=0` → pacing désactivé en silence
  (`sms-gateway.service.ts:274-281` ; `env.validation.ts` accepte 0).
- `CAPCOM6_DEVICE_STALE_SECONDS` sans borne haute ; `1e9` lu comme 1 → 30 (acceptable) ; décimales tronquées.
- Cache interlock 30 s + fraîcheur 120 s + persistance `lastSeen` ≤ 60 s : une CUT peut partir jusqu'à
  ~3,5 min après la mort réelle du téléphone (acceptable : le danger est la RESTORE, pas la CUT).
- `toNumber` complet dans le contexte des alertes `sms-gateway` (pré-existant) ; message d'erreur
  capcom6 (jusqu'à 300 caractères) renvoyé tel quel dans `/v1/texto/health`.
- `SENT_UNCONFIRMED` traité par la branche `SENT` de l'UI (rendu acceptable, non explicite).
- `releaseId` typé `string` côté relais et Tracky alors que l'API rend un entier.
- Doc 12 dit 90 s de fraîcheur, code 120 s ; doc 11 P0-6 promet quatre états (`ONLINE/DEGRADED/STALE/OFFLINE`),
  le code n'a qu'un booléen ; doc 03 « T-30 » non implémenté (décision métier en attente, correctement
  signalée).
- Aucun test de changement d'heure Europe/Paris (prochain : 25/10/2026) ; `getNowInTimezone` fabrique
  une `Date` locale (`schedule-cron.service.ts:679-704`).
- Ancien relais sans endpoint → Tracky affiche « relais injoignable » alors qu'il répond (sûr, libellé
  trompeur).

---

## 7. Réponses aux vingt questions critiques

1. **Le téléphone peut-il être « frais » alors que l'envoi SMS ne fonctionne plus ?** Oui. `lastSeen`
   est touché par tout appel authentifié de l'appareil au serveur (pull, ping, remontée de statut) : il
   prouve une connexion IP, pas la voie radio. Un téléphone connecté en Wi-Fi avec une SIM bloquée est
   « frais ».
2. **Un ping récent prouve-t-il que le worker Android et la SIM sont capables d'émettre ?** Non. Le
   ping est émis par l'application ; il ne teste ni `SmsManager`, ni le modem, ni l'opérateur. Le
   11/09, l'application journalisait « SendMessagesWorker finished successfully » pour des SMS `Failed`.
3. **`/health` du fournisseur prouve-t-il une émission réelle ?** Non. En production (1.43.0) et dans
   les sources amont, il ne contient que `db:ping`. Il ne sait même pas si un téléphone existe.
4. **Existe-t-il un test sentinelle sans coût prouvant périodiquement la SIM ?** Non. `simCards`
   (exposé par l'API, ignoré par le relais) dirait qu'une SIM est présente, pas qu'elle émet.
5. **Une vérification active payante est-elle nécessaire, à quelle fréquence ?** Oui : un SMS réel
   réconcilié jusqu'à `delivered`, au moins une fois par jour et idéalement à T-30 min de chaque fenêtre
   critique (04:30 et 06:30) ; vers la SIM du téléphone lui-même pour prouver aussi la réception et le
   webhook entrant. ~2 SMS/jour.
6. **Le système distingue-t-il accepté / envoyé / remis / exécuté ?** Accepté (`queued`) oui ; envoyé
   (`sent`) et remis (`delivered`) oui mais **seulement par polling** (rien n'est poussé) et sans
   distinction visuelle dans le bouton ; exécuté seulement sur preuve (ACK `kt` < 15 s, SMS d'accusé
   rare, ignition < 30 min). Les tentatives enregistrent `ACCEPTED`/`DELIVERED`/`ACKNOWLEDGED`.
7. **Si TCP et SMS exécutent tous deux la même commande ?** Même état final (les commandes fixent un
   état) ; seul coût : un SMS. Le danger est l'**ordre** : une CUT SMS retardée exécutée après la RESTORE
   (P0-2), que rien ne rappelle du téléphone aujourd'hui.
8. **Les commandes Coban sont-elles idempotentes côté boîtier ?** Par conception oui (`stop`/`resume`
   fixent l'état du relais) ; non mesuré ici sur matériel — à inclure dans la recette de banc.
9. **Une rafale de RESTORE peut-elle survenir après redémarrage ou avec plusieurs instances ?** Après
   redémarrage : le cron peut émettre jusqu'à 22 demandes RESTORE en un tick (pas de cadenceur pour
   RESTORE, par conception) ; les envois TCP sont immédiats (acceptable), les replis SMS passent par la
   file 15 s (pas de rafale vers le téléphone). Le worker reprend 25 commandes par 15 s, cadencées par la
   même file. Avec plusieurs instances : deux files SMS indépendantes (cadence doublée), deux
   cadenceurs CUT, deux sentinelles → **une seule instance est obligatoire** (documenté doc 15, à
   verrouiller dans le compose).
10. **La file anti-rafale est-elle persistante ou en mémoire ?** La file des CUT de flotte est
    **persistante par construction** (`lastEvaluatedState` non avancé en base) ; seul le cadenceur de
    10 s est en mémoire (après redémarrage : une coupe immédiate puis la cadence). La file SMS est en
    mémoire : les RESTORE sont récupérées de la base, les CUT en attente d'envoi SMS sont perdues (elles
    reviennent au tick suivant du cron).
11. **Une CUT automatique peut-elle partir pendant que la santé est mise en cache comme saine ?** Oui :
    cache 30 s + seuil 120 s + persistance par lots ≤ 60 s ≈ jusqu'à 3,5 min après la mort réelle du
    téléphone. Acceptable : la CUT n'est pas la direction dangereuse, et la RESTORE du matin sera
    précédée de plusieurs heures de sentinelle.
12. **Un RESTORE peut-il rester bloqué derrière un problème d'allowlist ?** Oui : 3 refus 403 → `FAILED`
    + alerte, sans contournement (P2-9). L'incident du 11/09 n'était pas dû à l'allowlist.
13. **Les allowlists Tracky, Texto et Android restent-elles cohérentes ?** Il n'y a pas d'allowlist
    Android (ni dans l'application ni sur le serveur capcom6). Tracky pousse vers le relais (`allowlist/sync`),
    le relais garde une garde anti-suppression de masse. Le mécanisme existe ; il n'a pas été ré-audité en
    profondeur ici (hors périmètre de la branche).
14. **Une suppression massive d'allowlist est-elle réellement empêchée ?** Oui côté relais
    (`ALLOWLIST_MAX_AUTO_REMOVALS`, présent en production ; test de la suite Texto « 25 suppressions
    retenues, plafond 5 »). Non ré-audité au-delà.
15. **Déployer Tracky avant Texto : blocage sûr ou régression ?** Blocage sûr : `/v1/texto/health` rend
    404 → `reachable:false` → interlock rouge, aucune CUT automatique ; RESTORE et actions manuelles
    intactes ; effet de bord : CRITICAL de la sentinelle toutes les 15 min et écran admin « relais
    injoignable » (libellé faux). Ordre Texto puis Tracky confirmé.
16. **Les nouveaux endpoints respectent-ils l'isolation multi-tenant ?** `/v1/texto/health` :
    authentifié par `ApiKeyGuard`, compteurs filtrés par `tenantId` ; les données appareil/serveur sont
    **globales** (un seul compte capcom6) et donc visibles de tout tenant — pas de numéro ni de contenu,
    mais version, `lastSeen`, nombre d'appareils, slot SIM et message d'erreur capcom6. `POST /sms/webhook/status`
    : signé HMAC, fail-closed sans secret en prod, sans émetteur aujourd'hui. `idempotencyKey` : unique
    globalement, relecture filtrée par boîtier, collision inter-véhicule → 409 (révèle l'existence de la
    clé, pas la commande).
17. **Une erreur du watchdog peut-elle faire tomber le module SMS ou le démarrage API ?** Non :
    `healthCheck` ne lève jamais (tout est rattrapé), `ErrorLogger.record` ne lève jamais, la cron a un
    `try/finally` ; DI vérifiée par le smoke-boot (5/5). Une exception hors `try` reste théoriquement
    possible (rejet non géré), aucune trouvée.
18. **Les horaires restent-ils intacts après toutes les actions manuelles ?** Oui pour `enabled`
    (seule l'option durable le change, gardée par `schedules_manage`, refusée sur RESTORE) ; override
    jusqu'à la prochaine bascule ; hold veilleur conservé. **Mais** l'exécution de la prochaine RESTORE
    dépend de P0-1.
19. **Comportement sûr le week-end et les jours fériés ?** Sémantique existante : jour désactivé =
    hors plage toute la journée ; fériés opt-in (`cutOnHolidays`, testé) ; override d'une action
    manuelle du vendredi soir court jusqu'à la bascule du lundi. La RESTORE du lundi est exposée à P0-1
    si celle du vendredi est partie par SMS. Changement d'heure non testé.
20. **Les documents promettent-ils davantage que le système ne garantit ?** Oui, sur cinq points :
    « webhook signé pour les statuts sortants » (pas d'émetteur) ; « RESTORE rejouée à la reconnexion »
    (pas de hook) ; « jamais abandonnée » (3 SMS puis `FAILED`) ; « quatre états de passerelle » (un
    booléen) ; « SIM explicitement sélectionnée » (variable absente). Le reste des cases cochées est
    honnête et reproduit.

---

## 8. Matrice de la chaîne de preuve

| Étape | TCP | SMS | Observée / supposée | Confusion possible dans l'UI |
|---|---|---|---|---|
| Requête acceptée par Tracky | `PENDING` | `PENDING` | observée | non |
| Transmise au relais / socket | `WRITTEN` (écriture socket) | `queued` relais | observée | « Rallumage en cours » — correct |
| SMS accepté par Android | — | `sent` | observée **par polling seulement** | `SENT` sans distinction sent/delivered dans le bouton |
| SMS réellement émis par la SIM | — | non observable | supposée | non affichée — correct |
| SMS remis au boîtier | — | `delivered` (accusé opérateur) | observée par polling | « SMS remis — exécution non confirmée » — correct |
| Commande exécutée | ACK `kt` < 15 s ; ignition | SMS « Succeed » (rare) ; ignition < 30 min | observée si preuve ; **ACK > 15 s perdu** | « confirmé » seulement sur preuve — correct |
| Accusé reçu par Tracky | `ACKNOWLEDGED` | `ACKNOWLEDGED` | observée | non |

Non observables : émission radio, file interne du téléphone et son ordre LIFO, batterie/charge
(absentes de l'API, confirmé), version de l'application (le serveur expose sa propre version, pas
celle de l'app).

---

## 9. Analyse des cas de concurrence

- **ACK TCP pendant l'envoi SMS** : rétrogradation `ACKNOWLEDGED`→`SENT` (P2-1).
- **ACK après expiration (> 15 s)** : ignoré par `AckWaiterService` (waiter retiré) ; SMS envoyé,
  commande parquée → alimente P0-1. Les ACK du 11/09 étaient de 0,1 à 5 s ; 15 s est raisonnable, mais
  un ACK tardif devrait être rattaché (motif K + RESTORE `SENT` du même IMEI).
- **ACK dupliqué** : seconde trame non appariée ; `updateMany` conditionnel côté SMS ; sans effet.
- **ACK ancien sur nouvelle commande** : possible uniquement si un waiter K est actif pour l'IMEI ; une
  seule RESTORE active par clé ; CUT (J) et RESTORE (K) distinguées par motif. Risque faible.
- **Deux commandes simultanées sur le même véhicule** : clé unique ⇒ même intention ; multi-onglets et
  multi-utilisateurs couverts ; verrou UI complémentaire ; testé.
- **CUT puis RESTORE rapprochées** : la RESTORE marque la CUT `SENT_UNCONFIRMED` en base mais **ne
  rappelle pas** le SMS CUT du téléphone (P0-2).
- **RESTORE puis CUT rapprochées** : la CUT ne supplante pas une RESTORE active ; les deux clés
  coexistent ; le worker RESTORE peut rallumer après la CUT (« RESTORE gagne » — à écrire noir sur blanc).
- **Redémarrage entre envoi et ACK** : le waiter disparaît ; RESTORE `SENT`/TCP avec `nextAttemptAt` +15 s
  → le worker envoie un SMS (coût, pas de perte) ; CUT reste `SENT` puis `SENT_UNCONFIRMED` à 30 min.
- **Redémarrage entre persistance et envoi** : RESTORE `PENDING` reprise par le worker ✅ ; CUT
  `PENDING` orpheline (P2-4).
- **Cron + worker** : le cron ne crée que des intentions, le worker dispatch ; le lease de 60 s peut
  expirer pendant une boucle ralentie par la file SMS (25 × 15 s) — sans effet à une instance.
- **Plusieurs instances** : cadenceur CUT, file SMS, dédup sentinelle, `restoreWorkerRunning` en
  mémoire ; seuls les leases sont partagés. Une instance obligatoire.
- **Message entrant ambigu / SIM-IMEI** : abstention si deux boîtiers partagent les 9 derniers chiffres ✅ ;
  un accusé « Resume engine Succeed » n'acquitte que la RESTORE `SENT` la plus récente du boîtier.
- **Tick cron réenfilant les mêmes véhicules** : impossible tant que `lastEvaluatedState` est avancé ;
  entre deux ticks, le cadenceur et `running` empêchent les doublons ; une désactivation ou un override
  retire le véhicule avant son créneau.
- **Dépassement de la fenêtre horaire** : 37 véhicules × 10 s = 6 min ; un véhicule différé (mouvement,
  arrêt < 10 min, hors ligne) reste en file jusqu'à la bascule suivante — voulu.

---

## 10. Analyse des horaires (invariants)

- Coupé automatiquement à 20 h, rallumé manuellement à 21 h : override jusqu'à 07:00 ; à 07:00 une
  RESTORE redondante part (coût possible d'un SMS) ; 20 h : CUT normale ✅. **Mais** si la RESTORE
  manuelle de 21 h part par SMS sans accusé, celle du surlendemain est avalée (P0-1) ✗.
- Roulant en journée, coupé manuellement : override jusqu'à 20:00 ; CUT redondante à 20:00 ; RESTORE à
  07:00 ✅ (la clé CUT est libérée en ≤ 40 min par la clôture périodique).
- Une action manuelle ne sort jamais du planning ✅ ; la désactivation est explicite, gardée, refusée
  sur RESTORE ✅ ; veilleur : hold indéfini conservé ✅.
- « Réactiver » (`vehicle-schedules.service.ts:224-234`) force une transition ; avec P0-1 elle est
  absorbée si une RESTORE est parquée.
- Compteur affiché à l'utilisateur (`queuedCuts`, `estimatedCutQueueDurationSec`) : exact pour le
  minimum ; ne compte pas les différés.
- Week-end, fériés, changement d'heure : §7 Q19.

---

## 11. Analyse de la sentinelle Android

**Garantit** : que le processus du relais répond ; que le serveur capcom6 atteint sa base ; qu'un
appareil non supprimé a contacté le serveur depuis moins de `deviceStaleSeconds` ; la profondeur de file
et les échecs 24 h du tenant ; une alerte CRITICAL par épisode, rappel toutes les 15 min, réarmement
après retour ; aucun SMS consommé ; anti-chevauchement ; ne peut pas faire tomber l'API ; s'efface hors
`vizyo-texto` (Twilio/noop non surveillés — à afficher).

**Ne garantit pas** : que l'application peut démarrer son service de premier plan ; que le worker
d'envoi tourne ; que la SIM émet ; que le réseau mobile est là ; que la file du téléphone n'est pas
bloquée ; qu'un message sera pris en charge avant 15 min ; quel appareil enverra.

**Faiblesses** : dédup en mémoire (redémarrage = nouvelle alerte ; plusieurs instances = doublons) ;
réarmement sur un seul tick sain (battement, P1-2) ; seuil de 120 s incompatible avec un téléphone
sans ping ; ancien relais → « injoignable » trompeur ; pendant un déploiement intermédiaire (Tracky
avant Texto) : CUT bloquées + CRITICAL/15 min, RESTORE intactes.

---

## 12. Tests manquants

**Automatisables immédiatement** : RESTORE du lendemain après RESTORE SMS non acquittée (P0-1) ; clic
manuel sur RESTORE parquée ; ACK pendant envoi SMS (garde conditionnelle) ; ACK tardif rattaché ; CUT
`PENDING` orpheline puis nouvelle CUT ; RESTORE après 3 échecs puis reconnexion TCP ; kill-switch : une
ligne par heure et par véhicule ; sentinelle : hystérésis sain/périmé alterné ; Texto : plusieurs
appareils (ancien + récent, supprimé), date future, `lastSeen` absent, provider `warn`/inconnu, HTTP
401/403/404/429/500, timeout, JSON invalide, valeurs d'env limites (chaîne, 0, négatif, décimal, énorme,
timeout > cadence) ; CUT avec `ttl`, RESTORE avec priorité ; glissement : clic en bout de piste et
touche `End` refusés ; DST 25/10/2026 ; double activation globale ; « 37 CUT simultanées » (existe),
« 37 RESTORE simultanées » (22 existe), « CUT manuelle pendant panne Android » (non bloquée — à
documenter par un test), « RESTORE pendant panne Android » (jamais bloquée — test explicite).

**Nécessitant PostgreSQL/Docker** : rejouer `20260912110000` après les migrations `20260913*` sur une
copie anonymisée ; contraintes `CHECK`/`UNIQUE` des tentatives ; crash entre `create` et dispatch,
entre dispatch et ACK ; deux workers avec leases ; volumétrie (37 véhicules × 2 transitions × tentatives
par jour, `engine_delivery_attempts` sans plan de purge) ; migration sur copie = **condition avant GO**
(Docker local absent pendant la revue du chantier, non revendiqué — correct).

**Nécessitant le téléphone** : ping ≤ 60 s écran éteint, application balayée, reboot sans
déverrouillage, mode économie, perte FCM, ordre FIFO, délai min, `simNumber` fixé, version SMSGate
qualifiée sur un second appareil, `lastSeen` qui avance.

**Nécessitant une vraie SIM** : SMS isolé puis série cadencée 1/15 s vers un numéro neutre, avec et
sans accusé de remise, SIM sans crédit/bloquée, perte réseau.

**Nécessitant un véhicule pilote** : RESTORE TCP avec ACK ; RESTORE socket coupée → SMS → preuve
ignition ; CUT puis RESTORE rapprochées avec SMS retardé (P0-2) ; redémarrage API avec RESTORE en
attente ; contrôle physique du démarrage.

---

## 13. Validation base de données

- Migration `20260912110000_engine_delivery_reliability` : additive (colonnes nullables ou avec défaut,
  nouvelle table, index) ; aucune ligne historique réinterprétée (`activeKey`/`idempotencyKey` `NULL`
  pour l'existant → **les anciennes RESTORE `SENT` ne bloquent pas** ; seules les nouvelles le feront).
- `gen_random_uuid()` : `pgcrypto` créé dans la migration initiale ; PostGIS 16 en production ✅.
- Contraintes : `UNIQUE(idempotencyKey)`, `UNIQUE(activeKey)`, `UNIQUE(commandId, attemptNumber)`,
  `CHECK channel`, `CHECK status` (incluant `UNAVAILABLE`, absent du commentaire Prisma) ; FK cascade.
- Dérive : index `engine_control_commands_restore_worker_idx` absent du schéma (P2-10) ; `prisma format`
  réécrirait 364 lignes du schéma (cosmétique, pré-existant).
- Ordre : la migration porte un horodatage antérieur à trois migrations déjà déployées ; `migrate deploy`
  l'appliquera comme « en attente » — à démontrer sur copie, pas à supposer.
- Idempotence des requêtes de reprise : worker par lease conditionnel (`updateMany` avec `count === 1`),
  `alertedAt` posé conditionnellement, acquittements par `updateMany` sur statut — correct.
- Croissance : `engine_delivery_attempts` ≈ (commandes/jour × 1-4) ; aucune purge prévue ; `sms_logs`
  purgés à 90 jours ; à décider (par ex. 180 jours, cascade déjà en place si la commande est supprimée).
- Réel PostgreSQL : non testé localement (pas de Docker) → **condition avant GO**.

---

## 14. Sécurité et dépendances

- Endpoint santé : authentifié (Bearer tenant), sans limite de débit propre (coût : 2 HTTP + 3 requêtes
  par appel ; ~1/min par Tracky) ; erreurs capcom6 renvoyées brutes (≤ 300 caractères) ; URL capcom6
  jamais exposée ; aucun numéro ni contenu de message.
- SSRF/injection d'URL : `textoUrl` vient de la configuration, `providerId` encodé (`encodeURIComponent`),
  `CAPCOM6_API_URL` configuration ; aucune URL fournie par l'utilisateur.
- TLS : `fetch` natif Node, vérification par défaut ; certificat invalide → exception → `reachable:false`
  (fail-closed) ; aucune désactivation de vérification trouvée.
- Secrets dans les logs : aucun nouveau ; `toNumber` complet dans certains contextes d'alerte
  (pré-existant, P3).
- Webhooks : entrant signé HMAC + anti-rejeu 5 min, fail-closed sans secret en prod ; sortant idem (sans
  émetteur).
- `pnpm audit --prod` (Tracky) : 1 critique (`maplibre-gl` XSS sanitizer bypass, web), 28 hautes
  (`axios` via `twilio` legacy, `lodash` via `@nestjs/config`, `multer`/`ws`/`engine.io`/`socket.io-parser`
  via la plateforme, `tmp` via `exceljs`, `brace-expansion`, `js-yaml` via `date-holidays`, `ip-address`
  via `geoip-lite`, `deepmerge-ts` via `prisma`), 26 modérées, 3 basses. **Aucune introduite par la
  branche** ; les DoS Socket.IO/`ws` sont les plus pertinentes pour la disponibilité de l'API (donc du
  worker RESTORE). Recommandation : lot séparé après stabilisation ; ne pas mêler à cette livraison.
- `npm audit --omit=dev` (Texto) : 5 hautes (`multer` via `@nestjs/platform-express`, `deepmerge-ts`
  via `prisma`), non exploitables sur ce relais (JSON seulement). Versions : NestJS 11.1.24, Prisma 6.19.3.
- Tracky : NestJS 11, Prisma 6.19.3 (README corrigé par la branche), Angular 20 ; `fetch` natif, pas
  d'Axios sur les chemins SMS.

---

## 15. Documentation : contradictions, cases cochées sans preuve, obsolescences

| Où | Ce qui est écrit | Ce que montre le code / la prod |
|---|---|---|
| README, doc 03 §8, doc 07 R4.1 (coché), CC-003 | RESTORE jamais abandonnée, rejouée à la reconnexion, file TCP durable | 3 SMS puis `FAILED` ; aucune relance à la reconnexion ; attente TCP = un créneau de 15 s |
| Doc 13, doc 07 R1.3 (coché), doc 03 | Webhook signé pour les statuts sortants + polling | Le relais n'émet rien ; seul le polling existe ; l'endpoint Tracky est sans émetteur |
| Doc 11 P0-4, doc 08 | SIM explicitement sélectionnée | `CAPCOM6_SIM_NUMBER` absent en production |
| Doc 11 P0-6 | États `ONLINE/DEGRADED/STALE/OFFLINE` | Un booléen `operational` |
| Doc 12 | Alerte si `STALE` > 90 s | 120 s dans le code |
| Doc 07 R1.3 | Contrôle toutes les 60 s, seuil 120 s | Exact, mais incompatible avec un téléphone sans ping (mesuré 552 s au repos) |
| Doc 13 §ordre | Migration puis déploiement « à la main » | Règle D1 : `deploy.sh` uniquement |
| Doc 18 | « Déployer Tracky avant le nouveau relais échouerait fermé » | Exact (404 → fail-closed) ; libellé « relais injoignable » trompeur |
| Doc 17 | 255 suites / 3 920 tests, 727, 416, 5 | Reproduit à l'identique |
| Doc 14 | 23 RESTORE non confirmées / 7 j dont 19 SMS | Reproduit à l'identique en base |
| Doc 07 (toutes les cases R7.2a « rafale de 22 RESTORE ») | Automatisé | Exact (test présent) — physique non mesuré, dit honnêtement |
| Docs 01-18 | Rien sur `main` qui bouge | 27 commits, 3 migrations, prod redéployée le 13/09 22:25 |

Instructions de déploiement ambiguës ou dangereuses : « appliquer la migration additive » sans dire
où ni comment (le script de déploiement l'applique-t-il ? à vérifier dans `deploy.sh`) ; « déployer
l'API » sans `deploy.sh` ; aucun mot sur l'ordre des migrations ; aucun prérequis téléphone.

---

## 16. Le diff : fonctionnel contre reformatage

Le commit `b5ec9d19` (+3 965 / −1 236) mêle une fonctionnalité (sentinelle, santé bout-en-bout,
écran admin) et un reformatage prettier intégral de fichiers préexistants. Méthode : les deux versions
de chaque fichier ont été passées par le **même** prettier (`--single-quote --trailing-comma all`,
largeur 80), puis comparées ; la version « après » est stable sous ce prettier (0 ligne de différence),
ce qui confirme l'outil et les options utilisés.

Résultat : ~560 lignes réellement fonctionnelles pour ~5 000 lignes brutes (tableau au §6, P1-4).
Aucune suppression ou modification involontaire n'a été trouvée dans les hunks de reformatage. Le
reformatage a déjà un coût concret : le conflit de fusion avec `main`. Il **doit être retiré** (ou
isolé dans un commit de style séparé, après fusion et accord d'équipe) avant la fusion. Côté Texto, le
style passe en guillemets doubles : à remettre en simples.

---

## 17. Détail des notes

**Diagnostic initial — 15/20.** Réussi : chronologie précise et honnête ; séparation constante des
quatre vérités ; vidéo image par image ; diagnostic téléphone ; refus d'un coupable unique ; hypothèses
ouvertes nommées ; chiffres du doc 14 exacts. Perdu : `/health` capcom6 pris pour un signal ; absence
du push de statuts non relevée ; sémantique de `lastSeen` sous-estimée ; évolution de `main` ignorée.

**Corrections Tracky — 15/30.** Réussi : §5 dans son ensemble. Perdu : P0-1 ; P0-2 (côté Tracky : pas
de `ttl` demandé, pas de rappel du SMS CUT) ; P1-1 ; P2-1 à P2-6 ; P2-10.

**Corrections Texto/Android — 9/20.** Réussi : endpoint bien construit et fail-closed ; batterie non
inventée (confirmé par le contrat public). Perdu : statuts sortants toujours non poussés ; `send()`
sans `ttl`/`priority`/`deviceId` ; fraîcheur incompatible avec la cadence réelle ; multi-appareils
ambigu ; `simCards` ignoré ; `CAPCOM6_SIM_NUMBER` absent ; timeout de 5 s sur l'envoi ; style ; 3 tests.

**Tests, observabilité, déploiement — 14/30.** Réussi : tous les chiffres reproduits ; tests nouveaux
pertinents ; écran admin honnête ; alertes avec plaque, IMEI, canal, tentative, action attendue. Perdu :
tentatives jamais exercées ; pas de test du scénario P0-1 ; pas d'intégration PostgreSQL ; dérive
d'index ; procédure sans `main`, sans `deploy.sh`, sans téléphone, sans preuve quotidienne ; cases
cochées au-delà du code.

---

## 18. Plan de déploiement corrigé (résumé)

Voir §3 phase 5. Différences avec l'ordre proposé dans la mission : fusion préalable avec `main`
(production = `66d286f5`) ; `deploy.sh` obligatoire ; téléphone configuré **avant** Texto ; preuve SMS
quotidienne installée avant les canaris ; migration répétée sur copie ; test « RESTORE du lendemain »
dans la recette ; kill-switch `true` seulement pendant la fenêtre canari.

---

## 19. Décision finale

- **Code prêt à merger : NON.** Conditions : P0-1 corrigé et testé ; diff nettoyé du reformatage ;
  rebase sur `main` sans conflit ; P2-1 et P2-4 corrigés ; suite complète relancée (en série si instable).
- **Texto prêt à déployer : OUI, sous conditions.** Endpoint additif et sûr. Conditions :
  `CAPCOM6_DEVICE_STALE_SECONDS` cohérent avec le ping réel du téléphone ; `CAPCOM6_SIM_NUMBER=1` ;
  délai d'envoi séparé (≥ 9 s) du délai de santé, ou acceptation explicite du risque de doublons ;
  guillemets remis en simples. `ttl`/`priority`/annulation exigés avant la réactivation des horaires.
- **Tracky prêt à déployer avec horaires désactivés : NON.** P0-1 touche aussi les RESTORE manuelles.
  Conditions : celles de la fusion + migration rejouée sur copie PostgreSQL + téléphone configuré +
  Texto déployé avant + `deploy.sh`.
- **Horaires prêts à être réactivés : NON.** Conditions : tout ce qui précède + P0-2 (validité CUT),
  P1-1 (reconnexion), P1-2 (fraîcheur/hystérésis), P1-3 (preuve quotidienne), canaris physiques réussis
  un par un, 7 jours de sentinelle sans faux positif, réactivation par groupes de 3-5.
- **Second téléphone requis avant lundi : NON.** Ce n'est pas lui qui bloque ; c'est le logiciel.
- **Second téléphone fortement recommandé à court terme : OUI.** Un Android, une SIM, un opérateur, un
  compte capcom6 ; corriger P2-8 (santé par appareil) **avant** de l'enregistrer.

### Réponse à la question finale

« Si ces branches sont déployées dans le bon ordre et que la recette réelle passe, quel niveau de
confiance raisonnable avons-nous que les véhicules seront coupés et surtout restaurés correctement le
lendemain ? »

**En l'état : faible**, et pas à cause du téléphone — parce que le code garantit aujourd'hui qu'une
RESTORE parquée après un SMS non acquitté bloque la suivante. Une recette « un RESTORE, un CUT, un
canari » ne le verrait pas ; seuls deux matins consécutifs sur un boîtier hors TCP le révèlent.

**Après correction des P0 et P1** :

- *Ce que le code garantit* : l'intention RESTORE survit au redémarrage ; elle est retentée par TCP puis
  SMS avec cadence ; elle est visible à chaque étape avec sa cause ; elle déclenche une alerte à 60 s ;
  aucune réponse HTTP ni `queued`/`sent`/`delivered` n'est présentée comme un rallumage ; une CUT
  automatique ne part que kill-switch ouvert, téléphone frais, preuve de remise récente et file saine ;
  les 37 véhicules ne sont jamais coupés en rafale ; une action manuelle ne sort jamais du planning.
- *Ce que les tests garantissent* : ces comportements sur des doubles de la base, de la socket et du
  relais ; pas la migration réelle, pas les contraintes SQL des tentatives, pas la latence du téléphone.
- *Ce que seul le matériel prouve* : que le boîtier exécute `resume123456` reçu par SMS et répond `kt` en
  TCP ; que la SIM émet en série cadencée ; que SMSGate se réveille écran éteint et après reboot ; que le
  ping et l'ordre FIFO tiennent sous Android 15.
- *Risque résiduel avec un seul téléphone* : élevé et incompressible par le logiciel. Tracky **verra**
  la panne (sentinelle, alerte à 60 s, liste nominative) et **n'aura pas coupé** la veille si la panne
  était déjà visible ; mais un téléphone qui meurt entre 20 h et 07 h laisse les véhicules hors TCP
  immobilisés jusqu'à l'intervention humaine. Le niveau raisonnable, corrections faites et recette
  passée : **bon pour les boîtiers joignables en TCP, dépendant d'un point de panne unique pour les
  autres** — point unique qui n'a aujourd'hui ni preuve d'émission quotidienne ni secours.

### Les cinq actions les plus importantes avant toute réactivation des horaires

1. Corriger P0-1 (réarmement/expiration de la clé RESTORE, confirmation ignition sans plafond, UI
   « déjà en cours / réarmé ») et prouver par test le « RESTORE du lendemain ».
2. Nettoyer le diff du reformatage, rebaser sur `main` (production = `66d286f5`), résoudre le conflit,
   rejouer la migration sur une copie PostgreSQL, relancer toute la suite.
3. Configurer le téléphone (ping ≤ 60 s, FIFO, délais, SIM fixe, version figée), aligner
   `CAPCOM6_DEVICE_STALE_SECONDS`, ajouter l'hystérésis de la sentinelle, vérifier 30 min écran éteint que
   `lastSeen` avance.
4. Donner une validité aux SMS CUT (`ttl`), une priorité aux RESTORE, annuler le SMS CUT supplanté, et
   relancer TCP à la reconnexion — une RESTORE n'est plus jamais terminale tant qu'elle n'est pas prouvée.
5. Instaurer la preuve SMS quotidienne réconciliée (T-30 min avant chaque fenêtre) — sans elle
   l'interlock refuse les CUT six jours sur sept — puis canaris physiques un par un, avec liste
   nominative à 05:10 et 07:10.

---

## Annexe A — Vérifications exécutées et résultats

| Vérification | Commande (résumé) | Résultat |
|---|---|---|
| État git Tracky | `git branch --show-current`, `git log -1`, `git status --porcelain`, `git worktree list`, `git merge-base HEAD main` | branche et HEAD attendus, propre, base `909ea552` |
| État git Texto | idem | branche et HEAD attendus, propre, base `1bd2def` |
| Divergence `main` | `git log --oneline 909ea552..main`, `git merge-tree --write-tree main HEAD` | 27 commits ; conflit `background-tasks.service.ts` |
| Reformatage | prettier sur les deux versions de chaque fichier de `b5ec9d19`, diff | tableau §6 P1-4 ; « après » stable sous prettier |
| Typecheck | `tsc --noEmit` dans `packages/shared` et `apps/api` | 0 erreur |
| Tests API | `jest --ci --maxWorkers=2` (apps/api) | **255 suites, 3 920 tests, 178,7 s** |
| Tests ciblés | `jest --testPathPatterns "engine-control|sms-gateway|…"` | 11 suites, 264 tests |
| Smoke DI | `jest --testPathPatterns app.module.smoke` | 5 tests |
| Tests Web | `ng test --watch=false --browsers=ChromeHeadless` | **727 / 727** |
| Tests partagé | `jest` (packages/shared) | 19 suites, 416 tests |
| Build API | `nest build` | OK |
| Build Web | `ng build --configuration production` | OK ; 4 avertissements de budget CSS (map, vehicles-list, vehicle-detail, reports) + 2 CommonJS — pré-existants |
| Prisma | `prisma validate` | schéma valide ; `prisma format` réécrirait 364 lignes (cosmétique) — fichier restauré ensuite |
| Client Prisma généré | `grep engineDeliveryAttempt …/.prisma/client/index.d.ts` | présent dans le worktree de la branche (29 occurrences), absent dans celui de `main` — normal |
| Audit dépendances Tracky | `pnpm audit --prod --json` | 1 critique, 28 hautes, 26 modérées, 3 basses — pré-existantes |
| Texto tests | `jest --ci` (variables d'env factices) | 4 suites, 24 tests |
| Texto typecheck/build | `tsc --noEmit`, `nest build` | OK |
| Audit dépendances Texto | `npm audit --omit=dev --json` | 5 hautes pré-existantes |
| Preuve P0-1 / P2-1 | test temporaire `zz-audit-temp.spec.ts` (annexe C), `jest --testPathPatterns zz-audit-temp` | 3/3 assertions ; fichier supprimé |
| Contrat SMS Gateway | `curl` `capcom6.github.io/android-sms-gateway/swagger.json` (v1.75.1) | `Device` sans batterie ; `Message` avec `ttl`, `validUntil`, `priority`, `deviceId`, `simNumber` ; `DELETE /messages/{id}` |
| Sources amont serveur | `gh api` sur `android-sms-gateway/server` : `internal/health/*`, `modules/db/health.go`, `handlers/health.go`, `online/service.go`, `modules/auth/service.go` | seul fournisseur de santé : `db:ping` ; `lastSeen` touché à chaque appel authentifié de l'appareil, persisté par lots d'une minute |
| Documentation SMS Gateway | `docs.sms-gate.app/features/ping/` | intervalle de pull par défaut 15 min, remplacé par le ping |
| Propreté finale | `git status --porcelain` dans les deux worktrees | vide |

## Annexe B — Observations VPS (lecture seule, sans secret)

Relevé du 13/09 à 20:56–21:02 UTC (22:56–23:02 Paris) :

- Conteneurs : `tracky-api` (Up 31 min, healthy), `tracky-web` (Up 31 min), `texto-relay`
  (`vizyo-texto:latest`, Up 2 semaines), `capcom6-server` et `capcom6-worker`
  (`ghcr.io/android-sms-gateway/server:latest`, Up 5 semaines), `capcom6-mysql` (mariadb:11),
  `tracky-postgres` (postgis 16-3.4), `tracky-redis`, `texto-postgres`, plus la pile démo.
- Commits déployés : Tracky `66d286f5` (13/09, « une commande de boîtier partie par SMS a un état
  terminal — SENT_UNCONFIRMED après quatre heures (TRK-062, T5) ») ; Texto `5199f1f` (24/08, merge de
  `fix/trk026-lookup-provider-id`).
- Variables d'environnement du conteneur `texto-relay` (noms seulement) : `ALLOWLIST_MAX_AUTO_REMOVALS`,
  `CAPCOM6_API_URL`, `CAPCOM6_PASSWORD`, `CAPCOM6_USERNAME`, `CAPCOM6_WEBHOOK_SECRET`,
  `GLOBAL_MAX_SMS_PER_MIN`, `NODE_ENV`, `PORT`, `TRUST_PROXY_HOPS` — **pas de `CAPCOM6_SIM_NUMBER`**.
- `GET /3rdparty/v1/health` (via l'env du conteneur, sans afficher les identifiants) :
  `{"status":"pass","version":"1.43.0","releaseId":1448,"checks":{"db:ping":{"status":"pass",…}}}`.
- `GET /3rdparty/v1/devices` : un appareil, `name: samsung/o1sxeea`, `createdAt 2026-06-03`,
  `lastSeen 2026-09-13T20:52:50Z` — inchangé à 20:57:30, 20:59:32 et 21:02:02.
- Tracky, `engine_control_commands`, 7 jours : voir §4.1 ; 30 jours par jour : voir §4.1.
- Texto, `messages` OUT, 7 jours : `failed` 13, `sent` 6, `delivered` 6.

## Annexe C — Test de preuve exécuté (temporaire, supprimé)

Fichier créé puis supprimé : `apps/api/src/engine-control/zz-audit-temp.spec.ts` (même harnais de
mocks que `engine-control.service.spec.ts`). Résultat : 3 tests passés = les trois défauts sont présents.

```ts
// Extrait — commande de la veille, SENT via SMS, parquée (nextAttemptAt null), activeKey conservé
const stale = cmd(); // createdAt/sentAt = now − 24 h, status SENT, channel 'SMS', nextAttemptAt: null
prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });
prisma.engineControlCommand.findFirst.mockResolvedValueOnce(stale); // relecture activeKey

const result = await service.requestCommand(
  TRACKER_ID, EngineAction.RESTORE, 'Automatisation horaire : entrée dans la plage autorisée',
  { userId: SCHEDULER_USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null }, 'SCHEDULER',
);
expect(result.id).toBe(stale.id);                                  // ✅ la commande de la veille
expect(registry.send).not.toHaveBeenCalled();                      // ✅ aucun TCP
expect(sms.send).not.toHaveBeenCalled();                           // ✅ aucun SMS
expect(prisma.engineControlCommand.update).not.toHaveBeenCalled(); // ✅ aucun réarmement

// Prédicat du worker : exclut {status:'SENT', nextAttemptAt:null}
await service.processPendingRestores();
const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
expect(JSON.stringify(where)).toContain('"status":"PENDING","nextAttemptAt":null');
expect(JSON.stringify(where)).not.toContain('"status":"SENT","nextAttemptAt":null');

// dispatchSmsAttempt : mise à jour sans garde ackedAt/status
const smsUpdate = prisma.engineControlCommand.update.mock.calls.find(c => c[0]?.data?.channel === 'SMS');
expect(smsUpdate[0].where).toEqual({ id: expect.any(String) });    // ✅ aucune condition
expect(smsUpdate[0].data.status).toBe(CommandStatus.SENT);
```

Pour le rejouer : recréer le fichier avec ce contenu (harnais complet reproduit d'après le spec
existant), `cd apps/api && npx jest --testPathPatterns zz-audit-temp`, puis supprimer le fichier.

## Annexe D — Hunks fonctionnels du dernier commit (`b5ec9d19`), après normalisation

- `background-tasks.service.ts` : ajout de l'entrée de catalogue `sms-gateway-watchdog` (14 lignes,
  descriptive : le catalogue n'impose pas `antiOverlap`, il le décrit).
- `engine-control.service.ts` : dans `assertAutomaticCutSafe`, `gatewayOperational = provider !== 'vizyo-texto' || health.gateway?.operational === true`,
  ajouté à la condition `safe` et au libellé de raison.
- `sms.module.ts` : fournisseur `SmsGatewayWatchdogService`.
- `sms-admin.controller.ts` : `mode = provider` seulement si `reachable && (provider !== 'vizyo-texto' || gateway.operational)` ;
  champ `gateway` exposé.
- `sms-gateway.service.ts` : interfaces `TextoGatewayHealth` et `SmsGatewayHealth` ; `healthCheck`
  appelle `GET /v1/texto/health` avec `Authorization: Bearer`, timeout 5 s, valide la forme
  (`operational`, `device.fresh`, `provider.status`), `reachable:false` sur non-2xx, `error` si non
  opérationnel, `gateway` joint à la réponse.
- `sms-gateway-watchdog.service.ts` (+ spec) : nouveaux (71 + 65 lignes).
- `engine-control.service.spec.ts` : mock `currentProvider`, test « bloque une CUT automatique si le
  téléphone Android ne ping plus », ajustements de `finally`.
- `sms-gateway.service.spec.ts` : `describe('… santé Android bout-en-bout')`, dont « échoue fermé si un
  ancien relais ne fournit pas la télémétrie ».
- Web `admin-sms.service.ts` : type `gateway` ; `admin-sms.component.ts` : panneau « Téléphone Android »
  (frais/périmé, appareils, dernier ping, serveur/version, SIM, file relais, échecs 24 h, mention
  batterie/charge non fournies) ; `gatewayOk` dans l'état global et les libellés.

Les diffs normalisés complets ont été produits dans le répertoire de travail temporaire de l'audit
(`scratchpad/norm/*.diff`) ; ils se régénèrent en passant les deux versions de chaque fichier par
`prettier --single-quote --trailing-comma all` puis `diff -u`.

## Annexe E — Fichiers et lignes de référence (worktree de la branche)

- `apps/api/src/engine-control/engine-control.service.ts` : `:79-90` constantes (ACK 15 s, alerte
  60 s, 3 SMS) ; `:222-254` clôture (CUT seulement) ; `:279-359` accusé SMS ; `:361-895`
  `requestCommand` (kill-switch `:398-415`, interlock `:416-422`, idempotence `:426-438`, dormance
  `:452-461`, verrou CUT en vol `:469-494`, gardes vitesse `:499-702`, horaires `:716-787`, clé `:789`,
  supplantation `:790-810`, création/collision `:811-855`, dispatch `:857-892`) ; `:957-971` délégué
  tentatives ; `:974-1041` interlock ; `:1043-1077` tentatives ; `:1079-1422` `dispatchCommand`
  (socket absente `:1096-1121`, SMS `:1123-1248`, TCP `:1250-1281`, ACK `:1289-1398`) ;
  `:1425-1524` `dispatchSmsAttempt` ; `:1532-1735` worker ; `:1737-1803` sentinelle RESTORE.
- `apps/api/src/vehicle-schedules/schedule-cron.service.ts` : `:155-167` crons ; `:192-236`
  évaluation (filtre CUT-only `:204-208`, tri RESTORE d'abord `:212-219`) ; `:238-474` `evaluateOne`
  (dormance `:258-263`, override `:266-272`, backoff/cadenceur `:304-327`, appel `:340-351`, reports
  `:352-422`, avancement `:426-441`).
- `apps/api/src/vehicle-schedules/automatic-cut-queue.ts` : `:1-26`.
- `apps/api/src/vehicle-schedules/vehicle-schedules.service.ts` : `:155-211` activation immédiate ;
  `:224-234` réactivation.
- `apps/api/src/vehicle-schedules/fleet-schedules.service.ts` : `:450-481` bulk ; `:551-563` classement.
- `apps/api/src/sms/sms-gateway.service.ts` : `:226-239` file ; `:271-281` intervalle ; `:358-549`
  santé ; `:582-608` lecture statut relais ; `:610-672` réconciliation ; `:678-719` webhook statut ;
  `:729-800` envoi/file ; `:972-1161` envoi vizyo-texto (timeout 10 s `:986`).
- `apps/api/src/sms/sms-gateway-watchdog.service.ts` : `:22` cron ; `:24` garde provider ; `:28`
  santé ; `:30-35` réarmement ; `:36-37` rappel ; `:43-55` alerte ; `:56-66` erreur.
- `apps/api/src/sms/sms-webhook.controller.ts` : `:69-129` entrant ; `:132-174` statut sortant.
- `apps/api/src/sms/sms-heartbeat.service.ts` : `:109`, `:131` crons hebdomadaires.
- `apps/api/src/positions/positions.service.ts` : `:32` fenêtre RESTORE ; `:825-889` confirmation.
- `apps/api/src/vehicles/vehicles.service.ts` : `:1101-1146` projection de l'état coupé.
- `apps/api/src/engine-control/engine-control.controller.ts` : `:50-79`.
- `apps/api/prisma/migrations/20260912110000_engine_delivery_reliability/migration.sql` : `:1-57`.
- `apps/web/src/app/features/engine-control/engine-control-button.component.ts` : `:355-357` verrou ;
  `:370-401` état coupé ; `:489-548` pastille ; `:806-879` confirmation.
- `apps/web/src/app/shared/ui/confirm-modal/confirm-modal.component.ts` : `:98-112` curseur ;
  `:340-355` relâchement.
- `apps/web/src/app/core/services/engine-command-lock.service.ts`, `engine-control.service.ts:32-42`,
  `realtime.service.ts:469-492`.
- Texto : `src/config/env.ts:17-23`, `:39-46` ; `src/capcom6/capcom6.service.ts:68-135` ;
  `src/messages/messages.service.ts:168-267` ; `src/messages/messages.controller.ts:26-40` ;
  `src/webhooks/webhooks.controller.ts:51-124` ; `src/webhooks/webhook-delivery.service.ts` ;
  `src/auth/api-key.guard.ts`.
