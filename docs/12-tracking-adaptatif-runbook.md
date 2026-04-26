# 12 — Runbook tracking adaptatif (operateur / admin)

> **Statut :** V1 — 2026-04-26 (livre avec sprints H1-H4)
> **Public :** admin / ops Tracky
> **Lecture :** ~5 min — vue d'ensemble des outils admin livres et procedures terrain

Ce runbook decrit comment utiliser au quotidien les pages admin du tracking
adaptatif (sampling, fix mode boitier, alertes). Il complete la roadmap
technique [11-roadmap-tracking-adaptatif.md](docs/11-roadmap-tracking-adaptatif.md)
qui detaille l'architecture.

---

## 1. Pages admin disponibles

| URL | Pour quoi faire |
| --- | --- |
| `/admin/alerts` | Vue d'ensemble : trackers FAILING, OFFLINE > 1h, commandes PENDING > 10 min |
| `/admin/trackers/:id/sampling` | Stats du sampling adaptatif d'un tracker (KPIs, histogramme, skip list) |
| `/admin/trackers/:id/fix-mode` | Etat fix mode boitier + timeline 90j + override manuel |
| `/admin/observability` | (existant) WireLogs + ErrorLogs bruts |
| `/admin/commands` | (existant) Catalog des commandes Coban manuelles |

---

## 2. Workflow type — un tracker semble bizarre

### 2.1 Un vehicule "disparait" de la carte

1. Aller sur `/admin/alerts`.
2. Verifier la section **OFFLINE > 1h** : si le tracker y est, le boitier ne
   communique plus → couverture GPRS, alimentation, ou panne hardware.
3. Verifier la section **FAILING** : si le tracker y est, la communication
   passe mais les commandes serveur sont ignorees → firmware probablement
   bloque, voir §3.
4. Si pas dans les alertes, ouvrir `/admin/trackers/:id/sampling` et regarder
   "Trames recues" sur 24h. Si > 0, le boitier emet, c'est probablement un
   probleme cote frontend (filtres carte, droits utilisateur).

### 2.2 Un vehicule a une trace en escalier sur l'historique

→ C'est probablement le sampling adaptatif (l'intervalle d'arret est passe
a 5 min). Verifier sur `/admin/trackers/:id/sampling` :

- Si `Ratio insert` < 30% sur la fenetre → sampling agressif, normal.
- Pour augmenter temporairement la finesse, **activer le mode verbose** :
  bouton "Mode verbose" → 1h ou 4h selon le besoin.
- Pour desactiver le sampling **definitivement** sur une fleet (contrats
  imposant un tracage continu), passer `Fleet.adaptiveSamplingEnabled = false`
  via la base ou un futur ecran fleet.

### 2.3 Un tracker est marque FAILING

Sur `/admin/trackers/:id/fix-mode` :

1. Lire le **bandeau d'etat** : `desiredFixIntervalS` (cible serveur) vs
   `currentFixIntervalS` (mesure reelle). Si l'ecart persiste, le boitier
   n'honore pas les commandes.
2. Derouler la **timeline** et regarder les 3-5 dernieres lignes.
3. Le **diagnostic suggere** (en orange dans la ligne) donne l'action
   recommandee. Exemples typiques :
   - "Tester reset SMS RESET123456" → utiliser `/admin/commands` quand le
     SMS gateway sera livre (cf. roadmap V2 `09-roadmap-v2.md`).
   - "Verifier antenne GPS / occlusion" → le vehicule est probablement en
     parking souterrain.
   - "Verifier la couverture GPRS" → la SIM data est peut-etre coupee
     (operateur, recharge, expiration).
4. Si le probleme est resolu, cliquer **Acquitter** pour retirer le badge
   FAILING. Sinon, planifier une intervention physique.

---

## 3. Override manuel du fix mode

Cas d'usage : besoin de forcer la haute frequence pour suivre un convoi en
direct, ou force la basse frequence pour economiser la batterie d'un vehicule
de remplacement immobilise.

Sur `/admin/trackers/:id/fix-mode` :

