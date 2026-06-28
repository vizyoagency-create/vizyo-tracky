# Sprint 6 — Rétention & archivage — ANALYSE (Phase 1)

> Volumétrie réelle (lecture seule prod) + modèle de données + rétention existante.
> Branche `feat/sprint-6-retention-archivage`. **CRITIQUE : supprime de la donnée.**
> **STOP en fin de doc** : valider volumétrie + tables in/out + mécanique avant de coder.

---

## 0. Résumé exécutif — 2 surprises qui changent tout

1. **Risque actuel ≈ NUL.** La table `positions` : **628 k lignes / 148 Mo**, et **la plus vieille position date du 14/04/2026 = 74 jours**. → **AUCUNE donnée > 1 an** aujourd'hui → la rétention 1 an purgerait **0 ligne**. C'est **préventif** (éviter que ça grossisse sur des années), **pas** une urgence. ⇒ on peut livrer le pipeline et l'activer **sans rien supprimer aujourd'hui** (le dry-run montrera 0).
2. **Le pipeline de purge positions EXISTE DÉJÀ.** `DataRetentionService.purgePositions()` supprime déjà par **lots de 10 000** (non bloquant), borné, idempotent — mais **désactivé** (`POSITIONS_RETENTION_DAYS=0` = défaut). Sprint 6 = **l'étendre** (archive/préavis + dry-run + vues + configurable + sûreté du champ de date), pas réinventer.

