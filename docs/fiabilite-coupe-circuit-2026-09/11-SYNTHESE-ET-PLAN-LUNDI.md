# Synthèse finale et plan de sécurisation pour lundi

Date de synthèse : 12 septembre 2026

Échéance opérationnelle : lundi 14 septembre 2026
Statut : plan préparatoire — aucune modification de production décrite ici n'a encore été appliquée

## 1. Décision exécutive

Le meilleur plan n'est **ni de remplacer immédiatement le Galaxy S21**, ni de réactiver sans protection les horaires automatiques du CDEF et de MH Cars.

Pour lundi, l'objectif réaliste et sûr est :

1. garantir que tous les véhicules nécessaires sont démarrables et restent utilisables ;
2. conserver les arrêts automatiques désactivés tant que les nouvelles protections P0 ne sont pas validées ;
3. utiliser TCP en priorité, puis un SMS de secours temporisé, traçable et confirmé ;
4. exploiter le S21 actuel après réglage et tests, tout en préparant un deuxième téléphone et une deuxième SIM indépendants ;
5. ne réactiver progressivement l'automatisation complète qu'après une campagne de canari contrôlée.

Une reprise lundi ne doit donc pas être confondue avec une remise en marche immédiate de tous les arrêts automatiques. Le mode sûr pour lundi est un **mode supervisé, RESTORE prioritaire et fail-open** : en cas de doute, le système n'immobilise pas le véhicule.

## 2. Ce qui s'est réellement passé

### 2.1 Incident principal du 11 septembre à 07:00

- 22 ordres `RESTORE` étaient dus.
- 10 ont reçu un ACK TCP.
- 2 ont été écrits sur une socket TCP sans recevoir d'ACK ; aucun secours SMS n'a ensuite été déclenché.
- 10 véhicules sans socket TCP sont tombés en secours SMS presque simultanément, en environ 6 secondes.
- Sur ces 10 SMS, 5 ont été livrés et 5 ont échoué avec `RESULT_ERROR_GENERIC_FAILURE`.
- Tracky a néanmoins pu considérer des demandes seulement mises en file comme envoyées, avancer son état métier et ne pas déclencher d'alerte exploitable.

L'incident n'est donc pas « le TCP en panne » ou « la SIM morte ». Il s'agit d'une chaîne de défaillances : disponibilité TCP variable, absence de secours après timeout d'ACK, rafale SMS trop rapide, erreurs Android/opérateur, puis absence de réconciliation côté Tracky.

### 2.2 Le problème existait déjà avant vendredi

La vidéo du téléphone montre des SMS `Non envoyé` dès les 31 août, 1er et 2 septembre. Le tableau de l'application affichait 453 messages au total, dont 52 échoués, soit environ 11,5 % d'échecs bruts historiques.

Le défaut était donc déjà présent depuis environ une semaine et demie. Il a été masqué par :

- les succès TCP ;
- les succès SMS partiels ;
- le fait que Tracky confondait mise en file et réussite finale ;
- l'absence d'alerte immédiate sur un `RESTORE` non confirmé.

### 2.3 Incident de cycle de vie Android

Après le redémarrage du téléphone le 11 septembre vers 20:56, SMSGate a enregistré à 21:55 :

- `Can't start foreground services while the app is running in the background` ;
- `Can't register receiver` ;
- `Registration failed: Job was cancelled`.

Le worker a ensuite repris. Cela prouve un second défaut, distinct des erreurs SMS du matin : après un redémarrage ou une relance en arrière-plan, Android peut empêcher temporairement le service SMSGate d'être pleinement opérationnel.

## 3. Diagnostic consolidé

### Cause principale côté Tracky

Tracky ne suivait pas la vérité de livraison jusqu'au terminal : `queued` pouvait être assimilé à `SENT`, le cron pouvait changer l'état moteur trop tôt, et aucun moteur durable ne réessayait ou n'escaladait un `RESTORE` non confirmé.

