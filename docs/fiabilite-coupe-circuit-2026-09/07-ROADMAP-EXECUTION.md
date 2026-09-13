# Roadmap d'exécution bug par bug

## Décision de sécurité

Les horaires automatiques CDEF et MH Cars restent désactivés jusqu'à la fin des lots P0, des tests de panne et du canari terrain. Aucun lot de cette roadmap ne réactive un planning.

L'objectif réaliste n'est pas « aucun réseau ne tombera jamais », mais : aucune restauration ne se perd, aucun échec ne reste invisible, aucune coupure automatique n'est autorisée si la reprise n'est pas démontrée disponible.

## Suivi d'exécution dans le worktree

Branche : `codex/tracky-cutoff-reliability-2026-09-12`

Worktree : `D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky-reliability-sep2026`
Production : **hors périmètre — aucun déploiement ni changement VPS autorisé dans ce chantier**

- [x] R0.1 — Worktree et branche isolés créés.
- [x] R0.2 — Audits, captures, vidéo et diagnostic téléphone conservés dans le dossier documentaire.
- [x] R1.1 — Identifiants corrélés intention/tentatives/SMS.
- [x] R1.2 — Journal durable des tentatives TCP et SMS.
- [x] R1.3 — Sentinelle de réconciliation des statuts SMS et alertes sous 60 s.
- [x] R2.1 — `queued`, `SENT` et `TCP_WRITTEN` ne valent plus restauration confirmée.
- [x] R2.2 — API et WebSocket exposent l'état réellement persisté.
- [x] R2.3 — UI conserve l'état en attente/non confirmé et explique le blocage.
- [x] R3.1 — Idempotence serveur et déduplication d'une intention active.
- [x] R3.2 — Verrouillage cohérent multi-vues/multi-utilisateurs ; carte et fiche unifiées sur le même composant.
- [x] R4.1 — Fallback SMS durable après socket absente ou timeout d'ACK TCP.
- [x] R4.2 — Reprise des RESTORE après redémarrage et retries bornés/temporisés.
- [x] R4.3 — Priorité RESTORE et annulation des CUT incompatibles.
- [x] R5.1 — Kill-switch des CUT automatiques, désactivé par défaut.
- [x] R5.2 — Interlock de santé fail-closed avant CUT automatique.
- [x] R6.1 — File SMS FIFO et cadence prudente configurable.
- [x] R6.1b — File CUT automatique du bouton flotte : une coupe/10 s, reprise prioritaire, état récupérable après crash.
- [ ] R6.2 — Heartbeat/ping, fraîcheur et métriques de passerelle.
- [x] R6.3 — Procédure du second téléphone documentée (achat différé).
- [x] R7.1 — Tests unitaires et intégration des scénarios critiques.
- [ ] R7.2 — Tests de crash/reprise, ACK perdu, webhook perdu et rafale de 22 RESTORE.
- [x] R7.3 — Runbook, variables, rollback et critères Go/No-Go finalisés.
- [ ] R7.4 — Canari terrain et réactivation progressive (nécessite décision explicite ultérieure).

Règle de coche : une case n'est cochée qu'après code, test automatisé pertinent et documentation de rollback. Les étapes terrain et production restent nécessairement non cochées tant qu'elles n'ont pas été explicitement autorisées et réalisées.

## Ordre obligatoire

L'ordre ci-dessous est une dépendance technique, pas une préférence. On commence par voir la vérité, puis on corrige les états, ensuite seulement on automatise les retries. Sinon une nouvelle logique pourrait multiplier silencieusement les SMS ou présenter un faux succès.