1. Section **Override manuel**.
2. Choisir l'intervalle force (30 / 60 / 120 / 300 s).
3. Choisir la duree (1h / 4h / 24h, ou "Lever override" pour reactiver l'algo).
4. Cliquer **Appliquer**. La commande Coban est envoyee immediatement via TCP
   (le boitier doit etre online). Une ligne `MANUAL_OPERATOR` apparait dans
   la timeline.

**Ne pas oublier** : pendant l'override, les transitions automatiques
(MOVING → STOPPED → 5min) sont bloquees. L'override expire automatiquement
au bout de la duree choisie.

---

## 4. Mode verbose temporaire (debugging sampling)

Cas d'usage : un client se plaint que ses traces sont incompletes sur un
vehicule precis, et on veut voir TOUTES les trames pendant 1h pour diagnostiquer.

Sur `/admin/trackers/:id/sampling` :

1. Section **Mode verbose**.
2. Choisir 15 min / 1h / 4h / 24h.
3. Cliquer **Appliquer**. Pendant la duree, **chaque trame valide** sera
   persistee dans la table `positions` (decisions `INSERTED_VERBOSE` dans
   l'audit). Le sampling reprend automatiquement a la fin.

Le mode verbose **ne change rien** au boitier (la frequence reste piloteee
par fix mode). Il n'augmente que le stockage cote serveur.

---

## 5. Indicateurs cles a surveiller

| Metrique | Ou la voir | Valeur attendue |
| --- | --- | --- |
| Ratio insert sur tracker en mouvement | `/admin/trackers/:id/sampling` | ~100% (chaque trame inseree) |
| Ratio insert sur tracker arrete | `/admin/trackers/:id/sampling` | ~10-20% (sampling efficace) |
| Trackers FAILING | `/admin/alerts` (badge en haut) | 0 idealement, < 5% du parc en pratique |
| Commandes PENDING > 10 min | `/admin/alerts` | 0 — sinon probleme de socket TCP |
| Trackers OFFLINE > 1h | `/admin/alerts` | < 10% du parc, sinon panne reseau |

---

## 6. Configuration env (production)

| Variable | Defaut | Effet |
| --- | --- | --- |
| `WS_BATCH_COALESCING_ENABLED` | `true` | Si `false`, fallback sur emit immediat (rollback rapide en cas de probleme) |
| `WIRE_LOG_ENABLED` | `false` | Si `true`, persiste les trames TCP dans `wire_logs` (cher en stockage, utile en debugging) |

Aucune autre conf n'est requise pour le tracking adaptatif. Les feature flags
operent par fleet via `Fleet.adaptiveSamplingEnabled` et `Fleet.adaptiveFixModeEnabled`
(true par defaut, modifiables via Prisma Studio en attendant un ecran fleet).

---

## 7. Procedure de rollback

Si un probleme grave est observe en prod apres deploiement :

### 7.1 Desactiver le sampling adaptatif

```sql
UPDATE fleets SET "adaptiveSamplingEnabled" = false;
```

→ chaque trame valide est persistee comme avant.

### 7.2 Desactiver le pilotage fix mode

```sql
UPDATE fleets SET "adaptiveFixModeEnabled" = false;
```

→ plus de commandes `fix...***n` automatiques. Les boitiers gardent leur
intervalle actuel jusqu'a la prochaine commande manuelle ou reset.

### 7.3 Desactiver le batch coalescing

Editer `.env` :

```env
WS_BATCH_COALESCING_ENABLED=false
```

Puis restart le backend. Les positions reprennent leur emit immediat individuel.

### 7.4 Rollback complet code

```bash
git revert 045343a 85fb2a4 4e63c88 639048c
pnpm --filter @vizyo/tracky-api prisma migrate resolve --rolled-back 20260427110000_sprint_h3_fix_mode
pnpm --filter @vizyo/tracky-api prisma migrate resolve --rolled-back 20260427100000_sprint_h1_adaptive_sampling
```

(Note : les migrations descendantes Prisma ne sont pas auto-generees — il
faut DROP les colonnes manuellement si on veut un vrai rollback DB.)

---

## 8. Pour aller plus loin

- Architecture detaillee : [11-roadmap-tracking-adaptatif.md](docs/11-roadmap-tracking-adaptatif.md)
- Protocole Coban : [03-protocol-coban-gps403d.md](docs/03-protocol-coban-gps403d.md)
- Observabilite generale : [08-logging-and-observability.md](docs/08-logging-and-observability.md)
