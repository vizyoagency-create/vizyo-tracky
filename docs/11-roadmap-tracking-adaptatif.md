# 11 — Roadmap tracking adaptatif (energie / cout / scalabilite)

> **Statut :** ✅ Livre — Sprints H1-H4 implementes le 2026-04-26 (branche `worktree-tracking-adaptatif`).
> **Perimetre :** strategie technique pour adapter dynamiquement la frequence de remontee et de diffusion des positions GPS, en fonction du contexte d'usage (utilisateur actif/inactif, vehicule en mouvement/arret, foreground/background mobile). Objectif : reduire conso energie boitier + reduire volume de donnees + tenir l'echelle a 30+ vehicules sans degrader l'UX live.
> **Source :** demande utilisateur 2026-04-26 — optimisation tracking adaptatif.
> **Pre-requis :** chantiers `10-roadmap-correctifs-urgents.md` (hydratation, refonte carte, lissage trace, correctifs rapports) en cours d'implementation.

> **Validation pre-merge requise :**
> - Tester sur banc 403D reel (transitions ignition + cut/restore non regressees, fix mode adaptatif observe)
> - Verifier le seed du SYSTEM_USER (00000000-0000-0000-0000-000000000000) en base de prod sinon les commandes systeme echouent.
> - Migrer la prod via `prisma migrate deploy` (2 migrations : H1 sampling + H3 fix mode).

---

## 0. Synthese executive

### 0.1 Mythe a corriger en premier — la frequence reelle

> **Hypothese de depart de la demande :** "la position est recuperee toutes les secondes depuis le boitier".
> **Realite mesuree dans le code :** le boitier Coban GPS-403D emet une trame **toutes les 30 secondes** (mode `fix030s***n` du protocole `gps103`, cf. [03-protocol-coban-gps403d.md §1.3](docs/03-protocol-coban-gps403d.md)). La sensation de fluidite 1 Hz vient de l'**interpolation client** ([map.component.ts](apps/web/src/app/features/map/map.component.ts) — `INTERP_DURATION_MS = 28_000`) qui anime le marqueur entre deux trames reelles.

**Consequences sur la strategie :**

- Le levier "passer de 1s a 30s" n'existe pas — il est deja la.
- Le vrai gain energie/data se situe sur trois autres axes :
  1. **Boitier** : passer de 30s a 60-120s quand le vehicule est a l'arret (commande Coban `fix120s***n`).
  2. **Serveur** : ne pas persister chaque trame quand la position n'a pas bouge (sampling adaptatif DB).
  3. **Client** : couper la pression UI/WS quand la page n'est pas visible (Page Visibility API).
- Le levier "polling -> push" n'existe pas non plus — Tracky pousse deja en Socket.IO ([realtime.gateway.ts](apps/api/src/realtime/realtime.gateway.ts)).

### 0.2 Tableau des chantiers

| # | Chantier | Couche | Severite | Statut | Commit |
| - | --- | --- | --- | --- | --- |
| 1 | Detection visibilite + pause UI | Frontend | 🟠 Eleve | ✅ Livre | `feat(sprint-h2)` |
| 2 | Sampling adaptatif serveur (dedup immobilite) + vue admin stats | Backend + UI | 🔴 Critique | ✅ Livre | `feat(sprint-h1)` |
| 3 | Pilotage frequence boitier + centre d'alertes admin (timeline & contexte debug) | Boitier + Backend + UI | 🟠 Eleve | ✅ Livre | `feat(sprint-h3)` |
| 4 | Compression historique (Douglas-Peucker reuse + retention 90j) | Backend | 🟢 Moyen | ✅ Livre | `feat(sprint-h4)` |
| 5 | Batch coalescing WebSocket | Backend | 🟢 Moyen | ✅ Livre | `feat(sprint-h1)` |

**Total estime (MVP complet) :** ~48h (~6 jours dev). Ordre recommande : 2 → 1 → 3 → 5 → 4.

> **Decisions actees (cf. §13) :** sampling adaptatif **actif par defaut** (UX-first, opt-out par fleet) ; hard-cap fix mode **300s en arret** ; retention `Position` brute **90 jours** ; epsilon Douglas-Peucker **5m** ; WebSocket **maintenu** onglet cache (zero delai au retour).

### 0.3 Legende statut

- ✅ Fait
- 🚧 En cours
- 📋 Planifie
- 💭 Backlog
- ❌ Hors scope

---

## 1. Audit de l'architecture actuelle

### 1.1 Schema du flux temps reel

```
[Coban-403D]                [TCP server]               [Postgres]            [Socket.IO]              [Angular]
   |  fix030s                  |                           |                     |                         |
   |--- trame position ------->| ingest()                  |                     |                         |
   |   (toutes les 30s)        |--- INSERT Position ------>|                     |                         |
   |                           |--- UPDATE Tracker.last -->|                     |                         |
   |                           |--- broadcastPosition() -------------------->| emit POSITION_UPDATE        |
   |                           |                           |                     |--- WS frame ----------->| signal positions
   |                           |                           |                     |                         | interp 28s
```

### 1.2 Constats