| Lot | Priorité | Bugs couverts | Résultat attendu | Condition de sortie |
|---|---:|---|---|---|
| R0 | immédiat | conservation des preuves | Journal complet et configuration du téléphone sauvegardés | L'incident est reproductible et horodaté |
| R1 | P0 | CC-004, 013, 028, 030, 032 | Chaque tentative est visible de bout en bout | Un échec apparaît dans Tracky en moins de 60 s |
| R2 | P0 | CC-001, 005, 008, 009, 010, 021 | Plus aucun faux état « restauré » | `queued/sent` ne nettoie jamais l'état coupé |
| R3 | P0 | CC-016 à 020 | Une intention unique malgré clics concurrents | Tests multi-onglets et multi-utilisateurs verts |
| R4 | P0 | CC-002, 003, 007, 027 | RESTORE durable et rejouable | Crash, socket absente et ACK perdu sont récupérés |
| R5 | P0 | CC-006, 014, 026 | Interlock fail-closed avant CUT | Une panne volontaire du secours bloque la CUT |
| R6 | P1 | CC-011, 012, 015, 024, 029, 031 | Passerelle SMS régulée et redondante | Vague de 22 RESTORE dans le SLO sans rafale |
| R7 | validation | CC-022, 023 et ensemble du registre | Canari puis réactivation progressive | Critères terrain signés, rollback testé |

## R0 — préserver les preuves avant toute manipulation du téléphone

Actions :

1. exporter le journal complet SMSGate couvrant au minimum du 1er au 12 septembre ;
2. photographier ou exporter la version Android, One UI, SMSGate, date de mise à jour, uptime/redémarrages et mises à jour système ;
3. relever opérateur, SIM/slot choisi, forfait/solde, SMSC si accessible et état des rapports de livraison ;
4. capturer les écrans batterie de SMSGate, applications en veille, permissions SMS/téléphone/notifications et démarrage automatique ;
5. conserver pour chaque test l'identifiant Tracky, l'identifiant du relais et l'identifiant SMSGate ;
6. comparer l'heure du message dans Tracky, sa récupération, `ACTION_SENT`, son apparition dans les SMS envoyés et l'ACK du boîtier.

Observabilité à poser dès ce lot : une fiche d'essai unique avec fuseau explicite `Europe/Paris` et UTC, modèle de téléphone, version d'application, SIM, signal et état écran allumé/éteint.

Interdit pendant R0 : réinstaller SMSGate, effacer ses données ou mettre à jour l'unique téléphone avant export. Ces actions pourraient supprimer la preuve.

## R1 — construire la vérité de bout en bout

### R1.1 — identité corrélée

Créer un `engineIntentId` idempotent, un `attemptId` par essai et conserver les identifiants fournisseur. Tous les logs, événements WebSocket et alertes doivent transporter ces valeurs avec `trackerId`, plaque, canal, action et timestamps.

### R1.2 — machine d'état observable

États minimaux :

`INTENT_CREATED → TCP_QUEUED → TCP_WRITTEN → TCP_ACKED`

ou

`SMS_QUEUED → PHONE_PICKED_UP → MODEM_ACCEPTED → SENT → DELIVERED`

avec branches `RETRY_SCHEDULED`, `FAILED`, `EXPIRED`, `CANCELLED` et `FIELD_CONFIRMED`.

Chaque transition doit enregistrer : acteur, ancien état, nouvel état, raison, code brut, latence depuis l'intention et prochain retry. Aucun code brut n'est perdu, mais le centre d'alertes ajoute une explication exploitable.

### R1.3 — réconciliation indépendante des webhooks

- recevoir les webhooks terminaux et vérifier leur signature ;
- poller les messages non terminaux toutes les 30 à 60 secondes ;
- considérer le webhook comme accélérateur, jamais comme l'unique vérité ;
- rendre les événements désordonnés et dupliqués idempotents ;
- surveiller `lastSeen`, `system:ping`, batterie, charge, version, âge de la plus vieille entrée et dernier message effectivement envoyé.

Alertes minimales :

- passerelle sans ping depuis 90 secondes ;
- message encore `queued/pending` après 60 secondes pour RESTORE ;
- échec Android terminal immédiat avec plaque et code ;
- aucun ACK boîtier dans le délai ;
- retard ou absence de webhook sans confondre cela avec un échec d'envoi ;
- version de passerelle différente de la version qualifiée.

