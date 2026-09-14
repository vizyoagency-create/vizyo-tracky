# Architecture cible

## Invariants métier

1. `desiredEngineState` est distinct de l'état de transport.
2. Une soumission ne vaut jamais une exécution.
3. Toute tentative possède un identifiant, un canal, des timestamps et un résultat.
4. Une intention RESTORE survit à un crash, un redéploiement et une indisponibilité réseau.
5. RESTORE peut être répété ; CUT ne peut pas être rejoué après sa date de validité.
6. Une transition de planning n'est terminée que lorsque son orchestrateur atteint une issue définie.
7. Un état inconnu est affiché comme inconnu, jamais comme normal.
8. Le serveur, pas le bouton, garantit l'idempotence.

## Modèle conceptuel

### Intention

`EngineIntent` représente le résultat métier voulu :

- `id`, `trackerId`, `vehicleId`, `fleetId` ;
- `action: CUT | RESTORE` ;
- `source`, `reason`, `requestedBy` ;
- `idempotencyKey` ;
- `desiredAt`, `deadlineAt`, `validUntil` ;
- `state` ;
- `attemptCount`, `nextAttemptAt` ;
- `terminalReason`, `confirmedAt` ;
- lien optionnel vers une transition de planning.

### Tentative

`EngineDeliveryAttempt` représente un essai réel :

- `intentId`, `attemptNo`, `channel: TCP | SMS_PRIMARY | SMS_SECONDARY` ;
- état de socket et âge de la dernière trame au moment du choix ;
- payload hashé/masqué ;
- identifiant fournisseur ;
- `submittedAt`, `transportAcceptedAt`, `sentAt`, `deliveredAt`, `deviceAckAt` ;
- ACK brut contrôlé et latence ;
- code et message d'erreur ;
- résultat terminal.

### États proposés

```text
CREATED
  -> WAITING_TCP
  -> TCP_SUBMITTED
  -> TCP_ACKNOWLEDGED
  -> SMS_QUEUED
  -> SMS_SENT
  -> SMS_DELIVERED_UNCONFIRMED
  -> DEVICE_ACKNOWLEDGED
  -> RETRY_WAIT
  -> ESCALATION_REQUIRED
  -> FAILED_TERMINAL
  -> CANCELLED / EXPIRED
```

L'état métier `RESTORED_CONFIRMED` ne peut venir que d'une preuve boîtier qualifiée ou d'une confirmation terrain auditée. `SMS_SENT` et `SMS_DELIVERED` restent des preuves de transport.

## Orchestrateur RESTORE

### Stratégie normale, TCP prioritaire

1. Créer l'intention durable avant tout I/O.
2. Si une socket saine existe, envoyer K et attendre `kt` pendant une fenêtre courte.
3. Si la socket est absente, garder l'intention `WAITING_TCP` et l'attacher au prochain login du boîtier.
4. Retenter TCP aux reconnexions et selon un calendrier borné.
5. À l'approche de l'échéance, soumettre le SMS dans une file régulée.
6. Réconcilier chaque statut SMS jusqu'au terminal.
7. Après échec SMS primaire, utiliser la passerelle secondaire selon politique.
8. Continuer à envoyer K au prochain TCP tant que la restauration n'est pas prouvée.
9. Lever une alerte humaine avant l'heure de départ, pas après.

*État au 14/09 (T56, document 32) :* points 1, 2, 3, 4, 6, 8 et 9 **tenus** par le code (documents
20, 22, 24, 28 ; « `WAITING_TCP` » est le statut `PENDING` avec `channel = TCP`). Point 5 tenu
**autrement** : le SMS part après l'attente TCP de 15 s et un second essai TCP du worker, pas « à
l'approche de l'échéance ». Point 7 (passerelle secondaire) **non implémenté** (document 12).

### Fenêtre proposée pour les horaires

- T−30 min : création des intentions RESTORE et opportunités TCP.
- T−20 min : nouveau passage TCP pour les non confirmés.
- T−10 min : fallback SMS primaire, régulé.
- T−5 min : seconde voie ou escalade immédiate.
- T : aucun véhicule ne doit être silencieusement « supposé restauré ».

Cette anticipation est une décision métier à valider, car elle rend le véhicule utilisable avant le début exact de la plage. Elle peut être configurée par flotte.

## Orchestrateur CUT

