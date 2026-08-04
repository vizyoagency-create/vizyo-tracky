# Référentiel des erreurs — Centre d'alerte Tracky

> Mémoire longue du centre d'alerte. Une erreur qui apparaît en prod se retrouve ici, avec sa
> cause racine et son correctif. À chaque passage, l'audit compare ce qu'il voit à ce fichier :
> **signature connue → on met à jour les compteurs ; signature inconnue → on enquête et on ajoute
> une fiche.**
>
> Il existe parce que la table `error_logs` **ne garde rien** : `ERROR_LOGS_RETENTION_DAYS`
> vaut 30 par défaut et n'est pas défini en prod, donc une erreur jamais corrigée s'efface
> toute seule à J+30. Ce fichier, lui, survit à la purge.

- Procédure d'audit : [`PROCEDURE-AUDIT.md`](./PROCEDURE-AUDIT.md)
- Rapports quotidiens : [`rapports/`](./rapports/)
- Dernière mise à jour : **2026-08-03**

---

## Comment lire une fiche

**Signature** — l'empreinte stable d'une erreur, *après normalisation* (plaques, IMEI, UUID,
durées et nombres remplacés par des jetons). C'est la clé d'identité : deux lignes qui ont la
même signature sont le même problème, même si leurs textes diffèrent.

**Statut** — le seul champ qui décide si on agit :

| Statut | Sens | Ce que fait l'audit |
|---|---|---|
| 🔴 **NON CORRIGÉ** | Défaut réel, aucun correctif livré | Remonte en tête du rapport, propose le correctif |
| 🟠 **CORRECTIF PROPOSÉ** | Cause connue, correctif écrit ici, pas encore livré | Rappelle la proposition, ne ré-enquête pas |
| 🟢 **CORRIGÉ** | Correctif livré ET vérifié en prod | Silencieux — sauf réapparition, qui devient une **régression** (🔴 immédiat) |
| ⚪ **BRUIT ACCEPTÉ** | Pas une faute ; on assume de le voir | Compte, ne propose rien |
| 🔵 **TERRAIN** | Vrai signal, mais l'action est matérielle/métier, pas du code | Liste l'action, n'écrit pas de code |

**Règle absolue** — on ne supprime **jamais** une ligne de `error_logs` tant que le défaut
n'est pas corrigé *et vérifié*. Le centre d'alerte n'est pas une boîte de réception à vider.

---

## Index