| Couche | Fichier | Constat | Levier |
| --- | --- | --- | --- |
| Boitier | (firmware Coban) | `fix030s***n` fixe, valable mouvement ET arret | **Adapter selon ACC** |
| TCP ingest | [positions.service.ts](apps/api/src/positions/positions.service.ts) | `ingest()` ecrit **toutes** les positions valides en DB, sans dedup | **Sampling immobilite** |
| TCP ingest | (idem) | Broadcast WS systematique, pas de batch | **Coalescing 1-2s** |
| WS gateway | [realtime.gateway.ts](apps/api/src/realtime/realtime.gateway.ts) | Push immediat fleet-room, pas de filtrage par presence client | **Filtrage room vide** |
| Frontend | [realtime.service.ts](apps/web/src/app/core/services/realtime.service.ts) | Pas de detection `visibilitychange`, signal continue de tourner onglet cache | **Page Visibility API** |
| Frontend | [map.component.ts](apps/web/src/app/features/map/map.component.ts) | Interpolation RAF (`requestAnimationFrame`) tourne meme onglet cache | **Pause RAF + interp** |
| DB | [schema.prisma](apps/api/prisma/schema.prisma) | Table `Position` append-only, aucune retention/compression | **Compaction historique** |

### 1.3 Ce qui marche deja bien

- Push WebSocket (Socket.IO) avec rooms par fleet → multicast efficace.
- Hydratation au login via `GET /api/vehicles/snapshot` (Sprint A V1.4).
- Denormalisation `Tracker.lastLat/lastLng/lastPositionAt` → lecture O(1).
- Interpolation client 28s → fluidite visuelle a 30s natif.

**Conclusion :** la base est saine. Les chantiers sont des optimisations additives, pas une refonte.

---

## 2. Strategie a 4 niveaux

L'optimisation pertinente touche **quatre couches independantes**, chacune avec son propre cout/benefice. Une bonne implementation mixe les quatre, mais on peut les livrer separement.

| Niveau | Levier | Beneficiaire principal | Risque |
| --- | --- | --- | --- |
| **Boitier** | Frequence trame GPRS adaptee au mouvement | Energie batterie + cout SIM data | Latence si parametre mal calibre |
| **Serveur** | Sampling DB + batch broadcast | Cout stockage + cout CPU + scalabilite | Perte de granularite historique si trop agressif |
| **Transport** | Filtrage room + coalescing WS | Cout bande passante + CPU client | Non-determinisme dans l'ordre des events |
| **Client** | Visibility + throttle UI | Energie device user + UX onglet inactif | Etat stale a la reactivation (mitigable par re-hydratation) |

Le **niveau boitier** est le seul qui touche directement la consommation electrique. Les trois autres reduisent **uniquement** le cout serveur/client/data.

---

## 3. Chantier 1 — Detection visibilite + pause UI cliente

### 3.1 Probleme

Quand l'utilisateur change d'onglet ou minimise la fenetre, l'application Angular continue a :

- recevoir les events `POSITION_UPDATE` via Socket.IO,
- mettre a jour les signals (`positions`, `trackerStatus`),
- faire tourner les boucles `requestAnimationFrame` de l'interpolation marker (`map.component.ts`),
- redessiner les markers MapLibre invisibles.

Sur un poste de supervision laisse ouvert toute la journee (cas reel client flotte), c'est du CPU et de la batterie pour rien.

### 3.2 Solution proposee

#### A. Page Visibility API + signal `isVisible`

Nouveau service `visibility.service.ts` :

```typescript
@Injectable({ providedIn: 'root' })
export class VisibilityService {
  readonly isVisible = signal(document.visibilityState === 'visible');
  readonly isUserActive = signal(true); // mouse/keyboard < 5min

  constructor() {
    document.addEventListener('visibilitychange', () => {
      this.isVisible.set(document.visibilityState === 'visible');
    });
    // user activity tracking (mousemove/keypress debounced)
    // ...
  }
}
```

#### B. Pause de l'interpolation RAF

Dans [map.component.ts](apps/web/src/app/features/map/map.component.ts), guard la boucle d'interp :

```typescript
private interpTick = (now: number) => {
  if (!this.visibility.isVisible()) {
    // skip frame, planifier reveil sur visibilitychange
    return;
  }
  // ... interpolation existante
  requestAnimationFrame(this.interpTick);
};
```

`requestAnimationFrame` est deja throttle a ~1 fps par les navigateurs sur onglet cache, mais on coupe completement pour eviter le travail de calcul.

#### C. Down-graded WebSocket en arriere-plan

Apres **5 minutes** d'inactivite onglet :

