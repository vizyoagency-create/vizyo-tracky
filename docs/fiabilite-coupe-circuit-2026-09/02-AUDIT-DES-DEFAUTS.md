# Audit des défauts

## Échelle

- P0 : peut laisser un véhicule immobilisé ou créer une fausse certitude ; bloque la remise en service.
- P1 : peut retarder la récupération ou masquer une dégradation importante.
- P2 : dette de robustesse, sécurité ou ergonomie à traiter avant généralisation.

## Registre

| ID     | Priorité | Défaut                                                            | Conséquence actuelle                                                    | Correction attendue                                                                                                                             |
| ------ | -------: | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CC-001 |       P0 | `queued` SMS traité comme réussite                                | Le planning ne retente plus                                             | Distinguer soumission, transport terminal et preuve boîtier                                                                                     |
| CC-002 |       P0 | Aucun fallback après timeout ACK TCP                              | RESTORE perdu après simple écriture socket                              | Fallback et retry durable après absence de `kt`                                                                                                 |
| CC-003 |       P0 | Pas de file TCP persistante                                       | Une socket absente forçait un SMS après 15 s, sans relance à la reconnexion (état du 11/09) | Stocker l'intention et vider à la reconnexion — **fait** : intention durable en base (12/09) et relance à la connexion du boîtier (T42, doc 22) ; pas de file dédiée, l'intention tient ce rôle |
| CC-004 |       P0 | Statuts SMS non réconciliés globalement                           | Échecs Android invisibles dans Tracky                                   | Webhook sortant ou polling régulier de tous les messages                                                                                        |
| CC-005 |       P0 | Le cron avance `lastEvaluatedState` trop tôt                      | Aucun nouveau RESTORE après échec asynchrone                            | Avancer l'état uniquement via un orchestrateur terminal                                                                                         |
| CC-006 |       P0 | Pas d'interlock avant CUT                                         | On coupe même si le chemin de reprise est dégradé                       | Refuser/différer CUT et alerter                                                                                                                 |
| CC-007 |       P0 | RESTORE non durable au redémarrage API                            | Perte possible entre création, dispatch et retry                        | Job/outbox transactionnel repris après crash                                                                                                    |
| CC-008 |       P0 | UI efface « coupé » sur RESTORE `SENT`                            | Fausse impression de véhicule restauré                                  | Conserver `RESTORE_PENDING/UNCONFIRMED` jusqu'à preuve                                                                                          |
| CC-009 |       P0 | « Automatisation off » masque l'état moteur                       | Un véhicule peut rester coupé hors planning sans signal visuel          | Deux axes d'état indépendants et toujours visibles                                                                                              |
| CC-010 |       P0 | `SENT_UNCONFIRMED` RESTORE affiché « Envoyé »                     | Le doute disparaît de l'écran                                           | Branche UI explicite et action opérateur requise                                                                                                |
| CC-011 |       P1 | Rafale SMS non régulée                                            | Erreurs Android/modem/opérateur probables                               | FIFO, token bucket et débit conservateur                                                                                                        |
| CC-012 |       P1 | Polling téléphone observé à 15 min                                | Retard incompatible avec le départ des véhicules                        | Push supervisé + polling 30–60 s + alerte de fraîcheur                                                                                          |
| CC-013 |       P1 | Le relais perd le détail d'échec webhook                          | Cause technique absente                                                 | Persister et propager `errorCode/errorMessage`                                                                                                  |
| CC-014 |       P1 | Heartbeat SMS hebdomadaire                                        | Une panne peut durer plusieurs jours                                    | Préflight quotidien et avant chaque fenêtre critique                                                                                            |
| CC-015 |       P1 | Une seule passerelle téléphone/SIM                                | Point de panne unique                                                   | Deuxième passerelle/SIM/opérateur indépendant                                                                                                   |
| CC-016 |       P1 | Pas d'idempotency key serveur                                     | Doublons possibles multi-onglets/multi-utilisateurs                     | Clé unique d'intention et verrou DB                                                                                                             |
| CC-017 |       P1 | Verrous UI locaux au composant                                    | Deux vues du même tracker peuvent agir en parallèle                     | Store partagé par tracker et verrou serveur autoritaire                                                                                         |
| CC-018 |       P1 | Modale individuelle fermée avant fin de requête                   | Chargement invisible, action réouvrable                                 | Conserver un état visible et bloquer toutes les commandes liées                                                                                 |
| CC-019 |       P1 | Éditeur horaire actif pendant `saving`                            | Course UI/API et état local incohérent                                  | Désactiver switch/champs/fermeture pendant sauvegarde                                                                                           |
| CC-020 |       P1 | Backdrop bulk cliquable pendant `applying`                        | La requête continue hors écran                                          | Bloquer fermeture ou afficher un suivi persistant                                                                                               |
| CC-021 |       P1 | Désactivation annoncée comme succès sans résultat RESTORE         | Exploitant rassuré prématurément                                        | Réponse avec `restoreRequired`, `commandId`, statut et suivi                                                                                    |
| CC-022 |       P1 | Pas de tests composants critiques                                 | Régressions de boutons/états non détectées                              | Tests Angular des trois composants concernés                                                                                                    |
| CC-023 |       P1 | Pas de test d'intégration réel relais↔Tracky                      | Contrat de statuts non protégé                                          | Environnement intégré avec webhooks désordonnés                                                                                                 |
| CC-024 |       P2 | SIM émettrice non fixée explicitement                             | Mauvaise SIM possible sur double-SIM                                    | Configurer et superviser le slot SIM                                                                                                            |
| CC-025 |       P2 | Mot de passe Coban `123456` codé en dur                           | Risque sécurité et divergence terrain                                   | Secret par tracker, chiffré et rotatif                                                                                                          |
| CC-026 |       P2 | Plannings de véhicules durablement muets encore activables        | Commandes impossibles et bruit                                          | Blocage/avertissement explicite selon politique flotte                                                                                          |
| CC-027 |       P2 | Pas de date de validité métier différente CUT/RESTORE             | Une CUT tardive peut devenir dangereuse                                 | Expiration courte CUT, RESTORE rejouable jusqu'à preuve/annulation                                                                              |
| CC-028 |       P0 | Santé réelle de la passerelle Android absente de Tracky           | Une passerelle connectée au serveur peut être incapable de se réveiller | Ping authentifié, fraîcheur, version et âge de file visibles ; batterie/charge signalées indisponibles tant que l'API Android ne les expose pas |
| CC-029 |       P0 | Android refuse parfois le service de premier plan en arrière-plan | Le téléphone reçoit le travail mais le traite très tard                 | Corriger les réglages OS, tester une version récente et surveiller le cycle de vie                                                              |
| CC-030 |       P1 | Échec d'inscription `Job was cancelled` non remonté               | Push/registration dégradé sans alerte Tracky                            | Remonter le défaut et déclencher le polling de secours supervisé                                                                                |
| CC-031 |       P1 | SMSGate `1.65.0` ne contient pas les corrections récentes         | Risque de worker et de statuts perdus déjà corrigés en amont            | Qualification en banc d'une version récente, puis canari avec rollback                                                                          |
| CC-032 |       P1 | File mobile restée environ 1 h 06 sans escalade                   | Un RESTORE urgent attend silencieusement                                | SLO d'âge de file, alerte à 60 s et bascule secondaire bornée                                                                                   |

