# Diagnostic en direct du téléphone

## Méthode et sécurité

Inspection effectuée le 12 septembre 2026 via l'écran du téléphone dans Microsoft Mobile connecté. Navigation en lecture uniquement : aucun SMS envoyé, aucun message relancé, aucun réglage modifié et aucune donnée effacée. Les identifiants sensibles du téléphone et de la SIM ne sont volontairement pas reproduits dans ce document.

## Identité technique

| Élément | Valeur observée |
|---|---|
| Téléphone | Samsung Galaxy S21 5G, modèle européen double SIM |
| Système | Android 15 |
| Interface constructeur | One UI 7.0 |
| Mise à jour système Google Play | 1er juillet 2026 |
| Application | SMSGate 1.65.0, build affiché 1444 |
| SIM active | SIM 1 uniquement |
| Opérateur | Free |

## État courant de la SIM et du réseau

- service : en service ;
- inscription IMS : enregistrée ;
- réseau voix/données : 5G `NR SA` affiché ;
- itinérance : absente ;
- signal lors du contrôle : environ -94 dBm / 46 ASU ;
- SMS manuel isolé à 08:47 : parti sans erreur visible.

Conclusion : aucune preuve d'une SIM morte, désactivée ou durablement désenregistrée. La SIM, le modem ou Free peuvent néanmoins refuser temporairement des rafales ; le code Android générique ne permet pas de les départager sans test croisé.

## Permissions et énergie

- notifications : autorisées ;
- SMS et téléphone : autorisés ;
- suppression des permissions si application inutilisée : désactivée ;
- batterie Android : `Non restreinte` ;
- optimisation batterie dans SMSGate : `Disabled` ;
- données en arrière-plan : autorisées ;
- démarrage au boot SMSGate : activé.

Conclusion : l'incident n'est pas expliqué par une permission SMS absente ou le réglage batterie standard. Malgré ces bons réglages, Android 15 a bien refusé le démarrage d'un service de premier plan en arrière-plan. L'exemption batterie ne supprime donc pas tous les défauts de cycle de vie de cette version de SMSGate.

## Configuration SMSGate à risque

| Réglage | Valeur observée | Risque |
|---|---|---|
| Ping interval | Non défini | Tracky ne peut pas détecter rapidement une application endormie |
| Délai minimum | Non défini | Rafale immédiate |
| Délai maximum | Non défini | Aucun jitter/régulation |
| Limite de messages | Désactivée | Aucun frein Android/opérateur |
| Ordre | LIFO, plus récents d'abord | Une ancienne restauration peut être retardée par de nouvelles commandes |
| Choix SIM | Défaut OS | Ambigu si une seconde SIM est ajoutée ultérieurement |
| Rétention logs | 30 jours | Correct pour l'enquête actuelle |

L'absence simultanée de délai et de limite correspond exactement au lot du 11 septembre : dix SMS créés en six secondes, cinq délivrés et cinq échoués presque immédiatement. Elle ne prouve pas à elle seule qui, d'Android ou de Free, a refusé les messages, mais elle fournit un déclencheur reproductible et corrigible.

## Redémarrage du 11 septembre

À 14:24 le 12 septembre, la durée de disponibilité Android était d'environ 17 h 28. Le téléphone a donc redémarré vers 20:56 le 11 septembre, à quelques minutes près.

Chronologie rapprochée :

- 20:49 : création du SMS RESTORE de FG-669-DQ ;
- vers 20:56 : redémarrage estimé du téléphone ;
- 21:55:14 : FCM tente de se réinscrire ;
- 21:55:14 : Android refuse le démarrage du foreground service et le receiver ;
- 21:55:15 : `Registration failed: Job was cancelled` ;
- 21:55:15–21:55:27 : le worker traite enfin la file et envoie le webhook.

Conclusion : le défaut de reprise après boot est fortement établi pour la commande tardive du soir. Il est distinct de la rafale échouée du matin, arrivée avant ce redémarrage.

## Répartition des responsabilités

### Certain

1. Tracky accepte `queued` comme succès trop tôt et ne réagit pas aux `Failed` terminaux.
2. SMSGate n'a ni pacing, ni limite, ni ping configuré.
3. SMSGate/Android 15 ne reprend pas toujours proprement après boot/arrière-plan.
4. Les SMS échoués sont de vrais échecs sortants visibles dans Google Messages.

### Très probable

La rafale sans régulation déclenche un refus dans la chaîne Android modem/SIM/Free. Le mélange cinq succès/cinq échecs dans la même seconde est compatible avec une limite ou un état radio transitoire.

### Non prouvé

- défaut matériel du téléphone ;
- SIM défectueuse ;
- limitation précise de Free ;
- mauvais SMSC ;
- rapport de livraison comme cause.

## Comment départager Android, la SIM et Free

Les tests doivent être effectués sur un numéro neutre, jamais avec `stop`/`resume` vers un véhicule.

| Test | Téléphone | SIM | Chemin | Interprétation |
|---|---|---|---|---|
| A | S21 actuel | Free actuelle | SMSGate, 1 SMS isolé | Vérifie le worker nominal |
| B | S21 actuel | Free actuelle | SMSGate, 10 SMS espacés de 15 s | Si succès : la rafale était le déclencheur |
| C | S21 actuel | autre opérateur | même scénario | Si C réussit et B échoue : SIM/Free suspect |
| D | autre Android | Free actuelle | même scénario | Si D réussit et B échoue : S21/Android/SMSGate suspect |
| E | autre Android | autre opérateur | secours complet | Valide l'indépendance de la deuxième voie |

Un `adb bugreport` ou `logcat -b radio` capturé pendant une reproduction est nécessaire pour attribuer l'échec générique à la couche radio exacte.

## Verdict provisoire

Ne pas remplacer immédiatement le téléphone ni la SIM. Les deux fonctionnent actuellement. Les premiers correctifs doivent être l'observabilité Tracky, le pacing, un ping, le retry et l'interlock CUT. La version SMSGate récente doit être qualifiée sur un second téléphone. Une autre SIM/opérateur est nécessaire comme test et comme vraie redondance, pas comme remplacement aveugle.