→ Conséquence mécanique : **cron-delete par lots** (l'existant), **PAS de partitionnement** (overkill + migration risquée sur une table jeune de 148 Mo).

---

## 1. Volumétrie réelle (prod, lecture seule)

DB totale = **586 Mo**. Top tables :

| Table | Taille | Lignes | Rétention actuelle | Périmètre S6 |
|---|---|---|---|---|
| `wire_logs` | 198 Mo | 505 k | **7 j (ON)** | déjà géré |
| `position_sampling_decisions` | 174 Mo | 439 k | **7 j (ON)** | déjà géré |
| **`positions`** | **148 Mo** | **628 k** | **∞ (OFF, défaut)** | ⭐ **cible du nouveau pipeline** |
| `alerts` | 24 Mo | 35 k | aucune | hors scope (cf §4) |
| `trips` | 12 Mo | 6,7 k | **garder** (agrégats) | hors scope (on garde) |
| autres | < 4 Mo | — | — | hors scope |

- **Span positions** : 14/04/2026 → 28/06/2026 = **74 jours**. Croissance ≈ **8,5 k lignes/jour ≈ 2 Mo/jour** (39 trackers). → en 1 an ≈ 3 M lignes / ~700 Mo : gérable, mais c'est pourquoi la rétention est utile à terme.
- **wire_logs + sampling_decisions (372 Mo) > positions (148 Mo)** mais déjà bornés à 7 j. La saturation S0 venait probablement du **cumul** (ces 3 tables + le live sur 2 vCPU), pas des positions seules.

---

## 2. Champ de date d'ancrage — décision de sûreté

| Champ | Sens | Pour la rétention |
|---|---|---|
| `timestamp` | heure **device** (Coban) | utilisé par l'existant. ⚠️ **risque** : une horloge device réglée dans le passé ferait paraître des positions **récentes** comme vieilles → **purge anticipée = perte de données récentes** |
| `createdAt` | heure **serveur** (insert, `@default(now())`) | **monotone, fiable, immune aux horloges device**. = la « date d'ajout » du brief |

**Recommandation : ancrer la rétention sur `createdAt`** (sûreté avant tout sur une opération destructive). L'existant utilise `timestamp` → à changer. **Coût** : ajouter un index `positions(createdAt)` (via `CREATE INDEX CONCURRENTLY`, non bloquant, ~secondes sur 148 Mo) pour une purge par lots efficace (l'index actuel `(trackerId, timestamp)` ne sert pas une purge globale par date).
*(Alternative défensive sans changer l'ancre : purger `WHERE timestamp < t AND createdAt < t` — supprime seulement si les DEUX sont vieilles. Mais `createdAt` seul est plus simple + plus sûr.)*

---

## 3. Tables IN scope

- **`positions`** = LA cible du nouveau pipeline (1 an → archive 1 mois → suppression). Aujourd'hui ∞.
- Déjà retenues (à documenter, pas à refaire) : `position_sampling_decisions` (7 j), `wire_logs` (7 j), `error_logs` (30 j).
- **`trips` = GARDÉS pour toujours** : agrégats légers (polyline, distance, durée, vitesses), **aucune FK vers positions**, jamais recalculés une fois fermés. Les rapports S5 reposent dessus → ne pas toucher.

## 4. Tables OUT scope — **JAMAIS touchées** (vérifié par test)
`users`, `vehicles`, `fleets`, `trackers`, `drivers`, `vehicle_groups`, `user_vehicle_access`, `geofences`, `engine_control_commands`, `audio_monitoring_commands` (audit immuable), `tracker_commands`, fleet configs, `user_sessions` / `user_activities` (analytics, 90 j séparé), `alerts`, `surveillance_events`. → la rétention ne touche QUE `positions`.

## 5. Dépendances — suppression sûre
- **Aucune FK vers `positions.id`** : rien ne référence une position. Supprimer des positions ne casse aucune cascade.
- `trips` stocke des polylines **dénormalisées** : indépendant des positions brutes.

---

## 6. Mécanique Postgres — cron-delete par lots (PAS partition)

| Option | Verdict |
|---|---|
| **Partitionnement** (par mois) | ❌ **overkill** : table jeune de 148 Mo ; migrer une table existante en partitionnée = opération lourde/risquée pour un gain nul à cette taille. À reconsidérer si > plusieurs Go un jour. |
| **Cron-delete par lots** | ✅ **retenu** : **existe déjà** (`purgePositions`, lots de 10 k, non bloquant), simple, idempotent, OK sur 2 vCPU. On l'étend. |

Pattern cron réutilisé (verrou anti-chevauchement + try/catch + borné) : comme `AudioAutoDisarmService` / `SurveillanceScheduler` / `DataRetentionService` existants.

## 7. Archive — fenêtre logique de préavis (pas de mouvement de données)

**Recommandé (le plus sûr)** : pas de table d'archive physique, pas de déplacement. La rétention = 2 durées configurables :
- `POSITIONS_RETENTION_DAYS` (actif, défaut **365**) ;
- `POSITIONS_ARCHIVE_DAYS` (préavis, défaut **30**).

Une position d'âge (sur `createdAt`) :
- `< 365 j` → **active** ;
- `[365, 395]` → **archive / préavis** : encore en table donc **récupérable**, marquée « suppression le {date} » dans les vues ;
- `≥ 395 j` → **supprimée** par le cron (par lots).

→ « archive récupérable » = simplement **pas encore supprimée** pendant le mois de préavis. **Zéro déplacement de données = zéro risque de migration**. La seule étape irréversible (la suppression) est la dernière, et seulement au-delà de 365+30 j.
*(Alternative : table froide `positions_archive` — plus « vraie archive » mais déplacement = risque ; écartée vu la criticité.)*

## 8. Cohérence S5 (rapports) si positions purgées
- ✅ **Rapports / KPIs / Excel** : reposent sur `trips` (agrégats) → **inchangés**.
- ⚠️ **Replay d'un vieux trajet** : `position-history` a déjà un **fallback compact** (polyline du Trip) pour les longues plages → dégrade proprement.
- ⚠️ **Export CSV positions** sur période purgée → partiel (à documenter : « positions conservées seulement sur la fenêtre de rétention »).
- ⚠️ **Recompute trajets** sur période purgée → impossible (message clair à afficher).

## 9. Risques
1. **Irréversibilité** de la suppression finale → mitigé par : dry-run obligatoire, flag OFF par défaut, mois de préavis récupérable, **0 ligne concernée aujourd'hui**.
2. **Horloge device** → ancrer sur `createdAt` (§2).
3. **Charge / lock** → lots de 10 k, cron de nuit, 2 vCPU OK (le volume actuel est petit).
4. **Périmètre** → tests qui prouvent qu'on ne touche QUE `positions`.

---

## 🛑 STOP — à valider avant Phase 2
1. **Volumétrie + le fait que c'est préventif** (positions = 74 j d'ancienneté → **0 à supprimer aujourd'hui**, on peut activer sans rien effacer).
2. **Périmètre exact** : IN = `positions` (le reste déjà retenu) ; OUT = tout le reste (§4). On ne touche QUE `positions`.
3. **Mécanique** : **cron-delete par lots** (étend l'existant, pas de partitionnement) + ancrage **`createdAt`** + index dédié + **archive = fenêtre logique de préavis** (pas de déplacement).

Dès ton OK sur ces 3 points → `PLAN.md` (durées configurables, dry-run + flag, vues super-admin/fleet/prochaines-suppressions, migration de l'index, fichiers, tests, rollback).
