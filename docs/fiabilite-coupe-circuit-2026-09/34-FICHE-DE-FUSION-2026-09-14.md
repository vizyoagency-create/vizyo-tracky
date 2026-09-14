# 34 — Fiche de fusion : ce que les deux branches contiennent, dans l'ordre, et comment les relire

Date : 14 septembre 2026
Pour : la relecture du propriétaire avant la fusion (document 25 §3). Rien ici n'est poussé ni fusionné.

## 1. Tracky — `codex/tracky-cutoff-reliability-2026-09-12`, 28 commits sur `main` au 14/09 10 h (cette fiche et ses mises à jour comprises — `git rev-list --count main..HEAD` fait foi)

Vérifié le 14/09 à 09:45 : `git merge-tree origin/main HEAD` **propre**, aucun fichier commun entre les commits de
`origin/main` depuis la base (`049d1d11`) et ceux de la branche. La copie non suivie `docs/fiabilite-coupe-circuit-2026-09/`
du worktree `main` a été retirée (sauvegarde hors dépôt) : `git status` du worktree `main` ne montre plus que des fichiers
qui ne sont pas du chantier.

| # | Commit | Tâche | Quoi | Où relire |
|---|---|---|---|---|
| 1–6 | `01756db7` … `de2f2949` | chantier du 12/09 | commandes moteur TCP/SMS fiabilisées, file des coupures, santé Android | docs 13, 15, 16, 18 |
| 7 | `d5c19a17` | T40 (P0-1) | la clé d'unicité RESTORE ne vit plus pour toujours | doc 20 |
| 8 | `076695c2` | T46 | doc 20 mis à jour | — |
| 9 | `8ab1d08e` | T41 (P0-2) | validité des SMS CUT, priorité RESTORE, annulation du SMS supplanté | doc 21 |
| 10 | `86c32fa9` | T42 (P1-1) | RESTORE relancée à la reconnexion, jamais terminale sans preuve | doc 22 |
| 11 | `86a2fc53` | T44 (P1-2) | sentinelle Android avec hystérésis, verdict par appareil | doc 23 |
| 12 | `1aa1e0f9` | T45 (P1-3) | preuve SMS quotidienne 04:30 / 06:30, écho entrant | doc 24 |
| 13 | `fde25b96` | T47 | procédure de déploiement ; index du worker dans `schema.prisma` | doc 25 |
| 14 | `93dba465` | T49 (P2-2) | kill-switch et interlock : une ligne par cause, espacée | doc 26 |
| 15 | `8a8cb2c4` | T48 (P2-1·4) | une preuve ne se rétrograde jamais ; CUT orpheline dispatchée | doc 27 |
| 16 | `b582fbf6` | T51 (P2-5·6) | rappel toutes les 15 min, SMS bloqué retenté, clic manuel borné | doc 28 |
| 17 | `428d1f39` | T52 (P2-9) | l'allowlist du relais ne bloque plus une RESTORE | doc 29 |
| 18 | `8bb24ca7` | T50 (P2-3) | le glissement de confirmation est un geste | doc 30 |
| 19–20 | `b407481a`, `e1634c97` | T53 (P2-10) | journal des tentatives exercé, changement d'heure | doc 31 |
| 21–24 | `10719033` … `01795646` | docs, T56 | documents 27–32, relecture des promesses | doc 32 |
| 25 | `303560c1` | T43, T61 | journée S21 | doc 33 |
| 26–28 | (cette fiche) | — | fiche de fusion et ses mises à jour | doc 34 |

Suites au 14/09 : typecheck vert, smoke DI 5/5, API 260 suites / 4 081 tests, web 732, partagé inchangé.
**Migration** : une seule, `20260912110000_engine_delivery_reliability` (additive), d'horodatage antérieur aux
trois migrations `20260913*` déjà en production — `migrate deploy` l'applique comme « en attente » (démontré, doc 25 §6).

## 2. Relais Texto — `codex/gateway-health-reliability-2026-09-13`, 5 commits sur `origin/main`

| Commit | Tâche | Quoi |
|---|---|---|
| `2de94d8` | chantier du 12/09 | santé réelle de la passerelle |
| `2536ea4` | T41 | validité, priorité, appareil explicite, `DELETE /v1/texto/:id` |
| `784d766` | T44 | verdict par appareil en quatre états, SIM exposées, réglages bornés |
| `ae17b34` | T45 | statuts sortants poussés sur `<callbackUrl>/status` |
| `0bb4013` | T47 | image capcom6 épinglée (`CAPCOM6_SERVER_TAG`), variables du téléphone transmises |

Suites : 7 suites / 55 tests ; aucune migration de base.

## 3. Ordre de relecture conseillé (2 h)

1. Doc 19 (le verdict) puis doc 32 (ce qui est tenu) — pour savoir quoi chercher.
2. `engine-control.service.ts` : suivre une RESTORE de sa création à sa preuve (T40, T42, T48, T51) ; le spec fait 139 tests, les
   noms des tests racontent chaque défaut.
3. `sms-gateway.service.ts` et `sms-heartbeat.service.ts` (T41, T45, T52) ; `sms-gateway-watchdog.service.ts` (T44).
4. `schedule-cron.service.ts` (T49) et `confirm-modal.component.ts` (T50).
5. Relais : `messages.service.ts`, `webhooks.controller.ts`, `webhook-delivery.service.ts`, `docker-compose.vps.yml`.

## 4. Après la fusion

`origin/main` à jour des deux côtés → document 25 §4 à §10, dans l'ordre, ensemble. Rien ne se déploie sans la fenêtre.
