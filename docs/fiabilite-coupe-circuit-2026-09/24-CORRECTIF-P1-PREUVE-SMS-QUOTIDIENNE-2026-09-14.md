# 24 — Correctif P1-3 (T45) : une preuve SMS chaque matin, et le relais dit ce qu'il sait

Date : 14 septembre 2026
Branches : Tracky `codex/tracky-cutoff-reliability-2026-09-12` · relais `codex/gateway-health-reliability-2026-09-13`
Production : **aucun changement** — code écrit, testé et committé sur les deux branches, non déployé.

## Le défaut corrigé (document 19, P1-3)

L'interlock des coupes automatiques exige une remise SMS **prouvée de moins de 24 h**
(`lastTerminalSuccessAt`). La seule source régulière était la preuve de vie **hebdomadaire**
du lundi 09:00. Une semaine TCP saine, sans SMS réel, et dès le mardi soir **toutes** les
coupures automatiques étaient refusées — avec un CRITICAL par appel (T49). Et le relais ne
poussait **aucun** statut sortant : sa table savait (13 failed, 6 sent, 6 delivered sur sept
jours), Tracky n'en voyait qu'un (mesure du 14/09 : 24 sortants `queued` sans suite, un seul
`delivered` en sept jours — la preuve de vie du 07/09).

## Ce qui change

### Relais Texto (commit `ae17b34`)

