# Décision sur la passerelle Android

## Réponse courte

Ne pas changer immédiatement le téléphone et ne pas développer immédiatement une application neuve.

La séquence recommandée est : préserver les logs, durcir Tracky, préparer un second téléphone dédié, y tester une version SMSGate récente et une seconde SIM/opérateur, puis décider avec des mesures. Pour le long terme, un fork maîtrisé de SMSGate ou un modem GSM industriel est moins risqué qu'une application Android entièrement réécrite.

## Ce que prouvent les captures

### Fonctionnement présent

Les journaux de 17:59 et 18:00 montrent que le worker envoie, reçoit `ACTION_SENT`, persiste le webhook et l'expédie. L'accès Internet est aussi journalisé comme actif. L'allowlist et le chemin serveur ne sont donc pas globalement cassés.

### Défaut de cycle de vie Android

Le 11 septembre à 21:55:14, l'application journalise :

- `Can't start foreground services while the app is running in the background` ;
- `Can't register receiver` ;
- puis `Registration failed: Job was cancelled`.

Quelques secondes après, le worker et les webhooks repartent. Cette séquence est cohérente avec une application incapable de se réveiller correctement en arrière-plan, puis active de nouveau lorsqu'elle est relancée/réveillée. Elle correspond temporellement au SMS de FG-669-DQ resté environ 1 h 06 avant prise en charge.

### Limite de la preuve

Ces captures n'affichent pas les cinq erreurs génériques du 11 septembre au matin. Elles prouvent un problème de réveil/registration, pas la cause radio exacte des `RESULT_ERROR_GENERIC_FAILURE`. Pour cette seconde cause, il faut l'export complet.

## Pourquoi cela pouvait fonctionner dix jours plus tôt

La panne est la composition de quatre conditions intermittentes :

1. davantage de boîtiers sans socket descendante au tick de 07:00 ;
2. une rafale de dix replis SMS ;
3. un téléphone/application parfois mal réveillé en arrière-plan et des échecs modem génériques ;
4. Tracky qui ne retente pas et n'alerte pas après une simple acceptation `queued`.

Auparavant, le TCP ou le téléphone réussissait assez souvent pour masquer les défauts d'architecture. Le fait qu'une chaîne ait fonctionné plusieurs jours ne prouve pas qu'elle était tolérante aux pannes. Les erreurs génériques visibles dès les 1er et 2 septembre montrent que le signal faible existait déjà.

Les changements à rechercher dans l'export et le téléphone sont : mise à jour SMSGate/Android/One UI/Google Play, redémarrage, changement de réglage batterie, retrait d'une permission, bascule de SIM, variation réseau/opérateur, changement de volume SMS et évolution du nombre de sockets TCP disponibles.

## Version SMSGate

La version observée côté téléphone est `1.65.0`, publiée le 29 mai 2026. Le journal officiel indique ensuite :

- `1.65.2` : utilisation systématique du contexte application pour le receiver ;
- `1.65.3` : démarrage du thread de travail à la création ;
- `1.66.0` : événement webhook `app:started` ;
- `1.67.0` : annulation des messages en attente et limite d'envoi par 30 minutes ;
- `1.70.1` et `1.70.3` : corrections de statuts envoyés/délivrés qui pouvaient être perdus.

Ces changements touchent directement des zones impliquées dans l'incident. Ils justifient un test de mise à jour. Ils ne prouvent pas que la dernière version corrigera l'erreur générique de la SIM et ne justifient pas une mise à jour en place sans secours.

## Options

| Option | Délai | Maîtrise | Risque | Décision |
|---|---:|---:|---:|---|
| Régler seulement le téléphone actuel | court | faible | reste un point unique | mesure provisoire seulement |
| Second téléphone + version récente qualifiée | court/moyen | moyenne | raisonnable et réversible | recommandé maintenant |
| Fork de SMSGate | moyen | forte | maintenance Android à assumer | à étudier après mesures |
| Nouvelle application Android | long | forte en théorie | reproduit toutes les contraintes Android et téléphonie | non recommandé en première réponse |
| Modem GSM industriel ou fournisseur SMS | moyen | forte côté serveur | coût/intégration | recommandé comme voie indépendante |

## Pourquoi une application neuve ne suffit pas

Android limite le démarrage des services de premier plan depuis l'arrière-plan. Une nouvelle application ne contournera pas cette politique : elle devra gérer FCM, WorkManager, permissions, SIM, receivers, redémarrages, variantes constructeurs, statuts sent/delivered et mises à jour Android. SMSGate possède déjà cette complexité et continue de recevoir des correctifs.

Si des fonctions manquent après qualification, forker le projet existant permet d'ajouter un heartbeat signé, un export de logs, un statut de file et une stratégie de réveil tout en conservant les années de travail existantes.

## Configuration cible du téléphone de banc

- appareil dédié, sans usage personnel ;
- alimentation permanente et température surveillée ;
- SMSGate autorisé sans restriction batterie ;
- permissions SMS, téléphone et notifications vérifiées ;
- notification persistante visible ;
- SIM et slot explicitement choisis ;
- ping `system:ping` régulier ;
- journal conservé assez longtemps et export automatique ;
- version figée après qualification, mise à jour seulement par canari ;
- redémarrage contrôlé périodique uniquement si les tests prouvent son utilité ;
- seconde passerelle sur une autre SIM et si possible un autre opérateur.

## Protocole de décision

1. tester l'actuel et le second téléphone avec exactement la même série de scénarios ;
2. mesurer prise en charge écran allumé/éteint, après balayage, après reboot, sans FCM, en Wi-Fi et en 4G ;
3. envoyer 1, 5, 10 puis 22 messages avec pacing contrôlé ;
4. comparer erreurs, latence, batterie, réveils, webhooks et pertes de statuts ;
5. laisser tourner au moins sept jours incluant un week-end ;
6. choisir sur les SLO mesurés, pas sur une impression.

## Informations encore nécessaires

- export complet du journal SMSGate du 1er au 12 septembre ;
- modèle exact, Android/One UI, version SMSGate et dates de mise à jour ;
- captures des réglages batterie et permissions ;
- opérateur, SIM/slot, solde/forfait et éventuelle limitation anti-spam ;
- historique de redémarrage du téléphone ;
- copie de l'historique SMS envoyé aux heures d'incident ;
- si reproductible sur banc : `adb logcat` ou bugreport couvrant l'appel `SmsManager` et le code radio retourné.

## Décision provisoire

Le téléphone actuel n'est pas condamné. Il est non qualifié comme composant unique de sécurité. On le conserve pour extraire les preuves, on prépare un second appareil, et Tracky doit rester capable de détecter puis contourner sa panne. La décision finale « garder, remplacer, forker ou passer à un modem » sera prise après l'export des logs et le banc comparatif.
