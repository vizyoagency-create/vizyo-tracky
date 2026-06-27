# Diagnostic — boîtiers « muets » CDEF 31

> Lecture seule sur la prod (VPS, vraies données). Aucune donnée modifiée, aucune
> commande envoyée à un boîtier. Établi le 2026-06-26.

## Définition retenue de « muet »
Une tâche d'installation **marquée Posée (`status = DONE`)** dont le tracker :
- **(a)** n'a **jamais** ouvert de connexion (`lastSeenAt` null) — aucune trame, jamais ; ou
- **(b)** s'est connecté puis s'est tu : `lastSeenAt` > **24 h** (un boîtier sain reporte plusieurs fois/jour) ; ou
- **(c)** « faux muet » : l'IMEI **de la tâche** ne correspond pas au tracker **réel** du véhicule — le véhicule émet, mais sous un autre IMEI → problème de **donnée d'association**, pas un boîtier mort.

`lastSeenAt` est le signal canonique « a-t-il déjà émis ? » (posé à la 1ʳᵉ trame, jamais remis à zéro).

## Sources croisées
`InstallationTask` (statut, date pose, imei, sim) × `Tracker` (lastSeenAt, lastPositionAt, status) × `Vehicle` (tracker réel par plaque) × `wire_logs` (octets bruts) × logs serveur (connexions TCP).

