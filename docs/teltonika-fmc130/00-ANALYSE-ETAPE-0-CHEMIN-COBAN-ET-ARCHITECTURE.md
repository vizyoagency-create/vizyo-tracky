# Étape 0 — Analyse du chemin Coban et architecture d'accueil du Teltonika FMC130

> **Statut :** rapport d'analyse. **Aucune ligne de code produite.** En attente de validation.
> **Date :** 2026-09-27
> **Périmètre :** ajouter le support Teltonika FMB/FMC (cible FMC130) + commandes sortantes
> Codec 12 vers un adaptateur CAN-CONTROL IMMO, sans toucher au comportement Coban GPS403.

---

## 0. En un paragraphe

Le dépôt est **beaucoup mieux préparé que prévu**. Le protocole Coban est déjà isolé dans un
paquet pur et testé (`packages/shared/src/protocol/`), la notion de commande sortante existe
déjà complètement (table `tracker_commands`, file, ACK, canal TCP/SMS), le registre de sockets
accepte **déjà** des `Buffer`, et le champ `Tracker.model` est une chaîne libre qui n'alimente
aucune logique — c'est un discriminant de protocole gratuit. **Le chantier peut se faire sans
AUCUNE migration de schéma** et en ne touchant que **5 fichiers existants**, dont **un seul est
sensible** (`engine-control.service.ts`, 2 lignes d'appel). Le vrai trou n'est pas
architectural : c'est que **le point d'entrée TCP lui-même n'est presque pas testé** — et c'est
exactement là que la détection de protocole doit atterrir.

---

## 1. Où et comment le protocole Coban est implémenté aujourd'hui

### 1.1 Couche protocole — pure, sans I/O (`packages/shared/src/protocol/`)

| Fichier | Lignes | Rôle |
|---|---:|---|
| `coban.types.ts` | 111 | `CobanFrame` = union `login` \| `heartbeat` \| `position` \| `no_fix` \| `unknown` ; `CobanCommand` |
| `coban.parser.ts` | 332 | `decodeFrame(raw: string): CobanFrame` — **seul point de décodage** |
| `coban.encoder.ts` | 46 | `encodeCommand(imei, cmd): string` — **seul point d'encodage** |
| `coban.utils.ts` | 73 | `nmeaToDecimal`, `knotsToKph`, `formatFrequency` |
| `coban.catalog.ts` | 559 | 20 gabarits de commandes (métadonnées, params, `expectedAckPattern`, `availableVia`) |
| `identifiant-scanne.ts` | 108 | normalisation d'IMEI scanné |
| `index.ts` | 6 | ré-exporte tout ce qui précède |

C'est propre : **`decodeFrame` et `encodeCommand` sont des fonctions pures**, sans dépendance
Nest, sans I/O, entièrement testables. C'est le modèle exact à reproduire pour le Teltonika.

### 1.2 Point d'entrée TCP (`apps/api/src/tracker-tcp/tcp-server.service.ts`, 388 lignes)

Un unique `net.createServer` sur `TRACKER_TCP_PORT` (défaut **5023**). Par connexion :

1. `socket.on('data')` → **`buffer += chunk.toString('ascii')`** (ligne 126)
2. découpage des trames sur le premier `;`, `\r` ou `\n` (`buffer.search(/[;\r\n]/)`)
3. `decodeFrame(raw)` puis `dispatchFrame(...)`, **sérialisé par socket** via une chaîne de
   promesses (`chain`) — corrige les bursts de reconnexion
4. `dispatchFrame` par type :
   - `login` → IMEI inconnu ⇒ `unknownTrackers.record()` + `socket.end()` ; connu ⇒
     `registry.register()`, `socket.write('LOAD')`, `status: ONLINE`
   - `heartbeat` → `socket.write('ON')`
   - `position` → snapshot tracker (TRK-040) → `positions.ingest(frame)` →
     `ackWaiter.tryMatch()` → `alertsService.createFromCobanFrame()` → SOS ⇒ `**,imei:…,E;`
   - `no_fix` → `lastSeenAt` + `lastNoFixAt`, **aucune position écrite**
   - `unknown` → tentative d'ACK, sinon log
5. `close` → `handleSocketClose` → passage OFFLINE **différé de 90 s** (anti-flapping), avec
   écriture conditionnelle `updateMany + WHERE lastSeenAt < seuil` (TRK-024)

> ### ⚠️ Deux points de la ligne 126 qui commandent toute l'architecture
>
> **(a) `chunk.toString('ascii')` dans Node MASQUE LE BIT DE POIDS FORT.** `0x8E` (le Codec ID
> du Codec 8 Extended) y devient `0x0E`. Toute trame binaire qui traverse cette ligne est
> **silencieusement corrompue** — pas d'exception, pas de log, juste des octets faux.
>
> **(b) le découpage se fait sur `;` `\r` `\n`**, soit les octets `0x3B`, `0x0D`, `0x0A`, qui
> apparaissent naturellement *à l'intérieur* d'un payload Teltonika binaire (timestamps,
> coordonnées, valeurs CAN).
>
> Conséquence : la détection de protocole **doit** se faire sur le `Buffer` brut du premier
> événement `data`, **avant** toute conversion en chaîne. Et le chemin Teltonika doit rester
> en `Buffer` de bout en bout. C'est le risque technique n° 1 du chantier.

### 1.3 Persistance et consommateurs

- `positions.service.ts` → `async ingest(frame: CobanPositionFrame)` : vie privée, sampling
  adaptatif, anti-replay, trajets, géofences, WS, dénormalisation `Tracker.last*`
- `alerts.service.ts` → `createFromCobanFrame(frame, tracker)` : mapping alarme → `Alert`
- `observability/coban-wire-logger.service.ts` → journal `wire_logs` (IN/OUT), sous drapeau
  `WIRE_LOG_ENABLED`
- `unknown-trackers/unknown-trackers.registry.ts` → IMEI inconnus, en mémoire, vue admin

**Champs réellement lus par les consommateurs** (relevé exhaustif) :

| Consommateur | Champs lus |
|---|---|
| `positions.service` | `imei`, `deviceTime`, `valid`, `latitude`, `longitude`, `speedKph`, `course`, `altitude`, `ignition`, `alarm`, `batteryPercent` |
| `alerts.service` | `alarm`, `latitude`, `longitude`, `speedKph`, `course`, `ignition`, `raw` |

**Tous mappables depuis un enregistrement Codec 8 Extended.** C'est la surface de l'adaptateur
et elle est petite.

---

## 2. Couverture de tests du chemin Coban — et le trou

### 2.1 Ce qui existe, et qui est vert (mesuré aujourd'hui)

| Périmètre | Suites | Tests | Durée | État |
|---|---:|---:|---:|---|
| `packages/shared` (protocole complet) | 19 | **423** | 5,3 s | ✅ vert |
| `apps/api` — `tracker-tcp`, `socket-registry`, `tracker-commands`, `positions` | 9 | **135** | 27,2 s | ✅ vert |
| `apps/api` — `engine-control` | 2 | **166** | — | ✅ vert |

La couche pure est **bien couverte** : `coban.parser.spec.ts` compte 30 cas, dont les trames
réelles, les hémisphères S/W, le passage de minuit, les `no_fix` LBS, le 4ᵉ champ
batterie/RFID, et les trames malformées.

### 2.2 Le trou, et il est exactement au mauvais endroit

**`tcp-server.service.spec.ts` (184 lignes, 9 tests) ne teste QUE le débounce OFFLINE.**
Il construit le service et appelle `scheduleOffline`, `cancelPendingOffline`, `markOffline`,
`handleSocketClose` via `as any`.

**Ne sont couverts par AUCUN test :**

1. **`handleConnection`** — le bufferisation, le découpage des trames, la conversion ASCII,
   la sérialisation par socket. *C'est la fonction où la détection de protocole va vivre.*
2. **`dispatchFrame`** — les 5 branches (`login`, `heartbeat`, `position`, `no_fix`,
   `unknown`) : aucune assertion sur `LOAD`, sur `ON`, sur le `socket.end()` d'un IMEI
   inconnu, sur l'ACK SOS, sur les rejets d'IMEI non concordant, sur « position avant login ».
3. **Aucun test d'intégration qui ouvre réellement un port TCP.** Les 4 specs e2e
   (`depot-isolation`, `health`, `privacy-ingestion`, `retention`) ne touchent pas au
   listener. Un `faux-boitier-coban.mjs` existe (`scripts/`, 116 lignes) mais c'est un outil
   manuel, pas un test.

**Réponse à ta règle n° 5 : oui, il manque un filet, et il manque précisément là où je vais
travailler.** L'étape 1 n'est pas une formalité : sans elle, je n'ai littéralement aucun test
qui casserait si je cassais le login Coban.

---

## 3. Modèle de données

### 3.1 La chaîne

```
Fleet (tenant)  ──<  Vehicle  ──1:1──  Tracker  ──<  Position
                        │                  │
                        │                  ├──< TrackerCommand        (commandes génériques)
                        │                  ├──< EngineControlCommand  (coupe-circuit)
                        │                  └──< AudioMonitoringCommand
                        └──< Trip, Alert, Geofence, …
```

Le cloisonnement multi-tenant passe **toujours** par `Vehicle.fleetId` : un `Tracker` n'a pas
de `fleetId` propre, il l'obtient via son véhicule. Tous les contrôles d'accès suivent ce
chemin (`tracker.vehicle.fleetId !== requestedBy.fleetId` ⇒ `ForbiddenException`).

### 3.2 `Tracker` — le discriminant est déjà là, et il est gratuit

```prisma
model Tracker {
  imei    String  @unique
  model   String  @default("COBAN_GPS403D")   // ← chaîne LIBRE, pas un enum
  status  TrackerStatus @default(OFFLINE)
  ...
}
```

`model` n'est **écrit** qu'en 2 endroits (`trackers.service.ts:42`,
`installations.service.ts:346`) et n'est **lu** que pour l'affichage
(`tracker-response.dto.ts`). **Aucune logique métier ne branche dessus.** Comme c'est un
`String` et non un `enum`, y poser la valeur `TELTONIKA_FMC130` **ne demande aucune
migration** et ne peut rien changer au comportement Coban.

C'est le discriminant que je propose d'utiliser. Si tu préfères une colonne explicite
(`protocole`), elle serait additive et nullable — mais elle serait redondante.

### 3.3 `TrackerCommand` — la file de commandes existe déjà, complète

```prisma
enum TrackerCommandStatus  { PENDING SCHEDULED SENT ACKNOWLEDGED FAILED CANCELLED SENT_UNCONFIRMED }
enum TrackerCommandChannel { TCP SMS }

model TrackerCommand {
  templateId, category, params Json, payload String, channel, status,
  scheduledAt, sentAt, ackedAt, expiredAt, ackResponse, lastError,
  expectedResult, observedResult, contextSnapshot Json, diagnosticHint,
  requestedBy → User, acknowledgedBy, …
}
```

**C'est exactement l'étape 5 de ton déroulé, déjà en base.** États, timeouts, corrélation
d'ACK, journalisation « qui / quand / quel véhicule / réponse du boîtier », clôture par
échéance (`SENT_UNCONFIRMED`, TRK-062). `payload` est un `String` : une trame Codec 12 y
tiendra **en hexadécimal**, sans migration.

Et `WireLog` (`imei`, `direction`, `raw`, `frameType`, `commandId`, `context`) donne déjà le
journal de fil.

---

## 4. Ce qui est générique et réutilisable / ce qui est couplé au Coban

### ✅ Déjà générique — réutilisable tel quel, zéro modification

| Élément | Pourquoi ça marche pour le Teltonika |
|---|---|
| `SocketRegistryService` | `send(imei, payload: string \| Buffer)` — **accepte déjà les Buffer**. Indexé par IMEI, agnostique du protocole. Émet `tracker.connected`. |
| `AckWaiterService` | Attente d'ACK par IMEI, avec priorités et timeout. La réponse Codec 12 type `0x06` porte du **texte ASCII** : il suffit de lui passer cette chaîne. |
| `TrackerCommand` + `WireLog` | Voir § 3.3. |
| `UnknownTrackerRegistry` | Aucune hypothèse de protocole. |
| Garde « boîtier muet » (72 h), throttling, garde tenant | Lisent `lastSeenAt` et `vehicle.fleetId`. |
| `DemoReplayService` | Pose de **faux sockets** dans le registre — précédent utile pour l'étape 7. |

### 🔴 Couplé au Coban — à ne PAS traverser

| Élément | Nature du couplage |
|---|---|
| `tcp-server.service.ts` | ASCII + découpage `;`/CR/LF. **Incompatible par construction** (§ 1.2). |
| `positions.service.ingest(frame: CobanPositionFrame)` | Signature typée Coban. Contournable **sans la modifier** : TypeScript est structurel, un adaptateur Teltonika peut construire une valeur conforme à `CobanPositionFrame`. Coût : le nom du type. |
| `alerts.createFromCobanFrame` | Idem. |
| `COBAN_COMMAND_CATALOG` + `getCatalog()` | Gabarits Coban. **Je ne les touche pas** : je propose un module de commandes Teltonika dédié (§ 5.4). |
| `engine-control.service.ts` | Appelle `encodeCommand` (Coban) en **2 endroits** : lignes **1972** et **2626**. Seul point réellement sensible. |
| `decodeFrame` / `encodeCommand` exportés sans préfixe | Risque de **collision de noms** dans `@vizyo/tracky-shared` (§ 8, R3). |

---

## 5. Architecture proposée

### 5.1 Principe : deux mondes, un seul point de contact — la socket

```
                        ┌──────────────────────── MONDE COBAN — INTOUCHÉ ────────────────────────┐
   port 5023  ───────►  │ TcpServerService (0 diff)                                              │
   (Coban)              │   chunk.toString('ascii') → split(;\r\n) → decodeFrame → dispatchFrame │
                        └───────────────────────────────┬───────────────────────────────────────┘
                                                        │
                         ┌──── COMMUN, DÉJÀ GÉNÉRIQUE ──┴──────────────────────────────────┐
                         │ SocketRegistry · AckWaiter · TrackerCommand · WireLog · Prisma  │
                         │ positions.ingest() · alerts · EngineControlService (gardes)     │
                         └──── ▲ ──────────────────────────────────────────────────────────┘
                               │ (adaptateur : enregistrement AVL → objet position)
   port 5027  ───────►  ┌──────┴───────────────── MONDE TELTONIKA — NEUF ─────────────────┐
   (Teltonika)          │ TeltonikaTcpServerService : Buffer de bout en bout              │
                        │   découpage par préfixe de longueur → handshake / Codec 8·8E     │
                        │   → ACK 4 octets → Codec 12                                     │
                        └─────────────────────────────────────────────────────────────────┘
```

### 5.2 Détection du protocole — la règle, et pourquoi elle est non ambiguë

| Protocole | Premiers octets possibles |
|---|---|
| **Teltonika** | `00 0F` (handshake, longueur d'IMEI = 15) ou `00 00 00 00` (préambule AVL) → **premier octet toujours `0x00`** |
| **Coban** | `#` = `0x23` (login `##,imei:…`), un chiffre ASCII `0x30`–`0x39` (heartbeat nu), ou `i` = `0x69` (`imei:…`) |

`0x00` ne peut **jamais** ouvrir une trame Coban (protocole entièrement ASCII imprimable) ;
`#`, un chiffre ou `i` ne peuvent **jamais** ouvrir une trame Teltonika (le premier octet est
un octet de longueur haute, nul pour tout IMEI). La règle est donc **totale et disjointe**.

Fonction pure proposée, dans `packages/shared`, testée dans les deux sens :

```ts
type ProtocoleReconnu = 'coban' | 'teltonika' | 'indetermine' | 'invalide';
function reconnaitreProtocole(premiersOctets: Buffer): ProtocoleReconnu;
```

- `< 2 octets` ⇒ `indetermine` (le premier `data` peut ne porter qu'un octet) — on attend,
  avec une borne de temps, puis on refuse.
- `0x00` en tête ⇒ `teltonika`
- `0x23` / `0x30`–`0x39` / `0x69` ⇒ `coban`
- tout le reste ⇒ `invalide` (fermeture, pas d'interprétation)

### 5.3 Deux ports plutôt qu'un — et la détection quand même

**Je recommande un second port** (`TELTONIKA_TCP_PORT`, défaut 5027) :

- le chemin Coban a alors **un diff de zéro octet** — aucune régression Coban n'est
  *possible*, pas seulement improbable ;
- la détection reste **nécessaire et testée dans les deux sens**, parce qu'un Coban mal
  provisionné **arrivera** sur le port Teltonika (les installateurs recopient les configs
  APN/serveur). Chaque écouteur **refuse explicitement** le protocole étranger au lieu de le
  mal interpréter ;
- si tu veux un port unique plus tard, la fonction de détection est déjà écrite et éprouvée :
  le passage devient une dizaine de lignes dans `handleConnection`, pas une refonte.

Si tu veux **un seul port dès maintenant**, c'est faisable — mais alors `tcp-server.service.ts`
est modifié avant la ligne 126, et le filet de l'étape 1 devient un préalable absolu.
**Dis-moi lequel des deux tu veux ; c'est la seule décision d'architecture que je ne prends
pas seul.**

### 5.4 Découpage en fichiers

**Neufs — couche protocole pure** (`packages/shared/src/protocol/teltonika/`) :

| Fichier | Contenu |
|---|---|
| `teltonika.types.ts` | `TrameTeltonika`, `EnregistrementAvl`, `ElementIo`, `ReponseCodec12` |
| `teltonika.crc.ts` | `crc16Arc(Buffer): number` |
| `teltonika.handshake.ts` | décodage du handshake IMEI + octet de réponse |
| `teltonika.codec8.ts` | décodage Codec 8 (`0x08`) **et** 8 Extended (`0x8E`), IO 1/2/4/8/X octets |
| `teltonika.codec12.ts` | encodage commande (type `0x05`), décodage réponse (type `0x06`) |
| `teltonika.decoupage.ts` | découpage des trames par préfixe de longueur |
| `teltonika.catalog.ts` | les 9 commandes `lvcan*` + métadonnées (dangerosité, rôle, params) |
| `reconnaissance-protocole.ts` | `reconnaitreProtocole()` (§ 5.2) |

**Neufs — côté API :**

| Fichier | Contenu |
|---|---|
| `apps/api/src/tracker-teltonika/teltonika-tcp-server.service.ts` | listener, Buffer de bout en bout |
| `apps/api/src/tracker-teltonika/teltonika.module.ts` | module Nest |
| `apps/api/src/tracker-teltonika/avl-vers-position.ts` | **l'adaptateur** (§ 5.5) |
| `apps/api/src/teltonika-commands/*` | contrôleur + service des 7 commandes non-moteur |
| `scripts/faux-boitier-teltonika.mjs` | faux boîtier (étape 3), calqué sur son jumeau Coban |
| `docs/teltonika-fmc130/01-protocole-teltonika-fmb-fmc.md` | doc protocole, à côté de `docs/03-protocol-coban-gps403d.md` |

### 5.5 L'adaptateur — réutiliser `positions.ingest()` sans le modifier

TypeScript étant structurel, l'adaptateur construit une valeur **conforme à
`CobanPositionFrame`** et la passe à `positions.ingest()` inchangé :

| Champ attendu | Source Teltonika |
|---|---|
| `imei` | handshake |
| `deviceTime` | timestamp 8 octets (ms depuis epoch, **UTC**) |
| `latitude` / `longitude` | `int32 / 1e7` |
| `speedKph` | vitesse 2 octets — **déjà en km/h** (pas de nœuds à convertir) |
| `course` | angle 2 octets |
| `altitude` | altitude 2 octets signés |
| `valid` | **`satellites > 0` ET coordonnées non nulles** — voir R5, c'est critique |
| `ignition` | IO `239` |
| `batteryPercent` | IO `113` |
| `alarm` | table de correspondance depuis l'`Event IO ID` (défaut `'none'`) |
| `raw` | hexadécimal de l'enregistrement |

**Dette de nommage assumée** : le type s'appelle `CobanPositionFrame` alors qu'il portera des
données Teltonika. Je l'assume plutôt que de renommer un type au cœur de la production.
*Proposition pour plus tard, hors de ce chantier* : `export type TramePositionNormalisee =
CobanPositionFrame` puis migration progressive des signatures. **Je ne le fais pas maintenant.**

### 5.6 Commandes sortantes

- **Les 7 commandes non-moteur** (`lvcanclosealldoors`, `lvcanopenalldoors`,
  `lvcanturninglights`, `lvcangetinfo`, `lvcangetprog`, `lvcansetprog <n>`,
  `lvcanfaultcodes`) → module `teltonika-commands` **neuf**, qui réutilise la table
  `TrackerCommand`, `AckWaiterService` et `SocketRegistryService.send()`. `tracker-commands`
  n'est pas touché.
- **`lvcanblockengine` / `lvcanunblockengine`** → **passent par `EngineControlService`**. Ce
  service porte 3 250 lignes de gardes durement acquis (`MAX_SPEED_FOR_CUT = 20`,
  `STALE_THRESHOLD_MOVING_MS = 60 s`, `REST_SPEED_KMH = 5`, TRK-046 « hors champ GPS »,
  interlock, audit immuable, anti-acharnement, preuve par chute d'ignition). Et le catalogue
  Coban l'écrit noir sur blanc : *« engine_stop and engine_resume are INTENTIONALLY EXCLUDED …
  Do NOT add engine commands here »*.

  Réimplémenter ce garde-fou à côté serait ré-ouvrir cinq incidents. **C'est le seul endroit
  où je demande à modifier un fichier du chemin Coban.** Forme du diff, minimale :

  ```ts
  // engine-control.service.ts:1972  (idem 2626)
  - const payload = encodeCommand(imei, cobanCmd);
  + const payload = this.encoderPourBoitier(tracker.model, imei, cobanCmd);
  ```

  avec un helper privé dont la **branche par défaut est littéralement `encodeCommand(imei,
  cmd)`** : pour tout `model` autre que Teltonika, l'octet produit est identique. Plus la
  sélection du motif d'ACK (`ENGINE_*_ACK_PATTERN` ↔ réponse Codec 12).

---

## 6. Vérification de la structure Codec 12 contre la doc officielle

Tu m'as demandé de vérifier et de te corriger. **J'ai décodé les deux trames d'exemple du
wiki Teltonika, champ par champ, et recalculé leurs CRC. Ta description est exacte.** Pas une
divergence sur la structure. Détail de la vérification :

### 6.1 Codec 12 — trame d'exemple officielle `getinfo`

```
000000000000000F 0C 01 05 00000007 676574696E666F 01 00004312
```

| Champ | Valeur mesurée | Conforme à ta spec |
|---|---|:--:|
| Preamble (4 o) | `0x00000000` | ✅ |
| Data Field Length (4 o) | `15` = `8 + longueur(commande)` | ✅ |
| Codec ID (1 o) | `0x0C` | ✅ |
| Command Quantity 1 (1 o) | `0x01` | ✅ |
| Type (1 o) | `0x05` (commande) / `0x06` (réponse) | ✅ |
| Command Size (4 o) | `7` | ✅ |
| Command (N o) | `"getinfo"` en ASCII | ✅ |
| Command Quantity 2 (1 o) | `0x01` | ✅ |
| CRC-16 (4 o) | `0x00004312` | ✅ |

**CRC recalculé : `0x4312` avec polynôme `0xA001`, init `0x0000`, sans XOR final, sur les
octets du Codec ID au Command Quantity 2 inclus → CONCORDE.** Ta spec CRC est juste au bit
près.

### 6.2 Les quatre précisions à retenir (aucune ne contredit ta spec, toutes se codent)

1. **Le champ CRC fait 4 octets mais ne porte qu'une valeur 16 bits** : les 2 octets de poids
   fort sont toujours `0x0000`. Il faut donc *écrire* 4 octets et ne *comparer* que les
   16 bits de poids faible. Une vérification sur 32 bits échouerait sur toute trame valide.
2. **La doc nomme l'algorithme « CRC-16/IBM »** ; c'est le même que CRC-16/ARC (et
   CRC-16/ANSI). Aucune divergence, juste un synonyme à connaître pour relire la doc.
3. **`Command Quantity 1` est ignoré par le boîtier à l'analyse**, mais `Command Quantity 2`
   **doit être égal** au premier. Les mettre tous deux à `0x01` est correct.
4. **Data Field Length exclut le préambule ET le CRC** — il compte du Codec ID au Command
   Quantity 2. Formule exploitable : `8 + longueur(commande)`.

### 6.3 Codec 8 Extended — trame d'exemple officielle, décodée intégralement

```
000000000000004A 8E 01 [enregistrement] 01 00002994
```

Décodage complet, curseur final = 86 / 86 octets, **CRC recalculé `0x2994` → CONCORDE** :

| Champ | Valeur | Remarque |
|---|---|---|
| Codec ID | `0x8E` | |
| Number of Data 1 / 2 | `1` / `1` | **1 octet chacun, même en 8E** ⚠️ |
| Timestamp (8 o) | `1560166592000` → `2019-06-10T11:36:32Z` | **millisecondes**, UTC |
| Priority (1 o) | `1` | |
| GPS element (15 o) | lon `0`, lat `0`, alt `0`, angle `0`, **sat `0`**, **vitesse `0`** | voir R5 |
| Event IO ID | `1` | **2 octets en 8E** (1 en Codec 8) |
| Total IO | `5` | **2 octets en 8E** |
| N1 (1) | `1=0x01` | compteur **2 octets**, ID **2 octets** |
| N2 (1) | `17=0x001d` | |
| N4 (1) | `16=0x015e2c88` | |
| N8 (2) | `11=…`, `14=…` | |
| NX (0) | — | **catégorie exclusive au 8E** : c'est là qu'arrivent VIN et valeurs CAN longues |

**Ce qui change entre Codec 8 et 8E** — à écrire noir sur blanc dans le décodeur, parce que
c'est le piège classique : passent de 1 à 2 octets l'`Event IO ID`, le `Total IO`, **chaque
compteur** `N1/N2/N4/N8` et **chaque ID d'IO** ; la catégorie `NX` (valeurs de longueur
variable, préfixées par leur longueur sur 2 octets) **n'existe qu'en 8E**. Restent à 1 octet :
le `Codec ID`, et `Number of Data 1` / `Number of Data 2`.

Tu as raison sur le fond : **sans le 8E, pas de VIN ni de CAN étendu** — ils vivent dans `NX`.

### 6.4 Handshake et acquittements — confirmés

- Boîtier → serveur : `000F` + IMEI en ASCII (ex. `000F333536333037303432343431303133`)
- Serveur → boîtier : **1 octet binaire** `0x01` (accepté) ou `0x00` (refusé)
- Après chaque paquet AVL : serveur → boîtier = **4 octets** = nombre d'enregistrements
  acceptés (ex. `00000002`)
- GPRS : **pas de mot de passe, pas d'espace en tête** — confirmé par l'exemple `getinfo`,
  qui ne porte ni l'un ni l'autre. Ta spec est juste.

---

## 7. Liste précise des fichiers existants que je prévois de modifier

| # | Fichier | Diff | Étape | Pourquoi |
|---|---|---|---|---|
| 1 | `packages/shared/src/protocol/index.ts` | **+1 ligne** `export * from './teltonika';` | 2 | rendre la couche pure importable |
| 2 | `apps/api/src/config/env.validation.ts` | **+2 lignes** : `TELTONIKA_TCP_PORT` (défaut 5027), `TELTONIKA_BLOCK_MAX_POSITION_AGE_S` (défaut 60) | 4, 6 | additif **avec valeurs par défaut** → aucun `.env` de prod à changer |
| 3 | `apps/api/src/app.module.ts` | **+2 lignes** : import du `TeltonikaTcpModule` | 4 | câblage Nest — couvert par `app.module.smoke.spec.ts` |
| 4 | 🔴 `apps/api/src/engine-control/engine-control.service.ts` | **2 appels + 1 helper privé + sélection du motif d'ACK** (§ 5.6) | 6 | réutiliser les gardes vitesse/fraîcheur plutôt que les réécrire |
| 5 | `apps/api/src/engine-control/engine-control.module.ts` | **+1 ligne** si l'encodeur est injecté | 6 | dépendance du point 4 |

**Non modifiés** — et c'est le cœur de la proposition : `tcp-server.service.ts`, tous les
`coban.*.ts`, `positions.service.ts`, `alerts.service.ts`, `socket-registry.service.ts`,
`ack-waiter.service.ts`, `tracker-commands.service.ts`, `coban.catalog.ts`, et
**`schema.prisma` — aucune migration**.

Les points 1 à 3 et 5 sont des ajouts d'une à deux lignes, sans branche conditionnelle. **Seul
le point 4 est un vrai changement de comportement** : je ne le toucherai pas sans ton accord
écrit sur le diff exact, conformément à ta règle n° 2.

---

## 8. Risques de régression identifiés

| # | Risque | Gravité | Parade |
|---|---|:--:|---|
| **R1** | `chunk.toString('ascii')` masque le bit haut : `0x8E` → `0x0E`. Toute tentative de partager le buffer du `TcpServerService` corrompt le Codec 8E **en silence**. | 🔴 | Deux ports (§ 5.3) ⇒ le problème ne se pose pas. Détection sur `Buffer` brut, jamais après `toString`. Test qui documente le masquage. |
| **R2** | Le découpage Coban sur `;` `\r` `\n` (`0x3B 0x0D 0x0A`) tranche au milieu d'un payload binaire. | 🔴 | Idem R1 : découpage Teltonika **par préfixe de longueur**, dans un fichier séparé. |
| **R3** | **Collision de noms** dans `@vizyo/tracky-shared` : un `export * from './teltonika'` qui exporterait `encodeCommand` ou `decodeFrame` rebinderait silencieusement le symbole que le chemin Coban importe. | 🔴 | Tous les exports Teltonika nommément distincts (`encoderCommandeCodec12`, `decoderTrameTeltonika`, …). **Test dédié** : `encodeCommand(imei, {type:'engine_stop'})` rend toujours exactement `**,imei:…,J;`. |
| **R4** | Le diff sur `engine-control.service.ts` casse la coupe Coban. | 🔴 | Branche par défaut = `encodeCommand(...)` littéral. Les **166 tests engine-control** doivent rester verts + un test d'octets sur la trame Coban produite. Ton accord préalable. |
| **R5** | **Un Teltonika sans fix GPS rapporte `vitesse = 0` et `satellites = 0`.** La trame d'exemple officielle du wiki est *exactement* ce cas (§ 6.3). Si l'adaptateur l'ingère en `valid: true, speedKph: 0`, la garde de coupe lit « véhicule à l'arrêt » (`speedKmh ≤ 5` ⇒ pas de contrôle de fraîcheur) et **autorise `lvcanblockengine` sur un véhicule peut-être à 90 km/h**. C'est ton TRK-046 à l'identique. | 🔴🔴 | `valid = satellites > 0 && coordonnées non nulles`. Un enregistrement sans fix part sur le chemin `no_fix`, **jamais** sur `ingest`. Test dédié avec la trame du wiki comme vecteur. |
| **R6** | Le boîtier Teltonika **réémet indéfiniment** les enregistrements non acquittés. Un ACK 4 octets faux ou absent ⇒ boucle d'ingestion dupliquée. | 🟠 | Le nombre d'enregistrements acceptés est calculé, pas constant. Test : trame à 2 enregistrements ⇒ `00000002`. Test de non-régression sur trame partielle ⇒ **pas** d'ACK. |
| **R7** | IMEI Teltonika inconnu : le chemin Coban ferme la socket (`socket.end()`). Un Teltonika ainsi fermé **reconnecte en boucle serrée**. | 🟠 | Répondre `0x00` (refus explicite) **puis** fermer, et enregistrer dans `UnknownTrackerRegistry`. |
| **R8** | `SocketRegistryService` est indexé par IMEI seul : si l'encodeur était choisi d'après *l'écouteur qui a reçu la socket*, un boîtier mal branché recevrait la mauvaise grammaire. | 🟠 | L'encodeur se choisit **depuis `tracker.model` lu en base**, jamais depuis le port d'arrivée. Test explicite. |
| **R9** | `AckWaiterService` partagé (clé = IMEI). | 🟢 | Un IMEI est d'un seul protocole. Aucun changement. Mentionné pour mémoire. |
| **R10** | **1 047 lignes non commitées** sur la branche `feat/agenda-cdef31-mise-en-service`, dont `engine-control.service.ts`, `engine-control.controller.ts` et leurs specs (17 fichiers). Le dépôt est partagé (Claude **et** Codex). | 🔴 | Voir § 9 — c'est le point bloquant de processus. |
| **R11** | `lvcanblockengine` sur CAN-CONTROL empêche le **démarrage** ; il ne coupe pas un moteur qui tourne. La preuve par « chute d'ignition » que `EngineControlService` sait attendre sur Coban n'aura donc pas le même sens. | 🟠 | `confirmationExpected = false` pour le blocage Teltonika, et un état « non vérifiable » plutôt qu'un faux « non confirmé ». À trancher à l'étape 6. |

---

## 9. ⚠️ Point bloquant de processus, avant toute ligne de code

L'arbre de travail courant porte **1 047 lignes non commitées** sur
`feat/agenda-cdef31-mise-en-service`, réparties sur 17 fichiers, dont **exactement ceux que
l'étape 6 doit modifier** (`engine-control.service.ts`, `engine-control.controller.ts` et
leurs specs). Ton `CLAUDE.md` est formel : *« un agent = un worktree »*, et **Codex travaille
aussi sur ce dépôt** — une modification « de personne » peut venir de lui.

J'ai vérifié : dans l'état actuel, **tout est vert** (423 + 135 + 166 tests). Mais travailler
là-dessus mélangerait mon diff au tien et rendrait impossible de prouver qu'une régression
vient de moi.

**Ma recommandation : un worktree dédié**, `git worktree add ../wt-teltonika`, à partir de
`main` ou de la branche de ton choix. Je n'y touche pas avant ton accord.

---

## 10. Ce que je te demande de trancher

| # | Question | Ma recommandation |
|---|---|---|
| **Q1** | Worktree dédié `../wt-teltonika`, ou je travaille ici ? Et sur quelle base — `main`, ou la branche courante avec son travail en cours ? | **Worktree dédié sur `main`** (§ 9) |
| **Q2** | **Second port** Teltonika (5027) ou **port unique** partagé avec détection dans `tcp-server.service.ts` ? | **Second port** : diff nul sur le chemin Coban, détection quand même écrite et testée (§ 5.3) |
| **Q3** | `lvcanblockengine` via `EngineControlService` (⇒ 2 lignes à modifier dans un fichier Coban, avec ton accord) ou garde réimplémenté à côté ? | **Via `EngineControlService`** : ne pas réécrire un garde-fou qui a coûté cinq incidents (§ 5.6) |
| **Q4** | Discriminant de protocole : `Tracker.model` (existant, zéro migration) ou nouvelle colonne `protocole` (additive, nullable) ? | **`Tracker.model`** (§ 3.2) |
| **Q5** | Confirmes-tu l'étape 1 (filet de caractérisation sur `handleConnection` + `dispatchFrame` + un test d'intégration qui ouvre vraiment un port) avant tout code Teltonika ? | **Oui** — c'est le trou le plus dangereux du dépôt pour ce chantier (§ 2.2) |
| **Q6** | Étape 6 : API seule, sans UI ? Ton déroulé ne mentionne pas d'écran — les 9 commandes seraient donc pilotables par API uniquement. | À confirmer ; je ne fais **rien** côté `apps/web` sans demande explicite |

---

## 11. Annexe — état des tests mesuré le 2026-09-27 (référence « avant »)

```
packages/shared                                     19 suites  423 tests  ✅  5,3 s
apps/api  tracker-tcp|socket-registry|
          tracker-commands|positions                 9 suites  135 tests  ✅ 27,2 s
apps/api  engine-control                             2 suites  166 tests  ✅
```

C'est la référence à laquelle comparer à chaque arrêt. Toute régression sur ces 724 tests
déclenche la règle n° 4 : **arrêt immédiat et signalement**, sans réparation ni adaptation.

Aucune occurrence de « teltonika », « codec », « FMC130 », « FMB » ou « lvcan » dans le dépôt
aujourd'hui : le chantier part d'une page blanche, sans résidu d'une tentative précédente.
