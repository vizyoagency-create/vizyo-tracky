# 22 — Correctif P1-1 (T42) : une RESTORE repart à la reconnexion et n'est jamais terminale sans preuve

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé sur la branche, non déployé.

## Le défaut corrigé (document 19, P1-1)

Personne n'écoutait la reconnexion d'un boîtier : aucun événement n'était émis par le registre de
sockets, aucun abonné ne relançait une RESTORE. L'attente TCP d'une RESTORE dont la socket était
absente valait **un seul créneau de 15 s**, puis le secours SMS. Et après trois SMS refusés, la
RESTORE passait `FAILED`, sa clé était libérée, et le cron des horaires — qui avait déjà avancé
`lastEvaluatedState` — ne la recréait jamais.

Scénario mesurable : téléphone passerelle mort, boîtier hors ligne à 07:00 → trois SMS refusés →
`FAILED` + alerte ; le boîtier revient en TCP à 07:40 : **personne ne lui envoie K**. Seul un humain
rallume. Les documents promettaient pourtant « jamais abandonnée, rejouée à la reconnexion »
(README du chantier, doc 03 §Orchestrateur points 3-4-8, doc 07 R4.1 coché, CC-003).

## Ce qui change (commit Tracky, voir l'index)

| Où | Quoi |
|---|---|
| `SocketRegistryService.register` | Émet `tracker.connected { imei, remoteAddress, replaced, at }` via `EventEmitter2` (injection facultative) pour toute socket **neuve** — première inscription ou remplacement. Un login renvoyé sur la même socket n'émet rien. Émis **après** l'inscription, pour qu'un abonné qui écrit tout de suite trouve la socket. Un abonné qui lève ne casse jamais le login. |
| `EngineControlService.onTrackerConnected` | Relit la **dernière RESTORE** du boîtier créée depuis **moins de 24 h** (même fenêtre que la preuve par ignition). Si elle n'est ni acquittée, ni sous lease, ni suivie d'une COUPURE plus récente : réarmement conditionnel (`updateMany` sur `ackedAt IS NULL`) → `PENDING`, canal et SMS effacés, clé d'unicité reposée (les `FAILED` / `SENT_UNCONFIRMED` sont ravivées), `nextAttemptAt = now`, puis relance immédiate du worker. **Le budget SMS n'est pas remis à zéro** : une reconnexion n'est pas une demande neuve (le budget neuf, c'est le réarmement P0-1 sur une demande neuve). |
| Worker (`processPendingRestores`) | Avant tout envoi : si une COUPURE plus récente existe, la RESTORE est close en `SENT_UNCONFIRMED` sans rien transmettre. Si le budget SMS est épuisé (3 tentatives, plus aucun SMS en vol) : `retryTcpOnly` — K en TCP si la socket est là, sinon prochain créneau ; **plus jamais un SMS**. |
| `retryTcpOnly` | Socket absente → `nextAttemptAt = +ENGINE_RESTORE_TCP_RETRY_MIN` (30 min), rien d'autre. Socket présente → K écrite, tentative inscrite, ACK attendu ; acquittement par `updateMany` **conditionnel** (`status = SENT AND ackedAt IS NULL`), jamais par écriture aveugle. `sentAt` n'est posé qu'à la **première** transmission : l'échéance de 4 h court depuis celle-là. |
| Épuisement SMS (3 chemins : refus de soumission initial, refus de soumission au worker, échec terminal réconcilié) | Plus jamais `FAILED` : `SENT`, clé conservée, `smsLogId` effacé, créneau TCP à +30 min, `lastError` explicite, alerte **CRITICAL « secours SMS épuisé »**. |
| `requestCommand` (CUT créée) | Symétrique de la supplantation RESTORE → CUT : une COUPURE neuve clôt en `SENT_UNCONFIRMED` toute RESTORE encore ouverte du boîtier (« supplantée par une intention CUT plus récente »). L'intention la plus récente gagne, dans les deux sens. |
| `cloturerCommandesPerimees` | L'échéance de 4 h d'une RESTORE court depuis `sentAt`, **ou depuis `createdAt` si rien n'a jamais été transmis** (socket absente, SMS refusés) — sinon une telle ligne ne se fermait jamais. |
| Env | `ENGINE_RESTORE_TCP_RETRY_MIN=30` (validation, exemples, doc 13). |

