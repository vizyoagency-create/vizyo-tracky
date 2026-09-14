# 23 — Correctif P1-2 (T44) : la sentinelle Android ne bat plus, et le verdict porte sur UN téléphone

Date : 14 septembre 2026
Branches : Tracky `codex/tracky-cutoff-reliability-2026-09-12` · relais `codex/gateway-health-reliability-2026-09-13`
Production : **aucun changement** — code écrit, testé et committé sur les deux branches, non déployé.

## Le défaut corrigé (document 19, P1-2)

- Tracky, sentinelle : **un seul** contrôle sain refermait l'épisode et remettait le rappel de
  15 min à zéro. Le téléphone ne contacte le serveur qu'à son pull de secours (mesuré le 13/09 :
  `lastSeen` figé 552 s au repos) : « périmé » puis « sain » à chaque pull, et **un CRITICAL par
  épisode**, jusqu'à quatre par heure, sans panne.
- Relais, santé : **le plus frais de TOUS les appareils gagnait** — un téléphone de test enrôlé
  sous le même compte aurait rendu la chaîne « fraîche » avec le téléphone de production mort ;
  `simCards` (fourni par l'API) ignoré ; `CAPCOM6_DEVICE_STALE_SECONDS` **sans borne haute**
  (999999999 rendait la fraîcheur inopérante en silence) ; le délai de 5 s des lectures
  s'appliquait aussi à l'**envoi** (« timeout mais accepté », jamais réconcilié).

## Ce qui change

### Relais Texto (commit `784d766`)

| Où | Quoi |
|---|---|
| `src/config/env.ts` | `CAPCOM6_BOUNDS` : stale **[30, 3600]** s (défaut 120), offline **[60, 86400]** s (défaut 900, jamais < stale), lectures **[1, 30]** s (5), envoi **[1, 60]** s (9). Une valeur absurde est ramenée à la borne, jamais acceptée. Nouveau `CAPCOM6_DEVICE_OFFLINE_SECONDS`, nouveau `CAPCOM6_SEND_TIMEOUT_MS`. |
| `Capcom6Service.send` | Utilise `sendTimeoutMs` ; les lectures gardent `requestTimeoutMs`. Type `Capcom6Device.simCards` (contrat `smsgateway.SimCard`). |
| `MessagesService.gatewayHealth` → `evaluateDevice` (fonction pure) | **L'appareil du verdict** : `CAPCOM6_DEVICE_ID` s'il est renseigné (`selection: configured`, `missing` s'il est introuvable → refus), sinon l'unique appareil enrôlé (`single`) ; plusieurs appareils sans identifiant → `ambiguous`, **refus** ; aucun → `none`. |
| `device.state` | `ONLINE` (≤ stale) · `STALE` (≤ offline) · `OFFLINE` (au-delà) · `UNKNOWN` (aucun appareil retenu, ping absent/illisible, ou daté dans le futur de plus de 60 s — horloges désaccordées). `fresh` reste exposé = `ONLINE`. |
| `sim.cards`, `sim.configuredPresent` | Cartes de l'appareil retenu ; la SIM configurée absente = refus ; `null` sur un serveur qui n'expose pas les SIM (jamais un refus par défaut). |
| `error` | La raison du refus, en clair, cumulée si plusieurs (« serveur capcom6 “fail” ; téléphone périmé : dernier ping il y a 300 s (seuil 120 s) »). |

### Tracky (ce commit)

| Où | Quoi |
|---|---|
| `SmsGatewayWatchdogService` | Hystérésis : un épisode s'**ouvre après 2** contrôles mauvais consécutifs et se **ferme après 3** contrôles sains consécutifs ; rappel toutes les 15 min inchangé. Un contrôle qui lève compte comme un contrôle mauvais, même seuil. Une alerte non persistée par le centre d'alerte est retentée au tick suivant (pas d'attente de 15 min). Contexte enrichi : `androidState`, `androidDevice`. |
| `TextoGatewayHealth` (API) et `admin-sms.service.ts` (web) | Champs **facultatifs** `device.state / selectedId / selectedName / selection / offlineAfterSeconds`, `sim.cards / configuredPresent` : un relais antérieur reste lisible, `fresh` suffit au verdict. |
| Écran `/admin` → SMS | Le libellé dit **pourquoi** : « ping périmé », « hors ligne — plus aucun contact », « plusieurs appareils enrôlés, aucun désigné », « appareil désigné introuvable », « SIM N configurée absente ». Nomme l'appareil du verdict et son mode de sélection. |

L'interlock des coupes automatiques (`assertAutomaticCutSafe`) est inchangé : il lit
`gateway.operational` avec un cache de 30 s ; sa raison profite du nouveau `error` du relais.

## Ce que ce correctif garantit — et ne garantit pas

- Garanti : un téléphone qui ne pingue qu'à son pull de secours produit **une** alerte puis un
  rappel toutes les 15 min — plus un CRITICAL par pull. Un ping manqué isolé n'ouvre rien.
- Garanti : le verdict de santé ne peut plus être fabriqué par un autre appareil que celui
  désigné ; deux appareils sans `CAPCOM6_DEVICE_ID` = refus explicite (**T43 doit renseigner
  `CAPCOM6_DEVICE_ID`** ; en attendant, un seul appareil enrôlé suffit).
- Garanti : `CAPCOM6_DEVICE_STALE_SECONDS` ne peut plus désactiver la fraîcheur.
- Non garanti : l'interlock n'a pas d'hystérésis propre — il est évalué à la demande d'une CUT,
  avec 30 s de cache ; un battement y coûte au plus un report d'une minute, pas une alerte.
- Non garanti : `simCards` n'a été vérifié que sur le contrat public (v1.75) ; sur le serveur
  1.43.0 de production, sa présence dans `GET /devices` est **non vérifiée** — d'où le `null`
  qui ne refuse jamais.
- Toujours vrai : sans T43 (ping 60 s), le téléphone reste `STALE` la plupart du temps et
  l'interlock reste rouge — avec **une** alerte au lieu de quatre par heure. T44 rend la
  sentinelle honnête, T43 rend le téléphone joignable.

## Tests ajoutés (verts)

- Relais — `env.spec.ts` (3, nouveau) : défauts, valeurs absurdes ramenées aux bornes (dont
  offline jamais < stale), valeur illisible → défaut ; `capcom6.service.spec.ts` (+1) : l'envoi
  a son délai, plus long que les lectures ; `messages-health.service.spec.ts` (14, réécrite) :
  ONLINE / STALE / OFFLINE, appareil désigné vs téléphone de test frais, identifiant introuvable,
  plusieurs appareils sans identifiant, appareil supprimé, ping absent ou illisible, ping futur
  (petite avance tolérée, grande = UNKNOWN), SIM présente / absente / non exposée, serveur
  injoignable, serveur « fail ». **6 suites, 47 tests.**
- Tracky — `sms-gateway-watchdog.service.spec.ts` (9, réécrite) : un mauvais n'ouvre rien, deux
  ouvrent un épisode unique, pulls alternés = une alerte, stricte alternance = rien, fermeture à
  trois sains puis nouvel épisode, rappel à 15 min pas avant, contrôle qui lève = mauvais, alerte
  non persistée retentée, fournisseur ≠ relais = rien. API 8 suites SMS / 101 tests.

## Ce qu'il reste

T45 (preuve quotidienne + statuts poussés par le relais), T43 (téléphone, `CAPCOM6_DEVICE_ID`),
T47 (procédure, dont les nouvelles variables `CAPCOM6_DEVICE_OFFLINE_SECONDS` et
`CAPCOM6_SEND_TIMEOUT_MS`), puis la recette T54 — notamment 30 min écran éteint pour voir
`state` passer et rester `ONLINE` après T43.
