# Deuxième téléphone — mémoire de décision et procédure future

Date : 12 septembre 2026
Décision propriétaire : achat prévu ultérieurement, pas pour la reprise de cette semaine.

## Pourquoi ce téléphone est nécessaire

Le deuxième téléphone ne remplace pas le correctif logiciel. Il supprime un point unique de défaillance : aujourd'hui une seule application, un seul Android, une seule SIM et un seul opérateur portent tout le secours SMS.

Le Galaxy S21 actuel reste la passerelle primaire provisoire. Rien dans l'audit ne prouve une panne matérielle permanente du S21 ou de sa SIM.

## Caractéristiques recherchées

- Android encore supporté et recevant les correctifs de sécurité ;
- appareil dédié à Tracky, sans usage personnel ;
- alimentation permanente et connexion réseau stable ;
- batterie SMSGate en mode non restreint ;
- démarrage automatique et notification foreground vérifiables ;
- SIM dédiée, idéalement d'un opérateur différent de la passerelle primaire ;
- possibilité de fixer explicitement le slot SIM ;
- emplacement physique et réseau différents si possible.

La puissance du téléphone est secondaire. La stabilité du cycle de vie Android, le suivi logiciel, l'alimentation et l'indépendance opérateur comptent davantage.

## Procédure quand le propriétaire revient avec l'appareil

1. Ne modifier ni désinstaller la passerelle primaire.
2. Inventorier modèle, version Android, correctif de sécurité, IMEI/slot et opérateur du nouvel appareil.
3. Installer la version SMSGate qualifiée sur le téléphone secondaire.
4. Appliquer les réglages documentés : permissions, batterie non restreinte, données en arrière-plan, autostart, SIM fixe, FIFO, cadence et ping.
5. Enregistrer la nouvelle passerelle dans le relais sous une identité distincte.
6. Tester d'abord vers un numéro neutre : isolé, série régulée, écran éteint, application balayée, perte Wi-Fi, redémarrage.
7. Réaliser au moins trois cycles RESTORE sur banc ou véhicule non critique, avec preuve terrain.
8. Simuler l'indisponibilité du S21 et vérifier que le routage bascule explicitement vers le secondaire.
9. Vérifier que Tracky affiche le téléphone choisi, son dernier heartbeat, sa version, la SIM, la tentative et son statut terminal.
10. Ne déclarer la redondance opérationnelle qu'après test de bascule et rollback signé.

## Politique d'exploitation future

- pas de sélection aléatoire entre téléphones ;
- le primaire reçoit normalement les messages ;
- le secondaire n'est utilisé qu'après verdict de santé ou politique explicite ;
- jamais de mise à jour simultanée des deux appareils ;
- test synthétique régulier sur chaque SIM ;
- alerte si un appareil est `STALE` depuis plus de 90 secondes ;
- historique distinct des taux d'échec par appareil, version, SIM et opérateur.

## Alternative à moyen terme

Pour les RESTORE les plus critiques, une deuxième application Android reste corrélée au même système d'exploitation. Une voie réellement indépendante — modem GSM industriel ou fournisseur SMS professionnel — devra être évaluée après la stabilisation de Tracky.
