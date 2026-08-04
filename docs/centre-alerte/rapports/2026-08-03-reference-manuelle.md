# Audit du centre d'alerte — 2026-08-03 (référence manuelle)

> **Ce fichier est l'étalon**, pas un rapport quotidien. Il porte volontairement un suffixe
> (`-reference-manuelle`) pour ne pas déclencher la garde anti-doublon, qui ne reconnaît que
> `<AAAA-MM-JJ>.md`. Il sert à mesurer ce que l'agent automatique trouve — et ce qu'il rate.
>
> Produit à la main lors de la session de création du dispositif. Horodatages en **UTC**.

**Verdict :** le centre d'alerte affiche 12 lignes dont **aucune nouvelle famille de bug
applicatif** — mais il tait l'essentiel : **72 commandes `fix_continuous` échouent chaque jour
depuis des mois**, et l'écran annonce « Trackers FAILING : 0 ». Le seul défaut *visible* qui
mérite du code est le bruit de rafraîchissement de session ; le seul défaut *grave* est invisible.

## Chiffres

| | |
|---|---|
| Lignes `error_logs` | **12** (3 sur 24 h · 1 CRITICAL · fenêtre 2026-07-28 → 2026-08-03) |
| Sources distinctes | 5 — `gps-integrity` (5), `frontend` (4), `fuel-station` (1), `http` (1), `realtime-client` (1) |
| Trackers FAILING | **0** ⚠️ *chiffre trompeur, cf. TRK-008* |
| Trackers hors ligne > 1 h | **6**, dont **3 jamais mis en service** |
| Commandes en attente > 10 min | **2** (même boîtier, 3 h et 9 h d'ancienneté) |
| Commandes échouées / jour (7 j) | **72,3** — 506 sur 7 jours, **100 % d'échec** |
| Rétention `error_logs` | 30 j par défaut, non surchargée en prod |

## 🔴 À traiter

### 1. TRK-008 — 72 échecs/jour invisibles *(le point majeur)*
`fix_continuous` : **3564 commandes en FAILED** au total, 506 sur 7 jours, ~72/jour, **100 %
d'échec**. 36 boîtiers, chacun exactement à son plafond anti-flapping de 2 commandes/jour.

**Cause racine.** Deux chemins écrivent `desiredFixIntervalS` et **un seul est borné** :
`requestChange()` clampe entre `HARD_CAP_MIN_S = 20` (le minimum officiel du Coban GPS403D) et
300 s ; l'**auto-alignement** écrit l'observé brut avec `AUTO_ALIGN_FLOOR_S = 1`. Il peut donc
inscrire comme cible à faire respecter une valeur que le matériel n'atteindra jamais — et c'est
ce qu'on lit en base : cibles à **2 s, 4 s, 8 s, 12 s**. La bande de tolérance devient alors
inatteignable et le boîtier ne peut plus **jamais** converger.

**Preuve.** 295 des 506 échecs portent `intervalle observe: 20s` : un boîtier qui émet
*exactement à son minimum matériel* et qu'on déclare non conforme.

**Pourquoi c'est invisible.** L'auto-alignement remet `fixCommandFailing = false` → l'écran
affiche 0. Et la requête « commandes en attente » ne regarde que `PENDING`/`SENT` → les 3564
`FAILED` n'y figurent pas.

**Correctif proposé.** Séparer la consigne d'exploitation de l'intervalle accepté
(`acceptedFixIntervalS`), pour qu'accepter un boîtier veuille dire *arrêter de le juger* plutôt
que *le juger contre une nouvelle cible*. Correctif minimal possible (`AUTO_ALIGN_FLOOR_S` →
20 s) mais c'est un retour en arrière partiel, à faire en connaissance de cause.

### 2. TRK-007 — commandes `fix_continuous` bloquées en SENT à vie
2 commandes sur `864035052915643` / EY-613-MF, 195 min et 555 min d'ancienneté. **Aucun chemin
automatique ne les solde** : le Coban n'ACK pas, `acknowledgedAt` n'est posé que par un
acquittement manuel d'admin, et la seule fermeture automatique n'a lieu qu'à la transition
`fixCommandFailing` false→true. Si le boîtier ne rebascule jamais, la commande reste `SENT`
indéfiniment.

Aggravant : la colonne « Raison » affiche `outcomeReason`, écrit **à la création** avec le motif
du *déclenchement* (`STOPPED_TO_MOVING`). Le nom annonce un résultat, le contenu livre une cause
d'envoi. → **Correctif :** solder par échéance + afficher un champ qui parle vraiment du résultat.

### 3. TRK-002 — bruit de rafraîchissement de session
2 lignes (iPhone + Chrome). Le refresh proactif est un `setTimeout` armé 60 s avant expiration :
gelé quand l'appareil dort, **tiré au réveil**, avant que la connectivité soit rétablie. La garde
`navigator.onLine !== false` ne filtre rien — `onLine` dit « une interface est active », pas
« Internet est joignable ». → **Correctif :** un réessai à 3 s + la garde de visibilité que
`realtime.service.ts` applique déjà correctement, **uniquement sur le chemin proactif**.

### 4. TRK-004 — un refus délibéré journalisé comme une faute
« Le budget IA mensuel est atteint » est levé en `ServiceUnavailableException` (**503**), et
`all-exceptions.filter.ts` archive tout ≥ 500. La gouvernance IA qui fonctionne produit donc une
erreur. La porte voisine (« IA désactivée pour cette société ») a le même défaut et le produira
aussi. → **Correctif :** une garde `isExpectedRefusal()` sur le modèle exact de
`isUpstreamThrottle()`, **structurelle et non textuelle**.

## 🟠 Connu, correctif en attente

- **TRK-003** — `realtime-client` CRITICAL, 1 occurrence le 31/07. Incident réel (le client a
  déjà la bonne garde de visibilité), probablement charge VPS — 45 s pile, la valeur documentée
  sous 2 vCPU. Proposer un niveau nuancé plutôt que CRITICAL systématique sur `everConnected: false`.
- **TRK-005** — `fuel-station`, timeout de l'API publique des prix carburants. Message déjà
  excellent ; reste à le classer `transient` comme les autres aléas fournisseur.
- **TRK-009** — 3 des 6 « trackers hors ligne » n'ont jamais été mis en service (`lastSeenAt`
  NULL, sans véhicule). Ils gonflent le compteur d'un tiers avec du matériel sain.
