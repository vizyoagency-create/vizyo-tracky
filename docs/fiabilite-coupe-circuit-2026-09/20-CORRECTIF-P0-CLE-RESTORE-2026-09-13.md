# 20 — Correctif P0-1 : la clé d'unicité RESTORE ne vit plus pour toujours

Date : 13 septembre 2026, soir (après la contre-expertise du document 19)
Branche : `codex/tracky-cutoff-reliability-2026-09-12`, worktree `vizyo-tracky-reliability-sep2026`
Production : **aucun changement** — code écrit, testé et **committé** (`d5c19a17`, décision D10 du 14/09), non déployé.
Historique : la branche a été nettoyée du reformatage prettier du commit `b5ec9d19` et **rebasée sur `main`**
(`049d1d11`) sans conflit le 14/09 (tâche T46) ; suites après rebase : API 259 suites / 4 002 tests, Web 727, partagé 423.

## Le défaut corrigé (document 19, P0-1)

`activeKey` garantit une seule intention RESTORE active par boîtier. Elle n'était libérée que par
une preuve — ACK TCP dans les 15 s, accusé SMS du boîtier (deux en cinq semaines), ou remontée
d'ignition dans les 30 minutes. Une RESTORE partie par SMS, remise (`delivered`) et jamais
acquittée gardait donc sa clé indéfiniment ; toute RESTORE suivante du même boîtier — planning du
lendemain, clic manuel — était dédupliquée vers elle : rien n'était envoyé, rien réarmé, aucune
alerte neuve, et le cron avançait `lastEvaluatedState`. Sur trente jours de production, au moins
une RESTORE par SMS sans accusé presque chaque jour.

## Ce qui change

| Où | Quoi |
|---|---|
| `engine-control.service.ts` — `rearmStaleRestore()` | À la collision `P2002`, une RESTORE active n'est rendue telle quelle **que** si elle est en cours de traitement (prochain essai dans la fenêtre d'ACK **et** activité récente : double clic, planning qui repasse). Parquée (`nextAttemptAt` nul), lointaine (essai au-delà de 15 s, backoff) ou muette depuis 10 min, elle est **réarmée** : retour en `PENDING`, canal effacé, `smsLogId` effacé, budget SMS remis à zéro, `sentAt` remis à null, lease posé, puis dispatch immédiat par `requestCommand` — TCP d'abord, secours SMS ensuite. `updateMany` conditionnel (`status: SENT, ackedAt: null`) : jamais sous un ACK arrivé entre-temps. |
| `engine-control.service.ts` — `cloturerCommandesPerimees()` | Second balayage : une RESTORE `SENT` sans accusé depuis plus de `ENGINE_RESTORE_EXPIRY_MIN` (défaut 240 min) passe `SENT_UNCONFIRMED`, `expiredAt` posé, **`activeKey` libérée** ; les lignes sous lease sont laissées au passage suivant. Jamais `FAILED`, jamais `ackedAt`. |
| `positions.service.ts` — `handleIgnitionTransition()` | Fenêtre de confirmation RESTORE par remontée d'ignition : 30 min → **24 h**, avec une garde : aucune CUT (hors `REJECTED_SPEED`) demandée après la RESTORE, sinon l'ignition raconte un autre épisode. |
| `env.validation.ts`, `.env.example`, `deploy/vps/.env.*.example` | `ENGINE_RESTORE_EXPIRY_MIN=240`. |
| `background-tasks.service.ts` | Le catalogue dit que le balayage solde aussi les rétablissements sans preuve (4 h). |
| `engine-control-button.component.ts` | Si le serveur rend une commande antérieure de plus de 60 s au clic : « Rallumage déjà en cours — commande créée à HH:MM, réarmée à l'instant » (ou « Coupure déjà en cours »), jamais « enregistrée » avec l'identifiant d'hier. |

Ce que ce correctif **ne fait pas** (volontairement, documents 19 §3 et tâches T41 à T47) : aucune
relance TCP à la reconnexion du boîtier (P1-1), aucune validité sur les SMS CUT (P0-2), pas de
garde sur la course ACK/SMS (P2-1), pas de dispatch d'une CUT `PENDING` orpheline (P2-4).

## Tests ajoutés (verts)

`apps/api/src/engine-control/engine-control.service.spec.ts` :

- « la RESTORE du lendemain RÉARME une RESTORE d'hier parquée et repart TCP d'abord » ;
- « un clic manuel réarme aussi une RESTORE dont le prochain essai est lointain (backoff) » —
  socket absente : attente de reconnexion, le worker paiera le SMS ;
- « un double clic ne réarme RIEN — une RESTORE en cours de traitement est rendue telle quelle » ;
- « si l'ACK arrive entre la relecture et le réarmement, rien n'est réécrit » ;
- « une CUT active n'est jamais réarmée par ce chemin » ;
- « ferme aussi les RESTORE envoyées sans preuve après 4 h en libérant leur clé — jamais sous
  lease » ; le test « ferme en SENT_UNCONFIRMED, jamais en FAILED » couvre désormais les deux
  balayages.

`apps/api/src/positions/positions.service.spec.ts` :

- « confirme un RESTORE app SENT vieux de trois heures quand le contact remonte » (fenêtre 24 h,
  garde « aucune CUT depuis » interrogée) ;
- « ne confirme PAS un RESTORE si une CUT a été demandée depuis ».

Le scénario de preuve de la contre-expertise (RESTORE d'hier parquée → RESTORE du lendemain →
rien n'est envoyé) est désormais **inversé** : un envoi part.

## Validation locale

- `tsc --noEmit` API et Web : 0 erreur ;
- suites `engine-control.service` + `positions.service` : 141 tests verts ;
- suite API complète : 255 suites, **3 928 / 3 928** tests (3 920 + 8 nouveaux) ;
- suite Web : 727 / 727 ;
- `git diff --check` : propre.

## Ce qu'il reste à faire avant tout déploiement

Voir le document 19 §3 et le poste de commande (T40 à T57) : P0-2 (validité des SMS CUT côté
relais), P1-1 (reconnexion TCP), P1-2 (fraîcheur du téléphone et hystérésis), P1-3 (preuve SMS
quotidienne), P1-4 (nettoyage du reformatage et rebase sur `main`), P1-5 (procédure de
déploiement par `deploy.sh`, migration rejouée sur copie PostgreSQL).
