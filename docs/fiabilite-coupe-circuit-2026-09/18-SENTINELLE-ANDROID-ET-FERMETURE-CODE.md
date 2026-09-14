# Sentinelle Android et fermeture du périmètre logiciel

## Résultat

Le dernier angle mort logiciel identifié est fermé dans deux branches isolées :

- Tracky : `codex/tracky-cutoff-reliability-2026-09-12` ;
- relais vizyo-texto : `codex/gateway-health-reliability-2026-09-13`.

Aucun changement n'a été appliqué à la production.

## Ce qui change

Le contrôle public `/health` de vizyo-texto disait seulement que le processus Node
répondait. Il ne disait rien du téléphone, de l'application Android ou de la SIM.
Le relais expose maintenant `GET /v1/texto/health`, protégé par la clé du tenant. Il
interroge le serveur Android pour obtenir son état, sa version et les appareils vus,
puis calcule la fraîcheur du dernier ping. Il ajoute les messages en attente, l'âge
du plus ancien et les échecs des dernières 24 heures pour le tenant.

Tracky consomme ce verdict et :

1. affiche le dernier ping Android, son âge, la version, la SIM et les deux files ;
2. contrôle la chaîne chaque minute sans envoyer de SMS ;
3. déduplique les alertes de panne, rappelle l'incident toutes les 15 minutes et se réarme après retour ;
4. bloque toute CUT automatique si le téléphone n'est pas démontré frais ;
5. laisse les RESTORE prioritaires et rejouables, même quand cette santé est rouge.

La batterie et la charge ne sont pas exposées par l'API Android utilisée. L'écran le
dit explicitement au lieu d'afficher un état supposé. Elles restent à contrôler sur
le téléphone et pourront être intégrées quand le fournisseur les exposera.

## Ordre de déploiement préparé

1. sauvegarder les deux bases et conserver `ENGINE_AUTOMATIC_CUT_ENABLED=false` ;
2. déployer d'abord vizyo-texto ;
3. vérifier avec la clé Tracky que `/v1/texto/health` rend `operational=true` et un
   téléphone frais ;
4. déployer Tracky avec le kill-switch toujours à `false` ;
5. vérifier l'écran SMS admin, la sentinelle et un SMS neutre avec statut terminal ;
6. exécuter R6.2b, R7.2b et les canaris R7.4 avant toute réactivation progressive.

Déployer Tracky avant le nouveau relais échouerait fermé : aucune CUT automatique ne
partirait. L'ordre ci-dessus évite néanmoins une alerte inutile pendant la bascule.

## Rollback

- Tracky peut revenir au commit précédemment déployé sans migration supplémentaire
  liée à cette sentinelle ;
- vizyo-texto peut revenir à son commit précédent, l'endpoint ajouté étant purement
  additif et sans migration ;
- le kill-switch reste `false` pendant tout rollback ;
- aucun rollback ne doit supprimer les commandes RESTORE déjà persistées.

## Preuves automatiques

- verdict sain seulement avec serveur `pass` et téléphone frais ;
- échec fermé sur téléphone périmé, erreur fournisseur ou ancien relais sans endpoint ;
- authentification Bearer Tracky vers le relais et Basic du relais vers capcom6 ;
- alerte dédupliquée pendant la panne, réarmée après récupération ;
- interlock CUT rouge quand le téléphone ne ping plus ;
- 22 RESTORE absorbés dans l'ordre, sans perte ni doublon et avec cadence ;
- suite complète, typechecks et builds à reporter après la validation finale.

## Ce qui ne peut pas être coché localement

Les trois contrôles restants ne sont pas du code en suspens : test écran éteint et
reboot du vrai téléphone, crash sur copie PostgreSQL, puis canaris physiques. Les
inventer donnerait une confiance factice. Ils restent volontairement bloquants pour
la réactivation des CUT automatiques.