- Vérifier les règles vitesse, fraîcheur GPS, immobilité et rôle.
- Vérifier l'interlock de restauration avant la création du CUT automatique.
- Donner au CUT une durée de validité courte.
- Ne jamais vider une vieille commande CUT lors d'une reconnexion tardive.
- Ne pas basculer l'état métier sur simple écriture socket.
- Un CUT non confirmé reste `CUT_PENDING/UNKNOWN`, avec consigne terrain explicite.
- RESTORE annule toute intention CUT encore non exécutée.

## Interlock de restauration

Avant chaque vague automatique CUT, calculer un verdict par flotte :

- listener TCP et worker de commandes sains ;
- base et file durable accessibles ;
- taux de sockets/frames connu ;
- passerelle primaire vue récemment ;
- dernier préflight SMS terminal réussi ;
- file SMS sous le seuil ;
- passerelle secondaire disponible ou procédure humaine active ;
- aucun incident P0 ouvert sur la chaîne de restauration.

Verdicts :

- `HEALTHY` : CUT automatique permis ;
- `DEGRADED` : CUT différé/refusé, alerte ;
- `UNKNOWN` : fail-open, CUT refusé ;
- `DISABLED` : aucune automatisation moteur.

## Régulation SMS

- Une file FIFO dédiée aux commandes moteur.
- RESTORE prioritaire sur tout autre SMS.
- Débit initial conservateur : 1 SMS toutes les 10–15 secondes et plafond 4/minute, à valider sur le forfait réel.
- Aucun burst lors d'un cron de flotte.
- Validité explicite des messages.
- Slot SIM configuré et enregistré dans les tentatives.
- Backoff avec jitter sur erreur temporaire.
- Circuit breaker sur taux d'échec élevé.
- Les statuts hors ordre et dupliqués sont acceptés de façon idempotente.

## Réconciliation relais

Deux mécanismes complémentaires :

1. webhook signé du relais vers Tracky pour chaque changement terminal ;
2. poller de rattrapage pour tout message non terminal trop ancien.

Le relais doit conserver et transmettre : `providerId`, `state`, `errorCode`, `errorMessage`, timestamps et identité du device/SIM. Tracky met à jour la tentative et recalcule l'intention dans une transaction idempotente.

## État UI cible

Afficher deux lignes indépendantes :

```text
Planning : désactivé
Moteur   : restauration en cours par SMS · envoyé à 19:55 · aucune preuve boîtier
```

États moteur autorisés :

- Normal confirmé ;
- Coupure en cours ;
- Coupé confirmé ;
- Restauration en cours ;
- Restauré confirmé ;
- Non confirmé — action requise ;
- Échec — action requise ;
- Inconnu.

Pendant une commande :

- tous les boutons du même tracker sont grisés via un store partagé ;
- spinner et libellé d'étape visibles ;
- fermeture bloquée uniquement pendant la soumission critique, puis suivi persistant ;
- la navigation ou le refresh ne fait pas perdre le suivi ;
- l'état est rechargé depuis le serveur, jamais seulement depuis la mémoire du composant.

## Idempotence et concurrence

- `idempotencyKey` générée pour chaque intention utilisateur ou transition planifiée.
- Index unique côté base.
- Verrou logique par tracker sur les intentions incompatibles.
- Deux RESTORE identiques rapprochés rejoignent la même intention.
- RESTORE préempte/annule un CUT en attente.
- Deux onglets et deux utilisateurs obtiennent le même `intentId`.
- Journaliser la déduplication au lieu de la cacher.

## Observabilité

Chaque intention doit fournir une timeline unique :

```text
06:30:00 intention RESTORE créée
06:30:00 socket absente, dernière trame 42 s
06:31:18 reconnexion TCP
06:31:18 K écrit
06:31:20 kt reçu, latence 1,8 s
06:31:20 restauration confirmée
```

Métriques minimales :

- taux ACK TCP et latence p50/p95/p99 ;
- part de commandes ayant nécessité SMS ;
- délai `queued -> sent -> delivered` ;
- taux d'échec par téléphone, SIM, opérateur et code ;
- âge et profondeur des files ;
- intentions RESTORE dépassant leur échéance ;
- CUT refusés par l'interlock ;
- commandes dédupliquées ;
- véhicules sans preuve à T−5 et à T.

## Redondance

La cible robuste comprend :

- TCP comme canal économique principal ;
- téléphone/SIM primaire ;
- seconde passerelle réellement indépendante : autre téléphone, autre SIM et idéalement autre opérateur ;
- procédure humaine documentée.

Deux applications sur le même téléphone ou deux services utilisant la même SIM ne constituent pas deux voies indépendantes.
