# 32 — Relecture des promesses documentaires (T56) : ce que les documents 01–18 disent, et ce que le code tient

Date : 14 septembre 2026
Branche : Tracky `codex/tracky-cutoff-reliability-2026-09-12`
Objet : le document 19 (§15) listait les phrases des documents 01–18 que le code ne tenait pas.
Chaque ligne est reprise ici avec son état **au 14 septembre à 07 h**, et la phrase d'origine a
été corrigée **dans le document concerné** (le texte historique reste lisible via `git`).

## Le tableau du document 19, ligne par ligne

| Où | Ce qui était écrit | État au 14/09 | Correction faite |
|---|---|---|---|
| README, doc 03 §orchestrateur, doc 07 R4.1, doc 02 CC-003 | RESTORE jamais abandonnée, rejouée à la reconnexion, file TCP durable | **Tenu** depuis T42 (doc 22) : hook `tracker.connected`, TCP seul retenté 24 h après les 3 SMS, jamais `FAILED` sans preuve ; rappel toutes les 15 min depuis T51 (doc 28). « File TCP » : il n'y a **pas de file dédiée**, l'intention en base (`activeKey`, `nextAttemptAt`) tient ce rôle. | README (principe et critère), doc 02 CC-003, doc 03 (état par point), doc 07 R4 point 4. |
| Doc 13, doc 07 R1.3, doc 03 | Webhook signé pour les statuts sortants + polling | **Tenu** depuis T45 (doc 24) : le relais pousse chaque statut terminal vers `<callbackUrl>/status`, signé ; exige le relais du chantier déployé (doc 25). | Doc 13 (mention T45), doc 07 R1.3. |
| Doc 11 P0-4, doc 08 | SIM explicitement sélectionnée | **Non tenu en production** : `CAPCOM6_SIM_NUMBER` absent du `.env` du relais — geste propriétaire **T43** (doc 25 §2). Le code du relais sait la sélectionner (T44). | Doc 11 P0-4 marqué « non fait en production (T43) ». |
| Doc 11 P0-6 | États `ONLINE/DEGRADED/STALE/OFFLINE` | **Tenu** depuis T44 (doc 23) : `device.state`, seuils 120 s (`STALE`) / 900 s (`OFFLINE`). | Doc 11 P0-6. |
| Doc 12 | Alerte si `STALE` > 90 s | Le code dit **120 s** (`CAPCOM6_DEVICE_STALE_SECONDS`) puis `OFFLINE` à 900 s. Le second téléphone lui-même **n'est pas implémenté**. | Doc 12 (seuils, et bandeau « non implémenté »). |
| Doc 07 R1.3 | Contrôle toutes les 60 s, seuil 120 s | Exact ; le téléphone sans ping (552 s mesurés) est traité par la fenêtre `OFFLINE` de 900 s et par la preuve SMS quotidienne (T45), pas par le seuil de 120 s seul. | Doc 07 R1.3 (deux seuils). |
| Doc 13 §ordre | Migration puis déploiement « à la main » | **Corrigé dans T47** : `deploy.sh` uniquement, ordre téléphone → relais → Tracky (doc 25). | Déjà fait (doc 13 étapes 3-5). |
| Doc 18 | « Déployer Tracky avant le nouveau relais échouerait fermé » | Exact (404 → fail-closed). Le libellé reste trompeur : un relais joignable mais ancien produit « relais SMS injoignable : Télémétrie Android indisponible (HTTP 404) » — le préfixe est faux, le suffixe dit vrai. **Non corrigé** (mineur ; l'ordre de déploiement du doc 25 l'évite). | Rien à changer dans le doc 18 ; libellé noté ici. |
| Doc 17 | 255 suites / 3 920 tests, 727, 416, 5 | Chiffres du 13/09 ; au 14/09 : API 260 suites / 4 081 tests, web 732, smoke 5 (voir README, « État du chantier »). | Doc 17 (note datée). |
| Doc 14 | 23 RESTORE non confirmées / 7 j dont 19 SMS | Reproduit à l'identique en base le 13/09. | Rien à changer. |
| Doc 07 R7.2a | Rafale de 22 RESTORE automatisée | Exact (test présent) ; physique non mesuré, dit honnêtement. | Rien à changer. |
| Docs 01-18 | Rien sur `main` qui bouge | `main` a reçu 27 commits, 3 migrations et un déploiement le 13/09 22:25 pendant le chantier ; la branche est **rebasée** dessus (T46) et la migration du chantier est antérieure aux siennes — appliquée « en retard », vérifié localement (doc 25 §6). | README, « État du chantier ». |

## Ce qui n'est pas dans le tableau mais a été relu

- Doc 07, cases cochées : chaque `[x]` renvoie désormais à un document de correctif ou à un test
  (liste ajoutée en tête de la checklist) ; R6.2b, R7.2b, R7.4 restent **ouvertes** — terrain,
  base réelle, canari : hors de ce que le code peut prouver seul.
- Doc 03, orchestrateur RESTORE : le point 5 (« à l'approche de l'échéance, soumettre le SMS »)
  est tenu **autrement** — le SMS part après l'attente TCP de 15 s et le second essai TCP du
  worker, pas « à l'approche de l'échéance » ; le point 7 (passerelle secondaire) **n'est pas
  implémenté**.
- Doc 16, « impossible de déclencher accidentellement » : **tenu** depuis T50 (doc 30).

## Ce que cette relecture ne fait pas

Elle ne réécrit pas l'histoire : les documents 01–18 gardent leur date et leur raisonnement ;
seules les phrases qui affirmaient un état du code ont reçu une note d'état, datée. Les
documents 19 à 31 sont la source pour l'état réel.
