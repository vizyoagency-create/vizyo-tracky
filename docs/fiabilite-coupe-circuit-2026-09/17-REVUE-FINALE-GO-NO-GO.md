# Revue finale du candidat et décision Go/No-Go

## Verdict au 13 septembre 2026

Le lot est un **candidat de validation**, pas encore une autorisation de remettre les horaires
automatiques en production. La production n'a pas été modifiée pendant cette revue.

Deux décisions doivent rester séparées :

1. déployer techniquement avec `ENGINE_AUTOMATIC_CUT_ENABLED=false` peut être envisagé après
   sauvegarde et répétition de la migration sur une base de test ;
2. réactiver les CUT automatiques reste **No-Go** tant que R6.2b, R7.2b et R7.4 ne sont pas validés.

## Revue du code

- restauration durable, reprises bornées, fallback TCP vers SMS et alertes conservés ;
- aucun statut de soumission ou de transport ne vaut preuve de rallumage ;
- garde-fou des CUT automatiques fail-closed et désactivé par défaut ;
- santé authentifiée du serveur SMS et fraîcheur du dernier ping Android ; une sentinelle ouvre une alerte critique par épisode et interdit les CUT si le téléphone est périmé ;
- file anti-rafale des CUT compatible avec l'unique instance API déclarée par le déploiement ;
- actions manuelles sans désactivation explicite : horaires conservés et prochaine transition
  suspendue jusqu'à la bascule suivante ;
- carte et fiche véhicule utilisent le même contrôle et la même confirmation par glissement ;
- relecture idempotente limitée au même boîtier ; une collision inter-véhicule est refusée ;
- réutilisation d'une clé idempotente pour l'action opposée refusée.

## Revue de la documentation et du déploiement

- suppression des compteurs de tests et du hash de production qui vieillissaient ;
- terminologie `fail-closed` corrigée ;
- document 16 ajouté à l'index ; liens relatifs contrôlés ;
- version Prisma du README alignée sur les dépendances réelles ;
- exemples `.env` production et démonstration alignés sur les noms Vizyo Auth actuels ;
- variables du coupe-circuit et de la file CUT ajoutées aux exemples et à la validation d'env.

## Validations locales obtenues

- typecheck des trois paquets : succès ;
- smoke de démarrage API : 5 tests réussis ;
- suite API finale exécutée en série : 255 suites et 3 920 tests réussis (*chiffres du 13/09 ; au 14/09, après les correctifs 20 à 31 : 260 suites, 4 081 tests — voir README « État du chantier »*) ;
- suite Web : 727 tests réussis (*732 au 14/09, T50*) ;
- suite partagée : 416 tests réussis ;
- tests moteur ciblés après les derniers durcissements : 95 réussis ;
- builds de production API, Web et partagé : succès ;
- schéma Prisma valide ; confirmations destructives explicites ; `git diff --check` propre.

Le build Web conserve des avertissements de budget de taille et deux avertissements CommonJS déjà
présents. Ils ne bloquent pas le coupe-circuit, mais constituent une dette technique distincte.
La commande de lint du dépôt n'est pas exécutable dans l'installation actuelle car ESLint n'est
pas installé alors que le script existe ; typecheck, tests et builds restent les contrôles effectifs.

## Validations encore obligatoires

- appliquer puis rejouer la migration sur une copie de PostgreSQL ; Docker local n'était pas
  disponible pendant la revue, donc aucun test de migration réelle n'est revendiqué ;
- crash/reprise sur une copie PostgreSQL avec RESTORE en attente et perte réseau réelle ;
- ACK et webhook perdus sont couverts automatiquement ; il reste à reproduire le scénario contre le relais et le téléphone réels ;
- la vague de 22 RESTORE est validée en simulation automatisée sans perte ni doublon ; il reste à mesurer délai, file et coût sur le téléphone/SIM réels ;
- preuve réelle du téléphone : premier SMS, écran éteint, application en arrière-plan et reboot ;
- deux canaris maximum avec contrôle physique et rollback prêt ;
- réactivation progressive, jamais les 37 véhicules ensemble.

Si un de ces contrôles échoue, le kill-switch reste `false` et les horaires CDEF/MH Cars restent
désactivés.
