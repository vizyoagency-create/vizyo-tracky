# 28 — Correctif P2-5 · P2-6 (T51) : une RESTORE qui traîne se rappelle, un SMS bloqué est retenté, un clic répond en 20 s

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Production : **aucun changement** — code écrit, testé et committé, non déployé.

## Les défauts corrigés (document 19, P2-5 et P2-6)

**P2-5 — une alerte, puis le silence.** La sentinelle écrivait une ligne CRITICAL à 60 s
(`alertedAt` posé) et ne revenait plus jamais : un téléphone éteint pendant des heures produisait
une ligne, puis rien, pendant que la RESTORE tournait en `queued` — et que le SMS restait en file
sur le relais sans jamais partir.

**P2-6 — le clic manuel attendait la file SMS.** `requestCommand` attendait le départ effectif
du SMS derrière une file cadencée à 15 s : avec N messages devant, la réponse dépassait le délai
du proxy → toast « refusé » pour une intention pourtant persistée et suivie.

## Ce qui change

| Où | Quoi |
|---|---|
| `alertOverdueRestores` | Sélection : jamais alertée **ou** alertée il y a plus de `ENGINE_RESTORE_REALERT_MS` (15 min). Nouvelle ligne CRITICAL « RESTORE toujours non confirmée depuis N min (rappel toutes les 15 min tant qu'elle n'est pas prouvée) », contexte `reminder: true`. Le marquage est une **comparaison-et-échange** sur la valeur lue d'`alertedAt` : deux instances ne rappellent pas deux fois ; une ligne non persistée rend l'ancienne valeur. |
| Worker, branche « SMS toujours en file » | Un SMS en file depuis plus de `ENGINE_RESTORE_SMS_STUCK_MS` (60 min, depuis `lastAttemptAt`) est **annulé au relais** (best-effort, T41) puis **retenté** au tick suivant (`smsLogId` remis à zéro, `nextAttemptAt` = maintenant). Le budget SMS (3) le compte : pas un SMS de plus qu'avant. À 30 min, on repolle simplement. |
| `dispatchBounded` | Un clic **MANUEL** attend le dispatch au plus `ENGINE_MANUAL_RESPONSE_BUDGET_MS` (20 s, variable d'environnement, plancher 1 s). Au-delà, l'intention **persistée** est rendue (`PENDING`, suivie par le worker et le flux temps réel) et l'envoi finit en arrière-plan, journalisé, sans rejet orphelin. Le **planificateur attend toujours** : son état n'avance qu'une fois la commande réellement partie. |

## Ce que ce correctif garantit — et ne garantit pas

- Garanti : tant qu'une RESTORE n'est pas prouvée, le centre d'alerte en reparle tous les quarts
  d'heure — un téléphone éteint depuis trois heures produit douze lignes, pas une.
- Garanti : un SMS coincé une heure en file n'y reste pas : annulation demandée, nouvel essai.
- Garanti : l'écran reçoit une réponse en 20 s au plus ; l'état affiché est l'état en base.
- Non garanti : la reprise réelle du SMS retenté dépend du téléphone ; s'il est toujours éteint,
  les trois SMS s'épuisent puis le TCP seul est retenté (document 22) — et le rappel continue.

## Tests ajoutés (verts)

`engine-control.service.spec.ts` (+4) : rappel à 15 min avec comparaison-et-échange ; SMS bloqué
61 min annulé et retenté ; 30 min simplement repollé ; clic manuel rendu dans le budget puis
envoi terminé derrière.

Variable ajoutée : `ENGINE_MANUAL_RESPONSE_BUDGET_MS=20000` (`env.validation.ts`,
`.env.example`, `deploy/vps/.env.prod.example`, document 13).
