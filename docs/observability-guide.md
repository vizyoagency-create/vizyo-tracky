# Guide Observabilite — Vizyo Tracky

## Stack

- **Logger** : `nestjs-pino` (Pino JSON structuré)
- **Pretty-print** : `pino-pretty` en dev (`NODE_ENV !== production`)
- **Persistence** : tables Prisma `WireLog` + `ErrorLog`
- **Cleanup** : cron quotidien 3h AM — wire logs > 7j, error logs > 30j

## Niveaux de log

| Niveau | Usage | Exemples |
|--------|-------|----------|
| `debug` | Trafic normal | Heartbeat ON, position ingérée |
| `info` | Événements notables | Tracker connecté, commande envoyée, ACK reçu |
| `warn` | Anomalie récupérable | IMEI inconnu, frame unknown, ACK timeout, socket fermé |
| `error` | Erreur avec impact | Dispatch échoué, parsing crash, DB error |

## Configuration `.env`

```
LOG_LEVEL=debug          # fatal | error | warn | info | debug | trace
WIRE_LOG_ENABLED=true    # Persiste les trames TCP dans wire_logs
```

## Champs structurés standards

Tout log métier contient (quand applicable) :
- `commandId` — UUID de la commande
- `imei` — IMEI du tracker
- `trackerId`, `vehicleId`, `fleetId`
- `latencyMs` — latence ACK
- `frameRaw` — trame brute
- `frameType` — login / heartbeat / position / unknown / command / ack

## Endpoints admin

```
GET /api/admin/logs/wire              # ?imei, commandId, direction, from, to, limit
GET /api/admin/logs/wire/:id
GET /api/admin/logs/errors            # ?source, imei, level, from, to, limit
GET /api/admin/logs/errors/:id
GET /api/admin/logs/tracker/:imei/timeline  # ?limit
```

Accès : `SUPER_ADMIN` uniquement.

## UI

`/admin/observability` — 3 onglets :
1. **Wire Logs** — filtre IMEI / direction, colorisation IN (vert) / OUT (bleu)
2. **Erreurs** — filtre source, détail click → stack trace + contexte JSON
3. **Timeline** — input IMEI, frise verticale wire + errors + commands

## Scénarios de diagnostic rapide

### Tracker ne se connecte pas
1. Timeline IMEI → chercher dernier event `login`
2. Si absent → le tracker n'atteint pas le port TCP
3. Si présent avec `Unknown IMEI` → IMEI pas seedé en DB

### Commande ne part pas
1. Filtrer wire logs `direction=OUT commandId=<id>`
2. Si absent → dispatch n'a pas écrit sur le socket (tracker offline ?)
3. Si présent → vérifier ACK (`direction=IN frameType=ack commandId=<id>`)

### ACK timeout
1. Wire logs `commandId=<id>` → voir OUT puis chercher IN
2. Si IN absent → tracker n'a pas répondu (firmware ? commande inconnue ?)
3. Vérifier `expectedPattern` dans les logs warn `ACK timeout`