### Causes contributives côté TCP

- Certaines balises n'avaient pas de socket active à l'heure critique.
- Un `write()` réussi ne prouve pas que la balise a exécuté l'ordre.
- Deux timeouts d'ACK n'ont pas déclenché de secours SMS.
- L'état de connexion et les ACK n'étaient pas assez visibles dans le centre d'alertes.

### Causes contributives côté SMS/Android

- Dix SMS de secours ont été injectés en rafale.
- SMSGate n'avait ni délai minimum/maximum configuré, ni limite de volume active.
- L'ordre de traitement était `LIFO`, donc les messages récents pouvaient passer devant les plus anciens.
- La SIM était laissée sur le choix par défaut du système.
- Android 15 a refusé le démarrage du service foreground lors d'une relance en arrière-plan.
- La version SMSGate observée est 1.65.0 ; des versions ultérieures annoncent des corrections sur les statuts et les workers. Une mise à jour directe du téléphone primaire reste néanmoins trop risquée sans appareil de secours et plan de retour arrière.

### Ce qui n'est pas la cause racine

- **Allowlist** : les webhooks atteignaient Tracky et aucune série de 403 n'a été observée.
- **SIM définitivement défaillante** : la SIM Free était enregistrée, IMS actif, signal correct et un SMS manuel isolé a réussi le 12 septembre à 08:47.
- **Panne TCP générale** : 10 ACK TCP ont été reçus pendant l'incident.
- **Bouton uniquement** : le bouton grisé est un symptôme d'un état optimiste et d'un verrouillage d'interface, pas l'origine matérielle de l'incident.

## 4. Faut-il changer de téléphone ?

### Réponse courte

**Non, pas comme correction d'urgence et pas en remplacement aveugle du S21.** Le S21 n'est pas prouvé défectueux et la SIM sait envoyer. Le remplacer seul ne corrigerait ni les erreurs Tracky, ni l'absence de fallback TCP, ni la rafale SMS, ni les faux statuts.

### Ce qu'il faut faire à la place

- Garder le S21 comme passerelle primaire provisoire après réglage et tests.
- Préparer dès ce week-end un **deuxième téléphone Android dédié**, avec une **deuxième SIM, idéalement d'un autre opérateur**.
- Installer et tester la version stable la plus récente de SMSGate sur ce deuxième téléphone avant de toucher à la version du téléphone primaire.
- Ne pas utiliser un téléphone personnel : appareil alimenté en permanence, emplacement fixe, réseau surveillé, batterie non optimisée, démarrage automatique et contrôle après chaque reboot.
- À moyen terme, ajouter une voie indépendante du même couple Android/SMSGate : modem GSM industriel ou fournisseur SMS, au minimum pour les `RESTORE` critiques.

Développer une nouvelle application Android d'ici lundi serait plus risqué : elle resterait soumise aux mêmes restrictions Android de services en arrière-plan et n'aurait pas encore l'historique de tests de SMSGate. Un fork ou une application dédiée ne doit être envisagé qu'après avoir stabilisé le serveur et identifié une limite reproductible de SMSGate.

## 5. Protections P0 à préparer avant toute réactivation

### P0-1 — Vérité de livraison

- `QUEUED` signifie « en attente », jamais « envoyé ».
- Seul un ACK TCP valide ou un statut SMS terminal positif autorise la confirmation métier.
- `FAILED`, timeout ou statut inconnu maintient l'ordre en échec/non confirmé et génère une alerte.
- Ajouter une réconciliation périodique des statuts SMS en complément du webhook.

### P0-2 — RESTORE durable et prioritaire

- Persister chaque intention avant le premier envoi.
- Réessayer un `RESTORE` jusqu'à confirmation ou escalade humaine.
- Après timeout d'ACK TCP, déclencher le secours SMS.
- Donner la priorité absolue aux `RESTORE` dans toutes les files.

### P0-3 — Protection fail-open

