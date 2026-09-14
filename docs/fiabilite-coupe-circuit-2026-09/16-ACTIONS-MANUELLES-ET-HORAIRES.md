# Actions manuelles, cartes et horaires — audit du 13 septembre 2026

## Invariant métier verrouillé

- Une coupe ou un rallumage manuel standard ne désactive jamais les horaires.
- La dérogation manuelle tient jusqu'à la prochaine bascule programmée.
- Une coupe manuelle en journée reste dans le cycle : reprise du planning le soir, puis RESTORE à la prochaine plage autorisée.
- Un RESTORE manuel après la coupe du soir ne sort pas le véhicule du cycle : le RESTORE du matin reste planifié.
- Seule l'option volontaire « Immobilisation durable » envoie `disableSchedule=true`.
- `disableSchedule` est refusé sur RESTORE et ignoré en défense interne hors CUT.
- Cette option exige `schedules_manage` pour ce véhicule, dans l'UI et dans l'API.

## Corrections UI

- La carte réutilise désormais `EngineControlButtonComponent`, composant de référence de la fiche véhicule.
- Il n'existe plus deux implémentations divergentes pour CUT/RESTORE.
- Une CUT en attente propose RESTORE et non une seconde CUT.
- Les textes distinguent la coupe standard, qui conserve les horaires, de l'immobilisation durable, qui en sort.
- La saisie de plaque est remplacée par un glissement complet pour CUT et RESTORE.
- La commande ne part qu'au relâchement à 98 % ou plus ; un relâchement incomplet revient à zéro.

## Tests de non-régression

- Payload web : CUT/RESTORE standard omettent `disableSchedule`; l'option durable seule l'envoie.
- API : `disableSchedule=true` est refusé sans `schedules_manage`.
- Évaluateur : CUT manuelle en journée → CUT du soir → RESTORE le lendemain matin.
- Évaluateur : RESTORE manuel le soir → RESTORE planifié le lendemain matin.
- UI : glissement incomplet sans effet, glissement complet déclenché une fois, autres modales inchangées.

## Périmètre

Ces changements sont uniquement dans le worktree `codex/tracky-cutoff-reliability-2026-09-12`.
Aucun déploiement et aucune modification de production ne font partie de ce lot.
