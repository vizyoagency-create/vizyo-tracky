# Phase 8 — Logs structurés & observabilité (cross-cutting)

> ✅ **Historique — réalisé** *(bandeau posé le 2026-08-22)*. Le mode d'emploi de ce qui a
> été livré est `docs/observability-guide.md`. Les cases non cochées ci-dessous datent du
> plan, pas du résultat.

**Objectif** : pouvoir diagnostiquer en moins de 2 minutes n'importe quel problème survenant pendant le bench 403C et la phase de tests réels — parsing qui échoue, commande qui ne part pas, ACK jamais reçu, tracker qui se déconnecte en boucle.

**Durée estimée** : 1 jour, livré **en amont de Phase 5** (le bench en a besoin pour diagnostiquer vite).

**Prérequis** : aucun.

---

## 8.1 Choix techniques

### 8.1.1 Logger : `nestjs-pino`

- Pino = JSON structuré natif, 5× plus rapide que Winston
- `nestjs-pino` s'intègre sans friction avec NestJS (`Logger` natif remplacé)
- Pretty-print en dev (`pino-pretty`), JSON brut en prod (lisible par Loki/Datadog/grep)
- Ajoute automatiquement `req.id` (correlation ID par requête HTTP)

Dépendances à ajouter :

```
pnpm --filter @vizyo/tracky-api add nestjs-pino pino pino-http
pnpm --filter @vizyo/tracky-api add -D pino-pretty
```

### 8.1.2 Correlation IDs

Chaque **commande** (EngineControl ou TrackerCommand) porte son `commandId` UUID. Tous les logs relatifs à cette commande — création, encode, socket.write, ACK match, timeout, WS broadcast — portent ce `commandId` dans le JSON log.

Chaque **trame TCP** entrante est loguée avec un `frameId` UUID court et l'IMEI. Si la trame est un ACK matché à une commande, le log d'ACK porte les deux IDs.

### 8.1.3 Stockage

- **Logs applicatifs** (info/warn/error) → stdout JSON, captés par Docker logs. En prod : Loki ou fichier rotating (`pino/file`).
- **Erreurs critiques visibles admin** → table Prisma `ErrorLog` (voir 8.4)
- **Trames TCP brutes** → table Prisma `WireLog` en mode debug seulement, désactivable par flag `.env` (`WIRE_LOG_ENABLED=true`), TTL 7 jours via cron cleanup

---

## 8.2 Modules de log métier

### 8.2.1 `CobanWireLogger` (nouveau service)

**Fichier** : `apps/api/src/observability/coban-wire-logger.service.ts`

Injecté dans `TcpServerService`, `EngineControlService`, `TrackerCommandsService`. Capture :

```ts
wireLogger.in(imei, rawFrame, parsedFrameType);
wireLogger.out(imei, payload, context: { commandId?, source: 'engine' | 'tracker-cmd' | 'ack' });
wireLogger.ackMatch(imei, rawFrame, commandId, latencyMs);
wireLogger.ackTimeout(imei, commandId, pattern, elapsedMs);
```

Chaque appel :
1. Loggue en Pino avec un `msg` lisible et les champs structurés (imei, commandId, direction, latencyMs, etc.)
2. Si `WIRE_LOG_ENABLED=true`, persiste dans `WireLog` (rotation 7 jours)

### 8.2.2 `ErrorLog` : erreurs critiques persistées

Chaque catch block dans les services critiques (TCP dispatch, commands dispatch, webhook SMS, positions ingest) appelle `errorLogger.record(error, context)`. Table accessible en admin UI.

---

## 8.3 Schéma Prisma

```prisma
model WireLog {
  id          String   @id @default(uuid()) @db.Uuid
  imei        String
  direction   String   // 'IN' | 'OUT'
  raw         String   @db.Text
  frameType   String?  // 'login' | 'heartbeat' | 'position' | 'unknown' | 'command' | 'ack'
  commandId   String?  @db.Uuid
  context     Json?
  createdAt   DateTime @default(now())

  @@index([imei, createdAt(sort: Desc)])
  @@index([commandId])
  @@index([createdAt])
  @@map("wire_logs")
}

model ErrorLog {
  id          String   @id @default(uuid()) @db.Uuid
  level       String   // 'ERROR' | 'CRITICAL'
  source      String   // 'tcp-server' | 'engine-control' | 'tracker-commands' | 'sms-webhook' | 'positions' | ...
  message     String
  stack       String?  @db.Text
  imei        String?
  commandId   String?  @db.Uuid
  userId      String?  @db.Uuid
  context     Json?
  createdAt   DateTime @default(now())

  @@index([source, createdAt(sort: Desc)])
  @@index([imei])
  @@index([commandId])
  @@index([createdAt])
  @@map("error_logs")
}
```

Migration : `observability_logs`.