## Ce que ce correctif garantit — et ne garantit pas

- Garanti : un boîtier qui revient en TCP dans les 24 h reçoit K au plus tard au tick suivant de sa
  reconnexion, pour sa dernière RESTORE non prouvée — même si elle était `FAILED` ou « nul ne
  sait » — et **seulement** si aucune COUPURE n'a été demandée depuis.
- Garanti : aucune intention ne consomme plus de `ENGINE_RESTORE_MAX_SMS_ATTEMPTS` SMS, quel que
  soit le nombre de reconnexions ; les relances TCP sont gratuites et espacées de 30 min.
- Garanti : une RESTORE ne renvoie jamais K après le J du soir. Le worker vérifie avant chaque
  envoi, et la CUT créée supplante les RESTORE ouvertes. Reste une fenêtre de quelques
  millisecondes entre la garde du worker et son écriture socket, commune à toute course
  RESTORE/CUT — famille de T48, pas de ce correctif.
- Borné : une intention meurt à 4 h après sa première transmission (ou sa création), et n'est plus
  ravivée passé 24 h après sa création. Une reconnexion dans cette fenêtre la ravive ; hors de la
  fenêtre, c'est la demande suivante (planning du lendemain, clic) qui crée une intention neuve.
- Non garanti : un boîtier qui ne renvoie jamais l'écho K. La preuve viendra alors de l'ignition
  (24 h, garde « aucune CUT depuis », statut `SENT` — c'est pourquoi l'intention reste `SENT` et
  non `FAILED` : `FAILED` était invisible à cette preuve comme à l'accusé SMS).

## Promesses documentaires désormais tenues (partie de T56)

- README du chantier : « une restauration ne doit jamais être abandonnée » — vrai : jamais
  terminale sans preuve, alertée, relancée à la reconnexion et toutes les 30 min, bornée à 4 h.
- Doc 03, orchestrateur RESTORE, points 3, 4 et 8 : intention attachée au prochain login, retentée
  aux reconnexions et selon un calendrier borné, K renvoyée au prochain TCP tant que non prouvée.
- Doc 07 R4.1 / CC-003 : « rejouer dès la reconnexion » — vrai.
- Reste faux et à corriger dans T56 : « file TCP persistante » au sens d'une file dédiée (c'est
  l'intention en base qui joue ce rôle, pas une file séparée) ; doc 02 CC-003 « une socket absente
  force immédiatement un SMS » reste vrai au premier dispatch **après** 15 s d'attente — choix
  conservé, la relance à la reconnexion couvre la suite.

## Tests ajoutés (verts)

- `socket-registry.service.spec.ts` (5) : émission à la première inscription après inscription,
  `replaced=true` au remplacement avec destruction de l'ancienne socket, pas d'émission sur la
  même socket, fonctionnement sans émetteur, abonné qui lève sans casser le login.
- `engine-control.service.spec.ts` (+13, 1 réécrit) : reconnexion → réarmement PENDING TCP d'abord
  sans budget neuf et K écrite ; `FAILED` ravivée, K en TCP, jamais un SMS, ACK conditionnel ;
  COUPURE plus récente → rien ; acquittée / sous lease / hors 24 h → rien ; clé déjà prise (P2002)
  → rien, sans lever ; abonné qui ne lève jamais ; budget épuisé + en ligne → K seule, créneau +30
  min, `sentAt` conservé ; budget épuisé + hors ligne → créneau seul, aucune tentative ; 3e SMS
  encore en file ≠ épuisé (réconciliation) ; worker clôt sans envoi sur COUPURE plus récente ;
  CUT créée supplante les RESTORE ouvertes ; CUT refusée (vitesse) ne supplante rien ; 3e refus de
  soumission → SENT + clé + créneau + CRITICAL ; 3e échec terminal réconcilié → idem (réécrit :
  l'ancien test exigeait `FAILED`) ; clôture 4 h avec horloge `createdAt` quand `sentAt` est nul.

## Ce qu'il reste

T44 (sentinelle), T45 (preuve quotidienne), T43 (téléphone), T47 (procédure), puis la recette T54
— et, pour ce correctif, sur boîtier de banc : « boîtier hors ligne, 3 SMS échouent, reconnexion
TCP → K envoyée et acquittée ». Non exercé sur un vrai boîtier à ce jour.