- Interdire un `CUT` automatique si la santé de la passerelle est inconnue ou trop ancienne.
- Interdire un `CUT` si un `RESTORE` précédent est en attente, en échec ou non confirmé.
- Donner une durée de vie courte aux ordres `CUT` afin qu'un ordre ancien ne puisse pas être exécuté tardivement.
- Conserver les horaires automatiques CDEF et MH Cars désactivés tant que ces garde-fous ne sont pas validés.

### P0-4 — Régulation SMS

- File FIFO persistante.
- Un SMS toutes les 15 secondes pour le premier réglage prudent, avec jitter possible jusqu'à 20 secondes.
- Limite de volume active et compteur visible.
- SIM explicitement sélectionnée — *au 14/09 : **non fait en production**, `CAPCOM6_SIM_NUMBER` est absent du `.env` du relais ; le code du relais sait la sélectionner (T44), la variable est un geste propriétaire (T43, doc 25 §2).*
- Aucun batch ne doit contourner cette file.

### P0-5 — Interface et centre d'alertes fiables

- Séparer clairement état planifié, état réel connu et commande en cours.
- Afficher la voie utilisée, les tentatives, le dernier ACK/statut et le motif d'échec.
- Ne retirer le chargement du bouton qu'à l'état terminal, avec expiration contrôlée et possibilité de reprise.
- Alerte critique en moins de 60 secondes pour tout `RESTORE` non confirmé.

### P0-6 — Santé de la passerelle

- Heartbeat au maximum toutes les 60 secondes.
- Statuts distincts : `ONLINE`, `DEGRADED`, `STALE`, `OFFLINE` — *tenu depuis T44 (doc 23) : `device.state`, seuils 120 s / 900 s.*
- Surveillance du dernier heartbeat, dernier SMS terminal, profondeur de file, taux d'échec et âge du plus vieux `RESTORE`.
- Alarme spécifique après reboot si le service foreground/receiver n'est pas opérationnel.

## 6. Plan du week-end

### Samedi — figer, sauvegarder et préparer le correctif

1. Laisser les horaires automatiques CDEF et MH Cars désactivés.
2. Sauvegarder la base, la configuration, les logs Tracky, les paramètres SMSGate et la version de l'application.
3. Ne pas mettre à jour le S21 primaire avant d'avoir un deuxième appareil prêt ou un retour arrière testé.
4. Implémenter les P0 derrière des feature flags : vérité de statut, fallback après timeout, file SMS régulée, alertes et blocage des `CUT` dangereux.
5. Préparer un tableau opérationnel donnant, par véhicule, l'état connu, la dernière connexion TCP, le dernier ACK et le dernier SMS terminal.

### Dimanche — tests sans risque terrain

1. Tests unitaires et d'intégration sur la machine de test.
2. Simuler les 22 `RESTORE` du 11 septembre : aucune rafale, aucune perte silencieuse, priorité RESTORE respectée.
3. Simuler socket absente, write sans ACK, webhook perdu, API redémarrée et téléphone `STALE`.
4. Tester les alertes : un opérateur doit savoir en moins de 60 secondes où et pourquoi l'ordre bloque.
5. Tester le téléphone sur un numéro neutre : premier SMS isolé, puis une série régulée de 10 SMS, écran allumé, écran éteint, arrière-plan et après redémarrage.
6. Si un deuxième téléphone est disponible, réaliser les mêmes tests avec sa SIM et comparer.
7. Faire un canari RESTORE uniquement sur un banc ou des véhicules non critiques, avec opérateur présent. Aucun CUT sur un véhicule exploité.

### Dimanche soir — préparer lundi

- Vérifier un par un les véhicules nécessaires lundi matin.
- Restaurer par anticipation les véhicules dont l'état réel n'est pas certain.
- Vider ou traiter toute file résiduelle.
- Placer un opérateur d'astreinte avec liste de contacts et procédure manuelle.
- Ne programmer aucun `CUT` automatique pour la nuit de dimanche à lundi.