Test de sortie : injecter un `RESULT_ERROR_GENERIC_FAILURE` et voir dans le centre d'alertes, en moins de 60 secondes, la plaque, le canal, la tentative, le code Android, l'âge de la commande et l'action suivante.

## R2 — corriger la sémantique métier et l'interface

### R2.1 — séparer les quatre vérités

- planning demandé ;
- intention moteur ;
- transport TCP/SMS ;
- exécution prouvée par `kt`, télémétrie compatible ou validation terrain tracée.

`queued`, `TCP_WRITTEN`, `SENT` et `DELIVERED` sont des preuves de transport, pas une preuve que le relais du véhicule a changé d'état.

### R2.2 — comportement écran

- conserver `RESTORE_PENDING` ou `RESTORE_UNCONFIRMED` tant qu'aucune preuve d'exécution n'existe ;
- afficher planning et état moteur sur deux lignes indépendantes ;
- ne jamais masquer un moteur coupé parce que le planning est désactivé ;
- afficher la progression réelle : création, TCP, ACK, SMS, téléphone, échec/retry ;
- laisser le résultat visible après fermeture de la modale.

Test de sortie : une réponse HTTP 200/`queued` suivie d'un échec SMS laisse le véhicule en alerte, ne le montre pas restauré et propose l'action opérateur correcte.

## R3 — verrouillage et idempotence

- clé d'idempotence générée par intention métier, pas par clic ;
- contrainte unique en base pour un RESTORE actif par tracker ;
- lease serveur pour le worker ;
- store UI partagé par tracker entre carte, liste et modales ;
- boutons, switchs, fermeture et backdrop bloqués pendant la phase critique ;
- réponse d'une désactivation contenant `restoreRequired`, `engineIntentId` et état courant ;
- RESTORE nouveau annule toutes les CUT non exécutées incompatibles.

Test de sortie : 20 appels simultanés depuis deux sessions produisent une seule intention et aucune commande contradictoire.

## R4 — orchestrateur RESTORE durable, TCP d'abord

### Politique proposée

1. enregistrer l'intention et l'outbox dans la même transaction ;
2. si socket présente, envoyer TCP et attendre l'ACK `kt` dans une fenêtre mesurée ;
3. sans ACK, garder la tentative visible et planifier le fallback, au lieu de déclarer succès ;
4. si socket absente, conserver le RESTORE dans une file TCP prioritaire et le rejouer dès la reconnexion ;
5. en parallèle ou après un délai configurable validé par tests, déclencher le secours SMS ;
6. réguler les retries avec backoff et jitter, sans abandonner l'intention RESTORE ;
7. après redémarrage API/Redis/VPS, reprendre exactement au dernier état durable.

Le choix série/parallèle entre TCP et SMS doit être configuré par flotte. Pour une échéance critique, on pourra préparer le RESTORE avant l'heure de départ et réserver le SMS à l'absence d'ACK, afin de réduire le coût sans sacrifier le délai.

SLO initial à mesurer puis ajuster : 95 % des RESTORE prouvés en moins de 60 secondes lorsque le boîtier est joignable ; alerte humaine à 60 secondes ; escalade renforcée à 3 minutes.

Test de sortie : tuer l'API entre la création et le dispatch, couper la socket, perdre l'ACK puis reconnecter le boîtier. L'intention survit, se rejoue et ne devient jamais faussement `CONFIRMED`.

## R5 — interlock fail-closed avant toute CUT

Calculer un verdict par flotte :

- `HEALTHY` : TCP observé, passerelle(s) fraîche(s), test SMS récent, file vide et aucune alerte critique ;
- `DEGRADED` : un canal manque mais un secours indépendant est prouvé ;
- `UNSAFE` : aucune capacité de restauration dans le SLO.

Une CUT automatique est refusée ou différée si le verdict n'est pas `HEALTHY`. Le refus crée une alerte, mais n'immobilise jamais le véhicule. Un préflight est exécuté avant chaque fenêtre critique et un test synthétique quotidien vérifie le chemin SMS sans attendre un incident réel.

