# Roadmap des correctifs — audit du 2026-08-20

> Plan d'exécution des six correctifs issus du rapport du [20/08](./rapports/2026-08-20.md).
> Chaque lot porte : **pourquoi**, **où** (fichier `:ligne`), **le geste**, **comment on prouve que
> c'est réparé**, et **ce qu'il ne faut surtout pas faire**.
>
> Référentiel : [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) · Méthode : [`PROCEDURE-AUDIT.md`](./PROCEDURE-AUDIT.md)

---

## ⚠️ À lire avant d'écrire la première ligne de code

**Le dépôt local est en retard sur la production.** Mesuré le 20/08 :

| | |
|---|---|
| `main` **local** | `896d57e3` |
| `main` **servi en production** | `f71ddc3` |
| Fichier `apps/api/src/alerts/alarme-alimentation.ts` | **absent en local**, présent en prod |

Les correctifs du 19/08 — ceux-là mêmes que les lots 1 et 6 viennent amender — **n'existent pas
encore dans l'arbre local**. Partir de l'état actuel produirait un conflit ou, pire, réécrirait par
inadvertance le travail de la veille.

**Premier geste, avant tout le reste :**

```bash
git fetch origin && git log --oneline main..origin/main | head -40
```

Puis créer chaque branche de lot **depuis `origin/main` à jour**, jamais depuis la branche courante.

> 🔑 C'est la leçon de [TRK-019](./REFERENCE-ERREURS.md#trk-019), rejouée à l'envers : ce dossier a
> déjà perdu quatre correctifs vérifiés parce qu'une image avait été construite depuis une branche
> forkée. **Vérifier de quoi on part coûte une commande et a déjà coûté une semaine.**

### Règles de travail

| Règle | Pourquoi |
|---|---|
| **Une branche par lot**, jamais un fourre-tout | Les lots 1 et 4 touchent le coupe-circuit ; il faut pouvoir en relire un sans l'autre. |
| **Aucun merge automatique en production** | Les lots 1 et 4 modifient une garde de sécurité — relecture humaine obligatoire. |
| `pnpm -w typecheck` **ne couvre pas le web** | Pas de script `typecheck` dans `apps/web` : la validation des gabarits, c'est **`ng build`** (lot 5). |
| Lancer la suite de tests **seule** | Le harnais est instable en parallèle ; en cas d'échec douteux, relancer la suite seule avant de conclure. |
| **Jamais de migration écrite à la main** | Passer par l'outillage Prisma. Le lot 3 n'est **pas** une migration : c'est un script de réparation de données, à part. |

---

## Vue d'ensemble

