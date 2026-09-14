# Runbook et remise en service

## Pendant le gel actuel

- Garder les horaires CDEF et MH Cars désactivés.
- Ne pas tester CUT sur les véhicules d'exploitation.
- Utiliser uniquement un véhicule/banc explicitement réservé aux essais.
- Vérifier quotidiennement la santé TCP, le téléphone et la profondeur des files.
- Conserver toute erreur Android avec heure, SIM, destinataire et capture des logs SMSGate.

## Préflight quotidien cible

À exécuter avant toute période critique :

1. API, base, worker et listener TCP sains.
2. Aucun backlog RESTORE ancien.
3. Téléphone primaire vu depuis moins de deux minutes.
4. Téléphone secondaire sain.
5. Test SMS récent arrivé à un état terminal attendu.
6. Aucun taux d'échec anormal sur la dernière heure.
7. Allowlist synchronisée.
8. Crédit/forfait/SIM/opérateur valides.
9. Interlock de flotte `HEALTHY`.
10. Astreinte et moyen de contact disponibles.

Si un point critique échoue : ne pas autoriser les CUT automatiques.

## Procédure « véhicules ne redémarrent pas »

1. Ne pas lancer une rafale de commandes.
2. Ouvrir la timeline de la vague RESTORE.
3. Classer les véhicules : ACK TCP, TCP sans ACK, SMS queued, SMS failed, aucune tentative.
4. Prioriser les RESTORE sans preuve.
5. Envoyer/retenter via l'orchestrateur, jamais directement en boucle.
6. Pour un boîtier connecté, attendre et vérifier `kt`.
7. Pour un boîtier hors ligne, vérifier le statut SMS terminal et la passerelle secondaire.
8. Alerter le responsable terrain avant l'heure de départ.
9. Enregistrer toute vérification physique avec identité, heure et plaque.
10. Ne fermer l'incident qu'après résolution ou procédure terrain explicite pour chaque véhicule.

## Lecture des statuts

- `Créée` : aucune tentative encore faite.
- `En attente TCP` : intention durable, socket indisponible.
- `TCP envoyé` : écriture réalisée, aucune preuve boîtier.
- `TCP confirmé` : ACK compatible reçu.
- `SMS en file` : relais seulement saisi.
- `SMS envoyé` : téléphone/opérateur a accepté l'émission, boîtier non confirmé.
- `SMS délivré` : transport déclaré livré, exécution boîtier non prouvée.
- `Restauré confirmé` : preuve boîtier qualifiée ou terrain audité.
- `Non confirmé` : action humaine requise.
- `Échec` : tentative terminée en erreur ; l'intention RESTORE doit continuer ou escalader.

## Remise en service progressive

### Gate 1 — laboratoire

- Toutes les phases P0 implémentées.
- Tests unitaires, intégration et chaos verts.
- Timeline et alertes vérifiées.

### Gate 2 — canari interne

- Deux véhicules non critiques.
- Présence terrain aux heures CUT/RESTORE.
- Trois cycles quotidiens sans faux succès.

### Gate 3 — petit groupe

- Interlock actif.
- Passerelle secondaire opérationnelle.
- Sept jours de préflight enregistrés.
- Revue des coûts SMS et des délais.

### Gate 4 — CDEF/MH Cars

- Validation écrite du propriétaire.
- Fenêtre de déploiement avec astreinte.
- Première reprise surveillée véhicule par véhicule.
- Possibilité immédiate de désactiver les horaires sans perdre les RESTORE en cours.

## Rollback opérationnel

En cas de doute après réactivation :

1. geler la création de nouveaux CUT ;
2. conserver le worker RESTORE actif ;
3. désactiver les horaires concernés ;
4. suivre toutes les restaurations jusqu'à preuve ;
5. ne pas redéployer à l'aveugle si cela peut interrompre la file ;
6. produire une liste nominative des véhicules non confirmés ;
7. lancer la procédure terrain.

## Responsabilités à attribuer

- Responsable décision de réactivation.
- Responsable technique Tracky.
- Responsable téléphone/SIM/opérateur.
- Responsable terrain CDEF/MH Cars.
- Astreinte de la première semaine.

## Preuves à conserver après chaque vague

- verdict interlock ;
- liste des intentions et tentatives ;
- ACKs et latences TCP ;
- statuts et erreurs SMS ;
- alertes ouvertes/résolues ;
- confirmations terrain ;
- versions API, web, relais et application Android ;
- heure serveur et fuseau.

## Condition de clôture du chantier

Le chantier n'est pas clos parce qu'une matinée s'est bien passée. Il est clos lorsque les critères du plan de tests sont satisfaits, que la reprise progressive est terminée et qu'une panne volontaire de chaque composant est contenue sans véhicule silencieusement immobilisé.