Cron cleanup journalier (`@nestjs/schedule`) : `DELETE FROM wire_logs WHERE created_at < NOW() - INTERVAL '7 days'` + `DELETE FROM error_logs WHERE created_at < NOW() - INTERVAL '30 days'`.

---

## 8.4 Exception filter global

**Fichier** : `apps/api/src/observability/all-exceptions.filter.ts`

Intercepte toute exception non catchée dans les controllers :
1. Loggue via Pino avec `req.id`, userId (si auth), route, body (masqué pour passwords)
2. Si `HttpException` avec status >= 500 ou exception non-Nest : persiste dans `ErrorLog`
3. Réponse client : format uniforme `{ error: { code, message, requestId } }` — le `requestId` permet à l'utilisateur/support de référencer l'incident

Global dans `main.ts` :
```ts
app.useGlobalFilters(new AllExceptionsFilter(errorLogger, logger));
```

---

## 8.5 Endpoints admin

```
GET  /admin/logs/wire              # query: imei, commandId, from, to, limit
GET  /admin/logs/wire/:id
GET  /admin/logs/errors            # query: source, imei, level, from, to, limit
GET  /admin/logs/errors/:id
GET  /admin/logs/tracker/:imei/timeline   # timeline unifiée WireLog + ErrorLog + commands
```

SUPER_ADMIN only. Rate limit standard.

---

## 8.6 UI admin `/admin/observability`

3 tabs :
1. **Wire logs** — filtres IMEI / direction / période, affichage brut avec colorisation (IN vert, OUT bleu, ACK violet)
2. **Errors** — filtres source / période, détail click → stack trace, contexte JSON pretty-print
3. **Tracker timeline** — input IMEI, affiche les 100 derniers events (wire + errors + commands) sur une frise verticale

Pas de live tail V1 (on peut l'ajouter plus tard avec WS). Refresh manuel.

---

## 8.7 Logging conventions à respecter partout

### 8.7.1 Niveaux

- `debug` — trafic normal (heartbeat ON répondu, position ingérée)
- `info` — événements notables (tracker connecté, commande envoyée, ACK reçu)
- `warn` — anomalie récupérable (IMEI inconnu, frame unknown, ACK timeout)
- `error` — erreur avec impact (dispatch échoué, parsing crash, DB error)

### 8.7.2 Format

**Toujours** passer les données en champs structurés, **jamais** interpoler dans le message :

```ts
// ❌ NON
this.logger.log(`Command ${cmd.id} dispatched to ${imei}`);

// ✅ OUI
this.logger.log({ commandId: cmd.id, imei, payload }, 'Command dispatched');
```

### 8.7.3 Champs standards

Tout log métier doit contenir (quand applicable) :

```ts
{
  commandId?: string,
  imei?: string,
  trackerId?: string,
  vehicleId?: string,
  fleetId?: string,
  userId?: string,
  latencyMs?: number,
  frameRaw?: string,
  frameType?: string,
}
```

### 8.7.4 Ne jamais logguer

- Passwords, JWT, API tokens, secrets Twilio
- `.env` values
- Credit cards, SSN (n/a ici mais principe général)

Masquage automatique dans `pino-http` via `redact: ['req.headers.authorization', '*.password', '*.token']`.

---

## 8.8 Livrables phase 8

- [ ] `nestjs-pino` installé et configuré dans `main.ts` + `AppModule`
- [ ] `pino-pretty` en dev, JSON raw en prod (switch par `NODE_ENV`)
- [ ] `CobanWireLogger` service + intégration dans TCP server, EngineControl, TrackerCommands
- [ ] `ErrorLogger` service (wrapper qui loggue + persiste selon sévérité)
- [ ] `AllExceptionsFilter` global avec response uniforme `{ error: { code, message, requestId } }`
- [ ] Prisma models `WireLog` + `ErrorLog` + migration + cron cleanup
- [ ] Endpoints admin `/admin/logs/*` (SUPER_ADMIN only)
- [ ] UI `/admin/observability` avec 3 tabs (wire / errors / timeline)
- [ ] Doc `docs/observability-guide.md` : comment lire les logs, correspondance niveaux ↔ actions, exemples de requêtes utiles
- [ ] 10+ tests (exception filter, error logger persistence, wire logger toggle, cleanup cron)

---

## 8.9 Vérifications sur le bench 403C (Phase 5)

Une fois Phase 8 livrée et avant de faire le bench, valider sur le mock :

1. Déclencher un CUT via l'UI → vérifier que les logs contiennent `commandId`, `imei`, `payload`, dans le bon ordre chronologique
2. Simuler un ACK dans FakeTcpSocket → vérifier entry `ackMatch` dans les logs avec `latencyMs`
3. Forcer une erreur (Prisma en panne) → vérifier `ErrorLog` row créée, requestId retourné au client
4. Consulter `/admin/observability` sur la timeline d'un IMEI mock → lisible et utile

Si ces 4 checks passent, le bench 403C sera diagnosticable en < 2 minutes par log.
