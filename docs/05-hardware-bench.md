# Phase 5 — Bench hardware Coban GPS403C (Tracky V1)

**Objectif** : valider E2E `login + position + CUT/RESTORE` sur un vrai tracker Coban 403C connecté à l'API de prod (ou staging accessible en public).

**Durée estimée** : 1 journée (setup + tests + rapport).

**Prérequis projet** : phases 1→4 validées (TCP server, parser, EngineControl, UI). La version "fake" via `FakeTcpSocket` fonctionne déjà E2E, ce bench confirme la compatibilité avec le vrai firmware.

---

## 5.0 Note compatibilité 403C vs 403D

Le code et la doc `docs/03-protocol-coban-gps403d.md` sont écrits pour le 403D. Le **403C** utilise la même famille de protocole (GPS103/Coban), mais il faut **valider trame par trame** que :

- Le login packet a bien le format `##,imei:<15 digits>,A;`
- Les positions arrivent au format `imei:...,tracker,...` (§9.1 de la doc protocole)
- Les commandes `J` / `K` (engine stop/resume) sont acceptées
- Le firmware répond `LOAD` / `ON` correctement

**Risques identifiés sur 403C** :
- Certaines variantes firmware envoient un format de date différent (sans `/`)
- Le `protocol 18` enrichi (ACC, porte, fuel) n'existe pas toujours sur 403C
- Le code `E;` d'ACK SOS peut être absent sur 403C

Si divergences → noter dans le rapport, adapter le parser si nécessaire (en gardant les tests existants verts).

---

## 5.1 Matériel requis

- 1× Coban GPS403C
- 1× SIM data activée (APN connu, solde crédité, SMS entrants/sortants autorisés)
- 1× Alim 12V bench OU faisceau véhicule
- 1× Relais coupe-circuit (NC) câblé sur le fil jaune du 403C (sinon CUT invisible)
- Téléphone pour envoyer les SMS de config initiale
- Multimètre pour vérifier l'état du relais

## 5.2 Pré-requis réseau

- [ ] **API joignable depuis internet public** sur le port TCP `5023` (tracker ne peut PAS joindre `localhost`)
  - Option A : déploiement staging sur VPS
  - Option B : tunnel `ngrok tcp 5023` en dev local (noter que ngrok TCP = plan payant)
  - Option C : exposer ponctuellement le port sur routeur box (IP publique + port forward)
- [ ] Vérifier : `nc -v <domaine> 5023` depuis externe doit ouvrir la socket
- [ ] IMEI du 403C inséré en base via admin UI ou seed (sinon `Unknown IMEI` → socket fermée)

## 5.3 Config SMS initiale du 403C

⚠️ **Sur 403C, le mot de passe initial peut être l'IMEI complet OU `123456` selon firmware**. Tester les deux — si `begin123456` échoue, tenter `begin<IMEI>`. Aligner ensuite avec `password<OLD> 123456`.

Envoyer les SMS **dans cet ordre exact**, attendre l'ACK à chaque étape :

| # | SMS envoyé | ACK attendu | Rôle |
|---|---|---|---|
| 1 | `begin<PWD>` | `begin ok` | Init boîtier |
| 2 | `password<OLD> 123456` | `password ok` | Align password sur `123456` (skip si déjà à 123456) |
| 3 | `apn123456 <apn>,<user>,<pass>` | `APN OK` | Config APN opérateur |
| 4 | `adminip123456 <IP_PUBLIQUE> 5023` | `adminip ok` | Pointage vers l'API Tracky |
| 5 | `gprs123456` | `GPRS ok` | Activation mode GPRS |
| 6 | `time zone123456,0` | `time zone ok` | UTC (évite décalage côté parser) |
| 7 | `fix030s***n123456` | `fix030s***n ok` | Fix toutes les 30s en continu |
| 8 | `protocol123456 18` | `protocol18 ok` | Active ACC + porte + fuel (si supporté 403C) |
| 9 | `less gprs123456 on` | `less gprs on ok` | Réduit trafic quand stationnaire |

**Si un ACK ne revient pas en < 30s** : SIM sans crédit SMS, password désynchronisé, ou 403C pas encore éveillé (appuie sur SOS pour forcer un réveil GSM).