| Où | Quoi |
|---|---|
| `WebhooksController.handleStatus` | `sms:sent` / `sms:delivered` / `sms:failed` / `sms:cancelled` (serveur ≥ v1.45.0) : la ligne `OUT` est mise à jour **sans jamais rétrograder un terminal** (webhooks dans le désordre), `failed` garde la raison du téléphone (`SmsFailedPayload.reason`) — **puis le statut est poussé au tenant**. Un webhook rejoué est repoussé : le tenant est idempotent. Une file en panne ne fait pas échouer le webhook capcom6 (sinon le serveur rejoue à l'infini). |
| `WebhookDeliveryService.enqueueStatus` | Même file persistante (retries, backoff 10 s → 1 h, 10 tentatives) et même signature (`X-Vizyo-Signature` / `X-Vizyo-Timestamp`) que les entrants. URL déduite : **`<callbackUrl>/status`** — le contrat que Tracky expose déjà (`POST /sms/webhook/status`), donc **pas de migration**. |
| Payload | `{ event, id (relais), providerId (capcom6 — celui que Tracky a gardé), status, to, at, errorMessage? }`. |

### Tracky (ce commit)

| Où | Quoi |
|---|---|
| `SmsHeartbeatService` | Deux sondes, un code (`HeartbeatKind`) : la preuve de vie **hebdo** inchangée (lundi 09:00, admins), et la preuve **quotidienne** — crons `sms-daily-proof` à **04:30 et 06:30** Europe/Paris (T-30 min des fenêtres de remise en route de 05:00 et 07:00) et `sms-daily-proof-verify` à **04:45 et 06:45**. Destinataire unique `SMS_DAILY_PROOF_RECIPIENT` (vide = no-op, journalisé) ; modèle `gateway_daily_proof` (catalogue des communications), source `sms-daily-proof`. |
| Vérification quotidienne | Fenêtre de **30 min** (`SMS_DAILY_PROOF_VERIFY_WINDOW_MIN`) : un passage à la fois. Réconciliation au relais, puis verdict : `OK` muet ; `INDETERMINE` en **ERROR** ; `ECHEC` et `NON_EMIS` en **CRITICAL** — chaque ligne dit la conséquence : « sans remise prouvée sous 24 h, l'interlock refusera les coupes automatiques de ce soir ». |
| **L'écho** | Si la preuve vise la SIM du téléphone passerelle lui-même, le message revient en **entrant** par le webhook. Un sortant encore « accepté » dont le corps est revenu est marqué `received` (statut terminal de succès connu) : remise prouvée **par réception** — émission, réception et webhook entrant en une seule preuve — et l'interlock la voit. |
| `recordOutboundStatus` | Un `cancelled` reçu sur une ligne que **nous** avons mise en `cancelling` (T41, CUT supplantée) écrit le terminal **sans alerte** ; un `cancelled` que personne n'a demandé reste un échec alerté. |
| Admin | `POST /api/admin/sms/heartbeat/run-now?kind=quotidien` et `…/verify?kind=quotidien` : rejouables à la main. |
| Catalogue des traitements | Deux entrées (`sms-daily-proof`, `sms-daily-proof-verify`), criticité haute — le garde d'exhaustivité et le compteur de drift restent justes. |
| Env | `SMS_DAILY_PROOF_RECIPIENT` (validation, exemples, doc 13). |

## Ce que ce correctif garantit — et ne garantit pas

- Garanti dès que `SMS_DAILY_PROOF_RECIPIENT` est renseigné et que le relais pousse : chaque
  matin, une remise prouvée (< 24 h) existe avant les fenêtres de départ **et** avant les coupes
  du soir ; si elle manque, un humain le sait à 04:45 — avant l'heure de départ, pas après.
- Garanti : les `delivered` / `failed` de **toutes** les commandes moteur parties par SMS arrivent
  désormais à Tracky en quelques secondes (webhook) au lieu d'être relus toutes les 30 s par le
  worker ; le worker garde sa relecture (seconde voie indépendante).
- Coût : **deux SMS par jour** (≈ 60 par mois) vers le numéro neutre.
- **Non vérifié** : qu'un SMS envoyé par le S21 à son propre numéro lui soit remis par Free
  (auto-envoi). Si l'opérateur ne le fait pas, l'écho n'arrive pas — mais l'accusé `delivered`
  poussé par le relais suffit à la preuve. À constater lors de T43/T54 ; à défaut, tout autre
  numéro neutre convient (une seconde SIM, un numéro de test).
- **Prérequis T43/T47** : le numéro doit être dans l'**allowlist** du tenant Tracky côté relais
  (le tenant est en `allowlistMode`) ; les webhooks `sms:sent`, `sms:delivered`, `sms:failed` —
  et `sms:cancelled` après la mise à jour du serveur — doivent être enregistrés côté capcom6
  vers `/internal/capcom6/webhook` (ils l'ont été le 24/08 pour les trois premiers, à **revérifier**
  dans `GET /3rdparty/v1/webhooks` : non vérifié sur la prod du 14/09).
- Non garanti : l'interlock reste **rouge** tant que T43 (téléphone) et cette preuve ne sont pas
  en place en production — c'est voulu.

## Tests ajoutés (verts)

- Relais — `webhooks-status.controller.spec.ts` (8, nouveau) : delivered → ligne mise à jour
  sans rétrograder + poussée sur `<callbackUrl>/status` ; failed avec la raison ; cancelled tel
  quel ; webhook rejoué sur ligne terminale repoussé ; message inconnu / sans tenant acquitté sans
  poussée ; file en panne n'échoue pas le webhook ; signature invalide → 403 sans écriture ;
  dérivation de l'URL. **7 suites / 55 tests.**
- Tracky — `sms-heartbeat.service.spec.ts` (+10) : no-op sans destinataire, un seul SMS au numéro
  neutre avec le bon modèle (jamais aux admins), l'hebdo inchangée, refus de soumission avec la
  conséquence, fenêtre de 30 min et modèle quotidien, **écho → received → OK**, écho sans
  correspondance ne prouve rien, INDETERMINE en ERROR sous `sms-daily-proof`, NON_EMIS en
  CRITICAL, les crons appellent la bonne sonde ; `sms-gateway.service.spec.ts` (+2) : `cancelled`
  voulu sans alerte, `cancelled` non demandé alerté ; catalogue des communications (+1 modèle).

## Ce qu'il reste

T43 (téléphone + `SMS_DAILY_PROOF_RECIPIENT` + allowlist + webhooks capcom6 à vérifier), T47
(procédure), puis T54 — notamment : 24 h de preuve quotidienne verte **avant** tout canari.