## Défauts d'état et de vocabulaire

Les états actuels mélangent quatre notions :

- l'intention métier : le véhicule doit être utilisable ou immobilisé ;
- la soumission : la requête a été acceptée par un composant ;
- le transport : TCP écrit, SMS envoyé ou délivré ;
- l'exécution : le boîtier a accusé ou le terrain a confirmé.

Cette confusion apparaît dans plusieurs endroits :

- `EngineControlCommand.status` ne suffit pas à raconter les deux canaux et leurs tentatives ;
- `lastEvaluatedState` décrit à la fois le planning voulu et une action supposée réussie ;
- `engineCutState` est nettoyé sur un RESTORE seulement `SENT` ;
- le toast « Rallumage envoyé » est correct, mais l'état du bouton devient déjà « normal » ;
- la liste horaires privilégie `scheduleEnabled=false` avant l'état moteur.

## Défauts des boutons

### Bouton moteur partagé

- La protection `if (loading()) return` limite les doubles clics dans une seule instance.
- Les boutons principaux n'ont pas tous `[disabled]="loading()"`.
- La modale est fermée avant la réponse réseau, donc son spinner n'est jamais visible pendant le vrai traitement.
- Une autre instance du bouton pour le même tracker possède son propre `loading`.
- Deux onglets ou deux utilisateurs ne partagent aucun verrou client.

### Carte

- La modale reste correctement visible et grisée pendant la requête.
- Le serveur demeure toutefois la seule protection fiable contre la concurrence.
- La vue hérite de la fausse transition vers « normal » sur RESTORE `SENT` via l'état temps réel.

### Éditeur horaire individuel

- La confirmation se ferme avant `save()`.
- Le switch global et les champs ne sont désactivés que par `readonly`, pas par `saving`.
- Le drawer peut être fermé pendant la requête.
- En cas d'échec, l'état optimiste peut rester visuellement désactivé alors que le serveur ne l'est pas.

### Désactivation en masse

- Le bouton confirmer est grisé pendant `applying` et le texte devient `Application…`.
- Le clic sur le fond peut néanmoins fermer la modale.
- La méthode n'a pas de garde interne contre une seconde invocation.
- L'API n'a pas de clé d'idempotence ; deux requêtes concurrentes peuvent toutes deux lire `wasEnabled=true` et produire plusieurs RESTORE.
- Pour une désactivation, le panneau de résultats détaillés n'est pas conservé.

## Couverture existante et lacunes

Points positifs :

- couverture API importante du contrôle moteur, des vitesses, de la dormance et des règles CUT ;
- tests du backoff des coupes ;
- tests unitaires de réconciliation SMS ;
- tests du heartbeat hebdomadaire.

Lacunes bloquantes :

- aucun spec du composant `engine-control-button` ;
- aucun spec du composant `fleet-schedules` ;
- aucun spec de `vehicle-schedule` ;
- pas de spec dédié du service `VehicleSchedulesService` ;
- pas de test crash/restart entre `PENDING` et dispatch ;
- pas de test bout en bout avec le relais et des statuts asynchrones ;
- pas de test de 22 RESTORE simultanés avec régulation SMS ;
- pas de test multi-onglets/multi-utilisateurs ;
- pas de test prouvant qu'une désactivation ne peut pas masquer un moteur encore coupé.