Test de sortie : éteindre le téléphone, casser FCM ou simuler un relais muet ; la CUT ne part pas et l'exploitant connaît la cause avant la fenêtre.

## R6 — fiabiliser la passerelle SMS

### R6.1 — régulation

- FIFO dédiée aux RESTORE ;
- priorité RESTORE supérieure aux autres SMS ;
- débit de départ prudent : un SMS toutes les 10 à 15 secondes, à valider avec la SIM et l'opérateur ;
- pas de retry aveugle après statut ambigu ;
- limites par minute et par 30 minutes configurées et visibles ;
- slot SIM fixé explicitement.

### R6.2 — téléphone et application

- téléphone dédié, constamment alimenté, batterie en mode non restreint pour SMSGate ;
- notification persistante et démarrage vérifiés ;
- ping rapproché et alerte de fraîcheur ;
- qualification d'une version SMSGate récente sur un second téléphone, sans mise à jour directe de l'unique passerelle ;
- tests écran éteint, application balayée, redémarrage, perte Wi-Fi/4G, mode économie, perte FCM et rafale contrôlée.

### R6.3 — indépendance

Une seule application, un seul téléphone, une seule SIM et un seul opérateur ne constituent pas un secours. Ajouter au minimum une deuxième voie indépendante : second téléphone/SIM/opérateur explicitement adressable, fournisseur SMS professionnel, ou modem GSM industriel. La bascule doit dépendre d'un verdict de santé, pas d'une sélection aléatoire.

Test de sortie : 22 RESTORE sont traités dans le budget de délai sans erreur, puis le même test est répété avec le téléphone principal indisponible.

## R7 — stratégie de livraison

1. tests unitaires de transitions et idempotence ;
2. intégration Tracky ↔ relais avec webhooks retardés, dupliqués, perdus et désordonnés ;
3. E2E interface multi-vues et multi-utilisateurs ;
4. chaos : crash API, Redis, réseau, FCM, téléphone et opérateur ;
5. banc avec boîtier et relais observables ;
6. deux véhicules internes non critiques pendant trois cycles minimum ;
7. petit groupe avec présence terrain ;
8. CDEF en dernier, après revue écrite des métriques et test du rollback.

## Tableau de bord obligatoire

Pour chaque flotte et canal :

- taux d'ACK TCP et latence p50/p95/p99 ;
- sockets présentes au moment du dispatch ;
- taux de fallback et sa cause ;
- âge de la file SMS, temps avant prise en charge téléphone, taux `sent/delivered/failed` ;
- erreurs par code Android, SIM, opérateur, version et plage horaire ;
- fraîcheur du dernier ping, état batterie/charge et version SMSGate ;
- nombre de RESTORE non confirmés et âge maximal ;
- nombre de CUT bloquées par l'interlock ;
- coût SMS évité/utilisé sans sacrifier les SLO.

## Définition de « terminé »

Un bug n'est pas clos quand le code est fusionné. Il est clos quand : test automatique présent, métrique et alerte présentes, scénario de panne exercé, canari terrain passé, rollback documenté et preuve conservée.

## Contre-vérification du 13 septembre 2026

- suite API complète : succès, zéro échec (les nombres exacts sont relevés dans chaque rapport de campagne) ;
- tests ciblés moteur + SMS : succès, zéro échec ;
- builds API, package partagé et Web : succès ;
- schéma Prisma : valide ; migration SQL et contraintes relues ;
- `git diff --check` : aucun défaut d'espacement ;
- production non modifiée : travail limité à `codex/tracky-cutoff-reliability-2026-09-12`.

Le code n'est pas déclaré prêt production tant que R6.2, R7.2 et R7.4 restent décochés. Ces points exigent notamment le relais/téléphone réel, une vague contrôlée de 22 RESTORE, un test de crash/reprise sur une base de test et un canari véhicule avec présence terrain.