| # | Lot | Fiche | Gravité | Effort | Risque | Dépend de |
|---|---|---|---|---|---|---|
| **1** | ✅ **FAIT** — Borner dans le temps la garde « coupure commandée » | [TRK-032](./REFERENCE-ERREURS.md#trk-032) | 🔴 **1** | S | **Élevé** — garde de sécurité | — |
| **2** | Rattacher l'accusé de réception SMS à sa commande | [TRK-036](./REFERENCE-ERREURS.md#trk-036) | 2 | M | Faible | — |
| **3** | Assainir puis borner la fermeture des épisodes GPS | [TRK-031](./REFERENCE-ERREURS.md#trk-031) | 2 | M | Moyen — écriture de données | — |
| **4** | Rendre visible toute disparition de lignes | [TRK-035](./REFERENCE-ERREURS.md#trk-035) | 🔴 **1** | S | Nul — lecture seule | — |
| **5** | Réparer `/admin/vps` et le rendre tolérant | [TRK-033](./REFERENCE-ERREURS.md#trk-033) | 2 | XS | Nul | — |
| **6** | Aligner la fenêtre de recalcul sur la rétention | [TRK-034](./REFERENCE-ERREURS.md#trk-034) | 3 | XS | Faible | — |

**Les six lots sont indépendants.** Aucun ne bloque l'autre : ils peuvent être menés en parallèle ou
dans n'importe quel ordre. L'ordre ci-dessus est celui de la **valeur décroissante**, pas d'une
contrainte technique.

**Si vous ne faites qu'une chose : le lot 1.** C'est le seul qui retire aujourd'hui une protection
réelle à 79 % de la flotte, et précisément la nuit.

**Le lot 5 est le meilleur rapport valeur/effort** — deux lignes, aucun risque, et un écran
d'exploitation qui remarche.

---

# Lot 1 — Borner dans le temps la garde « coupure commandée »

**Fiche : [TRK-032](./REFERENCE-ERREURS.md#trk-032) · Gravité 1 · Effort S · Risque ÉLEVÉ**

> ## ✅ FAIT le 2026-08-20 — commit `e88a5eec`
>
> **Branche `fix/trk-032-borne-coupure-commandee`, partie d'`origin/main` @ `42dcdb38`. NON poussée,
> NON déployée** — relecture humaine obligatoire (garde de sécurité).
>
> | | |
> |---|---|
> | Constante posée | `FENETRE_COUPURE_COMMANDEE_MS = 15 min`, dans `alerts.service.ts`, commentée avec la mesure qui la justifie |
> | Décision | `select: { action, createdAt }` puis comparaison de date — le contrat de `analyserAlimentation` reste **pur et sans horloge** |
> | `SENT` | **conservé** — voir la correction ci-dessous |
> | Tests | **6 nouveaux**, dont **2 qui échouent sur le code d'avant** (CUT de 6 h, CUT de 3 jours) — vérifié en remettant le service dans son état d'origine |
> | Vérifications | `tsc --noEmit` ✅ · **49 tests / 3 suites** ✅ (alerts, alarme-alimentation, **smoke-boot DI**) |
> | Autres appelants | **aucun** — `analyserAlimentation` n'est utilisé nulle part ailleurs |
>
> ⚠️ **Reste à faire côté production** : la vérification prescrite ci-dessous (comptage de nuit)
> **ne pourra être faite qu'après déploiement**. Elle est portée au prochain passage d'audit.

## Pourquoi

Quand l'application coupe elle-même le moteur, le boîtier perd son alimentation : s'en alarmer n'a
pas de sens. Le correctif du 19/08 supprime donc l'alerte dans ce cas. **Mais pour savoir si « c'est
nous », il lit la dernière commande moteur enregistrée, sans regarder sa date.**

Or l'automatisation horaire coupe la flotte entière le soir et la rétablit à 06:00. Entre les deux,
la dernière commande de la plupart des boîtiers est une coupe — **donc leur alarme d'alimentation
est muette toute la nuit**, y compris si quelqu'un débranche réellement la batterie.

Mesuré le 20/08 à 01:10 UTC :

| Dernière commande du boîtier | Boîtiers | Alarme d'alimentation |
|---|---|---|
| `CUT` (acquittée ou seulement émise) | **33** | 🔇 éteinte |
| `RESTORE` | 6 | ✅ active |

**33 sur 42, soit 79 % du parc.**

## 🔑 Le délai est mesuré, pas supposé — et il change la lecture du défaut

Avant de choisir une fenêtre au hasard, on a mesuré l'écart réel entre une coupe commandée et
l'arrivée d'une alarme d'alimentation, sur les trames brutes (`wire_logs`, 4 jours) :

| Boîtier | Coupe commandée | 1ʳᵉ alarme d'alimentation ensuite | Écart |
|---|---|---|---|
| DZ-034-CA | 18/08 20:00:05 | 19/08 00:57:46 | **4 h 58** |
| HD-292-SH | 18/08 20:00:06 | 19/08 00:32:34 | **4 h 32** |
| DZ-034-CA | 17/08 20:00:05 | 18/08 07:56:36 | 11 h 56 |
| HD-292-SH | 16/08 20:00:05 | 19/08 00:32:34 | 52 h |

**L'écart le plus court de toute la fenêtre est de 4 h 32.** Aucune alarme d'alimentation n'arrive
dans les minutes qui suivent une coupe commandée.

> 🔑 **Deux conséquences, et la seconde est plus importante que la première.**
>
> 1. **Une fenêtre de quelques minutes ne peut pas ramener le déluge** qu'on cherchait à éteindre :
>    les alarmes concernées sont toutes à plus de quatre heures de la coupe la plus proche. Le lot 1
>    est donc **beaucoup moins risqué qu'il n'en a l'air**.
> 2. **Le motif « coupure commandée » n'a jamais été la bonne explication de ces alarmes.** Une
>    perte d'alimentation causée par notre coupe apparaîtrait en secondes, pas en heures. Ce que
>    DZ-034-CA a produit — **304 trames sur 19 heures d'affilée** — est un défaut électrique réel,
>    pas un effet de bord de l'automatisation.
>
> Et la seule fois où la garde s'est réellement exercée, elle l'a confirmé : le 19/08 à **02:26:23**,
> elle a silencié une alarme survenue **6 h 26 après** la coupe de 20:00, sur un véhicule qui
> alarmait sans interruption depuis la veille au matin. **Son unique exercice est un faux silence.**

*Le vrai traitement du « contact coupé sur montage commuté » est l'autre branche du code, celle qui
regarde le niveau de batterie — pas celle-ci.*

## Où

| Quoi | Où |
|---|---|
| La lecture fautive | `apps/api/src/alerts/alerts.service.ts` — bloc `POWER_CUT` de `createFromCobanFrame`, la requête `engineControlCommand.findFirst({ status: { in: ['ACKNOWLEDGED','SENT'] } })` |
| La décision | `apps/api/src/alerts/alarme-alimentation.ts` → `analyserAlimentation(frame, { moteurCoupeParNous })` |
| ⚠️ | **Les deux fichiers ne sont pas encore dans l'arbre local** — voir le préambule. |

## Le geste

1. **Ajouter une borne de date à la requête.** Ne retenir la dernière commande que si elle est
   récente : `createdAt >= now() - FENETRE_COUPE_COMMANDEE`. Au-delà, `moteurCoupeParNous` vaut
   `false` et l'alarme reprend son cours normal.
2. **Choisir la fenêtre, et l'écrire comme une constante nommée**, avec en commentaire la mesure
   ci-dessus qui la justifie. **15 minutes** est un point de départ défendable : très au-dessus du
   temps de chute de l'alimentation, très en dessous des 4 h 32 observées.
3. ~~**Exclure le statut `SENT`.**~~ 🔴 **ABANDONNÉ à l'exécution — cette étape reposait sur une
   citation fausse.** Voir l'encadré ci-dessous.

> ### 🔴 Correction apportée pendant l'exécution — 2026-08-20
>
> La version initiale de ce lot prescrivait d'exclure `SENT`, au motif qu'« aucune commande n'est
> jamais acquittée : `ackedAt` = 0 sur 4 733 », en citant [TRK-014](./REFERENCE-ERREURS.md#trk-014).
> **La citation portait sur la mauvaise table.** TRK-014 décrit `tracker_commands` — les commandes de
> cadence. Les commandes moteur vivent dans `engine_control_commands`, et **elles sont acquittées** :
> **2 857 `ACKNOWLEDGED`** en base.
>
> Vérifié dans le code (`engine-control.service.ts`) : le chemin TCP passe bien en `ACKNOWLEDGED` à
> la réception de l'accusé, **mais le repli SMS écrit `SENT` avec `lastError: 'Envoyé via SMS (TCP
> indisponible)'` et n'en sort jamais** — c'est exactement
> [TRK-036](./REFERENCE-ERREURS.md#trk-036).
>
> **Exclure `SENT` rendrait donc l'application aveugle à ses propres coupes sur le chemin le moins
> fiable et le plus sensible** — le repli du coupe-circuit. `SENT` est **conservé**.
>
> 🔑 **La borne de temps ferme à elle seule le danger réel** : une coupe restée `SENT` pour toujours
> qui ferait taire l'alarme à vie. *Le statut ne dit pas depuis quand — c'est la date qui tranche,
> pas le statut.*
>
> **Leçon de méthode, à ne pas perdre** : une fiche de ce référentiel s'applique à **une table
> nommée**, pas à une idée générale (« les commandes ne sont jamais acquittées »). Généraliser une
> mesure au-delà de son périmètre fabrique un correctif qui a l'air fondé. *Relire la fiche citée
> avant de s'appuyer dessus coûte une minute.*

## Tests

- Une coupe **de 2 minutes** → l'alarme est supprimée, la trace `lastPowerNoticeAt` est écrite.
- **La même coupe, vieille de 6 heures** → l'alarme **est créée**. *C'est LE test du lot : il échoue
  sur le code actuel.*
- Une coupe restée au statut `SENT` → l'alarme est créée.
- Aucune commande moteur du tout → comportement inchangé.

## Vérification en production — sur la cause, pas sur l'affichage

Rejouer **entre 20:00 et 06:00** le comptage « dernière commande moteur par boîtier », et le
comparer au nombre de boîtiers réellement silenciés. **Aujourd'hui les deux valent 33 ; après
correction ils doivent être décorrélés.**

⚠️ **Ne pas** valider en constatant qu'il n'y a plus de fausses alertes d'alimentation : il n'y en a
plus depuis le 19/08 02:26 **parce que les trames ont cessé**, pas grâce à cette garde. Le compteur
serait à zéro dans les deux cas.

## ⛔ Ce qu'il ne faut pas faire

- **Ne pas supprimer la garde.** Elle traite un vrai problème. Le défaut est sa **portée**, pas son principe.
- **Ne pas toucher au seuil de batterie de 90 %** dans le même lot. C'est un arbitrage délibéré et
  séparé ; le mélanger rendrait la relecture impossible et le résultat inattribuable.
- **Ne pas élargir la fenêtre « pour être sûr ».** Chaque heure ajoutée rend du silence à la nuit,
  c'est-à-dire exactement ce qu'on répare.

---

# Lot 2 — Rattacher l'accusé de réception SMS à sa commande

**Fiche : [TRK-036](./REFERENCE-ERREURS.md#trk-036) · Gravité 2 · Effort M · Risque faible**

## Pourquoi

On croyait le repli SMS du coupe-circuit totalement aveugle. **Il ne l'est pas : la confirmation
arrive, et Tracky l'enregistre dans sa propre base — sans jamais la relier à la commande.**

| Heure (UTC) | Fait |
|---|---|
| 04:39:13 | Ordre `RESTORE` créé pour **GS-014-NY** |
| 04:39:14 | Commande passée au statut **émis** |
| **08:28:58** | 🔔 SMS entrant **« Resume engine Succeed »**, depuis **la SIM de ce boîtier** |
| 08:28:58 | Écrit dans `sms_logs` — `imei` **NULL**, `context` **NULL** |
| **+21 h** | La commande est **toujours** au statut émis |

Le numéro de l'expéditeur est exactement `trackers.simPhoneNumber`. **Une seule jointure manque.**

## Où

| Quoi | Où |
|---|---|
| Écriture du SMS entrant | `apps/api/src/sms/sms-gateway.service.ts:692` → `recordInbound()` |
| Appelant | `apps/api/src/sms/sms-webhook.controller.ts:121` |
| Bus d'événements déjà en place | `SMS_INBOUND_EVENT`, écouté par `tracker-provisioning.service.ts:312` |

🟢 **Deux bonnes nouvelles pour ce lot** : `recordInbound` accepte **déjà** un paramètre `imei`
optionnel — il n'est simplement jamais renseigné ; et un **bus d'événements existe déjà**, avec un
consommateur en production. L'ossature est là.

## Le geste

1. **Résoudre l'émetteur dans `recordInbound`** : chercher le boîtier dont `simPhoneNumber`
   correspond à `fromNumber`, et renseigner `imei`. Geste **isolé, sans effet de bord**, utile même
   si on s'arrête là — il rend tous les SMS entrants attribuables.
   ⚠️ Comparer en **E.164 normalisé** des deux côtés (cf. [l'incident MSISDN](./REFERENCE-ERREURS.md)) :
   un `+` manquant ferait échouer la jointure en silence.
2. **Ajouter un écouteur d'accusés** sur `SMS_INBOUND_EVENT` : reconnaître le gabarit fixe
   (`Stop engine Succeed`, `Resume engine Succeed`), retrouver la dernière commande moteur émise du
   **même boîtier** et **pour la même action**, puis écrire l'acquittement.
3. **Discriminer sur le couple (boîtier, action), pas sur le temps.** 3 h 50 séparent ici la
   commande de sa réponse : une fenêtre temporelle large rattacherait un accusé à la mauvaise commande.

## Tests

- SMS entrant depuis une SIM connue → `imei` renseigné.
- SMS entrant depuis un numéro inconnu → `imei` reste `NULL`, **aucune exception**.
- « Resume engine Succeed » + commande `RESTORE` émise → commande acquittée.
- « Resume engine Succeed » alors que la dernière commande est un `CUT` → **rien n'est acquitté**.
- Deux accusés identiques → le second ne réécrit pas un statut déjà terminal (idempotence).

## Vérification en production

Tout SMS entrant dont l'expéditeur correspond à une SIM connue doit porter un `imei`.
**Aujourd'hui : 0 sur 1.**

⚠️ **Ne pas** valider en constatant qu'une commande est passée à « acquittée » : ce serait vrai aussi
si on acquittait à l'aveugle.

## ⛔ Ce qu'il ne faut pas faire

**Ne pas conclure que ce lot fera apparaître les accusés manquants.** Il n'en existe que **deux en
cinq semaines** (13/07 et 19/08) pour 280 commandes émises. Ce lot répare le **rattachement** ; la
question « pourquoi seulement deux ? » reste entière et appartient à
[TRK-018](./REFERENCE-ERREURS.md#trk-018). **Deux problèmes, deux lots.**

---

# Lot 3 — Assainir puis borner la fermeture des épisodes GPS

**Fiche : [TRK-031](./REFERENCE-ERREURS.md#trk-031) · Gravité 2 · Effort M · Risque moyen**

## Pourquoi

Quand un véhicule retrouve le GPS, le code referme **tous** ses épisodes de perte encore ouverts, en
les datant du jour même. FS-253-HR est ressorti de son parking le 19/08 à **13:48:56** :

| Perte | Durée déclarée | Réalité |
|---|---|---|
| 15/07 09:31 | 🔴 **35,18 j** | ❌ fabriquée |
| 22/07 → 10/08 *(7 autres)* | 🔴 28,01 → 8,95 j | ❌ fabriquées |
| **12/08 15:20** | **6,94 j** | ✅ **la seule vraie** |

**Réfutation arithmétique** : pendant les « 35 jours » du premier épisode, le boîtier a émis
**5 027 positions**.

**Le dégât est déjà à l'écran** : la médiane de la zone annonce **16,03 jours** pour un parking dont
le véhicule ressort en sept. C'est précisément l'écran créé par
[TRK-028](./REFERENCE-ERREURS.md#trk-028) pour cesser de rester vague avec l'exploitant.

**Dette restante : 20 épisodes ouverts sur 9 véhicules — dont 9 sur KSR370**, boîtier mort depuis le
14/08. Le jour où il revient, il rejoue la scène à l'identique. **C'est prévisible, donc évitable.**

## Où

`apps/api/src/gps-dead-zones/gps-dead-zones.service.ts:165` → `recordRecovery()`, dont le
`updateMany` porte `where: { vehicleId, recoveredAt: null }` (ligne 169) — **sans borne sur `lostAt`**.

**Le commentaire au-dessus assume ce choix** : *« un véhicule peut porter plusieurs épisodes ouverts
si le cron a tourné pendant que la donnée était incohérente. On les ferme tous plutôt que d'en
laisser traîner un qui fausserait toutes les moyennes ensuite. »*

> 🔑 **L'intention est juste pour des doublons du même épisode. Elle est fausse pour un épisode d'un
> autre mois — et elle produit exactement ce qu'elle voulait éviter : une durée qui fausse la
> moyenne.** Une fonction idempotente sur le flux qu'elle produit ne l'est pas sur le stock qu'elle
> n'a pas produit.

## Le geste — **l'ordre compte**

### 3.a — Assainir le stock, une fois (à faire EN PREMIER)

Les 20 épisodes ouverts ne sont pas récupérables tels quels : leur vraie date de retour n'a jamais
été écrite. Deux options, à trancher :

- **Reconstituer** : `recoveredAt` = première position valide postérieure à `lostAt`, lisible dans
  `positions` (jointure par `trackerId` — ⚠️ `positions` **n'a pas** de `vehicleId`).
- **Ou exclure** ces épisodes du calcul de médiane par un drapeau, en assumant qu'ils sont perdus.

**Script à part, jamais une migration**, et **en DRY-RUN d'abord** : afficher ce qui serait écrit,
faire relire, puis exécuter. C'est le motif déjà éprouvé sur la rétention.

⚠️ **Ne surtout pas les fermer à `now()` en masse** : ce serait le défaut lui-même, appliqué à
l'échelle.

### 3.b — Borner le code, ensuite

Ajouter une borne sur `lostAt` au `where` du `updateMany`, pour qu'une fermeture ne puisse jamais
atteindre un épisode sans rapport avec la perte en cours. **La fenêtre se lit dans la donnée** : le
plus long épisode plausible du parc est de l'ordre de **7 jours**.

> **Pourquoi cet ordre ?** Borner d'abord laisserait les 20 épisodes ouverts **définitivement**
> ouverts — sous la borne, plus rien ne les fermera jamais. Ils deviendraient une dette immortelle
> au lieu d'une dette réparable.

## Vérification

Aucun épisode refermé ne doit couvrir un intervalle pendant lequel `positions` contient des points
du même boîtier. **Aujourd'hui : 8 sur 14.** L'objectif est **0** — et **pas** « la médiane a l'air
plus jolie ». Relever aussi la médiane de la zone du parking **avant** et **après** l'assainissement.

---

# Lot 4 — Rendre visible toute disparition de lignes

**Fiche : [TRK-035](./REFERENCE-ERREURS.md#trk-035) · Gravité 1 · Effort S · Risque nul**

## Pourquoi

Entre deux passages de l'audit, **41 709 alertes et au moins 89 lignes d'erreur ont disparu**, et
**rien nulle part n'en garde trace**. Les trois pistes ont été fermées une par une :

| Piste | Verdict |
|---|---|
| Le ménage automatique | ❌ il déclare `errorDeleted: 0`, et sa fenêtre est bien à 90 jours |
| Un bouton de l'application | ❌ **une seule** suppression de lignes d'erreur existe dans l'image servie, et **aucune** sur les alertes |
| La migration du jour | ❌ elle ajoute deux colonnes, rien d'autre |

La suppression a été faite **directement en base**. On ne l'a vue que dans les statistiques internes
de PostgreSQL (`n_tup_del`, `last_autovacuum`).

**Le piège de lecture, à retenir** : le taux « alertes sans message » affiche maintenant **5,5 % au
lieu de 81,6 %**. Ce n'est **pas** une amélioration — c'est le dénominateur qui a été effacé.

## Le geste

> 🔑 **Il n'y a pas de correctif possible côté code, et c'est le fond du sujet : aucun garde-fou
> applicatif ne peut arrêter un `DELETE` exécuté directement en base.** On ne cherche donc pas à
> l'empêcher — on cherche à ce qu'il ne puisse plus passer inaperçu.

1. **Relever chaque jour, et conserver ailleurs que dans ces tables** : `count(*)` et
   `min("createdAt")` de `error_logs` et `alerts`. La règle d'alerte tient en une phrase : **la date
   de la plus ancienne ligne ne doit jamais avancer** sans qu'une purge soit inscrite quelque part.
   Le 20/08, elle a avancé de **22 jours** sans aucune inscription.
2. **Documenter la manœuvre quand elle est volontaire** : une ligne dans le journal des actions
   système (catégorie `RETENTION`) coûte une insertion et rend l'événement lisible depuis l'écran —
   exactement ce que le cron de rétention fait déjà pour lui-même.

**Où l'accrocher** : le journal des passages de ce dossier tient déjà cette série
(`app/wiki.json` → `passages.chiffres`) — **c'est lui qui a détecté celui-ci**, avec un jour de
retard. Le porter dans l'application le rendrait immédiat.

## Vérification

Rejouer une suppression **en environnement de test** et vérifier qu'elle produit une trace lisible
sans avoir à interroger les statistiques internes de PostgreSQL.

---

# Lot 5 — Réparer `/admin/vps` et le rendre tolérant

**Fiche : [TRK-033](./REFERENCE-ERREURS.md#trk-033) · Gravité 2 · Effort XS · Risque nul**

## Pourquoi

L'écran plante **maintenant**, pour tout le monde. Le gabarit garde l'objet parent puis déréférence
l'enfant sans garde :

```
@if (idx.previsions; as p) {                     ← garde sur previsions
  … {{ p.chargeDeFond.healthchecksParMinute }}   ← chargeDeFond n'est PAS gardé
```

…alors que le fichier écrit par l'agent d'audit VPS ne contient que `disque` et `recuperable`.
**Vérifié aux trois endroits** : dans le dépôt, dans le dossier publié sur le VPS, et tel que
l'API le voit.

**Le bloc conditionnel entier meurt** : toute la carte « Prévisions » disparaît, **tableau du disque
compris**, alors qu'il n'a rien à voir avec le champ manquant.

> 🔑 **L'interface TypeScript déclare `chargeDeFond` obligatoire et le compilateur est satisfait —
> mais la valeur vient d'un JSON analysé sans validation.** Un type posé sur du JSON non validé
> n'est pas une garantie : c'est **une promesse que le compilateur n'a aucun moyen de tenir**.

## Où

| Quoi | Où |
|---|---|
| Le déréférencement | `apps/web/src/app/features/observability/admin-vps.component.ts:180-183` |
| Le type trop optimiste | `apps/web/src/app/core/services/vps-audit-wiki.service.ts` → `VpsWikiPrevisions.chargeDeFond` |
| La donnée manquante | `docs/vps-audit/app/wiki.json` → `previsions` |

## Le geste — **les deux, pas un seul**

1. **Côté écran** : passer `chargeDeFond` en **facultatif** dans l'interface, et poser une garde
   autour du **seul** bloc concerné. Le reste de la carte survit alors à n'importe quel manifeste partiel.
2. **Côté agent d'audit VPS** : renseigner `chargeDeFond` — les chiffres existent déjà, l'audit
   mesure les sondes et les processus par minute. Ajouter aussi la clé au modèle que l'agent suit.

## Vérification

Ouvrir l'écran avec un manifeste **volontairement amputé** de la clé : la carte « Prévisions » doit
s'afficher, sans la phrase de charge de fond, et la console doit rester muette.

⚠️ **Ne pas** valider en ajoutant le champ puis en constatant que la page marche — **ça ne teste rien
du défaut.** Et **ne pas se contenter du geste 2** : il répare la donnée du jour, pas la fragilité du
gabarit, et **le prochain champ ajouté rejouera la panne à l'identique**.

⚠️ **Validation obligatoire par `ng build`** : `pnpm -w typecheck` ne couvre pas `apps/web`, donc une
erreur de gabarit y passerait inaperçue.

---

# Lot 6 — Aligner la fenêtre de recalcul sur la rétention des positions

**Fiche : [TRK-034](./REFERENCE-ERREURS.md#trk-034) · Gravité 3 · Effort XS · Risque faible**

## Pourquoi

Trois réglages qui ne se parlent pas :

| Réglage | Valeur |
|---|---|
| Fenêtre de recalcul des trajets (`lookbackHours`) | **1 500 h = 62,5 jours** |
| Rétention des positions | **60 jours** |
| Rétention des trajets | **12 mois** |

Le recalcul cherche donc des positions **2,5 jours au-delà de l'horizon où il peut en exister**, sur
des trajets conservés vingt fois plus longtemps. **La même erreur se rejouera à chaque passage, pour
toujours.**

## 🔑 Un détail à ne pas manquer

`apps/api/src/trip-analysis/trip-automation.service.ts:350` plafonne déjà le réglage :

```ts
if (dto.lookbackHours !== undefined) data.lookbackHours = this.clampInt(dto.lookbackHours, 1, 720);
```

**Le maximum accepté par l'API est 720 h (30 jours). La valeur en production est 1 500.**

Autrement dit : **la valeur active est plus du double de ce que l'application accepterait
aujourd'hui** — elle a été posée avant ce plafond, ou en contournant l'API. *Un plafond qui ne
s'applique qu'aux écritures futures laisse les valeurs héritées agir indéfiniment* — c'est
exactement la leçon de [TRK-008](./REFERENCE-ERREURS.md#trk-008) : **clamper aussi à la lecture.**

## Le geste

1. **Clamper à la lecture**, ligne 141, là où la fenêtre est calculée : borner par la rétention des
   positions lue dans la configuration, pas en dur, avec **un jour de marge** pour ne pas courir
   après la purge nocturne.
2. **Normaliser la valeur stockée** (1 500 → une valeur dans les bornes), sinon l'écran continuera
   d'afficher un réglage que le code n'honore plus.
3. **Classer ce cas en information, pas en erreur.** Une fenêtre sans position parce que la rétention
   est passée est un état **attendu** ; l'écrire au centre d'alerte consomme l'attention qui doit
   aller ailleurs.

⚠️ **Ne pas corriger le message** : il est exact, nomme le véhicule, donne les deux bornes et précise
que rien n'a été supprimé. **Le défaut est le réglage, pas le cri.**

## Vérification

Relancer l'automatisation et vérifier qu'**aucune** ligne n'est écrite alors que des trajets de plus
de 60 jours subsistent en base — il en subsiste, la rétention des trajets étant de 12 mois.

⚠️ **Ne pas** vérifier en constatant l'absence de la ligne le lendemain : elle ne réapparaît que
quand un véhicule concerné entre dans la bande, et son absence un jour donné ne prouve rien.

---

## Hors périmètre — et pourquoi

Trois sujets ouverts au rapport du 20/08 ne sont **pas** dans cette roadmap :

| Sujet | Pourquoi pas ici |
|---|---|
| **[TRK-017](./REFERENCE-ERREURS.md#trk-017) — rotation de la clé d'API de la passerelle SMS** | **10ᵉ jour.** Ce n'est pas du code : c'est un geste d'exploitation (révoquer, rotationner, identifier l'instance hors serveur qui la porte). **Reste la priorité nº 1 de la plateforme**, devant tous les lots ci-dessus. |
| **[TRK-012](./REFERENCE-ERREURS.md#trk-012) — mauvais format de trame** | Correctif écrit depuis le 11/08, **en attente d'un accord**, pas d'un développeur. |
| **[TRK-022](./REFERENCE-ERREURS.md#trk-022) / [TRK-023](./REFERENCE-ERREURS.md#trk-023)** | Les correctifs sont **déjà déployés** — mais **non exercés**, faute de trames depuis le 19/08 02:26. Il n'y a rien à écrire : il y a à **mesurer** quand les trames reviendront. |

---

## Définition de « fini », pour chaque lot

Un lot n'est terminé que lorsque les **cinq** conditions sont réunies :

1. Le correctif est sur une branche dédiée, partie d'un `main` **à jour**.
2. Un test **échoue sur le code actuel** et passe avec le correctif. *Un test qui passe des deux
   côtés ne teste pas le défaut.*
3. `pnpm -w typecheck` + la suite concernée passent — et **`ng build`** pour le lot 5.
4. La vérification décrite **porte sur la cause**, pas sur la disparition d'un affichage.
5. La fiche correspondante est mise à jour dans
   [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) et dans `app/wiki.json` : **statut, date, et ce
   que la vérification a réellement montré.**

> 🔑 **La règle qui a le plus servi ce mois-ci** : *un correctif qui ne fait que vider l'écran n'est
> pas un correctif.* Chaque lot ci-dessus porte une vérification qui interroge la **cause** — parce
> que quatre fois sur cinq ce mois-ci, le compteur est tombé à zéro pour une raison qui n'avait rien
> à voir avec le correctif.
