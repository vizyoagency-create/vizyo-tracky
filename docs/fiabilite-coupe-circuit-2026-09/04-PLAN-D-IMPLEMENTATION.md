# Plan d'implémentation

## Règle de conduite

Ne pas livrer une grosse refonte en une fois. Chaque phase doit être observable, activable par feature flag, testée et réversible. Les horaires CDEF/MH Cars restent désactivés pendant le chantier.

## Phase 0 — préserver les preuves et figer le risque

- Conserver l'incident et les identifiants fournisseur utiles.
- Exporter les logs SMSGate du téléphone avant rotation.
- Inventorier SIM, forfait, opérateur, modèle Android, version SMSGate, réglages batterie et slot SIM.
- Vérifier qu'aucun autre mécanisme n'active automatiquement les horaires.
- Ajouter une checklist manuelle quotidienne pendant le gel.

Sortie : aucune coupure automatique possible sur les flottes gelées et preuves sauvegardées.

## Phase 1 — vérité des statuts et alertes

- Propager les webhooks sortants `sent/delivered/failed` du relais vers Tracky.
- Persister `errorCode` et `errorMessage` au niveau destinataire.
- Étendre la réconciliation à tous les SMS moteur non terminaux, pas seulement au heartbeat.
- Relier statut SMS, tentative et commande moteur.
- Créer des alertes immédiates pour échec terminal et retard anormal.
- Corriger l'affichage `SENT_UNCONFIRMED`.

Fichiers Tracky principaux :

- `apps/api/src/sms/sms-gateway.service.ts` ;
- `apps/api/src/sms/sms-heartbeat.service.ts` ;
- `apps/api/src/engine-control/engine-control.service.ts` ;
- schéma Prisma et migration ;
- contrat partagé des événements WS.

Sortie : reproduire un échec Android et le voir dans Tracky avec le bon véhicule et la bonne cause en moins de 60 secondes.

## Phase 2 — correction UI et concurrence

- Séparer visuellement planning et moteur.
- Ne plus nettoyer `cut` sur un RESTORE seulement soumis.
- Introduire un store d'opération partagé par tracker.
- Griser toutes les actions liées au tracker pendant la soumission.
- Ajouter spinner, étape et résultat persistant.
- Empêcher fermeture/backdrop pendant l'étape critique.
- Restaurer l'état serveur en cas d'échec de sauvegarde.
- Ajouter l'idempotency key à tous les appels moteur et bulk sensibles.

Composants principaux :

- `engine-control-button.component.ts` ;
- `map.component.ts` ;
- `fleet-schedules.component.ts/.html/.css` ;
- `vehicle-schedule.component.ts` ;
- `realtime.service.ts` ;
- `vehicles.service.ts` pour la projection d'état.

Sortie : aucun scénario double-clic, multi-vue ou timeout ne produit deux intentions ni un faux état rassurant.

## Phase 3 — orchestrateur RESTORE durable

- Créer `EngineIntent` et `EngineDeliveryAttempt`, ou équivalent compatible avec le modèle existant.
- Écrire l'intention et l'outbox dans la même transaction.
- Ajouter un worker durable et un mécanisme de lease.
- Vider les RESTORE en attente à chaque reconnexion TCP.
- Fallback après timeout ACK, pas seulement socket absente.
- Annuler les CUT incompatibles dès qu'un RESTORE est demandé.
- Reprendre automatiquement après crash/redeploy.

Sortie : une intention RESTORE créée avant un redémarrage est confirmée après reconnexion sans action humaine.

## Phase 4 — régulation et redondance SMS

- Déployer FIFO et débit configurables.
- Donner la priorité aux RESTORE.
- Configurer explicitement la SIM.
- Réduire/superviser le polling du téléphone et réparer la notification push.
- Ajouter une seconde passerelle indépendante.
- Ajouter circuit breaker et bascule contrôlée.

Sortie : une vague de 22 RESTORE ne crée aucune rafale et reste dans son budget de délai.

## Phase 5 — interlock et préflight

- Calculer le verdict de santé par flotte.
- Exécuter un préflight avant chaque fenêtre CUT et RESTORE.
- Refuser les CUT automatiques si le verdict n'est pas `HEALTHY`.
- Préparer les RESTORE en avance selon la politique validée.
- Afficher le verdict et sa cause dans l'administration.

Sortie : une panne volontaire du téléphone empêche le CUT automatique et déclenche une alerte explicite.

## Phase 6 — canari puis montée en charge

1. Banc uniquement.
2. Deux véhicules internes identifiés, jamais des véhicules CDEF critiques.
3. Trois cycles quotidiens contrôlés.
4. Petit groupe de flotte avec présence terrain.
5. Extension graduelle après revue des métriques.
6. CDEF en dernier, après validation écrite des critères.

## Migrations et compatibilité

- Les anciennes commandes restent lisibles en historique.
- Leur niveau de preuve doit être affiché comme `legacy/unknown`, jamais reconstruit artificiellement.
- Déployer d'abord les nouveaux champs tolérés par l'ancien code.
- Déployer ensuite l'écriture duale et l'observabilité.
- Activer le worker par feature flag.
- Basculer enfin le scheduler vers les intentions.

## Rollback

- Un rollback applicatif ne doit jamais supprimer les intentions RESTORE persistées.
- Le worker peut être mis en pause sans perdre la file.
- La désactivation de feature flag doit maintenir l'interlock en mode fail-open.
- Aucun rollback ne doit réactiver automatiquement les horaires.

## Décisions à valider avant codage

- Délai d'anticipation RESTORE par flotte.
- Preuve suffisante : `kt`, ignition, réponse SMS du boîtier ou terrain.
- Débit SMS autorisé par la SIM et l'opérateur.
- Fournisseur/passerelle secondaire.
- Durée maximale avant escalade humaine.
- Qui peut confirmer « vérifié sur place » et avec quelle trace.
- Politique des véhicules muets/dormants.
- Politique de rotation des mots de passe Coban.
