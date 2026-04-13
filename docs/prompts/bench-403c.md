# Guide bench 403C — Phase 5

> **Ce n'est PAS un prompt Claude Code.** C'est un guide manuel à suivre toi-même sur le bench physique.
> Se déroule **après Vague A livrée**.

---

## Matériel à préparer la veille

- [ ] 403C sur bench avec alim 12V stable (pas de batterie faible)
- [ ] SIM data activée, crédit SMS vérifié
- [ ] APN connu, user/pass le cas échéant
- [ ] Relais coupe-circuit NC câblé sur le fil jaune + LED témoin
- [ ] Multimètre en mode continuité
- [ ] Smartphone pour envoyer les SMS de config
- [ ] VPS staging OU tunnel `ngrok tcp 5023` prêt
- [ ] `.env` API pointant sur la bonne DB staging (pas prod !)

## Environnement software

1. Démarrer l'API avec logs Pino en pretty :
   ```bash
   NODE_ENV=development WIRE_LOG_ENABLED=true pnpm --filter api dev
   ```
2. Ouvrir 3 terminaux :
   - Terminal 1 : logs API (pino pretty, stdout)
   - Terminal 2 : `pnpm prisma studio` (observer `trackers`, `positions`, `engine_control_commands`, `tracker_commands`, `wire_logs`)
   - Terminal 3 : `curl` pour tests ponctuels
3. Ouvrir 2 onglets navigateur :
   - Tracky web connecté SUPER_ADMIN sur `/vehicles/<id>`
   - Tracky web `/admin/observability` tab "Tracker timeline"
4. Seed IMEI du 403C en base (via UI ou script), associer à un véhicule test.

## Étape 0 — Config SMS initiale (séquentielle stricte)

**Règle** : chaque SMS doit recevoir son ACK avant d'envoyer le suivant.
Si un ACK ne vient pas en 30s → STOP, reset le 403C, recommencer.

| # | SMS à envoyer | ACK attendu | Cocher |
|---|---------------|-------------|:---:|
| 1 | `begin<PWD>` | `begin ok` | [ ] |
| 2 | `password<OLD> 123456` | `password ok` | [ ] |
| 3 | `apn123456 <apn>,<u>,<p>` | `APN OK` | [ ] |
| 4 | `adminip123456 <IP_PUBLIC> 5023` | `adminip ok` | [ ] |
| 5 | `gprs123456` | `GPRS ok` | [ ] |
| 6 | `time zone123456,0` | `time zone ok` | [ ] |
| 7 | `fix030s***n123456` | `fix030s***n ok` | [ ] |
| 8 | `protocol123456 18` | `protocol18 ok` | [ ] |
| 9 | `less gprs123456 on` | `less gprs on ok` | [ ] |

**Note 403C** : le password initial peut être soit `123456` soit l'IMEI. Tester `begin123456` en premier, si KO → `begin<IMEI>`.

**Note `protocol 18`** : si le 403C refuse (ACK absent ou `protocol unknown`), c'est un firmware plus ancien → les champs ACC/porte/fuel seront absents des positions. Noter en divergence.

## Étape A — Login + heartbeat

1. [ ] Alimenter le 403C, attendre 30-60s (acquisition GPS)
2. [ ] Dans Terminal 1, chercher `Tracker connected` → noter l'IMEI
3. [ ] Dans Studio : `tracker.status = ONLINE`, `lastSeenAt` récent
4. [ ] Dans UI fleet : badge tracker vert
5. [ ] Dans `/admin/observability` tab "Wire logs" : trouver la trame login raw
6. [ ] **COPIER la trame login brute** dans la section "Divergences" du tracker si format inattendu
7. [ ] Attendre 90s : heartbeat `IMEI;` visible dans les wire logs, `ON` en réponse

**Red flag** : si `Unknown IMEI attempting login` → l'IMEI n'est pas en base OU le login packet a un format différent → vérifier la regex du parser sur la trame capturée.

## Étape B — Position

1. [ ] Attendre 30-60s, vérifier arrivée des positions dans les wire logs
2. [ ] Dans Studio `positions` : au moins 3 rows avec `valid=true`, lat/lng cohérents
3. [ ] **COPIER 3 trames raw de position** dans le rapport
4. [ ] Carte Tracky : marker visible, à la bonne position
5. [ ] Déplacer le bench de 20m → marker bouge dans les 30-60s
6. [ ] Si protocol 18 actif : vérifier présence de `ignition`, `door`, `fuel`, `temperature` dans les rows positions