- emettre cote client un event `client:idle` que le serveur peut utiliser pour reduire la frequence de broadcast vers ce socket (cf. chantier 5),
- conserver la connexion WS (reconnexion = re-hydratation onereuse),
- **ne pas** desabonner de la room (sinon perte d'evenements critiques type `ALERT_NEW`).

#### D. Re-hydratation au retour

A la transition `hidden -> visible` apres > 60s, appeler `realtime.service.hydrate()` pour rattraper l'etat (snapshot bulk REST + replay du dernier `POSITION_UPDATE` par tracker).

### 3.3 Effort

| Tache | Estimation |
| --- | --- |
| Service `VisibilityService` + tests | 1h |
| Integration map.component.ts (pause RAF + interp) | 1h30 |
| Throttle realtime.service.ts (signaler idle) | 1h |
| Re-hydratation au focus retour | 1h30 |
| Tests E2E (Playwright simulant `visibilitychange`) | 1h |

**Total : ~6h.**

---

## 4. Chantier 2 — Sampling adaptatif serveur (dedup immobilite)

### 4.1 Probleme

Un vehicule a l'arret moteur coupe envoie quand meme une trame toutes les 30s (le boitier garde le GPRS ouvert pour rester joignable). Resultat :

- 1 vehicule arrete pendant 8h de nuit = **960 lignes Position** identiques en DB.
- 30 vehicules x 12h x 120 lignes/h = **43 200 inserts/jour** dont la grande majorite est redondante.
- Volume DB qui croit lineairement et n'apporte aucune information.

### 4.2 Solution proposee — sampling adaptatif a 3 etats

Dans `PositionsService.ingest()` ([positions.service.ts](apps/api/src/positions/positions.service.ts)), introduire une logique de classification + ecriture conditionnelle.

#### A. Classification de l'etat vehicule

```typescript
type VehicleState = 'MOVING' | 'IDLE_ENGINE_ON' | 'STOPPED';

function classify(prev: Tracker, frame: CobanPositionFrame): VehicleState {
  if (frame.speedKmh > 3 || haversine(prev.lastLat, prev.lastLng, frame.lat, frame.lng) > 15) {
    return 'MOVING';
  }
  if (frame.ignition === true) return 'IDLE_ENGINE_ON';
  return 'STOPPED';
}
```

#### B. Politique d'ecriture par etat

| Etat | Politique DB | Politique WS |
| --- | --- | --- |
| `MOVING` | INSERT chaque trame (30s natif Coban) | broadcast chaque trame |
| `IDLE_ENGINE_ON` | INSERT 1 trame / 90s + INSERT obligatoire sur transition | broadcast chaque trame (UI doit voir le ralenti) |
| `STOPPED` | INSERT 1 trame / 5min + INSERT obligatoire sur transition | broadcast 1 trame / 90s |

**Toujours ecrire :**
- premiere trame post-transition d'etat,
- transition `ignition` (cf. Sprint A "ignition tracking" deja livre),
- alarme/SOS (priorite max).

#### C. Mise a jour systematique de `Tracker.lastSeenAt`

Meme quand on **n'ecrit pas** dans `Position`, on update `Tracker.lastSeenAt` (et eventuellement `lastValid`) pour conserver la traçabilite "le boitier est en vie".

> **Distinction critique :** `lastSeenAt` = dernier contact TCP (heartbeat ou trame), `lastPositionAt` = derniere position effectivement persistee. Cette distinction existe deja en V1.4.

#### D. Configuration via env / feature flag

```env
TRACKING_SAMPLING_ENABLED=true       # actif par defaut, UX-first
TRACKING_IDLE_INTERVAL_MS=90000
TRACKING_STOPPED_INTERVAL_MS=300000
TRACKING_DEDUP_RADIUS_M=15
```

> **Decision actee :** sampling **actif par defaut** sur toutes les fleets (existantes et nouvelles), avec **opt-out par fleet** via flag `Fleet.adaptiveSamplingEnabled = false` pour les contrats imposant un tracage continu (transport reglemente). Les politiques DB/WS du tableau §4.2-B sont calibrees pour que **l'utilisateur final ne voie aucune difference** sur la carte live (broadcast WS conserve en mouvement, interpolation 28s lisse les arrets).

#### E. Vue admin — statistiques de sampling par tracker

**Requis** pour qu'un admin puisse auditer l'efficacite du sampling et reperer les anomalies (boitier qui spam des positions identiques, sampling trop agressif sur un tracker specifique, etc.).

Nouvelle page admin `/admin/trackers/:id/sampling` :

- **KPIs en tete :** ratio `positions_persisted / positions_received` sur 24h / 7j / 30j, gain DB total estime (lignes economisees).
- **Histogramme** des decisions `INSERT` vs `SKIP` par heure sur 7j (visualiser les phases mouvement/arret/idle).
- **Liste des skips recents** (50 dernieres decisions) avec : timestamp, etat detecte (`MOVING`/`IDLE`/`STOPPED`), distance haversine vs derniere position, raison du skip.
- **Toggle override** : "Activer le mode verbose pour ce tracker (24h)" → desactive le sampling temporairement pour debugging.

**Source de donnees :** etendre `PositionsService.ingest()` pour logger les decisions dans une table `PositionSamplingDecision` (rolling window 7j, purge auto au-dela) :

```prisma
model PositionSamplingDecision {
  id          String   @id @default(uuid())
  trackerId   String
  decision    String   // 'INSERTED' | 'SKIPPED_DUP' | 'SKIPPED_THROTTLE'
  state       String   // 'MOVING' | 'IDLE_ENGINE_ON' | 'STOPPED'
  reason      String?  // ex: "haversine 3m < 15m radius"
  receivedAt  DateTime @default(now())
  @@index([trackerId, receivedAt])
}
```

**Cout DB :** ~2x volume de la version "sans sampling" sur 7j, mais purge auto + retention courte → impact marginal.

### 4.3 Risques et mitigation

| Risque | Mitigation |
| --- | --- |
| Perte de trace si vehicule "danse" autour d'un point (GPS jitter) | Filtre haversine 15m + classification basee `speedKmh` |
| Replay incomplet de la nuit | Toujours INSERT sur transition d'etat → 1 point de debut + 1 point de fin garantis |
| Reglementation transport (obligation de tracage continu) | Feature flag desactivable + mode "verbose" par fleet |

### 4.4 Effort

| Tache | Estimation |
| --- | --- |
| Helper `classify()` + tests unitaires | 1h |
| Refactor `ingest()` avec sampling | 2h |
| Migration `Tracker` (champ `lastWriteAt`) + table `PositionSamplingDecision` | 1h |
| Feature flag fleet (`adaptiveSamplingEnabled`) + config env | 1h |
| Metriques Prometheus (counter inserts skipped) | 1h |
| Tests E2E (simuler 30 trames identiques → 1 INSERT attendu) | 2h |
| **Vue admin `/admin/trackers/:id/sampling`** (KPIs + histogramme + skip list + toggle verbose) | 2h |
| Doc operateur (mode verbose, opt-out par fleet) | 1h |
| Validation sur banc avec vrai boitier | 1h |

**Total : ~12h.**

---

## 5. Chantier 3 — Pilotage frequence boitier (mode mouvement / arret)

### 5.1 Probleme

Le seul levier qui reduit reellement la **consommation electrique** du boitier (et donc l'usure batterie + le cout data SIM) est de **changer la frequence de fix GPS / GPRS** cote firmware.

Le protocole Coban `gps103` permet d'envoyer la commande `fix<NNN>s***n<password>` pour changer la frequence (cf. [03-protocol-coban-gps403d.md §1.3](docs/03-protocol-coban-gps403d.md)). Cette commande peut etre envoyee :

- par SMS (cf. `07-sms-gateway.md`),
- par GPRS via la socket TCP deja ouverte (canal descendant — cf. [tcp-server.service.ts](apps/api/src/tracker-tcp/tcp-server.service.ts) qui maintient deja `imei -> socket`).

### 5.2 Solution proposee

#### A. Etat cible par tracker

Ajouter sur `Tracker` :

```prisma
model Tracker {
  // ...
  desiredFixIntervalS  Int      @default(30)
  currentFixIntervalS  Int?     // confirmed by ack from device
  lastFixIntervalSyncAt DateTime?
}
```

#### B. Reconciliation declenchee par evenement

Au moment de la transition d'etat (calcule au chantier 2) :

| Transition | Action serveur |
| --- | --- |
| → `MOVING` | Envoyer `fix030s***n` si `currentFixIntervalS != 30` |
| → `STOPPED` (apres 10min) | Envoyer `fix120s***n` si `currentFixIntervalS != 120` |
| Reveil ignition apres > 1h | Envoyer `fix030s***n` |

L'envoi se fait via la socket GPRS deja ouverte (latence ~100ms), avec fallback SMS si la socket est tombee depuis > 5min (`Tracker.status = OFFLINE`).

#### C. Confirmation et observabilite

- Le boitier ne renvoie pas d'ack explicite a `fix...`, mais on peut **mesurer** le nouvel intervalle effectif sur les 3 prochaines trames recues et mettre a jour `currentFixIntervalS`.
- Logger les transitions dans une nouvelle table `TrackerCommandHistory` (deja prevue pour engine cut/restore — etendre le scope).
- Metric Prometheus : `tracker_fix_interval_seconds{trackerId}` pour grafana.

#### D. Garde-fous

- **Hard-cap a `fix300s` (5min) en arret prolonge** — au-dela, risque legal/SLA + risque de "perdre" un vehicule deplace en remorquage sans ignition.
- Whitelist par fleet : feature flag `Fleet.adaptiveFixEnabled` cote fleet (au cas ou un client exige le mode 30s permanent).
- Quota anti-flapping : pas plus de **2 changements de frequence par tracker / jour**.
- Si **3 commandes consecutives sans changement observe** sur les 6 trames suivantes → flag `Tracker.fixCommandFailing = true` + bandeau rouge dans la vue admin (cf. §5.2-E). **Pas de notification externe** (email/Discord/Slack) — toute l'info reste centralisee cote admin.

#### E. Vue admin — alertes, timeline & contexte de debug complet

**Decision utilisateur :** zero notification externe (pas d'email, pas de Discord, pas de Slack). **Tout doit etre centralise dans l'espace admin** avec un maximum de contexte pour comprendre et corriger.

Architecture d'observabilite admin en **trois niveaux** :

##### E.1 — Centre d'alertes global `/admin/alerts`

Page d'accueil ops qui agrege tous les trackers en etat anormal a travers toutes les fleets :

- **Compteurs en tete** : `X trackers FAILING`, `Y trackers PENDING > 10min`, `Z trackers OFFLINE > 1h`.
- **Liste triable** par severite, age, fleet, derniere action.
- **Badge non-lu** sur l'icone admin tant qu'il reste des alertes `FAILING` non acquittees.
- **Filtre rapide** : "Mes fleets" / "Toutes" / "Last 24h" / "FAILING uniquement".
- **Action en masse** : selectionner plusieurs trackers → "Marquer en quarantaine" / "Tenter retry batch" / "Acknowledger".

##### E.2 — Page detail tracker `/admin/trackers/:id/fix-mode`

**Bandeau d'etat en tete** (toujours visible) :

| Champ | Exemple | Code couleur |
| --- | --- | --- |
| Etat actuel | `FAILING — 3 commandes sans effet` | 🔴 |
| `currentFixIntervalS` (mesure reelle) | `30s` | gris |
| `desiredFixIntervalS` (cible serveur) | `120s` | gris |
| Derniere tentative | `2026-04-26 14:32:18 UTC (il y a 7 min)` | orange si > 5min |
| Derniere trame recue du boitier | `2026-04-26 14:33:02 UTC` | vert / rouge selon age |
| Statut socket TCP | `connecte depuis 02:14:08` | vert / rouge |
| Statut SIM (si chantier 3 fallback livre) | `derniere reponse SMS: 2026-04-25 09:11` | gris |

**Timeline chronologique** (90 derniers jours, paginee) :

Chaque ligne contient **TOUT** ce qui est necessaire au diagnostic, sans avoir a fouiller dans des logs :

```
┌───────────────────────────────────────────────────────────────────────┐
│ 🔴 2026-04-26 14:32:18 UTC                          FIX_MODE_CHANGE   │
│ Tentative : 30s → 120s                              Raison : STOPPED  │
│ Canal : TCP (socket #4827)                          Latence : 6 min   │
│ Resultat : ❌ FAILED (3 trames recues a 30s apres commande)            │
│                                                                       │
│ ▶ Commande envoyee :  "fix120s***n123456;"                            │
│ ▶ Trame attendue :    intervalle 120s sur 3 prochaines positions      │
│ ▶ Trame reellement recue : intervalle 30s (boitier ignore la cmd)    │
│                                                                       │
│ ▶ Contexte au moment de la commande :                                 │
│   - Vehicule : DACIA-001 (fleet "Demo Tracky")                        │
│   - Etat : STOPPED (vitesse 0 km/h, ignition OFF depuis 12 min)       │
│   - Position : 48.8566, 2.3522 (Paris 1er)                            │
│   - Signal GPS : 8 satellites, valid=true                             │
│   - Signal GPRS : derniere socket ouverte il y a 02:14                │
│                                                                       │
│ ▶ Diagnostic suggere :                                                │
│   • Firmware potentiellement bloque (3 echecs consecutifs)            │
│   • Tester redemarrage a distance via SMS "RESET123456"               │
│   • Si echec persistant > 24h → intervention physique requise         │
│                                                                       │
│ [Voir payload brut] [Tenter retry] [Mettre en quarantaine] [Acquitter]│
└───────────────────────────────────────────────────────────────────────┘
```

**Code couleur global** : vert (commande prise en compte ≤ 2 trames), orange (3-5 trames de latence), rouge (echec ou > 5 trames).

##### E.3 — Section erreurs filtrable & exportable

En bas de la page tracker :

- **Liste de toutes les commandes en echec** (`outcome = FAILED`) sur les 90 derniers jours.
- **Filtres** : type (`FIX_MODE_CHANGE`, `ENGINE_CUT`, `ENGINE_RESTORE`), canal (TCP / SMS), raison du failure.
- **Stats agreggees** : taux de reussite par mois, temps moyen de prise en compte, top 5 raisons d'echec.
- **Bouton "Exporter CSV"** : permet de partager avec un fournisseur boitier en cas d'incident recurrent.

##### E.4 — Source de donnees enrichie

Etendre la table `TrackerCommandHistory` (deja prevue pour engine cut/restore) avec :

```prisma
model TrackerCommandHistory {
  id             String   @id @default(uuid())
  trackerId      String
  type           String   // 'FIX_MODE_CHANGE' | 'ENGINE_CUT' | 'ENGINE_RESTORE'
  payloadSent    String   // ex: "fix120s***n123456;"
  expectedResult String?  // description textuelle de ce qui est attendu
  observedResult String?  // description de ce qui s'est reellement passe
  channel        String   // 'TCP' | 'SMS'
  outcome        String   // 'PENDING' | 'CONFIRMED' | 'FAILED'
  reason         String?  // 'MOVING_TRANSITION' | 'STOPPED_TRANSITION' | 'MANUAL_OPERATOR' | 'RETRY_AFTER_FAILURE'
  contextSnapshot Json    // snapshot complet au moment de la commande (position, signal, etc.)
  diagnosticHint String?  // suggestion automatique de prochaine action
  acknowledgedBy String?  // userId qui a acquitte
  acknowledgedAt DateTime?
  createdAt      DateTime @default(now())
  resolvedAt     DateTime?
  @@index([trackerId, createdAt])
  @@index([outcome, createdAt])
}
```

Le champ `contextSnapshot` (JSON) est la cle de l'auditabilite : on capture l'etat complet au moment de la commande pour qu'un admin puisse comprendre **plus tard**, sans avoir besoin de logs externes.

**Pas de Prometheus / Grafana** dans ce chantier (peut etre rajoute plus tard si vraiment besoin) — toute l'observabilite passe par l'admin UI.

### 5.3 Effort

| Tache | Estimation |
| --- | --- |
| Migration `Tracker` (champs desired/current/syncAt + fixCommandFailing) | 1h |
| Migration `TrackerCommandHistory` (enrichie avec `contextSnapshot`, `diagnosticHint`, `acknowledged*`) | 1h |
| Service `TrackerFixModeService` + reconciliation + capture `contextSnapshot` | 3h30 |
| Wiring sur transitions etat (chantier 2) | 1h |
| Fallback SMS si socket offline (depend de `07-sms-gateway`) | 2h |
| Anti-flapping + feature flag fleet | 1h |
| **Vue admin `/admin/alerts`** (centre d'alertes global, badge non-lu, actions en masse) | 2h |
| **Vue admin `/admin/trackers/:id/fix-mode`** (bandeau + timeline detaillee + section erreurs + export CSV) | 3h30 |
| Generation automatique des `diagnosticHint` (regles simples) | 1h |
| Tests E2E avec banc 403D reel | 2h |

**Total : ~18h** (depend du status de `07-sms-gateway.md` — si gateway non livree, sauter le fallback SMS et compter 16h).

---

## 6. Chantier 4 — Compression historique (Douglas-Peucker offline)

### 6.1 Probleme

Le user a explicitement mentionne **Douglas-Peucker** pour simplifier les traces. C'est pertinent pour les **replays/rapports historiques** (un trip de 2h en ville = ~240 points, mais un trace visuellement equivalent peut tenir en 30-50 points). Le sampling adaptatif (chantier 2) reduit deja l'ecriture, ce chantier reduit la **taille a la lecture** pour les requetes range > 24h.

**Rappel pedagogique — Douglas-Peucker en 2 phrases :** algorithme classique de simplification de polylignes. On garde les sommets les plus "significatifs" (ceux qui font tourner la trace au-dela d'une tolerance `epsilon` en metres) et on jette les points quasi-alignes intermediaires. **Decision actee : `epsilon = 5m`** — assez fin pour preserver la trace en zone urbaine (rues etroites, virages serres) sans sur-simplifier.

### 6.2 Solution proposee — table miroir compactee

#### A. Conserver `Position` brut (rétention 30j)

- Trace ultra-fine, source de verite, retention courte (30j configurable).
- Job de purge nocturne (`@nestjs/schedule`).

#### B. Nouvelle table `PositionCompact`

Apres clôture d'un trip (cf. trip segmentation existante dans `positions.service.ts`), executer Douglas-Peucker (epsilon = 5m) sur les points du trip et persister dans :

```prisma
model PositionCompact {
  id          String   @id @default(uuid())
  trackerId   String
  tripId      String?
  lat         Float
  lng         Float
  timestamp   DateTime
  speedKmh    Float?
  // pas de heading/altitude/satellites — economie
  @@index([trackerId, timestamp])
  @@index([tripId])
}
```

#### C. API de lecture historique

`GET /api/positions/history?trackerId=...&from=...&to=...&detail=auto|fine|compact`

- `detail=auto` (defaut) : choisit `Position` si range < 24h, sinon `PositionCompact`.
- `detail=fine` : force `Position` (audit, expertise).
- `detail=compact` : force `PositionCompact`.

#### D. Lissage pour rendu cartographique

Cote frontend, appliquer une **interpolation Catmull-Rom** sur les points compactes pour eviter l'effet "lignes droites" mentionne par le user. Implementation legere via `turf` ou maison (~30 lignes).

### 6.3 Effort

| Tache | Estimation |
| --- | --- |
| Migration Prisma `PositionCompact` | 0h30 |
| Helper Douglas-Peucker (lib `simplify-js` ou maison) | 1h |
| Hook trip-close → compact insert | 1h30 |
| API `/positions/history?detail=...` | 1h30 |
| Job purge nocturne `Position` > 30j | 1h |
| Catmull-Rom rendering frontend | 1h30 |
| Tests | 1h |

**Total : ~8h.**

---

## 7. Chantier 5 — Batch coalescing WebSocket

### 7.1 Probleme

A 30+ vehicules actifs simultanes, le serveur emet 30+ events `POSITION_UPDATE` toutes les ~30s en rafale (les boitiers ne sont pas synchronises mais la distribution est dense). Chaque event = 1 frame WS = 1 cycle parse/render cote client.

### 7.2 Solution proposee

#### A. Coalescing par fenetre 1s cote gateway

Buffer interne `Map<fleetId, PositionUpdateEvent[]>` flush toutes les 1000ms :

```typescript
@Injectable()
export class PositionBroadcastBuffer {
  private buffer = new Map<string, PositionUpdateEvent[]>();
  
  enqueue(fleetId: string, evt: PositionUpdateEvent) {
    const list = this.buffer.get(fleetId) ?? [];
    // dedup par trackerId : on garde le dernier
    const idx = list.findIndex(e => e.trackerId === evt.trackerId);
    if (idx >= 0) list[idx] = evt; else list.push(evt);
    this.buffer.set(fleetId, list);
  }
  
  @Interval(1000)
  flush() {
    for (const [fleetId, events] of this.buffer) {
      this.gateway.server.to(`fleet:${fleetId}`).emit('POSITIONS_BATCH', events);
      this.buffer.delete(fleetId);
    }
  }
}
```

#### B. Compatibilite client

- Ajouter un listener `POSITIONS_BATCH` cote frontend (signal update en une seule pass).
- Conserver `POSITION_UPDATE` pour les **alarmes prioritaires** (envoi immediat, pas de buffer).

#### C. Filtrage room vide

Avant de buffer/emit, verifier `gateway.server.sockets.adapter.rooms.get('fleet:' + fleetId)?.size > 0`. Si la room est vide (aucun client connecte pour cette flotte), ne meme pas serialiser l'event.

### 7.3 Effort

| Tache | Estimation |
| --- | --- |
| Service buffer + flush interval | 1h30 |
| Listener `POSITIONS_BATCH` cote Angular | 1h |
| Filtrage room vide | 0h30 |
| Tests load (artillery 30 vehicules x 5 clients) | 1h |

**Total : ~4h.**

---

## 8. Metriques et criteres de succes

A instrumenter avant les chantiers (pour avoir le baseline) et apres (pour valider le gain) :

| Metrique | Source | Avant cible | Apres cible |
| --- | --- | --- | --- |
| `position_inserts_total` | Prometheus / Postgres | ~120/h/tracker | < 30/h/tracker arrete |
| `tracker_gprs_bytes_per_day` | calcule via SIM provider | ~5 MB/j/tracker | < 2 MB/j/tracker arrete |
| `ws_messages_per_second` | Socket.IO admin UI | ~1/s a 30 vehicules | < 0.3/s avec coalescing |
| `client_cpu_pct_idle_tab` | Lighthouse / mesure manuelle | ~5-10% | < 1% |
| `db_size_position_table` | `pg_total_relation_size` | croissance lineaire | -60-80% en regime |
| `time_to_first_marker_after_login` | telemetrie front | < 1s (deja livre Sprint A) | maintenu |

### 8.1 Dashboards Grafana a etendre

Ajouter au dashboard existant (cf. `08-logging-and-observability.md`) :

- panel "Sampling efficiency" : `(positions_persisted / positions_received)` par tracker.
- panel "Fix mode" : repartition `currentFixIntervalS` (30 / 90 / 120).
- panel "Idle clients" : nombre de clients en etat `client:idle`.

---

## 9. Points de vigilance

### 9.1 Reglementaire et SLA

- Certains contrats flotte (transport de marchandises sensibles, taxi reglementé) imposent un **tracage continu**. Decision retenue : sampling adaptatif **actif par defaut** (UX-first, le client final ne ressent rien), **opt-out par fleet** via `Fleet.adaptiveSamplingEnabled = false` lors de l'onboarding ou plus tard.
- Conserver les **trames brutes** (table `Position`) pendant **90 jours** meme avec compression — exigence forensique en cas de sinistre/litige + audit qualite. Au-dela, `PositionCompact` (chantier 4) prend le relais sans perte visuelle significative.

### 9.2 Determinisme et tests

- Le sampling rend l'ingestion non-deterministe (depend de `Tracker.lastWriteAt`). Tests unitaires : mock `Date.now()` et figer `lastWriteAt`.
- Tests E2E avec banc 403D : **pas de regression** sur les transitions ignition + cut/restore (deja livres Sprint G).

### 9.3 Risque de derive d'horloge

- Le boitier Coban a une horloge potentiellement decalee de plusieurs minutes. Le sampling base sur `frame.deviceTime` peut donner des intervalles errones si l'horloge derive. **Decision :** baser le throttle sur `serverReceivedAt`, pas `deviceTime`.

### 9.4 Perte de granularite acceptable ?

Question a poser au product owner avant de merger le chantier 4 :

> "Pour un trip de 2h en ville, est-il acceptable que le replay historique > 30j n'ait que 30-50 points (au lieu de 240) avec une trace lissée Catmull-Rom ?"

Si non → desactiver le chantier 4 et augmenter la retention `Position` brute.

### 9.5 Reconciliation fix interval

Le boitier ne confirme pas la prise en compte de `fix120s`. On infere depuis l'intervalle reel des 3 prochaines trames. Si **2 commandes envoyees consecutives sans changement observe** → flag `Tracker.fixCommandFailing = true` + alerte ops (la SIM data ou le firmware peut etre HS).

---

## 10. Roadmap d'execution recommandee

### Phase 1 — Quick wins serveur (Sprint H1, ~16h)

- Chantier **2** (sampling adaptatif + vue admin stats) en premier : gain immediat sur DB et CPU + observabilite des le jour 1.
- Chantier **5** (batch coalescing) : peu de risque, gros benefice a 30+ vehicules.

**Livrable :** `feat/sprint-h1-sampling-adaptatif` + metriques baseline / apres + page admin `/admin/trackers/:id/sampling`.

### Phase 2 — Optimisation client (Sprint H2, ~6h)

- Chantier **1** (visibility + pause UI + maintien WS au cache).
- Validation sur poste de supervision laisse 8h (mesure conso CPU avec/sans).

**Livrable :** `feat/sprint-h2-visibility-throttle`.

### Phase 3 — Pilotage boitier (Sprint H3, ~18h)

- Chantier **3** (fix mode adaptatif + centre d'alertes admin + timeline contexte debug) : depend de la stabilisation Sprint H1 (transitions etat).
- Tests intensifs sur banc reel **avant** rollout fleet par fleet.
- Rollout par phases : 1 fleet pilote pendant 1 semaine → toutes les fleets si pas d'erreurs `FAILING`.

**Livrable :** `feat/sprint-h3-adaptive-fix-mode` + page admin `/admin/alerts` (centre global) + page admin `/admin/trackers/:id/fix-mode` (timeline + contexte). Aucune dependance externe (zero email/Discord/Slack).

### Phase 4 — Historique compact (Sprint H4, ~8h)

- Chantier **4** (Douglas-Peucker epsilon=5m + Catmull-Rom).
- Pas de validation produit specifique — la decision `epsilon=5m` preserve la fidelite urbaine.

**Livrable :** `feat/sprint-h4-history-compaction`.

---

## 11. Hors scope explicite

- **Migration vers SSE** au lieu de WebSocket : Socket.IO marche bien, gere deja le fallback polling, pas de raison de re-architecturer.
- **Tracking IA / predictif** (predire la prochaine position pour reduire la frequence d'echange) : interessant en R&D mais nul ROI court terme.
- **Compression binaire MQTT** entre boitier et serveur : impossible — le boitier est figé sur le protocole `gps103` ASCII (firmware Coban non modifiable).
- **Edge computing sur le boitier** (filtrer cote firmware avant envoi) : impossible pour la meme raison.

---

## 12. References

- [03-protocol-coban-gps403d.md](docs/03-protocol-coban-gps403d.md) — protocole `gps103`, commandes `fix...`, modes `tracker`/`monitor`.
- [04-roadmap.md](docs/04-roadmap.md) — roadmap principale V1.3.
- [09-roadmap-v2.md](docs/09-roadmap-v2.md) — backlog V2 (SMS gateway prerequis du chantier 3).
- [10-roadmap-correctifs-urgents.md](docs/10-roadmap-correctifs-urgents.md) — chantiers UX prerequis (hydratation V1.4 indispensable au chantier 1).
- [08-logging-and-observability.md](docs/08-logging-and-observability.md) — patterns metriques + dashboards Grafana.
- [06-tcp-commands-console.md](docs/06-tcp-commands-console.md) — console d'envoi de commandes TCP descendantes (utile pour piloter `fix...`).

---

## 13. Decisions actees (2026-04-26)

| # | Question | Decision | Justification |
| - | --- | --- | --- |
| 1 | Sampling adaptatif par defaut ? | ✅ **Actif par defaut** (UX-first, opt-out par fleet via `Fleet.adaptiveSamplingEnabled`) | Le client final ne ressent aucune difference (broadcast WS conserve en mouvement, interp 28s lisse les arrets). Cote serveur on optimise stockage et compute. |
| 2 | Hard-cap fix mode en arret prolonge ? | ✅ **300s (5min)** + centre d'alertes admin avec timeline + contexte de debug complet (zero notif externe) | Optimisation maximale conso/data sans depasser le seuil legal. Toute la visibilite est centralisee dans l'admin avec snapshot contextuel par commande pour faciliter le diagnostic. |
| 3 | Retention `Position` brute ? | ✅ **90 jours** | Couvre les besoins forensiques (litiges, audits) sans exploser le stockage. Au-dela : `PositionCompact` prend le relais. |
| 4 | Epsilon Douglas-Peucker ? | ✅ **5 metres** | Preserve la fidelite en zone urbaine (rues etroites, virages serres). Visuellement indistinguable de la trace brute. |
| 5 | Comportement WebSocket onglet cache > 30min ? | ✅ **Maintenir la connexion** | UX-first : zero delai au retour de l'onglet. Le chantier 1 minimise deja la pression a quasi zero. |

**Toutes les decisions etant prises, le Sprint H1 peut demarrer.** Les choix sont conservateurs cote UX (point 1, 5) et agressifs cote optimisation cout (point 2) — c'est le bon equilibre pour cette phase de croissance.

### 13.1 Pre-requis avant Sprint H1

- [ ] Confirmer que `Fleet` peut accueillir une nouvelle colonne `adaptiveSamplingEnabled: boolean @default(true)` (migration triviale).
- [ ] Verifier que `TrackerCommandHistory` (planifie pour cut/restore) sera bien livree avant ou pendant Sprint H3 — sinon ajouter la table dans le scope H3.
- [x] **Canal d'alerting `FAILING` :** acte — pas de notification externe. Tout passe par les pages admin `/admin/alerts` (centre global avec badge non-lu) et `/admin/trackers/:id/fix-mode` (timeline + contexte de debug complet).
