# Fiabilisation du coupe-circuit — chantier septembre 2026

## Statut

- Incident de référence : 11 septembre 2026, reprise matinale partiellement non exécutée.
- Mesure conservatoire : horaires automatiques désactivés sur CDEF 31 et MH Cars.
- État vérifié en production le 11 septembre : CDEF 30/30 désactivés, MH Cars 7/7 désactivés.
- FG-669-DQ : vérification terrain déclarée OK par le propriétaire le 12 septembre.
- Ce dossier prépare les corrections. Il n'autorise aucun changement de production.
- Les horaires ne doivent pas être réactivés avant satisfaction des critères de sortie de ce dossier.

## But

Le but n'est pas de promettre qu'un réseau mobile ne tombera jamais en panne. Le but est que Tracky :

1. ne présente jamais une soumission comme une exécution ;
2. connaisse et affiche précisément l'étape où une commande est bloquée ;
3. retente automatiquement une restauration par des chemins indépendants ;
4. refuse une coupure automatique si aucune voie de restauration fiable n'est disponible ;
5. permette à l'exploitant d'agir avant l'heure de départ des véhicules ;
6. conserve une preuve exploitable de chaque décision et de chaque tentative.

## Principe de sécurité directeur

> Une coupure peut être différée ou refusée. Une restauration ne doit jamais être abandonnée.

Les traitements CUT et RESTORE sont volontairement asymétriques :

- CUT : sécurité physique stricte, pas de tentative tardive aveugle, pas de coupure en mouvement.
- RESTORE : répétable et idempotent, priorité maximale, retries durables, plusieurs canaux, alerte humaine avant l'échéance.

## Documents

1. [Incident du 11 septembre](./01-INCIDENT-2026-09-11.md)
2. [Audit des défauts](./02-AUDIT-DES-DEFAUTS.md)
3. [Architecture cible](./03-ARCHITECTURE-CIBLE.md)
4. [Plan d'implémentation](./04-PLAN-D-IMPLEMENTATION.md)
5. [Plan de tests de fiabilité](./05-PLAN-DE-TESTS.md)
6. [Runbook et remise en service](./06-RUNBOOK-ET-REMISE-EN-SERVICE.md)
7. [Roadmap d'exécution bug par bug](./07-ROADMAP-EXECUTION.md)
8. [Décision sur la passerelle Android](./08-DECISION-PASSERELLE-ANDROID.md)
9. [Analyse de la vidéo SMSGate du 12 septembre](./09-ANALYSE-VIDEO-SMSGATE.md)
10. [Diagnostic en direct du téléphone](./10-DIAGNOSTIC-TELEPHONE.md)
11. [Synthèse finale et plan de sécurisation pour lundi](./11-SYNTHESE-ET-PLAN-LUNDI.md)
12. [Deuxième téléphone — mémoire de décision et procédure future](./12-SECOND-TELEPHONE-PASSERELLE.md)
13. [Implémentation isolée, déploiement, rollback et Go/No-Go](./13-IMPLEMENTATION-ET-GO-NO-GO.md)
14. [Campagne contrôlée du dimanche et surveillance lundi matin](./14-CAMPAGNE-CONTROLEE-DIMANCHE.md)
15. [File anti-rafale du bouton Horaires flotte](./15-FILE-ANTI-RAFALE-HORAIRES-FLOTTE.md)
16. [Actions manuelles, horaires et confirmation par glissement](./16-ACTIONS-MANUELLES-ET-HORAIRES.md)
17. [Revue finale du candidat et décision Go/No-Go](./17-REVUE-FINALE-GO-NO-GO.md)
18. [Sentinelle Android et fermeture du périmètre logiciel](./18-SENTINELLE-ANDROID-ET-FERMETURE-CODE.md)
19. [Contre-expertise indépendante du 13 septembre — verdict NO-GO, défauts P0/P1, plan d'action](./19-CONTRE-EXPERTISE-INDEPENDANTE-2026-09-13.md)
20. [Correctif P0-1 — la clé d'unicité RESTORE ne vit plus pour toujours](./20-CORRECTIF-P0-CLE-RESTORE-2026-09-13.md)
21. [Correctif P0-2 (T41) — une coupure par SMS a une date de péremption](./21-CORRECTIF-P0-VALIDITE-SMS-CUT-2026-09-14.md)
22. [Correctif P1-1 (T42) — une RESTORE repart à la reconnexion et n'est jamais terminale sans preuve](./22-CORRECTIF-P1-RELANCE-RESTORE-RECONNEXION-2026-09-14.md)

## Contre-expertise du 13 septembre

Le document 19 est une revue indépendante de tout le chantier : verdict **NO-GO** en l'état (un
défaut P0 introduit par la correction, démontré par test), notes, réponses aux vingt questions
posées, et plan d'action concret. Les documents 20, 21 et 22 décrivent les correctifs issus de cette revue (T40, T41, T42).
En cas d'écart entre les documents 13/17/18 et le document 19, **le document 19 fait foi** jusqu'à
ce que les tâches qu'il liste soient closes.

## Document directeur du week-end

Le document 11 consolide les constats des audits. Le document 13 décrit l'état réellement implémenté dans le worktree, le déploiement, le rollback et le Go/No-Go. En cas d'écart avec un ancien jalon, le document 13 fait foi pour la livraison ; l'architecture cible et la campagne complète restent décrites dans les documents 03 à 07.

## Critères non négociables avant réactivation

- Aucun statut `queued`, `SENT` ou écriture socket ne vaut « moteur restauré ».
- Une commande RESTORE non prouvée reste visible et retentée après redémarrage de l'API.
- Le centre d'alertes reçoit tout échec terminal SMS et toute restauration en retard.
- Le téléphone SMS ne reçoit jamais une rafale non régulée.
- Un RESTORE TCP sans ACK déclenche le chemin de secours.
- Une socket absente déclenche une file TCP durable, pas un abandon du TCP.
- L'interface sépare toujours « planning » et « état moteur ».
- Les boutons sont verrouillés pendant l'action dans toutes les vues et tous les onglets.
- Les requêtes sont idempotentes côté serveur.
- Un interlock empêche le CUT automatique quand la capacité de RESTORE est dégradée.
- Les tests unitaires, intégration, E2E, chaos et terrain définis ici passent.
- Une montée en charge progressive est réalisée avant toute remise à 100 % de la flotte.

## Hors périmètre immédiat

- Refonte générale de la télématique hors commandes moteur.
- Changement de modèle de boîtier.
- Optimisations UI sans rapport avec la sécurité des commandes.

Ces sujets peuvent être traités séparément, mais ne doivent pas retarder les protections P0.