**Red flag** : si positions parsées mais `valid=false` → GPS pas encore fixé, attendre. Si aucune position n'arrive → heartbeat seulement → problème de config `fix030s***n`.

## Étape C — CUT / RESTORE (véhicule à l'ARRÊT)

⚠️ **Bench immobile obligatoire.** Multimètre en continuité sur les deux extrémités du relais.

### C1 — CUT

1. [ ] Vérifier : dernière position speed=0, positionAge < 60s, valid=true
2. [ ] UI vehicle-detail → bouton **CUT** rouge
3. [ ] Double confirmation (saisir "OK" ou équivalent)
4. [ ] Toast "Commande envoyée" visible
5. [ ] Logs : `Command dispatched to <IMEI>: **,imei:<IMEI>,J;` avec `commandId` + `latencyMs`
6. [ ] **Multimètre** : continuité coupée ✂️ (en moins de 3s attendu)
7. [ ] Studio `engine_control_commands` : status = SENT (ou ACKNOWLEDGED si ACK reçu)
8. [ ] Timer : mesurer latence click UI → bascule relais. Cible < 3s.

### C2 — RESTORE

1. [ ] UI → bouton **RESTORE** vert
2. [ ] Double confirmation
3. [ ] Multimètre : continuité rétablie 🔁
4. [ ] Studio : nouvelle commande RESTORE status SENT
5. [ ] Latence mesurée

### C3 — Garde-fou vitesse (OPTIONNEL si bench embarqué)

1. [ ] Véhicule roulant à 25 km/h : tenter CUT → doit être refusé `REJECTED_SPEED`
2. [ ] Message UI explicite : "Vitesse trop élevée"

## Étape D — Test d'une commande du catalog (Vague A livrée)

Démontrer que la console de commandes fonctionne en vrai :

1. [ ] UI vehicle-detail tab "Commandes" → catégorie "Info" → template "Demander position"
2. [ ] Envoyer → vérifier log `Command dispatched` avec `templateId=position_single`
3. [ ] Dans les 30s : une nouvelle position doit arriver hors du cycle normal
4. [ ] Historique : la commande passe PENDING → SENT → ACKNOWLEDGED
5. [ ] Latence ACK mesurée, notée

Répéter avec :
- [ ] `status` (commande info)
- [ ] `speed_alarm 100` (commande param, ACK expected)
- [ ] Une commande SCHEDULED dans 2 min → vérifier dispatch automatique

## Rapport `docs/bench-403c-report.md`

Template à remplir :

```md
# Bench 403C — <date>

## Conditions
- IMEI: <imei>
- SIM: <operateur>, APN <apn>
- Firmware 403C: <si affichage dispo>
- Endpoint API: <url>
- Alim: 12V / batterie auxiliaire

## Résultats par étape

### Config SMS
| # | Commande | ACK reçu | Latence | OK |
|---|---|---|---|---|
| 1 | begin | ... | ... | ✅/❌ |

### Tests E2E
| Test | Résultat | Latence | Notes |
|------|----------|---------|-------|
| A1 Login | ✅ | 1.2s | Frame exacte: `##,imei:XXX,A;` |
| A2 LOAD | ✅ | 50ms | |
...

## Trames brutes capturées
- Login: `##,imei:XXX,A;`
- Position 1: `imei:XXX,tracker,201223...`
- Position 2: `...`
- Position 3: `...`

## Divergences 403C vs doc 403D
| Domaine | Attendu | Observé | Impact | Fix |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

## Latences mesurées
- Login handshake: Xms
- Position → DB: Xms
- CUT UI → relais: Xs
- ACK commande `status`: Xms

## Décision
- [ ] OK pour passer Vague B (SMS)
- [ ] PR fix parser nécessaire : <description>
- [ ] Blocage majeur : <description>
```

## Mise à jour `EXECUTION-TRACKER.md` après bench

- Cocher toutes les étapes bench réussies
- Remplir le tableau "Divergences 403C observées"
- Ajouter ligne au journal des sessions
- Passer progress bar "Bench 403C" à 100 %
- Si blocage : ajouter ligne dans "Issues ouvertes"
- Si OK : passer à `docs/prompts/vague-b.md`