| ID | Source | Signature courte | Statut | Vu la 1ʳᵉ fois | Dernière |
|---|---|---|---|---|---|
| [TRK-001](#trk-001) | `gps-integrity` | GPS perdu — boîtier vivant sans fix | 🔵 TERRAIN | 2026-07-28 | 2026-08-03 |
| [TRK-002](#trk-002) | `frontend` | Rafraîchissement de session — API injoignable | 🔴 NON CORRIGÉ | 2026-07-29 | 2026-08-03 |
| [TRK-003](#trk-003) | `realtime-client` | Canal temps réel JAMAIS établi | 🟠 PROPOSÉ | 2026-07-31 | 2026-07-31 |
| [TRK-004](#trk-004) | `http` | Budget IA mensuel atteint (503) | 🔴 NON CORRIGÉ | 2026-07-29 | 2026-07-29 |
| [TRK-005](#trk-005) | `fuel-station` | API prix carburants injoignable | 🟠 PROPOSÉ | 2026-07-28 | 2026-07-28 |
| [TRK-006](#trk-006) | `frontend` | NG02100 sur `/admin/subscriptions` | 🟢 CORRIGÉ | 2026-07-29 | 2026-07-30 |
| [TRK-007](#trk-007) | *commandes* | `fix_continuous` bloquée en SENT à vie | 🔴 NON CORRIGÉ | 2026-08-03 | 2026-08-03 |
| [TRK-008](#trk-008) | *commandes* | Boucle `fix_continuous` — 72 échecs/jour invisibles | 🔴 NON CORRIGÉ | 2026-08-03 | 2026-08-03 |
| [TRK-009](#trk-009) | *trackers* | Boîtiers « hors ligne » jamais mis en service | 🟠 PROPOSÉ | 2026-08-03 | 2026-08-03 |
| [TRK-010](#trk-010) | *plateforme* | La rétention efface les erreurs non corrigées | 🟠 PROPOSÉ | 2026-08-03 | 2026-08-03 |

---

## TRK-001

**Signature** — `gps-integrity | ERROR | GPS perdu : <PLAQUE> (<IMEI>) — boîtier vivant mais sans position GPS depuis <DURÉE>. Antenne à vérifier.`
**Statut : 🔵 TERRAIN** · 5 occurrences · 3 véhicules · 2026-07-28 → 2026-08-03

### Ce que ça veut dire
Le boîtier Coban parle (`lastSeenAt` frais, trames `no_fix` LBS) mais n'a plus de verrou GPS :
la dernière position reste figée. Détecté par `gps-integrity.service.ts`.

### Ce n'est pas un bug
Le détecteur fait exactement son travail, et il est déjà bien borné :
- une zone morte confirmée bénigne (parking souterrain) **éteint** l'alerte (`CONFIRMED_BENIGN`) ;
- une zone récurrente non suspecte ne remonte **pas** au centre admin, seulement à l'alerte flotte ;
- `createGpsLostAlert` déduplique **par épisode** — une seule ligne par perte, pas une par tick.

### État constaté le 2026-08-03
| IMEI | Plaque | Verdict |
|---|---|---|
| `864035054756102` | FZ-862-VY | **En cours** — dernière position 17:34, `lastNoFixAt` 20:25 → ~3 h sans fix |
| `864035054489449` | HD-779-MA | Reparti (position fraîche) |
| `864035053277480` | KSR370 | Reparti (position fraîche) — 3 épisodes distincts en 3 jours |

### Action
**Terrain, pas code.** Antenne GPS à vérifier sur FZ-862-VY ; KSR370 récidive (3 épisodes en
3 jours) → candidat au même contrôle.

### ⚠️ Ne pas « corriger » en silenciant
Ce détecteur a été explicitement mis hors périmètre de la passe du 2026-07-27 : c'est un vrai
signal matériel. Baisser son niveau ou élargir sa dédup ferait disparaître la seule chose qui
rende visible une antenne morte. *Corriger un message ≠ affaiblir une garde.*

---

## TRK-002

**Signature** — `frontend | ERROR | [api-fetch] Error: Rafraichissement de session — API injoignable : TypeError: <TYPE>`
(`<TYPE>` = `Load failed` sur Safari/iOS, `Failed to fetch` sur Chrome — même défaut)
**Statut : 🔴 NON CORRIGÉ** · 2 occurrences · 2026-07-29 → 2026-08-03

### Chaîne d'appel
`auth.service.ts` → `scheduleProactiveRefresh()` arme un `setTimeout` **~60 s avant l'expiration**
du token → `proactiveTick()` → `doRefresh()` → `apiFetchRaw('/api/auth/refresh', …, 'Rafraichissement de session')`
→ `api-fetch.ts` rattrape l'échec réseau et appelle `reportClientError('api-fetch', …)`.

### Cause racine
Un minuteur `setTimeout` est **gelé** quand l'onglet passe en arrière-plan ou que l'appareil
dort, puis **tiré au réveil** — c'est-à-dire à l'instant précis où la connectivité n'est pas
encore rétablie. Le rafraîchissement part dans le vide et échoue au niveau transport.

La garde censée filtrer ça ne filtre rien :

```ts
// api-fetch.ts
if (typeof navigator === 'undefined' || navigator.onLine !== false) {
  reportClientError('api-fetch', new Error(`${label} — API injoignable : ${describe(err)}`));
}
```

`navigator.onLine` dit seulement « une interface réseau est active » — il vaut `true` sur un
iPhone qui vient de se réveiller et n'a pas encore de route utilisable. La condition est donc
vraie, et on archive une ERREUR pour un hoquet que personne ne peut corriger.

### Preuves
- Les deux occurrences portent des UA distincts (iPhone iOS 18.7 / Chrome Windows) — donc pas
  un bug de navigateur, un défaut de conception du report.
- `TypeError: Load failed` est la signature Safari d'une requête **tuée**, pas refusée.
- Aucun 5xx correspondant côté serveur au même horodatage : le serveur n'a jamais reçu l'appel.
- La session n'est **pas** perdue pour autant : `doRefresh` pose `_refreshUnavailable` et ne
  déconnecte personne (commentaire explicite dans `auth.service.ts`). L'utilisateur ne voit rien.

### Correctif proposé
1. **Réessayer une fois avant de crier.** Sur échec *transport* du refresh **proactif**
   (pas celui déclenché par un 401 dans l'interceptor), attendre ~3 s et retenter. Ne remonter
   qu'au second échec. Un réveil d'appareil se résorbe en bien moins que ça.
2. **Reprendre la garde de visibilité qui existe déjà et qui marche.**
   `realtime.service.ts` fait exactement ce qu'il faut :
   `if (typeof document !== 'undefined' && !this.visibility.isVisible()) return;`
   — appliquer la même condition avant `reportClientError` dans `api-fetch.ts`.
   ⚠️ **Uniquement sur le chemin proactif** : une panne réelle vécue au premier plan doit
   continuer à remonter, c'est la raison d'être de ce module.

### Comment vérifier après correctif
Aucune nouvelle ligne de cette signature sur 7 jours, **alors qu'une vraie coupure d'API
(redéploiement) continue d'en produire**. Le second point est le vrai test : un correctif qui
supprime les deux cas a rendu le module inutile.

---

## TRK-003

**Signature** — `realtime-client | CRITICAL | Canal temps réel JAMAIS établi (<DURÉE>s) — API/WS injoignable — reason=<R>, transport=<T>, flaps=<N>, err=<E>`
**Statut : 🟠 CORRECTIF PROPOSÉ** · 1 occurrence · 2026-07-31 13:00

### Contexte
`realtime-incident.controller.ts` force le niveau **CRITICAL** dès que `everConnected === false` :

```ts
const level = neverConnected || (body.downMs ?? 0) >= 120_000 ? 'CRITICAL' : 'ERROR';
```

L'occurrence relevée : `downMs=45001`, `flaps=0`, `transport=websocket`, `err=timeout`, sur `/map`.

### Ce qui est déjà correct — et qu'il ne faut pas défaire
Le client **ne remonte pas** en arrière-plan (`armIncidentTimer` + `reportRealtimeIncident`
vérifient `visibility.isVisible()`). Donc contrairement au faux positif « onglet en arrière-plan »
connu, **cet incident a bien été vécu au premier plan** : quelqu'un a regardé une carte sans live
pendant 45 s. Le signal est réel.

### Cause probable
Charge VPS. `redis-io.adapter.ts` documente déjà que sous 2 vCPU l'API rate un pong et que
« tous les incidents tombent pile à 45 s » — ce qui est exactement la valeur observée
(`INCIDENT_DELAY_MS`).

### Correctif proposé
Nuancer le niveau, sans supprimer l'alerte. Un premier chargement de page qui met 45 s à établir
son WebSocket n'est pas du même ordre qu'une plateforme injoignable :

- **CRITICAL** si `everConnected === false` **et** (`downMs ≥ 120 s` **ou** au moins un second
  report pour la même flotte dans la fenêtre de dédup) ;
- **ERROR** sinon.

Le corps du message conserve `everConnected` — l'information n'est pas perdue, seul le cri baisse.

### Seuil de ré-escalade
Si cette signature dépasse **3 occurrences sur 24 h**, ce n'est plus un aléa : c'est la charge
VPS, et le sujet devient le dimensionnement (voir la piste « offline = TCP / VPS 2 vCPU saturé »).

---

## TRK-004

**Signature** — `http | ERROR | Le budget IA mensuel est atteint. L'analyse sera de nouveau possible le mois prochain, ou après relèvement du budget.` (`statusCode: 503`)
**Statut : 🔴 NON CORRIGÉ** · 1 occurrence · 2026-07-29

### Cause racine — une décision volontaire journalisée comme une faute
`place-analysis.service.ts` protège la dépense IA en levant un refus explicite :

```ts
if (await this.monthBudgetExhausted()) {
  throw new ServiceUnavailableException("Le budget IA mensuel est atteint. …");
}
```

`ServiceUnavailableException` porte un **503**. Et `all-exceptions.filter.ts` archive tout ce qui
est ≥ 500 :

```ts
if ((status >= 500 || !(exception instanceof HttpException)) && !isUpstreamThrottle(exception)) {
```

Le filtre sait déjà distinguer un 5xx *volontaire* (→ `ERROR`) d'un crash (→ `CRITICAL`)… mais il
**archive les deux**. Résultat : la gouvernance IA qui fonctionne parfaitement — le plafond tient,
l'utilisateur est prévenu — produit une erreur au centre d'alerte. Un plafond atteint n'est pas
une panne.

### Portée réelle (plus large qu'une ligne)
Le **même** défaut existe 6 lignes plus haut dans le même fichier : la porte
« l'assistance IA est désactivée pour cette société » lève aussi un 503. Elle n'a pas encore
produit de ligne, mais elle le fera. Tout refus métier habillé en 5xx est concerné.

### Correctif proposé
Reprendre **exactement** le patron qui existe déjà et qui a fait ses preuves — `isUpstreamThrottle()`
dans le même filtre, ajouté après l'incident des ~100 fausses CRITICAL au redéploiement du
2026-07-15 :

1. Ajouter une garde `isExpectedRefusal(exception)` dans `all-exceptions.filter.ts`, sur le
   modèle de `isUpstreamThrottle`, qui exclut de l'archivage les refus délibérés.
2. **Structurel, pas textuel.** Reconnaître le message serait fragile et attraperait des refus
   légitimes au passage — c'est le raisonnement déjà écrit en tête de `error-logger.service.ts`
   pour `isTransient`. Faire porter à l'exception une propriété (`expected: true`), posée par une
   `AiBudgetExhaustedException` / `AiDisabledException` dédiée.
3. La réponse HTTP au client **ne change pas** : seule la journalisation disparaît.

### Alternative envisagée puis écartée
Passer ces refus en 4xx (402 / 429) supprimerait le symptôme sans toucher au filtre. Écarté :
le front distingue déjà « API en panne » (5xx) de « refusé » (4xx) sur d'autres chemins, et
`auth.service.ts` s'appuie explicitement sur `status >= 500` pour décider de **ne pas déconnecter**.
Déplacer un statut a des effets à distance ; ajouter une garde n'en a pas.

---

## TRK-005

**Signature** — `fuel-station | ERROR | Passages en station non détectés : API publique des prix carburants injoignable sur <N> arrêt(s) — aucun plein n'est affirmé sur ce trajet, le reste de l'analyse est conservé. Cause : <CAUSE>`
**Statut : 🟠 CORRECTIF PROPOSÉ** · 1 occurrence · 2026-07-28 (avant la passe de correction du 27/07 ? non — juste après)

### Le message est bon
Il nomme la dépendance, la conséquence exacte (« aucun plein affirmé ») et ce qui est préservé
(« le reste de l'analyse est conservé »). C'est le résultat de la passe du 2026-07-27 sur les
messages bruts, et il faut le garder tel quel.

### Ce qui reste à corriger, c'est le classement
`This operation was aborted` = timeout d'une **API publique tierce** (prix carburants). Ni un bug
Tracky, ni une action à mener. C'est exactement la définition du contrat `transient` déjà posé
dans `error-logger.service.ts` — et déjà appliqué au 400 IA « Grammar compilation timed out »,
classé aléa fournisseur.

### Correctif proposé
Marquer cet échec `transient: true` à la levée → journalisé dans le conteneur, **non archivé**.
Le garde-fou existe déjà en aval : `error-rate-watchdog` réagit à un taux d'échec anormal, donc
une vraie panne durable de l'API carburants reste détectable sans polluer le centre au coup par coup.

### ⚠️ Piège
Ne pas reconnaître « aborted » dans le texte. Le contrat est **structurel** (une propriété sur
l'erreur), volontairement, pour la raison écrite en tête de `error-logger.service.ts`.

---

## TRK-006

**Signature** — `frontend | ERROR | [uncaught] Error: NG02100` · page `/admin/subscriptions`
**Statut : 🟢 CORRIGÉ** · 2 occurrences · 2026-07-29 et 2026-07-30

### Cause racine
NG02100 = `InvalidPipeArgument`. `admin-subscriptions.component.ts` demande explicitement la
locale française à deux endroits :

```html
{{ totalRevenueYear() | number : '1.0-0' : 'fr' }}
```

Angular n'embarque que `en-US`. Sans `registerLocaleData(localeFr)`, `formatNumber` lève
« Missing locale data » — que `DecimalPipe.transform` **réemballe** en NG02100. Le premier de ces
deux pipes affiche le **revenu annuel total en haut de page** : l'écran de pilotage commercial
cassait donc à l'affichage.

### Pourquoi rien ne l'a vu
`ng build` ne charge pas les locales et `tsc` ne lit pas les gabarits : l'erreur n'existe qu'à
l'exécution du pipe, sur cette page précise.

### Correctif livré
- `registerLocaleData(localeFr)` dans `main.ts` (commit `bb8c6c1`) ;
- `{ provide: LOCALE_ID, useValue: 'fr' }` dans `app.config.ts` (commit `6d2d57f`) — posé ensuite
  parce que les affichages *sans* locale explicite sortaient en format anglais : l'écran Rapports
  affichait « 27,944.4 km », qu'un francophone lit mille fois plus petit.

### Vérifié en prod le 2026-08-03
Les chunks cités dans les piles archivées (`chunk-L4A3VVAY.js`, `chunk-64WXMCK5.js`) sont
**absents** du bundle servi ; le bundle courant date du 2026-08-03 19:28 et contient bien
`registerLocaleData`. Les 2 lignes restantes sont donc de l'historique — à conserver comme trace,
pas à traiter.

### Régression à surveiller
Toute réapparition de NG02100 = 🔴 immédiat. Deux causes possibles : un nouveau pipe avec une
locale non enregistrée, ou une date non parsable passée à `DatePipe`.

---

## TRK-007

**Signature** — `COMMAND_PENDING | fix_continuous | SENT | acknowledgedAt IS NULL | âge > 10 min`
**Statut : 🔴 NON CORRIGÉ** · 2 commandes · même boîtier `864035052915643` / EY-613-MF · 2026-08-03

### Cause racine — aucun chemin automatique ne solde une `fix_continuous`
La commande déclare pourtant comment elle devrait être confirmée :

```ts
expectedResult: `intervalle ~${target}s observe sur les 3 prochaines trames`
```

Mais **rien n'écrit jamais cette observation dans la commande.** Inventaire des écritures de statut :

| Écriture | Fichier | Déclencheur |
|---|---|---|
| `ACKNOWLEDGED` | `tracker-commands.service.ts` | ACK attendu sur le fil — **jamais pour `fix_continuous`** (pas d'`expectedAckPattern`) |
| `acknowledgedAt` | `admin-alerts.controller.ts` | **Acquittement manuel** par un admin, uniquement |
| `FAILED` | `positions.service.ts` | Seulement à la **transition** `fixCommandFailing` false→true |

Conclusion : si le boîtier ne bascule jamais FAILING, la commande reste `SENT` **à vie** et
s'affiche indéfiniment au centre d'alerte. C'est le cas ici (3 h et 9 h d'ancienneté).

### Défaut aggravant — la colonne « Raison » ment
Le centre d'alerte affiche `outcomeReason`. Or `outcomeReason` est écrit **à la création**
(`tracker-fix-mode.service.ts`), avec le motif du **déclenchement** :

```ts
outcomeReason: reason,   // ex. 'STOPPED_TO_MOVING'
status: TrackerCommandStatus.PENDING,
```

Le nom du champ annonce un résultat, le contenu livre un déclencheur. Un admin lit
`STOPPED_TO_MOVING` comme *la cause du blocage* alors que c'est *la raison de l'envoi*.
C'est la famille « message qui ment » de la passe du 2026-07-27, jamais purgée sur ce chemin.

### Correctif proposé
1. **Solder par échéance.** Toute `fix_continuous` encore `SENT` au-delà d'un plafond
   (2 × `desiredFixIntervalS`, plancher ~15 min) est close en `FAILED` avec `observedResult`
   = l'intervalle réellement observé. Une commande sans ACK doit avoir une fin, sinon la file
   d'attente du centre d'alerte n'est plus une file d'attente.
2. **Afficher ce qui parle du résultat.** Renommer la colonne en « Motif d'envoi », ou afficher
   `diagnosticHint` / `observedResult`, qui décrivent bien l'état constaté.

### ⚠️ Contexte à ne pas perdre
Le Coban n'ACK pas de façon fiable — c'est un fait matériel documenté (Sprint 2 : confirmation
par chute d'ignition faute d'ACK). Le correctif n'est donc **pas** d'attendre un ACK : c'est de
donner une échéance à l'attente.

---

## TRK-008

**Signature** — `fix_continuous | FAILED | observedResult = "Tracker FAILING — <N> trames non conformes"` — **en volume**
**Statut : 🔴 NON CORRIGÉ** · ~72/jour · 506 sur 7 jours · **3564 au total** · découvert 2026-08-03

> ### C'est le point le plus important de cet audit, et le centre d'alerte n'en dit rien.

### Les chiffres (prod, 2026-08-03)
- `fix_continuous` : **3564 en FAILED**, 2 en SENT, 30 acquittées manuellement — *depuis toujours*.
- **506 échecs sur 7 jours**, ~72/jour, tous les jours, sans exception.
- **100 %** portent le même `observedResult` : `Tracker FAILING — 3 trames non conformes`.
- 36 boîtiers concernés, chacun à **exactement 14 commandes / 7 jours = 2 par jour** —
  c'est-à-dire **le plafond anti-flapping** (`FLAPPING_MAX_CHANGES`). Le système tape son quota
  maximum, tous les jours, pour rien.

### Pourquoi c'est invisible
- `fixCommandFailing` vaut **`false` pour les 43 boîtiers** → le centre d'alerte affiche
  « Trackers FAILING : 0 ».
- La requête « commandes en attente » ne regarde que `PENDING`/`SENT` → les 3564 `FAILED` n'y
  sont pas.

**Une panne chronique qui tourne depuis des mois ne produit aucune alerte.** C'est l'exact inverse
du défaut de juillet (des alertes qui ne nommaient pas leur cause) : ici, une cause réelle
ne produit aucune alerte.

### Cause racine — l'auto-alignement écrit une cible que le matériel ne peut pas tenir

Deux chemins écrivent `desiredFixIntervalS`, et **un seul des deux est borné** :

| Chemin | Ce qu'il écrit | Borné ? |
|---|---|---|
| `requestChange()` — la logique adaptative | `Math.min(Math.max(HARD_CAP_MIN_S, desiredS), HARD_CAP_S)` → toujours **20 / 30 / 300 s** | ✅ oui |
| **auto-alignement** (`positions.service.ts`) | l'intervalle **observé brut**, plancher `AUTO_ALIGN_FLOOR_S = 1` | ❌ **non** |

Or `HARD_CAP_MIN_S = 20` **est le minimum officiel du Coban GPS403D**, documenté comme tel dans
le fichier. L'auto-alignement peut donc inscrire comme *cible à faire respecter* une valeur que
le boîtier n'atteindra jamais — et c'est exactement ce qu'on lit en base :

| `desired` (cible) | `current` (réel) | Boîtiers | |
|---|---|---|---|
| **2 s** | 30 s | 2 | 🔴 sous le minimum matériel |
| **4 s** | 5 s | 1 | 🔴 |
| **8 s** | 20 s | 1 | 🔴 |
| 12 s | 21 s | 1 | 🔴 |
| 28 s | 331 s | 1 | |
| 20 / 21 / 19 s | 20 s | 18 | ✅ sain |

Une fois `desired = 12`, la bande de tolérance vaut [9,6 s ; 14,4 s]. Le boîtier émet à sa
cadence normale de 20 s → hors bande → 3 trames → `FAILING`. **Il ne peut plus jamais converger.**

### La boucle
1. `reconcile()` marque `FAILING` (3 trames hors bande, tolérance ±20 %).
2. `positions.service.ts` ferme les commandes `SENT`/`PENDING` en `FAILED`.
3. L'auto-alignement écrit l'observé dans `desired` et remet `fixCommandFailing = false`
   → **plus rien à voir au centre d'alerte**.
4. Le prochain changement d'état (`STOPPED` → `MOVING`) rappelle `requestChange()`, qui réécrit
   20 s… et tout recommence, jusqu'au plafond de 2 commandes/jour.

### Ce que confirme la répartition des échecs
Sur 506 échecs en 7 jours, **295 portent `intervalle observe: 20s`** — c'est-à-dire un boîtier
qui émet **exactement à son minimum matériel** et qu'on déclare pourtant non conforme, parce que
la cible enregistrée est descendue plus bas que ce minimum. Le reste s'échelonne sur 30 s, 21 s,
19 s, 10 s, 5 s, 2 s : la même dérive à différents stades.

### Le défaut de conception, en une phrase
> L'auto-alignement confond **« accepter ce que fait le boîtier »** et **« en faire la cible à
> faire respecter »**. Accepter devrait vouloir dire *arrêter de juger* — pas *juger contre une
> nouvelle valeur*.

### Coût
~72 écritures TCP/jour vers des boîtiers en 2G + 72 lignes DB/jour, pour zéro effet. Et surtout :
**la cadence d'échantillonnage réellement appliquée n'est plus celle décidée**, sans que rien ne
le signale.

### Correctifs proposés
1. **Séparer la cible de l'observé.** `desiredFixIntervalS` est la consigne d'exploitation
   (20 / 30 / 300) ; l'intervalle accepté doit vivre dans un champ distinct
   (`acceptedFixIntervalS`). `reconcile()` juge alors contre l'accepté quand il existe, et
   `requestChange()` reste seul maître de la consigne. C'est le correctif de fond : il supprime
   la boucle sans rien retirer.
2. **Un boîtier « accepté » ne se juge plus.** Plutôt que de réécrire une cible, poser un
   indicateur (« ce boîtier n'honore pas la consigne, on prend ce qu'il donne ») qui **désarme
   le compteur d'échec** au lieu de le relancer contre une nouvelle valeur.
3. **Rendre la boucle visible.** Une famille d'alerte « boîtier qui n'honore jamais sa cadence »,
   fondée sur le **taux de `FAILED` sur 24 h** — et non sur le drapeau `fixCommandFailing`, que
   l'auto-alignement efface avant que quiconque puisse le lire.

### Correctif minimal, si l'on ne veut toucher qu'une ligne
Porter `AUTO_ALIGN_FLOOR_S` de `1` à `HARD_CAP_MIN_S` (20 s) : l'auto-alignement ne pourrait plus
écrire une cible sous le minimum matériel, ce qui élimine à lui seul les cas 2 s / 4 s / 8 s / 12 s.

⚠️ **Mais c'est un retour en arrière partiel, à faire en connaissance de cause.** Ce plancher
*était* à `HARD_CAP_MIN_S` et a été **volontairement abaissé à 1** (V1.15) pour sortir les
boîtiers qui émettent plus vite que demandé (2 s / 10 s) et restaient `FAILING` à vie, incapables
de converger comme de s'aligner. Le remonter les y renverrait. C'est pourquoi le correctif 1 est
préférable : il résout les deux situations au lieu de les échanger.

### Vérification après correctif
`SECTION commandes_sante_7j` doit tomber **bien en dessous de 72 échecs/jour**, et
`SECTION cadence_derive` ne doit plus afficher aucune ligne `cible_suspecte = t`. Un correctif
qui ferait seulement disparaître les lignes du centre d'alerte sans faire baisser le compteur
d'échecs n'aurait rien réglé — il aurait juste éteint le témoin.

---

## TRK-009

**Signature** — `TRACKER_OFFLINE | lastSeenAt IS NULL | vehicleId IS NULL`
**Statut : 🟠 CORRECTIF PROPOSÉ** · 3 boîtiers sur 6 · 2026-08-03

### Constat
La section « Trackers OFFLINE > 1 h » du centre d'alerte comptait 6 boîtiers. Trois d'entre eux
(`864035054756027`, `864035054576169`, `864035054756197`) ont `lastSeenAt = NULL` et **aucun
véhicule rattaché** : ce sont des boîtiers en stock, **jamais mis en service**.

Ils ne sont pas *tombés* — ils ne se sont jamais levés. Les compter comme « hors ligne » gonfle
le compteur d'un tiers avec du matériel qui va parfaitement bien.

### Les 3 autres sont de vraies pannes terrain (🔵)
| IMEI | Plaque | Muet depuis |
|---|---|---|
| `864035053276839` | FV-941-LZ | 2026-04-28 — **connu**, planning actif, décision métier assumée |
| `863378070030776` | FL-787-KV | 2026-06-05 |
| `864035054756292` | *(aucune)* | 2026-07-01 |

### Correctif proposé
Exclure de l'alerte « hors ligne » les boîtiers jamais vus **et** non rattachés à un véhicule
(`lastSeenAt IS NULL AND vehicleId IS NULL`) dans `admin-alerts.controller.ts`. Les exposer
plutôt comme « en stock, jamais mis en service » — c'est une information d'inventaire, pas une
panne.

⚠️ Garder l'alerte pour un boîtier `lastSeenAt IS NULL` **rattaché à un véhicule** : là, c'est
une pose qui a échoué, et c'est un vrai signal.

---

## TRK-010

**Signature** — *(défaut de plateforme, pas une ligne d'erreur)*
**Statut : 🟠 CORRECTIF PROPOSÉ** · 2026-08-03

### Le centre d'alerte se vide tout seul
`ERROR_LOGS_RETENTION_DAYS` a pour défaut **30 jours** (`env.validation.ts`) et **n'est pas
défini** dans l'environnement du conteneur `tracky-api`. `log-cleanup.service.ts` supprime donc
chaque nuit tout ce qui dépasse 30 jours :

```ts
this.prisma.errorLog.deleteMany({ where: { createdAt: { lt: errorThreshold } } })
```

Conséquence directe : **une erreur jamais corrigée disparaît d'elle-même à J+30.** La consigne
« on ne clear pas tant que ce n'est pas corrigé » est contournée par le ménage automatique — et
sans bruit, puisque personne ne remarque une ligne qui s'efface.

### Parade déjà en place
Ce référentiel. Une fiche survit à la purge, garde la date de première apparition et le compteur
cumulé. C'est précisément pour ça qu'il existe.

### Correctif proposé (optionnel)
Si l'on veut aussi garder les *lignes* : porter `ERROR_LOGS_RETENTION_DAYS` à 90 dans
`deploy/vps/.env.prod`. Sans surprise de volume — 12 lignes en 6 jours, on est très loin d'un
problème de place.

---

## Journal des passages

| Date | Lignes `error_logs` | Signatures connues | Nouvelles | Ajoutées par |
|---|---|---|---|---|
| 2026-08-03 | 12 | — | 10 (amorçage) | audit manuel (session de création) |
