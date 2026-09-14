# 31 — Correctif P2-10 (T53) : le journal des tentatives est exercé, le changement d'heure couvert

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## Les défauts corrigés (document 19, P2-10)

- Le service lisait le délégué `engineDeliveryAttempt` en **duck-typing** : absent de tous les
  harnais, `beginAttempt`/`finishAttempt` étaient **inertes en test**. La suite était verte sans
  jamais écrire une tentative ; le `CHECK` des statuts et l'unicité `(commandId, attemptNumber)`
  posés par la migration `20260912110000` n'avaient jamais tourné.
- L'index `engine_control_commands_restore_worker_idx` était dans la migration mais pas dans
  `schema.prisma` → **fait dans T47** (`@@index(..., map:)`, document 25).
- Aucun test ne couvrait le changement d'heure Europe/Paris (prochain : **25/10/2026, 03:00**).

## Ce qui change

| Où | Quoi |
|---|---|
| Harnais `engine-control.service.spec.ts` | Un **faux délégué** `engineDeliveryAttempt` présent dans **tous** les tests. Il lit les deux listes `CHECK` (canal, statut) **dans le SQL de la migration lui-même** et refuse un canal ou un statut hors liste (`23514`) et un doublon `(commandId, attemptNumber)` (`P2002`). Filtre par `id` (fin de tentative) et par `(commandId, smsLogId)` (réconciliation du worker). Les 132 tests existants passent avec les contraintes actives. |
| Garde anti-dérive statique | Un test lit `engine-control.service.ts` et vérifie que **chaque littéral** passé à `beginAttempt`/`finishAttempt` figure dans le `CHECK` — un statut inventé dans le code fait échouer la suite avant d'échouer en production. |
| Chemins fixés | TCP acquitté → tentative n°1 `WRITTEN` puis `ACKNOWLEDGED` avec l'écho brut ; socket absente sur RESTORE → `UNAVAILABLE` ; CUT sans socket → SMS `QUEUED` puis `ACCEPTED`, corrélée au `smsLogId` et au `providerId` ; clic (n°1) puis worker (n°2) sans collision. |
| `schedule-evaluator.spec.ts` | 5 tests Europe/Paris : heure murale autour de 01:00Z le 25/10 (02:59:59 → 02:00:00 → 03:00:00) ; fenêtre 06:00 ouverte à 04:00Z le samedi (CEST) mais à **05:00Z** le dimanche (CET) ; `computeNextTransition` à travers la bascule (RESTORE à 05:00Z, CUT à 17:00Z) ; **heure répétée** ; heure sautée du 28/03/2027. |

### L'heure répétée : un comportement connu, documenté, non corrigé

Une plage de nuit qui se termine entre 02:00 et 03:00 le dernier dimanche d'octobre se referme
**deux fois** (02:45 CEST → CUT ; 02:00 CET → RESTORE ; 02:45 CET → CUT). C'est la sémantique
« horloge murale » de l'évaluateur, et le cron n'agit que sur les transitions : un véhicule
concerné reçoit trois ordres en une heure et quart, tous cohérents avec l'heure affichée. Aucune
flotte n'a aujourd'hui de plage se terminant dans cet intervalle ; le test le fixe pour que ce ne
soit pas une découverte. Le corriger demanderait de mémoriser « déjà refermée à cette heure
murale aujourd'hui » — à décider si une plage de nuit de ce type apparaît.

### Note sur `computeState` (`schedule-cron.service.ts`)

Le cron n'utilise plus `computeState` (il appelle `evaluateSchedule`) ; la méthode subsiste avec
son propre `getNowInTimezone` et un algorithme sans créneaux ni fériés, seulement pour son
ancien test. Dette mineure, hors périmètre de ce correctif.

## Ce qui reste — non vérifié ici

- **Rejeu des migrations sur PostgreSQL/PostGIS 16 réel** (Docker non démarré sur ce poste ;
  T47 l'a fait sur un PostgreSQL 18 sans PostGIS, tables du chantier seulement — document 25 §6).
- `prisma migrate diff` (exige une base fantôme) — l'index et la `map` sont vérifiés à la lecture.
- **Rétention** de `engine_delivery_attempts` : aucun plan de purge ; décision propriétaire
  (180 jours ?). Volume attendu : quelques lignes par commande moteur.
- Crash entre `create` et dispatch **sur base réelle** : couvert en unitaire (document 27,
  orpheline dispatchée), pas rejoué avec un vrai arrêt de processus.