## 5.4 Checklist validation E2E

### Étape A — Login + heartbeat

- [ ] Alimenter le 403C, attendre 30–60s (acquisition GPS)
- [ ] Logs API : `Tracker connected: <IMEI>`
- [ ] Base : `tracker.status === 'ONLINE'` + `lastSeenAt` récent
- [ ] WebSocket front : event `tracker:status` reçu, badge UI passe au vert
- [ ] Attendre 90s : heartbeat parsé, `ON` renvoyé par l'API (vérifier en debug log)
- [ ] **Capturer la trame exacte du login** → vérifier match `decodeFrame` (mettre raw dans le rapport)

### Étape B — Position

- [ ] Logs API : trames `imei:...,tracker,...` reçues toutes les 30s
- [ ] Base : rows dans `positions` avec `valid=true` et `lat/lng` cohérents
- [ ] Dashboard : marker visible sur la carte Leaflet, position live mise à jour
- [ ] Déplacer le bench de 20m → marker bouge dans les 30s
- [ ] **Capturer 3 trames brutes** de position dans le rapport → vérifier que tous les champs sont parsés (date, speed, course, altitude, ignition si protocol 18)

### Étape C — CUT / RESTORE (BENCH MOTEUR COUPÉ, VÉHICULE À L'ARRÊT)

⚠️ **Test uniquement sur bench ou véhicule au stop complet**. Ne pas tester sur un véhicule en mouvement même si le garde-fou refuserait — cohérence opérationnelle.

- [ ] Vitesse 0 km/h dans la dernière position, `positionAge < 60s`, `valid=true`
- [ ] UI Tracky → fiche véhicule → bouton **CUT**
- [ ] Double confirmation
- [ ] Toast "Commande envoyée"
- [ ] Logs API : `Command dispatched to <IMEI>: **,imei:<IMEI>,J;`
- [ ] **Multimètre** : relais bascule en position ouverte → coupure du circuit démarrage
- [ ] Base : `engine_control_commands.status = SENT`
- [ ] Bouton **RESTORE** → multimètre revient en fermé
- [ ] Base : nouvelle commande `RESTORE` avec `status = SENT`
- [ ] **Mesurer la latence** entre click UI et bascule relais — consigner dans le rapport

### Étape D — Garde-fou vitesse (optionnel si bench fixe)

- [ ] Si test embarqué : rouler à 25 km/h → tenter CUT → doit être refusé côté serveur avec `REJECTED_SPEED`
- [ ] À l'arrêt → CUT doit passer

## 5.5 Livrables attendus

- `docs/bench-403c-report.md` : date, IMEI testé, résultat par checklist, captures logs (raw frames), latences mesurées, divergences vs 403D
- Si bugs : tickets créés avec raw frame, trace serveur, action utilisateur
- Si adaptation parser/encoder nécessaire pour 403C : PR dédiée avec tests sur fixtures réelles capturées
- Mise à jour `docs/04-roadmap.md` ligne bench → ✅

## 5.6 Gotchas fréquents à capturer dans le rapport

- IMEI différent d'un tracker déjà seed → rejet silencieux, regarde `Unknown IMEI` dans les logs
- Tracker envoie `##,imei:...,A;` avec retour chariot `\r\n` différent du `;` → vérifier que le split tient
- Reconnexions GPRS automatiques : noter la fréquence pour ajuster le `stale threshold` si nécessaire
- SOS → le 403C spamme la trame `help me` toutes les 3 min tant que pas ACK → vérifier que l'ACK `,E;` est bien émis (ou adapter si 403C ne supporte pas cet ACK)
- Si le firmware envoie des trames inattendues (alarmes OBD, photos) → logguer comme `unknown`, ne pas crasher

---

## 5.7 Pattern pour Claude Code

Ce bench n'écrit pas de code sauf si un bug émerge. Si un bug est identifié :

1. Reproduire en test unitaire dans `packages/shared/src/protocol/` ou `apps/api/src/tracker-tcp/`
2. Fixer
3. Re-tester manuellement
4. Logguer dans le rapport

Ne pas refactor opportunément : on veut un rapport propre avant de passer phase 6.