## Résultat global du plan CDEF 31 (31 tâches)
- **22** Posées **OK** (l'IMEI de la tâche émet) ✅
- **6** Posées **à investiguer** (détail ci-dessous)
- **3** non-Posées (PENDING — installs pas encore faites, normal)

`wire_logs` actif (534 488 lignes) → **0 octet** capturé pour les **6 IMEI de tâche** : aucun n'a jamais émis sous cet IMEI. Côté logs serveur, seuls les **3 trackers réels** (…7902, …6383, …6227) se connectent.

## Les 6 boîtiers à investiguer

| Plaque | IMEI (tâche) | SIM (tâche) | Posé | Dernière trame (cet IMEI) | Position | Connexion TCP | wire_logs | Cause |
|---|---|---|---|---|---|---|---|---|
| **AL-927-QM** | `864035054756000` | +345901030605315 | 18/06 | jamais | jamais | jamais | 0 | **(c)** véhicule **ONLINE** via tracker réel `864035054757902` (pos OK) → IMEI tâche bidon |
| **HD-998-XY** | `864035054756123` | `+45901030605315` ⚠ | 19/06 | jamais | jamais | jamais | 0 | **(c)** véhicule **ONLINE** via `864035054756383` → IMEI tâche faux **+ SIM malformée** |
| **HD-584-BF** | `864035054756277` | +345901030621099 | 18/06 | jamais | jamais | jamais | 0 | **(c)** véhicule **ONLINE** via `864035054756227` → IMEI tâche faux (typo `6277`↔`6227`) |
| **FY-038-TS** | `864035054756433` | +345901030605305 | 25/06 | jamais | jamais | jamais | 0 | **(a)** IMEI plausible = tracker réel, **jamais connecté** → SIM/APN/alim/pose (terrain) |
| **GT-493-KS** | `864035054750000` ⚠ | `+345901030600000` ⚠ | 25/06 | jamais | jamais | jamais | 0 | **(a / placeholder)** IMEI **bidon** (`…0000`) + SIM bidon → provisioning incomplet, IMEI réel à saisir |
| **HD-443-QY** | `123456789012345` ⚠ | +33600000001 | 23/06 | jamais | jamais | jamais | 0 | **(a / placeholder)** IMEI **test** (`123…345`) → provisioning incomplet, IMEI réel à saisir |

## Classement par cause + preuve

### (c) — Faux muet : véhicule émet, IMEI de tâche erroné (3)
**AL-927-QM, HD-998-XY, HD-584-BF.** Preuve : le véhicule (par plaque) a un tracker **réel** différent, **ONLINE**, position fraîche (`lastSeen = 0 h`), et ce tracker réel apparaît dans les logs de connexion serveur. L'IMEI de la tâche, lui, a 0 wire_log et n'a jamais connecté. → **Ce ne sont PAS des boîtiers morts** : la donnée d'install est fausse. Les 2 « connus » (HD-998-XY, HD-584-BF) étaient des **fausses alertes**.

### (a) — Vrai muet, IMEI plausible (1)
**FY-038-TS** (`864035054756433`). L'IMEI de la tâche = le tracker du véhicule, mais 0 trame, 0 wire_log, jamais de connexion TCP. → boîtier réel qui n'atteint pas le serveur : **SIM data / APN / alimentation / pose**. Non réparable à distance (sauf renvoi config APN par SMS si la SIM répond).

### Placeholder — provisioning incomplet (2)
**GT-493-KS** (`…750000`) et **HD-443-QY** (`123456789012345`). IMEI manifestement bidon (ronds / suite 1-2-3…) → l'IMEI réel du boîtier posé **n'a jamais été saisi**. → récupérer l'IMEI réel (étiquette boîtier / SMS `imei<pass>`) puis corriger ; vérifier que le boîtier est bien posé.

## Remédiation proposée (Phase 2 — NON appliquée, sur GO boîtier par boîtier)
- **(c)** AL-927-QM, HD-998-XY, HD-584-BF → **fix data** : corriger l'IMEI (et la SIM pour le 998-XY) de la tâche d'install pour pointer le tracker réel. Aucun travail terrain (le véhicule émet déjà). Diff montré avant toute écriture.
- **(a)** FY-038-TS → **terrain** : vérifier SIM data + APN + alim/antenne du boîtier `…6433`. Option : renvoyer la config APN par SMS (sur GO explicite).
- **placeholder** GT-493-KS, HD-443-QY → **récupérer l'IMEI réel** sur le terrain, puis corriger le tracker (fix data, diff montré). Confirmer la pose physique.

## Impact réconciliation « posés »
Le plan affiche **28 Posées**. En réalité :
- **25 émettent vraiment** (22 propres + 3 « (c) » dont l'IMEI de tâche est faux mais le véhicule marche).
- **3 n'émettent pas** : 1 vrai muet terrain (FY-038-TS) + 2 placeholders à compléter (GT-493-KS, HD-443-QY).

→ Le compte « posés qui remontent » réel = **25 / 28**. Les 3 restants : 1 terrain + 2 saisies à finir.

## Phase 2 — Suivi des corrections (2026-06-26, sur GO utilisateur)

Vérité terrain confirmée par l'utilisateur : **038** = SIM HS · **493** = IMEI inconnu (boîtier posé) · **443** = boîtier absent.

### A — Fausses alertes (c) : tâche corrigée vers le tracker réel ✅ *(data, zéro terrain)*
| Plaque | Action | Preuve (relue après écriture) |
|---|---|---|
| AL-927-QM | imei `…756000`→`864035054757902`, trackerId→réel | task `DONE`, imei `…757902`, véhicule **ONLINE** |
| HD-998-XY | imei→`864035054756383`, SIM `+45901…`→`+345901030621097`, note effacée | task `DONE`, imei `…756383`, véhicule **ONLINE** |
| HD-584-BF | imei→`864035054756227`, note effacée | task `DONE`, imei `…756227`, véhicule **ONLINE** |

→ ces 3 véhicules **émettaient déjà** ; le planning est désormais exact. **Résolu.**

### B — Vrais problèmes terrain (en attente d'intervention sur place)
| Plaque | Cause | Action data faite | Reste (terrain) |
|---|---|---|---|
| FY-038-TS | SIM ne répond pas | note posée, reste `DONE` | reprendre la SIM sur place |
| GT-493-KS | IMEI réel inconnu (boîtier posé) | note posée, placeholder gardé | user ajoute la SIM ; **capture IMEI armée** — dès que le boîtier tape le serveur, l'IMEI sort en « Unknown IMEI » et est récupéré (0 trame pour l'instant) |
| HD-443-QY | boîtier manquant | statut `DONE`→**`PENDING`** (À poser) + note | poser le boîtier sur place |

### C — Nettoyage trackers fantômes ✅
3 trackers fantômes supprimés (`…756123` + `…756277` orphelins + `123…345` du 443). Vérif : **0 fantôme restant**. (Note : `HD-443-QY` garde un `imei` placeholder `123…345` dans la tâche `PENDING` — sera remplacé à la pose.)

## Réconciliation finale « posés »
- **Avant** : 28 « Posées » annoncées (dont 3 fausses alertes + 3 vrais problèmes).
- **Après** : **27 Posées** (HD-443 repassé À poser), dont **25 émettent vraiment** + **2 à reprendre** (FY-038 SIM, GT-493 IMEI), **+ 1 à poser** (HD-443).
- Compte fiable : **25 / 27 posés remontent**. Les 3 restants sont des chantiers terrain identifiés, pas des mystères.

## Statut
Phase 2 **data terminée** (A + C résolus, planning aligné, fantômes purgés).

### Mise à jour 2026-06-27 — GT-493-KS RÉSOLU ✅
Utilisateur a connecté le boîtier → son **vrai IMEI `864035054758058`** a tapé le serveur (« Unknown IMEI », 8 trames, wire_logs) → **capturé** puis **enregistré** sur le tracker GT-493-KS (placeholder `…750000` remplacé, tâche mise à jour). **Preuve** : `Tracker connected: 864035054758058`, **status ONLINE**, `lastSeen=1s`, **position OK** → il est passé en GPRS, **le repli SMS s'arrête**. (N° de SIM à confirmer — n'empêche pas le GPRS.)

Restent **2 chantiers terrain** : **FY-038-TS** (SIM HS, à reprendre sur place) · **HD-443-QY** (boîtier à poser).

**Réconciliation à jour : 26 / 27 posés remontent réellement** — 1 à reprendre (FY-038) + 1 à poser (HD-443).
