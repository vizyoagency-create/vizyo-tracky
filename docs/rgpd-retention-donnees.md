# RGPD — Politique de rétention des données Tracky (lot 1, 21/07/2026)

État **réel et vérifiable** des purges. Toute suppression est **irréversible** : il n'existe
aucune corbeille ni restauration applicative.

## Tableau de rétention

| Donnée | Fenêtre | Job | Suppression réelle |
|---|---|---|---|
| **Positions GPS** (`positions`) | **60 jours** (`POSITIONS_RETENTION_DAYS=60` + `POSITIONS_ARCHIVE_DAYS=0`) | `DataRetentionService`, cron **03h30** | **OUI** — par lots de 10 000, max 50 lots/nuit |
| **Trajets** (`trips`, + `trip_analyses`, `trip_fuel_stops`) | **12 mois** (`TRIPS_RETENTION_MONTHS=12`) | `TripsRetentionService`, cron **03h45** | **OUI** — par lots de 5 000, max 20 lots/nuit |
| **Journaux SMS** (`sms_logs` : numéros + contenu) | **90 jours** (`SMS_LOGS_RETENTION_DAYS=90`) | `LogCleanupService`, cron **03h00** | **OUI** |
| Journaux techniques (`wire_logs`) | 7 jours | `LogCleanupService`, 03h00 | OUI |
| Journaux d'erreurs + activité système | 30 jours | `LogCleanupService`, 03h00 | OUI |
| Audit des mutations (`category=MUTATION`) | 365 jours | `LogCleanupService`, 03h00 | OUI |
| Décisions d'échantillonnage | 7 jours | `DataRetentionService`, 03h30 | OUI |
| **Registre du temps de travail** (`work_time_entries`) | **5 ans** (obligation employeur) | `WorkTimeService`, cron 04h00 | OUI |

## Garde-fous

1. **Fenêtre minimale 30 jours** — `assertRetentionWindow` (`apps/api/src/common/retention-guard.ts`)
   refuse toute purge configurée sous 30 jours : le job **échoue** (erreur → centre d'alerte)
   au lieu de supprimer massivement à cause d'une variable mal saisie.
2. **Purge non désactivable en production** — `resolvePurgeArmed` : `POSITIONS_PURGE_ENABLED=false`
   et `TRIPS_PURGE_ENABLED=false` sont **ignorés** quand `NODE_ENV=production` (une prod ne doit
   pas dériver silencieusement vers « on ne purge plus »). Désactivation possible en développement
   et en test uniquement.
3. **Arrêt d'urgence en production** — poser la **fenêtre à 0** :
   `POSITIONS_RETENTION_DAYS=0` (positions), `TRIPS_RETENTION_MONTHS=0` (trajets),
   `SMS_LOGS_RETENTION_DAYS=0` (SMS). C'est le seul levier d'arrêt en prod, et il est explicite.
4. **Traçabilité** — chaque purge réelle écrit une entrée `RETENTION` dans le journal système
   (visible dans `/admin/activity`), avec le volume supprimé.

## Écoute audio : aucune donnée conservée (et ce n'est pas un oubli)

**Le serveur ne reçoit ni ne stocke aucun enregistrement audio.** Le boîtier Coban, une fois armé
par SMS (`monitor<password>`), **ouvre un canal d'appel téléphonique vers un numéro autorisé** :
le son ne transite jamais par Tracky. Il n'y a donc **aucun clip, aucun fichier, aucune rétention
audio à implémenter** — cf. `apps/api/src/audio-monitoring/audio-monitoring.service.ts` (« AUCUN
clip n'est uploadé au serveur, AUCUN stockage, AUCUNE rétention de clip »).

La variable d'environnement `AUDIO_RETENTION_DAYS`, qui n'était lue par aucun job, a été
**retirée le 21/07/2026** pour ne pas laisser croire à une purge inexistante.

**Ce qui est conservé** : la table `audio_monitoring_commands` — journal légal d'armement
(qui a déclenché, quand, **motif obligatoire**, rôle, environnement, statut, désarmement). Ce
n'est pas un contenu personnel mais une **preuve d'usage**, nécessaire en cas de contestation.
Elle n'est pas purgée aujourd'hui ; le volume est négligeable (3 lignes en production).

**État de l'écoute en production au 21/07/2026** : `AUDIO_MONITORING_ENABLED=false` et
`AUDIO_SUPERADMIN_ENABLED=false` — l'écoute est **techniquement impossible** tant que le cadre
juridique (information des conducteurs, consentement) n'est pas en place.

## Comment vérifier

```bash
# Ce qui reste au-delà de la fenêtre (doit tendre vers 0 après le passage nocturne)
select count(*) from positions where "createdAt" < now() - interval '60 days';
select count(*) from trips     where "startedAt" < now() - interval '12 months';
select count(*) from sms_logs  where "createdAt" < now() - interval '90 days';

# Trace des purges dans le journal système
select "createdAt", action, target, detail from system_activity_logs
where category = 'RETENTION' order by "createdAt" desc limit 20;
```
