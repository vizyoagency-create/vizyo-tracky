# File anti-rafale du bouton « toute la flotte »

## Décision

Le bouton de la page Horaires flotte reste utilisable pour régler toute une flotte, mais il ne
doit plus envoyer les coupures pendant la requête HTTP. Il enregistre les plannings, puis le
planificateur délivre au maximum un `CUT` automatique toutes les 10 secondes.

Pour 37 véhicules tous éligibles, la fenêtre minimale est de 6 minutes : premier départ immédiat,
dernier départ à `T+360 s`. Cette cadence est configurable avec
`SCHEDULE_CUT_QUEUE_INTERVAL_MS`, arrondie par créneaux de 10 secondes et bornée entre 10 et
60 secondes.

## Garanties

- Les `RESTORE` sont évaluées avant les `CUT` au tick principal.
- Le worker intermédiaire de 10 secondes ne traite que les `CUT` ; il ne multiplie donc pas les
  retries de redémarrage.
- Un seul `CUT` automatique obtient un créneau ; les autres restent en attente.
- La file est récupérable : tant que la transition n'aboutit pas, `lastEvaluatedState` n'avance
  pas en base. Après crash/redeploy, le véhicule réapparaît automatiquement au prochain tick.
- Il n'y a aucun long `sleep` dans une requête HTTP ou dans le cron.
- Une désactivation ou un override retire naturellement le véhicule avant son prochain tick.
- Les règles existantes restent applicables après sortie de file : jamais de coupe en mouvement,
  immobilité minimale, interlock de santé, kill-switch et backoff.

## Interface opérateur

L'aperçu ne dit plus « coupés maintenant ». Il annonce :

- le nombre mis en file ;
- l'intervalle minimal ;
- la durée minimale estimée ;
- la priorité des reprises moteur.

Après validation, le panneau suit les véhicules encore normaux jusqu'à leur coupure effective. Il
ne présente pas la simple mise en file comme une réussite physique.

## Tests exigés

- [x] 37 acquisitions simultanées : un seul départ autorisé.
- [x] 37 créneaux de 10 secondes : aucun doublon et dernier départ à six minutes.
- [x] Une reprise est ordonnée avant une coupure, indépendamment de l'ordre DB.
- [x] Une activation bulk hors plage n'appelle pas le moteur dans la requête HTTP.
- [x] Tests ciblés API verts.
- [ ] Test d'intégration avec horloge réelle, deux boîtiers canaris et observation TCP/SMS.
- [ ] Test crash/redeploy au milieu d'une file, sur environnement de validation.

## Rollback

Laisser `ENGINE_AUTOMATIC_CUT_ENABLED=false` bloque toute coupure automatique même si des
plannings sont présents. En cas d'anomalie, désactiver les horaires de la flotte : les entrées en
attente ne seront plus sélectionnées. Ne jamais supprimer les journaux de commandes pour vider la
file.

## Limite connue à surveiller

Le déploiement actuel comporte une seule instance API. Le cadenceur est local au processus, tandis
que la reprise après crash est portée par la DB. Avant un futur passage à plusieurs réplicas API,
ajouter un lease PostgreSQL distribué afin de conserver la garantie globale « une coupe par
créneau » entre instances.