## 7. Déroulé opérationnel de lundi

### Avant le début de service

1. Contrôle de l'API, base, worker, listener TCP et file SMS.
2. Heartbeat frais des passerelles et aucune erreur Android post-reboot.
3. Inventaire de tous les véhicules : aucune ambiguïté entre état Tracky et état terrain.
4. Lancer les `RESTORE` suffisamment tôt par TCP.
5. Après timeout d'ACK, utiliser le secours SMS régulé, jamais une rafale.
6. Quinze minutes avant prise de service, produire la liste des seuls véhicules encore non confirmés et les contrôler humainement.

### Pendant la journée

- Exploiter en mode supervisé.
- Conserver les `CUT` automatiques désactivés pour CDEF et MH Cars.
- Surveiller chaque tentative et traiter immédiatement toute commande non confirmée.
- Documenter les résultats pour décider du prochain canari.

## 8. Critères Go/No-Go

### Go pour une exploitation lundi en mode supervisé

- Tous les véhicules requis sont confirmés restaurés sur le terrain.
- API, base, listener et workers sont sains.
- Aucune file RESTORE ancienne ou invisible.
- Le fallback TCP vers SMS est testé.
- La régulation SMS est active et testée.
- Une panne terminale apparaît dans Tracky et déclenche l'alerte attendue.
- Le téléphone a passé le test après redémarrage et en arrière-plan.
- Un opérateur et une procédure manuelle sont disponibles.

### No-Go pour les CUT automatiques

Un seul des éléments suivants suffit à maintenir les horaires désactivés :

- statut SMS final non réconcilié ;
- `RESTORE` perdu après timeout TCP ;
- passerelle sans heartbeat ou erreur foreground/receiver ;
- alerte tardive ou ambiguë ;
- état UI différent de la vérité serveur/terrain ;
- absence de deuxième voie de secours pour le périmètre critique ;
- test canari non terminé ou non concluant.

La campagne complète de 100 cycles et 7 jours sans incident reste nécessaire avant de déclarer le système durablement fiable. Elle ne peut pas être honnêtement compressée en un week-end.

## 9. Ordre de correction après lundi

1. Modèle durable `EngineIntent` / `EngineDeliveryAttempt` et outbox transactionnelle.
2. Workers idempotents, verrouillés et reprenables après redémarrage.
3. Routage TCP/SMS avec ACK strict, TTL et priorités.
4. Réconciliation webhook + poller et signature des événements.
5. Centre d'alertes et interface fondés sur l'état réel.
6. Deuxième passerelle Android indépendante.
7. Voie GSM/SMS indépendante d'Android pour les restaurations critiques.
8. Campagne de tests canari, chaos, charge, reboot et terrain.
9. Réactivation progressive : banc, petit groupe non critique, puis CDEF/MH Cars.

## 10. Interdictions de sécurité

- Ne jamais considérer une réponse HTTP d'acceptation comme une livraison.
- Ne jamais lancer tous les SMS de secours en parallèle.
- Ne jamais exécuter tardivement un ancien `CUT`.
- Ne jamais masquer un échec par une simple fin de spinner.
- Ne jamais mettre à jour simultanément les deux passerelles.
- Ne jamais tester un `CUT` sur un véhicule opérationnel sans équipe terrain et procédure de récupération.
- Ne jamais réactiver les horaires CDEF/MH Cars uniquement parce qu'un test manuel isolé a réussi.

## 11. Conclusion

Le correctif le plus fiable combine trois couches : Tracky doit connaître la vérité de livraison, TCP doit basculer vers un SMS régulé après absence d'ACK, et la passerelle Android doit être surveillée et doublée. Le changement de téléphone seul ne résout rien. La priorité du week-end est de rendre les restaurations impossibles à perdre silencieusement et d'empêcher tout arrêt automatique lorsque la chaîne de secours n'est pas prouvée disponible.
