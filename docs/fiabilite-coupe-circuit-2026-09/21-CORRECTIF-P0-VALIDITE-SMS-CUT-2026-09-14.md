# 21 — Correctif P0-2 (T41) : une coupure par SMS a une date de péremption

Date : 14 septembre 2026
Branches : Tracky `codex/tracky-cutoff-reliability-2026-09-12` · relais `codex/gateway-health-reliability-2026-09-13`
Production : **aucun changement** — code écrit, testé et committé sur les deux branches, non déployé.

## Le défaut corrigé (document 19, P0-2)

Le relais envoyait au serveur SMS `textMessage` + `phoneNumbers`, sans validité, sans priorité,
sans viser un appareil. Or le 11/09, un SMS est resté **1 h 06** dans la file d'un téléphone
endormi avant de partir. Une COUPURE qui subit ce retard s'exécute **après** la remise en route du
matin : véhicule coupé au départ, sans que personne ne l'ait demandé. Et quand une RESTORE
supplantait une CUT, elle ne la marquait qu'en base — le SMS `stop` restait dans la file du
téléphone.

## Ce qui change

### Relais Texto (commit `2536ea4`)

| Où | Quoi |
|---|---|
| `POST /v1/texto/send` | Accepte `ttlSeconds` (5 … 86 400) et `priority` (−128 … 127). Conservés dans le contexte d'audit (`context.envoi`). |
| `Capcom6Service.send` | Transmet `ttl` (validité appliquée **par le téléphone**), `priority` (≥ 100 contourne limites et délais), `deviceId` (`CAPCOM6_DEVICE_ID`) et demande toujours l'accusé de remise. Bornes du contrat respectées. |
| `DELETE /v1/texto/:id` | Annule un sortant encore en attente, cloisonné par tenant. Réponse **toujours 200** avec `cancelled` et la raison ; 404 seulement hors tenant. `Capcom6Service.cancel` ne lève jamais. |
| `mapCapcom6State` | `Cancelling` / `Cancelled` rendus tels quels. |

Supports côté serveur capcom6 : `ttl` depuis v1.2, `priority` v1.20, `deviceId` v1.25 — **tous
présents sur le 1.43.0 de production**. L'annulation n'existe que depuis **v1.45.0 (07/07/2026)**
(409 sur un message déjà pris depuis v1.46.1) : sur le serveur actuel, le relais répond
« annulation non supportée » et rien ne casse. La mise à jour du conteneur serveur est un
prérequis de T47 pour que l'annulation devienne effective.

### Tracky (ce commit)

| Où | Quoi |
|---|---|
| `SmsSendContext` | `ttlSeconds` et `smsPriority` (distinct de `priority`, chaîne qui ordonne la file locale). |
| `sendViaVizyoTexto` | Les deux options remontent au premier niveau du corps envoyé au relais. |
| `trySmsFallback` | **CUT** : `ttlSeconds = ENGINE_CUT_SMS_TTL_S` (défaut 900, plancher 60). **RESTORE** : `smsPriority = 100`, jamais de validité. |
| `requestCommand` (RESTORE supplante CUT) | Relit les CUT visées avant de les clore, puis demande au relais l'annulation de leur SMS (`SmsGatewayService.cancelOutbound`) — asynchrone, jamais bloquant, jamais levé. Succès : la commande dit « SMS annulé au relais avant émission » ; refus : journal, la validité reste la garde. |
| `SmsGatewayService.cancelOutbound` | `DELETE /v1/texto/:providerId`, puis `sms_logs.status = cancelling` + `statusUpdatedAt` ; refuse sans identifiant fournisseur, sur statut terminal, sur entrant, ou hors `vizyo-texto`. |
| Env | `ENGINE_CUT_SMS_TTL_S=900` (validation, exemples, doc 13). |

## Ce que ce correctif garantit — et ne garantit pas

- Garanti dès le déploiement (serveur 1.43.0) : **le téléphone n'émet plus un `stop` de plus de
  15 min** ; les `resume` passent devant tout et hors délais sur le téléphone ; l'appareil visé
  est explicite dès que `CAPCOM6_DEVICE_ID` est renseigné (T43).
- Garanti après mise à jour du serveur capcom6 (≥ 1.45.0) : une CUT supplantée avant d'être
  prise par le téléphone est retirée de la file du serveur.
- Jamais garanti : un `stop` **déjà pris** par le téléphone et émis dans les 15 min ; c'est le
  comportement voulu (la coupure était légitime à cet instant), et la RESTORE qui suit le
  couvre par le worker durable.

## Tests ajoutés (verts)

- Relais — `capcom6.service.spec.ts` : transmission de `ttl`/`priority`/`withDeliveryReport`,
  absence quand rien n'est demandé, bornes, `DELETE` avec état, refus 405/409/réseau sans lever ;
  `messages-cancel.service.spec.ts` : annulation cloisonnée, `null` hors tenant, refus honnête
  d'un message parti, serveur ancien sans effet, entrant et message sans identifiant. **5 suites,
  33 tests.**
- Tracky — `sms-gateway.service.spec.ts` : corps envoyé au relais avec `ttlSeconds`/`priority`,
  `cancelOutbound` (DELETE, statut, refus, entrant, terminal) ; `engine-control.service.spec.ts` :
  validité sur CUT, priorité sur RESTORE, annulation à la supplantation, refus d'annulation qui
  ne bloque pas la RESTORE.

## Ce qu'il reste

T42 (relance TCP à la reconnexion), T44 (sentinelle), T45 (preuve quotidienne), T43 (téléphone :
ping, FIFO, SIM, `CAPCOM6_DEVICE_ID`), T47 (procédure, dont mise à jour du serveur capcom6 pour
l'annulation), puis la recette T54 — notamment « CUT puis RESTORE rapprochées avec SMS retardé »
sur boîtier de banc.
