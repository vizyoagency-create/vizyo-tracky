# Analyse de la vidéo SMSGate du 12 septembre

## Périmètre

Vidéo examinée image par image : `WhatsApp Video 2026-09-12 at 08.49.11.mp4`, durée décodable d'environ 50 secondes. Elle montre successivement les journaux SMSGate, l'historique de la file, Google Messages et un SMS manuel de test.

## Faits directement visibles

### État global de la file

| État | Nombre |
|---|---:|
| Total | 453 |
| Delivered | 335 |
| Sent | 66 |
| Failed | 52 |
| Pending | 0 |

Le taux brut `Failed / Total` affiché est de 11,5 %. Ce chiffre n'est pas encore un taux propre aux coupe-circuits : la file peut contenir d'autres usages et sa date de début dépend de la rétention locale.

### Lot du 11 septembre à 07:00

La liste montre exactement le motif déjà reconstitué :

- cinq `Delivered` entre 07:00:04 et 07:01:00 ;
- cinq `Failed` entre 07:00:01 et 07:00:04.

La coexistence, dans la même seconde, de réussites et d'échecs montre que le téléphone n'était pas simplement hors ligne. Elle est compatible avec un modem/SIM/opérateur ou une politique Android qui refuse une partie d'un lot, mais ne permet pas encore de choisir entre ces couches.

### Autres échecs du 11 septembre

La vidéo montre au moins huit échecs supplémentaires à 07:40:46, 07:55:00, 08:41:33, 09:35:30, 10:33:33, 10:34:41, 17:59:02 et 18:00:35.

Cela explique l'écart avec le comptage initial fait depuis le relais : la base distante observée ne racontait pas toute l'activité locale du téléphone.

### Preuve dans Google Messages

Dans `TRACKER CDEF - 731`, quatre messages de 17:59 sont explicitement marqués `Non envoyé` :

- `stop123456` ;
- `stop123456` ;
- `776` ;
- `Check123456`.

Le worker SMSGate peut journaliser qu'il a « terminé avec succès » alors que le résultat du destinataire est `Failed` : la réussite du worker signifie que son travail informatique s'est terminé, pas que le SMS a quitté le téléphone. De même, `Webhook sent successfully` signifie que le statut a été transmis au serveur SMSGate, pas que le SMS a été envoyé.

### Test manuel de 08:47

Le nouveau `check123456`, saisi directement dans Google Messages, apparaît avec `08:47 SMS` et sans libellé rouge. Il s'agit d'une réussite apparente d'un SMS isolé.

Ce test valide à 08:47 :

- le téléphone sait demander un envoi ;
- la SIM n'est pas totalement bloquée ;
- le réseau/opérateur n'est pas en panne permanente.

Il ne valide pas :

- le réveil FCM de SMSGate ;
- le démarrage de son service en arrière-plan ;
- son worker ;
- sa file et sa régulation ;
- le webhook vers Tracky ;
- l'ACK du boîtier.

## Ancienneté du défaut

Des groupes d'échecs sont visibles les 31 août, 1er septembre et 2 septembre. Le système n'est donc pas devenu défaillant uniquement le matin du 11 septembre. Le défaut existait déjà, mais les réussites TCP et les SMS partiellement réussis en masquaient l'impact métier.

## Diagnostic actualisé

Trois problèmes indépendants sont désormais prouvés :

1. Android/SIM/opérateur retourne de vrais échecs sortants intermittents, visibles dans Google Messages ;
2. SMSGate rencontre aussi un défaut de réveil/registration en arrière-plan ;
3. Tracky ne transforme pas les statuts `Failed` pourtant disponibles en retry et alerte véhicule.

L'allowlist n'explique pas ces échecs : les webhooks sont mis en file puis envoyés avec succès. Le TCP n'explique pas non plus l'erreur SMS, mais son indisponibilité ponctuelle augmente fortement le nombre de SMS simultanés et révèle la faiblesse du secours.

## Hypothèses encore ouvertes

Par ordre de probabilité à tester, sans les déclarer prouvées :

1. envois groupés trop rapides pour le téléphone/SIM/opérateur ;
2. état radio ou réseau intermittent ;
3. rapports de livraison provoquant un comportement particulier ;
4. sélection/état de la SIM ou paramètre SMSC ;
5. restriction Android/Samsung en arrière-plan ;
6. défaut de SMSGate `1.65.0` corrigé dans une version plus récente.

Le code `RESULT_ERROR_GENERIC_FAILURE` est volontairement peu précis. La documentation officielle conseille notamment de contrôler crédit, réseau, SIM/opérateur et de tester sans rapport de livraison.

## Prochains tests sûrs

Avant tout test, préserver les données et ne pas réinstaller l'application.

1. ouvrir `Voir les options` sur un seul message échoué et photographier tout détail, sans appuyer sur renvoyer ;
2. produire le rapport de bug Android avant redémarrage ;
3. vérifier opérateur, slot SIM, solde/forfait et restrictions anti-spam ;
4. envoyer via SMSGate, vers un numéro de test sans véhicule, un message isolé puis une série régulée 1/10 s ;
5. répéter application au premier plan, en arrière-plan et écran éteint ;
6. tester avec `withDeliveryReport=false` sur le numéro de test ;
7. répéter sur un second téléphone et une autre SIM/opérateur ;
8. corréler chaque essai avec la ligne locale, le webhook et le statut Tracky.

Ne pas retester un `stop` ou `resume` sur un véhicule pour diagnostiquer la passerelle. Un numéro de test neutre suffit et évite toute action moteur involontaire.

## Conclusion provisoire

Changer uniquement de téléphone pourrait réduire le problème Android mais ne réparerait pas Tracky. Développer immédiatement une autre application serait prématuré. La priorité reste : pacing, vérité des statuts, alertes, retry durable, interlock CUT, puis banc comparatif de deux passerelles indépendantes.
