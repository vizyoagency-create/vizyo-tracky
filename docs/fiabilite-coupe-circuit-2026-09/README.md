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

*État au 14/09 (T56, document 32) — ce que « jamais abandonnée » veut dire dans le code :* trois
SMS au plus, puis TCP seul retenté pendant 24 h à chaque reconnexion du boîtier et toutes les
30 min (T42, document 22) ; jamais `FAILED` sans preuve ; rappel au centre d'alerte toutes les
15 min tant qu'elle n'est pas prouvée (T51, document 28).

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
23. [Correctif P1-2 (T44) — la sentinelle Android ne bat plus, verdict par appareil](./23-CORRECTIF-P1-SENTINELLE-ANDROID-2026-09-14.md)
24. [Correctif P1-3 (T45) — une preuve SMS chaque matin, et le relais dit ce qu'il sait](./24-CORRECTIF-P1-PREUVE-SMS-QUOTIDIENNE-2026-09-14.md)
25. [Procédure de déploiement du chantier (T47) — téléphone → relais → Tracky, kill-switch false](./25-PROCEDURE-DE-DEPLOIEMENT-DU-CHANTIER-2026-09-14.md)
26. [Correctif P2-2 (T49) — une coupe retenue n'est pas une panne par véhicule](./26-CORRECTIF-P2-KILL-SWITCH-SANS-RAFALE-2026-09-14.md)
27. [Correctif P2-1 · P2-4 (T48) — une preuve ne se rétrograde jamais, une CUT orpheline est dispatchée](./27-CORRECTIF-P2-PREUVE-JAMAIS-RETROGRADEE-2026-09-14.md)
28. [Correctif P2-5 · P2-6 (T51) — une RESTORE qui traîne se rappelle, un SMS bloqué est retenté, un clic répond en 20 s](./28-CORRECTIF-P2-RESTORE-QUI-TRAINE-SE-RAPPELLE-2026-09-14.md)
29. [Correctif P2-9 (T52) — l'allowlist du relais ne bloque plus une remise en route](./29-CORRECTIF-P2-ALLOWLIST-NE-BLOQUE-PAS-RESTORE-2026-09-14.md)
30. [Correctif P2-3 (T50) — la confirmation par glissement est un geste, pas un clic](./30-CORRECTIF-P2-GLISSEMENT-VOLONTAIRE-2026-09-14.md)
31. [Correctif P2-10 (T53) — le journal des tentatives est exercé, le changement d'heure couvert](./31-CORRECTIF-P2-JOURNAL-DES-TENTATIVES-EXERCE-2026-09-14.md)
32. [Relecture des promesses documentaires (T56) — ce que les documents disent, ce que le code tient](./32-RELECTURE-DES-PROMESSES-DOCUMENTAIRES-2026-09-14.md)
33. [Journée S21 du 14/09 — diagnostic, configuration du téléphone, tests SMS (T43, T61)](./33-JOURNEE-S21-DIAGNOSTIC-ET-CONFIGURATION-2026-09-14.md)

## État du chantier au 14 septembre 2026 (07 h)

- `main` **a bougé** pendant le chantier (27 commits, 3 migrations, production redéployée le 13/09
  à 22:25) ; la branche est rebasée dessus (T46) et sa migration, antérieure aux leurs, s'applique
  « en retard » — vérifié localement, document 25 §6.
- Correctifs committés sur la branche, **non déployés** : P0-1, P0-2, P1-1, P1-2, P1-3, P2-1 à
  P2-6, P2-9, P2-10 (documents 20 à 31) ; relais Texto : santé par appareil, statuts sortants
  poussés, image capcom6 épinglée (documents 23, 24, 25).
- Téléphone S21 **configuré le 14/09 à 09:20** (document 33) : ping 60 s prouvé, FIFO, délais 10/15 s,
  limite 60/h, Local server OFF, veille des applis OFF. Tests SMS : 8 SIM sur 10 réputées injoignables
  répondent ; 2 restent en échec au départ (HD-584-BF, BP-434-RD) → TCP seul pour elles.
- Restent au propriétaire : revue et fusion, déploiement selon le document 25 (dont les variables du
  relais et `CAPCOM6_DEVICE_ID`), T54 (recette), T38 ; hors chantier : T57 (dépendances), T58/T59/T60
  (sur `main`).
- Suites au 14/09 (07 h) : typecheck vert, smoke DI 5/5, API 260 suites / 4 081 tests (une suite de
  `main`, `trip-analysis/fenetre-utile`, tient à la milliseconde et a dû être relancée seule),
  web 732 tests, relais 7 suites / 55 tests.

## Contre-expertise du 13 septembre

Le document 19 est une revue indépendante de tout le chantier : verdict **NO-GO** en l'état (un
défaut P0 introduit par la correction, démontré par test), notes, réponses aux vingt questions
posées, et plan d'action concret. Les documents 20 à 24 et 26 décrivent les correctifs issus de cette revue (T40, T41, T42, T44, T45, T49) ; le document 25 est la procédure de déploiement (T47), à jouer avec le propriétaire.
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
- Une socket absente laisse l'intention **en base** (pas de file dédiée : `activeKey`,
  `nextAttemptAt`), attachée à la prochaine connexion du boîtier et retentée par le worker ; le
  secours SMS ne part qu'après l'attente TCP de 15 s et un second essai TCP (T42, document 22).
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
