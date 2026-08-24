# Référentiel des erreurs — Centre d'alerte Tracky

> Mémoire longue du centre d'alerte. Une erreur qui apparaît en prod se retrouve ici, avec sa
> cause racine et son correctif. À chaque passage, l'audit compare ce qu'il voit à ce fichier :
> **signature connue → on met à jour les compteurs ; signature inconnue → on enquête et on ajoute
> une fiche.**
>
> Il existe parce que la table `error_logs` **ne garde rien**. ⚠️ **La justification chiffrée de
> cette phrase est corrigée le 2026-08-22 : la rétention réelle en production est de 90 jours, pas
> 30** — mesuré dans le `meta` du cron `logs_purged` (`errorDays: 90`). La conclusion, elle, est
> pire que ce qu'on croyait : les lignes ne s'effacent pas à J+30 par rétention, elles disparaissent
> **en quelques heures**, supprimées par une main extérieure à l'application ([TRK-035](#trk-035)).
> Ce fichier, lui, survit à tout.

- Procédure d'audit : [`PROCEDURE-AUDIT.md`](./PROCEDURE-AUDIT.md)
- Rapports quotidiens : [`rapports/`](./rapports/)
- Dernière mise à jour : **2026-08-24** *(audit quotidien — 🆕 [TRK-045](#trk-045), gravité 1)*

---

---

## 🚀 2026-08-23 *(journée, CAMPAGNE DE CORRECTIFS)* — onze chantiers fermés, un défaut trouvé en route, un seul déploiement

**Demandée par le propriétaire** (« prends le temps de tout fixer, ensuite on redéploie »). Onze
lots, préparés par une reconnaissance parallèle (11 lecteurs, fiches + code), implémentés
séquentiellement — un lot, une branche, une PR — puis UN déploiement.

| Lot | Fiche | PR | L'essentiel |
|---|---|---|---|
| L 🆕 | **TRK-044** | #108 | `parisHour()` rendait **NaN** — « Automatisation des lieux » ne pouvait JAMAIS se déclencher |
| A | TRK-043 | #109 | la garde anti double-run mesure l'espacement entre **départs** ; les ticks annulés sont visibles |
| B | TRK-012 + 021 | #110 | **l'enveloppe suit le canal** : trame TCP `**,imei:…,C,05m;` sur la socket, forme SMS au repli ; porte SMS-only |
| D | TRK-013 | #111 | la clôture par échéance **compare avant d'affirmer** (bande ±20 %, cible DEMANDÉE citée) |
| C | TRK-040 | #112 | le **contact** départage, le classement bénin devient un **sursis**, un cron relit la **pente** |
| E | TRK-024 | #113 | l'écriture OFFLINE devient **conditionnelle** (fraîcheur dans le WHERE, même instruction) |
| F | TRK-030 | #114 | la branche « jamais localisé » a une **borne** (createdAt, même tolérance que le régime établi) |
| G | TRK-029 | #115 | échéance connue → **réessai programmé** ; « différée, réessai à HH:MM » ; **clôture** des alertes à l'aboutissement |
| H | TRK-039 | #116 | les **cinq correctifs** : fenêtre 30 j, morts exclus, corroboration MESURÉE, étalement sur l'aire partagée, mémoire hors `error_logs` |
| I | outillage | #117 | garde anti-doublon **multi-branches + VPS** ; les raccourcis cessent de contredire le §11.b |
| J | TRK-041 | texto #7 | chaque **refus d'authentification** laisse une ligne (préfixe × IP), best-effort |

### 🆕 TRK-044 — le défaut trouvé PENDANT la campagne, en vérifiant un test daté

Le créneau de 01:10 UTC de « Automatisation des lieux » n'avait rien produit, toutes conditions
réunies. Cause, mesurée dans le conteneur de production : `Number(format(heure seule))` en
`fr-FR` rend **« 04 h »** → **NaN**, jamais égal à aucune heure. **La tâche n'a jamais pu se
déclencher sur son planning, et ne l'aurait jamais pu** — le seul passage réel de son histoire
est un run manuel. Sa jumelle des trajets était saine (`en-GB` + `parseInt`) : deux copies
privées du même calcul avaient divergé. Correctif : util commun `heureParis()`
(`formatToParts` + `h23` + repli qui ÉMET), les deux services délèguent, tests à INSTANT FIGÉ —
les tests existants recalculaient l'heure avec la même fonction cassée, NaN≡NaN passait.

> 🔑 **Trois leçons de méthode, payées dans la même journée :**
> - *les tests qui comparent une fonction à elle-même passent aussi quand elle rend NaN* —
>   seuls des instants figés avec résultat connu d'avance auraient crié ;
> - *le run manuel de vérification RÉARME la grâce de la sonde* : chaque « test » du matin
>   repoussait le moment où la sonde aurait crié — l'observation masquait le défaut ;
> - *la seule variable qui bouge n'est pas forcément la cause* (bis) : le mystère de 01:10
>   ne venait ni du déploiement, ni de la grâce, mais d'un parse cassé depuis l'origine.

### Vérifié avant fusion, sur le CUMUL des onze lots

`pnpm typecheck` ✅ · smoke-boot DI **5/5** ✅ · **API 178 suites / 2 634 tests** ✅ ·
`shared` 12/325 ✅ · `ng build` ✅ · texto : `nest build` + 19/19 ✅. Trois lots ont suivi la
méthode « le test d'abord, vérifié EN ÉCHEC sur l'ancien code » (TRK-043, TRK-030, TRK-039) —
sur ces chemins, aucun test ne verrouillait le défaut : rien n'aurait cassé en le corrigeant.

---

---

## 🟢 2026-08-23 — la première journée entière prouvée sans effacement, et un compteur qui aurait dû dire 24

**Le témoin des disparitions a passé sa première journée pleine, et il n'a rien vu.** Quatre
déclencheurs armés, **0 constat**, `n_tup_del` **inchangé à 3 785** sur 24 h, écart `ins − del − live`
**inchangé à 13 250**. L'arithmétique se referme exactement : **1 + 12 − 0 = 13**.

> ⚠️ **Un instrument neuf qui ne voit rien le premier jour n'a pas encore été exercé.** L'effaceur a
> frappé les 19, 20 et 21/08, puis rien les 22 et 23. Ce zéro est une **mesure**, pas une résolution :
> le témoin constate, il n'empêche pas, et la moitié restante de [TRK-035](#trk-035) — séparer les
> rôles — est entière.

**Conséquence immédiate, et elle est bonne :** pour la première fois depuis le 19/08, les comptes de
ce rapport sont des **mesures** et non des planchers. « 0 ligne `gps-integrity` en 24 h » se lit enfin
sans réserve.

### 🆕 [TRK-043](#trk-043) — la cadence déclarée n'est pas la cadence exécutée

L'automatisation des trajets est réglée sur `hourly`, son cron est `0 45 * * * *`. Mesuré :
**14 passages en 24 h au lieu de 24**. Aucune erreur, aucun seuil franchi, aucun signal.

La garde anti-double-run compare le tick à la **fin** du passage précédent — pas à son départ :

```ts
if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 50 * 60 * 1000) return;
```

**Tout passage de plus de 10 minutes emporte donc le tick suivant.** Vérifié tick par tick :
**23 des 24 ticks du 22/08 sont expliqués exactement**, le 24ᵉ tombant trois minutes avant une
recréation de conteneur.

> 🔑 **`RUN_BUDGET_MS` vaut 50 min, le seuil de la garde aussi.** Un passage qui consomme tout son
> budget **garantit** l'annulation du suivant. *Le frein serre le plus fort exactement quand la
> charge est la plus forte* — c'est le jour où il y a du retard à rattraper que la plateforme divise
> sa cadence par deux. La série de 7 jours le dit sans le code : le seul jour à 24 passages sur 24
> est celui où ils duraient **1,2 min** en moyenne.

⚠️ **Ce n'est pas une perte de donnée** — la fenêtre de 26 h recouvre un écart de 2 h. C'est de la
**latence**, et surtout **du silence** : le `return` est muet, donc un écart de 42 % entre le déclaré
et l'exécuté ne produit aucune trace. *Le profil exact de [TRK-008](#trk-008).*

### 🔴 « Automatisation des lieux » n'a jamais tourné pour de vrai

[TRK-042](#trk-042) tient — 0 ligne depuis le 22/08 12:35, ~13 passages horaires. Mais
`place_automation_runs` ne contient **qu'une seule ligne**, du 22/08 06:00:51, `origin = 'dry-run'` :
un essai à blanc lancé une minute **avant** l'activation de la tâche.

> ⚠️ **Ce n'est pas une régression du correctif, c'est sa contrepartie.** Le silence de la sonde est
> **correct et non informatif** : il dit « pas encore jugeable », et il le dira tant que la tâche ne
> tournera pas. *Un correctif qui remplace une fausse alarme par un silence doit être accompagné du
> test daté qui distingue les deux.*

### ✅ [TRK-038](#trk-038) — le test daté répond, et il répond « non »

Aucun redémarrage depuis le 22/08 13:31. Les deux lignes `speed-limit-osm` postérieures sont espacées
de **6 h 00 min 57 s** : la garde de 6 h tient au centième près quand le processus vit. Le seul
intervalle court de la journée (1 h 00) **encadre un redéploiement**. **2 cas sur 2 expliqués.**

🔴 Et la table `refroidissements_alerte` est **absente de la production** : la PR #106 est ouverte
depuis le 22/08 14:29, non fusionnée. *Ce qui est démontré aujourd'hui, c'est que la garde
fonctionne — donc que la seule chose qui l'empêche de fonctionner est le redémarrage.*

### 🧹 Cinq statuts périmés rectifiés

[TRK-031](#trk-031), [TRK-032](#trk-032), [TRK-034](#trk-034), [TRK-035](#trk-035) *(sonde)* et
[TRK-036](#trk-036) portaient encore « **CORRIGÉ, NON DÉPLOYÉ** ». Les cinq sont **fusionnés et en
ligne depuis le 22/08 04:54** (PR #93 → #99), marqueurs vérifiés dans le `dist/` servi le jour même.

> 🔑 **Un statut périmé coûte plus cher qu'un statut absent : il fait rouvrir une enquête close.**
> Ces en-têtes ont été écrits le matin du 22/08 ; la passe de livraison de l'après-midi les a
> démentis sans les corriger. *Le référentiel n'est à jour que si la dernière chose faite dans la
> journée est de l'y écrire.*

---

---

## ✅ 2026-08-22 *(après-midi)* — neuf PR livrées, et le tableau propre trouve deux défauts en une matinée

**Passe de LIVRAISON demandée par le propriétaire.** Les six correctifs qui dormaient sur `origin`
depuis le 20/08 ont été fusionnés et déployés, suivis de trois chantiers neufs. Quatre déploiements,
tous vérifiés sur l'artefact **servi**.

| PR | Objet | Vérifié en ligne |
|---|---|---|
| #93 → #99 | les six correctifs en attente + la doc du 18 au 22/08 | 04:54 |
| **#100** | **archivage RÉVERSIBLE** du centre d'alerte | 05:29 |
| **#101** | **témoin des disparitions** — 4 déclencheurs actifs | 12:48 |
| **#102** | [TRK-042](#trk-042) — sonde des tâches planifiées | 13:31 |

🔑 **« Clear » ne veut pas dire supprimer.** Décision du propriétaire, et elle est meilleure que la
proposition initiale : une ligne archivée **reste en base**, sort de la vue par défaut, et se rouvre.
*Un archivage qui supprimerait reproduirait volontairement le défaut de [TRK-035](#trk-035) — et
rendrait le témoin incapable de distinguer nos archivages des suppressions de l'intrus.*

### Le témoin des disparitions est en ligne — ce qu'il apporte, et ce qu'il n'apporte pas

Quatre déclencheurs (`AFTER DELETE` + `BEFORE TRUNCATE` sur `error_logs` **et** `alerts`), une ligne
par **instruction**. Chaque constat porte l'heure, le rôle, **l'adresse du client**, le nom
d'application, le PID, **le texte de la requête** et les bornes de ce qui a disparu.

> 🔑 **`adresseClient` suffit déjà à trancher la question qui bloquait depuis trois jours** :
> **NULL = socket locale**, donc un shell *dans* le conteneur ; **non nul = TCP**, et l'API se
> présente en `172.23.0.x`.

⚠️ **`TRUNCATE` est intercepté en `BEFORE`, et c'est le détail qui décide.** Un `AFTER` compterait
une table **déjà vidée** et rendrait « 0 ligne » : le témoin existerait, ne casserait rien, et ne
verrait rien — pour l'opération qui, justement, ne laissait déjà aucune trace. *On a failli rejouer
[TRK-026](#trk-026) dans l'instrument censé le réparer.*

**Exercé en base avant livraison** : `DELETE` de 2 lignes sur 3 → 1 constat aux bonnes bornes ;
`DELETE` sans effet → **aucun** constat ; `TRUNCATE` de 209 lignes → 1 constat à 209.

⚠️ **Le témoin constate, il n'empêche pas.** L'autre moitié de [TRK-035](#trk-035) — retirer
`DELETE`/`TRUNCATE` au rôle applicatif — reste à faire. Le cron supprime légitimement 170 000
`wire_logs` par nuit et tomberait avec.

### 🆕 [TRK-042](#trk-042) — le tableau propre paie dès la première matinée

**7 `CRITICAL` en six heures, toutes fausses.** « Automatisation des lieux », activée à **06:02**,
quotidienne à **03:00** — premier passage possible 21 h plus tard — déclarée à l'arrêt **33 minutes**
après son activation, puis **toutes les heures**.

> 🔑 **Une naissance lue comme une panne.** La branche « aucun passage enregistré » n'avait **aucune
> borne de durée**, alors que tout le reste de la sonde raisonne sur des durées lues et non
> supposées. **Même défaut que [TRK-030](#trk-030), sur un autre module** — là, un boîtier neuf était
> accusé 51 s avant son premier fix. *Il vaut la peine de chercher les autres `if (!lastX)`.*

✅ **Vérifié par le comportement** : le passage de 13:35, premier après déploiement, **n'a rien
écrit**.

### 🔴 [TRK-039](#trk-039) — le test daté répond cinq jours en avance, et réfute son énoncé

Attendue le 27/08, la ligne est revenue le **22/08 à 06:07**, deux jours après la précédente. Zones
et étalement **rigoureusement identiques** (6 zones, 580,9 km) ; seul le compte d'épisodes a bougé,
**de 2 à 9**.

> 🔑 **Le fait qu'on croyait constant ne l'était pas.** *Une clé d'anti-répétition qui inclut une
> grandeur qui monte toute seule ne supprime rien — elle laisse passer une ligne à chaque
> incrément.* Et le correctif proposé (borner les zones dans le temps) **ne suffira pas** tant que
> cette clé n'est pas identifiée. ⚠️ **Ne pas conclure que le délai est ignoré** : il est
> peut-être appliqué, sur une clé qui n'est pas celle qu'on croyait. *Un test daté qui échoue
> désigne l'énoncé aussi souvent que le code.*

### Et la journée elle-même : aucune disparition

`n_tup_del` **inchangé à 3 785 depuis 01:11**, soit douze heures. 10 lignes écrites, 11 vivantes,
1 archivée — l'arithmétique se referme exactement. **L'effaceur n'a pas frappé aujourd'hui**, et
c'est le premier jour où on peut le dire avec un instrument plutôt qu'avec une soustraction.

---

---

## 🔴 2026-08-22 — le centre d'alerte affiche 1 ligne, il en a reçu 66, et l'application prouve qu'elle n'en a effacé aucune

**Une seule ligne dans `error_logs`.** Et la même journée, les compteurs internes de PostgreSQL
disent : **66 insertions, 73 suppressions, en 20,7 heures.** L'arithmétique se referme exactement
(`8 + 66 − 73 = 1`), donc rien n'est perdu dans l'interprétation — c'est bien la table qui a été
vidée, pas la plateforme qui a été calme.

🎯 **L'attribution cesse d'être une hypothèse, et c'est le cron lui-même qui la donne.** Le service
de rétention consigne le nombre de lignes qu'il supprime, table par table, dans son propre `meta` :

| `logs_purged` | 17/08 | 18/08 | 19/08 | 20/08 | 21/08 |
|---|---|---|---|---|---|
| `errorDeleted` | **0** | **0** | **0** | **0** | **0** |
| `wireDeleted` | 170 774 | 167 265 | 163 301 | 164 046 | 170 384 |

Cinq jours, **zéro**. Et il n'existe qu'un seul `errorLog.deleteMany` dans toute la base servie. *On
avait passé trois jours à chercher qui supprimait ; il suffisait de demander à l'application ce
qu'elle avait supprimé, et elle tenait déjà le compte.*

> 🔑 **Deux mesures qui bougent ensemble ne racontent pas forcément la même histoire.** L'écart
> `ins − del − live` reste figé à **13 250** : la prescription d'hier (« il ne doit jamais croître »)
> est **satisfaite**, aucun nouveau `TRUNCATE`. Pendant que, sur la même table, un `DELETE`
> ordinaire emportait 73 lignes. *Les deux natures d'effacement ont chacune leur instrument, et
> chacun est aveugle à l'autre : le succès de l'un ne dit rien de l'autre.*

🔴 **Et personne ne pourra nommer l'auteur, pour deux raisons mesurées ce jour.** `log_statement`
vaut `none`, `log_connections` `off`, `logging_collector` `off` : **la base ne journalise rien**. Et
il n'existe **qu'un seul rôle**, `tracky`, porteur de `DELETE` **et** `TRUNCATE` — l'API, les crons,
les agents locaux et toute session `psql` humaine partagent la même identité.

> 🔑 **La commande qui a immobilisé la moitié du VPS pendant 3 h 54 visait un journal vide par
> configuration.** Le `docker logs tracky-postgres` du 20/08 ne pouvait contenir aucune requête :
> `logging_collector` est `off`. *Avant de payer pour lire un journal — et celui-là a coûté quatre
> heures de production —, vérifier qu'il écrit ce qu'on croit y chercher.*

### 🆕 [TRK-040](#trk-040) — le boîtier meurt en six heures, et la fiche véhicule le dit « pas en péril »

DZ-034-CA, le 21/08, à la trame près : `kt` **contact REMIS** à 06:00:07 · 1ʳᵉ `ac alarm` à
**06:23:46** avec **100 %** de batterie → verdict `contact_coupe`, **0 alerte** · batterie 100 → 83 →
63 → 29 → 0 % · `POWER_CUT` à **12:36:14** · **dernière trame 12:43:53, boîtier mort depuis**.
**6 h 12 min 28 s** entre l'annonce et l'alerte.

> 🔑 **Les deux cas que ce test doit séparer sont identiques au moment où il les sépare.** Une vraie
> coupure vide la batterie de secours — *à terme*. À l'instant zéro, elle est pleine **par
> définition**. Le discriminant retenu est le **niveau**, alors que l'information est dans la
> **pente**, qui n'existe pas encore. *Un critère qui a besoin de temps ne peut pas rendre un verdict
> instantané ; il peut seulement décider d'attendre.*

**Et le bon discriminant était déjà dans les trames.** Le module explique lui-même le mécanisme
bénin : `jt` (contact coupé) **puis** `ac alarm`. Ici c'est `kt` (contact remis) à 06:00:07 **puis**
`ac alarm` à 06:23:46. *Un montage sur +12 V commuté ne perd pas son alimentation 23 minutes après
que le contact a été remis.* La prémisse du verdict était réfutée par la trame précédente.

⚠️ **Ce n'est pas une condamnation du correctif du 19/08**, qui a supprimé 202 alertes inutiles et
dont les 4 arbitrages du 20/08 étaient justes. **Il manque une entrée — l'état du contact — pas une
refonte.** Et ce n'est pas non plus le chemin de [TRK-032](#trk-032) : ce tracker n'a **aucune**
commande moteur dans tout l'historique.

### 🆕 [TRK-041](#trk-041) — on a réparé la serrure et jeté le judas

La rotation du 20/08 est **confirmée par la donnée de la passerelle** : `vtx_48fe` jusqu'au 20/08
13:25, `vtx_d4f3` à partir de 14:25, bascule nette à 13:34, aucun chevauchement. Excellente
nouvelle.

Mais `allowlist_audit_logs.tenantId` est **`NOT NULL`** : une ligne d'audit ne s'écrit qu'**après**
qu'une clé valide a résolu le locataire. **Une requête avec la clé révoquée est rejetée à
l'authentification et ne laisse rien.**

> 🔑 **Le compteur de blocages ne peut plus bouger, quoi qu'il arrive.** Les 49 blocages étaient la
> seule preuve qu'un tiers détenait la clé. Après rotation, l'attaquant qui revient et celui qui a
> renoncé produisent **exactement la même donnée : aucune**. *Un compteur figé se lit « il ne se
> passe plus rien » ; celui-ci doit se lire « on ne peut plus rien voir ».* Silence de **102,0 h**,
> le plus long de la série — et le premier qui ne prouve même pas une absence.

### Ce qui va mieux, et qui ne produit aucune ligne

- **[TRK-023](#trk-023) est EXERCÉ et il tient** : **0 alerte sans message depuis le 19/08 01:56**,
  sur 3 jours et 4 types d'alerte. Les 556 lignes muettes restantes sont de l'historique.
- **[TRK-019](#trk-019) vérifié par l'égalité, pas par des marqueurs** :
  `git rev-list --count c9dc774..origin/main` rend **0**. La production est sur le sommet exact de
  `main`, pas sur quelque chose qui lui ressemble.
- **La règle du parking est exercée en production** : la zone de FL-787-KV (6 occurrences,
  `reviewedAt` = jamais) a été qualifiée `UNDERGROUND_PARKING` **automatiquement**, et sa perte du
  21/08 18:00 n'a produit aucune alerte.
- **« 0 récit IA » à chaque passage est un RÉGLAGE** (`narrateEnabled = false`), pas une panne.
  *Vérifié avant d'ouvrir une fiche : un zéro qui a une case à cocher n'est pas une alerte.*

🔴 **Et les six correctifs écrits restent absents de la production**, malgré **deux déploiements**
hier (web 17:34, api 23:45).

> ⚠️ **RECTIFICATION du même jour — et elle porte sur la méthode, pas sur un chiffre.** Ce passage
> a d'abord conclu « il leur manque un `git push` », sur la foi d'un `git cat-file -e` **OBJET
> ABSENT** dans le clone du serveur. **Faux : les six commits sont sur `origin` depuis le 20/08**
> (`git rev-list --count origin/<branche>..<branche>` rend **0** pour les six). Le clone du serveur
> a la refspec standard mais ne connaît que `refs/remotes/origin/main` — son dernier `fetch`
> portait sur `main` seul.
>
> 🔑 **On a changé d'instrument sans changer l'erreur.** Le 21/08, ce dossier avait abandonné
> `merge-base --is-ancestor` *parce qu'il confondait « commit absent » et « commit non fusionné »*.
> Son remplaçant confond « jamais poussé » et « poussé mais jamais rapatrié ici ». *Les deux fois,
> on a interrogé un clone local pour répondre à une question qui porte sur le dépôt distant.*
>
> **Ce qui manque réellement : les revues.** Les six branches sont poussées, **aucune n'a de pull
> request**, aucune n'est dans `main` — donc aucune ne peut arriver en ligne, quel que soit le
> nombre de reconstructions.

---

---

## 🔎 2026-08-21 — trois choses vont mieux sans produire une ligne, et le témoin de la disparition est pris en défaut

**8 lignes, 0 CRITICAL, aucune connue.** Le centre d'alerte n'a jamais été aussi calme, et le calme
vient de trois endroits qu'il ne sait pas nommer : l'alarme d'alimentation **correctement tue** pour
la première fois, l'assainissement de [TRK-031](#trk-031) qui **a tenu**, et la clé rotationnée qui
**fonctionne de bout en bout**. *Un centre d'alerte ne dit jamais qu'un correctif marche ; il ne
peut que cesser de dire qu'il ne marche pas.*

**Le témoin qui avait détecté l'effacement du 19/08 est aveugle à celui de `error_logs`.**
La vérification prescrite est rendue et négative dans le bon sens — `alerts.n_tup_del` **inchangé à
41 824**, `min("createdAt")` **immobile** au 20/08 05:47:16 : la suppression n'a pas rejoué en 14 h.
Mais un second compte, ouvert ce jour, ne se referme pas : `error_logs` porte **16 970** insertions,
**3 712** suppressions et **8** lignes vivantes — **13 250 lignes manquent, qu'aucun `DELETE` n'a
comptées**.

> 🔑 **Ce que `n_tup_del` mesure, ce ne sont pas les disparitions : ce sont les `DELETE`.**
> `TRUNCATE` vide une table sans l'incrémenter. Et **deux contrôles rendent le chiffre exploitable
> plutôt que curieux** : `pg_stat_database.stats_reset` est **NULL** (les compteurs n'ont jamais été
> remis à zéro), et la même arithmétique se referme **exactement** sur `alerts` — 51 881 − 41 824 =
> 10 057 = `n_live_tup`. *Un instrument validé sur un cas ne vaut que pour la classe d'événements de
> ce cas.* La sonde de recensement de [TRK-035](#trk-035), elle, aurait vu celui-ci : elle relève
> `count(*)` et `min("createdAt")`, qui chutent sous les deux opérations.

**Trois signatures neuves, et la plus grave est celle d'un agent déployé la veille.**
[TRK-039](#trk-039) — l'agent qualité GPS accuse l'antenne de **KSR370**, un boîtier **hors ligne
depuis 7 jours** dont la mort est **déjà expliquée** au dossier (coupure d'alimentation, batterie
vidée, cf. [TRK-023](#trk-023)), sur des zones vieilles de **19 jours** qu'aucune fenêtre ne borne.

> 🔑 **La prémisse est juste, le discriminant ne la teste pas.** *« Un boîtier mourant perd le signal
> PARTOUT »* est vrai — mais « partout » y est mesuré en **mètres d'étalement**, et l'étalement d'un
> véhicule mesure d'abord **la distance qu'il parcourt**. KSR370 a fait Toulouse–Benidorm :
> **580 928 m**, soit **193 fois** le seuil. Pire, la corroboration croisée — *« sans qu'aucun autre
> véhicule n'ait le même problème à ces endroits »* — est **impossible à franchir** pour un véhicule
> qui roule là où aucun autre de la flotte ne va. **Plus un véhicule voyage loin et seul, plus il est
> certain d'être déclaré en panne.** *Une absence de preuve est retournée en preuve.*

**Un défaut de famille, trouvé en enquêtant sur un autre.** [TRK-038](#trk-038) : la garde de 6 h qui
espace les alertes Overpass vit dans un **champ d'instance**, donc en mémoire de processus. Les six
lignes du 20/08 sont espacées de 5 h 00 · 3 h 59 · **6 h 02** · 1 h 57 · 1 h 03 — et trois des quatre
intervalles trop courts tombent **après une remise en service** (trois le 20/08 : 10:19, 22:27,
23:40). *La garde n'est pas cassée, elle est volatile : l'intervalle de 6 h 02 prouve qu'elle marche
quand le processus vit.* **Trois jumeaux** portent le même défaut — et le plus embarrassant est
l'alarme de **flambée d'erreurs**, dont l'anti-flambée est réarmé par le déploiement, c'est-à-dire
par l'événement qui provoque le plus de flambées.

⚠️ **[TRK-037](#trk-037) ne peut pas dater son premier cas** — la plus ancienne ligne survivante de
toute la table **est** l'une d'elles. *Le coût de la suppression hors application ne se paie plus en
théorie : il vient d'empêcher une fiche neuve de savoir depuis quand son défaut dure.*

✅ **Et une méthode d'outillage a payé.** `merge-base --is-ancestor` rendait « non » pour les cinq
correctifs écrits par cet audit — mais `git cat-file -e` rend **OBJET ABSENT DU CLONE** : ils ne sont
pas non fusionnés, ils sont **inconnus du serveur**. *Les deux verdicts se ressemblent et appellent
des actions opposées ; un seul les sépare.*

---

---

## 🎯 2026-08-19 — une mise en service répond à trois tests datés, et en ouvre deux fiches

Trois heures après le déploiement de la **7ᵉ image** (18/08 22:02, toujours `main` @ `2416331`), un
boîtier a été posé chez un **client neuf**. Cette seule installation a produit plus d'information que
la collecte entière.

**Le boîtier a été accusé de panne d'antenne 51 secondes avant son premier point GPS.** Login TCP à
01:09:36, ligne `gps-integrity` *« sans position GPS depuis toujours (jamais localisé). Antenne à
vérifier »* à **01:10:15**, premier fix à **01:11:06**. La branche « jamais localisé » du cron
(`gps-integrity.service.ts:167`) **ne porte aucune borne de durée** — et le commentaire deux lignes
plus haut en décrit pourtant une : *« alors qu'ils émettent activement des no_fix depuis un
moment »*. **L'intention a été écrite, jamais codée.** → [TRK-030](#trk-030).

> 🔑 **Le délai de grâce est accordé au cas qui n'en a pas besoin et refusé à celui qui en a
> besoin.** Un boîtier déjà localisé bénéficie de 2 heures de patience ; un boîtier qui n'a jamais eu
> de fix — le seul cas où l'attente est *physiquement certaine*, un démarrage à froid Coban cherchant
> le ciel — n'en reçoit aucune.

**Le premier retour de fix a refermé deux épisodes, et l'un des deux est faux.** Le raccroc de
[TRK-028](#trk-028) **s'exécute** (0 → 2), mais `recordRecovery` ferme **tous** les épisodes ouverts
du véhicule à la date du jour : celui du **01/08** est déclaré long de **16,9 jours** sur un boîtier
qui a émis **27 733 positions** pendant l'intervalle. **27 épisodes antérieurs au correctif
attendent le même sort**, sur 8 véhicules — FS-253-HR en porte 9 à lui seul. → [TRK-031](#trk-031).

> 🔑 **Un rattrapage sans date de coupure réécrit le passé avec le présent.** La fonction est
> idempotente sur le flux qu'elle produit ; elle ne l'est pas sur le stock qu'elle n'a pas produit.
> *Et le correctif écrit pour cesser de mentir à l'exploitant commence sa vie en lui montrant un
> chiffre faux.*

**La table `alerts` n'était pas un capteur éteint.** Après 60 h de silence : **202 `POWER_CUT` en
24 h**, toutes `CRITICAL`, **toutes sans message** (2 véhicules, dont 49 alertes en 17 minutes). Le
rapport d'hier a eu raison de ne rien conclure — et la question `POWER_CUT` est tranchée dans l'autre
sens : les deux véhicules qui ont crié sont **vivants**, KSR370 est mort et **ne pouvait pas**
crier. *L'hypothèse « la chaîne s'est tue le 13/08 » est réfutée ; le trou est structurel.*
[TRK-023](#trk-023) passe de 42 038 à **42 240** — premier mouvement depuis le 13/08.

**Le seul étage qui a tenu est le dernier** : 1 020 tentatives de notification, **10 réellement
envoyées** (815 supprimées, 195 groupées). *La rafale n'a pas été empêchée — elle a été absorbée.*

⚠️ **Deux fiches manquaient à l'index depuis leur création** : [TRK-026](#trk-026) et
[TRK-027](#trk-027) existent, sont citées partout, et n'apparaissaient **nulle part** dans le
tableau récapitulatif. Ajoutées ce jour. *Un index incomplet ne signale jamais son incomplétude.*

---

---

## 🟢 2026-08-18 — les correctifs d'hier sont EN LIGNE, et un seul des trois a pu être vérifié

Le déploiement du **17/08 15:54:49** (6ᵉ image, branche `main` @ `5d10796`, migration
`20260817140000_retour_du_signal_gps` appliquée à 15:54:55) embarque les trois commits de la veille.
Le référentiel enregistre donc, pour la première fois, le **passage en production** de son propre
travail — et la distinction qui compte :

| Correctif | En ligne | Exercé |
|---|---|---|
| Règle du parking souterrain | ✅ | ✅ **prouvé** — le journal du cron nomme les 2 véhicules silenciés, toutes les 5 min |
| [TRK-026](#trk-026) — preuve de vie SMS | ✅ | ❌ cron hebdomadaire ; celui du 17/08 07:00 est **antérieur** au déploiement. Verdict réel : **lundi 24/08** |
| [TRK-028](#trk-028) — durée d'absence | ✅ | ❌ `gps_loss_events` : **29 épisodes, 0 refermé** — aucun retour de fix depuis 15:54 |

> 🔑 **« Déployé » et « vérifié » ne s'écrivent pas dans la même colonne.** C'est l'erreur exacte qui
> a coûté cinq jours à [TRK-002](#trk-002). Deux des trois correctifs ne sont pas en défaut : ils
> n'ont simplement pas encore eu d'occasion de s'exécuter, et le dire est une information.

**La mesure qui qualifie un zéro.** 36 h sans une ligne `gps-integrity` auraient pu se lire comme une
panne du détecteur. Le journal du conteneur dit le contraire, toutes les 5 minutes :
*« 2 boîtier(s) vivant(s) sans position GPS (0 nouvelle(s) alerte(s), 2 en zone confirmée :
FZ-862-VY (15 h, parking), FS-253-HR (5 j, parking)) »*. Le cron tourne, **voit** les deux véhicules,
**nomme** leur durée, et décide de se taire. *Un compteur à zéro se qualifie en trouvant l'instrument
qui explique le zéro — jamais en raisonnant sur le zéro.* C'est exactement la consultabilité que
[TRK-027](#trk-027) exigeait en contrepartie, et elle est tenue.

⚠️ **Et la contrepartie est devenue réelle le même jour** : **FS-253-HR**, 132,5 h sans fix, zone à
9 occurrences qualifiée parking — **définitivement silencieux**. La fiche TRK-027 prescrit une
surveillance manuelle au-delà de 7 jours ; il en est au 6ᵉ.

**Une signature nouvelle — [TRK-029](#trk-029)** : le report d'une coupe moteur applique un backoff
exponentiel (5 → 15 → 30 min) à une condition qui porte sa propre échéance (*« arrêté depuis 256 s,
minimum 600 s »* = obstacle levé dans 344 s). HD-603-XY est devenu éligible à ~20:30 et a été coupé à
**20:55** — 25 min d'immobilisation en trop. *Un backoff traite l'ignorance ; il ne doit pas traiter
une échéance connue.*

**Deux pièges d'outillage, tous deux fabriquant une catastrophe de toutes pièces :**
`backup_runs.status` vaut **`OK`**, pas `SUCCESS` — un filtre d'exclusion a rendu « 112 sauvegardes,
112 échecs » ; et `trips.polylineMatched` est **du texte** (la polyligne), pas un booléen — `IS NOT
TRUE` a rendu « 100 % de trajets sans recalage sur cinq jours ». *Énumérer les valeurs d'une colonne
d'état avant de filtrer dessus, jamais l'inverse.*

---

---

## ✅ 2026-08-17 *(passe de correction)* — TRK-026 corrigé, et la règle du parking souterrain appliquée

Première fois que ce référentiel enregistre du **code écrit**, pas seulement un correctif proposé.
Deux chantiers, demandés explicitement par le propriétaire.

### 1. [TRK-026](#trk-026) — la preuve de vie SMS peut enfin échouer

Quatre gestes : le **chemin d'écriture qui manquait** (`reconcileOutboundStatus` — il n'existait
aucun `smsLog.update` dans tout le dépôt), l'**issue à trois états** (`accepted`/`delivered`/
`failed`), la **vérification différée** (deux crons : envoi lundi 09:00, verdict lundi 09:20), et un
corps de message qui **cesse d'affirmer** que la chaîne est saine.

> ⚠️ **`ok` est conservé, délibérément.** Onze appelants s'appuient dessus, dont le repli du
> coupe-circuit. *En changer le sens silencieusement aurait été pire que le défaut d'origine :* un
> booléen qui veut soudain dire autre chose casse une garde de sécurité sans rien signaler. Le
> commentaire dit maintenant ce qu'il vaut — « non refusé », pas « remis ».

🔑 **Un cas que rien ne couvrait est apparu en écrivant la vérification** : le verdict `NON_EMIS`,
quand le cron d'envoi lui-même n'a pas tourné. *Un heartbeat absent et un heartbeat non remis se
ressemblent exactement quand on ne regarde que les erreurs.*

⚠️ **Le verdict restera `INDETERMINE` après déploiement, et c'est le résultat attendu** — pas un bug.
On remplace un faux vert par un « on ne sait pas » daté. La ligne disparaîtra d'elle-même quand la
passerelle exposera un accusé de remise ([TRK-018](#trk-018) nº 1).

### 2. Perte GPS — la règle du parking souterrain

**Cause réelle, donnée par le propriétaire : les véhicules se garent dans des parkings souterrains.**
Le GSM passe, le ciel non. Reperdre le GPS **au même endroit** signe donc un lieu, pas une panne.

| Occurrence au même endroit | Comportement |
|---|---|
| **1ʳᵉ** | **alerte** — le seul signal utile |
| **2ᵉ** | lieu qualifié `UNDERGROUND_PARKING` **automatiquement** → **plus aucune alerte** |
| 3ᵉ et + | rien : ni alerte flotte, ni ligne, ni comptage |

Et le plafond de 24 h de [TRK-011](#trk-011) est **retiré sur les zones de parking**. C'est lui qui
signait **18 des 27** lignes `gps-integrity`, sur deux véhicules dont les zones étaient **déjà**
qualifiées parking par un opérateur.

> 🔑 **Un calibrage juste sur une prémisse fausse reste faux.** Le code justifiait ses 24 h par « un
> stationnement de nuit dure ~12 h ». Sur un parking souterrain, un véhicule reste garé une semaine
> de congés. *La durée d'une perte n'y porte aucune information — le plafond ne mesurait qu'une
> durée de stationnement.*

⚠️ **Deux mocks divergeaient de la production, et l'auraient laissé passer.** La garde d'origine
s'écrivait `zone.reviewedAt === null` et `zone.label === 'UNKNOWN'` ; les mocks de test omettent ces
champs (`undefined`), Prisma rend `null` / `'UNKNOWN'`. **Les tests passaient tout en décrivant un
comportement différent de la production.** Réécrit en tests de présence — et un test dédié verrouille
désormais l'équivalence « champ absent ≡ `null` Prisma ». *Un test vert sur un mock qui n'existe pas
en base ne prouve rien.*

⚠️ **La contrepartie a sa propre fiche : [TRK-027](#trk-027).** Une antenne morte se tait au même
endroit qu'un parking → silenciée dès la 2ᵉ fois. Le fait reste **consultable** (le journal du cron
nomme les véhicules silenciés et la durée, `gps_sans_fix` le mesure chaque nuit) mais n'est plus
notifié. Le garde-fou à écrire est **le contact**, pas une durée : *une voiture qui roule sans fix
n'est dans aucun parking.* Il est bloqué par un prérequis mesuré — **l'ACC n'est pas persisté sur
une trame `no_fix`** (`tcp-server.service.ts` n'y écrit que `lastSeenAt`/`lastNoFixAt`), donc
`lastKnownIgnition` est figé pendant toute la perte. L'écrire sans ce prérequis produirait un
garde-fou qui **affirme une cause fausse**.

### Vérification

`pnpm typecheck` ✅ · smoke-boot DI ✅ *(5 tests — le heartbeat injecte désormais `PrismaService`,
résolu par `PrismaModule` qui est `@Global()` : aucun câblage à ajouter, et c'est **prouvé**)* ·
**51 tests** sur les 3 suites touchées, dont **19 neufs** · suite complète **2106/2107**, l'unique
échec (`partner-invitation`) passant **29/29 en isolation** — instabilité connue du harnais.

🔴 **Rien n'est déployé.** Le code est sur une branche, non poussé, non mergé : la production tourne
toujours l'ancien comportement. Les deux fiches restent donc 🟠 jusqu'à vérification en ligne.

---

---

## 🔴 2026-08-17 *(2ᵉ passage, 08:48)* — la sonde chargée d'annoncer la panne du canal de secours ne peut pas rendre « en panne »

Relance demandée le même jour. `error_logs` n'a pas bougé d'une ligne — **zéro écriture depuis le
redéploiement du 16/08 16:03**, soit 16,7 h — et c'est l'examen des canaux muets qui rend la
trouvaille : **[TRK-026](#trk-026)**, la « preuve de vie » SMS hebdomadaire, **ne peut pas échouer**.

Le cron a tourné ce matin à 07:00 UTC (lundi 09:00 Paris, à la seconde attendue). Son SMS — qui
annonce littéralement *« chaine SMS OK »* — dort en `queued` avec 331 autres. Il n'y a **jamais eu**
une seule ligne `error_logs` de source `sms-heartbeat`.

| Maillon | Ce qui casse la sonde |
|---|---|
| `sms-heartbeat.service.ts:107` | n'écrit l'ErrorLog `CRITICAL` que si `send()` rend `ok: false` |
| `sms-gateway.service.ts:484` | déduit `ok` du statut **rendu à la soumission** — donc `queued` |
| *nulle part* | **`grep -rn "smsLog.update" apps/api/src` → zéro occurrence** |

> 🔑 **Un compteur figé peut être un compteur sans chemin d'écriture.** `sms_logs.status` ressemble à
> une chronologie ; ce n'est que la trace de l'instant d'insertion. *Avant de lire une colonne d'état
> comme une histoire, chercher qui l'écrit une seconde fois — si personne, ce n'est pas un état.*
>
> Et le durcissement antérieur le montre en creux : le commentaire `#34` a élargi la liste des
> statuts d'échec reconnus par `send()`. **Élargir une liste d'échecs ne sert à rien quand le seul
> statut jamais rendu n'en est pas un.** *On avait corrigé la forme du test, pas l'absence d'objet.*

**Défaut jumeau, au sens du §7.5 :** `healthCheck()` alimente l'écran d'administration avec
`recentFailures24h` compté sur `status = 'failed'` — **structurellement 0 depuis le 25/07** — et son
`reachable` pingue le `/health` **du relais**, pas le téléphone qui porte la SIM. *La même erreur que
la sonde de dépendances qui interrogeait l'URL interne : on instrumente le maillon le plus proche,
jamais celui qui tombe.* L'écran est vert par construction.

**Trois angles morts ouverts pour la première fois, et trois résultats négatifs qui valent d'être
écrits :** le **cloisonnement des notifications tient** (0 destinataire non-owner d'une autre flotte,
sur la totalité de la table) ; les **sauvegardes sont intactes** (111 exécutions, 0 échec, dernière ce
matin 03:02) ; et `api_traffic_logs`, qui semblait mort à 9 lignes par jour, a simplement un
**périmètre volontairement étroit**.

> ⚠️ **Ce dernier point est un piège à retenir.** « 0 erreur HTTP sur 24 h » est ici *structurellement
> garanti* : l'intercepteur s'exécute **après** les guards, donc un 401 ou un 429 ne l'atteint jamais,
> `/api/auth/` est exclu par conception, et les requêtes authentifiées sont dédupliquées à 1 par
> (utilisateur, IP) / 10 min. *Un compteur à zéro peut être un capteur éteint — ou un capteur dont le
> périmètre exclut précisément ce qu'on croyait mesurer.*

**Deux tests datés rendent leur verdict, et l'un dans un sens inattendu :**

| Fiche | Le test disait | Ce qui est mesuré |
|---|---|---|
| [TRK-001](#trk-001) | « rien ne doit être écrit le 17/08 vers 08:55 et 15:35 » | **ANNULÉ pour FZ-862-VY** — son fix est revenu à **08:45:11** après **120,0 h**, 25 min avant l'échéance : la condition de nullité écrite la veille s'est réalisée. **PENDANT pour FS-253-HR** (rappel vers 15:45). *Le test n'a pas de réponse — et la clause de nullité a évité de lire un silence comme une réussite.* |
| [TRK-014](#trk-014) | « l'instrument est-il vraiment réarmé ? » | **32 commandes sur 32** portent l'indice de silence aujourd'hui. Trois points sur la même définition : **0/285** (12→15/08), **18/70** (16/08), **32/32**. Total 100 → **131**. |

> **Le témoin remarche, et ce qu'il dit est pire que son silence.** 100 % des commandes émises
> aujourd'hui n'ont reçu aucune réponse du boîtier, et `ackedAt` vaut **0 sur 4544**. C'est
> exactement ce que [TRK-012](#trk-012) prédit — dont le correctif attend un accord depuis le 11/08,
> **septième jour**.

**[TRK-017](#trk-017) — 42 blocages, et une mesure nouvelle appuie le titre de la fiche.** Les deux
populations d'appels n'ont pas la même origine : les **159** appels normaux viennent de `172.18.0.1`
(passerelle Docker interne = l'API de production), les **42** blocages de `82.67.153.51`, une adresse
publique. Charge stable depuis une semaine — `requestedCount = 1`, refus *« 25 suppression(s) au-dela
du plafond de 5 »*, à `h:24:59` chaque heure, une seconde avant la réconciliation de la production.
*Un attaquant ne rejouerait pas la même charge d'un seul numéro à la même minute pendant sept jours :*
c'est bien une **seconde instance** portant la clé de production. Clé `vtx_48fe` inchangée,
**7ᵉ jour**. Rien depuis 02:24:59 — **quatrième silence**, et pour la quatrième fois il ne prouve
aucune révocation.

*(Note de méthode : le 1ᵉʳ passage avait manqué la frappe de 01:24:59, tombée pendant sa fenêtre de
collecte de 25 minutes. **Une collecte étalée n'est pas un instantané.**)*

---

---

## 🟢 2026-08-17 — la production repasse sur `main`, et l'instrument qui accusait depuis 5 jours est réfuté

**[TRK-019](#trk-019) se referme.** Les images ont été reconstruites le **16/08 à 15:59 / 16:00**,
les conteneurs recréés à **16:03**, et `/opt/vizyo-tracky` est sur **`main`** @ `3fccee5` — le point
de fork a disparu. Les deux commits perdus (`d5e5fb1`, `73440d8`) sont sur `main`, et **trois des
quatre marqueurs sont de retour** dans les artefacts servis.

> **Et deux instruments le prouvent sans lire un binaire.** Les silences boîtier tracés, figés à
> **81** depuis le 11/08 (0 sur 355 commandes), sont passés à **100** — dont un le 17/08 à 00:56.
> La trace horaire de réconciliation de l'allowlist, muette depuis le 11/08, réécrit à chaque heure.
> *Un marqueur présent dit qu'un code est là ; un compteur qui repart le prouve.*

**Le 4ᵉ marqueur n'était pas absent : il n'était pas mesurable.** Depuis le 12/08, cinq rapports ont
déclaré [TRK-002](#trk-002) en régression parce que `consecutiveTransportFailures` ne se trouvait pas
dans le bundle servi. C'est une variable de **portée module**, dans un artefact **minifié d'une
ligne** : le minifieur la renomme, toujours.

| Symbole cherché dans `chunk-IJIQMQ3Y.js` | Nature | Antérieur au correctif ? | Occurrences |
|---|---|---|---|
| `shouldReportNetworkFailure` | fonction de module | **oui, des semaines** | **0** |
| `consecutiveTransportFailures` | `let` de module | non | 0 |
| `"API injoignable"` · `"Rafraichissement de session"` | littéraux | oui | **1** · **1** |

Le contrôle est décisif : un symbole **certainement en production** rend zéro. Le témoin employé
jusqu'ici était un *littéral de chaîne* — il attestait qu'on lisait le bon fichier, jamais qu'un
**nom de variable** y serait visible s'il existait.

> 🔑 **Un témoin ne vaut que s'il est de la MÊME NATURE que ce qu'il contrôle.** Les marqueurs *API*
> restent valables (sortie `tsc`, non minifiée — ils viennent de repasser d'absents à présents) ;
> les marqueurs *web* de type identifiant sont, eux, définitivement retirés du référentiel.

**Et le correctif de [TRK-017](#trk-017), redéployé cette nuit, ne peut pas remonter l'attaque pour
laquelle il a été écrit** → nouvelle fiche **[TRK-025](#trk-025)**. Il lit `removalsBlocked` dans la
réponse du sync que **l'API émet elle-même** — un sync qui ne demande jamais de suppression
(`+0 / -0` à chaque heure). Les **40** suppressions de masse retenues appartiennent à un tiers, et ne
traversent jamais ce canal. *Un correctif branché sur le résultat de sa propre requête ne peut pas
voir ce que fait quelqu'un d'autre avec la même clé.*

**L'appelant de TRK-017 est revenu, pour la troisième fois après un silence** (5 frappes les 16 et
17/08, après 32 h de calme). Clé `vtx_48fe` toujours vivante : **7ᵉ jour**. *Trois occurrences du même
motif : un compteur de frappes mesure l'activité de l'attaquant, jamais son accès.*

> **Enfin, une corrélation démontée avant d'être racontée.** Les insertions de positions baissent
> pour le 3ᵉ jour (24 201 → 19 849 → **15 249**) et les rejets [TRK-015](#trk-015) sont retombés
> (5 323 → 2 287). La cause n'est ni le garde-fou ni une panne : **c'est le calendrier** — 195 trajets
> vendredi, 149 samedi (férié), **73 dimanche**, et le motif d'écrêtage dominant dit
> `STOPPED immobile, throttle 300s actif`. *Avant de lier deux grandeurs qui bougent ensemble,
> chercher la troisième qui les gouverne.*

---

## 🔴 2026-08-16 — quatrième reconstruction, et deux tests datés se déclenchent le même jour

La production a été reconstruite pendant la nuit — `tracky-api` le **15/08 à 17:05**, `tracky-web`
le **16/08 à 00:04**, conteneurs recréés à **00:06**. Le `merge-base` de `feat/depot-partage` avec
`main` reste **`c3c2704` (07/08)** pour la **quatrième fois**, et les quatre marqueurs sont de
nouveau absents des artefacts servis, chacun avec son témoin présent.

> **Et cette fois la reconstruction se prouve par le nom du chunk.** Le témoin web
> « Rafraichissement de session » vivait dans `chunk-TJGA5ATM.js` hier ; il vit dans
> **`chunk-XXNB5VTF.js`** aujourd'hui. Le fichier a changé, le témoin a suivi, le marqueur reste
> absent : ce n'est ni un cache, ni un chemin périmé, c'est un artefact **neuf** reconstruit avec le
> même trou. *Un témoin qui migre de fichier vaut mieux qu'un témoin immobile — il date la mesure.*

**Deux tests datés posés hier rendent leur verdict, et tous deux dans le sens qui coûte :**

| Fiche | Le test disait | Ce qui est mesuré |
|---|---|---|
| [TRK-021](#trk-021) | « si de nouvelles `shock_on` / `sensitivity` apparaissent, l'usage est régulier → **gravité 1** » | **+2 le 15/08 à 13:26** (10 → **12**), même opérateur, **3 jours sur 4**. Gravité 2 → **1**. |
| [TRK-013](#trk-013) | « si le compte atteint **9**, le numérateur repart et l'argument *figé* est mort » | **11** clôtures strictement fausses (7 · 7 · 7 · 8 · **11**). L'argument est mort. |

**Le troisième test confirme sans surprendre :** le 3ᵉ rappel GPS ([TRK-001](#trk-001)) est
**présent sur les deux véhicules** (15/08 09:00:15 et 15/08 15:35:15), condition de nullité vérifiée
d'abord — les deux épisodes sont toujours ouverts. Troisième point du même motif : le code servi
rappelle quotidiennement.

**Le mouvement le plus fort du jour est pourtant dans un angle mort.** Les rejets du garde-fou
anti-téléportation ([TRK-015](#trk-015)) triplent **le jour même où les insertions tombent au plus
bas** :

| Jour | `SKIPPED_REPLAY` | `INSERTED` |
|---|---|---|
| 13/08 | 2 636 | 24 706 |
| 14/08 | 1 545 | 24 201 |
| **15/08** | **5 323** | **19 849** |

Ni rafale ni boîtier unique : **34 boîtiers** concernés, réparti sur toutes les heures. Ce qui rend
le fait digne d'être écrit n'est pas l'amplitude seule — c'est que **deux grandeurs indépendantes
bougent dans le même sens** (+245 % de rejets, **−18 % d'insertions**) alors que les trames
entrantes ne baissent que de 2 %. *Un seul compteur qui bouge est du bruit ; deux compteurs
indépendants qui bougent ensemble méritent un troisième point.* Test posé.

**Et un terrain neuf, qu'il ne faut PAS confondre avec celui d'hier.** HD-779-MA s'est tu le 15/08 à
12:48:21 — mais **sans aucun `POWER_CUT`**, en annonçant **100 % de batterie jusqu'à sa dernière
trame**. Le cas KSR370 était une coupure d'alimentation suivie d'une vidange ; celui-ci est une
extinction nette, trois minutes après son alerte `GPS_LOST`. *Deux boîtiers qui s'éteignent à un
jour d'écart ne partagent pas forcément une cause — c'est la colonne « batterie » qui les sépare,
et elle n'est lisible que dans les trames brutes.*

> **Piège d'outillage, et il coûtait un faux « rien à signaler ».** Dans
> `allowlist_audit_logs`, la colonne `action` **ne varie pas** : elle vaut `sync` sur les 162 lignes.
> Compter dessus donne l'impression qu'aucun blocage n'est enregistré. La colonne qui sépare un
> blocage d'un appel normal est **`outcome`** (`ok` = 127, `removals_blocked` = 35). *Une colonne
> constante ressemble à une absence de donnée ; c'est la mauvaise colonne, pas la mauvaise table.*
> Deux autres noms rectifiés au passage : la table est **`allowlist_entries`** (pas `sms_allowlist`)
> et son adresse d'appelant est **`ip`** (pas `actorIp`).

---

## 🎯 2026-08-15 — le test décisif répond enfin, et il tranche par le COMPORTEMENT

Depuis le 12/08, la perte des quatre correctifs ([TRK-019](#trk-019)) ne reposait que sur un `grep`
du binaire servi : une preuve d'**absence de code**, jamais de comportement. Ce passage la double
d'une preuve indépendante, sans toucher à la production — et le motif est net sur **deux véhicules**.

Le code de `main` fixe la cadence des rappels par une borne : `age < 2 j` → quotidien ; `2 j ≤ age <
14 j` → **hebdomadaire**. Le rappel de **48 h** tombe donc *au-delà* de la borne, et le rappel de 24 h
se trouve **dans** la fenêtre de 7 jours qui le filtrerait. Sous le code corrigé, **rien ne devait
être écrit à 48 h.**

| Véhicule | Épisode ouvert | Rappel 24 h | Rappel 48 h | Sous le correctif |
|---|---|---|---|---|
| **FZ-862-VY** | 12/08 08:50:11 | 13/08 08:50:15 | **14/08 08:55:15 — PRÉSENT** | devait être **absent** |
| **FS-253-HR** | 12/08 15:20:59 | 13/08 15:25:15 | **14/08 15:30:15 — PRÉSENT** | devait être **absent** |

> **Et l'énoncé du test désignait le mauvais instant.** La fiche du 14/08 tenait le **3ᵉ rappel
> (72 h)** pour « le volet qui distingue les deux codes », en lisant la phrase de documentation —
> « quotidien les deux premiers jours ». La condition aux limites du code bascule **dès 48 h** :
> c'est le 2ᵉ rappel qui discrimine. *Un test daté doit tirer son instant discriminant de la
> condition aux limites, pas de la prose qui la décrit — une prose exacte peut désigner le mauvais
> instant, et coûter un jour d'attente pour rien.*

**Trois compteurs bougent, et deux affirmations de fiche tombent :**

| Fiche | Ce qui change |
|---|---|
| [TRK-017](#trk-017) | **24 → 35 blocages**, dont **11 le 14/08** — sa journée la plus active, à la cadence horaire de 04:25 à 17:25. Clé de production **toujours pas rotationnée : 5ᵉ jour**. |
| [TRK-021](#trk-021) | **+4 échecs le 14/08 à 21:01 et 21:02** (6 → 10), deux paires à 52 s d'écart, **même compte utilisateur** qu'au 12/08. Un opérateur réessaie ; le mur est le même. |
| [TRK-013](#trk-013) | Le numérateur **n'est plus figé** : 7 → **8** clôtures strictement fausses. C'était l'argument qui justifiait de ne pas prioriser la fiche. |
| [TRK-024](#trk-024) | L'asymétrie « à sens unique » **ne tient pas** sur la mesure du jour : 0 boîtier `OFFLINE` vu récemment, mais **1** `ONLINE` muet — les deux sens se sont inversés en 24 h. |

**Et l'issue du cas concret de [TRK-023](#trk-023) :** KSR370 n'a plus émis depuis le 14/08 02:05,
soit **23 h** à la collecte. La coupure d'alimentation, la vidange de batterie et la mort du boîtier
ont été vues intégralement par la plateforme ; ce que l'exploitant a reçu, ce sont deux cartes rouges
vides puis deux avertissements au texte identique. Contrôle terrain à faire.

> **Piège d'outillage, et il vaut d'être retenu :** `/app/dist` **n'existe pas** — les quatre `grep`
> de marqueurs ont rendu **zéro partout, témoins compris**. Le `WORKDIR` est `/app/apps/api`, donc
> le chemin réel est **`/app/apps/api/dist/`**. La note du 14/08 écrivait « le vrai chemin est
> `dist/gps-integrity/` », un chemin **relatif** — inutilisable dans un `docker exec` qui ne part pas
> du `WORKDIR`. *Un chemin noté en relatif se relit en absolu par le lecteur suivant ; seule la forme
> absolue survit au passage d'un rapport à l'autre.* Deuxième journée consécutive où le témoin sauve
> la conclusion.

> **Et une aggravation a failli être inventée.** `observedResult` et `diagnosticHint` sont `NULL` sur
> les six échecs récents de TRK-021, ce qui se lisait volontiers comme « TRK-019 a désarmé jusqu'à
> l'enregistrement du motif ». Faux : le motif est dans **`lastError`**, écrit correctement, et il
> l'était déjà en mai. *Cette table porte trois colonnes de « pourquoi » ; en lire deux et conclure
> au vide fabrique un défaut qui n'existe pas.*

---

## 🔴 2026-08-14 — le défaut trouvé hier sur UNE alerte en vaut 42 038, dont 41 507 CRITICAL et 3 SOS

Troisième reconstruction depuis `feat/depot-partage` (13/08 17:18 UTC), **même point de fork**
(`c3c2704`, 07/08), **mêmes quatre marqueurs absents** des artefacts servis. [TRK-019](#trk-019)
n'est plus une découverte, c'est une cadence.

Ce que ce passage apporte tient à une seule décision de méthode : **ouvrir la colonne au lieu de
compter la ligne.** [TRK-023](#trk-023) avait été écrite hier sur **une** occurrence — une alerte
`UNKNOWN` sans message. En comptant les messages vides sur toute la table :

| Type | Total | Sans message | |
|---|---|---|---|
| **POWER_CUT** | 41 507 | **41 507** | **CRITICAL** |
| OVERSPEED | 9 399 | 486 | |
| VIBRATION | 37 | **37** | |
| **SOS** | 3 | **3** | |
| LOW_BATTERY | 6 | 4 | |
| UNKNOWN | 1 | **1** | |
| **Total** | **51 524** | **42 038 — 81,6 %** | |

La cause est une ligne : `buildAlertMessage` connaît 7 types et **tout le reste tombe sur
`default: return null`**. Et un second verrou la double — le pourcentage de batterie que la trame
porte (`,ac alarm,…,100%,`) n'existe dans **aucun champ** de `CobanPositionFrame` : même avec le
`case` manquant, il n'y aurait rien à écrire.

**Et cette nuit le défaut a rencontré un incident réel.** KSR370 a perdu son alimentation à 20:44,
vidé sa batterie de secours (**5 %** à 00:57, **0 %** à 01:12) et cessé d'émettre à **02:05**. La
plateforme a tout vu ; ce qu'elle a montré à l'exploitant, ce sont **deux cartes rouges vides**.

> **Ce que l'épisode apprend sur la méthode — une fiche écrite sur une occurrence n'a pas de
> portée, seulement un exemple.** TRK-023 était juste dès hier, et son « une occurrence, la
> fréquence n'est pas prouvée » était une prudence correcte. Mais la question posée était
> « combien de fois ce **code** d'alarme revient-il ? », alors que le défaut ne portait pas sur le
> code : il portait sur le **`default`**. *Compter les occurrences de l'exemple mesure l'exemple ;
> pour mesurer un défaut, il faut compter ce que sa cause gouverne.*

**Un défaut neuf, à sens unique :** [TRK-024](#trk-024) — **5 boîtiers sur 43 portent `OFFLINE`
alors qu'ils émettaient il y a moins de 5 minutes**, et **aucun** ne porte `ONLINE` à tort. Rien ne
casse aujourd'hui (les commandes passent par la socket vivante, l'écran refiltre sur `lastSeenAt`) —
ce qui casse, c'est le prochain lecteur.

> **Et une mise en garde d'hier a été payée en un jour.** TRK-017 notait que l'appelant extérieur
> s'était tu depuis six créneaux, en refusant d'y lire une clé révoquée. **Il a refrappé deux fois
> le 13/08** (22:24 et 23:24). *Le silence d'un attaquant se lit comme une absence de mesure, pas
> comme une absence de menace.*

> **Piège d'outillage, payé et documenté :** le premier `grep` des marqueurs a visé
> `dist/src/trackers/` et rendu **0 partout, témoin compris**. Le vrai chemin est
> `dist/gps-integrity/`. *Un zéro sur le témoin ne dit pas « correctif absent », il dit « mauvais
> chemin » — c'est toute la raison d'être du témoin, encore fallait-il le regarder avant la
> conclusion.*

> **Une limite structurelle de l'outil « test daté », découverte ce jour.** Le volet décisif de
> [TRK-001](#trk-001) échoit à **08:50 UTC** ; l'audit collecte vers **04:10 UTC**. Aucun passage
> de ce jour ne pouvait le lire, et le lire quand même aurait produit un faux « il ne s'est rien
> passé ». *Un test daté doit échoir AVANT l'heure de collecte, sinon il est reporté d'un jour par
> construction — et cette contrainte appartient à l'énoncé du test, pas à sa lecture.*

---

## 🔴 2026-08-13 — la perte est réimposée à chaque image, et trois défauts neufs sortent des angles morts

Le rapport du 12/08 prédisait que la perte des quatre correctifs « redevient effective à chaque
reconstruction ». **C'est mesuré** : deux reconstructions de plus le 12/08 (`tracky-api` 07:08,
`tracky-web` 14:15), la branche a avancé d'un commit — et `merge-base` avec `main` est **toujours**
le `c3c2704` du 07/08. Les quatre marqueurs restent absents des artefacts servis.

**Et cette fois la perte se mesure aussi dans la donnée.** Sur les **77 commandes** émises depuis le
redéploiement du 11/08 22:37, **zéro** porte un `diagnosticHint` « Aucune réponse… » ; le compteur
de silences tracés est figé à 81. *Un marqueur absent du binaire dit qu'un correctif n'est pas là ;
un instrument qui n'écrit plus rien le prouve.* Voir [TRK-019](#trk-019).

**La régression de [TRK-002](#trk-002) n'est plus une déduction** : deux lignes le 12/08 (09:20 et
14:40), aucune pendant les 27 h où le correctif était en ligne, trois lignes avant. Le contraste
porte sur trois périodes, pas sur deux mesures — et aucune des deux lignes ne tombe dans une fenêtre
de redéploiement.

**Trois défauts neufs, aucun visible au centre d'alerte :**

| Fiche | Ce que c'est |
|---|---|
| [TRK-021](#trk-021) | **19 des 23 commandes du catalogue sont déclarées SMS-only et partent en TCP.** `availableVia` n'est lu **nulle part** — ni côté API (une seule occurrence : l'exposer au front), ni côté web. 6 `ACK timeout` en base, **6 sur 6** sur des templates SMS-only. |
| [TRK-022](#trk-022) | **La survitesse ne peut alerter que sur 1 boîtier sur 43** — un seul émet des trames `,speed,` — et y produit **1317 alertes en un jour**, une par trame, sans aucune déduplication. |
| [TRK-023](#trk-023) | **L'accusé de réception d'une coupure moteur** (`jk`) échappe au dictionnaire de décodage, devient une alerte « Alarme inconnue » **sans message** pour l'exploitant. Chaîne prouvée de bout en bout en 4 secondes. |

> **Ce que l'épisode apprend sur la méthode — un test daté ne survit pas au changement de son
> sujet.** Le test posé pour le 12/08 attendait une ligne `error_logs` sur FZ-862-VY, dont l'épisode
> durait depuis cinq jours. Aucune ligne n'est venue. Sa condition d'échec disait « la lecture de la
> régression est fausse » — **et il ne fallait surtout pas l'appliquer** : l'épisode s'était refermé
> le 12/08 à 08:50, 35 minutes avant l'heure du test. La variable choisie comme la plus stable du
> tableau est celle qui a bougé. *Avant de lire un zéro comme un échec, relire l'état que le test
> supposait.* Test réarmé au 13/08, avec sa condition de nullité écrite.

> **Et une rectification d'outillage qui a coûté une mesure.** Le 12/08 avait conclu que
> `position_sampling_decisions` « n'existe pas ». Elle existe : ses colonnes sont `decision · state ·
> reason · speedKmh · ignition · distanceM · receivedAt`, sans `createdAt` ni `deviceTime` — les deux
> horodatages qui classent un rejet sont **dans le texte de `reason`**, et la table de jumelage est
> `positions."timestamp"`. *Une erreur de nom de colonne et une table absente rendent le même
> message ; `information_schema` les sépare en une requête.* La série de [TRK-015](#trk-015) reprend,
> avec un trou d'un jour.

---

## 🔴 2026-08-12 — un déploiement a effacé quatre correctifs, et rien ne l'a dit

Le centre d'alerte affiche zéro depuis 14 h. C'est vrai, c'est mesuré, et ça ne veut rien dire :
le déploiement du **11/08 à 22:37 UTC** a reconstruit la production depuis
**`feat/depot-partage`**, une branche de fonctionnalité qui a divergé de `main` le **07/08** —
donc **avant** les correctifs du 10/08 au soir.

Les commits `d5e5fb1` et `73440d8` sont absents de `HEAD` sur le serveur, et surtout leurs
marqueurs sont absents des **artefacts servis** — chaque `grep` accompagné d'une chaîne témoin,
parce qu'un `grep` vide peut vouloir dire « mauvais chemin » :

| Fiche | Marqueur cherché | Témoin (même fichier) | Verdict |
|---|---|---|---|
| TRK-002 | `consecutiveTransportFailures` | « Rafraichissement de session » ✅ | **ABSENT** du bundle servi |
| TRK-001 | `reminderIntervalMs` | « ANORMALEMENT LONG » ✅ | **ABSENT** |
| TRK-017 | `episodeOpenedAt` | « Allowlist SMS » ✅ | **ABSENT** |
| TRK-014 | `armAckListener` | `ack-waiter.service.js` présent ✅ | **ABSENT** |

`f7896d9` (les neuf correctifs du 04/08) est bien présent : seule la soirée du 10/08 est perdue.
Voir [TRK-019](#trk-019).

> **Ce que l'épisode apprend sur la méthode.** Les trois derniers rapports concluaient « les
> correctifs tiennent, vérifiés sur des mesures ». Ils avaient raison — le jour où ils l'ont
> écrit. Un correctif n'est pas un état acquis : c'est un état à **re-mesurer**. Et le seul
> instrument qui pouvait voir ça n'est pas dans l'application, il est dans la comparaison entre la
> branche déployée et `main`.

**Et le test daté de [TRK-001](#trk-001) est PASSÉ — treize heures avant d'être effacé.** Le 11/08,
l'alerte flotte de FZ-862-VY est sortie à 09:25 (cadence quotidienne, inchangée par le correctif)
pendant qu'**aucune** ligne admin n'était écrite (cadence espacée). Deux canaux indépendants, dont
un qui devait parler et un qui devait se taire : un détecteur éteint les aurait tus tous les deux.
*Un test qui prédit un silence ET un bruit conclut ; un test qui ne prédit qu'un silence, non.*

**Un second défaut, d'instrumentation cette fois.** `tracker_commands` porte **deux** colonnes
d'acquittement, et `collecte.sql` lit celle qui ne vient pas du boîtier : `ackedAt` (le boîtier,
**0 sur 4176**) et `acknowledgedAt` (humain / de masse, **30**). Les 30 ne sont pas 30 réponses —
27 partagent le même horodatage à la milliseconde et aucune ne porte de `ackResponse`. Aucune
conclusion passée n'est fausse (les deux valent zéro sur la fenêtre courante), mais le compteur est
prêt à mentir. Voir [TRK-020](#trk-020).

---

## 🎯 2026-08-11 *(2ᵉ passage, 09:22 UTC)* — le boîtier n'a jamais été muet : on lui parlait dans la mauvaise langue

Le test daté de [TRK-014](#trk-014), relu sur 13 h au lieu de 5, confirme sa deuxième ligne sur
3,4× plus de données : `total = 47`, `avec_ack = 0`, `silences_traces = 47`, et **zéro** commande
close par le chemin de l'ACK. Mais le chiffre n'était pas la découverte — **la comparaison l'était**.

Sur la même socket, la même fenêtre, les mêmes boîtiers, deux familles de commandes coexistent :

| Famille | Format | Trames | Réponses |
|---|---|---|---|
| moteur — `**,imei:<IMEI>,K;` | enveloppe TCP | 36 | **33**, en ~2,6 s |
| cadence — `fix005m***n123456` | texte SMS | 47 | **0** |

`fix_continuous` envoie la forme **SMS** de la commande sur la socket **TCP**, qui attend
`**,imei:<IMEI>,C,05m;`. Le boîtier reçoit la trame, ne sait pas la lire, ne l'applique pas et ne
répond rien. **Quatre mois, 4 120 commandes, aucune réponse — et la réponse était dans le dépôt** :
`docs/03-protocol-coban-gps403d.md` §4.2.1 donne le format TCP depuis l'origine. Voir
[TRK-012](#trk-012).

> Les deux hypothèses que la table de décision laissait en lice — « la commande n'arrive pas » et
> « le mot de passe est refusé » — sont **toutes les deux fausses**. La trame arrive, et le mot de
> passe n'a jamais été lu. *Une table de décision bien construite peut être exhaustive sur les
> réponses qu'elle envisage et passer à côté de la bonne.*

**Et une affirmation de fiche vieille de quatre jours tombe.** Les trames `jt`/`kt`, écartées le
07/08 comme « des rapports de minuterie qui ne répondent à aucune commande », sont **33 sur 33**
corrélées à une commande moteur dans les 15 s, avec écho exact de la lettre. C'étaient de vrais
accusés de réception — donc la preuve, disponible depuis le 07/08, que le canal descendant
fonctionnait. *Un compteur qu'on a disqualifié une fois ne se re-vérifie plus jamais.*

**Rien n'a été codé** : la cause est établie, mais changer la trame émise change ce que reçoivent
43 boîtiers en service. Le test de validation tient en une trame sur un boîtier, sans SMS, sans
allowlist, non destructif — il est écrit dans [TRK-012](#trk-012), et il attend un accord.

---

## 🔎 2026-08-11 — le silence du boîtier est PROUVÉ, et le repli SMS n'a jamais eu de preuve de remise

Première nuit complète après les correctifs du 10/08 au soir. **Zéro ligne `error_logs` en six
heures**, et les trois correctifs déployés font ce qu'ils annonçaient — vérifiés chacun sur une
mesure, pas sur leur intention.

Le test daté de [TRK-014](#trk-014) rend son verdict, et c'est le deuxième cas de sa table de
décision : `total = 14`, `avec_ack = 0`, `silences_traces = 14`. **Le boîtier ne répond jamais —
prouvé, plus supposé.** L'écoute armée la veille a produit quatorze silences tracés en cinq heures.
Ce que ça débloque n'est pas un correctif : c'est le droit d'éliminer une hypothèse. « Le firmware
accepte mais n'applique pas » n'est **pas** confirmée ; le test SMS sur un boîtier redevient le seul
discriminant, et le correctif de [TRK-012](#trk-012) reste suspendu.

> La garde la plus fragile a tenu : les 14 commandes sont `FAILED` par les chemins ordinaires
> (réconciliation, échéance), **aucune par l'ACK**. Armer une écoute sans lui donner de pouvoir de
> décision était le point où la récidive était la plus probable.

**Et un angle mort neuf, trouvé en ouvrant une table qu'aucun passage n'avait ouverte.**
`engine_control_commands` : **112 commandes moteur reparties en SMS depuis le 03/06, aucune
acquittée**, statut `SENT` définitif. Côté passerelle, les **112 messages correspondants sont
encore en `queued`** — et **aucun message sortant, sur 310 depuis l'origine, n'a jamais dépassé cet
état**. Voir [TRK-018](#trk-018).

> Le constat n'est pas « les SMS n'arrivent pas » — c'est que **rien, nulle part, ne peut le dire**.
> Un véhicule est coupé et redémarré chaque nuit par ce canal. La cécité se distingue mal d'un
> fonctionnement normal : c'est exactement ce qui l'a laissée passer dix semaines.

**Ce que l'épisode apprend sur la méthode.** Deux instruments posés la veille ont répondu en une
nuit, et **un troisième s'est périmé dans le même geste** : le comptage de lignes `sms-allowlist`
proposé comme discriminant de [TRK-017](#trk-017) est devenu illisible, deux causes se superposant
désormais (la garde empêche le trou, l'alerte est passée par épisode). Le journal d'appels l'a
remplacé — et il renverse l'hypothèse « appelant actif aux heures ouvrées » : la machine a frappé à
21:25, 22:25, 23:25 et 00:25 UTC. *Un instrument neuf périme parfois celui qui l'a fait naître ;
encore faut-il s'en apercevoir avant de lire son zéro comme une bonne nouvelle.*

**Et deux en-têtes de fiche disaient faux** — vérifiés sur `main`, pas recopiés : TRK-001 et TRK-002
étaient annoncés « écrits, pas déployés ». Le commit `d5e5fb1` les contient, et il est en production
depuis le 10/08 19:39. *Une fiche écrite le soir d'un déploiement décrit l'état d'avant.*

---

## 🔎 2026-08-10 — le seul repli du coupe-circuit était coupé pour 24 boîtiers sur 43

Deux lignes inédites, source `sms-allowlist`, et derrière elles le trou le plus coûteux vu depuis
l'amorçage : **25 numéros sur 41 étaient absents de l'allowlist de la passerelle SMS, dont 24 SIM
de boîtier.** Le mode allowlist est actif ; un numéro absent reçoit un `403` levé **avant** toute
écriture. Un SMS refusé pour ce motif ne laisse donc **rien** : ni message en échec côté passerelle,
ni ligne d'erreur côté Tracky. Voir [TRK-017](#trk-017).

> Ce n'est pas un canal dégradé, c'est un canal absent — et c'est le **dernier recours** du
> coupe-circuit, celui qu'on utilise précisément quand le boîtier ne répond pas sur TCP. Or
> [TRK-014](#trk-014) a établi qu'il ne répond **jamais**.

**Ce que l'épisode apprend sur la méthode.** La ligne qui a tout révélé est celle d'un garde-fou
écrit le 27/07 pour ce défaut exact. Il a fallu treize jours pour qu'elle apparaisse — et l'enquête
ne peut pas dire si c'est parce que le trou vient de se former ou parce que le garde-fou ne tourne
pas à la cadence déclarée. Les deux lectures mènent à des correctifs opposés. **Un test daté les
sépare sans écrire une ligne de code** : relire `createdAt` des entrées demain. C'est écrit dans la
fiche, avec sa condition d'échec.

> ### 🔄 Suite — 2ᵉ passage du même jour, 17:12 UTC : le test daté a tranché, et il renverse la lecture
>
> Passage supplémentaire demandé par le propriétaire, seize heures après le premier. Le test posé
> pour le 11/08 a été exécuté avec de l'avance, et **la lecture A est écartée** : la réconciliation
> tourne parfaitement — six exécutions de plus dans la journée, toutes `+25 / -0`. Ce ne sont pas
> les numéros qui manquaient depuis treize jours, ce sont les entrées qui **sont effacées en bloc
> et recréées** au h:25 suivant. **Au moins six réouvertures du trou en 19 h**, chacune jusqu'à
> 60 minutes.
>
> Six pistes d'attribution ont été fermées (synchro Tracky, route d'admin, 2ᵉ instance,
> `vizyo-manager`, ménage programmé, tenant concurrent) — et **aucun instrument en place ne peut
> nommer l'appelant** : pas de journal d'accès au proxy, pas de table de requêtes dans la
> passerelle, `docker logs` du relais muet, point d'entrée exposé publiquement. C'est ce vide-là,
> et non le compteur, qui devient le correctif nº 0.
>
> **La leçon de méthode est double.** D'abord : *refuser de trancher a payé* — un correctif choisi
> le 09/08 aurait supervisé un cron qui tournait déjà. Ensuite : *une absence de ligne ne se lit
> pas seule.* « Aucune ligne entre le 27/07 et le 09/08 » avait été lu comme « le trou durait
> depuis treize jours » ; en régime B, la même absence signifie exactement l'inverse — **rien ne
> manquait**. Le fait était juste, l'inférence était retournable. Voir [le rapport du 2ᵉ passage](./rapports/2026-08-10-passe-2.md).

Et un second épisode **en rafale** de [TRK-015](#trk-015), sur un autre véhicule que celui du 08/08 :
GS-014-NY perd 21 minutes de trajet (entrée à 15 km/h, sortie à 130 km/h), 60 trames tamponnées
écartées. Le mécanisme n'était pas propre à HD-779-MA.

**Piège d'outillage :** `docker logs texto-relay` ne rend jamais la main sur cet hôte (deux essais,
sortie vide). Aucune conclusion de ce passage ne s'appuie sur des journaux de conteneur. *Un journal
illisible n'est pas un journal vide.*

---

## 🔎 2026-08-09 — le test daté passe, et deux pertes silencieuses se révèlent

Le rapport du 08/08 avait posé un test vérifiable à date : l'épisode GPS ouvert sur FZ-862-VY
devait franchir le plafond de 24 h vers le 08/08 09:07 UTC. **L'alerte est arrivée à 09:10:15**, au
premier tick suivant l'échéance. C'est la première vérification de [TRK-011](#trk-011) sur un
épisode **neuf** — le mécanisme tient sur un cas indépendant, pas seulement sur les deux véhicules
suivis depuis cinq jours.

> Un audit qui écrit un test daté et sa condition d'échec obtient une réponse. Celui qui écrit
> « à surveiller » n'obtient rien.

Derrière ce calme, deux pertes qui ne produisent aucune ligne :

1. **Une coupure réseau de 6 h 17 sur HD-779-MA a fait rejeter 1643 positions tamponnées d'un seul
   bloc.** Le trou est prouvé en base — aucune position entre 07/08 23:00 et 08/08 05:16, alors que
   le véhicule roulait à 87 km/h en y entrant et à 127 km/h en en sortant. [TRK-015](#trk-015)
   décrivait une perte diffuse ; elle est aussi **en rafale**. Et le boîtier concerné est celui
   dont l'incident de téléportation de juin a motivé l'écriture du garde-fou.
2. **89,8 % des trajets du 08/08 s'affichent en trace brute** : le recalage cartographique échoue
   depuis avril (80,7 % sur 12 462 trajets). Voir [TRK-016](#trk-016).

**Et le remède d'outillage d'hier était faux.** Le 08/08 avait établi que `docker logs --since`
ment sur ce conteneur, et recommandait `--tail N`. Mesuré ce jour : `--tail 200000` renvoie
3714 lignes s'arrêtant **79 minutes avant l'heure courante**, quand `--tail 3` donne la seconde.
Ce qui survit est la règle générale, pas le remède particulier : *citer le premier et le dernier
horodatage réellement observés*. C'est elle qui a attrapé ce piège-ci.

---

## 🔎 2026-08-08 — le centre d'alerte est muet pour la première fois, et 3466 positions manquent

Zéro ligne `error_logs` en 24 h — jamais vu depuis l'amorçage. Vérifié avant de s'en réjouir : le
détecteur GPS tourne, il a enregistré deux nouveaux épisodes le 07/08, les crons de commandes ont
créé et soldé 74 commandes. Le capteur n'est pas éteint : **les deux pertes GPS ouvertes depuis
quatre nuits se sont refermées**, et il n'y avait plus rien à rappeler.

Pendant ce temps, une perte de données tournait sans produire une seule alerte. Le garde-fou
d'ingestion — écrit pour empêcher la téléportation (incident HD-779-MA du 10-11/06) — a écarté
**8360 trames en 4 jours sur les 37 boîtiers du parc**. Sur ces 8360, **3466 n'ont aucune position
à ± 60 s dans la base** : ce sont des trous, pas des doublons. Voir [TRK-015](#trk-015).

> Dans la **même** classe de rejet, un tiers des trames sont des fantômes prouvés et la moitié
> sont des trous prouvés. Un critère unique ne peut pas être juste pour les deux — et c'est la
> donnée qui le dit, pas le raisonnement.

**Et un piège d'outillage qui invalide une méthode de mesure :** `docker logs --since 26h` a
renvoyé 205 lignes **se terminant 25 h avant l'heure courante**, quand `--tail 5` renvoyait des
lignes de la minute (`json-file`, `max-size=10m`, `max-file=3` — `--since` traverse mal les
fichiers tournés). Toute affirmation tirée des journaux doit désormais citer le **premier et le
dernier horodatage réellement observés**, jamais la fenêtre demandée. *Le « 62 auto-alignements en
24 h » du 06/08 était vraisemblablement une tranche plus courte : la conclusion tient (aucune
valeur sous 20 s, confirmée à nouveau ce jour sur 29 mesures), le libellé de fenêtre non.*

---

## 🔎 2026-08-07 — 3797 commandes depuis avril, pas un seul accusé de réception

Le journal de trames (`wire_logs`) tranche la question que TRK-012 laissait ouverte. Sur 4 jours :
**275 commandes `fix…***n123456` envoyées à 35 boîtiers, et aucune trame entrante contenant
« ok », « fix », « error » ou « password ».** Le boîtier ne répond rien.

Et personne n'écouterait de toute façon : le chemin adaptatif écrit `SENT` puis passe à la suite,
sans jamais armer `waitForAck` — alors que le catalogue définit bien un motif d'ACK pour
`fix_continuous`. `ackedAt` est **NULL sur les 3797 commandes** émises depuis le 2026-04-27, tous
templates confondus. Voir [TRK-014](#trk-014).

> Une chaîne de commande qui n'a jamais reçu de réponse en trois mois n'est pas « peu fiable ».
> Le savoir change ce qu'on peut conclure de chaque échec en aval.

**Et deux fiches disaient faux — vérifiées sur le code, pas recopiées :**

1. **TRK-007** affirmait qu'il n'existe pas d'`expectedAckPattern` pour `fix_continuous`. Le
   catalogue en définit un (`coban.catalog.ts:177`, `/fix.*ok/i`, 15 s). Ce qui manque est
   l'appel, pas le motif.
2. **TRK-008** portait une réserve sur un chemin d'écriture « non borné, plancher à 1 s ». Il est
   borné à 20 s depuis V1.19 (`tracker-fix-mode.service.ts:67`). Ce qui a induit la réserve en
   erreur est un **commentaire périmé** laissé en place aux lignes 473-478, qui annonce encore le
   comportement d'avant le correctif. *Un commentaire périmé fabrique un faux constat aussi
   sûrement qu'un bug.*

---

## 🔎 2026-08-06 — le correctif de TRK-007 marche, et il fabrique un message faux

Première fenêtre de **28 h sans redémarrage** depuis le correctif (`restarts=0` depuis le 04/08
21:32 UTC) : la comparaison porte enfin sur une journée pleine. Tout tient — 0 commande en
attente, 0 cible sous le minimum matériel, et cette fois vérifié **sur les journaux** et pas
seulement sur un instantané : 62 auto-alignements en 24 h, aucun sous 20 s.

Mais le balayage qui solde les commandes **clôt tout en `FAILED`, sans jamais comparer**. Trois
clôtures sur dix-sept annoncent « sans effet constaté : cadence réelle 20 s pour une cible de
20 s » — l'intervalle demandé est exactement celui observé. Voir [TRK-013](#trk-013).

> Un correctif qui solde correctement une file d'attente peut, dans le même geste, remplir le
> journal d'échecs qui ne sont pas des échecs. Le compteur ainsi gonflé est **celui qui sert à
> juger les autres fiches**.

Et une fiche disait faux : TRK-011 annonçait une dédup « par épisode ». Elle est **par 24 h**
(`alerts.service.ts:156`, fenêtre documentée). Les deux lignes des dernières 24 h sont donc des
rappels quotidiens sur des épisodes déjà connus, pas des doublons — un audit qui aurait cru la
fiche aurait enquêté pour rien.

---

## 🔎 2026-08-05 — les correctifs tiennent, mais TRK-008 se trompait sur 90 % de son volume

Vérifié en production 3 h 40 après le déploiement (conteneurs recréés le 04/08 à 21:30 UTC,
`restarts=0`) : **plus aucune cible sous le minimum matériel**, **plus aucune commande en
attente**, et le plafond de silence GPS a produit **ses deux premières alertes**. Les correctifs
de la nuit font ce qu'ils annonçaient.

**Et pourtant le volume d'échecs de commandes n'a pas bougé d'une ligne** — 14 échecs sur la
fenêtre 21:30 → 01:10, exactement comme la veille, sur les mêmes six boîtiers, à 9 millisecondes
près sur l'horodatage.

Parce que la cause n'était pas celle qu'on croyait. TRK-008 attribuait ses 295 échecs
« intervalle observe: 20 s » à une cible descendue sous le minimum matériel. **281 de ces 291
échecs demandaient en réalité 300 s** (`params.interval = '005m'`) — une consigne parfaitement
légitime. Le correctif ne pouvait donc pas les faire disparaître. Voir [TRK-012](#trk-012).

> Une cause racine se vérifie sur la **donnée de la commande**, pas sur la vraisemblance du récit.
> Le récit de TRK-008 était cohérent, documenté, et il expliquait 10 % des cas.

---

## 🟢 2026-08-04 — les neuf fiches ouvertes ont été corrigées et déployées

Livré en production le 2026-08-04 (PR #86, `f7896d9`, smoke-boot OK, `restarts=0`). Le fil
commun n'était pas « des bugs » : **le centre d'alerte ne disait pas la vérité — il criait
pour des non-fautes, et se taisait sur de vraies pannes.**

| Fiche | Ce qui a été livré |
|---|---|
| **TRK-011** | Plafond de silence de 24 h sur une zone bénigne. Le forçage est explicite : une zone confirmée est aussi « recognized », donc sans lui le dépassement n'aurait produit **aucune** ligne. |
| **TRK-008** | Cible clampée **à la lecture** (valeurs héritées neutralisées sans migration) · émettre plus vite **en mouvement** n'est plus une faute · plancher d'auto-alignement remonté · normalisation des cibles stockées. |
| **TRK-007** | Échéance **purement temporelle** (30 min). La conditionner à un état du boîtier l'aurait fait retomber dans le même piège. |
| **TRK-004** | `ExpectedRefusalException` — marqueur structurel, jamais textuel. Hérite de `ServiceUnavailableException` pour que la réponse HTTP ne bouge pas d'un octet. |
| **TRK-005** | Échec de l'API carburants marqué passager. Le message n'a pas bougé : il était déjà bon. |
| **TRK-003** | CRITICAL exige désormais que ça **dure** (2 min) ou que ça **recommence** (2ᵉ report dans l'heure). |
| **TRK-002** | Garde de visibilité + réessai silencieux à 3 s, sur le chemin proactif. |
| **TRK-009** | Boîtiers jamais mis en service exclus. Une pose ratée (jamais vu **mais** rattaché) reste signalée. |
| **TRK-010** | `ERROR_LOGS_RETENTION_DAYS=90` en production. |

### Vérifié en production, pas seulement en test

- **TRK-007** — le balayage a réellement tourné : *« 3 commande(s) fix_continuous close(s) par
  échéance »*, avec le texte attendu : « Sans effet constaté après 305 min : cadence réelle
  3601 s pour une cible de 20 s. »
- **TRK-008** — `fixCommandFailing` = 0 sur 43 boîtiers, **0 échec** depuis le déploiement.
- **TRK-009** — le compteur « hors ligne » passe de 7 à 4 ; les 3 boîtiers en stock sont écartés.
- **TRK-010** — `ERROR_LOGS_RETENTION_DAYS=90` lu dans l'environnement du conteneur.
- **TRK-011** — le détecteur tourne et **supprime correctement** : FS-253-HR est à 13,3 h,
  sous le plafond de 24 h. C'est le comportement voulu — un stationnement de nuit reste
  silencieux. Le déclenchement réel s'observera au franchissement des 24 h.

### ⚠️ Deux tests verrouillaient l'ancien comportement

Recalibrés, pas supprimés — leur intention restait juste :

1. *« SUPPRIME l'alerte en zone confirmée »* utilisait une perte de **29 h** et verrouillait donc,
   sans le vouloir, le trou de TRK-011. Il teste désormais une perte **courte**.
2. *« auto-aligns desired to a sub-20s interval (V1.15) »* verrouillait le **contournement** qui a
   produit toute la dérive. Remplacé par ce qui traite la cause.

> Si rien ne casse en corrigeant un défaut, se méfier : c'est souvent qu'un test protégeait le bug.

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
| [TRK-045](#trk-045) | *commandes / débit* | **La commande de cadence arrive enfin — et le boîtier fait l'inverse** : × 2,9 de trames sur toute la flotte, 23 boîtiers à 4–6 s, pour **moins** de positions stockées | 🔴 **NON CORRIGÉ · GRAVITÉ 1 · EN COURS DEPUIS LE 23/08 04:01** *(nouvelle ; conséquence directe et non anticipée du correctif [TRK-012](#trk-012). **Débit : 6 826 → 19 794 trames/h**, rampe **monotone** commençant à l'heure exacte du déploiement, chaque boîtier basculant après SA première trame `,C,`. **23 des 32** boîtiers ayant reçu une trame émettent à ≤ 10 s, contre **1 sur 6** parmi ceux qui n'en ont pas reçu. Mesuré au centième sur HD-603-XY : **5,00 s** pour une cible de 20 s. La forme **minutes** échoue **8 fois sur 8** (`,C,05m;` → 4–6 s) ; la forme secondes est mitigée (9 honorent, 15 s'effondrent) — piste sérieuse, **pas** une explication complète. Coût : × 2,9 de données SIM sur 43 cartes et d'écritures `wire_logs` sur un VPS à 2 cœurs, pour des positions stockées **en baisse** (25 713 → 20 225). 🔑 **La plateforme allait mieux quand ses commandes étaient ignorées.** ⚠️ **ne pas juger au compteur FAILING** — il dépend de l'heure de la mesure (garde V1.19 : émettre vite EN MOUVEMENT est exonéré) ; les grandeurs stables sont le **débit/heure** et le **nombre de boîtiers à ≤ 10 s**. ⚠️ **ces boîtiers ne se réparent pas seuls** : `AUTO_ALIGN_FLOOR_S` = 20 s refuse d'accepter 5 s, et `requestChange` cesse d'émettre vers un boîtier FAILING)* | 2026-08-24 | 2026-08-24 |
| [TRK-044](#trk-044) | `fleet-places` | **`parisHour()` rendait NaN** — la porte planifiée de « Automatisation des lieux » était fermée À TOUTE HEURE, depuis l'origine | 🟢 **CORRIGÉ ET DÉPLOYÉ le 23/08** *(mesuré dans le conteneur de prod : `Number("04 h")` = NaN. La tâche n'a JAMAIS pu se déclencher sur son planning — le seul passage réel est un run manuel. Util commun `heureParis()` testé à instants figés ; les deux copies privées délèguent. **Test daté 24/08 01:10 UTC** : première ligne `origin='scheduled'` attendue de toute l'histoire de la tâche)* | 2026-08-23 | 2026-08-23 |
| [TRK-043](#trk-043) | `trip-automation` | **La cadence déclarée n'est pas la cadence exécutée** — 14 passages horaires sur 24, la garde anti-double-run se mesure depuis la **fin** du passage précédent | 🟢 **CORRIGÉ ET DÉPLOYÉ le 23/08** (PR #109) · **GRAVITÉ 3** *(nouvelle ; `frequency = 'hourly'`, cron `0 45 * * * *`, **14 passages en 24 h**. `lastRunAt` est écrit à la CLÔTURE (`:768`) et la garde compare le tick à cette valeur (`:217`, seuil 50 min) : **tout passage de plus de 10 min emporte le tick suivant**. **23 des 24 ticks du 22/08 expliqués exactement** ; le 24ᵉ (12:45) tombe 3 min avant une recréation de conteneur. 🔑 **`RUN_BUDGET_MS` vaut 50 min, le seuil aussi** — un passage qui consomme tout son budget GARANTIT l'annulation du suivant : le frein serre le plus fort quand la charge est la plus forte. Série 7 j : le seul jour à 24/24 est celui à **1,2 min** de moyenne. ⚠️ **pas une perte de donnée** (fenêtre de 26 h), mais une latence ×2 et surtout un **silence total** — le `return` est muet. Famille : **angle mort**. ⚠️ **ne pas baisser le seuil** : le défaut est dans le point de mesure, pas dans sa valeur ; ⚠️ **ne pas supprimer la garde** : elle protège le redémarrage, que `this.running` ne couvre pas)* | 2026-08-23 | 2026-08-23 |
| [TRK-042](#trk-042) | `scheduled-task-heartbeat` | **Une tâche qu'on vient d'activer est déclarée « à l'arrêt »** — la branche « aucun passage enregistré » n'a aucune borne de durée | 🟢 **CORRIGÉ ET DÉPLOYÉ le 22/08 13:31** *(7 `CRITICAL` en une matinée sur « Automatisation des lieux », activée à 06:02 et quotidienne à **03:00** : premier passage possible 21 h plus tard, déclarée à l'arrêt **33 min** après l'activation puis **toutes les heures**. ✅ **Vérifié PAR LE COMPORTEMENT** : le passage de 13:35 — le premier après déploiement — n'a **rien écrit**. 🔑 **Même défaut que [TRK-030](#trk-030) sur un autre module** : une branche « ça n'est jamais arrivé » sans borne transforme une naissance en panne)* | 2026-08-22 | 2026-08-22 |
| [TRK-040](#trk-040) | *alertes* | **Une alarme d'alimentation à batterie pleine est déclarée « contact coupé » — y compris quand c'est une vraie coupure qui commence** | 🟢 **CORRIGÉ ET DÉPLOYÉ le 23/08** (PR #112 — contact + sursis + cron power-cut-recheck ; migration 4 colonnes) *(nouvelle ; DZ-034-CA le 21/08 : `kt` **contact remis** 06:00:07, `ac alarm` 06:23:46 à **100 %** → `contact_coupe`, 0 alerte ; batterie 100 → 0 % ; `POWER_CUT` 12:36:14 ; **boîtier mort depuis 12:43:53**. **6 h 12 min 28 s** de retard, et `lastPowerNotice` affirme toujours « pas en péril ». Famille **mensonger**. ⚠️ **ne pas corriger en baissant le seuil de 90 %** — le discriminant manquant est **l'état du contact**, pas son réglage. Pas le chemin de [TRK-032](#trk-032) : 0 commande moteur sur ce tracker)* | 2026-08-22 | 2026-08-22 |
| [TRK-041](#trk-041) | `sms-allowlist` | **La rotation de la clé a supprimé le seul témoin de l'intrus** — `allowlist_audit_logs.tenantId` est `NOT NULL`, donc une clé révoquée n'écrit aucune ligne | 🟢 **CORRIGÉ (vizyo-texto PR #7), DÉPLOYÉ le 23/08** — chaque refus laisse une ligne (préfixe × IP), vue admin /admin/auth-failures *(nouvelle ; rotation **confirmée** par les préfixes — `vtx_48fe` jusqu'au 20/08 13:25, `vtx_d4f3` dès 14:25. Mais blocages figés à **49**, dernier le 17/08 19:24:59 = **102,0 h**, le plus long silence de la série — et le premier qui **ne prouve même pas une absence**. Lié à [TRK-017](#trk-017) et [TRK-025](#trk-025))* | 2026-08-22 | 2026-08-22 |
| [TRK-039](#trk-039) | `GPS_QUALITE` | **L'agent qualité GPS accuse l'antenne d'un boîtier hors ligne depuis 8 jours** — et sa récidive du 22/08 a une cause mesurée : **son anti-répétition a été EFFACÉE** | 🟢 **CORRIGÉ ET DÉPLOYÉ le 23/08** (PR #116 — les 5 correctifs ; test daté du 29/08 maintenu, désormais « plus jamais tant qu'il est mort ») *(2ᵉ occurrence le 22/08 06:07, **2 jours** après la 1ʳᵉ et non 7. 🎯 **Cause trouvée** : `dejaSignalees()` lit `error_logs` LUI-MÊME ; la ligne du 20/08 a été supprimée dans la fenêtre des 73 effacements de [TRK-035](#trk-035), donc la requête a rendu `[]` et l'agent a réémis. Vérifié : elle rend `["KSR370"]` maintenant, et l'agent avait signalé **0** boîtier le 21/08. 🔴 **L'hypothèse « la clé inclut le compte d'épisodes » est RÉFUTÉE** — la clé est la plaque, rien d'autre. ⚠️ **Conséquence qui dépasse la fiche : effacer `error_logs` RÉARME les boucles d'alerte** — et le correctif proposé pour [TRK-038](#trk-038) hériterait du même défaut, sur 4 gardes au lieu d'1)* | 2026-08-21 | 2026-08-22 |
| [TRK-038](#trk-038) | *plateforme* | **Quatre gardes anti-répétition d'alerte vivent en mémoire de processus** — chaque déploiement les remet à zéro | 🟢 **CORRIGÉ (PR #106, déployé le 22/08 16:00) — PREUVE TERRAIN ACQUISE le 23/08** : première ligne de `refroidissements_alerte` (`speed-limit-osm`, émission 03:47:35.397, ATOMIQUE avec le constat 03:47:35.415) et intervalle de **7 h 59** tenu À TRAVERS deux redéploiements (22/08 19:48 → 23/08 03:47) — la garde survit désormais au redémarrage, ce que la mémoire de processus ne pouvait pas *(historique : mesuré sur les 6 lignes du 20/08 : intervalles 5 h 00 · 3 h 59 · **6 h 02** · 1 h 57 · 1 h 03 pour une garde de 6 h. **La garde n'est pas cassée, elle est volatile** — l'intervalle de 6 h 02 prouve qu'elle tient quand le processus vit, et 3 des 4 trop courts suivent une remise en service. Jumeaux : `error-rate-watchdog` (**l'alarme de flambée d'erreurs**), `allowlist.service` ([TRK-017](#trk-017)), `surveillance-scheduler`. 🔴 **1 intervalle inexpliqué** : 10:47 → 14:46, aucun redémarrage connu — fait consigné, non expliqué)* | 2026-08-21 | 2026-08-23 · ✅ **TEST DATÉ DU 23/08 RÉPONDU — « non »** : aucun redémarrage depuis le 22/08 13:31, et les deux lignes `speed-limit-osm` postérieures sont espacées de **6 h 00 min 57 s**. La garde de 6 h **tient au centième près quand le processus vit** ; le seul intervalle court du jour (1 h 00) encadre un redéploiement — **2 cas sur 2 expliqués**. 🔴 Table `refroidissements_alerte` **ABSENTE de la production** : **PR #106 ouverte le 22/08 14:29, non fusionnée**. *Ce que le test démontre, c'est que la garde fonctionne — donc que la seule chose qui l'empêche de fonctionner est le redémarrage.* · 🔴 **AMENDÉ le 22/08 : le correctif proposé NE DOIT PAS être appliqué tel quel** — ranger la mémoire des 4 gardes dans `error_logs` les exposerait à l'effaceur de [TRK-035](#trk-035), défaut mesuré sur [TRK-039](#trk-039) le jour même. *Un garde-fou ne doit pas ranger sa mémoire dans la pièce qu'il surveille.* |
| [TRK-037](#trk-037) | `trip-analysis` | **Overpass (OpenStreetMap) injoignable** — les excès de vitesse ne sont plus affirmés, et l'analyse est rendue **sans mention de la lacune** | 🔵 TERRAIN / dépendance tierce *(nouvelle ; 6 occurrences le 20/08, HTTP 500 ×4 / 502 ×2, sur le miroir **public et gratuit** `overpass.kumi.systems`. Le code est soigné — cache, lots, plafond, backoff, et `trouvee === false` non mémorisé. **Ce n'est pas un défaut de fabrication : c'est une dépendance sans repli.** ⚠️ **sa date de première apparition est INCONNAISSABLE** — la plus ancienne ligne survivante de la table **est** l'une d'elles, cf. [TRK-035](#trk-035))* | 2026-08-21 | 2026-08-22 |
| [TRK-032](#trk-032) | *alertes* | **33 boîtiers sur 42 ont leur alarme d'alimentation éteinte chaque nuit** — « coupure commandée par nous » déduit de la dernière commande moteur, **sans borne de temps** | 🟢 **CORRIGÉ ET DÉPLOYÉ le 2026-08-22 04:54** *(PR #93→#99 ; marqueur `FENETRE_COUPURE_COMMANDEE_MS` **présent ×2** dans le `dist/` servi. ⚠️ **NON EXERCÉ** : **0 trame `ac alarm` depuis le 21/08** — rien à arbitrer, donc rien de prouvé. État du 23/08 à 01:1x, **même heure** que la veille : **31 boîtiers sur 42** (29 `CUT`/`ACKNOWLEDGED` + 2 `CUT`/`SENT`), contre 35 — 2 points, aucune tendance)* · ancien statut : *(commit `e88a5eec` du 20/08 : fenêtre de 15 min, 6 tests dont 2 qui échouent sur le code d'avant, 49 tests au vert. **Poussé sur `origin` le 20/08, sans PR ni fusion** *(rectifié le 22/08)* — relecture humaine obligatoire. ⚠️ « exclure `SENT` » a été RÉFUTÉ pendant la correction : la citation de TRK-014 portait sur `tracker_commands`, pas sur les commandes moteur, qui sont bien acquittées (2 857). Le repli SMS reste en `SENT` à vie, l'exclure aveuglerait le coupe-circuit)* · **GRAVITÉ 1** *(nouvelle ; mesuré à 01:1x le 20/08 : 30 `CUT`/`ACKNOWLEDGED` + 3 `CUT`/`SENT`. L'automatisation horaire coupe la flotte à 18:00-20:00 et la rétablit à 06:00 : la silenciation couvre exactement les heures de stationnement sans surveillance)*  · 🆕 **21/08 : 29 boîtiers sur 42 silenciés à 04:33, tous par un `CUT` vieux de 8,7 h.** ⚠️ **le 33 du 20/08 a été mesuré à 01:1x — deux heures différentes, AUCUNE tendance** ; ce qui compte n'est pas le nombre mais la **largeur de la fenêtre de silence**. Correctif **poussé sur `origin`, sans PR ni fusion** *(rectifié le 22/08)* | 2026-08-20 | 2026-08-22 |
| [TRK-036](#trk-036) | `sms_logs` | **L'accusé de réception du boîtier arrive, est stocké par Tracky, et n'est jamais rattaché** — `imei` NULL alors que `fromNumber` = `simPhoneNumber` | 🟢 **CORRIGÉ ET DÉPLOYÉ le 2026-08-22 04:54** *(PR #93→#99 ; marqueur `simPhoneNumber` présent dans `sms-gateway.service.js` servi. ⚠️ **NON EXERCÉ** : **87 entrants, 85 sans `imei`**, strictement inchangé, dernier entrant le **19/08 08:28** — aucun accusé neuf depuis le déploiement)* · ancien statut : *(commit `435e65f2` du 20/08 : résolution de l'émetteur sur les 9 derniers chiffres + écouteur qui acquitte sur le COUPLE (boîtier, action), jamais sur le temps. **3 abstentions testées** : ambiguïté, panne de résolution, panne de l'écouteur. ⚠️ explique pourquoi on ne VOYAIT pas les accusés, PAS pourquoi il n'y en a que 2 en 5 semaines — [TRK-018](#trk-018) reste entière)* *(nouvelle ; « Resume engine Succeed » reçu le 19/08 08:28:58 depuis la SIM de GS-014-NY, commande `RESTORE` créée 3 h 50 plus tôt **toujours `SENT`** 21 h après. Précise [TRK-018](#trk-018) : la preuve n'est pas absente, elle est jetée)* *(🆕 **21/08 : ce n'est PAS un cas isolé** — **87 SMS entrants, 85 sans `imei`**, et outre « Resume engine Succeed » du 19/08, « **Stop engine Succeed** » du **13/07 04:17:38** est dans le même état. **Deux accusés moteur jetés**, pas un)* | 2026-08-20 | 2026-08-22 |
| [TRK-035](#trk-035) | *plateforme* | **41 709 alertes et ≥ 89 lignes d'erreur supprimées hors application, sans aucune trace** — et **13 250 lignes de plus qu'aucun `DELETE` n'a comptées** | 🟠 **TÉMOIN EN LIGNE · 1ʳᵉ JOURNÉE PLEINE SANS DISPARITION** *(🆕 **23/08** : `temoin_arme` rend ses **4 lignes**, toutes actives ; **0 constat** ; `n_tup_del` **inchangé à 3 785** sur 24 h ; écart `ins − del − live` **inchangé à 13 250** (3ᵉ point) ; arithmétique **1 + 12 − 0 = 13**, elle se referme exactement. `errorDeleted = 0` pour le **6ᵉ jour**. ⚠️ **un instrument neuf qui ne voit rien le 1ᵉʳ jour n'a pas encore été exercé** — l'effaceur a frappé les 19, 20 et 21/08 puis rien les 22 et 23. **La sonde `41c22081` est DÉPLOYÉE** (PR #93→#99, 22/08 04:54, marqueur `recensement-suppressions.service.js` présent) ; 1ᵉʳ passage à **23/08 03:15**. 🔴 **La moitié restante est entière** : un seul rôle `tracky` porte toujours `DELETE` ET `TRUNCATE`)* · ancien statut : *(🎯 **22/08 — L'ATTRIBUTION EST DÉMONTRÉE** : le cron de rétention consigne lui-même `errorDeleted: 0` **cinq jours de suite** (17→21/08) alors qu'il supprime 170 000 `wire_logs` par nuit, et il n'existe **qu'un seul** `errorLog.deleteMany` dans la base servie — **les 73 suppressions de la nuit viennent de l'extérieur de l'application**. L'écart `ins − del − live` reste figé à **13 250** : prescription satisfaite, **aucun nouveau `TRUNCATE`** — *les deux natures d'effacement ont chacune leur instrument, et chacun est aveugle à l'autre*. 🔴 **Et l'auteur restera innommable** : `log_statement=none`, `log_connections=off`, `logging_collector=off`, et **un seul rôle** porteur de `DELETE` ET `TRUNCATE`. ⚠️ **la sonde `41c22081` ne suffit pas** — elle voit l'effet, jamais l'auteur : y ajouter un **déclencheur au niveau instruction** sur `DELETE` **et** `TRUNCATE`. ⚠️ rétention réelle mesurée à **90 j**, pas 30)* · *(🆕 **21/08 — la vérification prescrite est rendue, et elle est NÉGATIVE dans le bon sens** : `alerts.n_tup_del` inchangé à **41 824**, `min("createdAt")` immobile au 20/08 05:47:16 — **la suppression n'a pas rejoué en 14 h**. 🔴 **Mais un second compte ne se referme pas** : `error_logs` porte **16 970** insertions, **3 712** suppressions, **8** lignes vivantes — **13 250 manquantes**. `TRUNCATE` ne touche pas `n_tup_del`. **Deux contrôles rendent le chiffre exploitable** : `stats_reset` est **NULL**, et la même arithmétique se referme **exactement** sur `alerts` (51 881 − 41 824 = 10 057 = live). 🔑 **Ce que `n_tup_del` mesure, ce ne sont pas les disparitions : ce sont les `DELETE`** — `pg_stat_user_tables` ne peut donc PAS servir de garde-fou. ✅ La sonde, elle, aurait vu celui-ci : elle relève `count(*)` et `min("createdAt")`. **Nouvelle vérification : `n_tup_ins − n_tup_del − n_live_tup` ne doit jamais croître ; 13 250 aujourd'hui, 1er point)* · ancien statut : *(commit `41c22081` du 20/08 : recensement quotidien à 03:15, rangé HORS des tables surveillées. La règle n'est pas « des lignes ont-elles disparu » mais « la disparition est-elle EXPLIQUÉE » — deux signaux, le nombre ET la borne basse. 🔴 **le défaut a REJOUÉ le jour même** : `error_logs` 14 → 4 et borne +20 h à 14:50, pendant que la purge déclarait `errorDeleted: 0`. **La sonde aurait crié.** ⚠️ elle n'empêche RIEN — aucun code n'arrête un `DELETE` en base)* · **GRAVITÉ 1 (consigne)** *(nouvelle ; ni la rétention — `errorDeleted: 0` —, ni un chemin applicatif — une seule `deleteMany`, aucune sur `alerts` —, ni la migration. Seul `pg_stat_user_tables` en témoigne. ⚠️ **rend le taux de [TRK-023](#trk-023) illisible** : 81,6 % → 5,5 % par effacement du dénominateur)* | 2026-08-20 | 2026-08-22 |
| [TRK-033](#trk-033) | `frontend` | **`/admin/vps` plante sur `chargeDeFond`** — champ déclaré obligatoire par le type TypeScript, **absent du JSON réel**, déréférencé sans garde | 🟢 **CORRIGÉ ET DÉPLOYÉ** *(garde + type facultatif déjà en ligne le 20/08 04:56 ; 🔴 **mais la cause écrite dans le code était FAUSSE** — « l'API ne le construit pas encore » : le champ était PRÉSENT à chaque passage du 11/08 au 17/08 et l'agent a cessé de l'écrire le 18/08. Consigne ajoutée à l'agent + commentaires rectifiés, `4849bb02`. 🟢 garde définitive : `strictTemplates` fait **ÉCHOUER LE BUILD** — prouvé, TS2532, code 1)* *(nouvelle ; 19/08 10:32:05, iPhone Safari. Vérifié dans le dépôt, sur `/opt/tracky-vps-audit` et tel que l'API le voit. **Toute la carte « Prévisions » meurt**, tableau du disque compris)* | 2026-08-20 | 2026-08-20 |
| [TRK-034](#trk-034) | `TRIP_AUTOMATION` | **La fenêtre de recalcul (1 500 h = 62,5 j) dépasse la rétention des positions (60 j)** — bande de 2,5 j sans donnée possible | 🟢 **CORRIGÉ ET DÉPLOYÉ le 2026-08-22 04:54 · DÉFAUT PLUS RÉALISÉ** *(PR #93→#99, marqueurs `lookbackHours`/`fenetreUtile` ×9 dans le `dist/` servi. 🆕 **23/08 — le réglage lui-même a changé** : `lookbackHours` **1 500 → 26** (la valeur par défaut), `recomputeTrips` = `true`, `narrateEnabled` = `false`. Recalculs par passage **848 → 4-45**. **La dérive décrite par la fiche n'est plus réalisée.** ⚠️ elle reste POSSIBLE : le plafond relevé à **2 160 h (90 j)** dépasse toujours la rétention des positions (**60 j**) — c'est une **décision assumée du correctif**, à ne pas rouvrir comme un défaut. ⚠️ **ce n'est PAS le correctif qui a ramené le réglage à 26 h** : il relève le plafond, il n'ampute pas la fenêtre)* · ancien statut : *(🆕 **22/08 — mesuré dans les réglages de production eux-mêmes** : `lookbackHours = 1500` (**62,5 j**) contre **60 j** de rétention des positions, `recomputeTrips = true`, cadence **horaire**. Conséquence visible : **3 373 trajets `recompute` en 5 jours**, dont **848 en une seule heure** le 19/08 04:00, et un passage horaire qui a duré **14 min 56 s**. Commit `152883ec` sur `fix/trk-034-fenetre-recalcul`, **poussé sur `origin`, sans PR ni fusion**)* · *(commit `638d16aa` du 20/08. Le BRUIT était déjà traité en amont ; ce qui restait était le TRAVAIL — un trajet au-delà de l'horizon était **analysé**, l'analyse relisait ses positions, n'en trouvait aucune et persistait une analyse VIDE, sur un budget **saturé** (3 712 trajets en 50 min, 6 véhicules laissés de côté). ⚠️ **la dérive 1 500 h vs plafond 720 h n'est pas corrigée en douce mais RENDUE VISIBLE** — le bon plafond est une décision)* *(nouvelle ; 20/08 00:32:01 sur FZ-862-VY, fenêtre 19/06 → 21/06. Bruit **structurel et permanent** : se rejouera à chaque passage. Le message, lui, est exact)* | 2026-08-20 | 2026-08-22 |
| [TRK-031](#trk-031) | *zones mortes* | `recordRecovery` referme **TOUS** les épisodes ouverts d'un véhicule à la date du jour — un épisode du 01/08 déclaré long de **16,9 j** | 🟢 **ASSAINISSEMENT VÉRIFIÉ ✅ · CODE DÉPLOYÉ le 2026-08-22 04:54** *(PR #93→#99, marqueur `recordRecovery` présent dans le `dist/` servi — **la borne de code n'est plus « non poussée »**. 🆕 **23/08** : **44 épisodes, 42 refermés, 2 ouverts, 3 de plus de 5 jours** — les trois de FS-253-HR, tous réels. **0 durée fabriquée.**)* · ancien statut : *(🆕 **21/08 — vérification prescrite RENDUE et POSITIVE** : **35 épisodes clos, 3 de plus de 5 jours, et les 3 sont RÉELS** — FS-253-HR, **0 position** pendant chacun des intervalles (7,10 j · 6,94 j · 5,82 j). Prescrit « 13/20 → 0/34 » ; mesuré **0 fabriquée sur 35**. Médianes de zone : Toulouse **0,78 j**, Benidorm **0,59 j** — les 16,03 j et 10,47 j empoisonnés ont **disparu**. ⚠️ la borne de code reste NON POUSSÉE, mais avec **2 épisodes ouverts** seulement la surface de récidive est réduite, pas fermée)* · ancien statut : *(assainissement **exécuté en prod le 20/08** : 14 épisodes fermés à leur vraie date + **13 dates fabriquées corrigées**. **Vérification prescrite : 13/20 → 0/34.** Médianes de zone 16,03 → **3,94 j** et 10,47 → **4,22 j**. ⚠️ le script initial ne traitait que les épisodes OUVERTS — insuffisant, ce sont les CLOS qui faussaient la médiane. ⚠️ la borne de code reste NON POUSSÉE : le défaut peut refabriquer au prochain retour de fix)* · ancien statut : *(commit `b28e389e` du 20/08. 🔴 **le défaut a rejoué une 3ᵉ fois pendant la correction** — FZ-862-VY, 4 épisodes à 08:16:31, 3 fabriquées réfutées par 539/386/178 positions ; **13 clos faux sur 19**, et une 2ᵉ zone empoisonnée à **10,47 j** pour 2,83 j réels. La borne retenue N'EST PAS la fenêtre fixe prévue : elle porte sur l'existence d'un épisode PLUS RÉCENT, pas sur l'ancienneté — sinon une absence réelle de 5 semaines resterait ouverte à vie. + script d'assainissement en DRY-RUN : **14 réparables**, durées réelles 0,00-0,80 j)* *(🔴 **le 19/08 13:48:56, FS-253-HR revient et referme 9 épisodes à la même seconde** : durées de 6,94 à **35,18 j**, dont **8 fabriquées** — réfutées par **5 027 positions**. **La médiane de la zone `79a8d0f2` affiche 16,03 j pour une absence réelle de 6,94 j.** Dette : **20 épisodes ouverts sur 9 véhicules**, dont **9 sur KSR370**)* | 2026-08-19 | 2026-08-20 |
| [TRK-030](#trk-030) | `gps-integrity` | Le boîtier **neuf** est accusé de panne d'antenne **51 s avant son premier fix** — la branche « jamais localisé » n'a aucune borne de durée | 🟢 **CORRIGÉ ET DÉPLOYÉ le 23/08** (PR #114 — borne createdAt, même tolérance que le régime établi ; vérif au prochain boîtier posé) *(nouvelle ; login 01:09:36 → alerte 01:10:15 → fix 01:11:06 ; se rejouera **à chaque pose**, et le commentaire du code décrit une garde qui n'existe pas)* | 2026-08-19 | 2026-08-19 |
| [TRK-029](#trk-029) | `schedule-cron` | Le report d'une coupe applique un **backoff exponentiel à une échéance connue** — et le message dit « impossible » pour une action qui a abouti | 🟢 **CORRIGÉ ET DÉPLOYÉ le 23/08** (PR #115 — réessai à l'échéance connue, rédaction « différée, réessai à HH:MM », clôture des alertes à l'aboutissement) *(**test daté nº 5 : aucun second cas** — 21 coupes normales le 18/08 à 20:00. La ligne de base des 25 min reste unique)* | 2026-08-18 | 2026-08-19 |
| [TRK-028](#trk-028) | `gps-integrity` | La fiche véhicule promettait « le véhicule réapparaît en sortant » **sans jamais dire quand** | 🟠 DÉPLOYÉ ET EXERCÉ · ⚠️ **DONNE UN CHIFFRE FAUX** *(le raccroc s'exécute — 2 → **14** épisodes refermés. Mais le 20/08, l'écran créé par cette fiche pour répondre « quand revient-il ? » annonce une médiane de **16,03 j** sur le parking `79a8d0f2`, pour une absence réelle de **6,94 j** : 8 des 9 durées de l'échantillon sont fabriquées par [TRK-031](#trk-031))* *(🟢 **21/08 : le chiffre est REDEVENU JUSTE** — épisodes refermés 14 → **35**, médiane de la zone parking **0,78 j**, 0 durée fabriquée sur 35. L'écran dit enfin la vérité qu'il promettait)* | 2026-08-17 | 2026-08-22 |
| [TRK-027](#trk-027) | `gps-integrity` | **Contrepartie assumée de la règle du parking** : une antenne morte qui se tait au même endroit est silenciée dès la 2ᵉ fois | 🔵 TERRAIN · **surveillance manuelle** *(🟢 **FS-253-HR est revenu le 19/08 à 13:48:56, après 6,94 j — sous le seuil des 7 jours.** Le contrôle terrain demandé depuis le 03/08 n'a plus d'objet sur ce véhicule : le boîtier fonctionne, c'est bien le parking qui masquait le ciel. Il a reperdu son fix à 15:05 le même jour. Le garde-fou à écrire reste le CONTACT, bloqué par le même prérequis. **21/08 : 2 épisodes ouverts seulement** — FS-253-HR 1,57 j, FZ-862-VY 0,79 j, **tous deux sous le seuil de 7 jours** : aucune surveillance manuelle due)* | 2026-08-17 | 2026-08-22 |
| [TRK-026](#trk-026) | `sms-heartbeat` | La sonde chargée d'annoncer la panne du canal de secours **ne pouvait pas rendre « en panne »** | 🟠 CORRIGÉ, EN LIGNE, **NON EXERCÉ** *(cron hebdomadaire ; premier verdict réel **lundi 24/08**. `INDETERMINE` sera le résultat ATTENDU, pas un échec)* | 2026-08-17 | 2026-08-19 |
| [TRK-025](#trk-025) | `sms-allowlist` | **49 suppressions de masse retenues par la passerelle, 0 remontée** — ⚠️ **et désormais INEXERÇABLE** : après la rotation, l'appelant ne peut plus produire de blocage, cf. [TRK-041](#trk-041) — le champ lu vient de la réponse au sync que l'API émet elle-même, où il vaut toujours 0 | 🔴 NON CORRIGÉ · **GRAVITÉ 1** *(**non exercé le 19/08** : blocages inchangés à 49, donc aucune occasion nouvelle de prouver le silence. Ni confirmé ni infirmé ce jour)* | 2026-08-17 | 2026-08-22 |
| [TRK-023](#trk-023) | *alertes* | **42 240 alertes sur 51 735 (81,6 %) partent sans message** — dont **41 709 `CRITICAL` « Alimentation coupée »** et **3 `SOS`** | 🟢 **CORRIGÉ — EXERCÉ ET VÉRIFIÉ le 22/08** *(**0 alerte sans message depuis le 19/08 01:56**, soit 3 jours pleins et **4 types** (`POWER_CUT`, `LOW_BATTERY`, `OVERSPEED`, `GPS_LOST`) ; le `POWER_CUT` du 21/08 12:36 porte un message complet — batterie, seuil, état du véhicule. Les 556 lignes muettes restantes sont **de l'historique**, dont les 24 de la salve du 19/08. ⚠️ **réserve maintenue** : le taux global reste illisible, son dénominateur ayant été effacé — cf. [TRK-035](#trk-035))* · ancien statut : *(⚠️ **le taux affiché le 20/08 est 556 / 10 055 = 5,5 % — NE PAS LIRE COMME UN PROGRÈS** : les 41 709 `POWER_CUT` du dénominateur ont été **effacées à la main**, cf. [TRK-035](#trk-035). Le correctif existe — `messageCoupure` pose enfin un message sur `POWER_CUT` — mais **aucune `POWER_CUT` n'a été créée depuis son déploiement le 19/08 01:56** : il n'est pas vérifié — **21/08 : toujours 0 `POWER_CUT` créée**, taux **556 / 10 057 = 5,5 %**, inchangé et toujours illisible)* | 2026-08-13 | 2026-08-22 |
| [TRK-019](#trk-019) | *livraison* | Un déploiement depuis une branche forkée **efface des correctifs vérifiés**, sans aucun signal | 🟢 CORRIGÉ *(**8ᵉ image** du 19/08 17:10, servie depuis `main` @ `f71ddc3` — **4ᵉ image consécutive conforme**. ⚠️ **réserve neuve du 20/08 : le tag `latest` détruit l'historique des déploiements.** `docker images` n'en montre qu'une alors que 3 vagues de migrations (01:56, 12:30, 17:12) en prouvent au moins trois le 19/08. Les migrations sont la seule horloge — et elles ne datent que les déploiements qui touchent le schéma)* | 2026-08-12 | 2026-08-22 |
| [TRK-021](#trk-021) | *commandes* | **19 templates sur 23 sont déclarés SMS-only et partent en TCP** — `availableVia` n'est lu nulle part | 🔴 NON CORRIGÉ · **GRAVITÉ 1** *(test daté RÉPONDU **non** pour la 4ᵉ fois : aucun nouvel essai. 3 `shock_on` + 3 `sensitivity` `FAILED` sur 7 j — la baisse depuis 4+4 est la **fenêtre glissante**, pas une amélioration. Gravité 1 maintenue. **21/08 : test daté non déclenché pour la 5ᵉ fois** — 3 + 3 `FAILED` sur 7 j, aucun essai neuf)* | 2026-08-13 | 2026-08-22 |
| [TRK-022](#trk-022) | *alertes* | Aucune déduplication des alarmes Coban : **1317 survitesses en un jour**, et **41 479 `POWER_CUT` en 15 jours** | 🟠 CORRECTIF DÉPLOYÉ, **NON EXERCÉ** *(🟢 **déduplication livrée le 19/08** : `DEDUP_ALARME_MS` = **6 h**, sur TOUS les types d'alarme — une alerte non acquittée du même type et du même véhicule bloque les suivantes. ⚠️ **aucune rafale depuis** : plus une seule trame `ac alarm` après le 19/08 02:26:23, donc rien à dédupliquer et **rien de prouvé**. **21/08 : 2 alertes en 24 h (1 OVERSPEED, 1 GPS_LOST), toutes deux AVEC message ; aucune rafale, 7ᵉ jour** — toujours rien à dédupliquer, donc toujours rien de prouvé)* | 2026-08-13 | 2026-08-22 |
| [TRK-024](#trk-024) | *trackers* | Le statut `OFFLINE` **survit aux trames** : des boîtiers marqués hors ligne alors qu'ils émettaient il y a < 5 min | 🔴 NON CORRIGÉ *(**7ᵉ point** sur la définition écrite (5 min / 15 min) : **0 / 2**, identique au 6ᵉ. Même sens depuis le 15/08)* | 2026-08-14 | 2026-08-22 |
| [TRK-020](#trk-020) | *outillage* | Deux colonnes d'acquittement : la collecte lit celle qui **ne vient pas du boîtier** | 🟠 CORRECTIF PROPOSÉ *(`ackedAt` = 0 sur **4513**, `acknowledgedAt` = 30, inchangé)* | 2026-08-12 | 2026-08-22 |
| [TRK-018](#trk-018) | *coupe-circuit* | Repli SMS : commandes moteur `SENT`, **0 confirmée**, aucun accusé de remise jamais écrit | 🔴 NON CORRIGÉ *(test daté **passé 9 fois** : 242 → 254 → 257 → 261 → 270 → 274 → **289** (**11ᵉ fois** le 22/08 : 289 → **296**) ; passerelle **349** `queued`, dernier empilé le 21/08 20:00. 🆕 **le 20/08, la NATURE du défaut change** : la preuve de remise n'est pas absente, elle est **jetée** — cf. [TRK-036](#trk-036). Le boîtier de GS-014-NY a répondu « Resume engine Succeed » par SMS le 19/08 08:28:58 ; Tracky l'a écrit dans `sms_logs` et laissé la commande en `SENT`)* | 2026-08-11 | 2026-08-22 |
| [TRK-017](#trk-017) | `sms-allowlist` | Un appelant hors VPS efface 25 numéros à chaque h:25 avec la clé de PROD — **garde posée, clé NON rotationnée** | 🟢 **CLÉ ROTATIONNÉE le 2026-08-20 à 13:34 UTC**, après 10 jours *(préfixe `vtx_48fe` → **`vtx_d4f3`**, `updatedAt` figé au 05/06 → 20/08. Preuves : clé du conteneur → **HTTP 200**, ancien préfixe → **HTTP 401**, `/api/health` 200, **0 copie** de la clé hors `.env.prod`. 🟢 **CHAÎNE APPLICATIVE PROUVÉE le 21/08** : réconciliation `outcome = ok` à **04:25:00**, appels normaux 234 → **261**. ⚠️ **mais la rotation ne peut PAS être créditée du silence de l'appelant** : blocages **49 (+0)**, le dernier le **17/08 19:24:59** — il s'était tu **3 jours AVANT** la rotation. **102,0 h de silence au 22/08, le plus long de la série, 9ᵉ silence lu comme un silence** ; l'effet de la rotation reste **non testé** tant qu'il ne revient pas. 🆕 **Et il ne pourra plus l'être** : la rotation a supprimé le seul témoin — une clé révoquée n'écrit aucune ligne d'audit, cf. [TRK-041](#trk-041). ⚠️ 3 pièges payés : `docker exec -i` avale le script via `ssh bash -s` · `</dev/null` APRÈS un heredoc l'annule · compose exige `--env-file .env.prod`)* · ancien statut : *(clé `vtx_48fe` inchangée — `tenants.updatedAt` au 05/06 — **10ᵉ jour**. Blocages **49 (+0)** depuis le 17/08 19:24, appels normaux 208 → **234** : **54 h de silence** de l'appelant, le plus long de la série, **7ᵉ silence lu comme un silence**. Entrées **44**, aucune suppression depuis **231 h**. ⚠️ 9ᵉ jour : blocages **49 (+0)**, appels normaux 178 → **208** : 30 h de silence, 6ᵉ silence lu comme un silence. Entrées 42 → 44, les 2 neuves datées de la seconde du rattachement du boîtier neuf. ⚠️ **42 → 49 blocages**, appels normaux 159 → **178** ; 5ᵉ silence lu comme un silence, PAS comme une révocation. Entrées intactes depuis **181,4 h**. ⚠️ **35 → 40 blocages** : l'appelant EST REVENU après 32 h de silence, pour la **3ᵉ fois** — la leçon devient une règle. Sa remontée au centre d'alerte est morte, cf. [TRK-025](#trk-025))* | 2026-08-09 | 2026-08-22 |
| [TRK-016](#trk-016) | *trajets* | Recalage cartographique en échec sur 9 trajets sur 10 | 🔴 NON CORRIGÉ *(**91,9 %** le 22/08 (204/222). Série ouvrée : 90,2 · 88,7 · 91,3 · 87,0 · 89,3 · 91,1 · **91,9** — le creux à 87,0 ne s'est pas confirmé. ✅ **Définition contrôlée le 22/08** : sur les trajets *démarrés* dans les 24 h (198), le taux est **92,4 %** — le recalcul de masse de [TRK-034](#trk-034) gonfle le dénominateur mais **ne fausse pas l'instrument**)* | 2026-08-09 | 2026-08-22 |
| [TRK-015](#trk-015) | *ingestion* | Positions réelles écartées par le garde-fou anti-téléportation | 🔴 NON CORRIGÉ *(**test daté RÉPONDU** : rejets 5497 → **2465**, le 15/08 était UNE JOURNÉE. La baisse d'insertions s'explique par le **week-end** (73 trajets dimanche vs 195 vendredi), pas par le garde-fou. 317 rejets = rejeu de tampon de HD-779-MA)* | 2026-08-08 | 2026-08-22 |
| [TRK-014](#trk-014) | *commandes* | Aucun accusé de réception boîtier — silence PROUVÉ, et **sa cause est trouvée** (mauvais format de trame) | 🔴 NON CORRIGÉ *(**6ᵉ point** : **74/75** commandes du jour portent l'indice ; silences tracés 243 → **651**. `ackedAt` = **0 sur 4 823** (21/08 : **73/74** commandes portent l'indice). 🆕 **92 trames `IN|ack` sont pourtant arrivées en 24 h — toutes pour les commandes MOTEUR** : le canal d'accusé fonctionne, seule la famille `fix_*` n'en reçoit jamais. 🆕 **devient un aggravant de [TRK-032](#trk-032)** : c'est parce qu'aucune commande n'est acquittée que « le moteur est coupé par nous » repose sur du vide)* | 2026-08-07 | 2026-08-22 |
| [TRK-012](#trk-012) | *commandes* | Cadence d'arrêt (300 s) jamais appliquée — **trame au format SMS émise sur la socket TCP** | 🟠 **CORRIGÉ ET DÉPLOYÉ le 23/08** (PR #110), PREUVE TERRAIN ATTENDUE — juger à l'INTERVALLE entre trames, puis le ratio commandes/boîtier doit décrocher de 2,00 *(**cause racine trouvée le 11/08** ; correctif écrit, en attente d'accord depuis **9 jours** ; 289 échecs « intervalle observé 20 s » sur 7 j. ⚠️ **preuve neuve du 19/08** : le boîtier posé cette nuit reçoit `fix030s***n123456` sur la socket TCP et ne répond pas — **2 `ACK timeout` en 6 minutes**. Chaque boîtier posé hérite du défaut à la minute où il se connecte. **11ᵉ jour d'attente d'accord le 21/08** : 277 échecs « intervalle observé 20 s » sur 7 j, et **71,3 échecs/jour** — le métronome n'a pas varié d'un dixième depuis dix jours)* | 2026-08-05 | **2026-08-24 · 🎯 PREUVE TERRAIN ACQUISE, ET ELLE A DEUX FACES.** ✅ **Le transport est réparé** — les trames sortantes portent `**,imei:…,C,05m;` et, pour la première fois en quatre mois, **le comportement des boîtiers change après réception** : 23 des 32 boîtiers ayant reçu une trame ont modifié leur cadence, contre 1 sur 6 parmi ceux qui n'en ont pas reçu. 🔴 **Mais la consigne n'est pas honorée, et l'écart va dans le mauvais sens** : au lieu des 300 s demandés, ces boîtiers émettent toutes les **4 à 6 s** — × 2,9 sur le débit de la flotte. **Le correctif est bon, son effet ne l'est pas** → fiche dédiée [TRK-045](#trk-045). ⚠️ **Le critère de succès écrit dans cette fiche — « le ratio commandes/boîtier doit décrocher de 2,00 » — ne doit PAS être utilisé** : il décroche aussi quand les boîtiers sont bâillonnés en FAILING, ce qui est exactement ce qui se produit. *Un critère de réussite qui est également satisfait par le pire échec ne mesure rien.* |
| [TRK-013](#trk-013) | *commandes* | Clôture par échéance : « sans effet » sans jamais comparer | 🔴 NON CORRIGÉ *(numérateur 19 → **22** (7·7·7·8·11·11·13·13·13·15·19·**22**) ; dénominateur 91 → **101**. Les deux montent pour le **2ᵉ jour** consécutif)* | 2026-08-06 | 2026-08-22 |
| [TRK-001](#trk-001) | `gps-integrity` | GPS perdu — boîtier vivant sans fix | 🔵 TERRAIN *(correctif de la fenêtre hebdomadaire **tient pour le 3ᵉ jour** : **1 seule ligne** en 24 h le 20/08 — FL-787-KV, 3 h sans fix — et **aucun rappel**. Elle est légitime : sa zone n'a été qualifiée `UNDERGROUND_PARKING` qu'à 21:55, 9 h plus tard. FS-253-HR **est revenu** à 6,94 j. **21/08 : 4ᵉ jour** — 1 seule ligne en 24 h (HD-686-QX, 2 h sans fix), aucun rappel)* | 2026-07-28 | 2026-08-22 |
| [TRK-002](#trk-002) | `frontend` | Rafraîchissement de session — API injoignable | 🟢 CORRIGÉ *(déployé — `d5e5fb1` est sur `main`, branche servie depuis le 16/08 16:03. ⚠️ **le marqueur binaire est RETIRÉ** : invalide sur bundle minifié, réfuté par contrôle. 5 verdicts « régression » de 12→16/08 rectifiés ; seul un contrôle COMPORTEMENTAL vaut désormais)* | 2026-07-29 | 2026-08-17 |
| [TRK-003](#trk-003) | `realtime-client` | Canal temps réel JAMAIS établi | 🟢 CORRIGÉ *(**vérifié en production le 2026-08-18** : 1ʳᵉ occurrence depuis le 31/07, écrite en **`ERROR`** et non `CRITICAL` — `downMs=45 000`, `flaps=0` : exactement le calibrage prévu. La variante `ERROR` fait partie de la signature)* | 2026-07-31 | 2026-08-18 |
| [TRK-004](#trk-004) | `http` | Budget IA mensuel atteint (503) | 🟢 CORRIGÉ | 2026-07-29 | 2026-07-29 |
| [TRK-005](#trk-005) | `fuel-station` | API prix carburants injoignable | 🟢 CORRIGÉ | 2026-07-28 | 2026-07-28 |
| [TRK-006](#trk-006) | `frontend` | NG02100 sur `/admin/subscriptions` | 🟢 CORRIGÉ | 2026-07-29 | 2026-07-30 |
| [TRK-007](#trk-007) | *commandes* | `fix_continuous` bloquée en SENT à vie | 🟢 CORRIGÉ *(→ produit TRK-013 · justification rectifiée le 07/08)* | 2026-08-03 | 2026-08-07 |
| [TRK-008](#trk-008) | *commandes* | Cible de cadence sous le minimum matériel | 🟢 CORRIGÉ *(diagnostic rectifié · réserve levée le 07/08)* | 2026-08-03 | 2026-08-07 |
| [TRK-009](#trk-009) | *trackers* | Boîtiers « hors ligne » jamais mis en service | 🟢 CORRIGÉ | 2026-08-03 | 2026-08-04 |
| [TRK-010](#trk-010) | *plateforme* | La rétention efface les erreurs non corrigées | 🟢 CORRIGÉ | 2026-08-03 | 2026-08-04 |
| [TRK-011](#trk-011) | `gps-integrity` | Zone bénigne = silence GPS **sans borne de durée** | 🟢 CORRIGÉ *(test daté vérifié sur un épisode neuf le 09/08)* | 2026-08-04 | 2026-08-09 |

---

## TRK-043

**Signature** — `trip-automation | (aucun message) | passage horaire annulé par la garde anti-double-run`
**Statut : 🔴 NON CORRIGÉ** · **gravité 3** · famille **angle mort** · 2026-08-23

### Ce que ça veut dire

L'automatisation des trajets est réglée sur `frequency = 'hourly'`, son cron est `0 45 * * * *` :
**24 passages par jour attendus**. Mesuré le 2026-08-23 sur les 24 h écoulées : **14 passages**.
Dix ticks n'ont rien fait, **sans écrire une ligne nulle part** — ni erreur, ni avertissement, ni
journal.

### Cause racine — la garde mesure depuis la fin, son intitulé parle du départ

`apps/api/src/trip-analysis/trip-automation.service.ts:217` :

```ts
// Horaire : garde anti double-run rapproché (< 50 min).
if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 50 * 60 * 1000) return;
```

`lastRunAt` est écrit **à la clôture** du passage (`:768`), pas à son départ. La garde compare donc
le tick à la **fin** du passage précédent, alors que son intitulé — « anti double-run rapproché » —
décrit un espacement entre **départs**.

**Conséquence arithmétique : tout passage de plus de 10 minutes emporte le tick suivant.**

### Vérification — 23 des 24 ticks du 22/08 expliqués exactement

| Fin du passage | Tick suivant | Écart | Attendu | Observé |
|---|---|---|---|---|
| 00:59:55 | 01:45 | 45,1 min | annulé | **absent** ✅ |
| 04:45:35 | 05:45 | 59,4 min | exécuté | **présent** ✅ |
| 06:59:48 | 07:45 | 45,2 min | annulé | **absent** ✅ |
| 09:36:31 | 09:45 | 8,5 min | annulé | **absent** ✅ |
| 11:36:30 | 11:45 | 8,5 min | annulé | **absent** ✅ |
| 14:18:29 | 14:45 | 26,5 min | annulé | **absent** ✅ |
| 16:19:51 | 16:45 | 25,2 min | annulé | **absent** ✅ |
| 18:07:02 | 18:45 | 38,0 min | annulé | **absent** ✅ |
| 20:02:08 | 20:45 | 42,9 min | annulé | **absent** ✅ |
| 22:59:55 | 23:45 | 45,1 min | annulé | **absent** ✅ |

Le seul tick non conforme — **12:45**, que la règle prévoyait exécuté — tombe **trois minutes** avant
la recréation du conteneur de 12:48 (PR #101). Un passage démarré à 12:45 et tué à 12:48 ne persiste
rien et ne met pas `lastRunAt` à jour, ce qui explique aussi que 13:45 ait bien tourné. *Fait
consigné, non démontré — c'est la seule pièce du raisonnement qui repose sur une reconstitution.*

### Le détail qui rend le défaut auto-aggravant

`RUN_BUDGET_MS` vaut **50 min** (`:68`) — exactement la valeur du seuil de la garde.

> 🔑 **Un passage qui consomme tout son budget garantit l'annulation du suivant.** Départ à `:45`,
> fin à `:35` de l'heure d'après, tick à `:45` → 10 minutes d'écart, annulé. *Le frein serre le plus
> fort exactement quand la charge est la plus forte* : c'est le jour où il y a du retard à rattraper
> que la plateforme divise sa cadence par deux.

La série de 7 jours dit la même chose sans qu'on ait à lire le code :

| Jour | Passages | Durée moyenne |
|---|---|---|
| 18/08 | **24 / 24** | **1,2 min** |
| 19/08 | 11 | 29,3 min |
| 20/08 | 14 | 21,1 min |
| 21/08 | 22 | 12,9 min |
| 22/08 | **14** | 19,2 min |

⚠️ Le 17/08 (14 passages, 1,1 min de moyenne) **ne suit pas cette lecture**.
`trip_automation_runs` est élaguée, donc une journée ancienne peut être tronquée. *Fait consigné,
non expliqué — il ne faut pas le faire rentrer de force dans le modèle.*

### Ce que ça coûte, et ce que ça ne coûte pas

**Ce n'est pas une perte de donnée.** La fenêtre balayée vaut **26 h** ; un écart de 2 h entre deux
passages est intégralement recouvert. Le coût réel est une **latence** : une analyse peut arriver
avec ~2 h de retard au lieu de ~1 h.

**Ce qui est grave, c'est le silence.** L'écran des tâches de fond et la sonde de
[TRK-042](#trk-042) jugent cette tâche sur sa cadence **déclarée**. Un écart de 42 % entre le déclaré
et l'exécuté ne produit **aucun signal** : le `return` est muet. *C'est le profil exact de
[TRK-008](#trk-008) — quelque chose qui ne marche qu'à moitié depuis des semaines, derrière un
compteur qui ne bouge pas.*

### Correctif proposé

1. **Mesurer la garde depuis le DÉPART du passage précédent**, pas depuis sa fin — c'est ce que son
   intitulé annonce déjà. Un champ `lastRunStartedAt`, ou `max("startedAt")` de
   `trip_automation_runs`, suffit. Avec un seuil de 50 min et un cron horaire, deux départs légitimes
   sont espacés de 60 min : la garde ne se déclenche plus jamais à tort.
2. **Ne pas se contenter de baisser le seuil.** Un seuil à 30 min laisserait passer les cas courts
   mais continuerait d'annuler après un passage de 45 min — c'est-à-dire dans le seul cas qui compte.
   *Le défaut est dans le point de mesure, pas dans sa valeur.*
3. ⚠️ **Ne pas supprimer la garde.** La ré-entrance est déjà bloquée en mémoire par `this.running` ;
   ce que la garde protège **en plus**, c'est le redémarrage — un conteneur recréé perd
   `this.running`. Une garde fondée sur le **départ** protège ce cas aussi bien.
4. **Rendre l'annulation visible.** Compter les ticks annulés et les afficher à côté de la cadence
   déclarée. *Un `return` silencieux dans un traitement de fond est un angle mort par construction.*

### Vérification

Compter les lignes de `trip_automation_runs` sur 24 h : **24** (moins un par redéploiement), quelles
que soient les durées. **14 le 2026-08-23.**

**Test daté — 2026-08-24.** Sans correctif, le compte doit rester loin de 24 **et varier à l'inverse
de la durée moyenne des passages**. Si le compte remonte à 24 alors que les durées restent longues,
c'est le modèle qui est faux, pas le défaut qui est corrigé.

---

> ⚠️ **Les en-têtes de fiche ci-dessous portent le statut du jour où la fiche a été écrite.**
> Neuf d'entre elles ont été corrigées le 2026-08-04 sans que leur en-tête soit repris — remis à
> jour le 2026-08-06. **En cas de doute, l'index ci-dessus fait foi.**

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

### Mise à jour du 2026-08-04
`FZ-862-VY` est **toujours sans fix : 7,4 h** (contre ~3 h la veille). L'épisode dure, il n'est
pas clos.

⚠️ **Et il ne réalertera plus.** Sa zone morte (`879699a3…`, parking souterrain, Toulouse) a été
**confirmée bénigne le 03/08 à 19:36**, une minute après l'alerte. Le détecteur cesse donc
d'alerter pour ce véhicule à cet endroit, **quelle que soit la durée de la perte** — voir
[TRK-011](#trk-011). Le suivi de cette antenne repose désormais sur les rapports d'audit, plus
sur le centre d'alerte.

### Mise à jour du 2026-08-05 — deux épisodes toujours ouverts, et désormais visibles

| IMEI | Plaque | Sans position depuis | Boîtier |
|---|---|---|---|
| `864035054757027` | **FS-253-HR** | **36,1 h** (dernière position 03/08 13:02) | vivant, trames à la minute |
| `864035054756102` | **FZ-862-VY** | **31,6 h** (dernière position 03/08 17:34) | vivant, trames à la minute |

Ces deux véhicules ont **enfin alerté** — le plafond de silence de [TRK-011](#trk-011) a produit
ses deux premières lignes (à 24 h et 26 h). Ils n'étaient plus détectables autrement.

`FW-298-WV` (`864035054756714`) a perdu son fix 2 h le 04/08 et **est reparti** : il n'apparaît
plus dans `gps_sans_fix`. Rien à faire — et c'est la preuve que l'alerte ordinaire fonctionne
toujours à côté du nouveau plafond.

### Mise à jour du 2026-08-06 — troisième nuit, les deux épisodes s'allongent

| IMEI | Plaque | Sans position depuis | La veille |
|---|---|---|---|
| `864035054757027` | **FS-253-HR** | **60,1 h** | 36,1 h |
| `864035054756102` | **FZ-862-VY** | **55,6 h** | 31,6 h |

Mêmes épisodes : `lastPositionAt` n'a pas bougé (03/08 13:02 et 03/08 17:34). Les deux boîtiers
émettent toujours des trames à la minute — c'est l'antenne, pas le réseau.

Chacun a produit **une seconde ligne**, 24 h après la première : c'est le rappel quotidien de la
fenêtre de dédup (voir la rectification en tête de [TRK-011](#trk-011)), pas un nouvel épisode.
Tant que l'antenne n'est pas vérifiée, comptez **une ligne par véhicule et par jour**.

### Mise à jour du 2026-08-07 — quatrième nuit

| IMEI | Plaque | Sans position depuis | La veille |
|---|---|---|---|
| `864035054757027` | **FS-253-HR** | **84,1 h** | 60,1 h |
| `864035054756102` | **FZ-862-VY** | **79,6 h** | 55,6 h |

Mêmes épisodes, `lastPositionAt` toujours figé au 03/08 (13:02 et 17:34). Une ligne par véhicule
et par jour, comme prévu par la fenêtre de dédup. Rien de nouveau à diagnostiquer : ce qui manque
est une intervention.

### ✅ Mise à jour du 2026-08-08 — les deux épisodes sont CLOS

| IMEI | Plaque | État au 08/08 01:13 UTC |
|---|---|---|
| `864035054757027` | **FS-253-HR** | **position fraîche** (01:13:40) — l'épisode du 03/08 13:02 est terminé |
| `864035054756102` | **FZ-862-VY** | position reprise le 07/08 09:07 — puis **reperdue** : nouvel épisode, **16,1 h** |

C'est ce qui explique le **zéro absolu** de `error_logs` sur 24 h : il n'y avait plus de rappel
quotidien à produire. FS-253-HR a même connu un **nouvel** épisode court le 07/08 à 13:50, déjà
résolu — silencieux à raison (zone bénigne, sous le plafond).

Le nouvel épisode de FZ-862-VY est également silencieux **à raison** : 16,1 h < 24 h.
Il franchira le plafond vers **08/08 09:07 UTC**. Une alerte est attendue dans la journée —
**si elle ne vient pas, c'est une régression de [TRK-011](#trk-011)**, et ce test tombe bien : il
vérifie le plafond sur un épisode neuf plutôt que sur les deux mêmes véhicules depuis cinq jours.

⚠️ **Un épisode clos ne vaut pas antenne réparée.** FZ-862-VY a repris une position puis l'a
reperdue en quelques minutes ; FS-253-HR a rouvert un épisode le lendemain. Le comportement reste
celui d'une antenne défaillante par intermittence. Le contrôle terrain reste à faire.

### Mise à jour du 2026-08-09 — l'épisode de FZ-862-VY dure, et il alerte

| IMEI | Plaque | Sans position depuis | Épisode ouvert le |
|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **40,1 h** | 07/08 09:07 |

FS-253-HR n'apparaît plus dans `gps_sans_fix` : son épisode du 07/08 13:50 s'est refermé. Un seul
boîtier vivant sans fix ce jour, contre deux les jours précédents.

L'épisode de FZ-862-VY a franchi le plafond de 24 h le 08/08 à 09:10 et produit sa ligne — voir
[TRK-011](#trk-011), dont c'est la première vérification sur un épisode neuf. Rappel quotidien
attendu tant que la perte dure.

### Mise à jour du 2026-08-10 — l'épisode entre dans sa quatrième journée

| IMEI | Plaque | Sans position depuis | Épisode ouvert le |
|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **64,1 h** | 07/08 09:07 |

Seul boîtier vivant sans fix, deuxième jour de suite. Le rappel quotidien attendu a bien été produit
le 09/08 à 09:15 (« sans position depuis 2 j ») : le plafond de [TRK-011](#trk-011) tient sur un
troisième rappel consécutif. Prochain rappel attendu vers le **10/08 09:15**.

⚠️ Rien de nouveau à diagnostiquer, et c'est le problème : cette antenne est signalée depuis le
03/08 et n'a toujours pas été touchée. Ce que la plateforme sait faire, elle le fait ; ce qui manque
est une intervention.

### 2026-08-12 — le test daté PASSE, puis l'espacement est retiré de la production

**Le test posé pour aujourd'hui est concluant**, et sur deux canaux indépendants :

| Canal | 2026-08-11 | Attendu | |
|---|---|---|---|
| Alerte **flotte** (cadence quotidienne, non touchée par le correctif) | `GPS_LOST` à **09:25:15**, « sans position depuis 4 j » | présente | ✅ |
| Ligne **admin** `error_logs` (cadence espacée, épisode > 4 j) | **aucune** | absente | ✅ |

Un détecteur simplement éteint aurait fait taire les deux. *Un test qui prédit à la fois un
silence et un bruit conclut ; un test qui ne prédit qu'un silence, non.*

⚠️ **Et l'espacement a été retiré treize heures plus tard** : `reminderIntervalMs` est absent du
build servi (témoin « ANORMALEMENT LONG » présent dans le même fichier). Le rappel quotidien sans
fin revient. Voir [TRK-019](#trk-019).

🗓️ **Nouveau test daté, ~09:25 UTC le 12/08 :** une ligne `error_logs` doit **réapparaître** pour
FZ-862-VY, en même temps que son alerte flotte. *Condition d'échec : si elle n'apparaît pas, la
lecture de la régression est fausse et l'analyse est à reprendre.*

### Mise à jour du 2026-08-12 — deux véhicules NEUFS entrent dans la famille

| IMEI | Plaque | Dernière position | Zone morte | État ce matin |
|---|---|---|---|---|
| `864035054757902` | **AL-927-QM** | 11/08 12:44:46 | 1ʳᵉ occurrence | reparti |
| `864035054756698` | **GS-928-NX** | 11/08 12:43:52 | 1ʳᵉ occurrence | reparti |

Les deux ont alerté à 14:45:15 et perdu leur fix **à 54 secondes d'intervalle**, même flotte, zones
mortes distinctes. ⚠️ **Fait noté, pas interprété.** Deux pertes quasi simultanées peuvent être
deux véhicules au même endroit au même moment comme tout autre chose : une occurrence ne fait pas
un mécanisme. *À re-regarder si le couple se reproduit.*

Et les deux épisodes suivis continuent : **FZ-862-VY 116,5 h** (5ᵉ jour, ouvert le 07/08 09:07) et
**FS-253-HR 38,6 h** (ouvert le 10/08 15:03).

### 🗓️ 2026-08-13 — le test daté est SANS OBJET : son sujet a changé d'état

Le test posé pour le 12/08 attendait une ligne `error_logs` sur FZ-862-VY vers 09:25, et écrivait
sa condition d'échec : *« si elle n'apparaît pas, la lecture de la régression est fausse et
l'analyse est à reprendre. »*

**Aucune ligne `gps-integrity` n'est apparue** — ni le 12/08, ni le 13/08. **Et il ne faut pas
appliquer la condition d'échec**, parce que la prémisse du test est tombée :

| Véhicule | `lastPositionAt` | Ce que ça veut dire |
|---|---|---|
| **FZ-862-VY** | **12/08 08:50:11** | L'épisode du 07/08 09:07 — **cinq jours** — est **CLOS**. Un **nouvel** épisode s'est ouvert derrière : 16,3 h à la collecte. |
| **FS-253-HR** | **12/08 15:20:59** | Épisode du 10/08 15:03 clos lui aussi. Nouvel épisode : 9,8 h. |

À 09:25 le 12/08, FZ-862-VY avait une position vieille de **35 minutes**. Il n'y avait rien à
signaler. Le silence est le comportement voulu, et les deux épisodes en cours sont **sous le
plafond de 24 h** — silencieux à raison, comme un stationnement de nuit. L'alerte flotte confirme
d'ailleurs le même état : dernière `GPS_LOST` le **11/08 15:05**, aucune depuis.

> **La leçon.** Un test daté suppose que son sujet ne bouge pas. Celui-ci a été posé sur l'épisode
> le plus stable du tableau — ouvert depuis cinq jours, `lastPositionAt` figé depuis le 07/08 — et
> c'est précisément lui qui a changé. Lire son zéro comme un échec aurait accusé le bon coupable
> ([TRK-019](#trk-019) est bien réel) **pour la mauvaise raison**, et fait « reprendre l'analyse »
> d'une régression pourtant confirmée par ailleurs. *Avant de lire un zéro comme un échec, relire
> l'état que le test supposait — un test daté doit désormais porter sa condition de nullité autant
> que sa condition d'échec.*

🗓️ **Test réarmé — deux échéances le 13/08, et le volet décisif le 14/08 :**

1. L'épisode de **FZ-862-VY** franchit 24 h vers le **13/08 08:50 UTC** → une alerte flotte
   `GPS_LOST` **et** une ligne `error_logs` doivent apparaître dans les 5 min qui suivent. Le
   plafond de 24 h, lui, **est** dans le build servi (témoin « ANORMALEMENT LONG » trouvé dans
   `gps-integrity.service.js`).
2. **FS-253-HR** franchit 24 h vers le **13/08 15:20 UTC** — même attente.
3. **Le volet qui teste la régression est au 14/08** : l'espacement étant absent de la production,
   un **second** rappel doit tomber ~24 h après le premier. Avec le correctif restauré, la cadence
   passerait à l'hebdomadaire au 3ᵉ jour. *C'est ce volet-là, et lui seul, qui distingue les deux
   codes.*

**Condition de nullité (écrite exprès) :** avant de conclure d'une absence de ligne, **relire
`lastPositionAt`**. Si l'épisode s'est refermé entre-temps, le test est de nouveau sans objet —
pas en échec.

### Mise à jour du 2026-08-13 — cinquième cycle, et les deux véhicules reperdent leur fix le jour même

Les deux longs épisodes se sont refermés le 12/08 — puis **les deux se sont rouverts dans la
journée**, à 08:50 pour FZ-862-VY et à 15:20 pour FS-253-HR. C'est le quatrième et le cinquième
cycle du profil « antenne intermittente » décrit le 08/08, et pour la première fois **les deux
véhicules le font le même jour**.

⚠️ Un épisode clos ne vaut toujours pas antenne réparée — et cette fois la démonstration tient en
quelques heures au lieu de quelques jours.

### 🗓️ 2026-08-14 — volets 1 et 2 ✅ PASSÉS ; le volet décisif n'était pas échu à l'heure de la collecte

| Volet | Attendu | Constaté | |
|---|---|---|---|
| 1 — FZ-862-VY franchit 24 h le 13/08 ~08:50 | ligne `error_logs` + alerte flotte | ligne à **08:50:15** (+4 s), alerte flotte présente | ✅ |
| 2 — FS-253-HR franchit 24 h le 13/08 ~15:20 | idem | ligne à **15:25:15** (tick suivant), alerte flotte présente | ✅ |
| 3 — **2ᵉ rappel ~24 h après le premier** | 14/08 **08:50** et **15:20** | **échéance postérieure à la collecte (04:16)** | ⏳ |

**Le volet décisif ne pouvait pas être lu, et c'est structurel.** L'audit collecte vers
**04:10 UTC** ; le test échoit à **08:50 UTC**. *Un test daté doit échoir AVANT l'heure de collecte,
sinon il est reporté d'un jour par construction — cette contrainte appartient à l'énoncé du test,
pas à sa lecture.* Le lire à l'heure de l'audit aurait produit un faux « il ne s'est rien passé »,
symétrique exact du piège du 13/08.

> **Le volet 3 est cependant déjà répondu par la voie directe :** `reminderIntervalMs` est **absent
> du build servi** (témoin « ANORMALEMENT LONG » = 1 dans le même fichier). L'espacement n'est pas
> en production. Le volet comportemental devient une **confirmation**, plus un discriminant.

🗓️ **Réarmé au 15/08**, où les deux points seront lisibles ensemble : le 2ᵉ rappel (48 h) **et** le
3ᵉ (72 h). Sous le code régressé : **deux lignes de plus** par véhicule. Avec le correctif restauré :
cadence hebdomadaire dès le 3ᵉ jour, donc **une seule**.
**Condition de nullité :** relire `lastPositionAt` d'abord. Ces deux épisodes se sont déjà refermés
puis rouverts le 12/08 ; si l'un se referme à nouveau, son volet est **sans objet**, pas en échec.

### 🎯 2026-08-15 — le volet décisif est RÉSOLU, et l'énoncé du test visait le mauvais instant

**Condition de nullité vérifiée d'abord**, comme la fiche l'exige : les deux épisodes sont
**toujours ouverts** — `lastPositionAt` inchangé au 12/08 08:50:11 (FZ-862-VY, 64,3 h) et au
12/08 15:20:59 (FS-253-HR, 57,8 h). Le test a donc un objet.

Le discriminant réel n'est **pas** le 3ᵉ rappel. Relu dans le code plutôt que dans sa description
(`gps-integrity.service.ts`, `reminderIntervalMs`) :

```
age < 2 j        → DAY      (rappel quotidien)
2 j ≤ age < 14 j → 7 * DAY  (hebdomadaire)
age ≥ 14 j       → 30 * DAY (mensuel)
```

À **48 h**, `age` vaut 2,00 jours : la borne `age < 2 * DAY` est déjà franchie, l'intervalle bascule à
7 jours, et `shouldRemindAdmin` cherche une ligne « GPS perdu » dans les 7 derniers jours — le rappel
de 24 h s'y trouve. **Sous le code corrigé, aucune ligne ne devait être écrite à 48 h.**

| Véhicule | Épisode ouvert | Rappel 24 h | Rappel 48 h | Attendu sous le correctif |
|---|---|---|---|---|
| **FZ-862-VY** | 12/08 08:50:11 | 13/08 08:50:15 ✅ | **14/08 08:55:15 — PRÉSENT** | **absent** |
| **FS-253-HR** | 12/08 15:20:59 | 13/08 15:25:15 ✅ | **14/08 15:30:15 — PRÉSENT** | **absent** |

Les deux lignes existent, portent « sans position depuis 2 j », et tombent au premier tick suivant
l'échéance (le détecteur tourne toutes les 5 min à `:15`). **Le code servi rappelle quotidiennement :
l'espacement n'est pas en production.** Deux véhicules, deux épisodes distincts, deux heures
d'échéance différentes — ni un détecteur éteint ni un hasard de tick ne produisent ce motif.

> **La leçon, et elle porte sur l'écriture des tests, pas sur leur lecture.** Le volet décisif avait
> été placé au 3ᵉ rappel en s'appuyant sur la phrase de documentation — « quotidien les deux premiers
> jours ». Cette phrase est exacte, et elle désigne pourtant le mauvais instant : « les deux premiers
> jours » ne produit qu'**un seul** rappel, celui de 24 h, parce que le suivant est déjà hors borne.
> *Un test daté doit tirer son instant discriminant de la condition aux limites du code, pas de la
> prose qui la décrit.* Le coût a été d'un jour d'attente et de deux rapports concluant « non échu ».

⚠️ **Ce qui change pour [TRK-019](#trk-019) :** la perte des correctifs reposait jusqu'ici sur des
`grep` de marqueurs — une preuve d'absence de code. Elle repose désormais **aussi** sur un
comportement observé en production, mesuré sur deux sujets indépendants. Les deux instruments
concordent.

🗓️ **Test suivant — 3ᵉ rappel (72 h), échéances 15/08 08:50 et 15:20.** Sous le code régressé : une
ligne de plus par véhicule. **Ce volet est une confirmation, plus un discriminant** — le 48 h a
tranché. **À lire lors de l'audit du 16/08**, jamais le jour même : l'échéance est postérieure à
l'heure de collecte (01:11 ce jour, 04:16 la veille), donc illisible par construction.
**Condition de nullité inchangée :** relire `lastPositionAt` avant de conclure d'une absence.

### Action
**Terrain, pas code.** Antennes GPS à vérifier sur **FS-253-HR** et **FZ-862-VY** — les deux longs
épisodes se sont refermés au bout de ~4 jours, mais les deux véhicules **reperdent leur fix dans
la journée** : c'est une antenne intermittente, pas une panne résolue. KSR370 récidive
(3 épisodes en 3 jours) → candidat au même contrôle.

### ⚠️ Ne pas « corriger » en silenciant
Ce détecteur a été explicitement mis hors périmètre de la passe du 2026-07-27 : c'est un vrai
signal matériel. Baisser son niveau ou élargir sa dédup ferait disparaître la seule chose qui
rende visible une antenne morte. *Corriger un message ≠ affaiblir une garde.*

---

### ✅ 2026-08-10 19:39 UTC — correctif DÉPLOYÉ *(l'en-tête ci-dessous disait « non déployé » : périmé le soir même)*

Le rappel quotidien sans fin est corrigé — livré sur `main` @ `d5e5fb1`, en production depuis le
10/08 19:39 UTC (vérifié sur `main`, pas sur la note du passage précédent). Les rappels au centre
d'alerte s'ESPACENT avec l'âge de l'épisode (quotidien les 2 premiers jours, puis hebdomadaire,
puis mensuel).

**Première mesure, 2026-08-11 :** aucune ligne `gps-integrity` depuis le 10/08 09:20, alors que
l'épisode de FZ-862-VY dure toujours (5ᵉ jour). L'espacement s'applique.
🗓️ **Test daté au 12/08** : l'épisode ayant plus de 4 jours, la cadence doit être **hebdomadaire** —
**aucune ligne attendue le 11/08 vers 09:20**. Si un rappel quotidien réapparaît, l'espacement n'a
pas pris.

### Mise à jour du 2026-08-11 — l'épisode entre dans sa cinquième journée, et un second rouvre

| IMEI | Plaque | Sans position depuis | Épisode ouvert le | Alerte ? |
|---|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **88,1 h** | 07/08 09:07 | rappels espacés (voir ci-dessus) |
| `864035054757027` | **FS-253-HR** | **10,1 h** | 10/08 15:03 | **silencieux à raison** — sous le plafond de 24 h |

FS-253-HR rouvre un épisode cinq jours après le précédent : le profil « antenne intermittente »
décrit le 08/08 se confirme sur un quatrième cycle. Son silence est le comportement voulu
([TRK-011](#trk-011)) — un stationnement de nuit ne doit pas crier.

⚠️ Ces deux véhicules sont aussi ceux dont les commandes de coupure moteur restent `SENT` sans
confirmation possible : sans fix GPS, la chute d'ignition qui sert d'accusé de réception n'est pas
observable. Voir [TRK-018](#trk-018) — même cause matérielle, vue depuis une autre table.

### ~~✍️ 2026-08-10 (soir) — correctif ÉCRIT, pas encore déployé~~ *(périmé, voir ci-dessus)*

⚠️ Ce qui n'est pas touché : l'alerte FLOTTE garde sa cadence quotidienne — c'est le canal de
l'exploitant, et l'acquitter la fait taire. Et le rappel ne devient **jamais** muet : un épisode
d'un an produit encore une ligne par mois. Rendre le silence infini serait rouvrir exactement le
trou de [TRK-011](#trk-011), où une zone confirmée bénigne éteignait l'alerte sans borne de durée.
*On corrige le cri, pas le garde-fou.* 4 tests ajoutés, dont un qui vérifie que le rappel ne
s'éteint pas.


### 🗓️ 2026-08-16 — 3ᵉ rappel PRÉSENT sur les deux véhicules : la régression est confirmée une 3ᵉ fois

**Condition de nullité vérifiée d'abord**, comme l'exige cette fiche depuis le 13/08 :
`lastPositionAt` vaut toujours **12/08 08:50:11** (FZ-862-VY) et **12/08 15:20:59** (FS-253-HR).
Les deux épisodes sont **ouverts** — le test a un objet.

| Véhicule | 24 h | 48 h | **72 h** | Sous le correctif restauré |
|---|---|---|---|---|
| **FZ-862-VY** | 13/08 08:50:15 | 14/08 08:55:15 | **15/08 09:00:15 — PRÉSENT** | absent (fenêtre hebdomadaire) |
| **FS-253-HR** | 13/08 15:25:15 | 14/08 15:30:15 | **15/08 15:35:15 — PRÉSENT** | absent |

Trois rappels consécutifs par véhicule, espacés d'exactement 24 h — au tick de 5 minutes près, qui
décale chaque ligne de +5 min (08:50 → 08:55 → 09:00). **Le code servi rappelle quotidiennement.**
La reconstruction de cette nuit ([TRK-019](#trk-019)) ne l'a pas ramené.

Ce volet était annoncé le 15/08 comme une **confirmation**, pas un discriminant — le rappel de 48 h
avait déjà tranché. Il tient son rôle : troisième point, même motif, deux véhicules indépendants,
deux heures d'échéance différentes.

**État terrain — 4ᵉ jour d'épisode :**

| IMEI | Plaque | Sans fix | Épisode ouvert |
|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **88,3 h** | 12/08 08:50:11 |
| `864035054757027` | **FS-253-HR** | **81,8 h** | 12/08 15:20:59 |

⚠️ Le contrôle terrain est demandé depuis le **03/08** — treize jours. Rien à diagnostiquer de plus.

---

## TRK-002

**Signature** — `frontend | ERROR | [api-fetch] Error: Rafraichissement de session — API injoignable : TypeError: <TYPE>`
(`<TYPE>` = `Load failed` sur Safari/iOS, `Failed to fetch` sur Chrome — même défaut)
**Statut : 🟢 CORRIGÉ** *(déployé — `d5e5fb1` est sur `main`, branche servie depuis le 2026-08-16 16:03)*
· 8 occurrences · 2026-07-29 → 2026-08-13

> ### 🔴 Rectification du 2026-08-17 — le marqueur binaire de cette fiche est RETIRÉ
>
> Du 12/08 au 16/08, **cinq rapports** ont déclaré cette fiche en régression au motif que
> `consecutiveTransportFailures` était introuvable dans le bundle servi. **Ce verdict a été rendu
> cinq fois par un instrument qui rend « absent » quoi qu'il arrive.**
>
> Le symbole est `let consecutiveTransportFailures = 0;` — une variable de **portée module**, ni
> exportée ni atteinte par chaîne, dans un artefact **minifié d'une seule ligne**
> (`chunk-IJIQMQ3Y.js`, 4 721 octets). Le minifieur la renomme, toujours.
>
> **Le contrôle qui réfute la méthode :**
>
> | Symbole | Nature | Antérieur au correctif ? | Occurrences |
> |---|---|---|---|
> | `shouldReportNetworkFailure` | fonction de module | **oui, des semaines** | **0** |
> | `noteTransportFailure` · `CONFIRM_AFTER_FAILURES` · `__resetTransportFailureCount` | module | non | 0 |
> | `"API injoignable"` · `"Rafraichissement de session"` | littéraux de chaîne | oui | **1** · **1** |
>
> Un symbole certainement en production rend zéro : la mesure ne mesure rien. Le témoin employé
> jusqu'ici était un *littéral de chaîne* — il attestait qu'on lisait le bon fichier, jamais qu'un
> **nom de variable** y serait visible s'il existait.
>
> 🔑 **Un témoin ne vaut que s'il est de la MÊME NATURE que ce qu'il contrôle.** Sur un artefact
> minifié, seuls survivent les littéraux, les noms exportés non élagués et les clés d'objet lues par
> chaîne. Les marqueurs *API* restent valables (sortie `tsc`, non minifiée) ; **tout marqueur *web*
> de type identifiant est proscrit** dans ce référentiel.
>
> **Ce qu'on peut affirmer, et rien de plus :** le correctif est **déployé**, établi par l'identité
> de la branche servie et la date de l'image — pas par une observation du bundle. Le seul contrôle
> valable désormais est **comportemental** : toute ligne `frontend | Rafraichissement de session`
> postérieure au 16/08 16:03 prouverait que la confirmation à deux échecs ne tient pas.

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

### 🔴 2026-08-13 — la régression PRODUIT des lignes : le contraste porte sur trois périodes

Hier, la régression était une déduction (un marqueur absent d'un bundle). Aujourd'hui elle est
mesurée dans `error_logs` :

| Période | Correctif | Lignes de la signature |
|---|---|---|
| 29/07 → 10/08 19:39 | absent | **3** (29/07, 03/08 ×2, 10/08) |
| **10/08 19:39 → 11/08 22:37** *(27 h)* | **EN LIGNE** | **0** |
| **11/08 22:37 → 13/08 01:11** *(26 h)* | retiré | **2** — 12/08 09:20:29 et 14:40:47 |

Les deux lignes : même utilisateur, iPhone iOS 18.7, `TypeError: Load failed`, sur
`/vehicles/…` puis `/settings`. **Aucune ne tombe dans une fenêtre de redéploiement** — les
conteneurs ont été recréés à 07:09 et 14:15, soit +2 h 11 et +25 min. Ce sont des hoquets isolés :
exactement ce que la confirmation à deux échecs consécutifs faisait taire.

⚠️ **Deux lignes ne font pas une tendance (§4 bis), et ce n'est pas ce qui est affirmé ici.** Ce qui
conclut est le **zéro intercalaire** : la seule fenêtre sans ligne depuis le 29/07 est exactement
celle où le correctif était en ligne. *Un contraste sur trois périodes vaut ce qu'une série de deux
points ne vaudra jamais.*

⚠️ **Le test daté du 18/08 reste illisible** tant que le correctif n'est pas remis en ligne — la
même raison qu'hier. Il devra être réarmé à partir de la date de remise, pas de sa date d'origine.

### 🔴 2026-08-12 — RÉGRESSION : le correctif n'est plus en production

Il n'a pas cassé, il a été **retiré**. Le déploiement du 11/08 à 22:37 UTC reconstruit la
production depuis `feat/depot-partage`, branche forkée de `main` le 07/08 — soit trois jours avant
`d5e5fb1`. Vérifié sur le **bundle servi** et pas sur le commit :
`consecutiveTransportFailures` est **absent** de `/usr/share/nginx/html/`, alors que le témoin
« Rafraichissement de session » s'y trouve bien (`chunk-TJGA5ATM.js`). Voir [TRK-019](#trk-019).

⚠️ **Le test daté du 18/08 devient illisible et doit être réarmé après remise en ligne.** Il
attendait zéro ligne sur 7 jours *alors qu'un redéploiement continue d'en produire* ; avec le
correctif absent, un zéro comme une ligne sont tous deux compatibles avec n'importe quelle
hypothèse. *Un test daté ne survit pas au retrait de ce qu'il teste — encore faut-il s'en
apercevoir avant de lire son résultat.*

### ✅ 2026-08-10 19:39 UTC — correctif DÉPLOYÉ *(la note ci-dessous disait « non déployé » : périmée le soir même)*

« Confirmer avant de crier » : un échec de transport ISOLÉ ne remonte plus. Il faut **deux échecs
consécutifs**, le compteur étant remis à zéro dès qu'une requête aboutit. Le cas visé est le
hoquet mobile (tunnel, bascule wifi/4G, changement de cellule) que `navigator.onLine` ne voit pas
et que la garde « page cachée » ne couvre pas — encore une ligne le 10/08 sur `/map` depuis un
iPhone. **Livré sur `main` @ `d5e5fb1`**, image `tracky-web` reconstruite le 10/08 à 19:38 UTC
(`consecutiveTransportFailures` vérifié présent dans `api-fetch.ts` sur `main`).

🗓️ **Test daté au 2026-08-18** : zéro ligne de cette signature sur 7 jours **alors qu'une vraie
coupure d'API (redéploiement) continue d'en produire**. *Condition d'échec : si aucune ligne
n'apparaît jamais, y compris pendant un redéploiement, le correctif a supprimé le signal et pas le
bruit — et le module est devenu inutile.*

### ~~✍️ 2026-08-10 (soir) — correctif ÉCRIT, pas encore déployé~~ *(périmé, voir ci-dessus)*

⚠️ Le signal survit : une API réellement tombée enchaîne des dizaines d'échecs en une fraction de
seconde, donc elle parle en quelques secondes — et le canal temps réel a par ailleurs son propre
détecteur indépendant ([TRK-003](#trk-003)). Ce qui disparaît est uniquement le hoquet unique.
19 tests au vert, dont trois neufs sur la confirmation et la remise à zéro.

⚠️ Piège rencontré en écrivant les tests : `reportClientError` déduplique un message identique
sur **15 s**, avec un état au niveau du MODULE que rien ne réinitialise entre deux tests. Deux
tests utilisant le même libellé se masquaient l'un l'autre — un test peut ainsi passer au vert
pour une raison qui n'a rien à voir avec ce qu'il croit vérifier.


## TRK-003

**Signature** — `realtime-client | CRITICAL | Canal temps réel JAMAIS établi (<DURÉE>s) — API/WS injoignable — reason=<R>, transport=<T>, flaps=<N>, err=<E>`
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 1 occurrence · 2026-07-31 13:00
*(Aucune nouvelle occurrence. La ligne CRITICAL encore visible au centre d'alerte lui est antérieure.)*

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



## TRK-004

**Signature** — `http | ERROR | Le budget IA mensuel est atteint. L'analyse sera de nouveau possible le mois prochain, ou après relèvement du budget.` (`statusCode: 503`)
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 1 occurrence · 2026-07-29

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
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 1 occurrence · 2026-07-28

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
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · **3 commandes · 2 boîtiers** · 2026-08-03 → 2026-08-04

> ⚠️ **Le correctif tient — et il a créé [TRK-013](#trk-013).** Le balayage solde bien la file
> (0 commande en attente les 05 et 06/08, 6 puis 8 clôtures observées), mais il clôt **tout** en
> `FAILED` sans jamais comparer la cadence obtenue à la cadence demandée. Ne pas défaire
> l'échéance temporelle en voulant corriger cela : c'est la comparaison qui manque, pas la patience.

### Cause racine — aucun chemin automatique ne solde une `fix_continuous`
La commande déclare pourtant comment elle devrait être confirmée :

```ts
expectedResult: `intervalle ~${target}s observe sur les 3 prochaines trames`
```

Mais **rien n'écrit jamais cette observation dans la commande.** Inventaire des écritures de statut :

| Écriture | Fichier | Déclencheur |
|---|---|---|
| `ACKNOWLEDGED` | `tracker-commands.service.ts` | ACK attendu sur le fil — **jamais atteint depuis le chemin adaptatif** *(voir la rectification ci-dessous)* |
| `acknowledgedAt` | `admin-alerts.controller.ts` | **Acquittement manuel** par un admin, uniquement |
| `FAILED` | `positions.service.ts` | Seulement à la **transition** `fixCommandFailing` false→true |

Conclusion : si le boîtier ne bascule jamais FAILING, la commande reste `SENT` **à vie** et
s'affiche indéfiniment au centre d'alerte. C'est le cas ici (3 h et 9 h d'ancienneté).

> ### ⚠️ Rectification du 2026-08-07 — l'`expectedAckPattern` existe
>
> Cette fiche affirmait « jamais pour `fix_continuous` (pas d'`expectedAckPattern`) ». Le
> catalogue en définit un : `coban.catalog.ts:177` → `/fix.*ok/i`, `ackTimeoutMs: 15000`.
>
> Ce qui manque n'est pas le **motif**, c'est l'**appel**. Le chemin adaptatif
> (`tracker-fix-mode.service.ts:647-659`) n'arme jamais `ackWaiter.waitForAck` ; le chemin
> générique (`tracker-commands.service.ts:239-241`), lui, le fait. Voir [TRK-014](#trk-014).
>
> **La conclusion opérationnelle de cette fiche reste juste** — l'échéance doit être purement
> temporelle — mais elle reposait sur une justification fausse. Et si l'on arme l'écoute d'ACK
> (correctif de TRK-014), il ne faut surtout **pas** en reconditionner la clôture : c'est
> exactement le piège que l'échéance temporelle a été écrite pour éviter.

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

### Mise à jour du 2026-08-04 — le mécanisme, et pourquoi la transition n'arrivera jamais

**Vérification empirique :** les 2 commandes vues la veille sont **toujours `SENT` 24 h plus
tard** (7 h 40 et 13 h 40 d'ancienneté). Une troisième s'est ajoutée, sur un **second** boîtier.

| Créée le | Boîtier | Plaque | Âge | Motif d'envoi |
|---|---|---|---|---|
| 03/08 21:15 | `864035054756763` | **FZ-731-YF** | 3 h 45 | `STOPPED_TO_MOVING` |
| 03/08 17:20 | `864035052915643` | EY-613-MF | 7 h 40 | `STOPPED_TO_MOVING` |
| 03/08 11:20 | `864035052915643` | EY-613-MF | 13 h 40 | `STOPPED_INTERVAL_ADJUSTED` |

La fiche disait « si le boîtier ne bascule jamais FAILING ». On sait maintenant **pourquoi** il ne
bascule pas : la garde « véhicule garé » (V1.18) de `reconcile()` remet le compteur d'échecs à
**zéro** à chaque trame lente d'un boîtier immobile.

```ts
const movingNow = frame.ignition === true || frame.speedKmh > PARKED_SPEED_KMH;
if (observedS > upper && !movingNow) {
  return { nextCurrentFixIntervalS: observedS, nextFailureCount: 0, nextFailing: false, … };
}
```

Or c'est exactement l'état des deux boîtiers concernés :

| Boîtier | Plaque | Cible | Réel | État |
|---|---|---|---|---|
| `864035054756763` | FZ-731-YF | 20 s | **3601 s** | ONLINE |
| `864035052915643` | EY-613-MF | 20 s | **3600 s** | ONLINE |

~1 trame par heure : le heartbeat Coban ACC OFF, comportement matériel normal. La garde V1.18 fait
donc **correctement** son travail — et, ce faisant, **désarme définitivement le seul chemin
automatique qui pouvait solder la commande**. Les deux gardes sont justes prises séparément ;
c'est leur **composition** qui laisse une commande ouverte pour toujours.

**Conséquence pour le correctif :** l'échéance proposée doit être **purement temporelle**. La
conditionner à un état du boîtier (FAILING, en mouvement, en ligne) la ferait retomber dans le
même piège. Ne pas non plus « corriger » la garde V1.18 : elle empêche un vrai faux positif
(3 véhicules garés déclarés FAILING à tort, prod du 2026-06-15).

---

## TRK-008

**Signature** — `fix_continuous | FAILED | observedResult = "Tracker FAILING — <N> trames non conformes"` — **en volume**
**Statut : 🔴 NON CORRIGÉ** · ~72/jour · 507 sur 7 jours · **3564+ au total** · découvert 2026-08-03 · **en extension**

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

### Mise à jour du 2026-08-04 — la dérive s'étend, et le plancher descend

| | 2026-08-03 | 2026-08-04 |
|---|---|---|
| Boîtiers à cible < 10 s | 4 | **10** |
| Cible la plus basse | 2 s | **1 s** |
| Échecs / jour | 72 | 72,4 |

| Cible | Réel | Véhicules |
|---|---|---|
| **1 s** | 20 s | FR-428-DQ, FM-772-JH |
| 2 s | 30 s / 8 s | FR-629-AD, FZ-862-VY |
| 3 s | 20 s / 8 s | GT-493-KS, KSR370 |
| 4 s | 19 s | *(boîtier sans véhicule)* |
| 5 s | 20 s | GS-909-NX |
| 8 s | 19 s / 9 s | GS-187-NY, FS-253-HR |

Le volume d'échecs, lui, est d'une régularité qui confirme le plafond anti-flapping : **36
boîtiers × exactement 2 commandes/jour, dix jours de suite** (71–74/jour du 25/07 au 03/08).

> L'important n'est pas que le compteur d'échecs stagne — c'est que **le nombre de boîtiers
> enfermés dans la boucle a plus que doublé en 24 h.** Le défaut ne se stabilise pas, il se
> propage : chaque nouvel épisode d'auto-alignement fait descendre une cible de plus.

L'apparition de cibles à **1 s** rend le correctif minimal (remonter `AUTO_ALIGN_FLOOR_S`) plus
tentant à court terme. Il reste déconseillé pour la raison écrite ci-dessous : il renverrait en
FAILING perpétuel les boîtiers qui émettent plus vite que demandé. Le correctif 1 reste le bon.

### Vérification après correctif
`SECTION commandes_sante_7j` doit tomber **bien en dessous de 72 échecs/jour**, et
`SECTION cadence_derive` ne doit plus afficher aucune ligne `cible_suspecte = t`. Un correctif
qui ferait seulement disparaître les lignes du centre d'alerte sans faire baisser le compteur
d'échecs n'aurait rien réglé — il aurait juste éteint le témoin.

### ✅ Mise à jour du 2026-08-05 — la cause déclarée est corrigée…

Vérifié 3 h 40 après le déploiement :

| `cadence_resume` | 2026-08-04 | 2026-08-05 |
|---|---|---|
| Cibles sous le minimum matériel | 14 | **0** |
| Cible la plus basse en base | 1 s | **20 s** |
| `cadence_derive` | 10 lignes | **0 ligne** |

Le clamp à la lecture a neutralisé toutes les cibles héritées, sans migration. Sur ce point la
fiche est close.

### 🔴 …mais elle ne rendait compte que de 10 % du volume

**Le compteur d'échecs n'a pas bougé.** Sur la fenêtre strictement comparable 21:30 → 01:10
(conteneur recréé à 21:30 UTC) : **14 échecs la veille, 14 cette nuit**, mêmes six boîtiers,
horodatages superposés à 9 ms près.

La fiche affirmait que les **295 échecs « intervalle observe: 20 s »** venaient d'un boîtier
émettant à son minimum matériel, jugé contre une cible descendue plus bas. **C'est faux.** Le
croisement `params.interval` × `observedResult` sur 7 jours le montre :

| Intervalle **demandé** | Observé | Occurrences |
|---|---|---|
| **300 s** (`005m`) | 20 s | **281** |
| 300 s | 30 s | 53 |
| 300 s | 21 s | 45 |
| 300 s | 19 s | 38 |
| 20 s | 10 s | 6 |
| 20 s | 4 s | 4 |

**281 des 291** échecs à « observe: 20 s » demandaient **300 s** — très au-dessus du minimum
matériel, donc parfaitement légitime. Aucun clamp ne pouvait les faire disparaître.

Répartition réelle des 506 échecs par motif d'envoi : **454 (90 %) en `STOPPED_INTERVAL_ADJUSTED`
à 300 s**, sur 36 boîtiers. C'est un **autre défaut** → [TRK-012](#trk-012).

> **Leçon.** Le récit de cette fiche était cohérent, documenté, appuyé sur du vrai code — et il
> expliquait un dixième des cas. Une cause racine se vérifie sur la **donnée de la commande**
> (`params`), pas sur la vraisemblance de l'histoire. Le contre-exemple tenait dans une requête
> de trois lignes qui n'a pas été faite.

### Confirmation du 2026-08-06 — vérifiée sur le comportement, pas sur un instantané

Le « 0 cible sous le minimum » du 05/08 était mesuré 3 h 40 après un redémarrage, sur une base que
`normalizeDriftedTargets` réécrit **toutes les 10 min** : un instantané ne pouvait pas distinguer
« plus rien n'écrit sous 20 s » de « le balayage a nettoyé juste avant la mesure ». Vérifié cette
fois sur 24 h de journaux, **62 auto-alignements, aucun sous 20 s** :

| Valeur écrite | 20 s | 21 s | 30 s | 31 s | 92 s |
|---|---|---|---|---|---|
| Occurrences | 44 | 9 | 7 | 1 | 1 |

La fiche est donc close sur une preuve de comportement, et non de coïncidence.

### ~~⚠️ Réserve — le chemin d'écriture, lui, n'est toujours pas borné~~ — **levée le 2026-08-07**

> La réserve écrite le 06/08 disait : « `positions.service.ts:303` écrit `desiredFixIntervalS`
> sans clamp, avec un plancher `AUTO_ALIGN_FLOOR_S = 1` ». **C'est faux.**

Vérifié dans le code le 2026-08-07 :

```ts
// tracker-fix-mode.service.ts:67
const AUTO_ALIGN_FLOOR_S = HARD_CAP_MIN_S;          // = 20 s depuis V1.19

// tracker-fix-mode.service.ts:479-482
const autoAlignDesiredS =
  nextFailing && observedS >= AUTO_ALIGN_FLOOR_S && observedS <= HARD_CAP_S
    ? observedS
    : null;
```

`autoAlignDesiredS` ne vaut donc autre chose que `null` que si l'observé tombe dans **[20 s, 300 s]**.
Le chemin d'écriture **est** borné, et il l'a été dans la même livraison que le clamp à la lecture.
La garantie n'est pas seulement comportementale : elle est dans le code. Rien à surveiller.

### ⚠️ Ce qui a fabriqué cette fausse réserve — et qui est toujours là

Le commentaire V1.15 des **lignes 473-478** n'a pas été repris lors de la livraison du 04/08. Il
annonce encore le comportement d'avant :

> « on accepte desormais aussi les intervalles SOUS le minimum hardware (boitiers qui emettent
> plus vite que demande, ex. 2s/10s) […] l'ancien plancher etait HARD_CAP_MIN_S = 20s »

Six lignes plus bas, la constante dit exactement l'inverse. Un lecteur qui s'arrête au commentaire
— c'est ce qui s'est produit le 06/08 — écrit une réserve sur un défaut qui n'existe plus.

> *Un commentaire périmé fabrique un faux constat aussi sûrement qu'un bug.* Même leçon que la
> rectification de [TRK-011](#trk-011) : ce qui décrit un mécanisme se vérifie sur le code.

*(Nettoyage de commentaire — hors périmètre de l'audit, qui ne modifie pas de code applicatif.)*

---

## TRK-012

**Signature** — `fix_continuous | FAILED | params.interval = "005m" | observedResult = "Tracker FAILING — <N> trames non conformes (intervalle observe: <DURÉE>)"` — **en volume**
**Statut : 🔴 NON CORRIGÉ** · **454 échecs / 7 jours · 36 boîtiers · 0 succès** · découvert 2026-08-05

> ### 454 fois la même consigne au même matériel, jamais honorée une seule fois.

### Constat

| Motif d'envoi | Échecs / 7 j | Boîtiers | Intervalle demandé |
|---|---|---|---|
| **`STOPPED_INTERVAL_ADJUSTED`** | **454 (90 %)** | **36** | `005m` = **300 s** |
| `MOVING_INTERVAL_ADJUSTED` | 17 | 8 | 20 s |
| `STOPPED_TO_MOVING` | 12 | 6 | 20 s |
| autres transitions | 23 | — | 20 / 30 s |

`acquittees = 0` sur les 454. Les boîtiers continuent à 19–30 s.

Le `contextSnapshot` est sans ambiguïté : `ignition: false`, `speedKmh: 0`, et surtout
`previousState = "STOPPED"`, `newState = "STOPPED"` — **l'état n'a même pas changé**. On réémet
une consigne à un véhicule déjà à l'arrêt, qui ne l'a jamais appliquée.

### Cause racine

À l'arrêt (contact coupé depuis > 10 min), `desiredIntervalFor()` demande **300 s** pour
économiser la batterie et le forfait 2G. Le Coban GPS403D **n'applique pas cet intervalle**.

La garde V1.19 qui exempte « émettre plus vite que demandé » est **restreinte au mouvement**, et
son commentaire l'assume explicitement (`tracker-fix-mode.service.ts`, ~ligne 450) :

```
⚠️ RESTREINT AU MOUVEMENT, volontairement. À l'ARRÊT, la cible (300 s) vise l'ÉCONOMIE de
batterie et de données : un boîtier qui émet plus vite y contrevient réellement.
```

**Ce raisonnement est juste.** C'est une vraie non-conformité, et l'économie visée est réelle.
Le défaut n'est pas dans le jugement — il est dans la **réponse au jugement** :

1. 3 trames hors bande → `FAILING` → la commande passe en `FAILED` ;
2. le prochain ajustement d'état relance `requestChange()` → **la même consigne repart** ;
3. jusqu'au plafond anti-flapping de **2 commandes / jour / boîtier** ;
4. 36 boîtiers × 2 ≈ **65–72 échecs par jour**, tous les jours, depuis des mois, **sans un seul
   succès**.

> **En une phrase :** la bonne réponse à « ce boîtier n'a jamais accepté cette consigne, 454 fois
> de suite » n'est pas « redemande-lui demain ».

### Coût

~454 écritures TCP par semaine vers des boîtiers 2G + autant de lignes en base, pour zéro effet.
Et surtout : **l'économie de batterie et de données que la cible de 300 s existe pour obtenir
n'est pas obtenue**, sur 36 boîtiers, sans qu'aucun écran ne le dise.

### Correctifs proposés

1. **Ne plus réémettre une consigne jamais honorée.** Après N échecs consécutifs sur le **même
   intervalle demandé** (proposition : 5), cesser d'envoyer cette consigne à ce boîtier et poser
   un état explicite — *« n'honore pas la consigne 300 s à l'arrêt »*. La consigne reprend si le
   boîtier l'honore une fois, ou sur action manuelle. C'est le correctif de fond : il supprime le
   trafic sans rien masquer.
2. **Rendre l'état lisible plutôt que bruyant.** Une section « boîtiers qui n'appliquent pas la
   cadence d'arrêt » alimentée par cet état. Un fait matériel stable **se consulte** ; il ne se
   notifie pas 72 fois par jour. *(Même famille que « à lire, pas à notifier ».)*
3. **Vérifier l'hypothèse matérielle AVANT d'écrire du code.** Le `payload` émis est
   `fix005m***n123456` : le suffixe est le **mot de passe Coban par défaut**. Si ces boîtiers ont
   un mot de passe différent, la commande est rejetée en silence et aucun correctif logiciel n'y
   changera rien. À trancher par un test SMS sur **un** boîtier. *(Piste, pas conclusion.)*

### 🔓 2026-08-10 — le préalable est levé, le code attend sa preuve

Cette fiche impose, noir sur blanc : *« Vérifier l'hypothèse matérielle AVANT d'écrire du
code. »* Ce préalable n'était pas vérifiable — personne n'écoutait la réponse des boîtiers.

**Il l'est depuis le 2026-08-10 20:03** : [TRK-014](#trk-014) arme le guetteur d'ACK sur ce
chemin exact. La réponse (ou le silence PROUVÉ) de chaque `fix005m` arrive désormais en base.

Aucune ligne de code n'a donc été écrite ici, **volontairement**. Le correctif #1 (cesser de
réémettre après N échecs sur le même intervalle) et le #3 (mot de passe Coban) mènent à des
gestes différents, et le résultat du test daté de TRK-014 dit lequel s'applique. Écrire le #1
maintenant serait exactement l'erreur que cette fiche interdit depuis le 05/08 — et la série a
déjà montré ce que coûte un correctif fondé sur un récit cohérent mais invérifié
([TRK-008](#trk-008), faux sur 90 % de son volume).

⚠️ **Ce qui ne change pas en attendant** : la cible d'arrêt de 300 s reste demandée, et les
~72 échecs quotidiens continuent. C'est assumé pour une nuit — ils ne produisent aucune alerte
et n'ont jamais rien cassé ; ce qu'ils coûtent est du trafic et une économie non obtenue.

### ⚠️ Ne pas « corriger » en élargissant la garde

Étendre l'exemption « plus vite que demandé » à l'arrêt ferait disparaître les 454 lignes en une
ligne de code — et annulerait silencieusement l'économie que la cible de 300 s existe pour
obtenir. Trois tests du module verrouillent ce comportement depuis l'origine, à raison.
*Le témoin n'est pas le défaut.*

### Vérification après correctif

`SECTION commandes_sante_7j` doit tomber **sous 15 échecs/jour** et `STOPPED_INTERVAL_ADJUSTED`
quitter la tête de `commandes_motifs_7j` — **sans** que la cible d'arrêt de 300 s soit
abandonnée. Un correctif qui ferait baisser le compteur en cessant de demander 300 s aurait
supprimé la fonctionnalité, pas le défaut.

### Mise à jour du 2026-08-06 — périmètre élargi, volume inchangé

Le motif `MOVING_TO_STOPPED` demande **la même consigne (300 s) au même matériel** et échoue de
la même façon. Il appartient donc à cette fiche, qui ne comptait que `STOPPED_INTERVAL_ADJUSTED` :

| Motif d'envoi | Demandé | Échecs / 7 j | Boîtiers |
|---|---|---|---|
| `STOPPED_INTERVAL_ADJUSTED` | `005m` | 441 | 36 |
| `MOVING_TO_STOPPED` | `005m` | 11 | 5 |
| **Total famille « 300 s à l'arrêt »** | | **452 / 502 = 90 %** | **36** |

Toujours `acquittees = 0`. Quatre points de mesure sur la **même fenêtre** (21:30 → 01:10, seule
fenêtre strictement comparable depuis le redémarrage du 04/08) :

| Nuit | 02→03/08 | 03→04/08 | 04→05/08 | 05→06/08 |
|---|---|---|---|---|
| Échecs | 14 | 14 | 14 | **15** |

Quatre points, même définition : **plat**. Ici la stabilité *est* l'information — elle prouve un
plafond atteint (2 commandes/jour/boîtier), pas un aléa.

**Fait nouveau, un seul point :** `fixCommandFailing` passe de 0 à **1** boîtier (HD-779-MA,
cible 20 s, réel 10 s à l'arrêt). Ce n'est pas une régression — la garde V1.19 refuse
volontairement d'exempter « plus vite que demandé » à l'arrêt, où la cible vise l'économie. C'est
donc ce défaut qui devient *partiellement visible* à l'écran. Un boîtier, une mesure : à
reconfirmer avant d'en conclure quoi que ce soit.

⚠️ Une partie du compteur d'échecs qui sert à juger cette fiche est **fausse** — voir
[TRK-013](#trk-013). Avant de mesurer l'effet d'un correctif ici, corriger là.

### Mise à jour du 2026-08-07 — volume plat, et l'hypothèse matérielle avance

**445 échecs sur 496 (89,7 %)**, 36 boîtiers, `acquittees = 0`. Répartition inchangée :
`STOPPED_INTERVAL_ADJUSTED` 435 + `MOVING_TO_STOPPED` 10.

Cinquième point sur la fenêtre strictement comparable (21:30 → 01:10) :

| Nuit | 02→03/08 | 03→04/08 | 04→05/08 | 05→06/08 | 06→07/08 |
|---|---|---|---|---|---|
| Échecs | 14 | 14 | 14 | 15 | **13** |

Cinq points, même définition : **plat**. Le total quotidien passe de 72 à 68 les 05 et 06/08, mais
sur **34 boîtiers au lieu de 36** — écart de périmètre, pas de tendance.

`fixCommandFailing` **repasse de 1 à 0** : le boîtier signalé la veille (HD-779-MA) n'est plus en
échec. C'est la confirmation qu'il ne fallait rien conclure d'une mesure unique — ni hier, ni
aujourd'hui.

### Mise à jour du 2026-08-08 — sixième point, toujours plat

**446 échecs sur 498 (89,6 %)**, 36 boîtiers, `acquittees = 0`. Répartition inchangée :
`STOPPED_INTERVAL_ADJUSTED` 435 + `MOVING_TO_STOPPED` 11.

| Nuit | 02→03/08 | 03→04/08 | 04→05/08 | 05→06/08 | 06→07/08 | 07→08/08 |
|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 14 | 15 | 13 | **13** |

Six points, même définition : **plat**. Le total quotidien remonte à **74 le 07/08 sur
37 boîtiers** (68 sur 34 les 05 et 06/08). Le rapport échecs/boîtier est constant à 2 : c'est le
plafond anti-flapping, et l'écart quotidien suit le nombre de boîtiers actifs, pas une tendance.

`fixCommandFailing` reste à **0**, deuxième jour de suite.

### Mise à jour du 2026-08-09 — septième point, et un invariant qui se confirme

**446 échecs sur 498 (89,6 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 433 + `MOVING_TO_STOPPED` 13, tous à `005m`.

| Nuit | 02→03 | 03→04 | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 |
|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 14 | 15 | 13 | 13 | **13** |

Sept points, même définition : **plat**.

Et l'invariant qui explique tout l'écart quotidien est désormais mesuré sur huit jours pleins :

| Jour | 01/08 | 02/08 | 03/08 | 04/08 | 05/08 | 06/08 | 07/08 | 08/08 |
|---|---|---|---|---|---|---|---|---|
| Commandes | 72 | 72 | 74 | 70 | 68 | 68 | 74 | 72 |
| Boîtiers | 36 | 36 | 37 | 35 | 34 | 34 | 37 | 36 |
| **Par boîtier** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** |

Le ratio ne bouge pas d'un centième : c'est le plafond anti-flapping (2 commandes/jour/boîtier)
atteint tous les jours par tous les boîtiers actifs. **Toute variation du total quotidien est un
écart de périmètre, jamais une tendance.** Le chiffre à surveiller après correctif n'est donc pas
le total : c'est le ratio, qui doit décrocher de 2,00.

### Mise à jour du 2026-08-10 — huitième point, et l'invariant tient sur neuf jours

**449 échecs sur 498 (90,2 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 427 + `MOVING_TO_STOPPED` 15, tous à `005m`, plus 7
`STOPPED_INTERVAL_ADJUSTED` à `030s`.

| Nuit | 02→03 | 03→04 | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 | 09→10 |
|---|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 14 | 15 | 13 | 13 | 13 | **13** |

Huit points, même définition : **plat**. Et le ratio commandes/boîtier reste à **2,00 le 09/08**
(72 commandes, 36 boîtiers) — neuvième jour consécutif sans écart d'un centième.

⚠️ **Un fait nouveau change le contexte de cette fiche sans changer son diagnostic.**
[TRK-017](#trk-017) établit que 24 des 43 SIM du parc étaient hors de l'allowlist SMS. Cela ne
concerne **pas** le canal des commandes de cadence, qui passe en TCP : les 449 échecs restent
mesurés sur l'intervalle des trames reçues. Mais cela retire une option au correctif #3 — le test
SMS sur un boîtier — tant qu'on n'a pas la certitude que son numéro est autorisé. **Vérifier
l'allowlist avant d'interpréter l'échec d'un test SMS**, sans quoi un `403` de la passerelle
passerait pour un boîtier muet.

**Le correctif #3 avance sans le test SMS.** [TRK-014](#trk-014) établit que le boîtier ne répond
**rien** : 275 commandes `fix…` envoyées en 4 jours, aucune trame de réponse, et `ackedAt` NULL sur
les 3797 commandes émises depuis avril. Le test SMS reste utile pour trancher entre « rejetée en
silence » et « acceptée mais non appliquée » — mais **armer l'écoute d'ACK est plus rapide, plus
sûr et couvre les 36 boîtiers d'un coup**. À faire avant tout correctif ici : sans ça, on pilote
à l'aveugle.

### 🔓 Mise à jour du 2026-08-11 — l'écoute a répondu, et elle ne désigne pas le firmware

**447 échecs « 300 s à l'arrêt » sur 496 (90,1 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 430 + `MOVING_TO_STOPPED` 14, tous à `005m`, plus 7
`STOPPED_INTERVAL_ADJUSTED` à `030s`.

| Nuit | 03→04 | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 | 09→10 | 10→11 |
|---|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 15 | 13 | 13 | 13 | 13 | **13** |

Neuf points, même définition : **plat**. Et le ratio commandes/boîtier atteint **dix jours
consécutifs à 2,00** — 72/36, 74/37, 70/35, 68/34, 68/34, 74/37, 72/36, 72/36, 72/36 du 02 au 10/08,
sans un centième d'écart. Le plafond anti-flapping est saturé tous les jours.

**Le test daté de [TRK-014](#trk-014) est tombé, et il ne libère pas le correctif #1 — il le
suspend.** Quatorze commandes `fix005m` émises après l'armement de l'écoute, **quatorze silences
tracés, zéro réponse**. Selon la table de décision de TRK-014, ce résultat écarte
« le firmware accepte mais n'applique pas » et laisse en lice « la commande n'arrive pas » et
« elle est rejetée en silence (mot de passe) ». Or le correctif #1 (cesser de réémettre) suppose que
le boîtier reçoive et refuse d'appliquer.

> **Écrire le #1 maintenant serait exactement l'erreur que cette fiche interdit depuis le 05/08.**
> Le préalable est désormais le **test SMS sur un boîtier** — et [TRK-017](#trk-017) impose de
> vérifier d'abord que son numéro est dans l'allowlist, sans quoi un `403` de la passerelle passerait
> pour un boîtier muet. À quoi [TRK-018](#trk-018) ajoute une contrainte : un SMS resté `queued`
> n'est pas une preuve d'envoi. **Trois fiches se rejoignent sur le même geste, et aucune ne peut
> le remplacer.**

### 🎯 2026-08-11 (2ᵉ passage, 09:22 UTC) — CAUSE RACINE TROUVÉE : la trame est au mauvais format

**Le test SMS n'est plus nécessaire.** La question qu'il devait trancher est tranchée par les
données de production et par la référence de protocole du dépôt. Et la réponse n'est **aucune des
deux hypothèses** que la table de décision de [TRK-014](#trk-014) laissait en lice.

`fix_continuous` envoie sur la **socket TCP** un payload au **format SMS** :

```
fix005m***n123456          ← ce qui part, depuis le 2026-04-27
**,imei:<IMEI>,C,05m;      ← ce que le parseur TCP du Coban attend
```

Le boîtier reçoit bien la trame — la socket est la même que celle qui marche. Il ne sait pas la
lire, donc il ne l'applique pas et ne répond rien. **Une trame illisible n'a pas de réponse : elle
n'a même pas d'erreur.** C'est exactement la signature observée depuis quatre mois.

#### La preuve — deux familles de commandes sur la MÊME socket, résultats opposés

Sur la fenêtre 10/08 20:03 → 11/08 09:22 (13 h), `wire_logs` :

| Famille | Format émis | Mot de passe | Trames | Réponses | Latence |
|---|---|---|---|---|---|
| **A** — moteur (`engine_control`) | `**,imei:<IMEI>,K;` / `,J;` | **non** | 36 | **33** | **~2,6 s** |
| **B** — cadence (`fix_continuous`) | `fix005m***n123456` | oui (`123456`) | 47 | **0** | — |

Les 33 réponses de la famille A ne sont pas des coïncidences : **33 sur 33** se corrèlent à une
trame sortante du même IMEI dans les 15 s, latence moyenne 2,60 s, et la lettre de la réponse
**écho celle de la commande** (`K;` → `kt`, `J;` → `jt`). Sur la même période, `IN` contient
**92 439 trames** dont **zéro** portant « fix », « ok », « error » ou « password ».

Et le contraste tient sur toute l'histoire, pas seulement sur 13 h :

| Depuis l'origine | Commandes | Acquittées |
|---|---|---|
| Famille A — `engine_control_commands` (depuis le 01/08) | 780 | **713** |
| Famille B — `tracker_commands`, **tous templates confondus** | **4 120** | **0** |

**Les 4 120 commandes émises depuis avril portent toutes le format texte.** `fix_continuous`,
`sensitivity`, `shock_on` : les trois seuls templates jamais utilisés, et les trois construisent
un payload SMS. **La commande TCP `,C,` n'a jamais été émise une seule fois** — `wire_logs` en
compte **0** depuis l'origine. L'hypothèse n'avait donc jamais pu être contredite : le cas
témoin n'existait pas.

#### La référence était dans le dépôt depuis le début

[`docs/03-protocol-coban-gps403d.md`](../03-protocol-coban-gps403d.md) §4.2.1, table extraite de
`Gps103ProtocolEncoder.java` de Traccar :

| Fonction | Payload TCP |
|---|---|
| Tracking périodique | `**,imei:<IMEI>,C,<XX><s\|m\|h>` |

Et §4.1 : *« Préfixe obligatoire : `**,` — envoi sur la socket existante du boîtier. »* Le format
texte `fixNNNm***n<pass>` est la forme **SMS** de la même commande. Le catalogue
(`coban.catalog.ts:176`) déclare `availableVia: ['sms','tcp']` mais n'a **qu'un seul
`buildPayload`** — donc un seul format pour deux canaux qui n'ont pas la même grammaire. *Le
défaut n'est pas dans la valeur envoyée, il est dans l'enveloppe.*

⚠️ **Détail qui compte pour le correctif :** Traccar formate la fréquence sur **deux** chiffres
(`String.format("%02dm", …)`), donc 300 s → **`05m`**, pas `005m`. Le catalogue utilise la forme
SMS à trois chiffres (`005m`, `010s`, `002m`…). Reprendre la forme du catalogue telle quelle dans
l'enveloppe TCP reproduirait le défaut sous une autre forme.

#### Ce que ça change pour les correctifs de cette fiche

Le correctif **#1** (cesser de réémettre après N échecs) **devient sans objet** : il traitait le
symptôme d'une consigne jamais honorée. Si la consigne est honorée, il n'y a plus rien à taire.
Le **#3** (mot de passe Coban) **tombe** : le mot de passe n'a jamais été lu, faute d'enveloppe.

> **Le correctif est désormais : émettre la bonne trame.** `**,imei:<IMEI>,C,05m;` sur le chemin
> TCP, la forme texte restant réservée au canal SMS. Ce n'est plus « faire taire 72 échecs par
> jour » — c'est **obtenir enfin la cadence de 300 s**, et avec elle l'économie de batterie et de
> forfait 2G que la cible existe pour produire, sur 36 boîtiers.

#### Ce qui reste à vérifier avant de généraliser — et pourquoi rien n'est codé ici

Le faisceau est solide mais il **n'a pas encore été vérifié sur un boîtier**. La discipline de
cette fiche depuis le 05/08 — *vérifier avant d'écrire du code* — s'applique à ce constat comme
elle s'appliquait aux précédents. Le test de validation est devenu **beaucoup plus simple que le
test SMS** qu'il remplace : il ne demande ni SMS, ni allowlist, ni preuve de remise, et il est
non destructif.

**Marche à suivre — un boîtier, une trame, dix minutes :**

1. Choisir **un** boîtier en ligne et à l'arrêt (cadence réelle observée 19–30 s).
2. Lui envoyer **une seule** trame `**,imei:<IMEI>,C,05m;` sur sa socket existante.
3. Observer `wire_logs IN` pendant 10 min : l'intervalle entre deux trames `position` doit passer
   de ~20 s à ~300 s.
4. **La preuve est l'intervalle, pas la réponse.** Le manuel Coban ne garantit aucun écho sur
   `,C,` ; l'absence d'ACK ne vaudrait donc pas échec ici — seule la cadence tranche.
5. Contrôle négatif, gratuit : les 35 autres boîtiers restent à ~20 s sur la même fenêtre.

⚠️ **Le piège du motif d'ACK, à ne pas reproduire.** Les motifs `status` et `position_single`
(`/imei:\d{15},(tracker|[A-Z])/i`, insensible à la casse) **matchent les trames `jt` / `kt`** des
commandes moteur. Un test qui conclurait sur ce motif compterait un ACK moteur pour une réponse de
cadence. Corréler sur le **temps** et sur l'**IMEI**, jamais sur le motif seul.

> **Aucune ligne de code n'est écrite ici, et c'est délibéré** — pour la deuxième fois sur cette
> fiche, mais pas pour la même raison qu'hier. Hier il manquait la preuve. Aujourd'hui elle est
> là, et ce qui manque est un **accord** : changer la trame émise change ce que reçoivent
> 43 boîtiers en service. C'est une décision humaine (§8 de la procédure).

### Mise à jour du 2026-08-13 — dixième point plat, et un renfort venu d'une autre fiche

**449 échecs « 300 s à l'arrêt » sur 500 (89,8 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 436 + `MOVING_TO_STOPPED` 13, tous à `005m`, plus 8
`STOPPED_INTERVAL_ADJUSTED` à `030s`.

| Nuit | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 | 09→10 | 10→11 | 11→12 | 12→13 |
|---|---|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 15 | 13 | 13 | 13 | 13 | 13 | 13 | **13** |

Dix points, même définition : **plat**.

⚠️ **Et le ratio commandes/boîtier sort de 2,00 pour la première fois en onze jours : 2,03 le
12/08** (73 / 36). L'écart n'est **pas** une dérive du plafond anti-flapping — il a un nom :
**FM-772-JH a reçu 4 commandes**, dont deux manuelles à 06:10, celles de [TRK-021](#trk-021). Sur le
périmètre que le plafond gouverne, l'invariant tient. *Un invariant qui bouge se vérifie avant
d'être raconté : celui-ci a été brisé par un humain, pas par un automate.*

### 🔗 Mise à jour du 2026-08-13 — deux cas indépendants renforcent la cause racine

[TRK-021](#trk-021) apporte à cette fiche deux témoins qu'elle n'avait pas : les commandes
`sensitivity` et `shock_on` envoyées manuellement le 12/08 à 06:10 portent des payloads au **format
SMS** (`sensitivity123456 2`, `shock123456`, suffixe `123456` = mot de passe Coban par défaut),
partent sur le canal **TCP**, et obtiennent **zéro réponse** — sur un boîtier `ONLINE`, avec un
guetteur d'ACK bien armé (chemin générique).

**Trois templates, trois utilisateurs de code différents, un seul et même symptôme.** Le faisceau
gagne deux cas indépendants sans qu'aucun test n'ait été lancé sur un boîtier. Le test de
validation de cette fiche (une trame `**,imei:<IMEI>,C,05m;`) reste **en attente d'accord** : il
n'est pas remplacé par ces observations, il est renforcé.

⚠️ Les deux fiches restent distinctes : ici « bon canal, mauvaise enveloppe » ; là « mauvais canal,
alors que la donnée qui dit lequel choisir est déjà dans le catalogue ». Deux gestes, deux
correctifs.

---

## TRK-013

**Signature** — `fix_continuous | FAILED | observedResult = "Sans effet constaté après <DURÉE> :
cadence réelle <N>s pour une cible de <N>s."` — *avec les deux valeurs égales*
**Statut : 🔴 NON CORRIGÉ** · **5 clôtures fausses + 6 cibles mal citées sur 28** · découvert 2026-08-06

> ### Le correctif de [TRK-007](#trk-007) solde la file. Il la solde en déclarant échec ce qui a abouti.

### Constat

Sur les 17 commandes closes par échéance depuis le 03/08, **trois** portent ce texte :

> « Sans effet constaté après 37 min : cadence réelle **20 s** pour une cible de **20 s**. Le
> boîtier n'acquitte pas ; commande close par échéance. »

| Commande | `params.interval` | Cadence réelle | Statut écrit |
|---|---|---|---|
| HD-443-QY · 05/08 15:40 | `020s` | 20 s | `FAILED` |
| FS-808-CE · 05/08 13:44 | `020s` | 20 s | `FAILED` |
| FW-298-WV · 04/08 13:45 | `020s` | 20 s | `FAILED` |

L'intervalle demandé est exactement celui observé, et la ligne est archivée comme un échec.

### Cause racine — il n'y a aucune comparaison

`tracker-fix-mode.service.ts:302-317` sélectionne les commandes trop vieilles, écrit `FAILED`, et
compose un message. Aucun test de conformité n'existe entre les deux :

```ts
const reel = c.tracker.currentFixIntervalS;
data: {
  status: TrackerCommandStatus.FAILED,
  observedResult: `Sans effet constaté après ${ageMin} min : cadence réelle ` +
    `${reel != null ? `${reel}s` : 'inconnue'} pour une cible de ` +
    `${c.tracker.desiredFixIntervalS}s. …`,
}
```

Une commande dont la cible est atteinte est close **exactement comme** une commande à 3600 s réels
pour une cible de 20 s.

### Second défaut, dans la même requête — la cible citée n'est pas celle demandée

Le `select` (ligne 293-297) ne charge pas `params`. La « cible » du message est donc
`c.tracker.desiredFixIntervalS`, **lue au moment du balayage** : la cible courante du boîtier, qui
a pu changer depuis l'envoi. Sur 4 des 17 clôtures, les deux diffèrent :

| Commande | Demandé (`params`) | Annoncé dans le message |
|---|---|---|
| HD-443-QY · 05/08 15:24 | `005m` (300 s) | « cible de 20 s » |
| FW-298-WV · 04/08 13:36 | `030s` | « cible de 20 s » |
| HD-779-MA · 04/08 22:32 | `030s` | « cible de 20 s » |
| EY-613-MF · 03/08 11:20 | `005m` (300 s) | « cible de 20 s » |

### Famille — **mensonger**

Au sens du §7 de la procédure : le message affirme un fait faux et envoie enquêter au mauvais
endroit. C'est la famille la plus grave, et c'est la même que celle du `outcomeReason` que
TRK-007 dénonçait déjà — le champ dont le nom annonce un résultat et le contenu livre autre chose.

### Ce que ça coûte, au-delà du message

Ces clôtures alimentent `commandes_sante_7j`, **le compteur qui sert à juger [TRK-012](#trk-012)
et à mesurer si un correctif porte**. Un indicateur qui compte des succès parmi ses échecs ne peut
pas servir de preuve. Le volume est faible aujourd'hui (3 sur 502), mais il croît avec le nombre
de commandes soldées — c'est-à-dire avec l'efficacité du correctif de TRK-007.

### Correctif proposé

Charger `params` dans le `select`, comparer, puis conclure :

1. si `currentFixIntervalS` tombe dans la bande de tolérance de l'intervalle **demandé par la
   commande** (la même bande ±20 % que `reconcile`), clore en `ACKNOWLEDGED` avec
   `observedResult` = « cible atteinte : cadence réelle X s — sans accusé de réception du
   boîtier » ;
2. sinon, garder `FAILED` **et citer l'intervalle demandé par la commande**, jamais la cible
   courante du boîtier.

### ⚠️ Ne pas allonger l'échéance à la place

Le délai n'est pas le sujet. L'échéance doit rester **purement temporelle** — c'est la leçon
durement acquise de TRK-007 : la conditionner à un état du boîtier la ferait retomber dans le
piège des deux gardes justes qui, composées, laissent une commande ouverte à vie. Ce qui manque
est la **comparaison**, pas la patience.

### Vérification après correctif

Plus aucune clôture n'annonce une cadence réelle égale à l'intervalle demandé tout en portant
`FAILED` — **et** les vraies non-conformités continuent de sortir en `FAILED` (EY-613-MF à
3600 s pour une cible de 300 s doit rester un échec). Le second point est le vrai test : un
correctif qui ferait disparaître les deux aurait supprimé le balayage, pas le défaut.

### Mise à jour du 2026-08-07 — dénominateur en hausse, numérateur stable

**19 clôtures par échéance** (17 la veille). Toujours **3 fausses** et **4 cibles mal citées** —
les deux nouvelles clôtures sont correctes :

| Commande | Demandé | Réel | Message | Verdict |
|---|---|---|---|---|
| `…6763` · 06/08 21:52 | `020s` | 4406 s | « cadence réelle 4406s pour une cible de 20s » | ✅ juste |
| `…7480` · 06/08 12:29 | `005m` | 6 s | « cadence réelle 6s pour une cible de 300s » | ✅ juste |

Deux clôtures justes ne prouvent rien : elles tombent du bon côté par construction (la cible du
boîtier au moment du balayage coïncidait avec celle de la commande). **Le défaut de code est
intact** — il n'y a toujours aucune comparaison, et `params` n'est toujours pas chargé.

### Mise à jour du 2026-08-08 — les deux compteurs montent

**24 clôtures par échéance** (19 la veille). **4 fausses** (+1) et **5 cibles mal citées** (+1).
Les deux nouveaux cas sont sur FS-253-HR le 07/08, à cinq minutes d'intervalle :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| FS-253-HR · 07/08 11:44 | `020s` | 21 s | « cadence réelle 21s pour une cible de 20s » | ❌ **fausse** — 21 s est dans la bande ±20 % de 20 s, donc la cible **est atteinte** |
| FS-253-HR · 07/08 11:39 | `030s` | 17 s | « cadence réelle 17s pour une cible de 20s » | ⚠️ **mal citée** — la commande demandait 30 s |
| FZ-731-YF · 07/08 22:43 | `005m` | 20 s | « cadence réelle 20s pour une cible de 300s » | ✅ juste |
| EY-613-MF · 07/08 02:20 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 07/08 01:20 | `020s` | 7198 s | « … pour une cible de 20s » | ✅ juste |

⚠️ **Précision de critère.** Les trois fausses clôtures des 04 et 05/08 affichaient une égalité
**stricte** (20 s pour 20 s). Celle du 07/08 est à 21 s pour 20 s : elle n'est fausse qu'au sens de
la **bande de tolérance ±20 %** — la même que celle dont `reconcile()` se sert pour juger. C'est
bien le critère du correctif proposé ci-dessus, et c'est celui qu'il faut retenir : comptée à
l'égalité stricte, cette clôture passerait pour juste alors que le boîtier honore sa consigne.

### Mise à jour du 2026-08-09 — les deux compteurs montent encore, sur le même véhicule

**28 clôtures par échéance** (24 la veille). **5 fausses** (+1) et **6 cibles mal citées** (+1).
Les deux nouveaux cas sont sur FS-253-HR le 08/08, à cinq minutes d'intervalle — **exactement la
même paire, sur le même véhicule, que le 07/08** :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| FS-253-HR · 08/08 12:11 | `020s` | 20 s | « cadence réelle 20s pour une cible de 20s » | ❌ **fausse** — égalité stricte |
| FS-253-HR · 08/08 12:06 | `030s` | 20 s | « cadence réelle 20s pour une cible de 20s » | ⚠️ **mal citée** — la commande demandait 30 s |
| FZ-731-YF · 08/08 23:17 | `005m` | 3602 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 08/08 02:20 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |

La récurrence de la paire n'est pas un hasard : deux commandes émises à quelques minutes d'écart
sur le même boîtier sont closes par le même balayage, et la seconde hérite d'une cible courante
réécrite entre-temps. **C'est le scénario que le correctif doit couvrir en priorité** — charger
`params` suffit à traiter les deux cas d'un coup.

⚠️ **Le taux ne baisse pas.** 11 clôtures défectueuses sur 28 (39 %) contre 9 sur 24 (37,5 %) la
veille. Le défaut de code est intact ; seul le dénominateur grandit, avec l'efficacité du balayage.

### Mise à jour du 2026-08-10 — trois clôtures de plus, toutes justes

**31 clôtures par échéance** (28 la veille). Les trois nouvelles, toutes du 09/08, sont **correctes** :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| FZ-731-YF · 09/08 23:29 | `005m` | 3602 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 09/08 06:25 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 09/08 02:20 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |

Le décompte défectueux reste donc **5 fausses + 6 cibles mal citées**, soit 11 sur 31 (35,5 %)
contre 11 sur 28 (39 %) la veille.

⚠️ **Ce recul du taux n'est pas une amélioration.** Le numérateur n'a pas bougé ; seul le
dénominateur a grandi. Et ces trois clôtures tombent du bon côté **par construction** — la cible
courante du boîtier coïncidait avec celle de la commande — exactement comme les deux du 07/08.
`params` n'est toujours pas chargé dans le `select` : le défaut de code est intact, et il
reproduira la paire FS-253-HR dès que deux commandes rapprochées seront closes par le même balayage.

### Mise à jour du 2026-08-11 — deux clôtures de plus, toutes deux justes

**33 clôtures par échéance** (31 la veille) :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| EY-613-MF · 10/08 02:21 | `020s` | 110 s | « cadence réelle 110s pour une cible de 20s » | ✅ juste |
| FZ-731-YF · 10/08 23:41 | `005m` | 3602 s | « … pour une cible de 300s » | ✅ juste |

Décompte défectueux **inchangé** : **5 fausses + 6 cibles mal citées = 11 sur 33 (33,3 %)**, contre
11 sur 31 (35,5 %) la veille. Troisième passage consécutif où le numérateur ne bouge pas et où seul
le dénominateur grandit — **le taux baisse sans que rien ne s'améliore.** C'est précisément pourquoi
la fiche compte les deux défauts en valeur absolue et non en pourcentage : un ratio qui décroît par
dilution raconte le contraire de ce qui se passe.

`params` n'est toujours pas chargé dans le `select` (vérifié : les deux nouvelles clôtures citent
juste parce que la cible courante coïncidait, comme les cinq précédentes). Le défaut de code est
intact.

### Mise à jour du 2026-08-13 — les quatre numérateurs sont figés, et le taux baisse encore

**40 clôtures** par échéance (38 la veille). Les deux nouvelles sont **justes** :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| HD-779-MA · 12/08 18:50 | `030s` | 20 s | « cadence réelle 20s pour une cible de 30s » | ✅ juste — et la cible est **bien citée** |
| FZ-731-YF · 13/08 00:06 | `005m` | 3601 s | « … pour une cible de 300s » | ✅ juste |

**Les quatre compteurs, sur trois définitions, sur trois passages :**

| Compteur | Définition | 11/08 | 12/08 | **13/08** |
|---|---|---|---|---|
| Message auto-contradictoire | le texte dit « réelle X s pour une cible de X s » | 7 | 7 | **7** |
| Réel dans la bande de la cible **annoncée** | ±20 % | 10 | 10 | **10** |
| **Fausses** — bande ±20 % de l'intervalle **demandé** *(le critère du correctif)* | | 5 | 5 | **5** |
| **Cibles mal citées** — annoncée ≠ `params.interval` | | 6 | 6 | **6** |
| Dénominateur | clôtures par échéance | 33 | 38 | **40** |

**Aucun numérateur ne bouge ; seul le dénominateur grandit.** Le taux « défectueuses » (fausses +
mal citées) tombe de 33,3 % à **27,5 %** sans qu'une ligne de code ait changé — quatrième passage
consécutif où la dilution raconte le contraire de ce qui se passe. `params` n'est toujours pas
chargé dans le `select`.

⚠️ **Trois définitions coexistent dans cette fiche, et il faut les garder toutes les trois.** La
première se lit sur le message seul (7), la deuxième juge sur la cible annoncée (10), la troisième
sur l'intervalle réellement demandé (5 + 6). Seule la troisième mesure le défaut ; les deux autres
sont ce qu'un lecteur pressé compterait. *Publier un seul chiffre sans dire lequel, c'est
fabriquer une divergence entre deux passages qui mesuraient la même chose.*


### 🔴 2026-08-16 — le test daté se DÉCLENCHE : le seuil de 9 est franchi, et largement

Le test posé le 15/08 : *« si le compte atteint 9, le numérateur repart réellement et l'argument
*figé* est mort »*. **Il atteint 11.**

| | 12/08 → 14/08 | 15/08 | **16/08** |
|---|---|---|---|
| Clôtures « sans effet » (dénominateur) | 38 → 45 | 49 | **54** |
| Clôtures **strictement fausses** (cadence réelle = cible) | **7** (figé 3 passages) | 8 | **11** |

Détail des clôtures où la cadence observée **égale exactement** la cible demandée :

| Message | Occurrences |
|---|---|
| « après 36 min : cadence réelle 20 s pour une cible de 20 s » | 3 |
| « après 37 min … 20 s pour 20 s » | 2 |
| « après 40 min … 20 s pour 20 s » | 2 |
| « après 31 / 34 / 35 / 49 min … 20 s pour 20 s » | 1 chacune |

Série sur cinq passages : **7 · 7 · 7 · 8 · 11**.

> **L'argument qui protégeait cette fiche est mort, et il vaut de dire lequel.** Depuis le 06/08 on
> lisait « seul le dénominateur grandit » : les clôtures fausses étaient un stock hérité, le
> balayage n'en fabriquait plus. C'était vrai sur trois passages, et c'est la raison pour laquelle
> la fiche est restée en gravité 3. Trois points identiques avaient été pris pour une stabilité ;
> ils n'étaient qu'un palier. *Un numérateur figé pendant trois mesures ne prouve pas qu'il est
> figé — il prouve qu'on n'a pas encore vu ce qui le fait bouger.* Le compteur ainsi gonflé est
> celui qui sert à juger les autres fiches de la famille « commandes ».

---

## TRK-014

**Signature** — *(absence de réponse, pas une ligne d'erreur)* `tracker_commands | ackedAt IS NULL |
100 % des commandes, tous templates, depuis l'origine`
**Statut : 🔴 NON CORRIGÉ** · **3797 commandes · 0 accusé de réception · depuis 2026-04-27** ·
découvert 2026-08-07

> ### La chaîne de commande n'a jamais reçu une seule réponse. Personne ne s'en est aperçu parce
> ### que personne n'écoutait.

### Constat 1 — le chemin adaptatif n'arme jamais l'écoute

`tracker-fix-mode.service.ts:647-659` écrit `SENT`, journalise la trame sortante, met à jour la
cible du boîtier, et s'arrête là. Il n'appelle **jamais** `ackWaiter.waitForAck`.

Le chemin générique, lui, le fait (`tracker-commands.service.ts:239-241`) :

```ts
const template = findTemplate(command.templateId);
if (template && template.expectedAckPattern) {
  this.ackWaiter.waitForAck(resolvedImei, template.expectedAckPattern, template.ackTimeoutMs, command.id)
    .then(/* → ACKNOWLEDGED, ackedAt, ackResponse */)
    .catch(/* → FAILED, lastError = "ACK timeout: …" */);
}
```

Preuve en base que ce chemin n'est jamais emprunté pour la cadence : sur 3797 commandes,
**4 seulement** portent un `lastError` de type `ACK timeout`, toutes datées du **2026-05-24** —
les essais manuels de `sensitivity` / `shock_on`. Les 3788 `fix_continuous` n'en portent aucun.

| Colonne | Valeur sur les 3797 commandes |
|---|---|
| `ackedAt` | **NULL — sans exception** |
| `ackResponse` | **NULL — sans exception** |
| `status` | `FAILED` — **100 %**, tous templates confondus |

Les **30** commandes portant un `acknowledgedAt` sont des **acquittements manuels d'administrateur**
(`admin-alerts.controller.ts`), la dernière le 2026-07-08. Aucune ne vient d'un boîtier.

### Constat 2 — et il n'y aurait rien à entendre

Le journal de trames est actif en production (`WIRE_LOG_ENABLED=true`, rétention 3 jours). Sur la
fenêtre disponible (03/08 03:00 → 07/08 01:15 UTC) :

| Sens | Contenu | Trames | Boîtiers |
|---|---|---|---|
| OUT | `fix005m***n123456` | **244** | 35 |
| OUT | `fix020s***n123456` | **21** | 9 |
| OUT | `fix030s***n123456` | **10** | 5 |
| IN | position · heartbeat · no_fix · login | 690 728 | 37 |
| IN | classées `ack` | 281 | 32 |
| IN | contenant « ok », « fix », « error » ou « password » | **0** | — |

Dans les 60 s qui suivent chaque `fix…`, il ne revient que du trafic ordinaire.

⚠️ **Les 281 trames classées `ack` ne sont pas des accusés de réception.** Ce sont des rapports de
minuterie Coban — `imei:…,jt,260806180001,100%,F,…` et `…,kt,…`, à 18:00 et 03:00 chaque jour —
que le motif générique `/imei:\d{15},/i` d'un autre template attrape au passage. Elles ne
répondent à aucune commande. *Un compteur d'ACK non nul peut ne contenir aucun ACK.*

### Ce que ça change — et ce que ça ne change pas

**Ça ne rend aucune fiche caduque.** [TRK-012](#trk-012) reste exact : la cadence de 300 s n'est
pas appliquée, c'est mesuré sur les trames reçues, pas sur les ACK.

**Ça change ce qu'on peut conclure.** Le diagnostic de TRK-012 repose entièrement sur
l'observation de l'intervalle des trames. Trois causes restent indistinguables :

1. la commande n'arrive pas (canal descendant) ;
2. elle arrive et est **rejetée en silence** (mot de passe — le payload finit par `***n123456`,
   le mot de passe Coban par défaut) ;
3. elle arrive, est acceptée, et le firmware ne l'applique pas.

Un `fix ok` ou un message d'erreur trancherait entre elles en 15 s. L'information circule
peut-être déjà sur le fil ; rien ne la lit.

### Une piste tentante, et pourquoi elle ne tient pas

Le catalogue n'offre que `010s`, `030s`, `060s`, `002m`, `005m`, `010m`
(`coban.catalog.ts:162-173`) — **`020s` n'y figure pas**, et l'automate adaptatif en envoie quand
même (21 trames en 4 jours), parce qu'il construit son intervalle sans passer par la liste.

Tentant d'y voir la cause. **Faux pour l'essentiel du volume :** `005m` *est* dans la liste, il est
valide, et il échoue **435 fois sur 7 jours**. La valeur d'intervalle n'explique pas TRK-012.
Anomalie de cohérence à corriger, pas cause racine. *(Le contre-exemple tient en une ligne : le
chercher avant d'écrire la fiche, pas après.)*

### Correctifs proposés

1. **Armer l'écoute sur le chemin adaptatif.** Appeler `ackWaiter.waitForAck` après l'envoi, comme
   le chemin générique. Le motif (`/fix.*ok/i`) et le délai (15 s) existent déjà dans le
   catalogue ; `tcp-server.service.ts:296,341` offre déjà chaque trame entrante au guetteur. Il ne
   manque que l'inscription du guetteur.
2. **Distinguer « sans réponse » de « en échec ».** Une commande à laquelle le boîtier n'a rien
   répondu n'est pas dans le même état qu'une commande explicitement rejetée. Aujourd'hui les deux
   s'écrivent `FAILED` — même famille de défaut que [TRK-013](#trk-013).
3. **Aligner le catalogue sur ce que l'automate émet** (ajouter `020s`, ou faire passer l'automate
   par la liste d'options). Faible priorité.

### ⚠️ Ne pas reconditionner la clôture des commandes à cet ACK

C'est la leçon durement acquise de [TRK-007](#trk-007) : un boîtier muet laisserait de nouveau des
commandes ouvertes à vie, et le centre d'alerte redeviendrait une file qui ne se vide pas.
L'échéance temporelle reste la fin de vie de la commande. **L'ACK ajoute une information quand elle
existe — il ne décide de rien.**

### Vérification après correctif

Au moins une commande porte un `ackResponse` non nul, **ou** le journal montre des
`ACK_TIMEOUT pattern=fix.*ok` réguliers. Les deux résultats sont utiles, et le second l'est
autant que le premier : il prouverait que l'écoute fonctionne et que le silence du boîtier est
réel — ce qu'on ne sait pas prouver aujourd'hui, faute d'écouter.

⚠️ Un correctif qui ferait seulement disparaître des lignes `FAILED` sans jamais produire ni ACK
ni timeout tracé n'aurait rien mesuré.

### Mise à jour du 2026-08-08 — inchangé, sur un dénominateur plus grand

**3871 commandes** émises depuis le 27/04 (+74 depuis la veille), **`ackedAt` NULL et
`ackResponse` NULL sans exception**, toujours 30 acquittements manuels d'administrateur et aucun
venant d'un boîtier. Rien n'a été armé, rien n'a répondu.

### Mise à jour du 2026-08-09 — inchangé, troisième jour

**3943 commandes** émises depuis le 27/04 (+72), `ackedAt` **NULL** et `ackResponse` **NULL** sans
exception, 30 acquittements manuels et aucun venant d'un boîtier. Trois passages, trois fois le
même zéro sur un dénominateur qui grossit de ~72 par jour.

### ✅ 2026-08-10 20:03 UTC — CORRECTIF #1 DÉPLOYÉ : l'écoute est armée

`tracker-fix-mode.service` inscrit désormais un guetteur d'ACK après chaque envoi TCP réussi
(`main` @ `73440d8`, `restarts=0`, API `healthy`). Le motif `/fix.*ok/i` et le délai de 15 s
venaient déjà du catalogue ; il ne manquait que l'inscription.

⚠️ **L'ACK informe, il ne décide de rien.** Le `status` de la commande n'est jamais modifié —
ni `ACKNOWLEDGED` sur réponse, ni `FAILED` sur silence. L'échéance PUREMENT TEMPORELLE reste la
seule fin de vie d'une commande ([TRK-007](#trk-007)). Un test verrouille ce point sur les deux
scénarios : c'est le garde-fou contre la récidive la plus probable.

Le silence, lui, est désormais **tracé** : au journal de trames, et dans `diagnosticHint` — qui
est durable et visible à l'écran des commandes.

### 🗓️ Test daté — au passage du 2026-08-11

Aucune commande n'est partie entre le déploiement (20:03) et 20:15 : les véhicules sont à
l'arrêt le soir et les transitions d'état se raréfient. La mesure se fera sur la nuit.

```sql
SELECT count(*) FILTER (WHERE "ackResponse" IS NOT NULL) AS avec_ack,
       count(*) FILTER (WHERE "diagnosticHint" LIKE 'Aucune réponse%') AS silences_traces,
       count(*) AS total
FROM tracker_commands WHERE "createdAt" > timestamp '2026-08-10 20:03:00';
```

| Résultat | Conclusion — et ce qu'il débloque pour [TRK-012](#trk-012) |
|---|---|
| `avec_ack > 0` | Le boîtier **reçoit et accepte** la consigne. La cause de TRK-012 est donc le **firmware qui ne l'applique pas** — l'hypothèse « mot de passe » tombe, et le correctif #1 de TRK-012 (cesser de réémettre) devient le bon. |
| `avec_ack = 0` **et** `silences_traces > 0` | Le boîtier **ne répond jamais**, ce qui est maintenant PROUVÉ et non plus supposé. Restent « non reçue » et « rejetée en silence (mot de passe) » → le test SMS sur un boîtier devient la seule façon de trancher. |
| `total = 0` | Aucune commande n'est partie : rien n'est mesuré. **Ne rien conclure** — et surtout ne pas lire ce zéro comme un silence du boîtier. |

⚠️ **Le troisième cas est le piège.** Un compteur à zéro parce que rien n'a été émis ressemble
exactement à un compteur à zéro parce que rien n'a répondu. Toujours lire `total` d'abord.

### 🔓 2026-08-11 — VERDICT DU TEST DATÉ : le silence du boîtier est PROUVÉ

Fenêtre 10/08 20:03 → 11/08 01:11 UTC, cinq heures :

```
avec_ack = 0   ·   silences_traces = 14   ·   total = 14
```

`total = 14` : le piège du troisième cas est écarté d'emblée — **des commandes sont bien parties**.
Les quatorze portent le même `diagnosticHint` : *« Aucune réponse du boîtier en 15 s (motif
attendu : fix.*ok). Le canal descendant est ouvert… »*. Quatorze `fix005m`, quatorze attentes
arrivées à échéance, **zéro réponse**.

C'est la **deuxième ligne** de la table de décision ci-dessus. Ce qu'elle établit :

- le boîtier **ne répond jamais** — désormais *prouvé*, plus supposé. L'écoute fonctionne, et son
  silence est un fait mesuré ;
- pour [TRK-012](#trk-012), l'hypothèse « le firmware accepte mais n'applique pas » n'est **pas**
  confirmée. Restent « la commande n'arrive pas » et « elle est rejetée en silence (mot de passe) » ;
- **le test SMS sur un boîtier redevient le seul discriminant**, exactement comme la fiche l'avait
  posé — et le correctif #1 de TRK-012 reste **suspendu** en attendant.

### ✅ La garde « l'ACK ne décide de rien » a tenu

C'était le point où la récidive était la plus probable. Les 14 commandes sont `FAILED`, mais
**aucune ne l'est par le chemin de l'ACK** :

| Chemin d'écriture du statut | Commandes |
|---|---|
| Réconciliation (« Tracker FAILING — 3 trames non conformes ») | 13 |
| Échéance temporelle (« Sans effet constaté après 39 min ») | 1 |
| **Guetteur d'ACK** | **0** |

Le `status` n'a pas bougé d'un cran à cause d'une absence de réponse. L'ACK informe
(`diagnosticHint`), l'échéance décide. *La leçon de [TRK-007](#trk-007) est appliquée, et vérifiée
en production sur des données réelles — pas seulement par le test unitaire qui la verrouille.*

**Ce qui reste ouvert :** les correctifs #2 (distinguer « sans réponse » de « en échec ») et #3
(aligner le catalogue sur `020s`). La fiche reste 🔴.

### Mise à jour du 2026-08-11 — cumul

**4087 commandes** émises depuis le 27/04 (+72), `ackedAt` **NULL** et `ackResponse` **NULL** sans
exception, 30 acquittements manuels d'administrateur. Le zéro d'`ackResponse` n'a plus le même sens
qu'hier : il est maintenant **accompagné de 14 silences tracés**, ce qui le transforme d'ignorance
en constat.

### 🎯 2026-08-11 (2ᵉ passage, 09:22 UTC) — le silence est confirmé sur 3,4× plus de données, et il a une CAUSE

Fenêtre élargie 10/08 20:03 → 11/08 09:22 (13 h au lieu de 5) :

```
avec_ack = 0   ·   silences_traces = 47   ·   total = 47
```

`total = 47` — le piège du troisième cas reste écarté. Les 47 sont des `fix005m` sur **25 boîtiers**,
toutes porteuses du même `diagnosticHint`. La deuxième ligne de la table de décision est donc
**confirmée sur un dénominateur 3,4 fois plus grand**, et la garde tient toujours : **0** commande
close par le chemin de l'ACK (0 `lastError`, 0 `outcomeReason` mentionnant un ACK).

**Et la cause du silence est maintenant connue** — voir [TRK-012](#trk-012) : le payload
`fix005m***n123456` est la forme **SMS** de la commande, émise sur la socket **TCP**, qui attend
`**,imei:<IMEI>,C,05m;`. Le boîtier ne répond pas parce qu'il ne peut pas lire la trame. *Le
guetteur d'ACK écoutait la bonne socket au bon moment — il attendait la réponse d'une question
jamais posée dans la langue du destinataire.*

> Ce que le correctif #1 de cette fiche a réellement produit n'est donc pas « la preuve que le
> boîtier est muet » : c'est **l'écart mesurable** entre deux familles de commandes, qui a désigné
> la cause. Un instrument vaut moins par le chiffre qu'il affiche que par la comparaison qu'il rend
> possible.

### ⚠️ Rectification du Constat 2 — les trames `jt` / `kt` SONT des accusés de réception

La fiche affirmait, le 07/08 : *« Les 281 trames classées `ack` ne sont pas des accusés de
réception. Ce sont des rapports de minuterie Coban […] qui ne répondent à aucune commande. »*
**C'est faux, et la mesure le montre.**

Sur les 33 trames `IN`/`ack` de la fenêtre de 13 h :

| Vérification | Résultat |
|---|---|
| Corrélées à une trame `OUT` du même IMEI dans les 15 s | **33 / 33** |
| Latence moyenne | **2,60 s** (`kt`) · **1,67 s** (`jt`) |
| Lettre de la réponse vs lettre de la commande | `K;` → `kt`, `J;` → `jt` — **écho exact** |

Ce sont les réponses des commandes moteur d'[TRK-018](#trk-018). L'horaire « 18:00 et 03:00 chaque
jour », lu à l'époque comme la signature d'une minuterie, est en réalité **l'horaire des coupures
et restaurations programmées**. La coïncidence de dates avait été prise pour un mécanisme — le
piège que [TRK-018](#trk-018) nomme lui-même trois semaines plus tard.

> La leçon écrite alors — *« un compteur d'ACK non nul peut ne contenir aucun ACK »* — reste vraie
> en général, et **elle était fausse ici**. Sa réciproque mérite d'être écrite à côté : *un
> compteur qu'on a disqualifié une fois ne se re-vérifie plus jamais.* Ces 281 trames étaient la
> preuve, disponible dès le 07/08, que le canal descendant fonctionnait parfaitement.

Cela **ne change pas** le diagnostic du correctif #1 : `fix.*ok` n'est jamais revenu, et les
47 silences sont réels. Cela change **ce qu'on croyait savoir du canal** : il n'a jamais été muet.

### 🔴 Mise à jour du 2026-08-13 — l'instrument est désarmé, et c'est MESURÉ

Hier, le désarmement se déduisait d'un marqueur absent du binaire. Aujourd'hui il se lit dans la
base :

| Mesure | Valeur |
|---|---|
| Commandes émises depuis le redéploiement (11/08 22:37) | **77** |
| …portant un `diagnosticHint` « Aucune réponse du boîtier… » | **0** |
| Compteur cumulé de silences tracés | **81** — figé au total du 11/08 |
| `ackedAt` / `ackResponse` | **0 sur 4231** |

Avant le redéploiement, **chaque** commande produisait un silence tracé (14 en 5 h, puis 47 en
13 h). Soixante-dix-sept commandes de suite sans une seule trace ne peuvent pas être un boîtier
plus bavard : c'est le guetteur qui n'est plus inscrit.

> **Le zéro d'`ackedAt` a donc changé de nature une seconde fois.** Il est passé d'ignorance
> (avant le 10/08) à constat (10-11/08), et il revient à l'ignorance. *Un instrument retiré ne
> laisse pas de trou visible dans la série — il laisse un zéro qui ressemble exactement au
> précédent.* Voir [TRK-019](#trk-019).

⚠️ **Ne pas comparer ce zéro aux précédents** dans un futur passage sans rappeler cette date de
rupture.

### 🔗 Mise à jour du 2026-08-13 — le chemin GÉNÉRIQUE, lui, écoute toujours

Deux commandes manuelles du 12/08 (`sensitivity`, `shock_on`) portent un
`lastError = "ACK timeout: ACK timeout after 15000ms"`. Le guetteur du chemin **générique** est
donc bien armé et fonctionne — ce qui a été désarmé est l'inscription posée le 10/08 sur le chemin
**adaptatif** (`tracker-fix-mode`). Les deux chemins sont distincts, et un seul est touché.

Ces deux commandes portent le décompte d'`ACK timeout` de **4 à 6**, toujours **6 sur 6 sur des
templates SMS-only** envoyés en TCP — voir [TRK-021](#trk-021), qui explique pourquoi aucune ne
pouvait aboutir.

### Mise à jour du 2026-08-10 — inchangé, quatrième jour

**4015 commandes** émises depuis le 27/04 (+72), `ackedAt` **NULL** et `ackResponse` **NULL** sans
exception, 30 acquittements manuels et aucun venant d'un boîtier.

⚠️ **Et le second canal vient de se révéler muet lui aussi.** [TRK-017](#trk-017) établit que
24 des 43 SIM du parc étaient hors de l'allowlist de la passerelle : leur repli SMS échouait en
`403`, sans trace. Sur ces boîtiers, **aucune** des deux voies de commande ne pouvait confirmer quoi
que ce soit — le TCP parce que personne n'écoute (cette fiche), le SMS parce que la passerelle
refusait. Le correctif #1 (armer `waitForAck`) devient plus urgent : c'est la seule des deux voies
dont la remise en service ne dépend pas d'un tiers.

---

## TRK-015

**Signature** — `positions | SKIPPED_REPLAY | garde-fou ingestion (stale_devicetime) : deviceTime
<DATE> vs dernier <DATE>` — **en volume, et sans aucune alerte**
**Statut : 🟢 CORRIGÉ ET DÉPLOYÉ le 2026-08-24** (PR #124) · découvert 2026-08-08 ·
**re-mesuré le 24/08 : 10 015 trames écartées / 4 j, dont 5 908 trous réels** *(3 466 au 08/08 —
la perte avait AUGMENTÉ, conséquence directe de [TRK-045](#trk-045) qui a triplé le débit)*

> ### Le garde-fou qui empêche la téléportation efface aussi des positions que la base n'a nulle part ailleurs.

---

## 🟢 2026-08-24 — CORRIGÉ ET DÉPLOYÉ (PR #124)

### La mesure refaite le jour du correctif — la perte avait grossi

| Classe de rejet | Trames | Jumeau *(rejet correct)* | **Sans jumeau = TROU** |
|---|---|---|---|
| Doublon exact (0 s) | 1 302 | **1 287 (99 %)** | 15 |
| Retour arrière ≤ 60 s | 851 | 422 | **429** |
| Retour arrière 1-60 min | 7 861 | 2 397 | **5 464** |
| **Total / 4 j** | **10 015** | 4 106 | **5 908** |

**5 908 contre 3 466 au 08/08.** Conséquence directe de [TRK-045](#trk-045) : le débit triplé a
multiplié les trames, donc les rejeux de tampon. *Un défaut non corrigé en aggrave un autre.*

Et le discriminant annoncé par la fiche se vérifie **des deux côtés** : 99 % des doublons exacts
ont leur jumeau — le garde-fou avait raison ; la majorité des retours en arrière n'en a aucun —
il avait tort.

### Le correctif — une phrase

> **Persister n'est pas faire autorité.** Le code prenait ces deux décisions en une seule.

Avant de rejeter sur `stale_devicetime`, chercher une position à cet horodatage **exact**.
Jumeau → fantôme, comportement d'avant strictement inchangé. Aucun jumeau → écrire la ligne
`positions`, **et rien d'autre** : ni dénormalisation (`lastLat` / `lastPositionAt` /
`lastValidFrameAt`), ni ignition, ni trip en direct, ni diffusion temps réel. Les trajets
récupèrent l'historique au recalcul du segmenteur, qui relit `positions` dans l'ordre.

Nouvelle décision d'audit **`RECOVERED_BUFFER`**, distincte de `SKIPPED_REPLAY` — sans elle, on
ne pourrait plus mesurer ce qu'on récupère **ni** ce qu'on continue d'écarter.

⚠️ **Horodatage exact, jamais une fenêtre.** Le ± 60 s sert à MESURER (il sur-compte les jumeaux,
donc 5 908 est un **plancher**). Le retenir comme test rejetterait des trames tamponnées
légitimes : à 5 s de cadence, 60 s en couvre douze.

⚠️ **Seul `stale_devicetime` est récupérable.** Un saut infaisable n'est pas un retard.

### 🔑 Le troisième piège de test de la journée

Le harnais du bloc « garde-fou replay » n'avait **aucun** mock `position`. La récupération levait
donc sur `prisma.position` undefined, son `catch` avalait l'erreur, et les **27 tests restaient
verts en décrivant une récupération qui ne tournait pas**.

**Vérifié par mutation**, et le résultat a corrigé le correctif : en neutralisant la récupération,
**un seul** test cassait — les quatre autres étaient des garde-fous, pas des preuves. Le test de
la baseline a donc reçu une assertion « la récupération a bien eu lieu » : sans elle il était vert
pour la mauvaise raison, *puisqu'un correctif désactivé ne touche pas non plus la baseline*.
Après correction : 2 tests cassent sous mutation.

### ⚠️ Le profil a changé le jour même du correctif

Mesuré à 11:47, juste avant le déploiement : **57 trames écartées sur l'heure, dont seulement
3 trous**. TRK-045 corrigé, les boîtiers sont passés de 5 s à 20-99 s — donc beaucoup moins de
trames et beaucoup moins de rejeux. *L'effet immédiat de ce correctif sera donc modeste ; sa
valeur est dans les RAFALES* (1 643 trames en un bloc le 08/08, 15,7 km perdus d'un coup).

**Ne pas conclure de chiffres bas que le correctif ne sert à rien** : il sert précisément les
jours de coupure 2G, qui sont rares et coûteux.

### ✅ Test prescrit — RÉPONDU 15 minutes après le déploiement (12:08 UTC)

La fiche exigeait deux conditions **simultanées**, précisément pour distinguer un garde-fou
*réparé* d'un garde-fou *supprimé* :

| Ce qui était prescrit | Mesuré |
|---|---|
| Les rejets **sans jumeau** tombent vers 0 | **0** ✅ |
| Les rejets **avec jumeau** se maintiennent | **109** `SKIPPED_REPLAY` ✅ |
| *(nouveau)* positions récupérées | **69** `RECOVERED_BUFFER` |

**Les deux conditions sont remplies.** Si `SKIPPED_REPLAY` était tombé à zéro lui aussi, le
garde-fou aurait été supprimé et non réparé — c'est ce que la double condition protège.

Répartition des 69 récupérations, pour savoir *ce qu'on récupère vraiment* :

| Classe | Trames |
|---|---|
| Vrai rattrapage de tampon (retour > 60 s) | **45** |
| Retour ≤ 60 s | 24 |
| Horodatage **identique** à la baseline | **1** |

⚠️ **La réserve, petite mais réelle : le cas « horodatage identique » contourne
l'échantillonnage adaptatif.** Une trame acceptée comme autoritaire mais NON persistée (jetée
par le throttle) ne laisse aucune ligne ; la trame suivante au même horodatage ne trouve donc
aucun jumeau et se fait récupérer — on réécrit ce que le sampler avait décidé d'omettre.
Mesuré à **1 sur 69 (1,4 %)**, et le volume de `positions` ne s'emballe pas (~1 130/h après,
contre 1 452/h avant). *Consigné pour ne pas le redécouvrir : si cette part monte, c'est ici
qu'il faudra regarder, et le remède serait de ne récupérer qu'au-delà d'un écart non nul.*

### Constat

`evaluateIngestionFix` refuse toute trame dont l'horodatage boîtier n'est pas **strictement**
postérieur au dernier horodatage valide. Sur 4 jours de `position_sampling_decisions` :
**8360 rejets**, soit 1,4 % du flux, sur **les 37 boîtiers du parc**. `stale_devicetime` en produit
**8356** ; `implausible_jump`, 4.

Le volume n'est pas le sujet. Le sujet est que la **même** règle produit deux résultats opposés,
et que la donnée permet de les séparer — en vérifiant si une ligne `positions` existe déjà pour ce
boîtier à cet horodatage :

| Classe de rejet | Trames | Jumeau en base *(fantôme → rejet correct)* | Aucune position à ± 60 s *(**trou**)* |
|---|---|---|---|
| Doublon exact (Δt = 0 s) | 1695 | **1650** | 9 |
| Retour arrière ≤ 60 s | 273 | 1 | **103** |
| **Retour arrière 1-60 min** | **6388** | 2186 | **3354** |
| **Total** | **8356** | **3837** | **3466** |

Le doublon exact est traité correctement : 97 % des trames ont leur jumeau en base, rien n'est
perdu. La classe « retour arrière 1-60 min », elle, contient **les deux à la fois** — un tiers de
fantômes prouvés, la moitié de trous prouvés.

### Ce qui est perdu n'est pas cosmétique

Les 6388 trames de cette classe sont en moyenne à **3688 m** de la dernière position connue
(maximum **47 km**) ; **4017** sont au-delà de 100 m et **3054** portent une vitesse rapportée
> 5 km/h — un véhicule **en mouvement**.

| Boîtier | Trous / 4 j | Distance moyenne | Maximum | Part de ses trames rejetées |
|---|---|---|---|---|
| EP-047-TY | 267 | 3061 m | 16,2 km | **22,3 %** |
| FG-669-DQ | 200 | 4641 m | 22,6 km | 17,4 % |
| HD-584-BF | 295 | 212 m | 4,7 km | 14,3 % |
| AL-927-QM | 227 | 529 m | 7,9 km | 9,3 % |
| DZ-034-CA | 296 | 44 m | 122 m | 20,0 % |

Sur DZ-034-CA ou GS-138-LT (4 m de moyenne) le trou est sans conséquence. Sur EP-047-TY et
FG-669-DQ, ce sont des segments de trajet entiers qui manquent — donc des kilomètres absents des
rapports de distance.

### Cause racine — un critère protège explicitement contre la perte, l'autre pas

`packages/shared/src/utils/gps-sanity.ts` applique trois critères. Le commentaire du **critère 2**
(saut infaisable) est sans ambiguïté sur l'intention :

> « On utilise le `dt` PLEIN (non borne) : un grand `dt` legitime (rattrapage post-coupure GPRS,
> vehicule deplace hors-ligne) tolere une grande distance — on ne rejette que l'infaisable, **pour
> ne jamais PERDRE une position reelle**. »

Le **critère 1** n'a aucune nuance équivalente :

```ts
const dtSec = (nextMs - prevMs) / 1000;
// 1. deviceTime non strictement croissant → trame rejouee depuis le buffer.
if (dtSec <= 0) {
  return { authoritative: false, reason: 'stale_devicetime' };
}
```

Or c'est lui qui produit 8356 des 8360 rejets. Un Coban qui bufferise pendant une coupure 2G puis
rejoue son tampon **après** que la trame temps réel a établi la nouvelle baseline voit toutes ses
positions tampon déclarées « antérieures » — et écartées. Le code ne peut pas distinguer ce
rattrapage d'un rejeu fantôme : les deux arrivent avec un horodatage plus ancien.

### Pourquoi personne ne l'a vu

`PositionsService.ingest` fait exactement ce qu'il faut pour rester discret, et il le fait bien :
il met à jour la liveness (le boîtier reste ONLINE), il journalise la décision en
`SKIPPED_REPLAY`, et il émet un `logger.warn`. Résultat :

- **aucune ligne `error_logs`** — ce n'est pas une erreur, c'est une décision ;
- **aucun compteur d'écran** — le centre d'alerte ne lit pas `position_sampling_decisions` ;
- le `warn` se perd dans les journaux du conteneur, qui ne retiennent que quelques heures.

Un trajet amputé de 16 km ne se voit que si quelqu'un connaît le trajet réel.

### Correctifs proposés

1. **Le test qui manque tient en une requête.** Avant de rejeter sur `stale_devicetime`, vérifier
   s'il existe déjà une ligne `positions` pour ce boîtier **à cet horodatage exact**. C'est
   précisément ce qui sépare un fantôme d'un rattrapage, et la donnée prouve que le test discrimine :
   3837 rejets ont leur jumeau, 3466 n'en ont aucun.
2. **Fantôme → rejeter**, comportement actuel strictement inchangé.
3. **Sinon → persister en trame NON autoritaire.** Écrire la ligne `positions` (l'historique est
   récupéré) **sans** toucher à la dernière position dénormalisée du tracker, ni à l'ignition, ni
   au broadcast temps réel. La baseline reste protégée — c'est elle, et elle seule, que l'incident
   du 10-11/06 a empoisonnée.
4. **Rendre la perte lisible.** Un compteur « trames écartées sans jumeau en base » par boîtier,
   sur 24 h. Un boîtier à 22 % de rejet est un signal terrain (couverture 2G) autant qu'un signal
   logiciel — et aujourd'hui rien ne le dit.

### ⚠️ Ne pas « corriger » en relâchant le critère 1

Accepter les trames antérieures **comme autoritaires** rouvrirait exactement l'incident que ce
garde-fou ferme : baseline empoisonnée → téléportation en live, distances négatives en rapports,
polylignes triangulaires en replay. Le même invariant est appliqué à trois autres étages
(`TripsService.processPosition`, le segmenter, le rendu replay) : les relâcher ensemble ferait
revenir le bug de « double trace ».

> *Le correctif porte sur ce qu'on **persiste**, pas sur ce qui fait **autorité**.* Ce sont deux
> décisions distinctes que le code d'aujourd'hui prend en une seule.

### Vérification après correctif

Le nombre de rejets **sans aucune position à ± 60 s** doit tomber vers 0, **pendant que** le
nombre de rejets ayant leur jumeau en base reste autour de **2000 / 4 jours**. Si les deux tombent
à zéro, le garde-fou a été supprimé et non réparé — et la téléportation reviendra.

Second test, sur la conséquence métier : la distance totale parcourue par EP-047-TY et FG-669-DQ
sur une semaine doit **augmenter** après correctif. Un correctif qui ne changerait aucune distance
n'aurait rien récupéré.

### ⚠️ Ce qui reste à établir

La classe « retour arrière ≤ 60 s » (273 trames, 103 trous) n'a pas été instruite séparément.
Elle est trop petite pour peser, mais son profil diffère : quasi aucun jumeau en base. À regarder
au prochain passage — il peut s'agir d'un tout autre mécanisme (horloge boîtier qui recule d'une
seconde) qu'il serait faux de fondre dans cette fiche.

### 🔴 Mise à jour du 2026-08-09 — la perte est aussi EN RAFALE : 1643 trames d'un seul bloc

La fiche décrivait une perte **diffuse**, ~1,4 % du flux réparti sur tout le parc. Le 08/08 en
montre l'autre visage. Une classe de rejet **absente des trois jours précédents** apparaît : le
retour arrière de **plus de 60 minutes**.

| Jour (`receivedAt`) | Doublon exact | Retour ≤ 60 s | Retour 1-60 min | **Retour > 60 min** |
|---|---|---|---|---|
| 05/08 | 407 | 29 | 2524 | **0** |
| 06/08 | 393 | 41 | 966 | **0** |
| 07/08 | 462 | 21 | 882 | **0** |
| **08/08** | 360 | 36 | 1730 | **1646** |

**1643 des 1646 viennent d'un seul boîtier : HD-779-MA.** Horodatages boîtier continus de
**07/08 22:58:54 à 08/08 05:16:34**, retard de 1,0 h à 6,3 h, rejeu reçu à partir de 05:16:55.

Ce que la base dit du même véhicule :

| | |
|---|---|
| Dernière position avant le trou | **07/08 22:59:54** — 43.317, -1.840, **86,7 km/h** |
| Positions entre 23:00 et 05:16 | **aucune** |
| Première position après le trou | **08/08 05:16:44** — 43.374, -1.663, **126,5 km/h** |
| Distance entre les bords du trou | **15,7 km** |
| Trames rejetées comblant l'intervalle | **1643**, dont **1636 sans position à ± 60 s** |

Le boîtier est entré dans le trou à 87 km/h et en est ressorti à 127 km/h six heures plus tard. Il
a tamponné pendant la coupure, rejoué à la reconnexion — et **tout a été écarté**, parce que la
trame temps réel avait déjà établi la nouvelle référence. C'est le mécanisme décrit par cette
fiche, observé pour la première fois **de bout en bout sur un épisode unique et datable**.

**Deux conséquences pour le correctif :**

1. **Il devra encaisser une rafale.** Un seul événement réseau produit 1600 trames à traiter d'un
   coup. Une vérification « existe-t-il déjà une position ? » ligne à ligne doit tenir ce débit.
2. **Le boîtier concerné est HD-779-MA** — celui-là même dont l'incident de téléportation des
   10-11/06 a motivé l'écriture du garde-fou. Le matériel qui justifie la garde est celui qui lui
   coûte le plus cher. Cela ne plaide pas pour relâcher la garde : cela plaide pour la proposition
   déjà écrite — **persister sans faire autorité**.

⚠️ **Réserve d'honnêteté.** `position_sampling_decisions` ne conserve pas les coordonnées des
trames rejetées : on ne peut pas prouver que les 1643 points sont géographiquement cohérents. Sont
prouvés : le trou (aucune position sur 6 h 17), la continuité temporelle des trames qui le comblent
exactement, et le fait que le véhicule roulait en y entrant comme en en sortant. La distance
moyenne au rejet (175 km) se lit vis-à-vis de la position **courante au moment du rejeu**, pas
comme une incohérence — le véhicule a manifestement voyagé loin pendant la coupure.

**Mesure du jour, à la définition du 08/08** (trou = aucune position à ± 60 s de l'horodatage rejeté) :

| Classe | Trames | Sans jumeau à ± 60 s | Distance moyenne |
|---|---|---|---|
| Doublon exact (Δt = 0) | 1627 | 11 | 0 m |
| Retour ≤ 60 s | 130 | 19 | 302 m |
| Retour 1-60 min | 6118 | **3911** | 3560 m |
| Retour > 60 min | 1646 | **1636** | 181 957 m |
| **Total `stale_devicetime`** | **9521** | **5577** | |

*(9527 `SKIPPED_REPLAY` sur 4 j au total : 9521 `stale_devicetime` + 6 `implausible_jump`.)*

**La question ouverte avance d'un point, sans se refermer.** La classe « retour ≤ 60 s » mesure ce
jour **130 trames dont 111 ont une position à ± 60 s** — profil **inverse** de celui du 08/08
(273 trames, quasi aucun jumeau). Deux points, deux profils opposés : rien à conclure, la classe
reste à instruire. Elle pèse 1,4 % du volume, elle peut attendre un troisième point.

### 🔴 Mise à jour du 2026-08-10 — deuxième rafale, sur un AUTRE véhicule

La rafale du 08/08 reposait sur un épisode unique (HD-779-MA), donc sur un seul boîtier — celui-là
même dont l'incident de juin a motivé le garde-fou. On pouvait encore croire à une particularité de
ce matériel. **Un second épisode, indépendant, est mesuré ce jour sur GS-014-NY :**

| | |
|---|---|
| Dernière position avant le trou | **09/08 14:50:22** — 15 km/h |
| Positions entre 14:50 et 15:11 | **aucune** |
| Première position après le trou | **09/08 15:11:28** — **130 km/h** |
| Trames rejetées comblant l'intervalle | **60**, à **21,5 km** en moyenne de la position courante au moment du rejeu |

Même signature de bout en bout : entrée dans le trou à basse vitesse, sortie à 130 km/h vingt et une
minutes plus tard, trames tamponnées pendant la coupure toutes écartées parce que la trame temps
réel avait déjà établi la nouvelle référence. **Deux épisodes, deux véhicules, deux jours** — le
mécanisme n'est pas propre à HD-779-MA, et le correctif doit encaisser des rafales de tailles très
différentes (60 trames ici, 1643 le 08/08).

**Mesure du jour, sur 24 h** (⚠️ fenêtre différente des passages des 08 et 09/08, qui portaient sur
4 jours — ces nombres ne se comparent pas aux précédents ; seule la **proportion** se compare) :

| Classe | Trames | Sans jumeau à ± 60 s | Part de trous | Distance moyenne |
|---|---|---|---|---|
| Doublon exact (Δt = 0) | 238 | 2 | 0,8 % | 0 m |
| Retour ≤ 60 s | 38 | 7 | 18,4 % | 155 m |
| Retour 1-60 min | **1969** | **1886** | **95,8 %** | 1143 m |
| Retour > 60 min | 0 | — | — | — |
| **Total `stale_devicetime`** | **2245** | **1895** | 84,4 % | |

Les rejets pèsent **1,55 % du flux** de décisions d'échantillonnage sur 24 h — proportion stable
depuis le 08/08 (1,4 %).

**La question ouverte prend un troisième point, et reste ouverte.** La classe « retour ≤ 60 s »
mesure 38 trames dont 7 sans jumeau (18 %) : ni le profil du 08/08 (quasi aucun jumeau), ni celui du
09/08 (quasi tous). *Trois points, trois profils.* C'est en soi une information : cette classe n'a
pas un mécanisme unique, et la fondre dans cette fiche serait faux. Elle pèse moins de 2 % du
volume — la traiter après le reste.

### Mise à jour du 2026-08-11 — aucune rafale ce jour

**Mesure sur 24 h**, même définition et même durée de fenêtre que la veille (trou = aucune position
à ± 60 s de l'horodatage rejeté) :

| Classe | Trames | Sans jumeau à ± 60 s | Part de trous |
|---|---|---|---|
| Doublon exact (Δt = 0) | 334 | 1 | 0,3 % |
| Retour ≤ 60 s | 94 | 46 | 48,9 % |
| Retour 1-60 min | **1412** | **569** | **40,3 %** |
| **Retour > 60 min** | **15** | **0** | **0 %** |
| **Total `stale_devicetime`** | **1855** | **616** | 33,2 % |

Les rejets pèsent **1,27 % du flux** (1855 sur 146 088 décisions d'échantillonnage) — proportion
stable depuis le 08/08 (1,4 % puis 1,55 %). Boîtiers les plus touchés : EP-047-TY (616 rejets),
FG-669-DQ (385), KSR370 (239) — les deux premiers sont ceux dont la fiche mesurait déjà les segments
de trajet manquants.

⚠️ **Aucune rafale.** La classe « retour > 60 min » compte 15 trames et **zéro trou**, contre 1646
le 08/08 et 60 le 09/08. Les deux épisodes documentés (HD-779-MA, GS-014-NY) n'ont pas de troisième.

⚠️ **Le taux de trous passe de 84,4 % à 33,2 % — ne pas y lire une amélioration.** Deux points ne
font pas une tendance (§4 bis), et une explication mécanique existe **sans qu'aucun défaut n'ait
changé** : le taux global est dominé par les classes de rafale, absentes ce jour. Le fait mesuré est
« 616 positions réelles écartées en 24 h » ; l'histoire « la perte diminue » n'est pas mesurée.

**La question ouverte prend un quatrième point, et un quatrième profil.** « Retour ≤ 60 s » : 94
trames dont 46 sans jumeau (**48,9 %**), après 37,7 % / 14,6 % / 18,4 %. Quatre mesures dispersées
sur toute la plage — la conclusion du 10/08 se renforce : **cette classe n'a pas un mécanisme
unique**. La fondre dans cette fiche serait faux ; l'instruire séparément quand le reste sera traité.

### 🔧 Mise à jour du 2026-08-13 — la série reprend, après une rectification d'outillage

Le passage du 12/08 n'a **pas** mesuré cette fiche, ayant conclu que `position_sampling_decisions`
« n'existe pas ». **La table existe.** Ses colonnes sont `decision · state · reason · speedKmh ·
ignition · distanceM · receivedAt` : il n'y a **ni `createdAt`, ni `deviceTime`**. Les deux
horodatages qui classent un rejet sont **dans le texte de `reason`** —

```
garde-fou ingestion (stale_devicetime) : deviceTime 2026-08-12T07:09:26.000Z vs dernier 2026-08-12T07:10:26.000Z
```

— et la table de jumelage est `positions."timestamp"`, pas `"deviceTime"`.

> *Une erreur de nom de colonne et une table absente produisent le même message d'erreur ; elles se
> distinguent en interrogeant `information_schema`.* Trois requêtes ont suffi. La série reprend
> avec un trou d'un jour au 12/08 — un trou dans la mesure, pas dans le défaut.

**Mesure sur 24 h**, même définition qu'aux passages précédents :

| Classe | Trames | Sans jumeau à ± 60 s | Part de trous |
|---|---|---|---|
| Doublon exact (Δt = 0) | 504 | **0** | 0 % |
| Retour ≤ 60 s | 119 | 50 | 42,0 % |
| Retour 1-60 min | **1405** | **906** | **64,5 %** |
| **Retour > 60 min** | **0** | — | — |
| **Total `stale_devicetime`** | **2028** | **956** | 47,1 % |

*(Le total `SKIPPED_REPLAY` relevé quelques minutes plus tôt donne 2022 : l'écart de 6 est celui de
la fenêtre glissante, pas une incohérence.)*

Les rejets pèsent **1,38 % du flux** (2022 sur 146 831 décisions d'échantillonnage) — proportion
stable depuis le 08/08 (1,4 · 1,55 · 1,27 %). Boîtiers les plus touchés : FG-669-DQ (355),
KSR370 (252), GS-014-NY (165), EP-047-TY (144).

⚠️ **Aucune rafale, deuxième jour de mesure consécutif sans** : la classe « retour > 60 min » est à
zéro, contre 1646 le 08/08 et 60 le 09/08. Le fait mesuré est **956 positions réelles écartées en
24 h**.

**La question ouverte prend un cinquième point, et un cinquième profil.** « Retour ≤ 60 s » : 119
trames dont 50 sans jumeau (**42,0 %**), après 37,7 / 14,6 / 18,4 / 48,9 %. Cinq mesures dispersées
sur toute la plage : **cette classe n'a décidément pas un mécanisme unique**.

*(Détail incident : une partie des rejets du 12/08 se concentre autour de 07:09-07:10 — l'heure
exacte de la recréation du conteneur `tracky-api`. Un redémarrage provoque des rejeux de tampon,
donc des rejets. Noté, pas instruit : c'est un mécanisme connu de cette fiche, pas un fait neuf.)*


### ⚠️ 2026-08-16 — les rejets triplent le jour où les insertions tombent au plus bas

| Jour | `SKIPPED_REPLAY` | `INSERTED` |
|---|---|---|
| 12/08 | 1 998 | 25 792 |
| 13/08 | 2 636 | 24 706 |
| 14/08 | 1 545 | 24 201 |
| **15/08** | **5 323** | **19 849** |

Sur la fenêtre glissante de 24 h : **5 497** rejets `SKIPPED_REPLAY`, dont **2 820 trous prouvés**
(aucune position à ± 60 s dans `positions."timestamp"`) — contre 533 la veille.

**Ni rafale, ni boîtier unique.** Les rejets se répartissent sur **34 boîtiers** (maximum 681 pour
un seul) et sur **toutes les heures** de la journée : l'heure la plus chargée pèse 780 rejets sur
5 323. Aucune fenêtre ne concentre l'épisode, contrairement aux rafales du 08/08 (HD-779-MA,
1 643 positions d'un bloc) et du 10/08 (GS-014-NY, 60 trames sur 21 minutes).

> **Fait mesuré, pas tendance — et voici pourquoi il est quand même écrit en gras.** La série des
> rejets oscille (1998 · 2636 · 1545 · **5323**) et quatre points sur une grandeur aussi remuante ne
> démontrent aucune aggravation. Ce qui distingue celui-ci n'est pas son amplitude : c'est que
> **deux grandeurs indépendantes bougent dans le même sens le même jour** — **+245 %** de rejets et
> **−18 %** d'insertions — alors que les trames entrantes ne baissent que de **2 %**
> (167 179 → 163 269). Plus de trames écartées pour à peu près autant de trames reçues.
> *Un compteur qui bouge seul est du bruit ; deux compteurs indépendants qui bougent ensemble
> méritent un troisième point avant qu'on les raconte.*

🗓️ **Test daté pour le prochain passage.** Relever `SKIPPED_REPLAY` **et** `INSERTED` du
16/08, avec le compte de trames entrantes. Si les deux restent au niveau du 15/08
(> 4 000 rejets, < 21 000 insertions), c'est un **régime** et la fiche change d'ordre de grandeur.
S'ils reviennent vers 1 500 / 24 500, le 15/08 était une journée.
**Condition de nullité :** si les trames entrantes chutent elles aussi (< 140 000), les trois
grandeurs bougent ensemble et la comparaison ne dit plus rien sur le garde-fou.

---

## TRK-016

**Signature** — `MapMatchingService | WARN | OSRM /match HTTP 400` → `trips.polylineMatched IS NULL`
— **en volume, et sans aucune alerte**
**Statut : 🔴 NON CORRIGÉ** · **89,8 % des trajets du 08/08 · 10 055 trajets sur 12 462 depuis le
15/04** · découvert 2026-08-09

> ### Une fonctionnalité qui échoue neuf fois sur dix depuis quatre mois n'est pas dégradée, elle est absente.

### Constat

`polylineMatched` est la trace du trajet recalée sur le réseau routier. Quand elle est nulle,
l'interface affiche la trace GPS **brute** — avec son bruit, ses angles droits et ses
allers-retours de stationnement.

| Jour | Trajets | Sans polyligne recalée | Part |
|---|---|---|---|
| 02/08 | 149 | 109 | 73,2 % |
| 03/08 | 145 | 131 | 90,3 % |
| 04/08 | 191 | 161 | 84,3 % |
| 05/08 | 202 | 188 | 93,1 % |
| 06/08 | 180 | 169 | 93,9 % |
| 07/08 | 199 | 183 | 92,0 % |
| 08/08 | 166 | 149 | **89,8 %** |
| **Depuis le 15/04** | **12 462** | **10 055** | **80,7 %** |

Sur la fenêtre de journaux mesurée (7,9 h) : **79 réponses HTTP 400 pour 79 replis en trace
brute**. Le rapport de 1 pour 1 montre que c'est le **premier** tronçon qui échoue et interrompt
tout le trajet.

### Cause racine — trois défauts distincts qui se composent

1. **Un tronçon en échec annule tout le trajet.** `map-matching.service.ts:36-40` découpe en
   tronçons de 100 points et fait `return null` à la première erreur. Un trajet de 400 points perd
   la totalité de son recalage à cause de 100 points.
2. **Le résultat n'est jamais réessayé.** `runMapMatchingAsync` persiste `polylineMatched` une fois
   ou pas du tout (`trips.service.ts:911-926`). Un échec transitoire devient **définitif**.
3. **Le fournisseur est l'instance de démonstration publique et gratuite** d'OSRM — valeur par
   défaut du code, `OSRM_BASE_URL` n'étant pas défini dans l'environnement du conteneur. Le
   commentaire du fichier l'assume comme un provisoire de V1.4 : *« demo gratuit, rate limite mais
   OK pour V1.4 sans hosting »*. Ce provisoire tient depuis avril.

### Famille — **brut**

Au sens du §7 de la procédure. Le code journalise `OSRM /match HTTP 400` et **jette le corps de la
réponse**, qui porte pourtant un `code` explicite. Le message ne nomme ni le trajet, ni le
véhicule, ni la conséquence — et il détruit l'information qui permettrait de conclure.

### Vérifié en direct, avec les paramètres exacts du code

Sondage avec des coordonnées **synthétiques** (aucune donnée client envoyée à un tiers) :

| Requête | Réponse |
|---|---|
| 4 points sur route, `radiuses=25` | **`Ok`** — le paramétrage du code fonctionne |
| Les mêmes 4 points, sans `radiuses` | `400` · `NoMatch` |
| 2 points seulement, `radiuses=25` | `400` · `NoSegment` |
| 4 points, **`radiuses=50`** | `400` · **`TooBig`** — *« Radius search size is too large for map matching »* |

> **Le correctif qui vient spontanément à l'esprit — élargir le rayon de recherche — est refusé par
> cette instance.** Il fallait le savoir avant d'écrire du code. *(Même leçon que TRK-012 correctif
> #3 : vérifier l'hypothèse d'infrastructure avant de coder.)*

Et ce n'est **pas** de la limitation de débit : le serveur répond 429 dans ce cas, pas 400.

### Ce qui n'est pas établi

Lequel des codes (`NoMatch`, `NoSegment`, autre) domine en production, et sur quel profil de trace.
Le savoir suppose de journaliser le corps de la réponse — une modification de code, hors du
périmètre de cet audit. **Ne pas conclure à sa place.**

### Correctifs proposés

1. **Journaliser le `code` du corps de la réponse**, pas seulement le statut HTTP. Une ligne, et
   elle transforme un compteur muet en diagnostic. **Préalable à tout le reste.**
2. **Ne pas annuler tout le trajet pour un tronçon.** Conserver les tronçons recalés, ne retomber
   en brut que sur celui qui échoue.
3. **Décider du provisoire.** Soit héberger une instance OSRM (`OSRM_BASE_URL` est déjà prévu,
   c'est une variable à poser), soit retirer la promesse de l'interface.

### ⚠️ Ne pas « corriger » en cachant le repli

La trace brute est un repli honnête : elle affiche une vérité bruitée plutôt qu'une jolie ligne
inventée. Le défaut n'est pas le repli — c'est qu'il soit devenu le cas **normal** sans que rien ne
le dise. *Le témoin n'est pas le défaut.*

### Vérification après correctif

La part de trajets sans polyligne recalée doit passer **sous 20 % sur une journée pleine**, **et**
les échecs restants doivent porter un `code` lisible dans les journaux. Si la part tombe sans
qu'aucun code n'apparaisse jamais, on n'a pas mesuré — on a espéré.

### Mise à jour du 2026-08-10 — septième jour au-dessus de 89 %

**92,7 % des trajets du 09/08** sans polyligne recalée (89 sur 96). Sept jours consécutifs entre
89,8 % et 93,9 % : la fonctionnalité est absente, pas dégradée. Rien n'a changé côté code ni côté
environnement (`OSRM_BASE_URL` toujours non défini, image inchangée depuis le 04/08).

### Mise à jour du 2026-08-11 — huitième jour consécutif

**90,4 % des trajets du 10/08** sans polyligne recalée (141 sur 156). Huit jours entre 89,8 % et
93,9 %, sur des volumes quotidiens allant de 96 à 199 trajets : ni le taux ni sa stabilité ne
dépendent de la charge. `OSRM_BASE_URL` reste non défini dans l'environnement du conteneur — le
provisoire de V1.4 tient depuis avril, et les correctifs #1 (journaliser le `code` de la réponse)
et #3 (décider du provisoire) n'ont pas bougé.

⚠️ Cette fiche est la seule des cinq ouvertes dont le correctif **ne dépend d'aucune autre** : ni
d'un test SMS, ni d'une rotation de clé, ni d'un accusé de remise. Une ligne de journalisation la
ferait avancer aujourd'hui.

### Mise à jour du 2026-08-13 — dixième jour consécutif

**91,7 % des trajets du 12/08** sans polyligne recalée (189 sur 206). Dix jours entre 89,8 % et
93,9 %, sur des volumes quotidiens de 92 à 207 trajets. `OSRM_BASE_URL` reste non défini ; les
correctifs #1 (journaliser le `code` du corps de la réponse) et #3 (décider du provisoire) n'ont
pas bougé.

⚠️ Cette fiche reste la seule dont le correctif ne dépend d'aucune autre — et c'est le troisième
passage consécutif où on l'écrit. *Une indépendance qu'on signale sans l'utiliser cesse d'être une
information.*


### 2026-08-16 — 89,2 %, 13ᵉ jour au-dessus de 88 %

**148 trajets le 15/08, 132 sans recalage — 89,2 %.** Cumul : **11 140 / 13 659 = 81,6 %**.

Série : 89,8 · 92,7 · 89,0 · 90,4 · 91,2 · 91,7 · 90,2 · 88,8 · **89,2**. Elle oscille dans une
bande de trois points sans qu'aucune ligne n'ait été touchée dans ce module. ⚠️ **Ni la baisse
d'hier ni la remontée d'aujourd'hui ne sont des mesures de quoi que ce soit** — l'écart tient à une
poignée de trajets sur ~150. Le fait qui compte est inchangé depuis avril : **neuf trajets sur dix
s'affichent en trace brute.**

---

## TRK-017

**Signature** — `sms-allowlist | ERROR | Allowlist SMS incomplète : <N> numéro(s) manquant(s)
rétabli(s) — le repli SMS (coupe-circuit, notifications) était inopérant pour ces destinataires.`
**Statut : 🔴 NON CORRIGÉ** · **25 numéros sur 41 effacés puis recréés en boucle, dont 24 SIM de
boîtier · 8 occurrences · découvert 2026-08-10** *(épisodes des 2026-08-09 20:25 / 22:25 et
2026-08-10 05:25 / 06:25 / 10:25 / 12:25 / 13:25 / 14:25 UTC)*

> ### Le repli du coupe-circuit se rouvre plusieurs fois par jour pour 24 boîtiers sur 43 — et rien, nulle part, ne peut nommer qui l'ouvre.

> 🔄 **Requalifié le 2026-08-10 au 2ᵉ passage.** La fiche décrivait d'abord un trou **historique** de
> treize jours rattrapé une fois. Le test daté (ci-dessous, exécuté avec 16 h d'avance) a montré
> l'inverse : la réconciliation **tourne bien**, et ce sont les entrées qui **disparaissent en
> boucle**. Un trou qui se rattrape et un trou qui se rouvre n'appellent pas le même correctif —
> c'est exactement pour ça que le premier passage a refusé de trancher.

### Constat — vérifié des deux côtés de la passerelle

| Fait | Où c'est mesuré |
|---|---|
| Numéros poussés par Tracky | **41** (43 boîtiers avec SIM + utilisateurs actifs, dédupliqués) |
| Absents au moment du rétablissement | **25**, dont **24 étiquetés `Tracker <imei>`** et 1 `User <email>` |
| Mode allowlist du tenant `tracky` | **actif** (`allowlistMode = true`) |
| Entrées `manual` (la reprise en main du 27/07) | 17, dont 10 SIM de boîtier — elles couvraient une partie du parc, pas l'autre |
| Envois SMS réels depuis le 27/07 | 44, tous « SUCCESS » — **sur les numéros présents uniquement** |

### Pourquoi ça ne pouvait produire aucune alerte

`tenants.service.ts:18-28`, côté passerelle :

```ts
async assertDestinationAllowed(tenant: Tenant, toE164: string): Promise<void> {
  if (!tenant.allowlistMode) return;
  const entry = await this.prisma.allowlistEntry.findUnique({ … });
  if (!entry) throw new ForbiddenException(`Destinataire ${toE164} hors allowlist …`);
}
```

Le refus est levé **avant** la création de la ligne `messages`. Conséquence directe : un SMS refusé
pour ce motif n'apparaît **ni** dans le journal de la passerelle (aucune ligne créée), **ni** au
centre d'alerte de Tracky. La table `messages` le confirme : 307 `queued`, 230 `received`,
29 `failed` — et **aucun refus d'allowlist**, par construction.

> Le seul chemin qui pouvait révéler ce trou est la réconciliation périodique elle-même. C'est
> exactement pour ça qu'elle a été écrite le 27/07 — et c'est la première fois qu'elle parle.

### Ce qui est démontré, et ce qui ne l'est pas

**Démontré — le trou était réel.** À 20:25, 25 numéros sur 41 manquaient. Les deux seuls chemins de
code qui écrivent une ligne `sms-allowlist` (`allowlist.service.ts:115` et `:124`) sont « j'ai
rétabli des numéros » et « la réconciliation a échoué ». Aucune ligne n'existe entre le 27/07 et le
09/08 20:25, et la rétention des erreurs est à 90 jours depuis [TRK-010](#trk-010). Une
réconciliation qui aurait tourné et abouti pendant cette période aurait produit l'une ou l'autre.

**Non démontré — pourquoi.** Les 25 entrées créées à 20:25 n'existent plus : celles présentes en
base portent toutes `createdAt = 2026-08-09 22:25:00.18`. Quelque chose les a supprimées entre les
deux passages — et **ce n'est pas la synchro de Tracky** :

- `syncAllowlist` (`tenants.service.ts:147-193`) ne supprime que les entrées `synced` **absentes de
  la liste poussée**, et Tracky journalise tout `removed > 0` au journal système ;
- `system_activity_logs` ne contient **que deux** `allowlist_synced` depuis le 27/07, toutes deux
  `+25 / -0`. Aucune suppression n'a jamais été rapportée.

Deux lectures étaient ouvertes, et elles menaient à des correctifs **opposés** :

| Lecture | Ce qu'elle implique | Verdict du 10/08 17:12 |
|---|---|---|
| **A — le cron ne tourne pas à la cadence déclarée** (`@Cron('0 25 * * * *')`, `allowlist.service.ts:106`) | Le trou datait du 27/07 et a duré 13 jours. Le correctif porte sur la **planification**. | ❌ **Écartée** — six exécutions de plus le 10/08. |
| **B — un tiers supprime les entrées `synced`** | Le cron fait son travail et répare un effacement qui recommence. Le correctif porte sur **qui appelle `DELETE /v1/allowlist/:phone`** ou `PUT /sync` avec une liste partielle. | ✅ **Retenue.** |

*Ne pas trancher sur un seul épisode* était la bonne consigne : un audit qui aurait choisi A le
09/08 aurait écrit une supervision de cron parfaitement inutile, sur un cron qui tournait déjà.
Il aura suffi d'un second passage — et d'une requête qui ne modifie rien — pour le savoir.

> ⚠️ **Ce qui reste faux dans le paragraphe ci-dessus.** « Aucune ligne n'existe entre le 27/07 et le
> 09/08 20:25 » reste vrai et vérifié, mais **n'autorise plus** à conclure que le trou datait du
> 27/07 : en régime B, une période sans ligne est une période où **rien ne manquait**. Le trou de
> treize jours était une inférence de la lecture A, et il tombe avec elle.

### ✅ Test daté — exécuté le 2026-08-10 à 17:12 UTC (2ᵉ passage), verdict : **lecture B**

Le test posé pour le 11/08 a été exécuté au passage supplémentaire du 10/08 au soir.

```sql
SELECT source, count(*), min("createdAt"), max("createdAt")
FROM allowlist_entries GROUP BY 1;
```

| `source` | n | `createdAt` min | `createdAt` max |
|---|---|---|---|
| `manual` | 17 | 2026-06-03 12:08 | 2026-07-27 13:37 |
| `synced` | **25** | **2026-08-10 14:25:00.78** | **2026-08-10 14:25:00.78** |

`createdAt` a bougé → **lecture B**. Et la lecture A est **écartée par un fait indépendant** : la
réconciliation a tourné **six fois de plus** le 10/08 (05:25, 06:25, 10:25, 12:25, 13:25, 14:25 UTC),
chaque fois `+25 / -0 (16 inchangés)`. Elle s'exécute, elle répare, et le trou revient.

**La suppression est mesurée, pas déduite** — `pg_stat_user_tables` sur `allowlist_entries` :
`n_dead_tup = 25` pour un `last_autovacuum = 2026-08-10 13:25:47 UTC`. Exactement 25 lignes
supprimées entre 13:25:47 et la lecture : le lot créé à 13:25, effacé avant celui de 14:25.
Suppression **en bloc**, de la taille exacte du lot `synced`, **jamais** sur les 17 `manual`.

⚠️ Les cumuls `n_tup_ins = 277` / `n_tup_del = 235` ne servent qu'à décrire une **forme** :
`stats_reset` est `NULL`, la date de départ des compteurs est inconnue. Aucune arithmétique de
cycles ne peut s'y appuyer.

### Fenêtres d'exposition — bornées par l'absence de ligne

L'alerte date la **fermeture** du trou, jamais son ouverture. Une heure sans ligne étant une heure
où rien ne manquait, les réouvertures du 10/08 se bornent ainsi :

| Trou ouvert dans… | Refermé à |
|---|---|
| (09/08 22:25 → 05:25] · (05:25 → 06:25] · (09:25 → 10:25] | 05:25 · 06:25 · 10:25 |
| (11:25 → 12:25] · (12:25 → 13:25] · (13:25 → 14:25] | 12:25 · 13:25 · 14:25 |

**Au moins six réouvertures en 19 h**, chacune jusqu'à 60 min. Rien entre 00:25 et 04:25, ni depuis
14:25 (intact 2 h 47 à la lecture). Le phénomène est **irrégulier**, pas horaire.

### Qui supprime ? Six pistes fermées — et l'angle mort EST le constat

| Piste | Pourquoi elle est écartée |
|---|---|
| La synchro de Tracky | 10 `allowlist_synced` depuis l'origine, **toutes en `-0`**. Ce chemin n'a jamais supprimé. |
| La route d'admin `DELETE /admin/sms/allowlist/:phone` | Passe par l'intercepteur d'audit. Sur 24 h : 22 `http_post`, 1 `http_patch`, **aucun `http_delete`**. |
| Une 2ᵉ instance de Tracky | Un seul `tracky-api` parmi les 29 conteneurs du VPS. |
| `vizyo-manager` | Une occurrence du mot dans un catalogue de services. Aucun code client. |
| Un ménage programmé côté passerelle | Seul minuteur de `vizyo-texto/src` : la relance des webhooks. Aucun `@Cron`. |
| Un tenant concurrent | La table `tenants` n'en contient qu'un. |

Reste l'angle mort, **et il est lui-même le défaut à corriger** :

| Instrument | État |
|---|---|
| Journal d'accès HTTP du reverse proxy | **absent** — il tourne sans `--accesslog` |
| Journal de requêtes de la passerelle | **inexistant** — 5 tables, aucune de trace d'appel |
| `docker logs` du relais | **ne rend pas la main** sur cet hôte |
| Exposition du point d'entrée | **publique** — l'appelant peut être hors du VPS (poste de dev inclus) |

*Tant qu'une mutation d'allowlist n'est pas attribuable, tout correctif viserait au jugé.*

### 🗓️ Nouveau test daté — au passage du 2026-08-11

1. Relire `allowlist_entries` : si `createdAt` des `synced` a **encore** bougé, le phénomène est
   confirmé sur un troisième jour → ce n'est plus un épisode, c'est un régime permanent.
2. Compter les lignes `sms-allowlist` du 10/08 18:00 au 11/08 03:00 UTC. **Zéro ligne la nuit**
   (comme entre 00:25 et 04:25 le 10/08) alors qu'il y en a le jour orienterait vers un appelant
   **actif aux heures ouvrées** — un poste de développement plutôt qu'un automate. C'est
   l'unique discriminant disponible sans toucher au code.
3. **Condition d'échec écrite** : si le passage se contente de recompter les réouvertures sans
   trancher le point 2, il n'aura rien appris de plus que celui-ci.

### ✅ 2026-08-10 19:25 UTC — **L'APPELANT EST NOMMÉ. Statut : cause racine trouvée.**

Le journal des appels a été déployé à 19:15. **Dix minutes plus tard, il avait la réponse** —
deux appels à `PUT /v1/allowlist/sync`, à quatre dixièmes de seconde d'écart :

| Heure | IP source | Numéros poussés | Effet | Verdict |
|---|---|---|---|---|
| 19:25:01.582 | **82.67.153.51** *(adresse publique, hors du VPS)* | **1** | aurait supprimé **25** entrées | 🛑 `removals_blocked` |
| 19:25:01.988 | `172.18.0.1` *(Tracky, sur le VPS)* | 41 | 0 ajout, 41 inchangés | ✅ `ok` |

**Les deux portent la MÊME clé d'API** (`apiKeyPrefix` identique), et **la même minute de cron**.
Ce n'est donc pas un tiers hostile : c'est **une seconde instance de Tracky**, exécutée hors du
VPS avec la clé de PRODUCTION de la passerelle SMS, dont la base ne contient qu'**un seul**
boîtier avec SIM. Son `@Cron('0 25 * * * *')` pousse sa liste d'un numéro ; la réconciliation
supprimait alors les 25 autres, et celle du VPS les recréait derrière. D'où :

- la cadence **exactement horaire à h:25** — même code, même minute ;
- le caractère **irrégulier** dans la journée — la machine n'est pas toujours allumée, ce qui
  colle au discriminant « appelant actif aux heures ouvrées » posé la veille ;
- l'**absence totale de trace** côté prod — c'est une autre instance, avec son propre journal ;
- la suppression des seules entrées `synced`, jamais des `manual`.

**La garde a tenu dès son premier passage** : `createdAt` des 25 entrées vaut toujours
`14:25:00.78`. Pour la première fois depuis le 09/08, elles ont survécu à un h:25.

> 🔐 **Ce qui reste à faire est une décision humaine, pas du code.** Une instance de
> développement détient la clé d'API de la passerelle SMS de production, et le point d'entrée
> est joignable depuis Internet. Le correctif durable est de **révoquer et rotationner cette
> clé**, puis de donner à l'environnement de développement **son propre tenant** (ou aucune
> clé). Tant que la clé est partagée, la garde empêche le dégât mais la cause demeure.

⚠️ **Ne pas conclure « c'est réglé » et retirer la garde.** Elle est ce qui transforme un
effacement silencieux en ligne de journal lisible. Elle reste utile après la rotation de clé.

### ✅ 2026-08-10 (soir) — correctifs DÉPLOYÉS

Sur demande du propriétaire. **En production depuis le 2026-08-10 19:15 UTC** (passerelle) et
19:39 UTC (Tracky, `main` @ `d5e5fb1`, `restarts=0`, API `healthy`). Migration
`20260810180000_allowlist_audit_log` appliquée.

| Où | Ce qui est écrit | Branche |
|---|---|---|
| `vizyo-texto` *(déployé)* | Table `allowlist_audit_logs` + migration ; **une ligne par appel** sur les 4 chemins de mutation, y compris à diff vide et y compris quand l'appel est retenu ; `trust proxy` + conservation du `X-Forwarded-For` **brut** ; **garde anti-suppression de masse** ; `GET /v1/allowlist/audit`. 11 tests (le dépôt n'en avait aucun). | `main` @ `80e04fe` |
| `tracky` *(déployé)* | Trace d'exécution inconditionnelle (`allowlist_reconciled`) ; alerte par **épisode** au lieu d'une ligne par réparation, avec rappel quotidien tant qu'il dure ; remontée d'une suppression retenue. 7 tests. | `main` @ `d5e5fb1` |

**Deux points de conception qui méritent d'être retenus :**

1. **`trust proxy` était absent du relais.** Sans lui, `req.ip` vaut l'IP de Traefik pour
   *tout le monde* : le journal aurait été écrit, aurait eu l'air de fonctionner, et
   n'aurait distingué personne. Le `X-Forwarded-For` brut est conservé **en plus**, pour
   qu'une erreur de configuration ne détruise pas la seule donnée qui identifie l'appelant.
2. **La garde retient les suppressions mais laisse toujours passer les ajouts.**
   L'asymétrie est voulue : un ajout élargit la couverture, une suppression la retire — et
   un refus d'allowlist ne laisse aucune trace côté envoi. En cas de doute, on penche du
   côté où les SMS partent. Un appelant qui veut vraiment supprimer en masse le déclare.

⚠️ **La garde ne remplace pas le journal** — et c'est bien le journal qui a nommé l'appelant
dix minutes après sa mise en ligne (voir plus haut). La garde, elle, a empêché le dégât dans
la même heure. Les deux étaient nécessaires : l'une protège, l'autre explique.

🔴 **Un piège payé pendant ce déploiement.** La migration a d'abord été générée avec
`prisma migrate diff --script > fichier 2>&1` : la bannière d'information de Prisma
(encadré semi-graphique) s'est retrouvée **dans le SQL**, et `migrate deploy` a échoué au
démarrage du conteneur. Sans le smoke-boot jetable, la passerelle SMS serait partie en
crash-loop — c'est-à-dire le repli du coupe-circuit moteur hors service. *Ne jamais rediriger
stderr dans un fichier destiné à être exécuté.* La migration en échec a dû être marquée
`--rolled-back` avant de rejouer (elle n'avait rien appliqué : `applied_steps_count = 0`).

### Correctifs proposés

0. 🔴 **Rendre attribuable toute mutation de l'allowlist, côté passerelle — LE préalable.**
   Journaliser l'auteur de `PUT /v1/allowlist/sync` et de `DELETE /v1/allowlist/:phone` : tenant, IP
   source, nombre d'entrées poussées, diff appliqué. **Une ligne par appel, y compris à diff vide.**
   Sans ça, « qui efface 25 numéros plusieurs fois par jour » restera sans réponse au prochain
   passage comme à celui-ci. *(Dépôt `vizyo-texto`, hors périmètre d'écriture de cet audit.)*
1. ⚪ **Rendre l'exécution de la réconciliation prouvable.** *Partiellement périmé au 10/08 : ce
   passage a prouvé qu'elle s'exécute.* Garde sa valeur pour distinguer « a tourné, rien à faire »
   de « n'a pas tourné », mais **n'est plus le préalable** — le nº 0 l'a remplacé.
2. **Alerter sur l'ÉTAT, pas seulement sur la RÉPARATION.** La ligne actuelle se déclenche quand la
   dérive est **déjà corrigée** : elle raconte le passé. Ce qui manque est une vérification
   d'inventaire — `AllowlistService.status()` expose déjà `missing[]` — remontée quand un numéro
   reste absent **entre deux réconciliations**. Un boîtier dont la SIM sort de l'allowlist doit être
   visible pendant qu'il l'est, pas une fois rentré.
3. **Refuser de couper un moteur dont le repli SMS n'est pas joignable.** Le repli existe parce que
   le canal TCP n'est pas fiable, et [TRK-014](#trk-014) prouve qu'aucun boîtier n'a jamais accusé
   réception d'une commande. Un coupe-circuit dont les deux voies sont muettes doit le **dire** au
   moment de la demande, pas être tenté dans le vide.
4. **Tracer le refus côté passerelle.** `assertDestinationAllowed` lève un `ForbiddenException` sans
   rien persister. Écrire une ligne `messages` en statut refusé (ou un compteur par tenant) donnerait
   à ce défaut la trace qu'il n'a pas — dans le dépôt `vizyo-texto`, hors périmètre de cet audit.

### ⚠️ Ne pas « corriger » en désactivant le mode allowlist

Passer `allowlistMode` à `false` ferait disparaître les 403 en une ligne — et ouvrirait l'envoi de
SMS à n'importe quel numéro, sur une passerelle facturée à l'envoi. L'allowlist est une garde de
dépense et d'abus, elle fait son travail. *Le témoin n'est pas le défaut : ce qui manque est la
synchro, pas la serrure.*

### ⚠️ Ne pas non plus se contenter d'un `PUT /sync` manuel

Il rétablirait l'état sans rien apprendre du mécanisme — et le régime B le rend en plus **inutile** :
le cron le fait déjà tout seul, six fois par jour, et l'effacement revient derrière. `createdAt` des
entrées `synced` reste la **mesure en cours** : ne pas la perturber par une synchro manuelle, c'est
le seul témoin de la prochaine suppression.

### Vérification après correctif

**Le vrai test porte sur l'attribution, pas sur le compteur.** Un correctif est acquis quand :

1. chaque `PUT /v1/allowlist/sync` et chaque `DELETE /v1/allowlist/:phone` laisse une ligne nommant
   son appelant, **y compris à diff vide** — c'est ce qui permettra de désigner le coupable ;
2. **puis seulement** `AllowlistService.status().missing` reste vide sur 7 jours consécutifs.

Faire (2) sans (1) est le piège : l'écran se viderait, le trou continuerait de se rouvrir entre deux
lectures, et on aurait reproduit exactement la cécité qu'on vient de mettre deux passages à percer.
*Un garde-fou dont on ne peut pas prouver qui le désarme ne garde rien.*

### 🔴 Mise à jour du 2026-08-11 — la garde tient, l'appelant tourne la nuit, la clé n'a pas bougé

**La garde a tenu six h:25 d'affilée.** `createdAt` des 25 entrées `synced` vaut toujours
`2026-08-10 14:25:00.78`, et `n_dead_tup` reste à 25 pour un `last_autovacuum` du 10/08 13:25 :
**aucune suppression depuis la veille**. Le correctif « exécution prouvable » fonctionne aussi —
5 `allowlist_reconciled` en base système (20:25 → 00:25), un par heure, y compris à zéro.

**L'appelant, lui, n'a pas cessé.** `allowlist_audit_logs`, 11 appels tracés en 6 h :

| Heure UTC | 19:25 | 20:25 | 21:25 | 22:25 | 23:25 | 00:25 |
|---|---|---|---|---|---|---|
| `172.18.0.1` (Tracky, VPS) — 41 numéros | ✅ `ok` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `82.67.153.51` (hors VPS) — **1** numéro | 🛑 `removals_blocked` | — | 🛑 | 🛑 | 🛑 | 🛑 |

**Cinq tentatives d'effacement de masse retenues**, motif identique : « 25 suppression(s) au-delà du
plafond ». Même préfixe de clé d'API dans les deux colonnes.

### 🔄 Le discriminant posé la veille est tranché — et il retourne l'hypothèse

Le test daté nº 2 proposait : *« zéro ligne la nuit orienterait vers un appelant actif aux heures
ouvrées — un poste de développement plutôt qu'un automate »*. L'appelant a frappé à **21:25, 22:25,
23:25 et 00:25 UTC**, soit 23:25 → 02:25 heure de Paris. **La machine tourne la nuit** ; un seul
créneau manque (20:25). L'irrégularité observée les 09 et 10/08 ne s'explique donc **pas** par des
horaires de bureau.

> ⚠️ **Et l'instrument proposé par cette fiche s'est périmé dans le même geste.** Compter les lignes
> `sms-allowlist` ne mesure plus rien : zéro ligne depuis le 10/08 14:25, mais **deux causes se
> superposent** — la garde empêche le trou, et l'alerte est passée par épisode. Un zéro qui a deux
> explications n'est pas une mesure. Lire `allowlist_audit_logs`, et rien d'autre.

### 🔴 Défaut résiduel, constaté ce jour — les blocages sont invisibles depuis Tracky

Les cinq suppressions retenues n'apparaissent **nulle part** dans Tracky : ni `error_logs`, ni
journal système, ni écran. Elles n'existent que dans `allowlist_audit_logs`, côté passerelle,
qu'aucune interface ne lit. La remontée « suppression retenue » livrée le 10/08 ne se déclenche que
sur la réponse à l'appel **de Tracky** — et Tracky n'est jamais bloqué, puisque c'est lui la
victime. *Un garde-fou qui protège en silence redevient invisible dès qu'on cesse de l'interroger
à la main.*

**Correctif à ajouter (nº 5) :** remonter à Tracky les blocages **subis par les autres appelants**.
Le plus simple sans coupler les deux dépôts : que la réponse de `PUT /v1/allowlist/sync` porte le
nombre de blocages survenus depuis le dernier appel du tenant, et que la réconciliation en fasse une
ligne d'alerte. Une garde dont on ne voit pas les déclenchements finit par être retirée comme
inutile.

### 🗓️ Test daté — au passage du 2026-08-12

**La clé a-t-elle été rotationnée ?** Relire `allowlist_audit_logs` : des appels depuis
`82.67.153.51` portant le même préfixe de clé signifient que la cause est intacte et que seule la
garde travaille.
**Condition d'échec écrite** : recompter les blocages sans dire si la clé a changé n'apprendrait
rien de plus que ce passage.

### ✅ 2026-08-13 — VERDICT DU TEST DATÉ : la clé n'a PAS été rotationnée

`allowlist_audit_logs`, cumul depuis la mise en ligne du journal (10/08 19:25) :

| Appelant | Préfixe de clé | Résultat | Appels | Dernier |
|---|---|---|---|---|
| `172.18.0.1` — Tracky, sur le VPS | **`vtx_48fe`** | `ok` | **55** | 13/08 00:25 |
| `82.67.153.51` — hors VPS | **`vtx_48fe`** | 🛑 `removals_blocked` | **22** | **12/08 18:25** |

**Le préfixe est identique dans les deux colonnes.** La cause est intacte ; seule la garde
travaille — et elle travaille bien : les 25 entrées `synced` portent toujours
`createdAt = 2026-08-10 14:25:00.78`, soit **62 heures sans une seule suppression**.

### ⚠️ Un fait nouveau qu'il ne faut PAS lire comme une bonne nouvelle

L'appelant extérieur **n'a plus frappé depuis le 12/08 18:25** — six créneaux h:25 d'affilée sans
lui, dont toute la nuit. Tentant d'y voir un arrêt.

**Trois raisons de ne pas le conclure.** Il s'était déjà tu entre 19:25 et 21:25 le 10/08 ; le
11/08 a établi qu'il tourne *aussi* la nuit (21:25, 22:25, 23:25, 00:25 UTC), donc l'irrégularité
n'a pas d'horaire ; et surtout la clé qu'il porte est toujours valide. **Une machine éteinte n'est
pas une clé révoquée** — elle se rallume, la clé pas.

> Le seul geste qui ferme ce sujet reste humain et inchangé depuis le 10/08 : **révoquer et
> rotationner `vtx_48fe`**, puis donner à l'environnement de développement son propre tenant. La
> garde empêche le dégât ; elle n'a jamais prétendu supprimer la cause.

🗓️ **Test daté au 2026-08-14 :** relire le préfixe de clé dans `allowlist_audit_logs`. S'il a
changé, la cause est fermée et la garde devient une ceinture de sécurité. S'il n'a pas changé,
**ne pas se contenter de recompter les blocages** : compter aussi le nombre de jours écoulés depuis
que le geste est écrit — c'est ce chiffre-là qui mesure le risque, pas le compteur de la garde.

### 🔴 2026-08-14 — VERDICT : la clé n'a pas changé, **et l'appelant est REVENU**

| Mesure | 13/08 | **14/08** |
|---|---|---|
| Préfixe de clé, appelant VPS (`172.18.0.1`) | `vtx_48fe` | **`vtx_48fe`** |
| Préfixe de clé, appelant extérieur (`82.67.153.51`) | `vtx_48fe` | **`vtx_48fe`** — identique |
| Appels `ok` cumulés | 55 | **82** |
| Tentatives d'effacement de masse **retenues** | 22 | **24** |
| Dernière frappe de l'appelant extérieur | 12/08 18:25 | **13/08 23:24:58** |
| Ancienneté des 25 entrées (`createdAt` inchangé) | 62 h | **86 h** |

**La mise en garde d'hier était juste, et elle a été payée en un jour.** Le silence de six créneaux
n'était pas un arrêt : l'appelant a refrappé **deux fois le 13/08**, à 22:24:59 et 23:24:58, avec
la même clé et le même motif (`25 suppression(s) au-delà du plafond de 5`).

> *Le silence d'un attaquant se lit comme une absence de mesure, jamais comme une absence de
> menace. Le compteur de la garde ne mesure pas le risque — il mesure combien de fois le risque
> s'est présenté.*

**Le chiffre qui mesure le risque, comme demandé par le test :** le geste est écrit depuis le
**10/08**. Cela fait **4 jours** qu'une clé de production compromise est valide, sur une machine
extérieure qui frappe encore.


### 2026-08-16 — 6ᵉ jour de clé vivante, et l'appelant se tait depuis 32 h

| | 14/08 | 15/08 | **16/08** |
|---|---|---|---|
| Blocages cumulés (`outcome = removals_blocked`) | 24 | 35 | **35** |
| Frappes dans la journée écoulée | 2 | 11 | **0** |
| `tenants.apiKeyPrefix` | `vtx_48fe` | `vtx_48fe` | **`vtx_48fe`** |
| `tenants.updatedAt` | 05/06 | 05/06 | **05/06** |
| Jours depuis que le geste est écrit | 4 | 5 | **6** |

Dernière tentative bloquée : **14/08 17:25:07** — soit **31,8 h de silence**. La clé, elle, n'a pas
bougé : `tenants.updatedAt` est resté au **05/06**, ce qui **exclut** toute rotation.

**Condition d'échec du test daté : NON déclenchée.** Les **42** entrées d'`allowlist_entries`
portent toujours leur date de création du **10/08 14:25:00.78**, soit **130,8 h sans une seule
suppression**. La garde tient. Appels normaux : **127** au cumul, **24/jour**, cadence inchangée.

> **Ce zéro est un fait, pas une rémission — et le référentiel l'a déjà payé deux fois.** Le 13/08,
> l'appelant s'était tu pendant six créneaux ; le rapport avait refusé d'y lire une clé révoquée, et
> **il a refrappé le lendemain**, puis onze fois le 14/08. *Un compteur de frappes mesure ce que
> l'attaquant fait, jamais ce qu'il peut faire.* Tant que `apiKeyPrefix` vaut `vtx_48fe`, l'accès
> existe, qu'on l'exerce ou non — et c'est `tenants.updatedAt`, pas le compteur de blocages, qui
> dit si le geste a été fait.

**Action inchangée et toujours humaine : révoquer et rotationner la clé d'API de la passerelle SMS.**

#### 🔧 Piège d'outillage : la colonne `action` ne distingue rien

`SELECT action, count(*) FROM allowlist_audit_logs GROUP BY 1` rend **une seule valeur** — `sync`,
162 lignes — et donne l'impression qu'aucun blocage n'est enregistré. La colonne qui sépare un
blocage d'un appel normal est **`outcome`** : `ok` = 127, `removals_blocked` = 35.

Deux autres noms, à écrire une fois pour toutes (base **`vizyo_texto`**, conteneur
**`texto-postgres`**, utilisateur **`texto`**) :

| Ce qu'on écrit spontanément | Le vrai nom |
|---|---|
| `sms_allowlist` | **`allowlist_entries`** |
| `allowlist_audit_logs.actorIp` | **`allowlist_audit_logs.ip`** |

*Une colonne constante ressemble à une absence de donnée. C'est la mauvaise colonne, pas la
mauvaise table — et `information_schema` les sépare en une requête.*

---

## TRK-018

**Signature** — *(absence de preuve, pas une ligne d'erreur)* `engine_control_commands | status =
SENT | ackedAt IS NULL | lastError = "Envoyé via SMS (TCP indisponible)"` + `messages | status =
queued` — **définitivement, des deux côtés**
**Statut : 🟠 CORRECTIFS 1 À 3 LIVRÉS ET DÉPLOYÉS le 2026-08-24** (PR #129 + [TRK-026](#trk-026)) ·
**correctif nº 4 non livré · preuve terrain en attente des coupes de 18:00 UTC** ·
découvert 2026-08-11 · **re-mesuré le 24/08 : 313 commandes `SENT`, 307 de plus de 24 h, 0 acquittée**

---

## 🟠 2026-08-24 — les trois quarts du chemin, et la moitié de la preuve

### La mesure refaite le jour du correctif — la file continuait de grossir

| | 13/08 | **24/08** |
|---|---|---|
| Commandes moteur `SENT` | 230 | **313** |
| …de plus de 24 h | 224 | **307** |
| …acquittées | 0 | **0** |
| Reparties en SMS | 112 | **153** |

*Le test daté du 12/08 prédisait « stable ou croissant tant qu'aucune fin de vie n'existe ».
Onze jours plus tard, +83.*

### Ce qui est livré

**Correctif nº 1 — l'accusé de remise. LE préalable, livré le matin même** par
[TRK-026](#trk-026) : les webhooks `sms:sent` / `sms:delivered` / `sms:failed` sont abonnés côté
capcom6, et Tracky va lire l'état auprès de la passerelle. *Sans lui, aucune des questions
suivantes n'était décidable — la fiche le disait, et c'est ce qui a dicté l'ordre de la journée.*

**Correctif nº 2 — la fin de vie.** Statut neuf `SENT_UNCONFIRMED`, échéance **purement
temporelle** (`ENGINE_COMMAND_EXPIRY_MIN`, défaut 30 min), balayage toutes les 10 min.

> ⚠️ **Distinct de `FAILED`, et ce n'est pas un détail de vocabulaire.** « A échoué » et « nul ne
> sait » ne sont pas la même information. Le coupe-circuit est une garde de sécurité : *une garde
> qu'on croit armée sans preuve est plus dangereuse qu'une garde qu'on sait muette.*

⚠️ **L'échéance ne regarde QUE l'horloge** — leçon de [TRK-007], déjà payée. La conditionner à un
état du boîtier la ferait retomber dans le piège qu'elle prétend fermer : on attendrait une
confirmation qui n'arrive jamais pour fermer une ligne ouverte faute de confirmation. **Un test
verrouille le `where`** : `status`, `ackedAt`, `sentAt`, rien d'autre.

⚠️ **`ackedAt` n'est JAMAIS écrit.** Marquer ces commandes acquittées d'office ferait disparaître
les 313 lignes et supprimerait la seule trace de la question. *Le témoin n'est pas le défaut.*

**Correctif nº 3 — le canal sort du champ d'erreur.** Colonne `channel` (`TCP` / `SMS`). Les
commandes neuves l'écrivent et laissent `lastError` vide.

⚠️ **Rétro-remplissage volontairement conservateur** : seules les **153** lignes portant le
marqueur SMS deviennent `channel = 'SMS'`. Les **5 191** autres restent `NULL` — *inconnu*, qui
est la vérité. Les marquer `TCP` par défaut fabriquerait une donnée que personne n'a observée, et
*un chiffre faux qui persiste finit par être cru*. Et `lastError` **n'est pas effacé** : détruire
une donnée pour corriger un **nom** serait pire que le nom.

### 🔑 Le câblage front — cinq points, et c'est le dernier qui comptait

Enum Prisma · DTO partagé · événements WS · service web · **et DEUX rendus**. Sans le dernier, le
nouvel état serait tombé dans un `default` muet et se serait affiché **`SENT_UNCONFIRMED` brut à
l'écran**. Le ton retenu est *attente*, pas *alerte* : **ce n'est pas une panne.**

### ⚠️ Ce qui N'EST PAS livré, et ce qui n'est pas prouvé

- **Correctif nº 4 (écran « immobilisations non confirmées ») : non livré.** Les trois autres
  rendent l'état lisible en base ; l'écran reste à faire.
- **La vérification prescrite n'a pas pu s'exercer.** Elle demande qu'« au moins un message porte
  un état postérieur à `queued` » : aucun SMS moteur n'est parti depuis l'abonnement des webhooks
  à 08:20. **Les coupes de 18:00 UTC seront le premier test réel de la chaîne complète.**

🗓️ **Test daté — au prochain audit.** Deux conditions **simultanées**, et la seconde est le
garde-fou : le nombre de commandes `SENT` de plus de 24 h doit tendre vers 0, **sans** que le
nombre de coupures demandées ait baissé. *Si les deux tombent ensemble, on a supprimé la
fonctionnalité, pas le défaut.*

> ### Un véhicule est immobilisé et redémarré chaque nuit par un canal dont personne, à aucun étage, ne peut dire s'il transmet.

### Constat — mesuré des deux côtés de la passerelle

| Mesure | Valeur | Où |
|---|---|---|
| Commandes moteur reparties en SMS | **112** depuis le 2026-06-03 | `engine_control_commands.lastError LIKE 'Envoyé via SMS%'` |
| …dont acquittées (`ackedAt`) | **0 — sans exception** | idem |
| Sur les 7 derniers jours | **24**, sur **12 véhicules** | idem |
| Statut final de ces commandes | `SENT`, **définitivement** | idem |
| Messages `engine-control-fallback` côté passerelle | **112**, tous en **`queued`** | `messages.context->>'source'` |
| Messages sortants ayant jamais dépassé `queued` (sur 310 depuis le 03/06) | **0** | `messages` |
| Seuls états terminaux jamais écrits | **29 `failed`**, tous le 2026-06-09 | `messages` |

**Les deux comptages concordent** sur la fenêtre de 7 jours — 24 côté Tracky, 24 côté passerelle.
Sur cette période, aucun SMS n'a donc été perdu **avant** la passerelle : le trou d'allowlist de
[TRK-017](#trk-017) n'a rien avalé ici. C'est un résultat négatif utile, et il vaut d'être écrit :
il évite d'attribuer à cette fiche ce qui appartient à l'autre.

### Ce qui est démontré, et ce qui ne l'est pas

**Démontré :** aucune des deux couches ne porte de preuve de remise. Tracky écrit `SENT` et n'y
revient jamais ; la passerelle écrit `queued` et n'y revient jamais. Le `providerId` est bien
renseigné — la passerelle a donc remis le message à un fournisseur — mais **aucun accusé de remise
n'a jamais été enregistré, pour aucun message, depuis la création de la table**.

**Non démontré :** que les SMS n'arrivent pas. Ce constat est une **cécité**, pas une panne. C'est
précisément ce qui l'a laissée passer dix semaines : un canal muet et un canal sain se ressemblent
exactement quand rien ne les mesure.

⚠️ **Piège écarté en cours d'enquête.** Le canal entrant de la passerelle est silencieux depuis le
2026-07-13 (dernier message `IN`, dernier `webhook_deliveries`). Tentant d'y voir une réception
cassée. **Faux :** les 230 entrants étaient les réponses à la campagne de provisionnement
(202 messages `provision`), qui s'est terminée **le même jour**. Rien ne prouve que la réception
soit en panne ; rien ne prouve qu'elle marche. *Une coïncidence de dates n'est pas un mécanisme.*

### Le cas le plus net — EY-613-MF, quatorze immobilisations par semaine sans confirmation

| | |
|---|---|
| Coupures nocturnes reparties en SMS (7 j) | **7 CUT + 7 RESTORE**, à 18:00 et 03:00 UTC |
| Acquittées | **0** |
| Pourquoi le TCP est indisponible | Le boîtier n'émet qu'**une trame par heure** à l'arrêt (heartbeat Coban ACC OFF) |
| `confirmationExpected` | `false` — le système **sait** qu'il n'attendra rien |

Ce véhicule est coupé chaque soir et redémarré chaque matin par un canal sans retour. Le
`confirmationExpected = false` est honnête sur l'intention, mais il transforme une absence de preuve
en état normal : plus rien ne distingue « le SMS est passé » de « le SMS est parti dans le vide ».

### Défaut aggravant — le champ qui porte l'information est un champ d'erreur

`lastError` contient « Envoyé via SMS (TCP indisponible) », qui n'est pas une erreur mais une
**information de routage**. Famille **mensonger** au sens du §7 : un lecteur qui trie sur
`lastError IS NOT NULL` compte 112 échecs qui n'en sont pas. C'est exactement le défaut du
`outcomeReason` dénoncé par [TRK-007](#trk-007) — le champ dont le nom annonce une chose et le
contenu en livre une autre.

### Défaut jumeau — une commande moteur n'a pas de fin de vie

Sur les 7 derniers jours, **49 commandes** restent `SENT` sans acquittement (31 `CUT`, 18 `RESTORE`),
dont 24 par le repli SMS et 25 par TCP. Depuis avril, **218** au total. C'est la même famille que
[TRK-007](#trk-007) sur `fix_continuous` : rien ne solde jamais ces lignes, et la file n'est plus une
file. La leçon de TRK-007 s'applique telle quelle — **l'échéance doit être purement temporelle**, et
surtout pas conditionnée à une confirmation qui, ici comme là, n'arrive jamais.

*(Sur ces 25 non-SMS, 20 concernent FZ-862-VY et FS-253-HR — les deux véhicules sans fix GPS de
[TRK-001](#trk-001), dont la chute d'ignition ne peut pas être observée. Ce n'est pas un défaut
supplémentaire : c'est la même cause matérielle, vue depuis une autre table.)*

### Correctifs proposés

1. **Faire remonter l'accusé de remise du fournisseur — LE préalable.** Tant qu'un message reste
   `queued` à vie, aucune des questions suivantes n'est décidable. Si le fournisseur n'expose aucun
   retour, l'écrire noir sur blanc et passer au nº 2 : ce qu'on ne peut pas mesurer, on doit au moins
   cesser de le présenter comme acquis. *(Dépôt `vizyo-texto`, hors périmètre d'écriture de cet
   audit.)*
2. **Donner une fin de vie aux commandes moteur.** Échéance **purement temporelle** (proposition :
   30 min), close en `SENT_UNCONFIRMED` — un état distinct de `FAILED`, parce que « nul ne sait » et
   « a échoué » ne sont pas la même information. Voir la leçon de [TRK-013](#trk-013) : le défaut
   n'était pas la clôture, c'était de conclure sans comparer.
3. **Sortir l'information de routage du champ d'erreur.** Un champ `channel` (`TCP` / `SMS`) dit ce
   que `lastError` raconte aujourd'hui, sans mentir sur sa nature.
4. **Rendre l'état lisible.** Une section « immobilisations non confirmées » — un compteur des
   commandes `SENT` de plus de 24 h, par véhicule. Aujourd'hui l'information existe en base et
   n'apparaît sur aucun écran.

### ⚠️ Ne pas « corriger » en marquant ces commandes acquittées d'office

Écrire `ackedAt` à l'envoi ferait disparaître les 112 lignes et supprimerait la seule trace de la
question. C'est le contraire d'un correctif : le coupe-circuit est une garde de sécurité, et une
garde qu'on croit armée sans preuve est plus dangereuse qu'une garde qu'on sait muette.
*Le témoin n'est pas le défaut.*

### ⚠️ Ne pas non plus conclure que le repli SMS est mort

Rien ici ne le montre. Trois canaux se cumulent pour rendre le coupe-circuit invérifiable — le TCP
sans ACK ([TRK-014](#trk-014), prouvé), l'allowlist qui refusait sans trace ([TRK-017](#trk-017)),
et l'absence d'accusé de remise (cette fiche) — mais **aucun des trois ne prouve qu'une coupure
n'a pas eu lieu.** Ce qui est établi est qu'aucun d'eux ne peut prouver qu'elle a eu lieu.

### Vérification après correctif

1. Au moins un message porte un état postérieur à `queued`, **ou** le journal montre des échecs de
   remise datés — les deux résultats sont utiles, et le second autant que le premier ;
2. **et** le nombre de commandes moteur `SENT` de plus de 24 h tend vers 0, **sans** que le nombre de
   coupures demandées ait baissé. Si les deux tombent ensemble, on a supprimé la fonctionnalité, pas
   le défaut.

### 🗓️ Test daté — au passage du 2026-08-12

Compter les `engine_control_commands` restées `SENT` au-delà de 24 h. Le chiffre doit être **stable
ou croissant** tant qu'aucune fin de vie n'existe. **Condition d'échec :** s'il baisse sans qu'aucun
correctif ait été livré, c'est qu'un autre chemin les efface — et il faut le trouver **avant** tout
le reste, parce qu'il rendrait toute mesure ultérieure fausse.

### ✅ 2026-08-13 — VERDICT DU TEST DATÉ : PASSÉ

| Mesure | 12/08 | **13/08** |
|---|---|---|
| Commandes moteur `SENT` (total) | 225 | **230** |
| …de plus de 24 h | 219 | **224** |
| …acquittées | 0 | **0** |
| `SENT` sur 7 jours | — | **40** |

**Croissant.** Aucun chemin caché n'efface ces lignes ; la condition d'échec n'est pas déclenchée,
et les mesures futures de cette fiche restent comparables. C'est un résultat modeste et il vaut
d'être écrit : *un compteur dont on a vérifié qu'il ne fuit pas est un compteur sur lequel on peut
bâtir.*

**Le second volet tient aussi, côté passerelle :**

| Mesure | 11/08 | **13/08** |
|---|---|---|
| Messages `queued` | 307 | **314** |
| Messages ayant dépassé `queued` | 0 | **0** |
| Seuls états terminaux jamais écrits | 29 `failed` (09/06) | **29 `failed` (09/06)** |

Le message le plus récent, parti le **12/08 à 18:00**, est encore `queued`. **Toujours aucun accusé
de remise, pour aucun message, depuis la création de la table.** Le repli SMS du coupe-circuit
compte désormais **116** commandes moteur (112 le 11/08), dont **15 sur les 7 derniers jours**,
**0 acquittée**.

🗓️ **Test daté reconduit au 2026-08-14 :** même mesure, même condition d'échec. Et un second volet,
gratuit : si un message quitte enfin `queued`, la question nº 1 de cette fiche est décidable — et
c'est la seule qui débloque les trois suivantes.


### 2026-08-16 — test daté PASSÉ pour la 5ᵉ fois

| Mesure | 11/08 | 13/08 | 14/08 | 15/08 | **16/08** |
|---|---|---|---|---|---|
| `engine_control_commands` `SENT` > 24 h | 219 | 224 | 231 | 236 | **242** |
| Passerelle : messages `queued` | — | 314 | 317 | 318 | **326** |

Strictement croissant sur cinq mesures : rien ne les efface, rien ne les solde. Le dernier message
empilé date du **15/08 18:01** ; les seuls états terminaux jamais atteints restent les **29** échecs
du **09/06** et les 230 `received` arrêtés au **13/07**.

> Dix semaines et 326 messages plus tard, **aucun message sortant n'a jamais dépassé `queued`**. Le
> constat n'est toujours pas « les SMS n'arrivent pas » — c'est que rien, nulle part, ne peut le
> dire. Un véhicule est coupé et redémarré chaque nuit par ce canal.

### 🔴 2026-08-17 *(2ᵉ passage)* — l'instrument censé signaler cette cécité est lui-même inerte → [TRK-026](#trk-026)

Test daté **passé une 7ᵉ fois** : `engine_control_commands` `SENT` > 24 h = **257** (242 · 254 ·
**257**) ; passerelle **334** `queued` (326 · 328 · **334**). Toujours strictement croissant, toujours
aucun état terminal.

**Mais le 2ᵉ passage du 17/08 trouve la pièce qui manquait à cette fiche.** Le correctif nº 1
ci-dessus — « faire remonter l'accusé de remise » — était présenté comme le préalable à tout. Il l'est
toujours, **et il ne suffira pas** :

- côté Tracky, **aucun code ne met jamais à jour `sms_logs.status`** (`grep -rn "smsLog.update"
  apps/api/src` → zéro occurrence). La table n'a pas de chemin d'écriture pour un second état, donc
  même des DLR disponibles ne seraient enregistrés nulle part ;
- et `send()` déduit son `ok` de la réponse **synchrone** de la passerelle, ce qui rend aveugle
  **toute** sonde bâtie dessus — dont la « preuve de vie » hebdomadaire de [TRK-026](#trk-026), qui
  n'a jamais pu écrire une seule ligne d'erreur depuis sa mise en service.

> **Ce que ça change pour cette fiche.** Le §« Ne pas conclure que le repli SMS est mort » énumérait
> trois canaux qui rendent le coupe-circuit invérifiable. **Il y en a un quatrième, et c'est le pire :
> le canal de surveillance lui-même.** Les trois premiers ne pouvaient pas prouver qu'une coupure a
> eu lieu ; celui-là affirme activement que tout va bien. *Une cécité qu'on connaît est un risque ;
> une cécité qui rend « OK » est un piège.*

**Le cas EY-613-MF, mesuré ce passage :** `RESTORE` émis le **17/08 à 03:00:00.978**, SMS
`resume123456` `queued` depuis **03:00:03**, boîtier **`OFFLINE` et sans fix GPS depuis 07:20:51**. Sur
3 jours : 7 commandes moteur, 0 acquittée, toutes en repli SMS.

🗓️ **Test daté reconduit au prochain passage**, avec un second volet emprunté à TRK-026 : si un
message quitte enfin `queued`, **vérifier dans la même minute que `sms_logs` l'a enregistré côté
Tracky**. Un DLR reçu par la passerelle mais non répercuté laisserait cette fiche exactement où elle
est, en donnant l'illusion du contraire.

---

## TRK-009

**Signature** — `TRACKER_OFFLINE | lastSeenAt IS NULL | vehicleId IS NULL`
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 3 boîtiers sur 6 · 2026-08-03
*(Le comptage brut reste 6 dans la collecte, pour rester comparable ; l'écran, lui, en affiche 3.)*

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
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04 — `ERROR_LOGS_RETENTION_DAYS=90`)* · 2026-08-03

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

## TRK-011

**Signature** — *(absence d'alerte)* `gps-integrity | AUCUNE LIGNE | perte GPS ≥ <DURÉE> dans une
zone morte `CONFIRMED_BENIGN``
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04, vérifié en prod le 05/08)* · 2 véhicules qui étaient
définitivement muets · découvert 2026-08-04

> ### ⚠️ Rectification du 2026-08-06 — la dédup est par **24 h**, pas par épisode
>
> Cette fiche et le commentaire du détecteur annonçaient « une ligne par dépassement ». C'est
> faux : `alerts.service.ts:156` fixe `dedupWindowMs = 24 h`, et c'est **volontaire et
> documenté** — la dédup ignore l'acquittement, sinon acquitter l'alerte (le geste normal pour
> vider le centre) en ferait recréer une au tick suivant.
>
> Conséquence pratique : **un épisode qui dure produit une ligne par jour.** Les deux lignes des
> dernières 24 h (FS-253-HR le 05/08 à 13:10, FZ-862-VY à 19:45) sont les rappels quotidiens des
> deux premières, à 24 h et 5 min près — pas des doublons, et pas des épisodes nouveaux.
>
> Un audit qui aurait cru la fiche aurait ouvert une enquête pour rien. *Une fiche qui décrit un
> mécanisme doit être vérifiée sur le code, pas recopiée d'un passage à l'autre.*

> ### Ce défaut ne produit rien. C'est précisément le problème.

### Constat
`FS-253-HR` (`864035054757027`) est **vivant** — `lastSeenAt` et `lastNoFixAt` frais à la minute,
donc il émet activement des trames sans verrou GPS — et **sans position depuis 11,9 h**
(dernière position le 03/08 à 13:02). Il n'a produit :

- **aucune ligne `error_logs`** — jamais, sur les 30 jours de rétention ;
- **aucune alerte véhicule `GPS_LOST`** — aucune sur 10 jours pour cette plaque.

Il est passé sous tous les radars, alors qu'il coche exactement la définition du défaut que
[TRK-001](#trk-001) détecte pour d'autres véhicules.

### Cause racine
`gps-integrity.service.ts` interrompt le traitement **avant** toute création d'alerte dès que la
zone morte est confirmée bénigne :

```ts
if (zone && zone.status === GpsDeadZoneStatus.CONFIRMED_BENIGN) {
  suppressed++;
  continue;              // ← ni alerte flotte, ni ErrorLog
}
```

Il n'existe **aucun test sur la durée de la perte**. La confirmation opérateur porte sur un
**lieu** (« ce parking souterrain est normal »), mais elle est appliquée à un **épisode de durée
quelconque**.

> **En une phrase :** une antenne morte sur un véhicule garé dans son parking habituel serait
> strictement indistinguable d'un stationnement normal — et ne serait jamais signalée.

C'est le trou même que ce module a été écrit pour combler. Son en-tête cite l'incident **FS-253**
et le résume ainsi : « RIEN ne le signalait ». Le véhicule aujourd'hui silencieux est `FS-253-HR`.

### Périmètre — il s'élargit tout seul

| Zone | Véhicule | Statut | Étiquette | Épisodes | Depuis |
|---|---|---|---|---|---|
| `79a8d0f2…` | FS-253-HR | `CONFIRMED_BENIGN` | Parking souterrain (Toulouse) | 5 | 2026-07-15 |
| `879699a3…` | FZ-862-VY | `CONFIRMED_BENIGN` | Parking souterrain (Toulouse) | 1 | **2026-08-03 19:35** |

Le second verrou vient d'être posé : l'alerte de FZ-862-VY a été levée à 19:35:15 et **acquittée
à 19:36:32** — une minute plus tard, la zone était confirmée bénigne. Ce véhicule était à 7,4 h
sans fix au moment de la collecte, et **n'alertera plus jamais à cet endroit**.

Le nombre de véhicules muets **augmente d'un à chaque confirmation opérateur**. Or confirmer une
zone est précisément ce qu'on demande à l'opérateur de faire : le geste vertueux creuse le trou.

### Correctif proposé — borner la suppression, pas la supprimer
1. **Plafond de silence configurable** `GPS_DEADZONE_MAX_SILENCE_H` (défaut **24 h**). Au-delà,
   alerter malgré la zone bénigne. Calibrage vérifié sur les données du 2026-08-04 : un
   stationnement de nuit habituel (11,9 h) reste silencieux ; une perte de 26 h parle.
2. **Message distinct**, qui dit pourquoi il parle malgré la zone : « perte GPS de 26 h dans une
   zone pourtant confirmée normale (parking souterrain, 5 épisodes) — durée anormale, antenne à
   vérifier. » Un message qui ne dirait pas cela enverrait l'opérateur reconfirmer une zone déjà
   confirmée — et il la reconfirmerait, à raison.
3. **Dédup par épisode**, comme le reste du module : une ligne par dépassement, pas une par tick
   de 5 min.

### ⚠️ Pourquoi pas un seuil adaptatif tout de suite
La donnée n'existe pas. `GpsLossEvent` porte `lostAt` et `detectedAt`, **mais pas de
`recoveredAt`** : la durée réelle des épisodes passés n'est pas mesurable en l'état. Un seuil
calculé sur l'historique de la zone (plus fin que 24 h fixes) suppose d'abord d'enregistrer la
fin d'épisode. Le plafond fixe est le correctif applicable **aujourd'hui**.

### ⚠️ Ne pas retirer la suppression
C'est le cœur de la fonctionnalité « zones mortes » : ne plus re-signaler un parking habituel, ne
plus faire déplacer quelqu'un pour rien. *Corriger la borne, pas la garde.*

### Vérification après correctif
Une perte dépassant le plafond dans une zone bénigne produit une ligne — **et un stationnement de
nuit ordinaire n'en produit toujours aucune**. Le second point est le vrai test : un correctif qui
ferait re-crier la zone à chaque perte aurait annulé la fonctionnalité.

### 🔶 2026-08-17 — LE PLAFOND EST RETIRÉ SUR LES ZONES DE PARKING (décision du propriétaire)

Ce plafond a été juste pendant treize jours, puis il est devenu la **première source de bruit du
centre d'alerte**. Mesuré au 2ᵉ passage du 17/08 :

| Famille de ligne `gps-integrity` | Lignes | Sur |
|---|---|---|
| **« GPS perdu ANORMALEMENT LONG » (ce plafond)** | **18 / 27** | **2 véhicules** — FZ-862-VY (10) et FS-253-HR (8) |
| « GPS perdu … depuis 2 h » (première perte) | 9 / 27 | 6 véhicules distincts |

**Et les deux zones incriminées étaient DÉJÀ qualifiées `UNDERGROUND_PARKING` par un opérateur**,
statut `CONFIRMED_BENIGN`, `reviewedAt` renseigné. Autrement dit : un humain avait déjà répondu à la
question, et le plafond continuait de poser la question tous les jours.

> 🔑 **Le calibrage reposait sur une prémisse fausse.** Le commentaire du code disait : *« un
> stationnement de nuit ordinaire dure ~12 h ; 24 h laisse passer un week-end court »*. La cause
> réelle, donnée par le propriétaire, est le **parking souterrain** — où un véhicule reste garé un
> week-end, une semaine de congés, un mois. *Sur un parking, la durée d'une perte ne porte
> AUCUNE information ; le plafond ne mesurait donc rien qu'une durée de stationnement.*

**Ce qui change** (`gps-integrity.service.ts`) : `benignSilenceExceeded` gagne la condition
`!isParkingZone`. Une zone dont le libellé est `UNDERGROUND_PARKING` ou `COVERED_PARKING` silencie
**sans aucun plafond**.

**Ce qui NE change pas :** le plafond reste **intégralement actif** pour toute autre zone
`CONFIRMED_BENIGN`. Là, la confirmation dit « cet endroit est normal » sans dire pourquoi, et la
durée porte encore de l'information. Un test le verrouille explicitement sur une zone
`JAMMER_SUSPECTED` — sans lui, la levée du plafond aurait rouvert le trou en grand.

⚠️ **La contrepartie est réelle et elle a sa propre fiche : [TRK-027](#trk-027).** Une antenne morte
se tait au même endroit qu'un parking, donc elle sera silenciée dès la 2ᵉ occurrence. Le fait reste
**consultable** (journal du cron, `gps_sans_fix`, fiche véhicule), il n'est plus notifié. Le
garde-fou qui reste à écrire est **le contact**, pas une durée — et il exige de persister l'ACC des
trames `no_fix`, qui ne l'est pas.

*Cette fiche reste 🟢 CORRIGÉ : le trou qu'elle a bouché — une zone bénigne muette SANS BORNE et
sans qu'on sache pourquoi — l'est toujours. Ce qui est retiré, c'est son application à un cas où la
borne était structurellement fausse.*

---

## TRK-019

**Signature** — `livraison | (aucune ligne) | Un correctif vérifié en production disparaît d'un déploiement construit depuis une branche forkée avant lui`
**Statut : 🟢 CORRIGÉ le 2026-08-17** · 4 correctifs perdus puis rétablis · 2026-08-12 → 2026-08-17

> ### ✅ Fermeture du 2026-08-17 — la production est servie depuis `main`
>
> | | Constat |
> |---|---|
> | Images | `tracky-web` 16/08 15:59:24 · `tracky-api` 16/08 16:00:48 |
> | Conteneurs | recréés le **16/08 16:03:14**, `restarts=0` |
> | Branche servie | **`main`** @ `3fccee5` — le point de fork a disparu |
> | Commits perdus | `d5e5fb1` et `73440d8` vérifiés sur `main` (`git branch --contains`) |
>
> **Trois marqueurs sur trois mesurables sont présents** dans `/app/apps/api/dist/` :
> `reminderIntervalMs` (TRK-001), `episodeOpenedAt` (TRK-017), `armAckListener` (TRK-014). Le
> quatrième (TRK-002, côté web) n'est **pas mesurable** par cette méthode — voir la rectification
> d'instrument dans la fiche [TRK-002](#trk-002).
>
> **Et deux instruments le confirment par leur comportement :** les silences boîtier tracés passent
> de **81** (figés depuis le 11/08, 0 sur 355 commandes) à **100** ; la trace horaire de
> réconciliation de l'allowlist, muette depuis le 11/08, réécrit à chaque heure.
>
> ⚠️ **Réserve, et elle est le vrai reste-à-faire.** Le fait est réparé ; la **cause** ne l'est pas.
> Rien n'empêche une prochaine mise en ligne de repartir d'une branche forkée, et rien ne le
> signalerait. Correctif structurel proposé : **refuser de construire une image dont le `merge-base`
> avec `main` n'est pas `main` lui-même**, ou au minimum inscrire la branche et le `merge-base` dans
> une route de version lisible depuis l'application. Tant qu'il n'existe pas, cette fiche doit être
> **re-vérifiée à chaque nouvelle image** (test daté nº 4 du rapport du 17/08).

### Ce qui a été mesuré

| | |
|---|---|
| Images reconstruites | `tracky-api` 11/08 **22:34** · `tracky-web` 11/08 **22:31** UTC |
| Conteneurs recréés | 11/08 **22:37** UTC, `restarts=0` |
| Branche déployée | **`feat/depot-partage`** @ `36009cd` |
| Fork avec `main` | **`c3c2704`** — 2026-08-07 |
| Commits perdus | `d5e5fb1` et `73440d8` — 2026-08-10 au soir |

### Cause racine
La production n'est pas construite depuis `main` mais depuis la branche de fonctionnalité en
cours. Celle-ci a divergé le 07/08 : tout correctif livré sur `main` après cette date est
**absent de l'image**, et le redevient à chaque reconstruction. Ce n'est pas un `revert` — rien
n'a été annulé. C'est une branche qui n'a jamais eu le correctif, et qu'on déploie par-dessus une
image qui l'avait.

### Pourquoi rien ne l'a vu
Aucune des trois couches de surveillance ne peut voir ça :
- **`error_logs`** ne journalise que ce que le code émet ; un code absent n'émet rien ;
- **les compteurs** (commandes, trackers, cadence) mesurent le comportement des boîtiers, pas la
  version du logiciel ;
- **le `git log` local** montre `main`, où les correctifs sont bien présents.

Le défaut n'est visible que dans l'écart entre **ce qui est commité** et **ce qui est servi** —
et cet écart n'était vérifié nulle part de façon systématique.

### Portée — ce que chaque perte coûte
| Fiche | Ce qui n'est plus en ligne | Conséquence |
|---|---|---|
| **TRK-002** | confirmation à 2 échecs consécutifs | 🔴 régression : un hoquet mobile isolé re-produit une ligne. Test daté du 18/08 **illisible** |
| **TRK-001** | espacement des rappels admin | le rappel quotidien sans fin revient |
| **TRK-014** | `armAckListener` — le guetteur d'ACK | l'instrument qui prouvait le silence est **éteint** : `ackedAt` = 0 par absence de mesure, plus par mesure d'une absence |
| **TRK-017** | trace inconditionnelle + alerte par épisode | garde côté Tracky perdue. ⚠️ **La garde côté passerelle SMS est un autre service et tient** (39 h sans ligne) |

`f7896d9` (les neuf correctifs du 04/08) est **présent** : ils sont antérieurs au fork.

### Correctif proposé
1. **Reporter `d5e5fb1` et `73440d8` sur la branche en ligne** (`cherry-pick`, ou fusionner `main`
   dans `feat/depot-partage`), puis reconstruire. Les deux commits ne touchent que
   `gps-integrity`, `sms/allowlist`, `api-fetch` et `tracker-fix-mode` — aucun recouvrement avec
   le travail « espace dépôt » de la branche.
2. **Décider ce que la production suit.** Déployer une branche de fonctionnalité est un choix
   possible ; le faire sans rebaser sur `main` en fait un piège permanent.

### Vérification — sur les artefacts SERVIS, avec témoin
Un `grep` vide peut vouloir dire « absent » ou « mauvais chemin ». Chaque marqueur se cherche avec
une chaîne dont on sait qu'elle **doit** être là :

```bash
docker exec tracky-web sh -c 'grep -rl consecutiveTransportFailures /usr/share/nginx/html/'   # TRK-002
docker exec tracky-web sh -c 'grep -rl "Rafraichissement de session" /usr/share/nginx/html/'  # témoin
docker exec tracky-api sh -c 'grep -rl reminderIntervalMs /app/apps/api/dist'                 # TRK-001
docker exec tracky-api sh -c 'grep -rl "ANORMALEMENT LONG" /app/apps/api/dist'                # témoin
docker exec tracky-api sh -c 'grep -rl episodeOpenedAt /app/apps/api/dist'                    # TRK-017
docker exec tracky-api sh -c 'grep -rl armAckListener /app/apps/api/dist'                     # TRK-014
```

🗓️ **Test daté au 2026-08-12, ~09:25 UTC.** Sous le code restauré (dédup 24 h), une ligne
`error_logs` doit **réapparaître** pour FZ-862-VY en même temps que son alerte flotte quotidienne.
*Condition d'échec : si aucune ligne admin n'apparaît, la régression n'est pas celle décrite ici et
l'analyse est à reprendre.*

### ⚠️ Ne pas conclure trop vite
Un centre d'alerte vide **ne prouve pas** que les correctifs tiennent : ce passage montre le cas
exact où le zéro et le retrait du correctif coexistent. Et ne pas « corriger » en re-déployant
`main` par-dessus : cela effacerait le travail de la branche en cours, qui est en ligne
volontairement. Le geste est un report de commits, pas un changement de branche.

### 🔴 Mise à jour du 2026-08-13 — la perte est RÉIMPOSÉE à chaque image, et elle se mesure aussi dans la donnée

La fiche annonçait que la perte « redevient effective à chaque reconstruction ». **Deux
reconstructions de plus l'ont vérifiée en une journée :**

| | 12/08 |
|---|---|
| Images reconstruites | `tracky-api` **07:08** · `tracky-web` **14:15** UTC |
| Conteneurs recréés | 07:09 et 14:15, `restarts=0`, API `healthy` |
| Branche déployée | `feat/depot-partage` @ **`b3b3fac`** *(hier `36009cd`)* |
| `merge-base` avec `main` | **`c3c2704`** — 07/08, **inchangé** |
| `d5e5fb1` / `73440d8` dans `HEAD` | **NON** / **NON** |

La branche **avance** (un commit de plus, qui corrige une pluie de 403 sur `/api/alerts` pour le
compte dépôt) mais elle n'est **pas rebasée**. Les quatre marqueurs sont de nouveau absents des
artefacts servis, chacun re-vérifié avec son témoin.

**Fait nouveau : un second témoin, indépendant du binaire.** Le marqueur absent prouvait que le
code n'était pas là ; l'instrument le prouve maintenant par son silence.

| Mesure | Valeur |
|---|---|
| Commandes émises depuis le 11/08 22:37 | **77** |
| …portant un `diagnosticHint` « Aucune réponse… » | **0** |
| Compteur cumulé de silences tracés | **figé à 81** (le total du 11/08) |

Avant le redéploiement, **chaque** commande en produisait un. *Un marqueur absent dit qu'un
correctif n'est pas là ; un instrument qui n'écrit plus rien le prouve.* Voir
[TRK-014](#trk-014).

🗓️ **Le test daté du 12/08 est SANS OBJET, pas en échec** — et c'est une leçon à part entière :
voir la mise à jour du 13/08 de [TRK-001](#trk-001). Réarmé au 13/08 avec sa condition de nullité
écrite.


### 🔴 2026-08-16 — QUATRIÈME reconstruction, et le nom du chunk la date

| | Constat |
|---|---|
| Image `tracky-api` | reconstruite le **15/08 17:05:36** |
| Image `tracky-web` | reconstruite le **16/08 00:04:28** |
| Conteneurs | recréés le **16/08 00:06**, `restarts=0` |
| Branche servie | `feat/depot-partage` @ `8ea5120` (15/08 23:56 UTC) |
| `merge-base` avec `main` | **`c3c2704` (07/08)** — inchangé pour la 4ᵉ fois |

Les quatre marqueurs sont de nouveau **absents des artefacts servis**, chacun avec son témoin
présent (chemin absolu `/app/apps/api/dist/`) :

| Fiche | Marqueur | Verdict | Témoin ✅ |
|---|---|---|---|
| TRK-001 | `reminderIntervalMs` | **ABSENT** | « ANORMALEMENT LONG » → `gps-integrity/gps-integrity.service.js` |
| TRK-017 | `episodeOpenedAt` | **ABSENT** | « Allowlist SMS » → `sms/allowlist.service.js` |
| TRK-014 | `armAckListener` | **ABSENT** | `tracker-commands/ack-waiter.service.js` |
| TRK-002 | `consecutiveTransportFailures` | **ABSENT** | « Rafraichissement de session » → `chunk-XXNB5VTF.js` |

> **Ce qui rend cette 5ᵉ vérification différente des quatre précédentes : le témoin a CHANGÉ DE
> FICHIER.** Il vivait dans `chunk-TJGA5ATM.js` le 15/08, il vit dans **`chunk-XXNB5VTF.js`** le
> 16/08. Un bundle Angular renomme ses chunks à chaque construction : le témoin qui suit ce
> renommage prouve que l'artefact examiné est **neuf**, et non un cache, un volume monté ou un
> chemin périmé. *Un témoin immobile atteste qu'on lit le bon fichier ; un témoin qui migre atteste
> en plus qu'on lit un fichier RÉCENT — c'est la seule forme qui distingue « pas encore corrigé »
> de « corrigé puis re-effacé ».*

Compteur de reconstructions depuis la perte : **4**. Cadence observée : une tous les un à deux jours.
Le geste reste celui du 12/08 — reporter `d5e5fb1` et `73440d8` sur la branche en ligne, puis
reconstruire. **Tant que le point de fork ne bouge pas, tout correctif écrit aujourd'hui sera effacé
par la 5ᵉ image.**

---

## TRK-020

**Signature** — `outillage | (aucune ligne) | Le compteur « acquittées » de la collecte quotidienne lit acknowledgedAt (humain) et non ackedAt (boîtier)`
**Statut : 🟠 CORRECTIF PROPOSÉ** · 2026-08-12

### Ce qui a été mesuré
`tracker_commands` porte **deux** colonnes d'acquittement, de sens opposés :

| Colonne | Ce qu'elle porte | Valeur au 12/08 |
|---|---|---|
| `ackedAt` + `ackResponse` | l'accusé de réception **du boîtier** | **0** sur 4176 |
| `acknowledgedAt` + `acknowledgedBy` | un acquittement **humain / de masse** | **30** |

`collecte.sql` compte `acknowledgedAt` dans `commandes_sante_7j` (`count("acknowledgedAt")`) et
filtre dessus dans `commandes_en_attente`.

### Cause racine
Deux notions distinctes portent presque le même nom, et la requête a pris la première venue. Rien
dans le résultat ne signale laquelle est lue : la colonne s'affiche sous l'étiquette
« acquittees », qui décrit exactement ce que le lecteur croit voir.

### Pourquoi c'est encore inoffensif — et pourquoi ça ne le restera pas
Sur la fenêtre de 7 jours, les deux colonnes valent zéro : **aucune conclusion d'aucun rapport
passé n'est fausse**. Les 30 lignes non nulles sont toutes antérieures au 08/07, donc hors fenêtre.

Mais ces 30 lignes montrent le risque en clair : **27 partagent le même horodatage à la
milliseconde** (`2026-06-04 15:39:18.788`), aucune ne porte de `ackResponse`, et toutes sont au
statut `FAILED`. Ce ne sont pas 30 réponses de boîtier, c'est **une écriture en masse**. Le jour
où un opérateur en refait une, le rapport lira « N acquittées » et écrira que le boîtier a répondu
— contredisant TRK-014 sur la foi d'un compteur qui ne mesure pas ça.

> C'est la leçon de [TRK-014](#trk-014) qui revient sur une autre colonne : *un compteur
> d'acquittement non nul peut ne contenir aucun acquittement.* Elle avait été écrite pour les
> trames `ack` du journal ; elle vaut aussi pour la base.

### Correctif proposé — **non appliqué, et c'est délibéré**
Dans `collecte.sql`, lire `ackedAt` pour l'ACK boîtier, et exposer les deux séparément :

```sql
count("ackedAt")         AS acquittees_boitier,
count("acknowledgedAt")  AS acquittees_humain,
```

⚠️ **Ce changement n'a pas été fait.** Il modifie la définition d'une grandeur suivie depuis neuf
passages, et la procédure (§4 bis) interdit de changer une définition entre deux mesures sans le
dire. À appliquer en une fois, en notant la date de bascule dans le journal des passages — les
deux séries valant zéro aujourd'hui, la bascule est indolore **maintenant** et ne le sera plus
après la première écriture en masse.

### Vérification
Après correctif, `acquittees_boitier` doit valoir 0 (cohérent avec TRK-014) **et**
`acquittees_humain` doit pouvoir bouger sans que le premier ne bouge. Si les deux restent
solidaires, la requête lit encore la même colonne deux fois.

### Mise à jour du 2026-08-13 — la bascule est toujours indolore
Les deux colonnes valent encore **0** sur la fenêtre de 7 jours (les 30 acquittements humains
datent tous d'avant le 08/07). Le correctif reste **non appliqué, délibérément** : le changer
maintenant coûte zéro, le changer après une écriture de masse fabriquerait une fausse variation.

---

## TRK-021

**Signature** — `tracker_commands | FAILED | lastError = "ACK timeout: ACK timeout after <DURÉE>ms"`
sur un template dont le catalogue déclare `availableVia: ['sms']`, émis avec `channel = TCP`
**Statut : 🔴 NON CORRIGÉ** · **19 templates sur 23 concernés · 6 essais manuels depuis mai, 6 échecs**
· découvert 2026-08-13

> ### Le catalogue dit quel canal utiliser. Personne ne le lit — ni l'API, ni le front.

### Comment on est tombé dessus

Deux commandes créées le **12/08 à 06:10:00**, à **34 millisecondes d'écart**, par un utilisateur
réel depuis la console. Ce sont les **premières commandes non-`fix_continuous` depuis le 24/05**.
Elles sortaient du lot de l'audit parce qu'elles n'avaient ni `outcomeReason`, ni
`params.interval`, ni `observedResult` — les trois colonnes que remplit l'automate de cadence.

| | `sensitivity` | `shock_on` |
|---|---|---|
| Créée | 12/08 06:10:00.433 | 12/08 06:10:00.467 |
| `channel` | **TCP** | **TCP** |
| `payload` | `sensitivity123456 2` | `shock123456` |
| `lastError` | `ACK timeout: ACK timeout after 15000ms` | idem |
| Boîtier | FM-772-JH — **`ONLINE`** | idem |

Le boîtier était en ligne, la socket ouverte, le guetteur d'ACK armé (c'est le chemin générique,
qui l'arme bien — cf. [TRK-014](#trk-014) Constat 1). Il n'a rien répondu.

### Cause racine — la déclaration existe, et elle n'est branchée sur rien

`coban.catalog.ts:268-271` est explicite, et le commentaire précède la donnée :

```
// Templates dédiés au module SurveillanceMax. Envoyés via SMS car les
// commandes shock/sensitivity/noshock ne sont pas supportées sur le canal
// TCP descendant de la famille GPS103/403 — les ACK reviennent par SMS.
```
```ts
availableVia: ['sms'],
```

**`availableVia` n'apparaît qu'une seule fois dans tout le code de l'API** — à
`tracker-commands.service.ts:396`, pour être *recopiée* dans la réponse du catalogue destinée au
front. Côté web, elle n'est qu'une ligne de type (`tracker-commands.service.ts:41`), **consultée
nulle part**. Et `dispatch()` annonce son intention sans détour dans son propre en-tête :

> *« Envoie une commande au tracker via TCP. »*

Il vérifie que le boîtier est en ligne, refuse si non, écrit `SENT`, journalise la trame — et ne
regarde jamais le template. Un template SMS-only part donc en TCP, où il ne peut que expirer.

### La routine manquante est écrite dans le dépôt depuis l'origine

`docs/07-sms-gateway.md:206-209` décrit exactement l'aiguillage attendu :

```ts
if (online && template.availableVia.includes('tcp')) { … envoi TCP … }
if (template.availableVia.includes('sms') && command.tracker.phoneNumber) { … repli SMS … }
```

Ce n'est donc pas une conception manquante : c'est une conception **écrite, documentée, et non
câblée**. Le chemin du coupe-circuit moteur, lui, sait le faire (`engine_control_commands` porte un
repli SMS documenté par [TRK-018](#trk-018)) — la capacité existe dans le produit, elle n'a jamais
été reliée au catalogue.

### Portée

| Déclaration | Templates |
|---|---|
| `['tcp','sms']` | **4** |
| `['sms']` seulement | **19** |

**19 commandes sur 23 sont proposées dans la console et ne peuvent aboutir.** Et le compteur le
confirme sur toute l'histoire de la base : **6 lignes portent un `ACK timeout`, 6 sur 6 sur des
templates SMS-only** — 4 le 24/05 (`sensitivity`, `shock_on`), 2 le 12/08 (les mêmes). Aucune
tentative n'a jamais abouti, et aucune ne le pouvait.

### Famille — **mensonger**, au sens du §7

Le message rendu à l'opérateur est « le boîtier n'a pas accusé réception ». C'est vrai et c'est
trompeur : le boîtier n'a jamais été interrogé sur le canal qu'il comprend. Le message envoie
enquêter sur le matériel alors que la faute est dans l'aiguillage. *Même famille que
[TRK-013](#trk-013) et [TRK-018](#trk-018) — un champ qui dit vrai sur le mauvais sujet.*

### Ce que ça change pour [TRK-012](#trk-012)

Rien de son diagnostic, **et un renfort de sa preuve**. TRK-012 établit que `fix_continuous` part
au format SMS sur une socket TCP. Ici, deux **autres** templates, un **autre** utilisateur, une
**autre** date : mêmes payloads au format SMS (`shock123456`, `sensitivity123456 2` — suffixe
`123456`, le mot de passe Coban par défaut), même canal TCP, même silence total. Le faisceau de
TRK-012 gagne deux cas indépendants sans qu'aucun test n'ait eu à être lancé.

⚠️ **Les deux fiches restent distinctes** (§5 : dans le doute, signatures distinctes). TRK-012 est
« bon canal, mauvaise enveloppe » et se corrige en réécrivant la trame. TRK-021 est « mauvais canal,
alors que la donnée qui dit lequel choisir est déjà là » et se corrige en branchant l'aiguillage.
Fusionner les deux masquerait l'un des deux gestes.

### Correctifs proposés

1. **Brancher `availableVia` dans `dispatch()`** — l'aiguillage du §206 de `07-sms-gateway.md`,
   tel qu'il est écrit. Un template sans `tcp` part par SMS si le boîtier a un numéro ; sinon la
   commande est **refusée à la création**, avec un motif lisible.
2. **Refuser tôt plutôt qu'expirer tard.** Une commande impossible ne doit pas passer 15 s à
   attendre puis s'écrire `FAILED` : elle doit être rejetée à la création, avec « cette commande
   n'existe pas sur le canal TCP de ce boîtier ». Un échec de 15 s ressemble à une panne matérielle ;
   un refus immédiat ressemble à ce que c'est.
3. **Ne pas proposer dans la console ce qui ne peut pas partir.** Le front reçoit déjà
   `availableVia` : il lui suffit de griser un template SMS-only quand le boîtier n'a pas de
   numéro de SIM. *(Cosmétique — le nº 1 est le vrai correctif ; sans lui, l'API resterait
   contournable.)*

### ⚠️ Ne pas « corriger » en retirant les templates SMS-only du catalogue

Ils décrivent de vraies fonctions du boîtier (capteur de choc, sensibilité, geofence), et le module
Surveillance Max s'appuie dessus. Les retirer supprimerait la fonctionnalité au lieu de la brancher.
*Le témoin n'est pas le défaut.*

### ⚠️ Ne pas non plus déclarer `tcp` sur ces templates pour faire passer l'aiguillage

Le commentaire du catalogue dit **pourquoi** ils sont SMS-only : le boîtier ne les supporte pas sur
le canal descendant. Élargir la déclaration ferait disparaître le refus sans rien faire marcher —
et rendrait le catalogue faux, c'est-à-dire inutilisable comme source de vérité pour le correctif
suivant.

### Vérification après correctif

Une commande SMS-only émise depuis la console **part par SMS** (ligne `messages` créée côté
passerelle) **ou** est refusée à la création avec un motif explicite — et **plus aucune** ligne
`tracker_commands` ne porte à la fois `channel = TCP` et un template sans `tcp` dans
`availableVia`. Ce second point est le vrai test : un correctif qui se contenterait de griser le
bouton laisserait l'API émettre.

⚠️ Vérifier aussi que les 4 templates TCP-capables continuent de partir en TCP. Si tout bascule en
SMS, on a remplacé un aiguillage absent par un aiguillage inversé — et on facture des SMS pour ce
qui passait gratuitement.


### 🔴 2026-08-16 — le test daté se DÉCLENCHE : trois jours sur quatre, même opérateur

Le test posé le 15/08 : *« si de nouvelles commandes `shock_on` / `sensitivity` apparaissent, l'usage
est régulier et la fiche doit remonter en gravité 1 »*. **Une paire de plus le 15/08 à 13:26:09** —
`channel = TCP`, `FAILED`, `lastError = « ACK timeout after 15000ms »`, **même compte utilisateur**
(`68d0627e…`) que les trois vagues précédentes.

| Échecs `ACK timeout` sur modèles SMS-only | Quand |
|---|---|
| 4 | 24/05 |
| 2 | 12/08 |
| 4 | 14/08 |
| **2** | **15/08** |
| **12** | **cumul — 12 sur 12 partis en TCP** |

**Statut : gravité 2 → 1.** La fiche décrivait « un usage occasionnel qui se heurte à un mur » ; la
mesure dit trois journées sur les quatre dernières, toujours le même opérateur, toujours le même
délai de quinze secondes avant l'échec.

> **Ce que le compteur a changé, ce n'est pas le diagnostic — c'est la nature du défaut.** Tant que
> les dix échecs se répartissaient entre mai et deux nuits d'août, la lecture « vestige » tenait :
> quelqu'un avait essayé, avait renoncé. Une 4ᵉ vague sur une 4ᵉ journée dit autre chose — **une
> fonction annoncée au catalogue est essayée régulièrement et ne peut pas aboutir par
> construction**, puisque `availableVia` n'est lu nulle part. *Un défaut qu'on croit dormant se
> requalifie en comptant ses journées distinctes, pas ses occurrences : quatre échecs le même soir
> sont un incident, deux échecs par jour pendant quatre jours sont un produit cassé.*

---

## TRK-022

**Signature** — `alerts | OVERSPEED | une alerte par trame `,speed,`, sans déduplication` — **et un
seul boîtier du parc peut en produire**
**Statut : 🔴 NON CORRIGÉ** · **1317 alertes en un jour sur 1 véhicule · 42 véhicules sur 43 ne
peuvent PAS alerter** · découvert 2026-08-13

> ### Le détecteur de survitesse est éteint sur 42 véhicules, et sur le 43ᵉ il parle toutes les 24 secondes.

### Constat — deux défauts opposés, mesurés dans la même table

`error_logs` ne dit rien de la table `alerts` : c'est un canal séparé, celui de l'exploitant. En
l'ouvrant sur 14 jours :

| Jour | Alertes `OVERSPEED` | Véhicules distincts |
|---|---|---|
| 12/08 | **1317** | **1** — FG-669-DQ |
| 11/08 | 0 | — |
| 10/08 | 258 | 1 — FG-669-DQ |
| 08/08 | 28 | 1 — FG-669-DQ |
| 05/08 | 4 | 1 — FG-669-DQ |
| 03/08 | 32 | 1 — FG-669-DQ |
| 31/07 | 595 | 1 — FG-669-DQ |
| 30/07 | 27 | 1 — FG-669-DQ |

**100 % des alertes de survitesse de la fenêtre portent la même plaque.**

### Défaut 1 — 42 boîtiers sur 43 ne peuvent pas alerter

Ce n'est pas une flotte prudente, et ce n'est pas une hypothèse : le journal de trames tranche. Sur
3 jours, **un seul IMEI** (`864035053277662`) émet des trames `,speed,` — **1575** — et **aucun des
36 autres boîtiers actifs n'en émet une seule**.

L'alarme de survitesse Coban est un **réglage embarqué** (`speed` + seuil, posé par commande SMS).
Il est configuré sur un boîtier. Tracky ne fait que traduire la trame reçue : il n'existe **aucune
règle serveur** qui comparerait la vitesse d'une position à une limite. Donc **la détection de
survitesse est absente sur 42 véhicules**, et rien à l'écran ne le dit — la flotte a l'air
irréprochable.

> C'est exactement la question la plus rentable de la procédure (§3) : *qu'est-ce qui casse sans
> crier ?* Un compteur de survitesse à zéro sur 42 véhicules ressemble trait pour trait à
> 42 conducteurs exemplaires.

### Défaut 2 — sur le seul qui en produit, une alerte par trame

`alerts.service.ts:44-90` (`createFromCobanAlarm`) crée une ligne par trame d'alarme. **Aucune
déduplication, aucune notion d'épisode, aucun seuil de répétition.** Résultat mesuré le 12/08 :
**1317 alertes entre 05:52 et 14:32**, soit une toutes les **24 secondes** en moyenne.

Le contraste est **dans le même fichier** : `createGpsLostAlert` (ligne 152) prend un
`dedupWindowMs = 24 h` et son commentaire explique longuement pourquoi il ne filtre pas sur
l'acquittement. Le chemin des alarmes Coban n'a rien de tel — il n'a même pas de fenêtre.

*(Effet de bord : chaque trame déclenche aussi un `findUnique` sur `surveillanceProfile`, soit
1317 allers-retours en base pour un seul véhicule sur une journée.)*

### ⚠️ Les vitesses sont réelles — vérifié, pas supposé

Tentant de conclure à un bruit GPS. **Faux.** Les payloads donnent 135–168 km/h, et l'écart entre
deux positions consécutives les confirme : 4331.57969 N → 4331.51802 N en 3 s = **114 m**, soit
137 km/h — exactement la vitesse rapportée. Le véhicule roule vraiment à cette allure.

> **Il y a donc un vrai signal à remonter — une fois, pas 1317.** *Corriger le cri, pas le
> garde-fou.* Un correctif qui supprimerait l'alerte de survitesse aurait effacé la seule
> information de sécurité que ce parc produise.

### Correctifs proposés

1. **Dédupliquer par épisode**, comme le fait déjà `createGpsLostAlert` dans le même service. Un
   épisode de survitesse = une alerte, enrichie du **maximum atteint** et de la **durée**. Fenêtre
   de reprise à définir (proposition : nouvel épisode après 5 min sous le seuil).
2. **Rendre visible que 42 véhicules ne sont pas surveillés.** Une section « boîtiers sans alarme
   de survitesse configurée », dérivée de l'absence de trames `,speed,` sur 30 jours. C'est une
   information d'inventaire, comme les boîtiers en stock de [TRK-009](#trk-009) — et aujourd'hui
   rien ne la porte.
3. **Décider si la survitesse doit dépendre du boîtier.** Soit on provisionne le seuil embarqué sur
   tout le parc (commande SMS — et [TRK-021](#trk-021) doit être corrigé avant, sans quoi elle
   partira en TCP et expirera), soit on ajoute une règle serveur sur la vitesse des positions
   reçues. Le choix est métier ; ne pas le trancher laisse la fonctionnalité à 1/43.

### ⚠️ Ne pas « corriger » en montant le seuil du seul boîtier configuré

Cela ferait tomber le compteur à zéro et rendrait le parc entièrement muet sur la survitesse, ce
qui *ressemblerait* à un succès. Le volume vient de l'absence de déduplication, pas du seuil.

### Vérification après correctif

Le nombre d'alertes `OVERSPEED` d'une journée doit tomber à l'ordre de la **dizaine** pour
FG-669-DQ, **et** chacune doit porter une durée et une vitesse maximale — **pendant que** le nombre
d'**épisodes** distincts reste le même qu'aujourd'hui. Si le compte d'épisodes baisse aussi, on a
supprimé des signaux et pas des doublons.

Second test, sur l'autre moitié du défaut : au moins un second véhicule doit pouvoir produire une
alerte de survitesse. Tant qu'un seul en produit, seul le bruit aura été traité.

---

### 🔴 Mise à jour du 2026-08-14 — le défaut n'est pas propre à la survitesse, et son pire cas date de juin

La fiche d'hier tenait sur un seul type d'alarme. **Il vaut pour toute la famille** — c'est
`createFromCobanFrame` qui n'a aucune déduplication, pas le chemin de la survitesse.

**Preuve du jour, sur `POWER_CUT` :** les 4 alertes du 13/08 sont **deux événements comptés
deux fois**.

| Véhicule | Alertes | Écart | Position |
|---|---|---|---|
| DZ-034-CA | 09:00:04 et 09:00:09 | **5 s** | identique |
| KSR370 | 20:44:45 et 20:44:52 | **7 s** | identique |

**Et l'historique donne un ordre de grandeur que la survitesse ne montrait pas :**

| Période | Alertes `POWER_CUT` | Véhicules | Pic journalier |
|---|---|---|---|
| 17/06 → 01/07 | **41 479** | **1 à 2** | **3 596** le 20/06 |

Quinze jours, un ou deux véhicules, plus de quarante mille cartes. Le mécanisme est identique et il
est antérieur de deux mois à la découverte de la fiche.

> *Le volume de la survitesse n'était pas le plafond du défaut, il en était un échantillon. Une
> fiche ouverte sur le symptôme le plus visible sous-estime presque toujours sa propre portée —
> la question qui la calibre n'est pas « combien de fois ce symptôme ? » mais « qu'est-ce que sa
> cause gouverne d'autre ? ».*

⚠️ **La survitesse est retombée à 5 alertes le 13/08** (contre 1317 le 12/08). Série complète :
27 · 595 · 32 · 4 · 28 · 258 · **1317** · **5**. **Ce n'est pas une amélioration** — c'est une
grandeur qui suit la conduite d'un seul chauffeur (§4 bis de la procédure). Le fait qui compte n'a
pas bougé : **un seul véhicule sur 43 peut alerter**.

**Le correctif proposé ne change pas, mais son périmètre s'étend :** la déduplication doit être
posée dans `createFromCobanFrame`, **par (véhicule, type d'alarme, fenêtre)**, et non sur le seul
chemin `OVERSPEED`.

---

## TRK-025

**Signature** — `sms-allowlist | (aucune ligne) | suppressions de masse retenues par la passerelle, jamais remontées au centre d'alerte`
**Statut : 🟢 CORRIGÉ ET DÉPLOYÉ le 2026-08-24** (PR #127) · découvert 2026-08-17 ·
**re-mesuré le 24/08 : 49 blocages, 0 ligne — et plus aucune tentative depuis le 17/08**

> ### Le garde-fou retient 49 tentatives d'effacement de masse. Le centre d'alerte n'en affiche aucune.

---

## 🟢 2026-08-24 — CORRIGÉ ET DÉPLOYÉ (PR #127)

### La mesure refaite le jour du correctif — et une nouvelle qui n'était pas dans la fiche

| | |
|---|---|
| Tentatives `removals_blocked` | **49**, toutes depuis `82.67.153.51`, clé `vtx_48fe` |
| Première · **dernière** | 10/08 19:25 · **17/08 19:24** |
| Appels `ok` sur la même période | 342 |
| Numéros perdus | **0** — la garde a tenu, 42 numéros intacts |
| Refus d'authentification depuis la rotation | **2**, le 23/08 à 04:11:58, même IP |

**Le tiers a cessé le 17/08 — trois jours AVANT la rotation de clé du 20/08**
([TRK-017](#trk-017)). L'arrêt ne peut donc pas être crédité à la rotation, et la fiche ne le
prétend pas : *deux faits qui se suivent ne s'expliquent pas l'un l'autre.*

> ⚠️ **La menace est DORMANTE, pas éteinte.** Ce qui était corrigé ici, c'est une **cécité** :
> un nouvel épisode serait passé inaperçu comme les 49 précédents.

### Cause racine — confirmée mot pour mot

La branche d'alerte lisait `result.removalsBlocked`, le compteur de la réponse à la
synchronisation que **l'API émet elle-même** — laquelle ne demande jamais de suppression. Le
champ valait **structurellement zéro**. Les tentatives qui comptent ne vivent que dans
`allowlist_audit_logs`, **côté passerelle**.

### Le correctif

`remonterBlocagesPasserelle` lit `GET /v1/allowlist/audit` à chaque réconciliation, retient les
`removals_blocked` des **24 dernières heures**, et remonte au centre d'alerte **en nommant
l'appelant** : IP, en-tête brut, préfixe de clé, route, nombre de numéros visés.

**L'endpoint existait déjà côté passerelle** — c'est le correctif nº 1 que cette fiche
préconisait, et il ne restait qu'à l'appeler. *Troisième chaîne de la journée dont un seul
maillon manquait*, après [TRK-026](#trk-026) et [TRK-045](#trk-045).

**Cadence** : une alerte au premier blocage, puis un rappel quotidien tant que ça dure — via le
refroidissement **en base**, donc un redémarrage ne re-alerte pas.

⚠️ **Fenêtre glissante de 24 h, pas tout l'historique.** Sans borne, chaque passage horaire
re-alerterait sur les 49 blocages d'août, pour toujours.

⚠️ **La lecture ne lève jamais.** Elle s'exécute au milieu du cron qui *répare* la couverture
SMS : la faire échouer coûterait la réparation elle-même, bien plus cher que l'alerte perdue.

⚠️ **Verrou anti-régression** : un test vérifie que `removalsBlocked` de la synchro est
**ignoré**. S'y fier de nouveau reproduirait exactement ce défaut — *une branche qui a l'air de
marcher et n'écrit jamais rien.*

### ⚠️ Ce qui n'est PAS prouvé, et ne peut pas l'être aujourd'hui

La vérification prescrite — *« à la prochaine tentative retenue, une ligne doit apparaître dans
l'heure »* — **n'a pas pu être exercée** : il n'y a plus de tentative depuis le 17/08. Les tests
couvrent le mécanisme (6 neufs, dont 2 qui cassent sous mutation) ; **la preuve terrain viendra
au prochain épisode, s'il y en a un.**

*Différence réelle avec TRK-045 et TRK-015, vérifiés sur des mesures avant/après. Mieux vaut le
dire que laisser croire à une preuve équivalente.*

### Ce que le correctif promettait

Le commit `d5e5fb1` (10/08) annonçait : *« Nouveau : une suppression de masse retenue par la
passerelle est remontée tout de suite (champ `removalsBlocked`, côté vizyo-texto). »* Le code existe
bien, et il est **redéployé depuis le 16/08 16:03** (marqueur `episodeOpenedAt` vérifié présent).

### Ce que la mesure dit

| Mesure | Valeur |
|---|---|
| `allowlist_audit_logs.outcome = 'removals_blocked'` (passerelle) | **40**, dont **2** après le redéploiement (16/08 23:24:59, 17/08 00:24:59) |
| Lignes `sms-allowlist` dans `error_logs` | **aucune depuis le 10/08 14:25** |
| Trace horaire de réconciliation (`system_activity_logs`) | `+0 / -0 (41 inchangés)` — à **chaque** passage |

Le cron tourne, la garde retient, et rien ne remonte.

### Cause racine

`reportCoverage` (`apps/api/src/sms/allowlist.service.ts:173`) lit `result.removalsBlocked`, où
`result` est la réponse du `POST /v1/allowlist/sync` **que l'API émet elle-même**
(`allowlist.service.ts:318`). Or cette synchronisation ne demande **jamais** de suppression : le
journal système le montre à chaque heure (`-0`). La passerelle n'a donc rien à retenir *pour cette
requête*, et le champ vaut structurellement **0**.

Les suppressions qui comptent sont celles d'un **tiers** porteur de la clé de production
(`82.67.153.51`, cf. [TRK-017](#trk-017)). Elles n'existent que dans `allowlist_audit_logs` côté
passerelle — table qu'**aucun code de l'API ne lit** : les seules occurrences de `removalsBlocked`
dans `apps/api/src` sont les quatre lignes du champ lui-même.

> **Famille : angle mort.** Le garde-fou fonctionne parfaitement — 42 numéros intacts depuis 154,8 h.
> C'est sa **remontée** qui est morte, et elle est indétectable par construction : *un canal qui
> n'écrit jamais ressemble exactement à un canal sur lequel rien n'arrive.*
>
> ⚠️ Ne pas « corriger » en faisant alerter le cron sur les entrées manquantes : ce chemin existe
> déjà, il fonctionne, et il ne se déclenche pas ici **parce que rien ne manque** — la garde a tenu.
> Corriger le cri, pas le garde-fou.

### Correctif proposé

1. **Préférable** — côté passerelle, exposer `GET /v1/allowlist/audit?since=<horodatage>` ; le cron
   de réconciliation le lit à chaque passage et remonte au centre d'alerte tout
   `outcome = removals_blocked` postérieur au précédent passage, **avec l'adresse appelante**.
2. **À défaut** — faire renvoyer par `/v1/allowlist/sync` un cumul (`removalsBlockedTotal`) plutôt
   que le compteur de la requête courante ; l'API alerte sur toute progression entre deux passages.

Dans les deux cas, respecter la cadence déjà en place pour cette source : **une alerte par épisode,
rappel quotidien tant qu'il dure** — le défaut d'origine de TRK-017 était précisément une ligne par
occurrence.

### Vérification

À la prochaine tentative retenue par la passerelle, une ligne `sms-allowlist` doit apparaître dans
`error_logs` **dans l'heure qui suit**, sans qu'aucune entrée n'ait eu besoin d'être rétablie. Une
vérification qui se contenterait de compter les entrées d'allowlist ne prouverait rien : elles n'ont
jamais bougé.

---

## TRK-026

**Signature** — *(absence de ligne, pas une erreur)* `sms-heartbeat | (aucune ligne, jamais) |
preuve de vie hebdomadaire dont l'échec est structurellement impossible`
**Statut : 🟢 RÉSOLU LE 2026-08-24 — les trois maillons de la chaîne sont posés** ·
découvert 2026-08-17 *(2ᵉ passage)* · sonde corrigée le 2026-08-17 · **chaîne de bout en bout
rétablie le 24/08** (webhooks capcom6 + `vizyo-texto#8` + `vizyo-tracky#122`)

> ### La sonde chargée d'annoncer la panne du canal de repli du coupe-circuit ne peut pas rendre « en panne ».

---

## 🟢 2026-08-24 — RÉSOLU, et le diagnostic a changé grâce à une phrase du propriétaire

⚠️ **Le statut ci-dessus disait « CORRECTIF ÉCRIT ET TESTÉ, non déployé ». C'était FAUX** : le
correctif de la *sonde* était en ligne depuis le 17/08 et il fonctionnait — elle a produit sa
première ligne le 24/08 à 07:20, un `INDETERMINE` honnête au lieu d'un faux vert. *Un statut
périmé fait rouvrir une enquête close* — même piège que les cinq statuts rectifiés le 23/08.

### La phrase qui a réorienté l'enquête

> « **J'ai bien reçu le message**, donc il faut trouver un moyen de recevoir le SMS retour. »

Ce n'était donc **ni** un problème de livraison, **ni** un problème de passerelle : *un tuyau de
retour que personne n'avait branché.* Sans cette observation, l'enquête serait partie vers la
SIM, le forfait ou l'opérateur — les quatre pannes que l'en-tête du heartbeat nomme.

### La mesure — l'information existait depuis le début

| | |
|---|---|
| Sortants figés `queued` (Tracky **et** passerelle) | **365**, depuis le 03/06 |
| États `sent` / `delivered` jamais écrits | **0**, jamais |
| Entrants reçus | **231** — le webhook marche… pour **un seul** événement |
| capcom6 interrogé sur le message de 07:00 | **`state: "Delivered"`**, horodaté |

**capcom6 savait.** Personne ne le lui demandait.

### Trois maillons — deux existaient déjà sans jamais servir

| # | Maillon | Avant le 24/08 | Correctif |
|---|---|---|---|
| 1 | capcom6 → passerelle | **un seul** webhook abonné : `sms:received` | `sms:sent`, `sms:delivered`, `sms:failed` enregistrés (config, pas du code) |
| 2 | passerelle : `handleStatus` | **existait**, jamais déclenché | rien à écrire — il attendait depuis l'origine |
| 3 | Tracky : relire l'état | **jamais appelé** — `reconcileOutboundStatus` invoqué sans statut | `lireStatutPasserelle()` → `GET /v1/texto/:id` |

Plus un maillon d'assemblage : Tracky persiste `providerId ?? id`, donc l'identifiant **capcom6** ;
la recherche côté passerelle acceptait le sien seulement → **404 sur une ligne qui existe**. Elle
accepte désormais les deux clefs, `tenantId` conservé dans les deux branches.

> 🔑 **Trois pièces sur quatre étaient déjà là.** Le catalogue capcom6 mappait `Delivered`, la
> passerelle traitait l'événement, la méthode de réconciliation existait. *Ce qui manquait n'était
> pas du code : c'était de demander.* Une chaîne dont chaque maillon est écrit mais qu'aucun bout
> ne relie ne transporte rien — et rien ne le signale, puisque chaque pièce, isolée, a l'air juste.

⚠️ **La garde à ne jamais retirer** : toute panne de lecture (passerelle injoignable, 404, JSON
illisible, délai dépassé) laisse le verdict à `INDETERMINE`. *Ne jamais transformer une absence de
réponse en preuve de remise* — c'est le défaut que cette fiche décrit, et il serait facile de le
réintroduire en voulant bien faire. Un test le verrouille.

⚠️ **Les 365 lignes historiques restent `queued`** : les correctifs réparent le flux, pas le passé.
Un rattrapage est possible — capcom6 répond encore sur leurs identifiants — mais il **réécrirait
de l'historique** : décision séparée, non prise.

🗓️ **Test daté — prochain heartbeat (lundi 09:00 Paris)** : le verdict doit passer de
`INDETERMINE` à **`OK`**, et `sms_logs.status` porter `delivered`. ⚠️ Si le verdict reste
`INDETERMINE`, vérifier D'ABORD que capcom6 a bien poussé l'événement (webhook abonné ≠ webhook
reçu) avant de soupçonner le code.

### Ce que le code promet

Un cron hebdomadaire (`@Cron('0 0 9 * * 1', { timeZone: 'Europe/Paris' })`,
`apps/api/src/sms/sms-heartbeat.service.ts:58`) envoie un SMS aux numéros d'administration. Son
commentaire d'en-tête nomme précisément les pannes visées :

> *« vizyo-texto repose sur une SIM Android physique. La chaine peut casser silencieusement : tel
> decharge, app capcom6 crashee, SIM expiree, operateur qui block… Si la chaine marche, le SMS
> arrive ; si elle casse, un ErrorLog CRITICAL `source='sms-heartbeat'` est cree — on sait que la SIM
> est down avant le prochain incident. »*

**Les quatre pannes citées produisent toutes le même observable : un SMS accepté par la passerelle,
puis jamais remis.** C'est-à-dire un HTTP 200 et un statut `queued`. Aucune ne peut donc déclencher
l'ErrorLog.

### Cause racine — trois maillons, et c'est le troisième qui décide

| Maillon | Où | Ce qu'il fait |
|---|---|---|
| Le heartbeat n'incrémente `failed` que sur `res.ok === false` | `sms-heartbeat.service.ts:107-117` | c'est la seule branche qui écrit l'ErrorLog `CRITICAL` |
| `send()` déduit `ok` du statut **rendu à la soumission** | `sms-gateway.service.ts:484` | `ok = !['failed','rejected','undelivered','error','cancelled','canceled'].includes(status)` |
| **Aucun code ne met jamais à jour `sms_logs.status`** | *nulle part* | `grep -rn "smsLog.update" apps/api/src` → **zéro occurrence** |

`sms_logs.status` est écrit **une seule fois, à l'insertion** (`sms-gateway.service.ts:467-480`),
avec le statut que la passerelle rend dans la même seconde — `queued`. Le webhook entrant
(`recordInbound`, ligne 513 sq.) ne crée que des lignes `received` pour les SMS **entrants** : il ne
réconcilie aucun sortant. Un SMS sortant reste donc figé sur son statut de soumission **à vie**.

Comme `queued` ne figure pas dans `failedStatuses` — et **ne doit pas y figurer**, puisque ce n'est
pas un échec mais une absence de réponse — `send()` rend `ok: true` dès que l'appel HTTP aboutit.
`failed` reste à 0. L'ErrorLog n'est jamais écrit.

> ⚠️ Le commentaire de la ligne 481 est instructif : *« #34 — `ok` ne doit PAS rester true pour les
> statuts d'echec autres que 'failed' »*. Quelqu'un a déjà durci cette liste. **Durcir une liste de
> statuts d'échec ne sert à rien quand le seul statut jamais rendu n'en est pas un.** Le correctif
> précédent a traité la forme du test, pas le fait qu'il n'y a rien à tester.

### Mesures en production — 2026-08-17 08:48 UTC

| Mesure | Valeur |
|---|---|
| Lignes `error_logs` de source `sms-heartbeat`, `sms-gateway` ou `sms-webhook` | **0 — depuis toujours** |
| SMS sortants en `queued` (`sms_logs`) | **332**, dernier **17/08 07:00:00.529** |
| Dernier `failed` (`sms_logs`) | **2026-07-25 20:09** — figé depuis 22 jours |
| Dernier `received` | **2026-07-13** |
| Heartbeat du jour | émis **17/08 07:00:00.529** = lundi 09:00 Paris ✅, statut **`queued`** |
| Côté passerelle (`messages`) | **334** `queued`, heartbeat à **07:00:00.389**, `providerId` renseigné |

Le cron **a bien tourné**, à la seconde attendue : ce n'est pas un cron mort. Son message porte le
texte `[Vizyo Tracky] Heartbeat 2026-08-17T07:00:00.106Z via vizyo-texto — chaine SMS OK`.

> **Famille : mensonger** (§7). Un message qui *affirme* que la chaîne est saine, transporté par la
> chaîne qu'il est censé tester, et dont l'arrivée n'est jamais vérifiée. *Une sonde qui ne peut pas
> rendre « en panne » ne mesure rien — elle décore.*

### Défaut jumeau (§7.5) — l'écran d'administration est vert par construction

`healthCheck()` (`sms-gateway.service.ts:152-160`) alimente l'écran d'administration avec
`recentFailures24h`, compté sur `status = 'failed'` dans `sms_logs`. Pour la même raison, **ce
compteur vaut structurellement 0 depuis le 25/07**, et `lastFailure` ressort invariablement la ligne
du 25/07 20:09. Le `reachable` du même écran pingue `/health` **du relais** — la santé du relais, pas
celle du téléphone qui porte la SIM. Deux indicateurs, aucun ne regarde le maillon qui casse.

*C'est le défaut de la sonde de dépendances qui interrogeait l'URL interne, reproduit à l'identique
sur un autre canal : on instrumente le maillon le plus proche, jamais celui qui tombe.*

### Ce que ça coûte — EY-613-MF, le cas concret

Le véhicule coupé et redémarré chaque nuit par le repli SMS de [TRK-018](#trk-018). Sur trois jours :
**7 commandes moteur**, toutes `SENT`, toutes `ackedAt` nul, toutes `Envoyé via SMS (TCP
indisponible)`, `confirmationExpected = false`. Le dernier `RESTORE` est parti le **17/08 à
03:00:00.978** ; son SMS `resume123456` est `queued` depuis **03:00:03** ; le boîtier est **`OFFLINE`
et sans fix GPS depuis 07:20:51**.

Personne, à aucun étage, ne peut dire si ce véhicule a été redémarré — **et la sonde construite pour
le dire a rendu « OK ».**

### Correctifs proposés

1. **Découpler la mesure de la soumission — le cœur du correctif.** Le heartbeat doit relire l'état
   de **son propre message** après un délai (proposition : 15 min), et non se fier au retour
   synchrone. En l'absence d'accusé de remise, conclure **`INDÉTERMINÉ`** : un troisième état,
   distinct de OK et d'ÉCHEC. *Un booléen ne peut pas porter « accepté mais non confirmé », et c'est
   le seul état que ce canal produise.*
2. **Faire rendre un tri-état par `send()`** (`accepted` / `delivered` / `failed`) au lieu d'un
   `ok: boolean`, et laisser chaque appelant décider de ce qu'il en fait. Le repli du coupe-circuit
   et un SMS de provisionnement n'ont pas les mêmes exigences.
3. **Cesser de présenter `recentFailures24h` comme un indicateur de santé** tant qu'aucun statut
   terminal n'existe. Afficher le fait : « N messages sans accusé de remise depuis X ».
4. **Le préalable reste le nº 1 de [TRK-018](#trk-018)** — un accusé de remise depuis la passerelle
   (dépôt `vizyo-texto`, hors périmètre d'écriture de cet audit). ⚠️ **Mais il ne suffirait pas :**
   `send()` lit la réponse **synchrone**, donc le heartbeat resterait aveugle même avec des DLR
   disponibles. **Les deux correctifs sont nécessaires, dans cet ordre ou en parallèle.**

### ⚠️ Ne pas « corriger » en supprimant le heartbeat

Il coûte un SMS par semaine et il *pourrait* fonctionner. Le retirer supprimerait la seule intention
de surveillance de ce canal. Le défaut n'est pas la sonde, c'est **ce qu'elle lit**.

### ⚠️ Ne pas conclure que les SMS n'arrivent pas

Rien ici ne le montre, et c'est exactement la réserve de [TRK-018](#trk-018) : ce constat est une
**cécité**, pas une panne. Ce qui est établi, c'est qu'aucun instrument — ni la sonde, ni l'écran, ni
la table — ne peut distinguer un canal sain d'un canal mort. *Et pour la sonde, ce n'est pas une
limite de mesure : c'est une impossibilité de construction.*

### Vérification après correctif

Couper volontairement la chaîne en **aval** de la passerelle (téléphone hors ligne, app arrêtée) un
lundi, et vérifier qu'une ligne `sms-heartbeat` apparaît dans `error_logs`. Un heartbeat qui
« réussit » téléphone éteint prouve que le correctif n'est pas appliqué.
⚠️ **Ne pas valider en regardant l'écran d'administration** — il est vert par construction (défaut
jumeau ci-dessus), et le valider par lui reviendrait à contrôler une sonde par une autre sonde
cassée.

### 🗓️ Test daté — au passage du 2026-08-24

Le prochain heartbeat tombe **lundi 24/08 à 07:00 UTC**. Relever (a) le statut de son SMS dans
`sms_logs` et (b) la présence d'une ligne `sms-heartbeat` dans `error_logs`. Tant que (a) vaut
`queued` et (b) reste vide, la fiche est confirmée telle qu'écrite.
**Condition d'échec du diagnostic :** si une ligne `sms-heartbeat` apparaît **sans qu'aucun correctif
n'ait été livré**, l'analyse est fausse et il faut la reprendre entièrement — un chemin d'écriture
existerait alors, que ce passage n'a pas trouvé.

---

### ✅ 2026-08-17 — CORRECTIF APPLIQUÉ (écrit, testé, **non déployé**)

Quatre gestes, dans l'ordre où ils comptent.

#### 1. Le chemin d'écriture qui manquait — `reconcileOutboundStatus()`

`apps/api/src/sms/sms-gateway.service.ts`. C'était la cause racine : **aucun `smsLog.update`
n'existait dans tout `apps/api/src`**. Sans point d'entrée, aucun accusé de remise n'aurait pu être
enregistré même s'il arrivait. La méthode ne **fabrique** aucune preuve — elle rend l'état courant
quand aucun statut fournisseur n'est disponible, et **ne réécrit jamais un statut déjà terminal**
(une preuve de remise ne se dégrade pas).

#### 2. L'issue à trois états — `SmsOutcome`

`accepted` / `delivered` / `failed`, avec `smsOutcomeFromStatus()` et trois listes explicites
(`SMS_SUBMISSION_STATUSES`, `SMS_FAILED_STATUSES`, `SMS_DELIVERED_STATUSES`).

⚠️ **`ok` est CONSERVÉ tel quel, et c'est délibéré.** Onze appelants s'appuient dessus, dont le repli
du coupe-circuit (`engine-control.service.ts:494` et `:769`) et le provisioning. En changer le sens
silencieusement aurait été **pire que le défaut d'origine** : un booléen qui veut soudain dire autre
chose casse des gardes de sécurité sans rien signaler. Son commentaire dit désormais ce qu'il vaut —
« non refusé », pas « remis » — et `outcome` est là pour qui veut décider sur une preuve.

#### 3. La sonde ne conclut plus à l'envoi — vérification différée

`apps/api/src/sms/sms-heartbeat.service.ts`. Deux crons au lieu d'un :

| Cron | Heure (Europe/Paris) | Rôle |
|---|---|---|
| `sms-heartbeat` | lundi **09:00** | envoie, et **ne conclut rien** |
| `sms-heartbeat-verify` | lundi **09:20** | relit les messages émis et **prononce le verdict** |

Verdict à cinq branches : `OK` (remise prouvée → **silence**), `ECHEC` (refus → `CRITICAL`),
`INDETERMINE` (accepté sans preuve → `ERROR` explicite), **`NON_EMIS`** (aucun heartbeat en base →
`CRITICAL`), `SANS_OBJET` (aucun destinataire).

> 🔑 **`NON_EMIS` couvre un cas que RIEN ne couvrait** : le cron d'envoi qui ne tourne pas
> (conteneur redémarré au mauvais moment, `@Cron` non enregistré, exception avalée). *Un heartbeat
> absent et un heartbeat non remis se ressemblent exactement quand on ne regarde que les erreurs.*

⚠️ **Deux crons plutôt qu'un `setTimeout`** : cette sonde tourne une fois par semaine, donc la
fenêtre où un redéploiement avalerait un timer en mémoire est énorme. La vérification retrouve ses
messages en base par `template = 'gateway_heartbeat'` → idempotente, rejouable à la main via
`POST /api/admin/sms/heartbeat/verify`.

#### 4. Le corps du message ne mentionne plus la santé de la chaîne

`« chaine SMS OK »` → `« si vous lisez ceci, la remise fonctionne »`. L'ancien texte se lisait comme
un **constat** alors qu'il n'était qu'un envoi tenté — porté par la chaîne même qu'il prétendait
valider. Un test verrouille l'absence de l'ancienne formule.

#### Et l'écran d'administration cesse d'être vert par construction

`healthCheck()` expose `deliveryProofAvailable` (faux tant qu'aucun sortant n'a jamais atteint un
statut terminal de succès), `pendingWithoutReceipt` et `oldestPendingAt`. `recentFailures24h` reste
présent pour la compatibilité, avec un commentaire qui dit pourquoi il ne mesure rien.

#### Vérification exécutée

| | |
|---|---|
| `pnpm typecheck` | ✅ 3 tâches |
| Smoke-boot DI (`app.module.smoke`) | ✅ 5 tests — `SmsHeartbeatService` injecte désormais `PrismaService`, résolu via `PrismaModule` qui est `@Global()` : **aucun câblage de module à ajouter**, et c'est prouvé, pas supposé |
| `sms-heartbeat.service.spec.ts` | ✅ **12 tests** (dont 7 neufs sur la vérification différée) |
| Suite complète | ✅ 2106/2107 — l'unique échec (`partner-invitation`) passe **29/29 en isolation** : instabilité connue du harnais, sans rapport |

#### ⚠️ Ce que ce correctif NE fait pas

Il ne rend pas la chaîne SMS prouvable. Tant que la passerelle n'expose pas d'accusé de remise
(correctif nº 1 de [TRK-018](#trk-018), dépôt `vizyo-texto`), le verdict hebdomadaire sera
**`INDETERMINE`** — et écrira une ligne `ERROR` par semaine. **C'est le résultat attendu, pas un
bug** : on remplace un faux vert par un « on ne sait pas » daté et visible. La ligne disparaîtra
d'elle-même le jour où un accusé de remise existera, sans nouvelle modification.

#### 🗓️ Test daté — lundi 2026-08-24, 09:30 UTC+2

Après déploiement : relever le verdict (`POST /api/admin/sms/heartbeat/verify`) et la ligne
`sms-heartbeat` dans `error_logs`. Attendu : **`INDETERMINE` + une ligne `ERROR`**.
**Condition d'échec :** un verdict `OK` sans qu'aucun accusé de remise n'ait été livré côté
passerelle signifierait que `SMS_DELIVERED_STATUSES` attrape un statut de soumission — donc que le
faux vert a simplement changé de place. Vérifier alors la valeur brute de `sms_logs.status`.

---

## TRK-030

**Signature** — `gps-integrity | ERROR | GPS perdu : <PLAQUE> (<IMEI>) — boîtier vivant mais sans position GPS depuis toujours (jamais localisé). Antenne à vérifier.`
**Statut : 🔴 NON CORRIGÉ** · **gravité 2** · 1 occurrence · découvert 2026-08-19

> ⚠️ **Le texte est une variante de [TRK-001](#trk-001), la cause ne l'est pas.** TRK-001 décrit un
> fait **terrain** — une antenne réellement masquée ou débranchée. Celle-ci est un **faux positif de
> mise en service**. *Deux fiches valent mieux qu'une fusion qui masque une cause* (§5) : confondre
> les deux enverrait un installateur vérifier une antenne qui fonctionne.

### Ce que ça veut dire

Un boîtier posé chez un **client neuf** est accusé de panne d'antenne **51 secondes avant son
premier point GPS**.

### La séquence, minute par minute

| Heure (UTC) | Événement |
|---|---|
| **01:03:03** | Véhicule `FT000XX` créé — flotte « Ahmed », ouverte la veille |
| **01:04:03** | Boîtier `864035054755856` rattaché par `admin@vizyoagency.com` |
| **01:07:12** | Provisionnement SMS lancé, 6 étapes |
| **01:09:36** | 🔌 Connexion TCP — trame de login `##,imei:…,A` |
| **01:10:15** | 🔴 `error_logs` + alerte `GPS_LOST` : *« depuis toujours (jamais localisé). Antenne à vérifier. »* — **39 s après la connexion** |
| **01:11:06** | 🛰️ **Premier point GPS** |

### Cause racine

`apps/api/src/gps-integrity/gps-integrity.service.ts:162` retient les boîtiers
`lastSeenAt` récent **ET** `lastNoFixAt` récent **ET** `(lastPositionAt IS NULL OU périmée de 2 h)`.
Un boîtier qui n'a **jamais** eu de position tombe dans la première branche du `OR` — **celle qui ne
porte aucune borne de durée**. Il devient éligible dès sa première trame `no_fix`, au premier tick
qui suit sa connexion.

> 🔑 **L'asymétrie est exactement à l'envers de ce qu'il faudrait.** Un boîtier déjà localisé
> bénéficie de **2 heures** de patience ; un boîtier qui n'a jamais eu de fix — le seul cas où
> l'attente est *physiquement certaine*, un démarrage à froid Coban cherchant le ciel pendant une à
> plusieurs minutes — n'en reçoit **aucune**. *Le délai de grâce est accordé au cas qui n'en a pas
> besoin et refusé à celui qui en a besoin.*

**Et le code le savait.** Le commentaire des lignes 160-161 annonce :
*« ou jamais localisés **alors qu'ils émettent activement des no_fix depuis un moment** »*. Cette
condition « depuis un moment » **n'existe nulle part dans la requête**. *L'intention a été écrite,
jamais codée — et un commentaire qui décrit une garde absente est pire qu'un commentaire manquant :
il fait passer la relecture.*

**Famille : faux positif** (§7). Rien n'était en panne.

### Ce que ça coûte

La flotte « Ahmed » a été ouverte le 18/08 : **client neuf, en cours d'installation**. Sa toute
première ligne au centre d'alerte est une fausse alarme, et une alerte `GPS_LOST` est partie sur son
unique véhicule. **Le défaut se rejouera à chaque boîtier posé** — il n'y a rien d'aléatoire dedans.

### Correctif proposé

1. **Borner la branche « jamais localisé » par l'ancienneté du BOÎTIER**, pas par celle de sa
   position (qui n'existe pas) : n'inclure un boîtier `lastPositionAt IS NULL` que si son premier
   contact remonte à plus d'un seuil de démarrage à froid — `firstSeenAt`, à défaut
   `tracker.createdAt`. **30 minutes** est large (un démarrage à froid dépasse rarement 5 min) et
   reste très en deçà des 2 h accordées aux autres.
2. **Ne pas se contenter d'un test sur `lastNoFixAt`** : il est réécrit à chaque trame et ne dit
   rien de la durée. C'est bien l'ancienneté du boîtier qu'il faut lire.
3. **Rédiger autrement le cas restant.** Un boîtier posé depuis 4 heures et toujours jamais localisé
   est un **vrai** signal, mais son message doit dire *« jamais localisé depuis sa mise en service
   il y a N heures »* — « depuis toujours » se lit comme un défaut ancien alors que la date de
   naissance est connue.

### ⛔ Ce qu'il ne faut PAS faire

**Ne pas supprimer la branche « jamais localisé ».** Un boîtier posé la semaine dernière et jamais
localisé est **le signal le plus utile de tout ce détecteur** — c'est l'antenne oubliée dans le
carton. Et ne pas élargir la fenêtre des 2 h : elle n'a rien à voir avec ce défaut.

### Vérification (porte sur la cause, pas sur l'affichage)

À la prochaine mise en service, relever dans le journal l'écart **login TCP → première position
valide**, et vérifier qu'**aucune** ligne `gps-integrity` n'a été écrite dans l'intervalle. Ligne de
base du 19/08 : **login 01:09:36 → fix 01:11:06, soit 90 s**. **Ne pas** valider le correctif en
constatant la disparition de la ligne sur un boîtier déjà localisé : ce cas n'a jamais été concerné.

### 🗓️ Test daté — au prochain passage

Le client est en cours d'installation, un second boîtier est probable. **Deux poses sur deux avec
fausse alarme** transforment le défaut en certitude opérationnelle. Une pose **sans** alarme
signifierait que le boîtier a accroché avant le tick — **pas** que le défaut n'existe pas.

---

## TRK-032

**Signature** — *(absence d'alerte)*
`alerts | AUCUNE LIGNE | POWER_CUT supprimé car « moteur coupé par nous » — sans borne de durée`
**Statut : 🟠 CORRIGÉ, NON DÉPLOYÉ** *(commit `e88a5eec`, branche `fix/trk-032-borne-coupure-commandee`,
partie d'`origin/main` @ `42dcdb38` — **poussée sur `origin`, sans PR ni fusion** *(rectifié le 22/08)*, relecture humaine obligatoire : garde de
sécurité)* · **GRAVITÉ 1** · découvert 2026-08-20

### ✅ Ce qui a été fait le 2026-08-20

Constante `FENETRE_COUPURE_COMMANDEE_MS` = **15 minutes** dans `alerts.service.ts`, commentée avec la
mesure qui la justifie. La requête sélectionne désormais `createdAt` en plus de `action`, et la
fraîcheur est jugée dans le service — le contrat de `analyserAlimentation` reste **pur et sans
horloge**.

**6 tests ajoutés, dont 2 qui échouent sur le code d'avant** (CUT de 6 h, CUT de 3 jours), vérifié en
remettant le service dans son état d'origine : `Tests: 2 failed, 29 passed`. Puis **49 tests / 3
suites au vert** (alerts, alarme-alimentation, **smoke-boot DI**) et `tsc --noEmit` propre.
Aucun autre appelant de `analyserAlimentation` dans le dépôt.

⚠️ **La vérification ci-dessous n'est PAS faite** : elle exige le déploiement. Portée au prochain
passage d'audit.

### L'alarme d'alimentation de 33 boîtiers sur 42 est éteinte toutes les nuits

Le correctif du 19/08 (`10fe7a8` + migration `20260819030000_alimentation_sans_coupure`) fait taire
l'alarme `POWER_CUT` quand la coupure est **commandée par l'application**. L'intention est juste :
couper le moteur coupe l'alimentation, s'en alarmer est absurde — 202 fausses alertes en une nuit le
19/08. **C'est la façon de le savoir qui est fausse.**

```js
const derniereCommande = await this.prisma.engineControlCommand.findFirst({
  where: { trackerId: tracker.id, status: { in: ['ACKNOWLEDGED', 'SENT'] } },
  orderBy: { createdAt: 'desc' },
  select: { action: true },
});
… analyserAlimentation(frame, { moteurCoupeParNous: derniereCommande?.action === 'CUT' })
```

### Cause racine

La requête lit **la dernière commande moteur, sans aucune borne de temps**, et sans vérifier que la
coupe est **encore en vigueur**. Tant qu'aucun `RESTORE` ne vient se placer après elle, un `CUT`
vieux d'une heure, d'un jour ou d'un mois continue d'affirmer « c'est nous ».

### Mesure du 2026-08-20 à 01:1x UTC

| Dernière commande du boîtier | Boîtiers | Effet sur l'alarme d'alimentation |
|---|---|---|
| **`CUT` / `ACKNOWLEDGED`** | **30** | 🔇 éteinte |
| **`CUT` / `SENT`** | **3** | 🔇 éteinte |
| `RESTORE` / `ACKNOWLEDGED` | 5 | ✅ active |
| `RESTORE` / `SENT` | 1 | ✅ active |

> 🔑 **33 boîtiers sur 42 — 79 % du parc — ont leur alarme d'alimentation éteinte au moment de la
> mesure.** Ce n'est pas un accident : c'est **l'automatisation horaire** qui les a coupés, à 18:00
> et 20:00 la veille, et qui les rétablira à 06:00. *La flotte entière est silenciée chaque nuit,
> exactement pendant les heures où un véhicule est garé sans surveillance — c'est-à-dire la seule
> fenêtre où une coupure d'alimentation réelle (vol, batterie débranchée, sabotage) est plausible.*

### ⚠️ Ajout du 2026-08-20 — le délai réel est MESURÉ, et il retourne la lecture du défaut

Avant de choisir une fenêtre au jugé, l'écart réel entre une coupe commandée et l'arrivée d'une
alarme d'alimentation a été mesuré sur les **trames brutes** (`wire_logs`, 4 jours) :

| Boîtier | Coupe commandée | 1ʳᵉ alarme d'alimentation ensuite | Écart |
|---|---|---|---|
| DZ-034-CA | 18/08 20:00:05 | 19/08 00:57:46 | **4 h 58** |
| HD-292-SH | 18/08 20:00:06 | 19/08 00:32:34 | **4 h 32** |
| DZ-034-CA | 17/08 20:00:05 | 18/08 07:56:36 | 11 h 56 |
| HD-292-SH | 16/08 20:00:05 | 19/08 00:32:34 | 52 h |

**L'écart le plus court de toute la fenêtre est de 4 h 32.** Aucune alarme n'arrive dans les minutes
qui suivent une coupe commandée.

> 🔑 **Deux conséquences, la seconde plus importante que la première.**
> 1. **Une fenêtre de quelques minutes ne peut PAS ramener le déluge** qu'on voulait éteindre : les
>    alarmes concernées sont toutes à plus de quatre heures de la coupe la plus proche. **Le
>    correctif est donc beaucoup moins risqué qu'il n'en a l'air.**
> 2. **Le motif « coupure commandée » n'a jamais été la bonne explication de ces alarmes.** Une perte
>    d'alimentation causée par notre coupe apparaîtrait en secondes, pas en heures. Les **304 trames
>    sur 19 heures d'affilée** de DZ-034-CA sont un défaut électrique réel, pas un effet de bord de
>    l'automatisation. *Le « contact coupé sur montage commuté » relève de l'autre branche du code,
>    celle du niveau de batterie — pas de celle-ci.*
>
> Et l'unique exercice réel de la garde le confirme : le 19/08 à **02:26:23**, elle a silencié une
> alarme survenue **6 h 26 après** la coupe de 20:00, sur un véhicule qui alarmait sans interruption
> depuis la veille au matin. **Son seul exercice connu est un faux silence.**

### Deux aggravants, déjà documentés ailleurs dans ce référentiel

1. **`SENT` suffit.** [TRK-014](#trk-014) prouve qu'**aucun boîtier n'a jamais acquitté quoi que ce
   soit** : `ackedAt` = **0 sur 4 733**. Une commande `SENT` n'est pas une commande exécutée, c'est
   une commande **émise** — et [TRK-012](#trk-012) montre qu'elle part au mauvais format.
   L'application éteint donc une alarme au motif d'une coupe dont elle n'a aucune preuve.
2. **Un `RESTORE` resté `SENT` ne débloque rien — et ça arrive.** Un boîtier porte aujourd'hui un
   `RESTORE / SENT` du **27/07, soit 559 heures**. Si la même chose arrivait à un `CUT` resté en
   tête, ce véhicule serait silencié **définitivement**, sans que rien ne le signale.

### Le second verdict de silence, à surveiller aussi

`analyserAlimentation` se tait dans un **second** cas : `batteryPercent >= 90` → *« contact coupé sur
un montage commuté »*. C'est un arbitrage délibéré et défendable (« le boîtier n'est pas en péril »),
mais il a une conséquence à connaître : **une coupure d'alimentation réelle commence toujours avec
une batterie pleine.** L'alerte n'arrive donc qu'une fois la batterie descendue sous 90 %, c'est-à-dire
en retard — ou jamais si le boîtier s'éteint avant. *Ce point n'est pas le défaut de la fiche ; il ne
doit pas être corrigé sans mesure. Il est écrit ici pour ne pas être redécouvert.*

### Correctif proposé — trois gestes, du plus urgent au plus propre

1. **Borner dans le temps.** N'accepter le motif « coupure commandée » que si le `CUT` est récent —
   quelques minutes suffisent : la chute d'alimentation suit la commande de très près. Au-delà,
   l'alarme redevient légitime, parce qu'un véhicule coupé depuis six heures qui perd son
   alimentation ne la perd plus à cause de la coupe.
2. **Lire l'état, pas l'historique.** La bonne question n'est pas « quelle est la dernière commande
   enregistrée ? » mais « le moteur est-il coupé **maintenant** ? ». Si un état de coupe est tenu
   quelque part, c'est lui qu'il faut lire ; sinon, l'introduire vaut mieux que de déduire un état
   d'une pile de commandes non acquittées.
3. ~~**Exclure `SENT`.**~~ 🔴 **RÉFUTÉ le 2026-08-20, pendant la correction.** Ce geste était justifié
   par « tant que [TRK-014](#trk-014) tient, `SENT` ne prouve rien ». **La citation portait sur la
   mauvaise table** : TRK-014 décrit `tracker_commands` (commandes de cadence). Les commandes moteur
   vivent dans `engine_control_commands`, et **elles sont acquittées — 2 857 `ACKNOWLEDGED`.**

   Vérifié dans `engine-control.service.ts` : le chemin TCP passe bien en `ACKNOWLEDGED`, **mais le
   repli SMS écrit `SENT` avec `lastError: 'Envoyé via SMS (TCP indisponible)'` et n'en sort
   jamais** ([TRK-036](#trk-036)). Exclure `SENT` rendrait donc l'application **aveugle à ses propres
   coupes sur le chemin le moins fiable et le plus sensible** — le repli du coupe-circuit.
   `SENT` est **conservé**.

   > 🔑 **La borne de temps ferme à elle seule le danger réel** : une coupe restée `SENT` pour
   > toujours qui ferait taire l'alarme à vie. *Le statut ne dit pas depuis quand — c'est la date qui
   > tranche, pas le statut.*
   >
   > **Et la leçon de méthode vaut au-delà de cette fiche** : une fiche de ce référentiel s'applique
   > à **une table nommée**, jamais à une idée générale (« les commandes ne sont jamais
   > acquittées »). Généraliser une mesure au-delà de son périmètre fabrique un correctif qui a
   > l'air fondé.

### Vérification (porte sur la cause, pas sur l'affichage)

Rejouer le comptage « dernière commande moteur par boîtier » **entre 20:00 et 06:00** : le nombre de
boîtiers en `CUT` doit devenir **indépendant** du nombre de boîtiers dont l'alarme est éteinte.
Aujourd'hui les deux valent 33. **Ne pas** valider en constatant qu'il n'y a plus de fausses
`POWER_CUT` : il n'y en a plus parce que les trames ont cessé le 19/08 à 02:26:23, pas grâce à cette
garde.

### ⛔ Ce qu'il ne faut PAS faire

Ne pas supprimer la garde : elle traite un vrai problème. **Le défaut est sa portée, pas son
principe.**

---

## TRK-036

**Signature** — *(défaut de chaînage, pas une ligne d'erreur)*
`sms_logs | AUCUNE LIGNE | SMS entrant « …engine Succeed » enregistré avec imei NULL, jamais rapproché de la commande`
**Statut : 🟠 CORRIGÉ, NON DÉPLOYÉ** *(commit `435e65f2`, branche
`fix/trk-036-accuse-sms-rattache`, partie d'`origin/main` — **poussée sur `origin`, sans PR ni fusion** *(rectifié le 22/08)*)* · **gravité 2** ·
découvert 2026-08-20

### ✅ Corrigé le 2026-08-20 — deux gestes, et trois abstentions

| Geste | Où |
|---|---|
| `recordInbound` résout l'émetteur → `sms_logs.imei` | `sms-gateway.service.ts` |
| Un écouteur reconnaît l'accusé et acquitte la commande | `engine-control.service.ts` |

**Le rapprochement se fait sur les 9 derniers chiffres** — même convention que la machine à états
de provisionnement, parce que le même numéro circule en `+33…`, `0033…` ou `0…` selon l'opérateur
qui le relaie. Une comparaison stricte échouerait sur une simple variation de forme.

**Et la commande se retrouve par le COUPLE (boîtier, action), jamais par le temps.** 3 h 50
séparaient la commande de sa réponse : une fenêtre temporelle assez large pour couvrir ce cas
rattacherait n'importe quel accusé à n'importe quelle commande de la journée.

> 🔑 **Les trois abstentions comptent autant que le rapprochement**, et chacune a son test :
> 1. **Deux boîtiers pour un même numéro → on n'acquitte RIEN.** Un accusé collé au mauvais véhicule
>    ferait croire à une coupure moteur confirmée sur un véhicule qui n'a rien reçu — strictement
>    pire que pas d'accusé.
> 2. **Une panne de résolution ne fait pas perdre le SMS.** Remplacer un angle mort par une perte de
>    donnée serait pire que le défaut d'origine.
> 3. **Une panne de l'écouteur ne casse pas le flux entrant.** Un `@OnEvent` qui lève casse
>    l'événement pour **tous** les abonnés — dont la machine à états de provisionnement, qui attend
>    ses ACK sur le même canal.

**Vérifications** : `tsc --noEmit` ✅ · **127 tests / 8 suites** ✅ (engine-control, sms,
**smoke-boot DI**) · les nouveaux tests **échouent sur le code d'avant** (la suite engine-control ne
compile même pas : la méthode n'existait pas). Ajout de `sms-gateway.service.spec.ts`, **qui
n'existait pas** — portée volontairement étroite, uniquement le rattachement.

### ⚠️ Ce que ce correctif NE règle PAS, et qu'il ne faut pas confondre

Il explique pourquoi on ne **voyait** pas les accusés. Il n'explique pas pourquoi il n'y en a que
**deux en cinq semaines** pour 280 commandes `SENT`. **Les deux questions sont distinctes** et
[TRK-018](#trk-018) reste entière : une fois les accusés ramassés, on saura enfin **combien** il en
manque — ce qui est le vrai sujet.

### Le constat d'origine (2026-08-20)

### L'accusé de réception du boîtier arrive, est stocké par Tracky, et n'est jamais rattaché

[TRK-018](#trk-018) dit depuis le 11/08 que le repli SMS n'a **aucune preuve de remise**. Le 19/08 a
produit la preuve — **et elle était déjà dans la base de Tracky.**

| Heure (UTC) | Où | Fait |
|---|---|---|
| 04:39:13.553 | Tracky | Commande `RESTORE` créée pour **GS-014-NY** |
| 04:39:13.668 | Passerelle | `resume123456` empilé vers **+345901030609501** |
| 04:39:14.040 | Tracky | Commande passée en **`SENT`** |
| **08:28:58.320** | Passerelle | 🔔 **SMS entrant de +345901030609501 : « Resume engine Succeed »** |
| **08:28:58.558** | **Tracky** | 🔔 **Le même SMS est écrit dans `sms_logs`** — `imei` **NULL**, `context` **NULL**, `template` **NULL** |
| **+21 h** | Tracky | La commande est **toujours `SENT`** |

Et `trackers.simPhoneNumber` pour GS-014-NY vaut **exactement `+345901030609501`**. Le boîtier est
identifiable **par une seule jointure**, sur une colonne qui existe déjà.

> 🔑 **Le défaut n'est pas que la preuve manque — c'est qu'elle est arrivée, a été rangée, et que
> personne n'est allé la chercher.** Le repli SMS n'est pas aveugle : il est **sourd d'une oreille**.
> Tracky reçoit « Resume engine Succeed » et la classe comme un SMS entrant anonyme, à côté d'un
> « Binjour, je vois avec eux demain ! » et d'un démarchage commercial.

### Une nuance qui doit rester distincte

`messages` (côté passerelle) ne porte que **deux** accusés de ce type : « Stop engine Succeed » le
**13/07** et « Resume engine Succeed » le **19/08**. Deux en cinq semaines, pour **1 602** commandes
moteur `FAILED` et **280** `SENT`. *Le rattachement manquant explique pourquoi on ne les voit pas ;
il n'explique pas pourquoi il n'y en a que deux.* **Les deux questions sont distinctes et doivent le
rester** — corriger le rattachement ne fera pas apparaître les 278 autres.

### Correctif proposé

1. **À la réception d'un SMS entrant, résoudre l'émetteur** : `trackers.simPhoneNumber = fromNumber`
   → renseigner `sms_logs.imei`. Geste isolé, sans effet de bord, utile même sans la suite.
2. **Reconnaître les accusés** : le corps suit un gabarit fixe (`Stop engine Succeed`,
   `Resume engine Succeed`). Les rapprocher de la dernière `engine_control_commands` `SENT` du même
   boîtier et écrire l'acquittement.
3. **Ne pas rapprocher à l'aveugle sur le temps seul** : 3 h 50 séparent ici la commande de sa
   réponse. Une fenêtre trop large rattacherait un accusé à la mauvaise commande ; le couple
   (boîtier, action) est le bon discriminant, pas la proximité horaire.

### Vérification

Tout `sms_logs` de direction `IN` dont le `fromNumber` correspond à un `simPhoneNumber` connu doit
porter un `imei`. **Aujourd'hui : 0 sur 1.** Et **pas** « la commande est passée en `ACKNOWLEDGED` » :
ce serait vrai aussi si on acquittait à l'aveugle.

---

## TRK-035

**Signature** — *(défaut de plateforme, pas une ligne d'erreur)*
`plateforme | AUCUNE LIGNE | suppression de masse hors application — invisible de tous les journaux`
**Statut : 🟠 SONDE ÉCRITE, NON DÉPLOYÉE** *(commit `41c22081`, branche
`fix/trk-035-recensement-suppressions`, partie d'`origin/main` — **poussée sur `origin`, sans PR ni fusion** *(rectifié le 22/08)*)* ·
**GRAVITÉ 1 (consigne) / 3 (technique)** · découvert 2026-08-20

### 🔴 LE DÉFAUT A REJOUÉ LE JOUR MÊME OÙ ON ÉCRIVAIT LA SONDE

Mesuré à 14:50, pendant la rédaction du correctif :

| | Ce matin 01:1x | **14:50** |
|---|---|---|
| Lignes `error_logs` | **14** | **4** |
| Plus ancienne | 19/08 09:35 | **20/08 05:47** *(+20 h)* |
| `pg_stat_user_tables.n_tup_del` | 3 695 | **3 712** *(+17)* |
| Purge enregistrée à 03:00 | — | **`errorDeleted: 0`** |

**Troisième jour de suite, et toujours aucune trace.** Vérifié à nouveau ce jour : il n'existe
**toujours qu'un seul** chemin de suppression de lignes d'erreur dans le code servi (le cron), et
**aucun endpoint `DELETE`** côté alertes ou observabilité. *La sonde écrite aujourd'hui aurait crié
aujourd'hui.*

### ✅ Ce qui a été livré — et ce que ça n'est pas

> 🔑 **Ce n'est PAS un garde-fou, et ça ne peut pas en être un.** Aucun code applicatif
> n'arrête un `DELETE` exécuté directement en base. La sonde n'empêche rien : elle fait la seule
> chose qui reste possible — **empêcher que ça passe inaperçu**.

**La règle n'est pas « des lignes ont-elles disparu ? » mais « la disparition est-elle
EXPLIQUÉE ? »** — on compare la baisse au nombre de lignes que les purges **enregistrées**
revendiquent. Ce qui dépasse n'a pas d'explication.

**Deux signaux, pas un** :

| Signal | Ce qu'il attrape |
|---|---|
| Le **nombre** qui baisse | une suppression ciblée **au milieu** de l'historique |
| La **borne basse** qui avance | un `DELETE` par ancienneté — le cas du 19/08, +22 jours |

*S'en remettre à la borne seule laisserait passer le premier cas entier.*

**Le relevé vit ailleurs que dans les tables surveillées**, et c'est tout l'intérêt : rangé dans
`error_logs`, il disparaîtrait avec les lignes qu'il compte. Il est écrit dans le journal des
actions système — là où le ménage déclare déjà ses propres purges, et lisible depuis l'écran
d'administration.

**Cron à 03:15, APRÈS le ménage de 03:00**, et c'est délibéré : recenser avant produirait un écart
d'un jour à chaque passage. *La sonde crierait tous les jours, on l'ignorerait, et le jour où elle
aurait raison personne ne la lirait.*

**Vérifications** : `tsc --noEmit` ✅ · **126 tests / 12 suites** ✅ dont le **smoke-boot DI** —
obligatoire ici, un service mal câblé dans `observability` a déjà provoqué une boucle de crash.
**10 tests** sur la règle de comparaison, sortie du service en **fonction pure** : elle se vérifie
sans base, sans horloge et sans injection. Dont **le test qui protège la sonde d'elle-même** — une
purge qui revendique sa baisse ne déclenche **rien**.

### ⚠️ Ce qui reste hors de portée du code

Le second geste de la fiche — **documenter la manœuvre quand elle est volontaire** — n'est pas
livrable ici : il appartient à celui qui exécute le `DELETE`. La sonde le rend simplement
coûteux à omettre, puisque l'omission produit désormais une ligne `CRITICAL`.

### Le constat d'origine (2026-08-20)

### 41 709 alertes et au moins 89 lignes d'erreur effacées, sans aucune trace

| | 19/08 (mesuré à 01:32) | **20/08** |
|---|---|---|
| Lignes `error_logs` | **50**, la plus ancienne du **28/07** | **14**, la plus ancienne du **19/08 09:35:00** |
| Lignes `alerts` | **51 735** | **10 055** |
| Dont `POWER_CUT` | **41 733** | **24** |

### Ce n'est ni la rétention, ni un chemin de l'application

1. **La rétention n'a rien supprimé.** Le cron du 19/08 03:00:20 porte son propre compte-rendu :
   `{"errorDeleted": 0, "sysActivityDeleted": 0, "wireDeleted": 163301}`. Seuls les journaux de trame
   ont été purgés — et `ERROR_LOGS_RETENTION_DAYS` vaut bien **90** dans l'environnement du
   conteneur, ce qui laissait le 28/07 très largement dans la fenêtre.
2. **Aucun code applicatif ne peut le faire.** Une seule `errorLog.deleteMany` existe dans toute
   l'image servie (`log-cleanup.service.js`), et **aucune** `alert.deleteMany` — nulle part. Le
   bouton « tout acquitter » (`POST /api/alerts/acknowledge-all`, appelé 3 fois le 19/08, dont une à
   **09:31:45**) fait un `updateMany` sur `acknowledgedAt` : **il ne supprime rien**, vérifié dans le
   service.
3. **La migration ne le fait pas non plus.** `20260819030000_alimentation_sans_coupure`, lue
   intégralement, ajoute deux colonnes à `trackers`. Un point.

**La seule trace est indirecte** : `pg_stat_user_tables` compte **41 824** suppressions cumulées sur
`alerts`, et l'autovacuum de `error_logs` s'est déclenché le **19/08 à 09:35:15** — quinze secondes
après l'horodatage de la plus ancienne ligne survivante.

Le volume effacé de `error_logs` est **minoré** : aux 50 lignes mesurées la veille s'ajoutent les 39
comptées par le courriel de synthèse du 19/08 04:10:00 (« 39 erreurs en 1 h »), toutes disparues.
**Au moins 89 lignes.**

> 🔑 **[TRK-010](#trk-010) avait fermé la mauvaise porte.** La fiche du 03/08 a identifié la
> rétention automatique comme le moyen par lequel une erreur non corrigée s'efface, et l'a bouché en
> portant la fenêtre à 90 jours. La porte réellement empruntée le 19/08 est une autre : **le SQL
> direct sur la base de production**, qui ne passe ni par la rétention, ni par l'application, ni par
> le journal des mutations. *Un garde-fou posé dans le code ne protège que ce qui passe par le code.*

### Ce que ça coûte

- **Les taux de ce référentiel deviennent illisibles sans avertissement.** [TRK-023](#trk-023)
  affichait **42 240 / 51 735 = 81,6 %** ; il afficherait aujourd'hui **556 / 10 055 = 5,5 %**.
  **Cette chute de 76 points ne doit rien à un correctif.** La reporter comme un progrès serait la
  plus grosse erreur de lecture possible de tout le dossier.
- La consigne explicite du propriétaire — *« une erreur reste visible tant qu'elle n'est pas corrigée
  ET vérifiée »* — est contournable sans trace, y compris par mégarde.

### Correctif proposé

Il n'y en a pas côté code, et c'est le fond du sujet : **aucun garde-fou applicatif ne peut arrêter
un `DELETE` en base.** Ce qui est possible :

1. **Rendre la disparition visible plutôt que l'empêcher.** Un relevé quotidien de `count(*)` et
   `min("createdAt")` sur `error_logs` et `alerts`, conservé **ailleurs que dans ces tables**,
   transforme un effacement muet en fait daté. Le journal des passages de ce dossier fait déjà cela,
   et **c'est lui qui a détecté celui-ci** — mais un jour plus tard.
2. **Documenter la manœuvre quand elle est volontaire.** Une ligne dans `system_activity_logs`
   (catégorie `RETENTION`) coûte une insertion et rend l'événement lisible depuis l'écran, comme le
   fait déjà le cron.

### Vérification

`min("createdAt")` de `error_logs` ne doit jamais **avancer** sans qu'une purge soit inscrite quelque
part. **Le 20/08, il a avancé de 22 jours sans aucune inscription.**

### Note d'honnêteté

Le 19/08 a vu au moins trois déploiements et une trentaine de commits, dont plusieurs sur le bruit du
centre d'alerte. Un nettoyage délibéré pendant cette passe est l'hypothèse la plus simple. **Cette
fiche ne l'affirme pas** : elle constate que ni l'application, ni la rétention, ni aucun journal n'en
portent trace — et c'est ce constat-là qui est son sujet.

---

## TRK-033

**Signature** — `frontend | ERROR | [uncaught] TypeError: undefined is not an object (evaluating 'e.chargeDeFond.<CHAMP>')`
**Statut : 🟢 CORRIGÉ ET DÉPLOYÉ** · **gravité 2** · découvert 2026-08-20

### ✅ Résolu le 2026-08-20 — en trois morceaux, dont deux déjà faits

| Geste | État |
|---|---|
| Garde `@if (p.chargeDeFond; as cf)` au gabarit | ✅ **déjà fait** (`42dcdb38`) et **déployé** — image `tracky-web` reconstruite le **20/08 04:56** |
| Champ déclaré **facultatif** dans l'interface | ✅ **déjà fait** (`42dcdb38`) |
| **L'agent d'audit VPS sait écrire le champ** | ✅ **fait ce jour** — la consigne n'existait **nulle part** |
| Commentaires du code rectifiés | ✅ **fait ce jour** (`4849bb02`) |

### 🔴 La cause écrite dans le code était FAUSSE — et elle envoyait au mauvais endroit

Les deux commentaires posés avec la garde disaient : *« l'API ne le construit pas encore »*.
**L'API ne construit rien ici** — elle sert le manifeste `docs/vps-audit/app/wiki.json`, **écrit par
l'agent d'audit VPS**. Et l'historique du fichier est sans appel :

| Passage de l'agent | `chargeDeFond` |
|---|---|
| 11/08 → **17/08** (7 passages consécutifs) | ✅ **PRÉSENT à chaque fois** |
| **18/08** | ❌ **ABSENT** |
| 19/08, 20/08 | ❌ absent |
| **19/08 10:32** | 🔴 **l'écran tombe** |

> 🔑 **Rien n'était « pas encore construit » : quelque chose a été PERDU.** Le champ vivait depuis
> au moins une semaine, l'agent a cessé de l'écrire le 18/08, et l'écran est tombé le lendemain.
> *Un commentaire qui affirme une cause fausse fait passer la relecture et envoie enquêter ailleurs —
> il coûte plus cher qu'un commentaire absent.*

**Et c'est ce qui rendait le correctif incomplet** : avec la seule garde, la ligne de charge de fond
disparaît **en silence** à chaque passage de l'agent. La cause réelle — l'agent ne sait pas qu'il
doit écrire ce champ — n'était traitée nulle part. Elle l'est désormais, dans sa consigne.

### 🟢 La vérification prescrite est SUPERFLUE — il existe une garde plus forte qu'un test

La fiche demandait d'ouvrir l'écran avec un manifeste amputé. Inutile : `apps/web/tsconfig.json`
active **`strict: true` + `strictTemplates: true`**, donc un déréférencement non gardé d'un champ
facultatif est une **erreur de compilation**.

**Prouvé, pas supposé** — la garde a été retirée temporairement et `ng build` relancé :

```
X [ERROR] TS2532: Object is possibly 'undefined'   (x4, lignes 186-189)
=== code de sortie : 1 ===
```

Garde restaurée : `ng build` -> **code 0**.

> 🔑 **La panne ne peut plus être réintroduite en silence : le build refuse.** C'est une garde
> strictement meilleure qu'un test — elle n'a pas besoin d'être écrite pour chaque nouveau champ,
> elle s'applique à tous. *Aucun test n'a donc été ajouté, et c'est délibéré* : le dépôt teste la
> logique sans DOM, et le défaut vit dans le gabarit — un test de logique ne l'aurait jamais vu.

### `/admin/vps` plante sur un champ que son propre manifeste ne contient pas

Une ligne, le **19/08 à 10:32:05**, sur `/admin/vps`, iPhone Safari, compte
`admin@vizyoagency.com`. **Reproductible depuis la donnée, et en ligne au moment où ceci est écrit.**

### Cause racine

Le gabarit ouvre une garde sur l'objet parent puis déréférence l'enfant sans garde :

```
@if (idx.previsions; as p) {                     ← garde sur previsions
  … {{ p.chargeDeFond.healthchecksParMinute }}   ← chargeDeFond n'est pas gardé
```

Or `previsions` vient de `docs/vps-audit/app/wiki.json`, **écrit par l'agent d'audit VPS**, et ce
fichier ne contient que deux clés : `disque` et `recuperable`. **`chargeDeFond` est absent.** Vérifié
aux trois endroits : dans le dépôt, dans `/opt/tracky-vps-audit/app/wiki.json` publié sur le VPS, et
tel que le conteneur `tracky-api` le voit.

> 🔑 **L'interface TypeScript déclare `chargeDeFond` obligatoire, et le compilateur est satisfait —
> mais la valeur vient d'un JSON analysé sans validation.** Un type posé sur du JSON non validé n'est
> pas une garantie : c'est **une promesse que le compilateur n'a aucun moyen de tenir**. Ici la
> promesse est faite au gabarit, qui y croit et déréférence.

### Ce que ça casse

Pas seulement la phrase sur la charge de fond : **le `@if` entier meurt, donc toute la carte
« Prévisions » disparaît** — y compris le tableau du disque et le total récupérable, qui n'ont rien à
voir avec le champ manquant.

### Correctif proposé — deux gestes, et il faut les deux

1. **Côté écran, rendre le champ facultatif** : `chargeDeFond?` dans l'interface, `@if
   (p.chargeDeFond; as cf)` autour du seul bloc concerné. Le reste de la carte survit alors à
   n'importe quel manifeste partiel.
2. **Côté agent VPS, renseigner `chargeDeFond`** — les chiffres existent déjà (l'audit VPS mesure les
   healthchecks et les processus par minute). *Ce second geste seul ne suffit pas : il répare la
   donnée du jour, pas la fragilité du gabarit, et le prochain champ ajouté rejouera la même panne.*

### Vérification

Ouvrir `/admin/vps` avec un `wiki.json` **volontairement amputé** de `chargeDeFond` : la carte
« Prévisions » doit s'afficher, sans la phrase de charge de fond, et la console doit rester muette.
**Ne pas** valider en ajoutant le champ puis en constatant que la page marche — ça ne teste rien du
défaut.

---

## TRK-034

**Signature** — `TRIP_AUTOMATION | ERROR | Recalcul impossible sur <PLAQUE> : aucune position entre <DATE> et <DATE>, alors que des trajets bruts y subsistent. Rien n'a été supprimé.`
**Statut : 🟠 CORRIGÉ, NON DÉPLOYÉ** *(commit `638d16aa`, branche
`fix/trk-034-fenetre-recalcul`, partie d'`origin/main` — **poussée sur `origin`, sans PR ni fusion** *(rectifié le 22/08)*)* · **gravité 3** ·
découvert 2026-08-20

### ✅ Corrigé le 2026-08-20 — mais la moitié était déjà faite

| Geste | État |
|---|---|
| Ne plus alerter sur une tranche vide **au-delà** de la rétention | ✅ **déjà fait en amont** — `horizonRetention()`, avec son propre fichier de tests |
| Borner la fenêtre par la rétention | ✅ **fait ce jour** — `fenetreUtile()` |
| Rendre visible la dérive du réglage | ✅ **fait ce jour** |

### 🔑 Le bruit était traité, le TRAVAIL ne l'était pas

Le signalement était déjà tu. Mais un trajet situé au-delà de l'horizon continuait d'être
sélectionné, puis **analysé** — or l'analyse **relit les positions du trajet**, n'en trouve aucune,
et persiste une **analyse vide**. Du budget dépensé pour un résultat qui ne peut rien contenir.

**Et ce budget est saturé** : le passage du **2026-08-20 00:35** a analysé **3 712 trajets en
50 minutes**, atteint son plafond de temps (`budgetAtteint`) et laissé **6 véhicules** de côté.
Chaque trajet analysé au-delà de l'horizon est pris sur ceux-là.

`fenetreUtile()` borne la **sélection** des trajets, et rien d'autre : le calcul de `fromMs` est
inchangé, donc la garde d'alerte en aval reste intacte, en ceinture et bretelles.

> 🔑 **Le correctif ne raccourcit RIEN d'exploitable** — il retire uniquement du travail
> provablement vide. Deux tests verrouillent ce point : une fenêtre déjà dans la rétention n'est
> **pas touchée**, et si la rétention est **désactivée** on ne borne **rien** (rien n'est purgé,
> donc tout est exploitable). *Le piège symétrique — amputer la fenêtre sans raison — aurait fait
> disparaître des trajets analysables en silence.*

### ⚠️ La dérive de réglage n'est PAS corrigée en douce — elle est rendue visible

`lookbackHours` vaut **1 500 h** en base, alors que l'API n'accepte que **720 h** à l'écriture : le
réglage a été posé **avant** ce plafond, ou en le contournant.

**Le bon plafond est une décision, pas une supposition.** Le passage le journalise donc à chaque
tour au lieu de trancher seul :

```
lookbackHours vaut 1500 h en base, au-dela du maximum accepte a l'ecriture (720 h).
Reglage herite d'avant ce plafond, ou pose en le contournant — a trancher.
```

Le plafond devient au passage une **constante nommée, partagée entre l'écriture et la lecture** —
c'est la leçon de [TRK-008](#trk-008), où des valeurs hors bornes ont continué d'agir longtemps
après que le chemin d'écriture eut été borné. *Un plafond qui ne s'applique qu'aux écritures futures
laisse les valeurs héritées agir indéfiniment.*

### ✅ TRANCHÉ le 2026-08-20 — le plafond est relevé, la fenêtre n'est pas amputée

**Le plafond passe de 720 h (30 j) à 2 160 h (90 j)** *(commit `152883ec`)*, et la raison est dans
les chiffres :

> 🔑 **L'ancien plafond était PLUS BAS que la rétention des positions.** 720 h = 30 jours,
> alors que les positions vivent **60 jours**. L'écran interdisait donc d'écrire une fenêtre de
> 45 jours que le système aurait parfaitement su honorer : **ce plafond ne protégeait rien, il
> amputait.**
>
> Et ramener le réglage à 720 h aurait **divisé par deux la fenêtre d'analyse** d'une plateforme qui
> rattrape justement son historique — *une régression déguisée en mise en conformité*.

**Règle posée** : ce plafond **ne doit jamais descendre sous `POSITIONS_RETENTION_DAYS`**, sinon
l'interface refuse des valeurs exploitables. 90 jours laisse la marge si la rétention est relevée.

⚠️ **Relever ce plafond n'est sans danger que PARCE QUE `fenetreUtile()` existe** : le travail réel
reste borné par la rétention quelle que soit la valeur saisie. Sans lui, un plafond haut autoriserait
des balayages profonds et vides. **Les deux gestes vont ensemble et ne doivent pas être séparés.**

La sentinelle qui journalise la dérive **reste armée** — non plus pour celle-ci, qui est tranchée,
mais pour la prochaine, qui ne se verrait pas davantage.

**Vérifications** : `tsc --noEmit` ✅ · **165 tests / 13 suites** ✅ (trip-analysis, trip-automation,
horizon-retention, fenetre-utile, **smoke-boot DI**) · les 5 nouveaux tests **échouent sur le code
d'avant**. Corrige aussi un commentaire périmé qui annonçait « 50 jours en prod ».

### Le constat d'origine (2026-08-20)

### La fenêtre de recalcul dépasse de 2,5 jours la rétention des positions

Une ligne, le 20/08 à 00:32:01, sur FZ-862-VY, pour la fenêtre **19/06 → 21/06**.

| Réglage | Valeur | Portée |
|---|---|---|
| `trip_automation_settings.lookbackHours` | **1 500 h** = **62,5 jours** | jusqu'où le recalcul remonte |
| `POSITIONS_RETENTION_DAYS` | **60 jours** | jusqu'où les positions existent |
| rétention des trajets | **12 mois** | jusqu'où les trajets existent |

L'automatisation va chercher des positions **2,5 jours au-delà de l'horizon où il peut y en avoir**,
sur des trajets conservés vingt fois plus longtemps. Le 19/06 est à **62 jours** de la collecte : dans
la fenêtre de recalcul, hors de la rétention des positions. Et la purge du 19/08 03:30 a justement
retiré **22 674 positions** « > 60 j ».

> 🔑 **Ce n'est pas un aléa, c'est une soustraction.** Tant que `lookbackHours` dépasse
> `POSITIONS_RETENTION_DAYS`, la bande de recouvrement produit la même erreur **à chaque passage,
> pour toujours** — et elle s'élargira si l'un des deux réglages bouge sans l'autre.

### À porter au crédit du message

Il est explicite, nomme le véhicule, donne les deux bornes et se termine par *« Rien n'a été
supprimé »*. Ce n'est ni un message circulaire ni un message menteur au sens du §7 : il décrit
exactement ce qui s'est passé. **Le défaut est le réglage, pas le cri.**

### Correctif proposé

1. **Borner la fenêtre de recalcul par la rétention des positions**, à la lecture du réglage plutôt
   qu'en dur : `min(lookbackHours, POSITIONS_RETENTION_DAYS × 24)`, avec une marge d'un jour pour ne
   pas courir après la purge nocturne.
2. **Classer ce cas en information, pas en erreur.** Une fenêtre sans position parce que la rétention
   est passée est un état **attendu** ; l'écrire en `ERROR` consomme l'attention qui doit aller
   ailleurs *(§7 : « décrit un refus voulu → faux positif, ne doit pas être archivé »)*.

### Vérification

Après correction, relancer l'automatisation et vérifier qu'**aucune** ligne `TRIP_AUTOMATION` n'est
écrite alors que des trajets antérieurs à 60 jours subsistent en base — il en subsiste, la rétention
des trajets étant de 12 mois. **Ne pas** vérifier en constatant la disparition de la ligne le
lendemain : elle ne réapparaît que quand un véhicule concerné entre dans la bande.

---

## TRK-031

**Signature** — *(pas une ligne d'erreur : une durée fabriquée dans la donnée)*
`gps-dead-zones | (aucune ligne) | recordRecovery ferme TOUS les épisodes ouverts du véhicule à la date du jour`
**Statut : 🟠 CORRIGÉ, NON DÉPLOYÉ** *(commit `b28e389e`, branche `fix/trk-031-episodes-gps-bornes`,
partie d'`origin/main` — **poussée sur `origin`, sans PR ni fusion** *(rectifié le 22/08)*)* · **gravité 2** · découvert 2026-08-19

### 🔴 Le défaut a rejoué UNE TROISIÈME FOIS — ce matin, pendant la correction

| Jour | Véhicule | Épisodes fermés à la même seconde | Fabriquées |
|---|---|---|---|
| 18/08 | HD-779-MA | 2 | 1 (16,88 j) |
| 19/08 | FS-253-HR | **9** | **8** (jusqu'à 35,18 j) |
| **20/08 08:16:31** | **FZ-862-VY** | **4** | **3** — réfutées par **539 · 386 · 178** positions |

**Un véhicule par jour, trois jours de suite.** La mesure prescrite par cette fiche est passée de
**8 sur 14** hier à **13 épisodes clos faux sur 19** ce jour — soit **68 %**.

**Et une SECONDE zone est désormais empoisonnée :**

| Zone | Épisodes | Médiane affichée | Absence réelle la plus longue |
|---|---|---|---|
| `79a8d0f2` — parking de FS-253-HR | 9 | 🔴 **16,03 j** | 6,94 j |
| `879699a3` — parking de FZ-862-VY | 4 | 🔴 **10,47 j** | **2,83 j** |

### ✅ Corrigé le 2026-08-20 — mais PAS avec la fenêtre fixe prévue

> 🔴 **Correction de la roadmap, faite à l'exécution.** Elle prescrivait d'ajouter
> `lostAt >= now() - <fenêtre max d'épisode>`, avec une fenêtre de l'ordre de 7 jours lue dans la
> donnée. **Cette règle est fausse** : un véhicule réellement absent cinq semaines *a* une absence de
> cinq semaines. La refuser laisserait son épisode ouvert **pour toujours** — une autre façon de
> mentir, plus discrète.
>
> 🔑 **La borne ne doit pas porter sur l'ANCIENNETÉ de la perte, mais sur le fait qu'un épisode
> PLUS RÉCENT existe.** On ferme le plus récent encore ouvert et ses doublons (marge d'une heure —
> les doublons du cron naissent à quelques minutes d'écart). Les plus anciens restent ouverts : ce
> sont des restes d'avant le correctif, ils relèvent de l'assainissement, pas de l'ingestion.
>
> Vérifié sur les quatre scénarios : épisode courant seul ✅ · doublons du même épisode ✅ · épisode
> d'un autre mois **laissé ouvert** ✅ · absence réelle de cinq semaines **fermée normalement** ✅.
> *La fenêtre fixe échouait sur les deux derniers.*

**Un garde-fou qui manquait, ajouté au passage** : un retour **antérieur** à la perte est refusé.
`at` est l'heure **boîtier**, et un Coban qui rejoue son tampon après une coupure réseau émet des
horodatages antérieurs au temps réel — c'est tout le sujet de [TRK-015](#trk-015). Sans ce contrôle :
durée négative, écartée **en silence** du calcul de médiane, et un épisode marqué clos qui ne l'est pas.

⚠️ **Un test existant VERROUILLAIT le défaut** : il attendait `where === { vehicleId, recoveredAt: null }`,
c'est-à-dire l'absence de borne. **Recalibré, pas supprimé** — l'invariant qu'il défend (ne jamais
réécrire une date déjà posée) reste vrai et reste vérifié. **4 des 9 tests échouent sur le code d'avant.**

### ✅✅ ASSAINISSEMENT EXÉCUTÉ EN PRODUCTION le 2026-08-20 — objectif atteint

**Sur accord explicite**, en transaction, avec sauvegarde et script de retour arrière préparés
avant l'écriture.

> 🔴 **Le script initial était INSUFFISANT, et la mesure l'a dit avant l'exécution.** Il ne
> traitait que les épisodes **ouverts** — or au 20/08, **13 des 20 épisodes CLOS portaient une durée
> fabriquée**, et ce sont eux, pas les ouverts, qui alimentent la médiane affichée à l'exploitant.
> *Assainir les seuls épisodes ouverts aurait laissé l'écran mentir exactement comme avant.*
>
> Un épisode clos à date fausse se reconnaît sans ambiguïté : **le boîtier a émis des positions
> PENDANT l'absence qu'il déclare**. Le script a donc été étendu à cette seconde population
> (commit `c8552d07`).

| | Traité |
|---|---|
| Épisodes ouverts fermés à leur **vraie** date | **14** — durées réelles **0,00 → 0,80 j** |
| **Dates fabriquées corrigées** | **13** — 35,18 j → **7,10** · 16,88 j → **0,10** · 16,03 j → **3,94** |
| Laissés ouverts, légitimement | **2** — les véhicules ne sont pas revenus |

**La vérification prescrite par cette fiche, celle qui porte sur la CAUSE :**

| | Avant | **Après** |
|---|---|---|
| Épisodes clos couvrant un intervalle avec positions | **13 / 20** | ✅ **0 / 34** |

**Et les médianes suivent** — c'est l'écran de [TRK-028](#trk-028) qui cesse enfin de mentir :

| Zone | Avant | **Après** |
|---|---|---|
| `79a8d0f2` — parking de FS-253-HR | 16,03 j | **3,94 j** |
| `879699a3` — parking de FZ-862-VY | 10,47 j | **4,22 j** |
| `6c0ffca0` — HD-779-MA | 16,88 j | **0,10 j** |

⚠️ **La borne de code n'est toujours PAS déployée** (branche `fix/trk-031-episodes-gps-bornes`, non
poussée). L'ordre prescrit a été respecté — assainir d'abord — mais **tant que la borne n'est pas en
ligne, le défaut peut refabriquer des durées au prochain retour de fix.** Il l'a fait trois jours de
suite.

### L'outil — `prisma/assainir-episodes-gps.ts`

**DRY-RUN par défaut**, `--apply` pour écrire. Reconstitue la vraie date de retour depuis la
**première position valide postérieure à la perte**.

**DRY-RUN joué contre la production le 20/08 :**

| Verdict | Épisodes | Détail |
|---|---|---|
| **RÉPARABLE** | **14** | durées réelles de **0,00 à 0,80 j** — dont les **9 de KSR370** |
| TOUJOURS PERDU | 1 | FS-253-HR, reparti au parking le 19/08 à 15:05 — **doit rester ouvert** |
| HORS RÉTENTION | 0 | — |

> 🔑 **Les 9 épisodes de KSR370 valent 0,10 à 0,80 jour.** Fermés à `now()` au retour du boîtier,
> ils auraient valu **plusieurs semaines chacun**. C'est la démonstration chiffrée de ce que le script
> évite.

⚠️ Il ne ferme **jamais** à `now()` — ce serait le défaut appliqué en masse. Un épisode sans position
postérieure **reste ouvert** (le véhicule n'est pas revenu) ; un épisode antérieur à la rétention des
positions est **nommé** plutôt que deviné. *Les laisser ouverts est honnête ; leur inventer une date
ne le serait pas.*

⚠️ **Limite assumée** : la relation `Vehicle → Tracker` est 1-1 et pointe le boîtier **actuel**. Si un
boîtier a été remplacé depuis la perte, les positions de l'ancien ne sont plus atteignables par ce
chemin et l'épisode sera classé « toujours perdu ». Le script n'écrit alors rien — mieux vaut un
épisode ouvert qu'une date inventée.

### ⚠️ Mise à jour du 2026-08-20 — la prédiction s'est réalisée en douze heures

Le test daté écrit le 19/08 disait : *« FS-253-HR (9 épisodes ouverts) est un candidat. Au retour,
compter les épisodes refermés à la même seconde : s'il y en a plus d'un, la fiche est confirmée une
seconde fois. »*

**FS-253-HR est revenu le 19/08 à 13:48:56. Neuf épisodes ont été refermés à cette seconde-là.**

| Perte | Retour écrit | Durée déclarée | Réalité |
|---|---|---|---|
| **15/07 09:31:02** | 19/08 13:48:56 | 🔴 **35,18 j** | ❌ |
| 22/07 13:35:53 | 19/08 13:48:56 | 🔴 28,01 j | ❌ |
| 28/07 14:38:16 | 19/08 13:48:56 | 🔴 21,97 j | ❌ |
| 29/07 14:39:11 | 19/08 13:48:56 | 🔴 20,97 j | ❌ |
| 03/08 13:02:53 | 19/08 13:48:56 | 🔴 16,03 j | ❌ |
| 07/08 13:50:49 | 19/08 13:48:56 | 🔴 12,00 j | ❌ |
| 10/08 07:00:11 | 19/08 13:48:56 | 🔴 9,28 j | ❌ |
| 10/08 15:03:19 | 19/08 13:48:56 | 🔴 8,95 j | ❌ |
| **12/08 15:20:59** | 19/08 13:48:56 | **6,94 j** | ✅ **la seule vraie** |

**Réfutation arithmétique** : pendant les « 35,18 jours » du premier épisode, le boîtier
`864035054757027` a émis **5 027 positions**.

**Et le dégât annoncé s'est matérialisé sur l'écran que [TRK-028](#trk-028) a créé :**

| Zone | Épisodes clos | Médiane affichée | Absence réelle la plus longue |
|---|---|---|---|
| `79a8d0f2` — parking souterrain de FS-253-HR | **9** | 🔴 **16,03 j** | **6,94 j** |

L'écran écrit pour cesser de dire « il réapparaîtra en sortant » sans dire quand répond désormais
**« environ seize jours »** pour un parking dont le véhicule ressort en une semaine.

**Dette restante : 20 épisodes ouverts sur 9 véhicules**, dont **KSR370 avec 9** (le plus ancien du
15/07) et **FZ-862-VY avec 4**. KSR370 est mort depuis le 14/08 : le jour où il revient, il écrira
neuf absences se terminant à la même seconde, dont une de plus d'un mois. **C'est le prochain
déclencheur, et il est prévisible.**

*L'ordre de correction écrit le 19/08 est confirmé : **assainir le stock d'abord, borner le
`updateMany` ensuite.** L'inverse rejouerait la fabrication sur les 20 épisodes restants.*

---

### Le constat d'origine (2026-08-19)

### Ce que ça veut dire

Le raccroc à l'ingestion posé par [TRK-028](#trk-028) **s'exécute** — c'est la bonne nouvelle, et
c'était le test daté nº 3. Mais il ferme **tous** les épisodes ouverts du véhicule, sans regarder
leur date d'ouverture.

| Véhicule | Perte | Retour écrit | Durée déclarée | Durée réelle |
|---|---|---|---|---|
| HD-779-MA | **15/08 10:37:22** | 18/08 11:02:52 | 3,0 j | ✅ **3,0 j** — plausible |
| HD-779-MA | **01/08 13:54:55** | **18/08 11:02:52** | 🔴 **16,9 j** | ❌ **2 h 28** |

**La réfutation est sans appel** : entre le 01/08 16:23 et le 15/08 03:16, ce boîtier a émis
**27 733 positions**. Il n'a pas été perdu 16,9 jours ; il est revenu le 01/08 en fin d'après-midi.

### Cause racine

`apps/api/src/gps-dead-zones/gps-dead-zones.service.ts:168` fait un `updateMany` sur
`{ vehicleId, recoveredAt: null }`. L'épisode du 01/08 était resté ouvert parce que
**`recordRecovery` n'existait pas encore** — le code n'a été déployé que le 17/08 15:54. Le premier
retour venu l'a trouvé ouvert et l'a estampillé à la date du jour.

Le commentaire assume explicitement le choix : *« un véhicule peut porter plusieurs épisodes ouverts
si le cron a tourné pendant que la donnée était incohérente. On les ferme tous plutôt que d'en
laisser traîner un qui fausserait toutes les moyennes ensuite. »* **L'intention est juste pour des
doublons du même épisode. Elle est fausse pour un épisode d'un autre mois** — et produit exactement
ce qu'elle voulait éviter.

> 🔑 **Un rattrapage sans date de coupure réécrit le passé avec le présent.** Le code suppose que
> tout épisode ouvert appartient à la perte en cours. C'était vrai le jour où il a été écrit, parce
> qu'il fermait tout au fil de l'eau. Ça ne l'a **jamais** été pour les lignes antérieures à son
> déploiement, et personne ne les a regardées. *Une fonction idempotente sur un flux ne l'est pas
> sur un stock qu'elle n'a pas produit.*

### Ce que ça abîme, précisément

La **durée médiane par zone** est exactement ce que [TRK-028](#trk-028) affiche sur la fiche véhicule
pour répondre à « quand revient-il ? ». Une valeur de 16,9 jours dans l'échantillon décale la médiane
vers le haut. *Le correctif livré pour cesser de mentir à l'exploitant commence sa vie en lui
montrant un chiffre faux.*

### La dette est chiffrée, pas hypothétique

**28 épisodes ouverts, dont 27 antérieurs au déploiement**, sur **8 véhicules** :

| Véhicule | Épisodes ouverts | Plus ancien |
|---|---|---|
| FS-253-HR | **9** | 15/07 09:31 |
| KSR370 | **9** | 15/07 23:55 |
| FZ-862-VY | **4** | 03/08 17:34 |
| HD-292-SH · GS-187-NY · FW-298-WV · GS-928-NX · AL-927-QM | 1 chacun | 17/07 → 11/08 |
| FL-787-KV | 1 | 18/08 09:22 *(le seul postérieur au correctif)* |

Le jour où FS-253-HR ressort de son parking, il écrira **neuf** absences se terminant à la même
seconde, dont une de plus d'un mois.

### Correctif proposé — deux gestes, et l'ordre compte

1. **Assainir le stock d'abord, une fois.** Les 27 épisodes antérieurs au 17/08 15:54 ne sont pas
   récupérables tels quels : leur vraie date de retour n'a jamais été écrite. La déduire de la
   **première position postérieure au `lostAt`**, lisible dans `positions` — ou, à défaut, poser un
   drapeau les excluant du calcul de médiane. **Ne pas les fermer simplement à `now()`** : c'est le
   défaut lui-même, appliqué en masse.
2. **Borner le `updateMany` ensuite.** Ajouter `lostAt >= now() - <fenêtre max d'épisode>` au
   `where`, pour que la fermeture ne puisse jamais atteindre un épisode étranger à la perte en cours.
   La fenêtre se lit dans la donnée : le plus long épisode plausible du parc est de l'ordre de
   **7 jours** (FS-253-HR).

### ⛔ Ce qu'il ne faut PAS faire

Ne pas revenir à `update` au lieu de `updateMany` : le cas des doublons du même épisode, que le
commentaire décrit, est réel. Ne pas non plus supprimer les épisodes fautifs — un épisode effacé
n'est plus auditable, et la perte du 01/08 a bel et bien eu lieu ; c'est sa **fin** qui est fausse.

### Vérification

Après assainissement, **aucun** épisode refermé ne doit afficher une durée pendant laquelle
`positions` porte des points du même boîtier. La requête tient en une ligne et se rejoue : compter
les épisodes clos dont l'intervalle `[lostAt, recoveredAt]` contient au moins une position.
**Aujourd'hui : 1 sur 2.** L'objectif est **0** — et **pas** « la médiane a l'air plus jolie ».

### 🗓️ Test daté — au prochain passage

Au prochain retour de fix (FZ-862-VY, 4 épisodes ouverts, ou FS-253-HR, 9), compter les épisodes
refermés **à la même seconde**. S'il y en a plus d'un, la fiche est confirmée une seconde fois et la
dette commence à se matérialiser. Relever aussi la médiane de la zone concernée **avant** et
**après**.

---

## TRK-029

**Signature** — `schedule-cron | ERROR | Automatisation horaire : coupe/reprise impossible sur <PLAQUE> depuis <DURÉE> — Coupe auto différée : véhicule arrêté depuis seulement <N>s (minimum requis <N>s)`
**Statut : 🔴 NON CORRIGÉ** · **gravité 2** · 1 occurrence · découvert 2026-08-18
*(Première ligne de source `schedule-cron` depuis l'ouverture du référentiel le 28/07.)*

### Ce que ça veut dire

L'automatisation horaire doit couper le moteur de **HD-603-XY** à 20:00. Le véhicule roule encore.
La garde refuse — **et elle a raison**. Le report est ensuite ré-espacé par un backoff exponentiel,
qui fait attendre 30 minutes une condition dont le code connaît l'heure exacte de levée.

### La séquence, reconstituée dans le journal du conteneur

La ligne seule ne permet pas le diagnostic ; la séquence, oui.

| Heure (UTC) | Tentative | Cause du report | Prochain essai |
|---|---|---|---|
| **20:03** | CUT | *véhicule en mouvement (32,4 km/h)* | +5 min |
| **20:08** | CUT | *arrêté depuis seulement 41 s (min. 600 s)* | +15 min |
| **20:24** | CUT | *arrêté depuis seulement 256 s (min. 600 s)* | **+30 min** |
| **~20:30** | — | **le véhicule franchit les 600 s : il est éligible** | *(rien ne le voit)* |
| **20:31** | — | 🔴 ligne `error_logs` : « coupe impossible depuis 31 min » | — |
| **20:55** | CUT | ✅ **réussi** (`schedule_history` : `CUT / OUT_OF_WINDOW`, 20:55:00.317) | — |

Les quatre jours précédents, la même coupe tombait à 20:00:04, 20:00:05, 20:25:00 et 20:00:05.

### Cause racine

Le backoff (5 → 15 → 30 min) est appliqué **indistinctement** à toutes les causes de report. Or
*« arrêté depuis 256 s, minimum requis 600 s »* n'est pas une incertitude : c'est un compte à rebours
de **344 secondes**, lisible dans la donnée qui vient d'être évaluée. Le code a la réponse et attend
quand même une demi-heure. Coût mesuré : **25 minutes d'immobilisation en trop**.

> 🔑 **Un backoff traite l'ignorance ; il ne doit pas traiter une échéance connue.** Le même délai
> croissant est **juste** pour un boîtier qui ne répond pas — on ne sait pas quand il reviendra — et
> **faux** pour un compte à rebours qu'on lit dans la trame. *Deux causes de report que rien ne
> distingue dans le code reçoivent la même punition, et l'une des deux la subit pour rien.*

### Le défaut second — celui qu'un exploitant voit

Le message affirme *« coupe/reprise **impossible** »* alors que le contexte porte
`waitingBackoff: true` : l'attente était **voulue**. Et **rien ne referme la ligne** —
`clearDeferral()` (`apps/api/src/vehicle-schedules/schedule-cron.service.ts`) ne vide que des `Map`
en mémoire, sans aucune écriture. Le centre d'alerte conserve donc indéfiniment un « impossible » qui
décrit une action **qui a abouti 24 minutes plus tard**.

**Famille : mensonger** (§7) — le message affirme une impossibilité là où il y a eu une attente
délibérée et résolue.

### Correctif proposé — trois gestes, aucun ne touche à la garde

1. **Réessai à l'échéance connue.** Quand la cause de report porte un compte à rebours calculable
   (`arrêté depuis N s / minimum M s`), programmer le prochain essai à `M − N` secondes (+ un tick de
   marge) au lieu du pas de backoff. **Conserver le backoff exponentiel** pour les échecs de
   transport et les causes inconnues : c'est là qu'il est justifié.
2. **Ne pas écrire « impossible » quand `waitingBackoff` est vrai et l'échéance connue.** Rédiger
   *« coupe différée, réessai à HH:MM — véhicule arrêté depuis N s sur M s requis »*. Un exploitant
   qui lit « impossible » appelle le conducteur ; celui qui lit « différée à 20:30 » attend.
3. **Écrire la clôture.** `clearDeferral()` doit tracer l'aboutissement — ligne de résolution, ou
   champ de résolution sur la ligne d'origine. *Une alerte sans état de sortie reste vraie pour
   toujours.*

### ⛔ Ce qu'il ne faut PAS faire

**Ne pas toucher au minimum de 600 s, ni au refus de couper un véhicule en mouvement.** Le véhicule
roulait à 32,4 km/h quand la fenêtre s'est ouverte ; la garde a fait exactement son travail. *Si un
garde-fou crie mal, on corrige le cri — pas le garde-fou* (§8). Ne pas non plus « corriger » en
cessant d'écrire la ligne : le blocage de 31 minutes est une information réelle, c'est sa
**rédaction** et son **absence de clôture** qui sont fautives.

### Vérification (porte sur la cause, pas sur l'affichage)

Sur un véhicule dont la coupe est différée pour « arrêté depuis N s », mesurer l'écart entre
l'instant où il franchit les 600 s et l'instant de la coupe effective : il doit tomber **sous un tick
de cron**. Le relever dans `schedule_history` contre le journal du conteneur — **et pas** en comptant
les lignes `error_logs`, qui diminueront de toute façon.

### 🗓️ Test daté — au prochain passage

Relever, pour chaque coupe différée, le délai entre éligibilité et coupe effective. **Ligne de base
du 17/08 : 25 min.** Le correctif n'étant pas écrit, un second cas confirmerait que ce jour n'était
pas une singularité.

---

## TRK-028

**Signature** — *(pas une erreur observée : une promesse d'écran sans mesure derrière)*
`gps-integrity | (aucune ligne) | « le véhicule réapparaît en sortant » — sans jamais dire quand`
**Statut : 🟠 DÉPLOYÉ, NON EXERCÉ** · ouvert 2026-08-17, mesuré 2026-08-18

> ⚠️ **Fiche créée le 2026-08-18, après coup.** Le numéro TRK-028 était employé par le commit
> `5d10796` **sans qu'aucune fiche existe** dans ce référentiel — l'audit du 18/08 l'a découvert en
> cherchant le prochain numéro libre. *Un identifiant de fiche attribué dans un message de commit
> mais absent du référentiel est un renvoi mort : la fiche est écrite ici pour que la trace tienne.*

### Ce que ça veut dire

Depuis la règle du parking souterrain ([TRK-027](#trk-027)), la fiche véhicule annonce que la
position réapparaîtra à la sortie du parking — **sans dire quand**. L'exploitant devait choisir entre
croire l'écran et rappeler le conducteur : précisément le coup de fil que cet écran existe pour
éviter. Le correctif mesure la durée réelle des épisodes passés et l'annonce.

### Ce qui a été livré (commit `5d10796`, déployé le 17/08 15:54)

- **Table `gps_loss_events`** (`lostAt` · `detectedAt` · `recoveredAt` · `zoneId`), migration
  `20260817140000_retour_du_signal_gps` appliquée en production le **17/08 15:54:55**.
- **Le raccroc est à l'ingestion, pas au cron** — et c'est le point de conception : le cron
  d'intégrité tourne **sur les boîtiers sans fix**, donc un véhicule ressorti du parking a déjà
  quitté sa liste. Il ne peut structurellement pas refermer un épisode. Seule l'ingestion voit
  l'instant du retour.
- **`recordRecovery` n'est appelé que si le silence a dépassé le seuil du cron** : sur une trame
  ordinaire il n'y a pas même une requête. Sans ce filtre, un `updateMany` par trame et par véhicule
  sur la route la plus chaude du système.
- **Médiane, pas moyenne** : un week-end au parking (72 h) gonflerait une moyenne jusqu'à une durée
  que personne ne voit jamais. Sur `[180, 190, 200, 4320]` min la médiane rend 195, la moyenne 1222.
- **`recoveredAt` nullable sans défaut** : `NULL` = épisode ouvert, et c'est aussi l'état honnête des
  lignes déjà en base.

### État mesuré en production — 2026-08-18

| Mesure | Valeur |
|---|---|
| Épisodes dans `gps_loss_events` | **29** |
| Épisodes refermés (`recoveredAt` non nul) | **0** |
| Épisode le plus récent | FZ-862-VY, ouvert le **17/08 12:22:55** |

**Ce n'est pas un défaut : c'est l'absence d'occasion.** Aucun boîtier n'a retrouvé son fix après une
perte longue depuis le déploiement de 15:54. Le seul retour du jour — FZ-862-VY à 08:45 le 17/08 —
est **antérieur** au déploiement.

### 🗓️ Test daté — au prochain passage

Au premier retour de fix après une perte longue (FZ-862-VY est le candidat le plus probable), un
`recoveredAt` doit apparaître. **S'il reste nul après un retour constaté dans
`trackers.lastPositionAt`**, le raccroc à l'ingestion ne s'exécute pas — et la fiche véhicule
continuera d'annoncer une durée qu'elle ne mesure pas, ce qui serait pire que l'écran muet d'avant.

---

## TRK-027

**Signature** — *(trou assumé, pas une erreur observée)* `gps-integrity | (aucune ligne, par
conception) | une antenne morte devient silencieuse dès la 2ᵉ perte au même endroit`
**Statut : 🟠 TROU ASSUMÉ — garde-fou à écrire** · **contrepartie connue de la règle du parking** ·
ouvert 2026-08-17

> ### La règle du parking souterrain silencie un lieu. Une antenne morte se tait exactement au même endroit.

### Le contexte

Le 2026-08-17, sur constat terrain du propriétaire — *les véhicules se garent dans des parkings
souterrains* — la règle suivante a été appliquée (voir [TRK-011](#trk-011) et
[TRK-001](#trk-001)) : à la **2ᵉ** perte GPS au même endroit, le lieu est qualifié
`UNDERGROUND_PARKING` automatiquement et **n'alerte plus jamais**, sans plafond de durée.

C'est juste, et c'est mesuré : **18 des 27** lignes `gps-integrity` de production venaient du
plafond de 24 h appliqué à deux zones **déjà** qualifiées parking par un opérateur. Un parking
explique une perte de durée quelconque — congés, immobilisation longue.

### Le trou, énoncé sans détour

**Une antenne réellement morte produit le même motif.** Le véhicule se gare là où il se gare
d'habitude, le boîtier reste joignable, le fix ne revient pas. À la 2ᵉ occurrence, le lieu est
classé parking et le défaut devient **définitivement silencieux**.

C'est le trou de [TRK-011](#trk-011) — à une différence près, qui compte : il est désormais
atteignable **sans aucune décision humaine**. Avant, il fallait qu'un opérateur confirme la zone.

### Ce qui reste mesurable — la raison pour laquelle ce n'est pas une régression

Le fait n'est pas notifié ; il n'est pas invisible :

| Canal | Ce qu'il montre |
|---|---|
| Journal de synthèse du cron | nomme les véhicules silenciés **et la durée** (`FS-253-HR (5 j, parking)`) |
| Section `gps_sans_fix` de `collecte.sql` | c'est elle qui a mesuré les 113,4 h de FS-253-HR |
| Fiche véhicule / carte | la zone reste affichée, l'état « en attente GPS » reste visible |

*Un état stable qui dure se consulte ; c'est la doctrine de cette base depuis
[TRK-011](#trk-011). Ce qui change ici, c'est qu'on l'applique jusqu'au bout.*

### Le garde-fou à écrire — physique, pas temporel

Un plafond de durée est le mauvais outil : il vient d'être retiré pour de bonnes raisons. Le bon
discriminant est **le contact** :

> Un véhicule **garé** dans un parking a le contact **coupé**. Un véhicule qui **roule** sans fix
> GPS n'est dans aucun parking — c'est une antenne.

Règle proposée : silencier une zone de parking **uniquement si `lastKnownIgnition` est faux**, et
alerter dès que le contact est mis alors que le fix manque depuis plus de N minutes.

### 🔴 Le prérequis, et c'est lui qui bloque

**L'ACC n'est pas persisté sur une trame `no_fix`.** `tcp-server.service.ts:332-335` n'écrit que
`lastSeenAt` et `lastNoFixAt` :

```ts
await this.prisma.tracker.update({
  where: { imei: frame.imei },
  data: { lastSeenAt: new Date(), lastNoFixAt: new Date() },
});
```

Or `lastKnownIgnition` n'est réécrit que par le chemin des trames de **position**. Pendant une perte
GPS, il est donc **figé sur sa valeur d'avant la perte** — exactement comme `lastLat/lastLng`. Le
garde-fou ci-dessus lirait une valeur périmée, ce qui est pire qu'aucun garde-fou : il conclurait
« contact coupé » sur un véhicule en train de rouler.

⚠️ **Ne PAS écrire ce garde-fou avant d'avoir vérifié que la trame `no_fix` porte l'ACC.** Le
parseur (`coban.parser.ts:23`) construit `noFix()` avec `{ type, imei, alarm, deviceTime, raw }` —
il **jette** tout le reste. Les trames de position, elles, extraient bien `result.ignition`
(lignes 198 et 289). Il faut donc :

1. établir si la trame LBS/`no_fix` du GPS403D contient le champ ACC (lecture de trames réelles dans
   `wire_logs`, rétention 3 j — **pas** une lecture de la doc) ;
2. si oui : l'exposer dans `CobanNoFixFrame` et le persister dans `lastKnownIgnition` ;
3. seulement alors, conditionner le silence au contact.

*Sans l'étape 1, l'étape 3 est un garde-fou qui affirme une cause fausse — la famille la plus grave
du §7 de la procédure.*

### Vérification après correctif

Un véhicule dont la zone est un parking, contact **mis**, sans fix depuis plus du seuil → **doit**
produire une alerte. Le même véhicule contact **coupé**, sans fix depuis une semaine → **ne doit
rien** produire. Les deux moitiés sont nécessaires : n'en tester qu'une revient à retrouver soit le
bruit de TRK-011, soit la cécité de cette fiche.

### 🗓️ Test daté — au prochain passage

Relever, pour chaque zone qualifiée parking automatiquement, le nombre d'épisodes et la durée
maximale observée. **Signal d'alarme :** un véhicule dont un épisode « parking » dépasse **7 jours**
mérite un contrôle terrain manuel — aucune règle logicielle ne le dira, et c'est précisément ce que
cette fiche documente.

---

## TRK-024

**Signature** — `trackers | status = 'OFFLINE'` alors que `lastSeenAt` a moins de 5 minutes
**Statut : 🔴 NON CORRIGÉ** · **5 boîtiers sur 43** · découvert 2026-08-14

> ### Cinq boîtiers sont marqués hors ligne pendant qu'ils émettent — et jamais l'inverse.

### Ce que la mesure dit

| `status` | Boîtiers | Vus < 5 min | Vus < 1 h |
|---|---|---|---|
| ONLINE | 29 | 28 | 29 |
| **OFFLINE** | **14** | **5** | **6** |

**L'erreur est à sens unique.** Cinq boîtiers vivants portent `OFFLINE`, et **aucun** boîtier muet
ne porte `ONLINE` — vérifié : `status='ONLINE' AND lastSeenAt < now()-1h` rend **0**.
*Une erreur qui ne se produit que dans un sens n'est pas du bruit : c'est une course perdue toujours
du même côté.*

### Cause racine

`markOffline` (`tcp-server.service.ts:192-206`) se garde en consultant le **registre de sockets** —
`if (this.registry.has(imei)) return;` — et non la **fraîcheur de `lastSeenAt`**. Or `status:
'ONLINE'` est aussi écrit par `positions.service.ts` (lignes 83, 136, 181, 229) **à chaque trame de
position**, sur un chemin que le registre de sockets ne connaît pas : seule une trame de **login**
appelle `registry.register`.

Une écriture `OFFLINE` différée peut donc écraser un `ONLINE` plus récent qu'elle. Le code nomme
lui-même le risque — le commentaire dit « Garde anti-TOCTOU (#11) » — mais la garde **rétrécit** la
fenêtre sans la fermer : le `UPDATE` final n'est conditionné par rien.

### Ce que ça ne casse pas — vérifié, et c'est ce qui fixe la gravité

| Chemin | Lit-il `tracker.status` ? | Conséquence |
|---|---|---|
| Envoi de commande (`dispatch`) | **Non** — `registry.send()`, la socket vivante (`tracker-commands.service.ts:181`) | Les commandes partent normalement |
| Compteur « hors ligne » de `/admin/alerts` | Oui, **mais refiltré** sur `lastSeenAt` (`admin-alerts.controller.ts:346`) | Le compteur est juste — 8 à l'écran contre 14 en base |
| Liste des véhicules (API) | Exposé brut sous `trackerStatus` (`vehicles.service.ts:1025`) | **Aucun consommateur ne le lit** — la connectivité affichée est dérivée de `lastSeenAt` |

**Donc : rien ne casse aujourd'hui.** Ce qui casse, c'est le prochain lecteur. `status` est le nom
le plus évident pour « le boîtier est-il joignable », et il ment une fois sur huit. *Un champ faux
que personne ne lit est une dette, pas un incident — mais c'est une dette qui se règle en une ligne
aujourd'hui et en une enquête plus tard.*

### Correctif proposé

Rendre l'écriture **conditionnelle** plutôt que renforcer la garde :

```ts
await this.prisma.tracker.updateMany({
  where: { id: tracker.id, lastSeenAt: { lt: seuilOffline } },
  data: { status: TrackerStatus.OFFLINE },
});
```

La condition passe alors dans la même instruction que l'écriture ; aucune fenêtre ne subsiste, et
le garde-fou anti-TOCTOU existant peut rester tel quel — il devient une optimisation, plus une
protection.

### ⚠️ Ne pas « corriger » en supprimant le passage OFFLINE différé

L'anti-flapping qu'il porte est délibéré et documenté (`cancelPendingOffline`) : le supprimer
ferait clignoter le statut à chaque reconnexion. *On corrige la condition d'écriture, pas le
mécanisme.*

### Vérification après correctif

`SELECT count(*) FROM trackers WHERE status='OFFLINE' AND "lastSeenAt" > now() - interval '5
minutes'` doit valoir **0** — **pendant que** le nombre de boîtiers réellement hors ligne
(`lastSeenAt < now()-1h`) reste **inchangé** à 6. Si les deux tombent ensemble, on a cessé d'écrire
`OFFLINE` du tout.


### 2026-08-16 — 2ᵉ point identique sur la définition écrite, et les deux anomalies n'en font qu'une

| Sens | 14/08 | 15/08 | **16/08** |
|---|---|---|---|
| `OFFLINE` mais vu il y a < 5 min | 5 | 0 | **0** |
| `ONLINE` mais muet depuis > 15 min | 0 | 1 | **1** |

Deuxième mesure identique sur la définition **écrite** (5 min / 15 min, ce dernier étant
`TRACKER_ONLINE_THRESHOLD_MS`). La mesure du 14/08 n'ayant pas noté son seuil, elle n'entre pas dans
la série : il faudra un 3ᵉ point pour dire quoi que ce soit d'une cadence.

**Et le boîtier concerné n'est pas un cas isolé — il porte aussi la commande en attente du jour.**
`FZ-731-YF` (`864035054756763`) :

| Instant | Événement |
|---|---|
| 00:44:10.701 | dernière trame reçue (`trackers.lastSeenAt`) |
| 00:44:10.712 | création de la commande `fix_continuous`, motif : *« Pas de trame GPS valide depuis 60 min alors que la socket est ouverte »* |
| 01:11 (collecte) | commande toujours `SENT` (27 min), boîtier toujours `ONLINE`, **muet depuis 27 min** |

**Onze millisecondes** séparent la dernière trame de la commande émise pour y remédier. Les deux
compteurs de l'écran — « 1 commande en attente » et « 1 boîtier ONLINE muet » — ne signalent donc
**pas deux problèmes** : c'est un seul boîtier, qui a cessé d'émettre à l'instant où on lui parlait,
et dont le statut n'a pas suivi. *Deux anomalies mesurées séparément peuvent être le même
événement ; c'est l'horodatage à la milliseconde qui les recolle.*

S'y ajoute un cas de [TRK-014](#trk-014) : la commande n'obtiendra pas de réponse, et **aucun silence
ne sera tracé**, l'instrument étant désarmé depuis le 11/08.

---

## TRK-023

**Signature** — `alerts | UNKNOWN | title = "Alarme inconnue" | message = NULL` — déclenchée par
l'**accusé de réception** d'une commande de coupure moteur
**Statut : 🔴 NON CORRIGÉ** · **42 038 alertes sur 51 524 (81,6 %)** · découvert 2026-08-13 sur
1 occurrence, **élargi le 2026-08-14**

> ### 42 038 alertes partent sans une ligne de texte — dont 41 507 « Alimentation coupée » en CRITICAL et 3 SOS.

---

### 🔴 Mise à jour du 2026-08-14 — la portée réelle, et pourquoi elle avait été sous-estimée

La fiche d'hier décrivait deux défauts : (1) une réponse de commande transformée en alarme, et
(2) **une alerte sans message**. Le premier est bien resté à **une** occurrence. Le second n'a
jamais été à une occurrence — il n'avait simplement pas été compté sur la bonne colonne.

| Type | Total | Sans message | Sévérité |
|---|---|---|---|
| **POWER_CUT** | 41 507 | **41 507 (100 %)** | **CRITICAL** |
| OVERSPEED | 9 399 | 486 | WARNING |
| VIBRATION | 37 | **37 (100 %)** | — |
| **SOS** | 3 | **3 (100 %)** | — |
| LOW_BATTERY | 6 | 4 | WARNING |
| UNKNOWN | 1 | **1 (100 %)** | INFO |
| GEOFENCE_ENTER / GEOFENCE_EXIT / GPS_LOST | 571 | **0** | — |
| **Total** | **51 524** | **42 038 (81,6 %)** | |

**Cause racine, en une phrase :** `buildAlertMessage` (`alerts.service.ts:353-371`) traite
7 types — `OVERSPEED`, les trois `HARSH_*`, `LOW_BATTERY`, `GPS_LOST`, `MOVEMENT_IDLE` — et **tout
le reste tombe sur `default: return null`**. `POWER_CUT`, `SOS`, `VIBRATION`, `UNKNOWN` et
`SURVEILLANCE_TRIGGERED` n'y figurent pas. Le `null` est écrit tel quel dans `alerts.message`
(ligne 81), et la carte arrive vide chez l'exploitant.

⚠️ **`SOS` est le cas qui décide de la gravité.** Trois alertes de détresse, trois messages vides.
Le volume est dérisoire ; ce qu'il coûte ne l'est pas.

**Un second verrou, qu'un `case` de plus ne lèverait pas.** La trame porte le niveau de batterie —
`imei:864035053277480,ac alarm,260813204451,100%,F,…` — et `coban.types.d.ts:38` documente même la
position du champ (`"imei:...,tracker,<date>,<batt>%,L,..."`). Mais **`CobanPositionFrame` n'a
aucun champ batterie** : la valeur n'est jamais décodée, seulement recopiée dans `payload.raw`.
Écrire « Alimentation coupée » sans dire s'il reste 100 % ou 5 % d'autonomie n'apporterait presque
rien.

### Le cas concret du 2026-08-14 — ce que l'exploitant a vu d'un boîtier en train de mourir

| Heure (UTC) | Fait | Ce qui est remonté |
|---|---|---|
| 13/08 20:44:45 **et** 20:44:52 | alimentation coupée sur KSR370, batterie **100 %** | 2 cartes `CRITICAL` **vides** |
| 14/08 00:57:41 | batterie **5 %** | « Niveau de batterie faible détecté par le tracker » |
| 14/08 01:12:42 | batterie **0 %** | **le même texte**, sans le chiffre |
| 14/08 02:05:24 | **dernière trame**, boîtier muet | *(rien — une absence n'est pas un événement)* |

Les deux avertissements de batterie portent le **même texte** alors que l'un annonce 5 % et l'autre
0 % : le seul champ qui distinguait une alerte d'un arrêt imminent est celui qui n'est pas décodé.

### Correctif proposé (deux temps — le second est le vrai)

1. **Rendre l'alerte sans texte impossible.** Ajouter les cas manquants — au minimum `POWER_CUT`,
   `SOS`, `VIBRATION`, `SURVEILLANCE_TRIGGERED` — **et** remplacer `default: return null` par un
   repli explicite : « Alarme *`<code>`* remontée par le boîtier ». Un `null` doit cesser d'être
   une valeur atteignable pour ce champ.
2. **Décoder le pourcentage de batterie** dans `CobanPositionFrame` et le porter dans le message :
   « Alimentation coupée — le boîtier passe sur batterie interne (**100 %**) », puis
   « Batterie interne à **5 %** — le boîtier va cesser d'émettre ».

### Vérification après correctif

`count(*) FILTER (WHERE message IS NULL OR message = '')` doit valoir **0 pour les alertes créées
après la livraison** — les 42 038 historiques restent, on ne réécrit pas la donnée passée.
⚠️ **Le test porte sur la colonne, pas sur l'écran.** Un front qui afficherait le titre à la place
du message vide masquerait le défaut sans le corriger.

⚠️ **Et il ne suffit pas.** Un second test doit vérifier qu'un `POWER_CUT` neuf porte un **niveau
de batterie**, sinon on aura remplacé un vide par une phrase creuse.

---

### Le défaut d'origine — la réponse « j'ai bien coupé le moteur » devient une alarme inconnue

### La chaîne, à la seconde près

| Heure (13/08) | Sens | Ce qui se passe |
|---|---|---|
| 00:04:22.065 | — | Commande moteur **CUT** manuelle (`source = MANUAL`, motif « depuis carte ») sur KSR370 |
| 00:04:22.075 | OUT | `**,imei:864035053277480,J;` — l'enveloppe TCP correcte |
| 00:04:26.079 | IN | `imei:864035053277480,jk,260813000425,100%,F,…` |
| 00:04:26.091 | — | La commande passe **`ACKNOWLEDGED`** — latence **4,0 s** |
| 00:04:26.117 | — | **Une alerte « Alarme inconnue » est créée pour l'exploitant** |

La **même** trame fait donc deux choses opposées : elle solde correctement la commande moteur *et*
elle produit une alarme au client.

### Cause racine — trois maillons, tous justes séparément

1. **`decodeAlarm` ne connaît pas `jk`.** `coban.parser.ts:27-61` décode `jt` (acc_off), `kt`
   (acc_on), `it` (idle), `dt` (tamper), `et` (batterie faible) — et retombe sur `'unknown'` pour
   tout le reste (`return 'unknown'`, ligne 60). Le repli est raisonnable **pour une alarme**.
2. **Le mapping transforme `unknown` en alerte.** `alert-mapping.ts:44` :
   `unknown: { type: 'UNKNOWN', severity: 'INFO', title: 'Alarme inconnue' }`. C'est le seul code
   du tableau qui produit une alerte sans savoir de quoi il parle — `acc_on` et `acc_off`, eux,
   sont mappés sur `null` et ne créent rien.
3. **Le message est vide par construction.** `buildAlertMessage` (`alerts.service.ts:353-371`) ne
   traite que 6 types ; son `default: return null` s'applique à `UNKNOWN`. L'alerte arrive donc avec
   un titre, aucune explication, et la trame brute reléguée dans `payload` — que l'écran ne montre
   pas.

> **En une phrase :** un code de réponse absent du dictionnaire devient une alarme, et une alarme
> sans traduction devient une carte vide.

### Ce que la mesure dit — et ce qu'elle ne dit pas

**Dit :** le mécanisme, de bout en bout. La commande sortante, la réponse 4,0 s plus tard sur le
même IMEI, l'`ackedAt` écrit par le guetteur, et l'alerte créée 26 ms après. Trois tables
concordantes, plus le code.

**Ne dit pas :** la fréquence. Sur 3 jours, `wire_logs` compte **202 `jt`** (34 boîtiers) et
**209 `kt`** (33 boîtiers) — contre **2 lignes `jk`**, qui sont **la même trame** journalisée deux
fois (une fois en `position`, une fois en `ack`), sur **un** boîtier. Et la table `alerts` n'a
jamais contenu qu'**une seule** ligne `UNKNOWN` depuis l'origine.

⚠️ *Une occurrence ne fait pas un volume.* Ce qui justifie la fiche n'est pas le nombre, c'est que
le chemin soit ouvert : **tout code de réponse non répertorié** produira la même alerte vide, et le
parc en reçoit des centaines par jour dont on ne connaît le sens que par recoupement.

### Lien avec [TRK-014](#trk-014)

Cette fiche prolonge la rectification du 11/08, qui avait établi que `jt`/`kt` sont de **vrais
accusés de réception** des commandes moteur (`K;` → `kt`, `J;` → `jt`). `jk` est un troisième code
de la même famille, arrivé en réponse à un `J;`. **Il est correctement reconnu par le guetteur
d'ACK** — le motif générique est insensible à la casse — donc la commande est bien soldée ; il
n'est pas reconnu par le décodeur d'**alarmes**, qui est un chemin distinct. *Deux lecteurs de la
même trame, deux dictionnaires, un seul tenu à jour.*

### Correctifs proposés

1. **Ne pas transformer une réponse de commande en alarme.** Le chemin d'alarme doit ignorer les
   trames corrélées à une commande sortante récente — l'information existe déjà : le guetteur d'ACK
   les identifie dans la même seconde. À défaut, ajouter `jk` (et tout code à deux lettres de la
   famille des échos) au dictionnaire, mappé sur `null` comme `jt` et `kt`.
2. **Une alerte sans message ne doit pas partir.** Si `buildAlertMessage` retourne `null` pour un
   type dont le titre ne se suffit pas, composer un message à partir de la trame plutôt que de
   laisser un vide : « code d'alarme non reconnu (`jk`) — trame conservée pour analyse ». Un
   opérateur ne peut rien faire de « Alarme inconnue » tout court.
3. **Rendre les codes inconnus comptables.** Un compteur des codes tombés dans le repli `unknown`,
   par code et par boîtier, sur 30 jours. C'est ce qui permettra de savoir si `jk` est un cas isolé
   ou la partie visible d'un dictionnaire en retard sur le firmware.

### ⚠️ Ne pas « corriger » en supprimant le mapping `unknown`

Le rendre `null` ferait disparaître l'alerte vide **et** toute trace d'un code non reconnu — donc
la seule chance de découvrir une alarme réelle que le parseur ne sait pas encore lire. *On corrige
le message, pas le garde-fou.* Ce mapping est un filet ; il lui manque un texte, pas une
suppression.

### Vérification après correctif

Plus aucune alerte `UNKNOWN` n'est créée à la suite immédiate d'une commande sortante vers le même
IMEI — **et** le compteur de codes tombés dans `unknown` continue de se remplir dans les journaux.
Si ce compteur tombe à zéro en même temps, on a fermé les yeux au lieu de trier.


### 2026-08-16 — dormant pour la 2ᵉ journée, et le cas KSR370 est clos sans réponse

**42 038** alertes sans message sur **51 529** — le numérateur n'a pas bougé d'une unité, le
dénominateur a pris les 3 `GPS_LOST` du jour. Sur 24 h : **3 alertes, toutes `GPS_LOST`, toutes avec
message**. Aucun `POWER_CUT`, `SOS` ni `VIBRATION` n'a été émis.

**Le défaut est dormant, pas corrigé.** Un compteur à zéro qui mesure une absence d'événement ne dit
rien de la fonction qui l'écrirait.

**Issue du cas concret :** KSR370 (`864035053277480`) n'a plus émis depuis le **14/08 02:05:24**,
soit **47,1 h**. Ses deux `POWER_CUT` `CRITICAL` du 13/08 20:44 restent **sans message**, et le seul
chiffre qui distinguait « alerte » de « arrêt imminent » — le pourcentage de batterie porté par la
trame — n'a jamais été décodé. Contrôle terrain demandé depuis le 15/08.

> ⚠️ **Et un second boîtier s'est éteint le 15/08 — sans être le même cas.** HD-779-MA s'est tu à
> 12:48:21 **sans aucun `POWER_CUT`**, en annonçant **100 % de batterie jusqu'à sa dernière trame**.
> *Deux extinctions à un jour d'écart ne partagent pas forcément une cause : c'est la colonne
> « batterie » des trames brutes qui les sépare, et c'est précisément celle que cette fiche
> reproche à `CobanPositionFrame` de ne pas porter.*

---

## TRK-037

**Signature** — `trip-analysis | ERROR | Limites de vitesse indisponibles : Overpass (OpenStreetMap) injoignable sur <N> requete(s) — les exces de vitesse ne sont pas affirmes sur ce trajet, le reste de l'analyse est conserve. Cause : Overpass HTTP <CODE>`
**Statut : 🔵 TERRAIN / dépendance tierce** · **gravité 3** · découvert 2026-08-21

**6 occurrences le 20/08** (05:47, 10:47, 14:46, 20:48, 22:45, 23:48) — causes **HTTP 500** (×4) et
**HTTP 502** (×2). L'instance visée est `https://overpass.kumi.systems/api/interpreter` : **un miroir
public et gratuit** d'OpenStreetMap, sans engagement de service.

### Ce n'est pas un défaut de fabrication, et il faut le dire

`speed-limit.service.ts` est soigné : déduplication par cellule, cache en base, lots de 200 points,
plafond de 8 requêtes, backoff 4 s / 12 s avec rejeu des refus de quota, une seule alerte par
analyse. Et `trouvee === false` n'est **pas** mémorisé — le commentaire nomme le bug que ça avait
causé, *59 347 points stérilisés*. Le message porte la **dépendance** et la **conséquence**, ce que
ce référentiel réclame depuis [TRK-005](#trk-005).

### Le vrai préjudice n'est pas la panne : c'est le silence sur la panne

Sur ces analyses, les excès de vitesse ne sont **pas affirmés** — mais le reste de l'analyse est
conservé et **rendu sans mention de la lacune**. L'exploitant reçoit une notation A→E qui **paraît
complète** et qui a été calculée sans l'un de ses critères.

> 🔑 **Une dégradation qui ne se déclare pas au lecteur du résultat n'est pas une dégradation
> gracieuse : c'est un résultat faux avec un air juste.** L'alerte existe, elle est exacte, elle est
> au centre d'alerte — et elle s'adresse à l'exploitant du système, jamais au lecteur du trajet.

### ⚠️ Cette fiche ne peut pas dater son premier cas

La plus ancienne ligne survivante de toute la table `error_logs` **est l'une de ces six**
(20/08 05:47:16). Tout ce qui précède a été effacé, cf. [TRK-035](#trk-035). *Le coût de la
suppression hors application ne se paie plus en théorie : il vient d'empêcher une fiche neuve de
savoir depuis quand son défaut dure.*

### Correctif proposé — l'action n'est pas d'abord du code

1. **Décider de l'instance Overpass.** Un miroir public gratuit n'offre aucun engagement ; une
   instance dédiée ou un abonnement est une décision d'exploitation.
2. **Repli sur une seconde instance** avant de renoncer — le code n'en connaît qu'une.
3. **Marquer l'analyse comme incomplète** quand les limites sont inconnues. *C'est le seul des trois
   qui répare le préjudice réel.*

**Vérification.** Une analyse dont les limites n'ont pas pu être résolues doit être identifiable
depuis l'écran de trajet, sans lire `error_logs`.

---

## TRK-038

**Signature** — *(défaut de plateforme, pas une ligne d'erreur)*
`plateforme | AUCUNE LIGNE | garde anti-repetition d'alerte tenue en memoire de processus — remise a zero par tout redemarrage`
**Statut : 🔴 NON CORRIGÉ** · **gravité 3** · découvert 2026-08-21 *(en enquêtant sur [TRK-037](#trk-037))*

`SILENCE_ALERTE_MS` vaut **6 heures**. Les six lignes du 20/08 sont pourtant espacées de :

| Intervalle | Durée | Explication |
|---|---|---|
| 05:47 → 10:47 | **5 h 00** | migration `diagnostics_zones_gps` à **10:19** |
| 10:47 → 14:46 | **3 h 59** | 🔴 **aucun redémarrage connu** |
| 14:46 → 20:48 | **6 h 02** | ✅ **la garde a tenu** |
| 20:48 → 22:45 | **1 h 57** | migration `passages_agents_locaux` à **22:27** |
| 22:45 → 23:48 | **1 h 03** | conteneurs recréés à **23:40** |

`derniereAlerteAt` est un **champ d'instance** d'un service `@Injectable()` de portée singleton, et
il n'y a **qu'une réplique** `tracky-api`. La garde n'a donc qu'un moyen de retomber à zéro : **le
redémarrage du processus.**

> 🔑 **La garde n'est pas cassée — elle est volatile.** L'intervalle de 6 h 02 le prouve : quand le
> processus vit, elle fait exactement son travail. *Un garde-fou contre les rafales, remis à zéro par
> l'événement qui provoque le plus de rafales.*

### C'est une famille, pas un cas

| Fichier | Champ | Ce qu'il protège |
|---|---|---|
| `trip-analysis/speed-limit.service.ts:83` | `derniereAlerteAt` | l'alerte Overpass ([TRK-037](#trk-037)) |
| `observability/error-rate-watchdog.service.ts:34` | `lastAlertAt` + `COOLDOWN_MS` | l'alarme de **flambée d'erreurs** |
| `sms/allowlist.service.ts:153` | `lastEpisodeAlertAt` | l'alarme du **trou d'allowlist** ([TRK-017](#trk-017)) |
| `surveillance/surveillance-scheduler.service.ts:60` | `lastDormantSummaryAt` | la synthèse **véhicules dormants** |

⚠️ **Ne pas y ajouter les `lastCallAt` / `lastPrune` voisins** : ce sont des limiteurs d'appels
sortants, pas des refroidissements d'alerte. Un redémarrage les remet à zéro sans conséquence.
*Deux champs qui se ressemblent au `grep` ne portent pas le même enjeu.*

> 🔑 **Le cas le plus embarrassant est le deuxième.** L'instrument chargé de crier quand les erreurs
> flambent porte son propre anti-flambée en mémoire — et se retrouve réarmé par le déploiement, qui
> est précisément le moment où les erreurs flambent. *Il est le plus bruyant quand on a le moins
> besoin de lui, et le plus calme quand on l'a déjà entendu.*

### Correctif proposé

Tirer la dernière émission de la **donnée** plutôt que d'un champ, pour les quatre. Pour
`speed-limit`, la requête existe déjà en substance :

```sql
SELECT max("createdAt") FROM error_logs
WHERE source = 'trip-analysis' AND context->>'feature' = 'speed-limit-osm';
```

> 🔴 **AMENDEMENT DU 2026-08-22 — NE PAS APPLIQUER CE CORRECTIF TEL QUEL.** L'enquête sur
> [TRK-039](#trk-039) a montré ce jour-là qu'un garde-fou dont la mémoire vit dans `error_logs`
> **se fait réarmer par l'effaceur de [TRK-035](#trk-035)** : la ligne du 20/08 a disparu, et
> l'agent a réémis deux jours plus tard au lieu de sept. Appliquer ce correctif tel quel
> échangerait un défaut connu contre celui-là, **sur quatre gardes au lieu d'une**.
>
> Le principe reste juste — l'état doit vivre dans la **donnée**, pas dans un champ d'instance —
> mais **pas dans la table que quelqu'un vide**. *Un garde-fou ne doit pas ranger sa mémoire dans
> la pièce qu'il surveille.* Écrire l'état dans une table dédiée, ou attendre que TRK-035 soit
> refermée.

Coût : une requête **uniquement** quand toutes les requêtes ont échoué — c'est-à-dire rare.

### Ce qui reste ouvert

L'intervalle **10:47 → 14:46** n'est expliqué par aucun redémarrage connu. Les migrations sont la
seule horloge des déploiements sur cet hôte — le tag `latest` ayant détruit l'historique des images,
cf. la réserve de [TRK-019](#trk-019) — et elles n'en datent aucun à cette heure. **Fait consigné,
non expliqué.**

**Test daté — 22/08.** Si aucun déploiement n'a lieu d'ici demain, deux lignes `speed-limit-osm`
distantes de moins de 6 h prouveraient que le redémarrage n'est *pas* la seule cause.
*Condition de nullité : si un déploiement a lieu, le test ne conclut rien et il est réarmé.*

---

## TRK-039

**Signature** — `GPS_QUALITE | ERROR | <PLAQUE> perd le signal a <N> endroits distincts, repartis sur <DIST> km, sans qu'aucun autre vehicule n'ait le meme probleme a ces endroits (<N> episodes). Controler le boitier : antenne, fixation, alimentation.`
**Statut : 🔴 NON CORRIGÉ** · **gravité 2** · découvert 2026-08-21

Une occurrence, le **20/08 10:01:52**, sur **KSR370**. La source est neuve : l'agent qualité GPS
(`outils/agent-qualite-gps.cjs`, commit `8c952067`) est en production depuis le 20/08.
**Trois choses fausses se superposent dans une seule ligne.**

### 1. La donnée a jusqu'à 19 jours, et rien ne la borne

Les 6 zones de KSR370 ont pour dernière occurrence le **2026-08-01 00:15** — dix-neuf jours avant
l'alerte. La fonction `zones()` de l'agent lit `gps_dead_zones` **sans aucune fenêtre temporelle**.

### 2. Le boîtier est mort depuis sept jours, et sa mort est déjà expliquée ailleurs

KSR370 (IMEI `864035053277480`) n'a plus émis depuis le **14/08 02:05:24**. Et le référentiel sait
pourquoi : coupure d'alimentation le 13/08 à 20:44, batterie de secours à **5 %** à 00:57 puis
**0 %** à 01:12, dernière trame à 02:05 — le cas concret de [TRK-023](#trk-023). *Envoyer un
technicien contrôler une antenne est l'action la moins utile qu'on puisse tirer de ce dossier.*

### 3. Le discriminant est infranchissable — et c'est le défaut de fond

Le verdict « boîtier » exige `zones >= 4` **et** `étalement >= 3 000 m` (`ZONES_MIN_BOITIER`,
`ETALEMENT_BOITIER_M`). KSR370 : **6 zones**, étalement **580 928 m** — **193 fois** le seuil. Ses
lieux sont Toulouse, **Benidorm** (×2), Plaisance-du-Touch, Ramonville-Saint-Agne : un aller-retour
Toulouse–Espagne.

> 🔑 **La prémisse est juste, le discriminant ne la teste pas.** Le commentaire du module dit vrai —
> *« un boîtier mourant perd le signal PARTOUT »*. Mais « partout » y est mesuré en **mètres
> d'étalement**, et l'étalement d'un véhicule mesure d'abord **la distance qu'il parcourt**. Pire, la
> corroboration croisée — *« sans qu'aucun autre véhicule n'ait le même problème à ces endroits »* —
> est **impossible à franchir** pour un véhicule qui roule là où aucun autre de la flotte ne va.
> Benidorm ne sera jamais corroboré. **Plus un véhicule voyage loin et seul, plus il est certain
> d'être déclaré en panne.** *Une absence de preuve est retournée en preuve.*

**Famille (§7) : mensonger** — il affirme une cause fausse et envoie enquêter au mauvais endroit,
la catégorie que la procédure tient pour la plus grave.

> ✅ **Le versant « lieu » du même agent, lui, se comporte correctement** : il exige **2 véhicules**
> avant de conclure, et son unique diagnostic du jour (FW-298-WV + GS-928-NX, Toulouse) les a. *Le
> défaut n'est pas dans l'agent : il est dans la branche qui n'a pas cette exigence.*

### Correctif proposé

1. **Borner `zones()` dans le temps** (30 j) — un diagnostic bâti sur des zones de trois semaines
   décrit un passé révolu.
2. **Contrôler la vie du boîtier** — ne pas diagnostiquer la qualité GPS d'un tracker `OFFLINE`
   depuis plus de 24 h.
3. **Cesser de conclure « boîtier » quand aucune zone n'a pu être corroborée** faute d'un autre
   véhicule sur le secteur : c'est le cas `indeterminé`, pas le cas `boitier`.
4. **Normaliser l'étalement** par la distance parcourue, ou exiger que les zones soient dispersées
   *dans une même aire d'exploitation*.

⚠️ **Ne pas corriger en montant le seuil.** Porter `ETALEMENT_BOITIER_M` à 600 km blanchirait
KSR370 et laisserait le défaut entier : le prochain véhicule qui descend en Espagne le rejouera.
*C'est le critère qui est faux, pas son réglage.*

**Test daté — 27/08.** `JOURS_SANS_REPETITION` vaut 7 : sous le code actuel, la même ligne doit
**réapparaître** le 27/08 sur KSR370, dont l'état n'aura pas changé. Sa réapparition confirme la
fiche sur un second point. *Condition de nullité : si KSR370 est déposé ou remis en service d'ici
là, le test n'a plus d'objet.*

### 🎯 2026-08-22 *(enquête)* — LA CAUSE EST TROUVÉE, ET CE N'EST PAS L'ANTI-RÉPÉTITION

La ligne est réapparue le **22/08 à 06:07:25** sur KSR370, deux jours après celle du 20/08 et non
sept. **Ce n'est pas le délai qui a failli : c'est sa mémoire qui a été effacée.**

#### La mémoire de l'anti-répétition, c'est `error_logs` lui-même

`outils/agent-qualite-gps.cjs:99-107` — `dejaSignalees()` interroge la table des erreurs pour
savoir qui a déjà été signalé :

```sql
SELECT DISTINCT context->>'plaque' FROM error_logs
WHERE source = 'GPS_QUALITE'
  AND "createdAt" > now() - interval '7 days';
```

**Le garde-fou n'a pas d'état à lui. Son état, c'est la ligne qu'il a écrite la fois d'avant.**

#### La chaîne, mesurée

| Fait | Mesure |
|---|---|
| La ligne du 20/08 dans `error_logs` | **absente** — 1 seule ligne `GPS_QUALITE`, celle du 22/08 |
| Dans la table d'archive | **absente** aussi |
| Ce que `dejaSignalees()` aurait rendu à 06:07 | **`[]`** — vide |
| Ce qu'elle rend maintenant | **`["KSR370"]`** |
| Passage de l'agent le **21/08 04:27** | « **0** boîtier signalé » — la mémoire tenait |
| Passage de l'agent le **22/08 06:07** | « **1** boîtier signalé » — la mémoire avait disparu |

La suppression tombe dans la fenêtre des **73 lignes effacées** entre le 21/08 04:31 et le 22/08
01:11 ([TRK-035](#trk-035)). *L'anti-répétition fonctionne exactement comme écrite ; elle a repris
à zéro parce qu'on lui a retiré ce sur quoi elle comptait.*

#### 🔴 L'hypothèse écrite quelques heures plus tôt est RÉFUTÉE

Ce document a d'abord conclu que « la clé d'anti-répétition inclut le compte d'épisodes », sur la
foi du seul chiffre qui avait bougé (2 → 9) pendant que zones et étalement restaient identiques.
**C'est faux.** La clé est la **plaque**, rien d'autre. Le compte d'épisodes a changé dans la même
période, sans lien de cause.

> 🔑 **La seule variable qui bouge n'est pas forcément la cause — surtout quand on n'a pas cherché
> celles qui ont disparu.** Le raisonnement portait sur ce que la table contenait ; l'explication
> était dans ce qu'elle ne contenait **plus**. *Devant deux mesures qui diffèrent, se demander
> d'abord si le référentiel de comparaison a survécu entre les deux.*

#### Ce que ça révèle, et qui dépasse cette fiche

**Effacer `error_logs` ne détruit pas seulement de la connaissance : ça RÉARME des boucles
d'alerte.** Tout composant qui se sert de cette table comme mémoire voit sa déduplication remise à
zéro par l'effaceur — et réémet. C'est une conséquence de second ordre de [TRK-035](#trk-035) que
rien n'avait identifiée, et elle se paie en fausses alertes, pas seulement en oubli.

> ⚠️ **CONSÉQUENCE DIRECTE POUR [TRK-038](#trk-038), À LIRE AVANT D'ÉCRIRE SON CORRECTIF.** Le
> correctif proposé le 21/08 pour les quatre gardes anti-répétition « en mémoire de processus » est
> précisément de **tirer la dernière émission de `error_logs`** :
>
> ```sql
> SELECT max("createdAt") FROM error_logs
> WHERE source = 'trip-analysis' AND context->>'feature' = 'speed-limit-osm';
> ```
>
> **Ce correctif échangerait un défaut connu contre celui-ci, sur quatre gardes au lieu d'une.** Il
> reste bon *sur le principe* — l'état doit vivre dans la donnée, pas dans un champ d'instance —
> mais **pas dans la table que quelqu'un vide**. *Un garde-fou ne doit pas ranger sa mémoire dans
> la pièce qu'il surveille.*

#### Ce qui reste vrai de la fiche

Le défaut de fond est **confirmé sur un second point** : le verdict « contrôler le boîtier » a été
réémis sur un tracker mort depuis 8 jours, dont la cause est documentée ailleurs
([TRK-023](#trk-023)). Les quatre correctifs proposés restent valables — **plus un cinquième** :
donner à l'anti-répétition une mémoire qui ne soit pas `error_logs`.

#### 🗓️ Test daté — ANNULÉ et remplacé

Le test posé pour le 27/08 (« la ligne doit réapparaître ») **n'a plus d'objet** : il testait la
durée, et la durée n'est pas en cause. Le test posé cet après-midi (« une ligne doit apparaître dès
que le compte d'épisodes bouge ») est **retiré** — son hypothèse est réfutée.

**Nouveau test, et il porte sur TRK-035 plutôt que sur cette fiche :** tant que `disparitions_lignes`
reste vide, aucune ligne `GPS_QUALITE` ne doit apparaître sur KSR370 avant le **29/08** (7 jours
après le 22/08). *Une ligne plus tôt, avec un constat de disparition entre les deux, confirmerait
le mécanisme sur un second cas. Une ligne plus tôt SANS constat le réfuterait — et il faudrait
alors chercher ailleurs.*

---

## TRK-040

**Signature** — ce n'est pas une ligne `error_logs` mais un **verdict de classement**, visible sur la
fiche véhicule (`trackers.lastPowerNotice`) :
`alarme-alimentation | contact_coupe | "Batterie interne à <N> % : alimentation externe absente, mais le boîtier n'est pas en péril. Typique d'un contact coupé sur un montage commuté."`
**Statut : 🔴 NON CORRIGÉ** · **gravité 2** · 1 cas mesuré, 1 boîtier perdu · 2026-08-21

### Le cas, à la trame près

DZ-034-CA, IMEI `864035054756177`, le 2026-08-21 :

| Heure | Fait | Batterie |
|---|---|---|
| **06:00:07** | trame **`kt` — contact REMIS** | 100 % |
| **06:23:46** | 1ʳᵉ `ac alarm` → verdict **`contact_coupe`**, **0 alerte** | **100 %** |
| 06:40 → 06:48:33 | salve de 7 `ac alarm` ; `lastPowerNotice` figée : *« pas en péril »* | 100 % |
| 07:00 | — | 96 → 83 % |
| 08:00 · 09:00 · 10:00 | — | 84 → 72 · 75 → 63 · 64 → 29 % |
| **11:27:45** | `low battery` → 1ʳᵉ alerte, `LOW_BATTERY` **WARNING** | **12 %** |
| 11:42:47 | `low battery` | 5 % |
| 12:14:52 | `ac alarm` en `no_fix` | 0 % |
| **12:36:14** | **`POWER_CUT` CRITICAL** (message complet, cf. [TRK-023](#trk-023)) | 0 % |
| **12:43:53** | **dernière trame. `OFFLINE` depuis.** | 0 % |

**6 h 12 min 28 s** entre la première trame qui annonçait la perte et la première alerte.

### Cause racine — le discriminant est en retard sur ce qu'il doit trancher

`apps/api/src/alerts/alarme-alimentation.ts` classe **chaque trame isolément**, sur le seul niveau de
batterie : `>= SEUIL_BATTERIE_COUPURE (90) ⇒ contact_coupe`. Le commentaire du module énonce la
prémisse : *« Une VRAIE coupure vide la batterie de secours. Un contact coupé la laisse pleine. »*
C'est exact — **au bout d'un moment**.

> 🔑 **À l'instant zéro d'une vraie coupure, la batterie de secours est pleine par définition.** Les
> deux cas que ce test doit séparer sont donc **rigoureusement identiques au moment où il les
> sépare**. Ce qui les distingue est la **pente**, et la pente n'existe pas encore. *Un critère qui a
> besoin de temps ne peut pas rendre un verdict instantané — il peut seulement décider d'attendre.*

### Le discriminant qui aurait tranché était déjà dans les trames

Le module décrit lui-même le mécanisme bénin : *« `jt` (contact coupé) à 20:00, salve d'`ac alarm` à
00:44, `kt` (contact remis) à 06:00 »*. Ici la séquence est **inversée** — `kt` à **06:00:07**, puis
`ac alarm` à **06:23:46**. **Un montage sur +12 V commuté ne peut pas perdre son alimentation
23 minutes après que le contact a été REMIS.** La prémisse du verdict était réfutée par la trame
précédente, dans la même table.

### Ce n'est pas [TRK-032](#trk-032)

Vérifié : `engine_control_commands` rend **0 ligne** pour ce tracker, sur tout l'historique. Le
garde `moteurCoupeParNous` n'a pas joué. **Deux mécanismes silencient au même endroit ; celui-ci est
le test de batterie, seul.**

### Famille — **mensonger** (§7)

Il affirme une cause fausse (« typique d'un contact coupé »), et il l'affirme sur la surface que
l'exploitant consulte pour juger. Aujourd'hui encore, 12 h après la mort du boîtier, la fiche
véhicule porte la phrase écrite à 06:48.

### Correctifs proposés

1. **Croiser avec le contact — le geste le moins cher et le plus décisif.** `analyserAlimentation()`
   reçoit déjà un `contexte` : y ajouter l'état du contact et **ne faire confiance au test de
   batterie que lorsque le contact est coupé**. Contact ON + `ac alarm` → `coupure_reelle`, ou à
   défaut `indetermine` — qui alerte, conformément au choix déjà écrit et commenté dans le module.
2. **Différer au lieu de trancher.** Batterie ≥ 90 % **et** contact coupé → ne rien conclure,
   réexaminer à T+30 min. Si l'alimentation manque toujours **et** que la batterie a baissé, c'est
   une coupure — et l'alerte doit porter l'heure de la **première** trame (06:23), pas celle de la
   découverte (12:36).
3. **Périmer `lastPowerNotice`.** Une note qui affirme « pas en péril » doit être remplacée dès que
   le même boîtier produit un `coupure_reelle`, ou expirer d'elle-même. Elle survit aujourd'hui à la
   mort du boîtier et contredit le centre d'alerte.

### ⚠️ Ne pas « corriger » en baissant le seuil

Le seuil de 90 % est une décision du propriétaire et il fait son travail : 202 alertes inutiles
supprimées en 24 h. Le passer à 80 % n'aurait gagné qu'environ une heure sur les 6 h 12 de ce cas,
au prix du bruit revenu. *Ce n'est pas le réglage qui est faux, c'est le fait de conclure sans le
contact.*

### ⚠️ Ne pas lire ce cas comme une condamnation du correctif du 19/08

Il reste juste et mesuré : les 4 `ac alarm` du 20/08 étaient bien bénignes, et sans lui DZ-034-CA
aurait produit une salve de CRITICAL. **Il manque une entrée, pas une refonte.**

### Vérification après correctif

Rejouer la séquence du 21/08 (`kt` 06:00:07 → `ac alarm` 06:23:46 à 100 %) : l'analyse doit rendre
`alerter: true`. Un cas témoin `jt` → `ac alarm` à 100 % doit continuer de rendre `contact_coupe`.
*Les deux, sinon on a seulement déplacé le défaut.*

---

## TRK-041

**Signature** — absence d'écriture, pas une ligne : `allowlist_audit_logs` n'enregistre **aucune**
tentative dont la clé d'API n'est pas valide.
**Statut : 🔴 NON CORRIGÉ** · **gravité 2** · lié à [TRK-017](#trk-017) et [TRK-025](#trk-025) ·
2026-08-22

### Comment on est tombé dessus — en vérifiant une bonne nouvelle

La rotation de clé du 20/08 est **confirmée par la donnée de la passerelle elle-même** :

| Préfixe | Résultat | Origine | n | Première | Dernière |
|---|---|---|---|---|---|
| `vtx_48fe` | `ok` | `172.18.0.1` | 246 | 10/08 19:25 | **20/08 13:25** |
| `vtx_d4f3` | `ok` | `172.18.0.1` | 35 | **20/08 14:25** | 22/08 00:25 |
| `vtx_48fe` | `removals_blocked` | **`82.67.153.51`** | **49** | 10/08 19:25 | **17/08 19:24:59** |

Bascule nette à 13:34 (`tenants.updatedAt`), aucun chevauchement, réconciliation horaire vivante.

### Cause racine — le témoin était accroché au succès de l'authentification

`allowlist_audit_logs.tenantId` est **`NOT NULL`**. La ligne d'audit ne peut être écrite qu'**après**
qu'une clé valide a permis de résoudre le locataire. Une requête présentant la clé révoquée est
rejetée en amont et **ne laisse aucune trace dans cette table**.

> 🔑 **On a réparé la serrure et jeté le judas.** Les 49 blocages étaient la seule chose qui prouvait
> qu'un tiers détenait la clé de production. Après rotation, l'attaquant qui revient et celui qui a
> renoncé produisent **exactement la même donnée : rien**. *Un compteur figé se lit spontanément
> « il ne se passe plus rien » ; celui-ci doit désormais se lire « on ne peut plus rien voir ».*

### Ce que ça change pour la lecture des passages suivants

Blocages **49 (+0)**, dernier le **17/08 19:24:59** — **102,0 h** de silence, le plus long de la
série (32 h, 30 h, 54 h, 81 h auparavant). Ce record **ne peut pas** être porté au crédit de la
rotation : l'appelant s'était tu **trois jours avant elle**. Et depuis, l'instrument est aveugle.
**9ᵉ silence lu comme un silence — et le premier qui ne prouve même pas une absence.**

### Correctif proposé

Journaliser côté passerelle les **authentifications refusées** — préfixe de clé présenté, IP, route,
horodatage — dans une table qui **n'exige pas de locataire résolu**. Sans elle, « 49, inchangé » sera
rapporté comme rassurant indéfiniment.

### ⚠️ Ne pas se contenter d'un compteur agrégé

« N refus d'authentification » ne suffit pas. Ce qu'il faut savoir, c'est **quel préfixe** est
présenté depuis **quelle IP** : c'est ce qui distinguera un client mal reconfiguré de l'instance qui
portait `vtx_48fe`.

### Vérification après correctif

Une requête volontaire avec une clé invalide, depuis une IP connue, doit produire une ligne
consultable — sans locataire.

---

## TRK-042

**Signature** — `scheduled-task-heartbeat | CRITICAL | Tâche planifiée à l'arrêt : « <TÂCHE> » est ACTIVÉE mais ne tourne plus — aucun passage enregistré depuis son activation (cadence configurée : <CADENCE>, seuil d'alerte <DURÉE>).`
**Statut : 🟢 CORRIGÉ ET DÉPLOYÉ** *(22/08 13:31, vérifié par le comportement)* · 7 occurrences ·
1 tâche · 2026-08-22

### Ce qui s'est passé, à la minute près

| Heure | Fait |
|---|---|
| **06:00:51** | « Automatisation des lieux » **tourne** — 2 lieux analysés, 0,04 €, `stopReason: completed`. C'est un **`dry-run`**, qui n'écrit pas `lastRunAt`. |
| **06:02:23** | la tâche est **activée** (`placeAutomationSettings.updatedAt`) |
| **06:35:00** | 1ʳᵉ `CRITICAL` — **33 minutes** après l'activation |
| 07:35 → 12:35 | 6 autres, **une par heure** |

La tâche est **quotidienne à 03:00**. Son premier passage possible était **21 heures plus tard**.

### Cause racine — une naissance lue comme une panne

`observability/scheduled-task-heartbeat.service.ts` : la branche « aucun passage enregistré »
alertait **immédiatement**, sans aucune borne de durée.

```ts
if (!state.lastRunAt) {
  this.report(task.name, state.cadence, null, maxSilenceHours);  // tout de suite
```

Les autres branches, elles, sont soignées : la cadence est **lue** et non supposée (correctif du
03/08 après une fausse alerte), la tolérance vaut deux périodes avec un plancher de 4 h. **Tout le
raisonnement sur la durée était écrit — et cette branche-là n'en bénéficiait pas.**

> 🔑 **Même défaut que [TRK-030](#trk-030), sur un autre module.** Là, un boîtier **neuf** était
> accusé de panne d'antenne **51 s avant son premier fix**, la branche « jamais localisé » n'ayant
> elle non plus aucune borne. *Deux modules, un seul motif : une branche « ça n'est jamais arrivé »
> traitée comme « c'est cassé ». Il vaut la peine de chercher les autres `if (!lastX)`.*

### Famille — **faux positif** (§7)

Il décrit un refus voulu — l'attente normale d'une tâche qui n'est pas encore due — comme une faute.

### Correctif livré

Quand `lastRunAt` est nul, le silence se compte depuis la **configuration** de la tâche
(`updatedAt` des réglages) et la **même** tolérance s'applique. Le message porte désormais la durée
d'attente : *« aucun passage depuis son activation il y a 200 h »* se juge, *« aucun passage »* ne
se juge pas.

### ✅ Vérifié PAR LE COMPORTEMENT, pas par un marqueur

Déploiement à **13:31:05**. Le passage de **13:35** — le premier après mise en ligne — **n'a rien
écrit**, et la série horaire ouverte depuis 06:35 s'arrête net. *Un marqueur dit qu'un code est
là ; un instrument qui cesse de crier au moment où on lui apprend à attendre le prouve.*

### ⚠️ Deux réserves, assumées

- **`updatedAt` bouge à chaque édition des réglages** : modifier une tâche qui n'a **jamais** tourné
  lui redonne une fenêtre. Portée bornée — dès qu'un passage existe, `lastRunAt` fait foi.
- **Sans repère de configuration, on signale quand même** (ancien comportement). Se taire faute de
  repère masquerait une vraie panne : c'est l'inverse du défaut corrigé.

### ⚠️ Le piège de test corrigé au passage — le plus instructif de la passe

Le test « jamais tourné » mockait **sans `updatedAt`** — donc `undefined`, là où Prisma rend
**toujours** une date. Il serait resté **vert en décrivant un comportement qui n'existe nulle
part**, et le correctif serait passé pour testé sans l'être.

*C'est exactement le piège payé le 17/08* (garde écrite sur `reviewedAt === null`, verte en test,
divergente en base). Le harnais injecte désormais `updatedAt` **par défaut** : un test peut le
**choisir**, il ne peut plus l'**oublier**.

### Ce qui reste ouvert

Les 7 lignes déjà écrites restent au centre d'alerte. Elles sont **archivables** — un faux positif
compris et classé, pas supprimé.

---

## TRK-044

**Signature** — pas une ligne : un SILENCE. `place_automation_runs` sans aucune ligne
`origin='scheduled'` malgré `enabled=true` — et aucun des trois filets ne pouvait le voir.
**Statut : 🟢 CORRIGÉ ET DÉPLOYÉ le 23/08** · défaut présent depuis l'origine · 2026-08-23

### Comment on est tombé dessus

En vérifiant le test daté de [TRK-042](#trk-042) : le créneau planifié réel de la tâche était
01:10 UTC (hour=3 **Europe/Paris**, tick à HH:10 — le référentiel croyait « 03:00 UTC », lui
aussi corrigé). Toutes conditions réunies — activée, `lastRunAt` nul, processus vivant, le cron
d'à côté (allowlist, :25) tournait — et **rien** : ni ligne, ni erreur, ni journal.

### Cause racine — un habillage de locale dans un `Number()`

```
parisHour = Number(new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', ... }).format(date))
```

En français, un format à heure SEULE rend **« 04 h »**, pas « 04 ». `Number("04 h")` = **NaN**,
et `NaN !== settings.hour` quelle que soit l'heure : **la porte était fermée à toute heure,
en silence** — le `return` de la garde ne journalise rien (même famille que TRK-043).
Vérifié dans le conteneur de production (node v20.20.2) : `"04 h"` → NaN.

### Pourquoi RIEN ne l'a vu — trois filets, trois angles morts

1. **Les tests** recalculaient `parisHour()` côté test avec LA MÊME fonction : NaN comparé à
   NaN+5 « passe pour la bonne raison apparente ». Seul un instant FIGÉ avec résultat connu
   d'avance aurait crié — c'est la forme des tests neufs.
2. **La sonde des tâches** ([TRK-042](#trk-042)) mesure le silence depuis `lastRunAt`… que
   chaque **run manuel de vérification** réécrit : tester la tâche à la main REPOUSSAIT le
   moment où la sonde aurait fini par crier.
3. **La jumelle des trajets était saine** (`en-GB` + `parseInt` + garde `isFinite`) — deux
   copies privées du même calcul avaient divergé, et la production `hourly` n'exerçait pas la
   branche `daily` qui aurait révélé l'écart.

### Correctif

Util commun `heureParis()` dans `common/utils/datetime.ts` : `formatToParts` (le champ heure
isolé, sans habillage de locale), `hourCycle: 'h23'` (minuit = 0, jamais « 24 »), et un REPLI
qui **émet** plutôt qu'il ne se tait (heure UTC du serveur — un run décalé se voit au journal,
un run absent ne se voit nulle part). Les deux copies privées délèguent : une implémentation,
un jeu de tests (été, hiver, minuit, jamais-NaN, et la porte à instant figé).

### 🗓️ Test daté — 24/08 01:10 UTC

La **première ligne `origin='scheduled'` de toute l'histoire de la tâche** doit apparaître dans
`place_automation_runs` entre 01:10:00 et 01:11:00 UTC. *Réserve : un run réel (manual, pas
dry-run) lancé après le 23/08 03:10 UTC recale la garde des 22 h et reporterait le créneau au
25/08 — vérifier `lastRunAt` avant de conclure.*

---

## TRK-045

**Signature** — pas une ligne d'erreur : **un débit**. Aucune alerte, aucun `error_logs`, aucun
seuil franchi. Profil exact de [TRK-008](#trk-008).
**Statut : 🔴 NON CORRIGÉ · GRAVITÉ 1 · en cours depuis le 23/08 04:01 UTC** · 2026-08-24

### Comment on est tombé dessus

En cherchant pourquoi le compteur `trackersFailing` était passé de **0 à 24** en une nuit, alors
que le taux d'échec de commandes n'avait pas bougé d'un dixième (71,3/j, 11ᵉ jour). *Le compteur
qui a attiré l'attention n'est pas celui qui porte l'information* — voir la réserve de lecture.

### Cause — le correctif de [TRK-012](#trk-012) a réussi ce qu'il visait, et c'est le problème

Depuis le 27/04, la socket TCP recevait la forme SMS `fix005m***n123456`, que le parseur du Coban
ignore. Les boîtiers tournaient donc à leur cadence d'usine (~20 s), et les 4 120 commandes émises
en quatre mois **n'avaient aucun effet**. Le correctif du 23/08 (PR #110) fait partir la bonne
enveloppe : `**,imei:<IMEI>,C,05m;`. Les boîtiers la lisent — **et n'appliquent pas la valeur**.

### Les quatre mesures, dans l'ordre où elles ferment le raisonnement

**1. Corrélation réception → changement de cadence** (boîtiers ONLINE, 24/08 01:15 UTC) :

| A reçu une trame `,C,…;` depuis 04:01 | Boîtiers | Émettent à ≤ 10 s |
|---|---|---|
| **oui** | 32 | **23** |
| non | 6 | 1 |

**2. Mesure directe, au centième** — HD-603-XY, cible **20 s**, douze trames consécutives à
01:13–01:14 UTC : **5,00 s** d'écart. Sur les boîtiers commandés à **300 s** : 4 à 6 s.

**3. Rampe monotone à partir de l'heure exacte du déploiement**, chaque boîtier basculant après
*sa* propre première trame `,C,` :

```
23/08 03 h   6 826 trames/h   ← dernière heure avant déploiement
23/08 04 h   7 840            ← conteneur démarré à 04:01:07
23/08 12 h  10 673
23/08 18 h  15 190
24/08 00 h  19 794            ← × 2,90, et 6 boîtiers n'ont pas encore reçu leur trame
```

**4. LE MODÈLE — « deux chiffres, unité jetée »**, vérifié sur **cinq** formes.

> 🔴 **La première lecture de ce point, écrite le matin du 24/08, était FAUSSE** : elle
> concluait « la forme secondes est mitigée (9 obéissent, 15 s'effondrent) ». C'était un
> **artefact de tri** — les boîtiers étaient comptés d'après une trame quelconque de leur
> historique au lieu de la **dernière reçue**. Réparti par dernière trame, il n'y a **aucune
> exception**. *Un comptage sans ordre sur des événements datés ne mesure pas ce qu'il croit
> mesurer — et il se raconte très bien.*

| Dernière trame `,C,` reçue | Boîtiers | Cadence obtenue |
|---|---|---|
| `,C,05m;` | 28 | **4–6 s** |
| `,C,20s;` | 4 | **19–20 s** |
| `,C,30s;` | 6 | **30 s** |

**Le firmware lit DEUX chiffres, jette la lettre d'unité, et traite le nombre comme des
secondes.** Les cinq formes mesurées s'y rangent sans exception :

| Envoyé | Lu par le boîtier | Mesuré |
|---|---|---|
| `,C,20s;` | « 20 » → 20 s | 20 s ✅ |
| `,C,30s;` | « 30 » → 30 s | 30 s ✅ |
| `,C,05m;` | « 05 » → 5 s *(le `m` est jeté)* | 4–6 s ✅ |
| `,C,300s;` | « 30 » puis `0` au lieu de l'unité → échec → défaut firmware | **60 s** ✅ |
| `,C,99s;` | « 99 » → 99 s | **99 s** ✅ |

**Conséquence structurelle : le maximum exprimable est 99 s.** La cible de 300 s était
**inatteignable par construction** sur ce matériel — et le paramètre `HARD_CAP_S = 300` demandait
donc depuis toujours une valeur que le boîtier ne pouvait pas honorer.

### 🐤 Les deux canaris du 24/08 — BP-434-RD, garé, cadence de départ 5,00 s

Émis depuis `/admin/trackers/:id` → *Personnalisé* → *Commande brute*.

**Canari 1, `,C,300s;` à 04:56:41 UTC** — neuf écarts, **tous multiples de 60**, trames toutes à
`:44/:45` : `180 · 120 · 60 · 180 · 60 · 120 · 180 · 180`. Le boîtier applique **60 s**, son
défaut. *`300s` n'obtient pas 300 s.*

**Canari 2, `,C,99s;` à 05:51:26 UTC** — six écarts : `99 · 81+18 · 99 · 63+36` (le boîtier émet
par **paires**, espacées de 99 s pile). Et immédiatement en base : `currentFixIntervalS = 99`,
`desiredFixIntervalS = 99`, **`fixCommandFailing = false`** — *le boîtier a convergé et est sorti
de FAILING tout seul.* Validation complète.

### 🔴 Le défaut n'était pas que dans l'automate : il était dans le MENU de l'opérateur

Quatre des six intervalles proposés au catalogue étaient des pièges :

| Il choisissait | Trame émise | Appliqué |
|---|---|---|
| 10 secondes / 30 secondes | `,C,10s;` / `,C,30s;` | 10 s / 30 s ✅ |
| **1 minute** | `,C,01m;` | **1 s** ❌ |
| **2 minutes** | `,C,02m;` | **2 s** ❌ |
| **5 minutes** | `,C,05m;` | **5 s** ❌ |
| **10 minutes** | `,C,10m;` | **10 s** ❌ |

Le pire est « 1 minute » : `intervalLabel(60)` rendait `001m`, donc la trame demandait **une
seconde**. *Un opérateur qui cherchait à économiser la batterie multipliait le trafic par 60.*

> 🔑 **Trois tests verrouillaient ce défaut, et le plus affirmatif était le plus faux.** Le spec du
> catalogue disait : *« Traccar écrase les restes : 60 s passe en minutes (`%02dm`) — comportement
> assumé, documenté. »* Il décrivait fidèlement le code, et le code demandait 1 s. *Un test qui
> explique longuement pourquoi il attend cette valeur-là mérite d'être relu en premier.* En
> corrigeant, **8 tests ont cassé** : c'est la preuve que le correctif touche le chemin réel.

**5. Aucun accusé, jamais** — 100 % des commandes finissent en `ACK_TIMEOUT pattern=fix.*ok`. Le
motif attendu est celui de la forme **SMS** ; une réponse TCP `,C,` n'y correspondrait pas.

### Ce que ça coûte

- **Données mobiles × 2,9 sur 43 cartes SIM**, tous les jours, depuis 21 heures.
- **Écritures `wire_logs` × 2,9** sur un VPS à **2 cœurs** qui porte toute la production
  (~475 000 trames/jour contre ~172 000).
- **Et ça n'achète rien** : les positions réellement stockées ont **baissé** (25 713 → 20 225) —
  l'échantillonnage adaptatif jette les trames d'un véhicule à l'arrêt. *On paie trois fois le
  transport pour stocker moins.*

> 🔑 **La plateforme allait mieux quand ses commandes étaient ignorées.** Réparer un canal rend
> effective une consigne que le parc n'applique pas correctement. *Un correctif de transport ne se
> juge pas à ce qu'il fait partir, mais à ce que le destinataire en fait.*

### ⚠️ Deux pièges de lecture, à connaître avant de rouvrir cette fiche

1. **Ne pas juger au compteur `trackersFailing`.** Il dépend de **l'heure de la mesure** :
   `reconcile` exonère un boîtier qui émet plus vite que demandé **s'il est en mouvement** (garde
   V1.19, volontaire). À 01:11 UTC toute la flotte est à l'arrêt, donc les 23 émetteurs rapides
   comptent tous en échec ; **en journée ce nombre sera plus bas sans que rien ne s'améliore.**
   Les grandeurs **stables** sont le **débit/heure** et le **nombre de boîtiers à ≤ 10 s**.
2. **Ces boîtiers ne se réparent pas seuls.** `AUTO_ALIGN_FLOOR_S` vaut 20 s (remonté par
   [TRK-008](#trk-008)) : l'auto-alignement refuse d'accepter 5 s. Et `requestChange` cesse
   d'émettre vers un boîtier FAILING. **Le rattrapage automatique est hors circuit sur ces 23
   boîtiers** — il faudra une action explicite.

### ✅ Correctif ÉCRIT ET VÉRIFIÉ le 24/08 — NON DÉPLOYÉ

Demandé par le propriétaire dans la journée. Remplace la proposition initiale, qui visait `300s` :
le canari 1 a montré que cette valeur n'était pas atteignable.

| Fichier | Changement |
|---|---|
| `coban.utils.ts` | `formatFrequency` → **deux chiffres + `s` toujours** ; **lève** au-delà de 99 s. Constante `TCP_MAX_FREQUENCY_S = 99`. |
| `coban.catalog.ts` | les **4 options trompeuses retirées** ; ajout `020s` et `099s`. |
| `tracker-fix-mode.service.ts` | `HARD_CAP_S` **300 → 99** · `return 300` en dur → la constante · `intervalLabel` en secondes jusqu'à 99. |
| `tracker-commands.service.ts` | **repli SMS « option A »** — TCP d'abord, SMS **seulement si la socket a échoué**. |
| `commands-panel.component.ts` | **suivi d'envoi par étapes** + chronomètre. |
| `vehicle-detail.component.ts` | onglet « Commandes » **retiré** (la console reste dans l'Admin). |

⚠️ **Lever plutôt que plafonner** : un plafonnement silencieux laisserait l'interface promettre
« 10 minutes » pour une trame qui demande 99 s — un mensonge de 6× à la place d'un de 60×. Le seul
endroit qui connaisse la limite du matériel est l'encodeur.

⚠️ **Le critère du repli SMS est « l'écriture socket a échoué », JAMAIS « pas d'accusé ».** Ces
boîtiers n'acquittent pas en TCP (625 155 trames en 4 jours, zéro accusé) : un repli sur l'absence
d'accusé enverrait ~70 SMS/jour.

**Effet attendu au déploiement** : `normalizeDriftedTargets` ramène les cibles de 300 s à 99 s
**sans migration**, et l'automate émet `,C,99s;` — honoré au centième. Par boîtier garé : **873
trames/jour au lieu de 17 280**, mieux que le régime d'avant l'incident (4 320 à 20 s).

**Vérifié** : `shared` 332/332 · API 171/171 · `onglets-familles` 10/10 · `tsc` ✅ · `ng build` ✅.
**8 tests réécrits**, dont deux gardes structurelles : *aucune valeur acceptable ne produit autre
chose qu'un suffixe `s`* (sur 1→99 et sur le chemin réel d'émission), et *le catalogue ne propose
plus aucun intervalle inexprimable*.

### 🔴 DÉPLOYÉ le 24/08 à 06:37 — et la mesure dit que ça NE SUFFIT PAS

Marqueurs vérifiés **dans l'artefact servi** : `HARD_CAP_S = 99`, `formatFrequency` qui lève,
catalogue réduit à `010s · 020s · 030s · 060s · 099s`. `tracky-api` *healthy*, `restarts=0`.

**Cinquante minutes plus tard :** plus une seule trame `,C,05m;` ✅, cibles à 300 s ramenées de
16 à 3 ✅ — mais **22 boîtiers sur 38 toujours bloqués à 4–6 s**, seulement **2 commandes émises
en 50 minutes**, et un débit **inchangé** à ≈380 tr/min.

> 🔑 **Le correctif a arrêté la CAUSE sans soigner une seule VICTIME.** Leçon plus large que ce
> défaut : *un correctif qui empêche un état d'être atteint ne fait rien pour ceux qui y sont
> déjà.* La fiche disait « ces boîtiers ne se réparent pas seuls » — sans en tirer la
> conséquence. **Constater un piège ne le désamorce pas.**

**Le verrou est double, et chaque moitié est raisonnable prise seule** — `requestChange` refuse
de parler à un boîtier FAILING (ne pas marteler), `reconcile` refuse de s'aligner sous 20 s (ne
pas inscrire une cible intenable, TRK-008). Ensemble, sur un boîtier que **notre propre défaut**
a mis à 5 s : ni convergence, ni alignement, ni commande. **Il reste à 5 s à vie.**

⚠️ **Un déblocage manuel ne suffirait pas** — vérifié avant d'écrire le correctif :
`clear-failing` rouvre la porte, mais `reconcile` remonte le compteur à FAILING en **trois
trames (15 s)** contre **cinq minutes** de cooldown. *Un geste qui a l'air de marcher et qui ne
marche pas.*

**Second correctif — PR #120** : `recupererBoitiersEmpoisonnes()`, même cron que la
normalisation. Pour tout boîtier FAILING dont la cadence observée est **sous le plancher
d'auto-alignement** (signature exacte d'une victime), forcer **une** commande vers la cible
courante. Le boîtier converge et sort de FAILING seul — la séquence du canari 2.

⚠️ **La borne `lastSeenAt` de ce balayage empêche une facture SMS** : `tryFallbackSms` refuse
d'émettre vers un boîtier vu il y a moins de 5 min, donc en ne sélectionnant que ceux-là le
repli devient structurellement impossible. Sans elle, un boîtier hors ligne coûterait un SMS
toutes les 10 minutes — *réparer une facture en en ouvrant une autre.* Un test la verrouille.

🗓️ **Test daté — prochain audit** : débit retombé de ≈380 tr/min vers ≈**60 tr/min**.
⚠️ **Le compteur FAILING seul ne prouvera rien** — il retombe aussi quand la flotte roule.

### Correctif proposé initialement — conservé pour mémoire

Par ordre de sûreté :

1. 🔴 **Arrêter l'hémorragie d'abord, comprendre ensuite.** Un interrupteur d'environnement qui
   suspend l'émission des `fix_continuous` sur le canal TCP (repli sur l'ancien comportement =
   ne rien appliquer) rend la flotte à son régime d'avant-hier en un redémarrage. **Seule action
   urgente** ; les suivantes peuvent attendre une revue.
2. **N'émettre que la forme secondes** — `,C,300s;` au lieu de `,C,05m;`, puisque la forme minutes
   échoue 8 fois sur 8. `formatFrequency` bascule en minutes au-delà de 60 s ; le Coban accepte
   `NNNs` jusqu'à 999. **À vérifier sur UN boîtier avant toute généralisation.**
3. **Test canari obligatoire avant tout déploiement qui change une trame sortante** : un boîtier,
   dix minutes, l'intervalle mesuré, et l'extension au parc seulement au vu du résultat. *La fiche
   TRK-012 prescrivait exactement ce test ; rien ne l'a rendu bloquant, et 21 heures ont passé.*
4. **Sonde de débit.** Un facteur 2,9 sur le trafic de la flotte doit alerter **par lui-même** ;
   aucun instrument existant ne regarde cette grandeur.
5. **Corriger `expectedAckPattern`** pour le canal TCP, afin qu'un succès puisse être constaté
   autrement que par déduction.

### 🗓️ Vérification — porte sur la CAUSE, pas sur l'affichage

Après toute action : **l'intervalle entre deux trames d'un boîtier donné**, mesuré en base, doit
revenir à la valeur demandée (± 20 %), **et** le débit horaire de la flotte doit retomber vers
~7 000 trames/h. ⚠️ **Un `trackersFailing` revenu à 0 ne prouve rien** — il retombe aussi quand la
flotte roule, et il retomberait encore si l'on baissait simplement la cible.

---

## Journal des passages

| Date | Lignes `error_logs` | Signatures connues | Nouvelles | Ajoutées par |
|---|---|---|---|---|
| 2026-08-24 | **17 dont 8 actives et 9 archivees** (3 sur 24 h, **0 CRITICAL active**) | 25 revues ; 🆕 **TRK-045 — LA COMMANDE ARRIVE ENFIN, ET LE BOITIER FAIT L INVERSE.** Premier audit apres la mise en ligne de la campagne des onze lots (image du 23/08 03:59, conteneur demarre a **04:01:07**, `restarts=0`). Le correctif TRK-012 a REUSSI ce qu il visait — la socket recoit `**,imei:...,C,05m;` au lieu de la forme SMS, et pour la premiere fois en quatre mois **le comportement des boitiers change apres reception** : **23 des 32** boitiers ayant recu une trame emettent desormais a <= 10 s, contre **1 sur 6** parmi ceux qui n en ont pas recu. Mais la consigne n est pas honoree et l ecart va dans le mauvais sens : **5,00 s mesures au centieme sur HD-603-XY pour une cible de 20 s**, 4 a 6 s la ou 300 s sont demandes. **Debit de la flotte 6 826 vers 19 794 trames/h (x 2,90)**, rampe MONOTONE commencant a l heure exacte du deploiement, chaque boitier basculant apres SA premiere trame `,C,`. Cout : x 2,9 de donnees SIM sur 43 cartes et d ecritures `wire_logs` sur un VPS a 2 coeurs — **pour des positions stockees EN BAISSE** (25 713 vers 20 225), l echantillonnage adaptatif jetant les trames d un vehicule a l arret. 🔑 **La plateforme allait mieux quand ses commandes etaient ignorees** — *un correctif de transport ne se juge pas a ce qu il fait partir, mais a ce que le destinataire en fait*. La forme MINUTES echoue **8 fois sur 8**, la forme secondes est mitigee (9 honorent, 15 s effondrent) : piste serieuse, **pas** une explication complete — le rapport ecrit le fait mesure, pas une theorie du firmware. ⚠️ **le critere de succes ecrit dans TRK-012 (« le ratio commandes/boitier doit decrocher de 2,00 ») est INUTILISABLE** : il est egalement satisfait par le pire echec, les boitiers baillonnes en FAILING ; ⚠️ **ne pas juger au compteur `trackersFailing` (0 vers 24)** — il depend de l HEURE de la mesure, la garde V1.19 exonerant un boitier rapide EN MOUVEMENT : a 01:11 toute la flotte est a l arret. Les grandeurs stables sont le debit/heure et le nombre de boitiers a <= 10 s ; ⚠️ **ces 23 boitiers ne se reparent pas seuls** — `AUTO_ALIGN_FLOOR_S` = 20 s refuse d accepter 5 s et `requestChange` cesse d emettre vers un boitier FAILING ; ✅ **TRK-044 : TEST DATE REPONDU « OUI »** — `place_automation_runs` porte enfin `2026-08-24 01:10:00.156 | scheduled`, **la premiere ligne planifiee de toute l histoire de la tache**, et la reserve ne s applique pas (seul run manuel le 23/08 a 02:01, avant 03:10) ; ✅ **TRK-029 verifie PAR LE COMPORTEMENT** — la ligne `schedule-cron` de 20:31 porte `resolvedAt = 20:41` et « Cloture automatique : coupe aboutie » : reessai programme ET cloture d alerte, exerces en production le jour du deploiement ; ✅ **TRK-013 exerce** — **5 clotures ACKNOWLEDGED « Cible atteinte »**, dont **17 s pour 20 s demandes**, exactement le cas que la bande ±20 % devait sauver ; `acquittees = 0` sur ces lignes est VOULU (l accuse reste reserve a une vraie reponse du boitier, pour ne pas truquer TRK-014) — ne pas rouvrir d enquete ; ✅ **TRK-038 : 6 h 00 min 13 s** entre les deux lignes `speed-limit-osm`, et l intervalle qui ENJAMBE le redemarrage de 04:01 fait 7 h 00 — la table `refroidissements_alerte` est bien en production ; ✅ **TRK-042 tient** — 0 ligne en ~37 passages, et le silence est desormais INFORMATIF puisque la tache a reellement tourne ; ⚠️ **TRK-043 : 24 passages sur 24 le 23/08 mais LE TEST N EST PAS DISCRIMINANT** — duree moyenne **6,3 min**, SOUS le seuil de 10 min qui declenchait l ancien defaut : l ancien code aurait probablement rendu 24/24 lui aussi. Nouveau test date pose : au prochain jour a passages > 10 min de moyenne, le compte doit rester a 24/24 ; 🟢 **2e journee pleine PROUVEE sans effacement** — `temoin_arme` rend ses 4 declencheurs actifs, **0 constat**, `n_tup_del` inchange a **3 785**, ecart `ins-del-live` fige a **13 250** (**4e point**), `errorDeleted = 0` pour le **7e jour** ; TRK-008 **71,3/j, 11e jour**, metronome inchange ; 5 boitiers hors ligne, tous rattaches (KSR370 muet depuis **10,0 j**) ; `cadence_resume` **0 sous 20 s** sur 43 — la garde V1.19 tient ; 🔴 **`cadence_derive` a son PROPRE angle mort** : elle ne regarde que la CIBLE, qui est saine — le defaut du jour est dans la cadence REELLE, et **aucune section du SQL de collecte ne regardait le debit** | **1** (TRK-045) | agent d'audit |
| 2026-08-23 *(journee, CAMPAGNE DE CORRECTIFS)* | — *(passe de correction, pas d audit)* | **ONZE lots fermes en une journee, UN deploiement** : TRK-044 (nouveau — parisHour rendait NaN, la tache des lieux ne pouvait JAMAIS se declencher), TRK-043 (garde depuis le DEPART, ticks annules visibles), TRK-012+021 (l ENVELOPPE SUIT LE CANAL — trame TCP sur la socket apres 4 mois de format SMS, 72 echecs/jour ; porte SMS-only), TRK-013 (le verdict COMPARE, bande ±20 %), TRK-040 (le CONTACT departage, le classement benin devient un SURSIS, un cron relit la PENTE — migration 4 colonnes), TRK-024 (ecriture OFFLINE conditionnelle), TRK-030 (borne du jamais-localise), TRK-029 (reessai a l echeance connue + redaction honnete + CLOTURE des alertes), TRK-039 (les 5 correctifs, la contre-preuve devient TESTABLE), outillage (garde anti-doublon multi-branches, raccourcis alignes sur le §11.b), TRK-041 (vizyo-texto : chaque refus d auth laisse une ligne). Verifie sur le CUMUL : API 178 suites / 2 634 tests, shared 325, ng build, texto 19/19, smoke-boot 5/5. Trois lots ont suivi la methode « test d abord, verifie EN ECHEC sur l ancien code ». 🔑 Lecons : *une tache qui rend NaN ne rate pas son heure, elle n a pas d heure* ; *le run manuel de verification REARMAIT la grace de la sonde — l observation masquait le defaut* ; *deux copies privees d un meme calcul divergent toujours par la pire* | **1** (TRK-044) | campagne de correctifs |
| 2026-08-23 | **13 dont 5 actives et 8 archivees** (5 sur 24 h, **0 CRITICAL active**) | 24 revues ; 🟢 **PREMIERE JOURNEE ENTIERE PROUVEE SANS EFFACEMENT** — `temoin_arme` rend ses **4 lignes** toutes actives, **0 constat de disparition**, `n_tup_del` **inchange a 3 785** sur 24 h, ecart `ins-del-live` **inchange a 13 250** (3e point), et l arithmetique se referme exactement : **1 + 12 - 0 = 13**. `errorDeleted = 0` pour le **6e jour**. ⚠️ **un instrument neuf qui ne voit rien le premier jour n a pas encore ete exerce** — l effaceur a frappe les 19, 20 et 21/08 puis rien les 22 et 23 ; le temoin CONSTATE, il n empeche pas, et la separation des roles reste entiere. **Consequence immediate et bonne** : pour la premiere fois depuis le 19/08, les comptes de ce rapport sont des MESURES et non des planchers ; 🆕 **TRK-043 : la cadence declaree n est pas la cadence executee** — `frequency = hourly`, cron `0 45 * * * *`, **14 passages en 24 h au lieu de 24**, sans une seule ligne nulle part. La garde anti-double-run compare le tick a la **FIN** du passage precedent et non a son depart, donc **tout passage de plus de 10 min emporte le tick suivant** ; **23 des 24 ticks du 22/08 expliques exactement**, le 24e tombant 3 min avant une recreation de conteneur. 🔑 **`RUN_BUDGET_MS` vaut 50 min, le seuil de la garde aussi** : un passage qui consomme tout son budget GARANTIT l annulation du suivant — *le frein serre le plus fort exactement quand la charge est la plus forte*. Serie 7 j : le seul jour a 24/24 est celui a **1,2 min** de moyenne. ⚠️ **pas une perte de donnee** (fenetre de 26 h) mais une latence x2 et surtout un **silence total** — le `return` est muet, profil exact de TRK-008 ; 🔴 **« Automatisation des lieux » n a JAMAIS tourne pour de vrai** — `place_automation_runs` ne contient qu une ligne, `origin = dry-run`, lancee une minute AVANT l activation de la tache ; *un correctif qui remplace une fausse alarme par un silence doit etre accompagne du test date qui distingue les deux* ; ✅ **TRK-038 : test date REPONDU, « non »** — aucun redemarrage depuis 13:31, les deux lignes `speed-limit-osm` espacees de **6 h 00 min 57 s**, seul intervalle court encadrant un redeploiement, **2 cas sur 2 expliques** — mais table `refroidissements_alerte` **ABSENTE de la production**, PR #106 non fusionnee ; 🧹 **CINQ STATUTS PERIMES RECTIFIES** — TRK-031, TRK-032, TRK-034, TRK-035 et TRK-036 portaient encore « CORRIGE, NON DEPLOYE » alors qu ils sont en ligne depuis le 22/08 04:54 : *un statut perime coute plus cher qu un statut absent, il fait rouvrir une enquete close* ; 🆕 **TRK-034 n est PLUS REALISE** — `lookbackHours` **1 500 vers 26**, recalculs par passage **848 vers 4-45** ; TRK-018 **passe 12e fois** (296 vers 302) ; TRK-013 101 vers **106**, strictement fausses **22** inchangees ; TRK-016 **87,8 %** ; TRK-024 **8e point** identique ; TRK-023 **tient 4e jour** (79,3 h sans alerte muette) ; TRK-017/025/041 blocages **49 (+0)**, **125,9 h** de silence, 10e ; TRK-021 fenetre de 7 j **VIDE** — *ce n est pas une amelioration, c est un oubli d essayer* ; TRK-039 la ligne temoin a **survecu a la nuit**, mais **KSR370 est muet depuis 9,0 j** ; TRK-022 et TRK-032 **non exerces** — 0 trame `ac alarm` depuis le 21/08 ; 🟢 **une zone de plus qualifiee benigne** sans revue humaine (5 vers 6) ; ⚠️ **production 11 commits derriere `origin/main`**, dont 2 de code (affichage `/admin/background-tasks`) | **1** (TRK-043) | agent d'audit |
| 2026-08-22 *(soir, enquete TRK-039)* | 12 dont **4 actives** et **8 archivees** (les 7 fausses CRITICAL de TRK-042 classees, pas supprimees) | 🎯 **CAUSE TROUVEE, et elle refute l hypothese ecrite quelques heures plus tot** : la recidive de TRK-039 ne vient PAS d une cle d anti-repetition mal composee, elle vient de ce que **la memoire de cette anti-repetition a ete EFFACEE**. `dejaSignalees()` interroge `error_logs` LUI-MEME pour savoir qui a deja ete signale ; la ligne du 20/08 a disparu dans la fenetre des 73 effacements, donc la requete a rendu une liste VIDE et l agent a reemis. Verifie des deux cotes : elle rend KSR370 maintenant, et l agent avait signale ZERO boitier le 21/08 quand la ligne existait encore. 🔑 **La seule variable qui bouge n est pas forcement la cause — surtout quand on n a pas cherche celles qui ont DISPARU** : le raisonnement portait sur ce que la table contenait, l explication etait dans ce qu elle ne contenait plus. ⚠️ **CONSEQUENCE DE SECOND ORDRE DE TRK-035, que rien n avait identifiee** : effacer `error_logs` ne detruit pas seulement de la connaissance, ca REARME des boucles d alerte — et ca se paie en fausses alertes, pas seulement en oubli. 🔴 **TRK-038 AMENDE dans la foulee** : son correctif proposait de ranger la memoire des quatre gardes dans `error_logs`, ce qui echangerait un defaut connu contre celui-ci sur QUATRE gardes au lieu d une. Le principe reste juste — l etat doit vivre dans la donnee — mais pas dans la table que quelqu un vide. *Un garde-fou ne doit pas ranger sa memoire dans la piece qu il surveille.* ✅ **Archivage exerce en production** : 7 lignes classees, ZERO constat de disparition, `n_tup_del` inchange — *archiver n est pas supprimer* n est plus une affirmation de conception, c est une mesure | 0 *(TRK-039 et TRK-038 amendees)* | enquete |
| 2026-08-22 *(après-midi, passe de LIVRAISON)* | 11 (10 actives, **1 archivee** — premier usage de l'archivage) | **9 PR fusionnees et DEPLOYEES en 4 vagues**, toutes verifiees sur l'artefact SERVI : les 6 correctifs qui dormaient sur `origin` depuis le 20/08 (#93→#98), la doc du 18 au 22/08 (#99), l'**archivage REVERSIBLE** (#100), le **temoin des disparitions** (#101), et TRK-042 (#102) ; 🔑 **« clear » ne veut pas dire supprimer** — decision du proprietaire, meilleure que la proposition initiale : une ligne archivee RESTE en base, sort de la vue par defaut, se rouvre, *et un archivage qui supprimerait rendrait le temoin incapable de distinguer nos archivages des suppressions de l'intrus* ; ⚠️ **le TRUNCATE est intercepte en BEFORE** — un AFTER compterait une table deja vidée et rendrait « 0 ligne », soit TRK-026 rejoue DANS l'instrument cense le reparer ; 🆕 **TRK-042 : le tableau propre paie des la premiere matinee** — 7 CRITICAL fausses, une tache activee a 06:02 et quotidienne a 03:00 declaree a l'arret 33 min plus tard puis toutes les heures, *une naissance lue comme une panne*, **meme defaut que TRK-030 sur un autre module** ; ✅ **verifie PAR LE COMPORTEMENT** : le passage de 13:35, premier apres deploiement, n'a RIEN ecrit ; 🔴 **TRK-039 : le test date repond CINQ JOURS EN AVANCE et refute son enonce** — zones et etalement identiques, seul le compte d'episodes bouge (2 → 9), *une cle d'anti-repetition qui inclut une grandeur qui monte toute seule ne supprime rien* ; ⚠️ **un piege de test corrige au passage** : le mock omettait `updatedAt` la ou Prisma en rend toujours un — vert en decrivant un comportement inexistant, exactement le piege du 17/08 ; **aucune disparition de la journee** (`n_tup_del` inchange a 3 785 sur 12 h) | **1** (TRK-042) | passe de livraison |
| 2026-08-22 | **1** (1 sur 24 h, **0 CRITICAL**) — mais **66 ecrites et 73 supprimees en 20,7 h** | 23 revues ; 🎯 **TRK-035 : l'attribution cesse d'etre une hypothese** — le cron de retention consigne lui-meme `errorDeleted: 0` **cinq jours de suite** (17 au 21/08) alors qu'il supprime 170 000 `wire_logs` par nuit, et il n'existe **qu'un seul** `errorLog.deleteMany` dans la base servie : *il suffisait de demander a l'application ce qu'elle avait supprime, elle tenait deja le compte* ; l'ecart `ins-del-live` reste fige a **13 250** (prescription satisfaite, **pas de nouveau TRUNCATE**) pendant qu'un `DELETE` ordinaire emportait 73 lignes — **les deux natures d'effacement ont chacune leur instrument, et chacun est aveugle a l'autre** ; 🔴 **et personne ne pourra nommer l'auteur** : `log_statement=none`, `log_connections=off`, `logging_collector=off`, et **un seul role** porteur de `DELETE` ET `TRUNCATE` — *la commande qui a immobilise la moitie du VPS pendant 3 h 54 le 20/08 visait un journal vide par configuration* ; retention reelle mesuree a **90 j**, pas 30 : l'en-tete de ce fichier est corrige ; 🆕 **TRK-040 : DZ-034-CA meurt en 6 h 12 pendant que la fiche vehicule le dit « pas en peril »** — `kt` **contact REMIS** a 06:00:07 puis `ac alarm` a 06:23:46 avec **100 %** de batterie, verdict `contact_coupe`, 0 alerte ; batterie 100 vers 0 %, `POWER_CUT` a 12:36, **boitier mort a 12:43:53**. *Les deux cas que ce test doit separer sont identiques au moment ou il les separe : l'information est dans la PENTE, pas dans le niveau* — et le bon discriminant etait dans la trame precedente, un montage commute ne perd pas son alimentation 23 min apres que le contact a ete remis ; 🆕 **TRK-041 : on a repare la serrure et jete le judas** — rotation **confirmee** par les prefixes de cle (`vtx_48fe` jusqu'au 20/08 13:25, `vtx_d4f3` des 14:25), mais `allowlist_audit_logs.tenantId` est `NOT NULL` donc **une cle revoquee n'ecrit rien** : blocages figes a 49, **102,0 h** de silence, le premier qui ne prouve meme pas une absence ; 🟢 **TRK-023 EXERCE et il tient** — **0 alerte sans message depuis le 19/08 01:56**, 3 jours et 4 types ; 🟢 **TRK-019 verifie par l'EGALITE** — `git rev-list --count c9dc774..origin/main` rend **0** ; 🟢 **regle du parking exercee en production** (zone FL-787-KV auto-qualifiee, 6 occurrences, jamais revue) ; 🟢 **« 0 recit IA » est un REGLAGE** (`narrateEnabled=false`), verifie avant d'ouvrir une fiche ; TRK-034 **mesure dans les reglages** : `lookbackHours=1500` (62,5 j) contre 60 j de retention, **848 trajets recalcules en une heure**, un passage horaire de **14 min 56 s** ; TRK-018 **passe 11e fois** (289 vers 296) ; TRK-013 91 vers **101** / 19 vers **22** ; TRK-016 **91,9 %**, definition controlee a 92,4 % sur les trajets demarres ; TRK-024 **7e point** identique ; TRK-038 **test date NUL** (2 deploiements, clause de nullite), rearme ; 🔴 **les SIX correctifs restent absents de la PRODUCTION** malgre 2 deploiements — ⚠️ **RECTIFIE le meme jour** : ils sont POUSSES sur origin depuis le 20/08 (`git rev-list --count origin/<b>..<b>` rend 0 pour les six), le clone du serveur ne connaissait que `origin/main`. *On a change d instrument sans changer l erreur : `cat-file -e` confond jamais pousse et jamais rapatrie ici, exactement comme `merge-base` confondait absent et non fusionne la veille.* Ce qui manque, ce sont les REVUES : aucune des six branches n a de pull request, aucune n est dans `main` | **2** (TRK-040, TRK-041) | agent d'audit |
| 2026-08-21 | **8** (8 sur 24 h, **0 CRITICAL**, **aucune connue**) — la plus ancienne du 20/08 05:47:16 | 21 revues ; 🔴 **TRK-035 : le temoin qui avait detecte l'effacement du 19/08 est AVEUGLE a celui de `error_logs`** — la verification prescrite est rendue et NEGATIVE dans le bon sens (`alerts.n_tup_del` inchange a **41 824**, borne basse immobile, **pas de recidive en 14 h**), mais **13 250 lignes manquent qu'aucun `DELETE` n'a comptees** (ins 16 970 moins del 3 712, pour 8 vivantes), soit un `TRUNCATE` ; **deux controles rendent le chiffre exploitable** : `stats_reset` NULL, et la meme arithmetique se referme EXACTEMENT sur `alerts` — *ce que `n_tup_del` mesure, ce ne sont pas les disparitions, ce sont les `DELETE`* ; 🆕 **TRK-039 : l'agent qualite GPS deploye la veille accuse l'antenne de KSR370**, boitier hors ligne depuis 7 j et mort d'une coupure d'alimentation deja documentee, sur des zones vieilles de 19 j — et son discriminant est **infranchissable** pour un vehicule qui roule seul et loin (Toulouse-Benidorm, **580 928 m** = 193x le seuil) ; 🆕 **TRK-038 : quatre gardes anti-repetition d'alerte vivent en memoire de processus**, dont celle de l'alarme de flambee d'erreurs — la garde n'est pas cassee, elle est **volatile** (6 h 02 prouve qu'elle tient ; 3 des 4 intervalles trop courts suivent une remise en service, **1 reste inexplique**) ; 🆕 **TRK-037 : Overpass injoignable**, et **sa date de premiere apparition est INCONNAISSABLE** — la plus ancienne ligne survivante EST l'une d'elles ; 🟢 **l'alarme d'alimentation est EXERCEE et JUSTE pour la 1re fois** (4 trames `ac alarm`, toutes a 100 % de batterie, 0 alerte — et **ce n'est PAS le chemin de TRK-032 qui les a tues**) ; 🟢 **TRK-031 : verification prescrite RENDUE et POSITIVE** — **0 duree fabriquee sur 35** (contre 13 sur 20), medianes 16,03 j vers **0,78 j** ; 🟢 **TRK-017 : chaine applicative PROUVEE avec la cle rotationnee** (reconciliation `ok` a 04:25) — mais **la rotation ne peut PAS etre creditee du silence de l'appelant**, tu depuis le 17/08, **3 jours AVANT** elle ; TRK-018 **passe 10e fois** (274 vers 289) ; TRK-036 **elargie a 2 accuses moteur jetes** (85 SMS entrants sur 87 sans `imei`) ; TRK-016 **91,1 %** — le creux a 87,0 ne s'est pas confirme ; TRK-032 **29 boitiers sur 42 silencies, par un CUT vieux de 8,7 h** (mesure a 04:33, contre 33 a 01:1x la veille : **heures differentes, aucune tendance**) ; ✅ **les 5 correctifs de cet audit sont INCONNUS du clone du serveur** (`git cat-file -e`), donc jamais pousses — la ou `merge-base` seul rendait le meme non pour deux situations opposees | **3** (TRK-037, TRK-038, TRK-039) | agent d'audit |
| 2026-08-20 | **14** (14 sur 24 h, **4 CRITICAL**) — ⚠️ **la table a perdu son histoire** : plus rien avant le 19/08 09:35 | 30 revues ; 🔴 **41 709 alertes et >= 89 lignes d'erreur EFFACEES hors application, sans aucune trace** — ni la retention (`errorDeleted: 0`), ni un chemin applicatif, ni la migration ; seul `pg_stat_user_tables` en temoigne (TRK-035), et **le taux de TRK-023 tombe de 81,6 % a 5,5 % par effacement du DENOMINATEUR, pas par correction** ; 🔴 **TRK-032 : 33 boitiers sur 42 ont leur alarme d'alimentation eteinte chaque nuit** — « coupure commandee par nous » deduit de la derniere commande moteur SANS BORNE DE TEMPS, et l'automatisation horaire coupe la flotte de 18:00-20:00 a 06:00 ; 🔴 **TRK-031 CONFIRMEE A L'ECHELLE PREDITE** — FS-253-HR revient le 19/08 13:48:56 et **referme 9 episodes a la meme seconde** (6,94 a **35,18 j**, dont **8 fabriquees**, refutees par **5 027 positions**), et **la mediane de la zone affiche 16,03 j pour une absence reelle de 6,94 j** sur l'ecran meme cree par TRK-028 ; 🆕 **TRK-036 : l'accuse de reception du boitier ARRIVE et est JETE** — « Resume engine Succeed » recu le 19/08 08:28:58 depuis la SIM de GS-014-NY, ecrit dans `sms_logs` avec `imei` NULL, commande toujours `SENT` 21 h apres (TRK-018 change de nature) ; **le deluge POWER_CUT a cesse parce que les TRAMES ont cesse** — derniere `ac alarm` le 19/08 02:26:23, aucune depuis 23 h sur une fenetre `wire_logs` de 4 jours : les correctifs de TRK-022 (dedup 6 h) et TRK-023 (message) sont **deployes et NON EXERCES** ; 🟢 **la qualification automatique d'un parking est EXERCEE pour la 1re fois** (zone `55615ba3`, `reviewedAt` NULL, 19/08 21:55) ; 🟢 **une sonde neuve a detecte un vrai arret de 9 h** de l'automatisation des trajets et s'est tue au premier passage reussi ; 🟢 **FS-253-HR est revenu a 6,94 j**, sous le seuil de TRK-027 ; TRK-017 **10e jour**, cle `vtx_48fe` inchangee, 54 h de silence lues comme un silence (7e fois) ; TRK-018 **passe 9e fois** ; **>= 3 deploiements le 19/08** (3 vagues de migrations) — le tag `latest` empeche de les compter | **5** (TRK-032, TRK-033, TRK-034, TRK-035, TRK-036) | agent d'audit |
| 2026-08-19 | 50 (2 sur 24 h, **aucune n'est un rappel** : 1 perte neuve + 1 faux positif de mise en service ; 0 CRITICAL) | 27 revues ; **7e image le 18/08 22:02, toujours `main` @ `2416331`** — 3e image consecutive conforme, marqueurs presents ; **la mise en service d'un boitier chez un client neuf repond a trois tests dates** : le boitier est accuse de panne d'antenne **51 s avant son premier fix** (TRK-030), le premier retour de fix **referme 2 episodes dont un du 01/08 declare long de 16,9 j** alors que 27 733 positions ont ete emises pendant l'intervalle (TRK-031 — et **TRK-028 est donc EXERCE**), et TRK-012 se rejoue en direct (`fix030s***n123456` sur socket TCP, **2 ACK timeout en 6 min** sur un boitier de 2 minutes) ; **la table `alerts` n'etait PAS un capteur eteint** — 202 `POWER_CUT` en 24 h, **toutes CRITICAL, toutes sans message** (TRK-023 +202, TRK-022 rejoue : 49 alertes en 17 min), et la question POWER_CUT est **tranchee dans l'autre sens** (les 2 vehicules qui ont crie sont VIVANTS, KSR370 est mort et ne pouvait pas crier) ; **1 020 notifications, 10 reellement envoyees** — le dernier etage a tenu ; TRK-029 **test date nº 5 : aucun second cas** (21 coupes normales) ; TRK-017 **9e jour**, cle `vtx_48fe` inchangee ; TRK-018 **passe 8e fois** ; TRK-025 **non exerce** ; parc 43 → 42, **explique et trace** (3 `DELETE /api/trackers/:id` dans `system_activity_logs`) ; **TRK-026 et TRK-027 ajoutees a l'index, ou elles manquaient depuis leur creation** | 2 (TRK-030, TRK-031) | agent d'audit |
| 2026-08-18 | 48 (2 sur 24 h, **toutes deux POSTERIEURES au deploiement de 15:54**, 0 CRITICAL) | 25 revues ; **le deploiement du 17/08 15:54 met en ligne les 3 correctifs de la veille** (6e image, `main` @ `5d10796`, migration appliquee) — et un seul est EXERCE : la regle du parking, **prouvee par le journal du cron** qui nomme les 2 vehicules silencies toutes les 5 min ; TRK-026 et TRK-028 sont deployes mais **sans occasion de s'executer** ; **TRK-001 : test date PASSE** sur FS-253-HR (aucune ligne le 17/08 vers 15:45, sous l'ancien code) ; **TRK-003 verifie en production** (1re occurrence depuis le 31/07, ecrite en `ERROR` et non `CRITICAL` — le calibrage tient) ; **TRK-025 : test date CONFIRME** (blocages 42 → **49**, toujours **0** ligne) ; TRK-017 **8e jour**, cle `vtx_48fe` inchangee ; TRK-018 **passe 7e fois** ; TRK-016 revient a **91,3 %** sur un lundi ouvre — la mise en garde d'hier sur l'echantillon du dimanche est validee ; TRK-014 **4e point** a 83/83 ; **la table `alerts` est muette depuis 60 h sur ses 9 types** — fait mesure, mesure discriminante datee, aucune conclusion | 2 (TRK-029, TRK-028) | agent d'audit |
| 2026-08-17 | 46 (2 sur 24 h — **2 rappels `gps-integrity` attendus**, tous deux ANTÉRIEURS à la reconstruction de 16:03, 0 CRITICAL) | 23 revues ; **TRK-019 REFERMÉ** — production servie depuis `main` (5ᵉ image, 16/08 16:03), 3 marqueurs sur 3 mesurables présents + 2 preuves comportementales (silences 81 → **100**, trace allowlist horaire à nouveau) ; **TRK-002 rectifié : l'instrument était invalide** (variable de portée module cherchée dans un bundle minifié — le contrôle `shouldReportNetworkFailure`, en prod depuis des semaines, rend 0), 5 verdicts « régression » annulés ; **TRK-015 : test daté RÉPONDU** — le pic du 15/08 était une journée, et la baisse d'insertions est un **week-end** (73 trajets dimanche vs 195 vendredi) ; TRK-021 test daté **non déclenché** ; TRK-018 **passé 6ᵉ fois** ; TRK-017 **7ᵉ jour**, appelant revenu (3ᵉ fois après un silence) ; HD-779-MA a repris après 31 h **en rejouant un tampon** (317 rejets) | 1 (TRK-025) | agent d'audit |
| 2026-08-16 | 44 (3 sur 24 h — **3 rappels `gps-integrity` attendus**, 0 CRITICAL) | 24 revues ; **TRK-019 : 4ᵉ reconstruction** (témoin web migré vers `chunk-XXNB5VTF.js` — l'artefact est neuf et le trou identique) ; **2 tests datés DÉCLENCHÉS** — TRK-021 passe en **gravité 1** (12 échecs, 3 jours sur 4) et TRK-013 franchit son seuil (8 → **11**, l'argument « numérateur figé » est mort) ; **TRK-015 : rejets ×3,5 ET insertions −18 %** le même jour, 3ᵉ point demandé ; tests datés TRK-001 (3ᵉ rappel) et TRK-018 **passés** ; TRK-017 **6ᵉ jour**, clé toujours vivante malgré 32 h de silence | 0 | agent d'audit |
| 2026-08-15 | 41 (2 sur 24 h — 2 rappels GPS **attendus**) | 22 revues ; **le volet décisif de TRK-001 tranche par le COMPORTEMENT** sur 2 véhicules (le rappel de 48 h, et non celui de 72 h, était le discriminant) ; TRK-017 **35 blocages dont 11 le 14/08**, sa journée record ; TRK-021 6 → **10** ; **TRK-013 : le numérateur n'est plus figé** (7 → 8) ; TRK-024 voit son asymétrie « à sens unique » **tomber** (0 / 1, inversé) ; test daté TRK-018 **passé** | 0 | agent d'audit *(ligne ajoutée rétroactivement le 16/08 — elle manquait)* |
| 2026-08-14 | 39 (3 sur 24 h — 2 rappels GPS **attendus**, 1 ligne TRK-002) | 21 revues ; **TRK-023 élargi de 1 à 42 038 alertes** (dont 41 507 CRITICAL et 3 SOS) ; **TRK-022 renforcé** sur `POWER_CUT` (41 479 en 15 jours de juin) ; TRK-019 **3ᵉ reconstruction**, point de fork inchangé ; **TRK-017 : l'appelant est REVENU**, clé toujours valide ; tests datés TRK-018 **passé**, TRK-001 volets 1-2 **passés** et volet 3 **non échu** | 1 (TRK-024) | agent d'audit |
| 2026-08-13 | 36 (2 sur 24 h — **les deux de la signature TRK-002**, régression désormais confirmée par la donnée) | 20 revues ; TRK-019 **réimposé** par 2 reconstructions et mesuré dans la donnée (0 silence tracé sur 77 commandes) ; test daté TRK-018 **passé** ; test daté TRK-001 **sans objet** (son épisode s'est refermé) et réarmé ; clé de TRK-017 **non rotationnée** | 3 (TRK-021, TRK-022, TRK-023) | agent d'audit |
| 2026-08-12 | 34 (3 sur 24 h, **0 depuis le redéploiement de 22:37**) | 18 revues ; **TRK-002 repasse en 🔴 RÉGRESSION** (correctif retiré de la prod) ; test daté de TRK-001 **passé** sur 2 canaux avant retrait ; TRK-013 voit son numérateur bouger (7 fausses / 38) | 2 (TRK-019, TRK-020) | agent d'audit |
| 2026-08-11 *(2ᵉ passage, 09:22 UTC)* | — *(passage ciblé : vérification d'ACK, pas d'audit complet)* | **Cause racine de TRK-012 trouvée** (format SMS émis sur socket TCP) ; test daté de TRK-014 reconfirmé sur 13 h (47/0/47) ; **Constat 2 de TRK-014 rectifié** (les `jt`/`kt` sont de vrais ACK) | 0 | tâche `trk012-ack-et-correctif` |
| 2026-08-11 | 31 (8 sur 24 h — **toutes antérieures aux correctifs du soir** ; **0 ligne** sur les 6 h qui les suivent) | 17 revues ; **TRK-014 tranché** (silence PROUVÉ, garde ACK vérifiée), 3 correctifs confirmés en prod, 2 en-têtes recalés sur `main` | 1 (TRK-018) | agent d'audit |
| 2026-08-10 *(2ᵉ passage, 17:12 UTC)* | 31 (10 sur 24 h — dont **6 fois la même** ligne `sms-allowlist`) | 17 revues ; **TRK-017 requalifié** (test daté tranché : lecture B), TRK-012 revoit un boîtier FAILING | 0 | agent d'audit *(passage supplémentaire demandé)* |
| 2026-08-10 | 23 (3 sur 24 h — 2 d'une signature inédite, 1 rappel GPS attendu) | 16 revues ; TRK-015 confirmé en rafale sur un 2ᵉ véhicule | 1 (TRK-017) | agent d'audit |
| 2026-08-09 | 20 (1 sur 24 h — l'alerte de plafond **attendue**, TRK-011 non régressé) | 15 revues ; TRK-015 étendu à la perte en rafale | 1 (TRK-016) | agent d'audit |
| 2026-08-08 | 19 (**0 sur 24 h** — les 2 épisodes GPS longs se sont refermés) | 14 revues ; TRK-001 clos sur ses deux épisodes | 1 (TRK-015) | agent d'audit |
| 2026-08-07 | 19 (2 sur 24 h, toutes deux des rappels à 24 h) | 13 revues, 2 fiches rectifiées sur le code (TRK-007, TRK-008) | 1 (TRK-014) | agent d'audit |
| 2026-08-06 | 17 (2 sur 24 h, toutes deux des rappels à 24 h) | 12 revues, 6 en-têtes de fiche recalés sur l'index | 1 (TRK-013) | agent d'audit |
| 2026-08-05 | 15 (3 sur 24 h) | 11 revues, 9 confirmées corrigées en prod | 1 (TRK-012) | agent d'audit |
| 2026-08-04 | 12 (0 nouvelle) | 10 revues | 1 (TRK-011) | agent d'audit (1er passage automatique) |
| 2026-08-03 | 12 | — | 10 (amorçage) | audit manuel (session de création) |
