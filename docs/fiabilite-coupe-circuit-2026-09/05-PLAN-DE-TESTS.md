# Plan de tests de fiabilité

## Philosophie

Les tests ne doivent pas seulement vérifier le chemin heureux. Ils doivent provoquer les pannes observées : socket absente, ACK perdu, téléphone endormi, SMS en rafale, statut tardif, crash du serveur et concurrence utilisateur.

## Tests unitaires API

### Machine d'état

- Chaque transition autorisée et interdite.
- `queued` ne produit jamais `RESTORED_CONFIRMED`.
- `SMS_SENT` et `SMS_DELIVERED` restent non confirmés sans preuve boîtier.
- `kt` confirme uniquement l'intention RESTORE compatible.
- ACK ancien, dupliqué ou hors ordre ignoré/audité.
- RESTORE annule un CUT pending.
- CUT expiré n'est jamais envoyé.
- RESTORE dépasse l'échéance vers `ESCALATION_REQUIRED`, sans être abandonné.

### TCP

- socket présente et ACK rapide ;
- socket absente puis reconnexion ;
- socket marquée présente mais détruite ;
- écriture réussie sans ACK ;
- fermeture entre write et ACK ;
- ACK après timeout ;
- deux connexions simultanées pour le même IMEI ;
- redémarrage API avec intention en attente ;
- reconnexion après expiration CUT ;
- reconnexion après échéance RESTORE.

### SMS

- `queued -> sent -> delivered` ;
- `queued -> failed` avec code Android ;
- webhook dupliqué ;
- webhook hors ordre ;
- webhook perdu puis rattrapé par poller ;
- relais 200 avec JSON invalide ;
- relais timeout mais création réellement acceptée ;
- push mobile timeout ;
- téléphone silencieux ;
- double-SIM sans slot ;
- débit dépassé et circuit breaker ;
- bascule secondaire ;
- validité expirée.

### Planning

- `lastEvaluatedState` n'avance pas sur simple soumission ;
- restauration due conservée après échec de tous les canaux ;
- désactivation d'un planning coupé crée une intention RESTORE suivie ;
- désactivation répétée rejoint la même intention ;
- réactivation ne duplique pas un RESTORE déjà confirmé ;
- interlock dégradé bloque CUT ;
- interlock inconnu bloque CUT ;
- RESTORE n'est jamais bloqué par l'interlock ;
- changements d'heure été/hiver et fuseaux.

## Tests composants Angular

### Bouton moteur

- double-clic ;
- clic pendant `loading` ;
- deux instances pour le même tracker ;
- statut `SENT_UNCONFIRMED` ;
- échec API et rollback visuel ;
- refresh pendant la commande ;
- RESTORE soumis mais non confirmé conserve l'état prudent ;
- accessibilité du bouton grisé et motif lisible.

### Horaires individuels

- confirmation de désactivation ;
- switch, champs, annulation et fermeture bloqués pendant la sauvegarde ;
- timeout API ;
- réponse serveur discordante ;
- planning désactivé + moteur encore coupé affichés simultanément ;
- résultat RESTORE suivi après sauvegarde.

### Horaires de flotte

- bouton bulk grisé et libellé de progression ;
- backdrop et Escape inactifs pendant soumission ;
- résultats véhicule par véhicule ;
- restauration TCP confirmée ;
- restauration SMS pending/failed ;
- reprise du panneau après navigation/rechargement.

## Tests d'intégration

- PostgreSQL + Redis/file + API + faux serveur TCP + faux relais SMS.
- Transaction intention/outbox atomique.
- Worker concurrent avec lease : une seule tentative effective.
- Crash juste après commit et avant dispatch.
- Crash juste après dispatch et avant persistance de l'ACK.
- Redémarrage du worker avec messages non terminaux.
- Perte temporaire de base pendant un ACK.
- Contrat webhook signé relais↔Tracky.
- Projection WS et snapshot cohérents après chaque état.

## Tests E2E navigateur

- Deux onglets envoient RESTORE au même véhicule : un seul `intentId`.
- Deux rôles différents agissent simultanément.
- Réseau navigateur coupé après clic : le suivi revient au reload.
- Désactivation bulk de 30 véhicules avec progression persistante.
- Le toast ne dit jamais « restauré » sans preuve.
- Le centre d'alertes ouvre directement la timeline concernée.
- Mobile tactile : bouton grisé visible, taille correcte, aucune action cachée dans un hover.

## Tests de charge

- 22 transitions RESTORE à la même seconde.
- 200 véhicules en snapshot sans N+1.
- 22 sockets présentes : ACKs concurrents correctement corrélés.
- 22 sockets absentes : aucune rafale SMS.
- Débit FIFO respecté à 1/15 s puis aux valeurs validées.
- Priorité RESTORE devant les SMS non critiques.
- Mémoire stable après 24 h de retries et reconnexions.

## Tests chaos

- Arrêt brutal de `tracky-api`.
- Arrêt du worker.
- Arrêt Redis/file.
- indisponibilité PostgreSQL ;
- coupure réseau vers le relais ;
- arrêt du téléphone ;
- SIM retirée ou sans réseau ;
- réponse opérateur lente ;
- perte de notification push ;
- horloge téléphone décalée ;
- webhooks retardés de 30 minutes ;
- doublons massifs de webhooks.

Résultat attendu commun : aucune fausse confirmation, aucune intention RESTORE perdue, CUT automatique refusé lorsque nécessaire, alerte actionnable.

## Tests terrain

- Au moins deux boîtiers et deux firmwares si présents dans le parc.
- Téléphone primaire et téléphone secondaire.
- Deux opérateurs distincts si possible.
- Véhicule connecté, véhicule sans socket, véhicule hors ligne.
- 100 cycles contrôlés CUT/RESTORE sur banc ou véhicule dédié.
- Vérification physique du relais et du démarrage, pas uniquement des statuts logiciels.
- Mesure ACK TCP, délai SMS et effet réel.
- Aucun essai CUT sur véhicule en circulation.

## Campagne de non-régression

- 7 jours consécutifs de préflight sans échec caché.
- 3 jours de canari terrain avec présence d'un opérateur.
- Aucun `RESULT_ERROR_GENERIC_FAILURE` non alerté.
- Aucun RESTORE dépassant son échéance sans escalade.
- Aucun doublon de commande physique malgré doubles clics simulés.
- Aucun CUT automatique avec interlock dégradé.

## Critères de passage

### Qualité logicielle

- `pnpm verify` vert.
- Tests nouveaux déterministes et relancés seuls en cas d'instabilité.
- Migrations testées montée et rollback applicatif.
- Revue sécurité et revue métier séparées.

### Objectifs opérationnels

- 100 % des intentions disposent d'une timeline complète.
- 100 % des échecs terminaux produisent une alerte.
- 0 fausse confirmation dans la campagne.
- 0 intention RESTORE perdue lors des tests crash/restart.
- 0 CUT automatique lorsque l'interlock n'est pas sain.
- Alerte RESTORE en retard émise avant l'heure de départ.

Ces objectifs portent sur le comportement de Tracky. Ils ne prétendent pas rendre les réseaux mobiles infaillibles ; ils garantissent que leur panne est contenue, visible et récupérable.