- **TRK-010** — `ERROR_LOGS_RETENTION_DAYS` = 30 par défaut, non défini en prod : **une erreur
  jamais corrigée s'efface toute seule à J+30**. La consigne « ne pas clear » est contournée par
  le ménage automatique. Le référentiel est la parade.

## ⚪ Bruit / 🔵 Terrain

- **TRK-006 (🟢)** — les 2 `NG02100` sur `/admin/subscriptions` sont **déjà corrigées**
  (`registerLocaleData(localeFr)` + `LOCALE_ID: 'fr'`). Vérifié : les chunks cités dans les piles
  sont **absents** du bundle servi, daté du 03/08 19:28. Lignes historiques, aucune action.
- **TRK-001 (🔵)** — 5 alertes « GPS perdu », 3 véhicules. **FZ-862-VY est en cours** (dernière
  position 17:34, ~3 h sans fix) → antenne à vérifier. KSR370 (3 épisodes en 3 jours) et
  HD-779-MA sont repartis. Détecteur sain, ne pas y toucher.
- **🔵 Hors ligne long** — FV-941-LZ muet depuis le 28/04 (connu, planning actif, décision métier
  assumée), FL-787-KV depuis le 05/06, `864035054756292` depuis le 01/07.

## Angles morts examinés

| Vérifié | Verdict |
|---|---|
| Commandes `FAILED` (absentes de tout écran) | 🔴 **506/7 j, 100 % d'échec** → TRK-008 |
| Dérive de `desiredFixIntervalS` | 🔴 **4 boîtiers sous le minimum matériel** (2/4/8/12 s) |
| Corrélation erreurs ↔ redéploiements | web rebuild 19:28, api 19:38 ; aucune erreur ne coïncide |
| Bundle servi vs commits | chunks des piles NG02100 **absents** → correctif bien en ligne |
| Rétention des journaux | 🟠 purge à 30 j non surchargée → TRK-010 |
| État réel des GPS perdus | 1 en cours sur 3 |

## Fiches ajoutées ou mises à jour

TRK-001 → TRK-010 — **amorçage du référentiel** (10 fiches créées).
