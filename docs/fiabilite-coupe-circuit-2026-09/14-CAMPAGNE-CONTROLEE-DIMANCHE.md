# Campagne contrôlée du dimanche 13 septembre 2026

## Verdict de départ à 06 h 30

- production actuelle : `main` / `e4749302` ;
- `tracky-api` sain depuis trois jours ; PostgreSQL et Redis sains ;
- relais `texto-relay` démarré, mais son état Android/SIM n'est pas prouvé par ce seul constat ;
- CDEF31 : 30 plannings présents, 0 actif ;
- MH Cars : 7 plannings présents, 0 actif ;
- sur sept jours : 23 RESTORE non confirmés, dont 19 via SMS ;
- SMS sortants sur sept jours : 25 `queued`, une seule preuve `delivered`.

Avec les plannings actuellement désactivés, aucune bascule automatique ne se produira à 20 h ou
22 h. Une campagne réelle exige donc une décision explicite et un véhicule canari identifié ; elle
ne doit jamais réactiver les 37 véhicules d'un coup.

## Règles non négociables

1. Aucun CUT sur un véhicule en circulation ou sans opérateur physiquement présent.
2. Le kill-switch global reste `false` pendant migration, déploiement et contrôles techniques.
3. Sauvegarde vérifiée avant migration ; image et commit précédents notés pour rollback.
4. Deux véhicules canaris maximum : un MH Cars, puis un CDEF31.
5. Un seul canari à la fois ; la restauration physique est vérifiée avant de passer au suivant.
6. Une réponse HTTP, `queued`, `sent` ou `delivered` ne vaut jamais preuve de redémarrage.
7. Au moindre doute : nouveaux CUT gelés, worker RESTORE conservé, planning canari désactivé.

## Préparation avant 12 h

- [ ] Désigner la plaque MH Cars, la plaque CDEF31 et l'opérateur terrain de chaque véhicule.
- [ ] Vérifier batterie, carburant, accès aux clés et possibilité de démarrage immédiat.
- [ ] Exporter les réglages actuels des 37 plannings avant toute modification.
- [ ] Sauvegarder PostgreSQL et vérifier que l'archive est lisible.
- [ ] Relever versions API, Web, relais, Android, SIM utilisée et opérateur.
- [ ] Vérifier l'heure UTC du VPS et l'heure Europe/Paris.
- [x] Confirmer que CDEF31 et MH Cars restent à 0 planning actif.

## Validation technique avant 18 h

- [ ] Déployer d'abord en démonstration/préproduction avec le kill-switch à `false`.
- [ ] Appliquer la migration additive et vérifier le démarrage API.
- [ ] Tester RESTORE TCP avec ACK.
- [ ] Tester socket absente, attente TCP, timeout, puis SMS prioritaire cadencé.
- [ ] Redémarrer l'API pendant une intention RESTORE et vérifier sa reprise.
- [ ] Provoquer un webhook dupliqué puis perdu ; vérifier absence de double alerte et reprise par polling.
- [ ] Lancer le heartbeat SMS, attendre, puis utiliser « Vérifier la remise ».
- [ ] Vérifier que l'écran ne prononce jamais « OK » sur un simple `queued`.
- [ ] Simuler 22 RESTORE sur l'environnement de test et mesurer la file à 15 s.
- [ ] Tester le rollback applicatif sans supprimer la migration ni les journaux.

## Gate de 18 h

Go canari uniquement si tous les tests précédents sont verts, le téléphone est stable écran éteint,
le centre d'alertes est visible et les deux opérateurs terrain confirment leur présence. Sinon :
No-Go, plannings désactivés et aucune CUT automatique.

## Fenêtre MH Cars — 19 h 45 à 20 h 30

1. Vérifier API, base, listener TCP, relais, allowlist et profondeur de file.
2. Vérifier qu'aucune intention RESTORE ancienne n'est active.
3. Si le Go a été donné, armer uniquement le canari MH Cars ; tous les autres restent désactivés.
4. À 20 h, suivre l'intention, chaque tentative, l'ACK et l'état ignition.
5. Restaurer le canari de façon contrôlée sans attendre le lendemain.
6. Vérifier physiquement le démarrage, puis désarmer ce planning canari.
7. Exporter les preuves et décider séparément si le canari CDEF31 peut être tenté.

## Fenêtre CDEF31 — 21 h 45 à 22 h 30

Même protocole, sur un seul véhicule CDEF31. CDEF31 n'est jamais le premier test. Si le canari MH
Cars a produit une erreur, aucun CUT CDEF31 n'est autorisé.

## Fenêtres critiques du lundi 14 septembre

L'historique réel montre les RESTORE MH Cars vers 05 h et CDEF31 vers 07 h. Si les horaires sont
réactivés après les canaris, la surveillance doit donc reprendre :

- MH Cars : 04 h 45–05 h 30 ;
- CDEF31 : 06 h 45–07 h 30.

À 05 h 10 puis 07 h 10, produire la liste nominative : confirmé TCP, SMS remis mais boîtier non
confirmé, échec terminal, aucune tentative. Toute ligne sans preuve déclenche un appel terrain ; elle
ne disparaît jamais de l'écran par simple succès HTTP.

## Preuves à archiver

- commit/image déployés et résultat de migration ;
- état des 37 plannings avant/après ;
- timeline des deux canaris ;
- tentatives TCP/SMS et statuts terminaux ;
- logs du centre d'alertes ;
- résultat du heartbeat différé ;
- confirmation physique signée par plaque et heure ;
- décision Go/No-Go et personne qui l'a prise.

## Condition pour réactiver l'ensemble

Les deux canaris et leurs restaurations doivent être physiquement confirmés, le crash/restart doit
avoir conservé l'intention, la vague simulée de 22 doit être cadencée, et aucune fausse réussite ne
doit apparaître. Sans cela, les 37 plannings restent désactivés pour lundi et la reprise se fait
manuellement avec présence terrain.
