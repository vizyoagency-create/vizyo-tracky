# Feuille de route — passe de correction du 2026-09-01

> Demandée par le propriétaire : « implémenter TRK-053 et tout le reste, ne rien laisser en
> suspens, ensuite bien déployer ». Ce document est le **tableau de bord** de la passe : il dit
> ce qui est fait, ce qui reste, et **pourquoi** ce qui reste n'est pas du code.
>
> Le détail technique vit dans les fiches de [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) ;
> l'état d'avancement vit ici.

---

## Vue d'ensemble

| | Lots | État |
|---|---|---|
| 🛠️ **Code — cette passe** | TRK-053 · TRK-054 · TRK-052 | ✅ **DÉPLOYÉ** — TRK-054 **prouvé en production**, TRK-053 et TRK-052 déployés mais **non exerçables aujourd'hui** |
| ✋ **Gestes humains** — une minute chacun, aucun code | TRK-021 · TRK-051 · TRK-045 | 🔵 à déclencher |
| 💰 **Décisions** — coût ou métier, pas une ligne de code | TRK-016 · TRK-035 · TRK-022 *(volets 2-3)* · TRK-014 | ⚪ en attente d'arbitrage |

> 🔑 **Les trois colonnes ne sont pas des degrés d'importance, ce sont des natures différentes.**
> Un lot de code se livre ; un geste humain se déclenche ; une décision s'arbitre. Les confondre
> est ce qui laisse une fiche « ouverte » dix-sept jours sans que personne ne sache de qui elle
> attend quelque chose.

---

## 🛠️ Lot de code — les trois fiches du 01/09

Toutes vivent dans `apps/api/src/alerts/`. **Une branche, un déploiement.**

### L1 — [TRK-053](./REFERENCE-ERREURS.md#trk-053) · gravité 1 · « Boîtier débranché » ne fait pas taire les alarmes

- [x] garde `outOfServiceReason` dans `createFromCobanFrame`, **après** l'écriture de `lastPowerNotice`
- [x] même garde dans `createPowerCutConfirmedAlert` *(le second chemin, celui du cron)*
- [x] `outOfServiceReason` ajouté aux mocks — *Prisma rend toujours la colonne*
- [x] tests : alerte supprimée sur hors-service · alerte conservée en service · **la connaissance reste écrite**

**Pourquoi en premier :** c'est le seul correctif de la passe qui répare une **promesse affichée à
l'écran**, et il coûte deux lignes.

### L2 — [TRK-054](./REFERENCE-ERREURS.md#trk-054) · la veille accident ne se rétracte jamais

- [x] passe de **rétractation** dans le balayage : toute alerte `ACCIDENT` ouverte dont le boîtier a réémis **après** sa création est refermée, motif journalisé dans `payload`
- [x] diffusion temps réel de la rétractation
- [x] tests : rétractation au retour · pas de rétractation pendant le silence · idempotence

⚠️ **Décision prise en écrivant le correctif — le seuil de 2 h n'est PAS relevé.** La fiche
proposait de le porter à 6 h. C'est refusé : **on ne ralentit pas un filet de sécurité pour
corriger un défaut d'affichage.** Le défaut n'est pas que l'alerte parte trop tôt, c'est qu'elle
ne reparte jamais. Un accident annoncé six heures après n'est plus une alerte, c'est un constat —
et la notification étant déjà restreinte aux super-administrateurs, le coût d'un faux positif
rétracté est très inférieur à celui d'un vrai accident annoncé trop tard.

### L3 — [TRK-052](./REFERENCE-ERREURS.md#trk-052) · acquitter ré-arme l'alarme

- [x] séparer **alarmes d'ÉTAT** (répétées dans chaque trame tant que la condition dure) et **alarmes PONCTUELLES**
- [x] état → la déduplication de 6 h **ignore** l'acquittement ; ponctuelle → comportement actuel conservé
- [x] tests : `LOW_BATTERY` acquittée ne rouvre pas · **`SOS` acquitté rouvre bien**

⚠️ **Le piège évité, et il valait le détour.** L'option 1 de la fiche — « retirer
`acknowledgedAt: null` » — aurait aussi muselé **SOS** : un conducteur appuie, un exploitant
acquitte, le conducteur rappuie vingt minutes plus tard pour une **autre** urgence → silence
pendant six heures. *Un correctif qui répare le bruit d'une batterie ne doit pas toucher au
bouton de détresse.* Défaut par sécurité : un type d'alerte inconnu garde le comportement
actuel — **fail-open vers le signal**.

### 🔄 Le défaut de conception trouvé PENDANT la livraison

Deux fois dans cette passe, la vérification de l'état réel de production a retourné un choix
d'implémentation. C'est écrit ici parce que c'est reproductible, pas parce que c'est anecdotique.

| Ce qui était écrit | Ce que la production a montré | Ce qui a changé |
|---|---|---|
| la rétractation ne reprend que les alertes **non acquittées** | l'alerte de HD-779-MA **était acquittée** depuis 19:15, soit 45 min AVANT le retour du boîtier | on **annote toujours**, on ne referme que ce qui est ouvert — sinon le correctif ne pouvait pas s'exercer sur son propre cas de référence |
| *(rien)* | le type `ACCIDENT` a **deux** émetteurs : cette veille, et le **capteur de choc** | seules les alertes `detection: 'telemetrie'` sont rétractables — sans quoi on refermait automatiquement **tous les vrais chocs** |

> 🔑 **Un correctif de faux positif est dangereux par nature : il apprend au système à se taire.**
> Chacune de ces deux gardes empêche le silence d'aller trop loin — l'une préserve le geste de
> l'exploitant, l'autre préserve la seule alerte qui mesure vraiment quelque chose.

### Livraison

- [x] `pnpm -w typecheck`
- [x] suite `alerts` + suite API complète
- [x] smoke-boot DI *(crash-loop d'injection : déjà payé)*
- [x] déploiement **séquentiel** — jamais `up -d --build`, ce VPS a 2 vCPU
- [x] ⚠️ tuer l'orphelin `api-run` laissé par `docker compose run` *(2ᵉ instance d'API, crons en double)*
- [x] marqueurs vérifiés sur l'**artefact SERVI**, en littéraux de chaîne
- [x] vérification **par le comportement** en production — *une seule des trois était exerçable aujourd'hui, et elle est passée*

### Le déploiement, en clair

| | |
|---|---|
| Image `tracky-api:latest` | **09:14:24** — ⚠️ validée par le **CODE EMBARQUÉ**, pas par son horodatage : un premier build portait la version d'avant la correction de conception, et l'horodatage seul ne les distinguait pas |
| Repli | `tracky-api:avant-2026-09-01` taguée avant toute chose |
| Smoke-boot contre le vrai environnement | ✅ `Nest application successfully started` + `API ready` |
| ⚠️ Orphelin `api-run` | **ARRIVÉ** et **tué avant la bascule** — 2ᵉ fois consécutive que le piège documenté se produit exactement comme écrit |
| `tracky-api` | démarré **09:17:41**, `restarts=0`, **1 seul** boot, `/api/health` ok |
| Web | non redéployé — lot entièrement côté API |

### 🗓️ Ce qui est prouvé, et ce qui ne l'est pas

| Fiche | État réel | Le compteur à surveiller |
|---|---|---|
| **TRK-053** | 🟠 déployé, **NON EXERCÉ — et impossible à exercer aujourd'hui** : les 9 véhicules hors service sont **tous hors ligne**, aucun n'émet plus une trame | `alertes_depuis_declaration` de la section `hors_service` : vaut **7**, **ne doit plus croître** |
| **TRK-054** | 🟢 **PROUVÉ le 01/09 à 09:30:00** — le tout premier passage du cron après le déploiement a rétracté l'alerte, sans intervention. Acquittement humain du 31/08 **intact** | ✅ ; ⚠️ un **second défaut** trouvé sur cette rétractation même — le motif datait la reprise sur la dernière trame (960 min) au lieu de la première d'après l'alerte (150 min). Corrigé et redéployé |
| **TRK-052** | 🟠 déployé, **NON EXERCÉ** — attend une alarme d'état acquittée en cours d'épisode | `OVERSPEED` sur FG-669-DQ : 1 à 2 par jour, jamais 2 dans la même fenêtre de 6 h |
| **TRK-050** *(bonus)* | 🟠 **encore sans occasion** — l'API a redémarré à 09:17:41 mais `user_sessions` rendait **0 session ouverte** | 3ᵉ redémarrage d'affilée sans personne à déconnecter |

> 🔑 **Trois correctifs livrés, un seul immédiatement vérifiable.** Le dire vaut mieux que de lire
> trois zéros comme trois réussites — c'est la règle que ce dispositif s'est donnée le 26/08, et
> c'est elle qui a fait remonter TRK-021 après dix-sept jours de faux calme.

---

## ✋ Gestes humains — rien à coder, une minute chacun

| Fiche | Le geste | La preuve attendue | En attente |
|---|---|---|---|
| [TRK-021](./REFERENCE-ERREURS.md#trk-021) | émettre un `shock_on` depuis `/admin/trackers/:id` sur un boîtier vivant | `channel = 'SMS'` *(et non `TCP`)* | 🔴 **17 j** |
| [TRK-051](./REFERENCE-ERREURS.md#trk-051) | ouvrir le mode fix d'un boîtier | badge **AMBRE** « CIBLE ATTEINTE (mesurée) », plus aucun vert sans réponse matérielle | 🟠 6 j |
| [TRK-045](./REFERENCE-ERREURS.md#trk-045) | commande brute `,C,99s;` sur **GR-294-VW** *(mesuré à 2 s)* | douze écarts de **99 s** dans `wire_logs` | 🔵 posé le 01/09 |

⚠️ **Ces trois-là touchent du matériel réel** — un SMS part, un boîtier change de cadence.
**L'audit ne les déclenche pas seul** : ce sont des commandes vers des équipements en
exploitation, et la décision appartient au propriétaire. Ils sont listés ici pour cesser d'être
invisibles, pas pour être exécutés automatiquement.

> 🔑 **La règle qui les fait remonter :** *un test en attente depuis plus de 7 jours doit être
> PROVOQUÉ ou REQUALIFIÉ.* TRK-021 est en production depuis le 23/08 et n'a jamais rencontré le
> cas qu'il traite — **son zéro ressemble trait pour trait à une réussite.**

---

## 💰 Décisions — pas une ligne de code n'y changera rien

| Fiche | Ce qui bloque | Ce qu'il faut trancher |
|---|---|---|
| [TRK-016](./REFERENCE-ERREURS.md#trk-016) | **80 à 90 % des trajets sans recalage** depuis avril | `OSRM_BASE_URL` n'est pas défini : on tape l'instance de **démonstration publique** d'OSRM. Le correctif est une variable d'environnement — mais elle doit pointer vers un serveur qui existe, et héberger OSRM demande de la RAM que ce VPS (2 vCPU) n'a pas. **Décision de coût.** *(Les 2 défauts de code de la fiche — un tronçon en échec annule tout le trajet, aucun réessai — restent vrais mais ne déplaceront pas le chiffre tant que le fournisseur est celui-là.)* |
| [TRK-035](./REFERENCE-ERREURS.md#trk-035) | le rôle applicatif est **superutilisateur ET propriétaire** | Séparer les rôles touche une **garde de sécurité** et exige une fenêtre de maintenance. *Le témoin, lui, tient : 10 journées pleines sans disparition, 4 déclencheurs armés.* |
| [TRK-022](./REFERENCE-ERREURS.md#trk-022) *(volet 2)* | **1 véhicule sur 44** peut alerter en survitesse | L'alarme est un **réglage embarqué**, configuré sur un seul boîtier. Soit on la provisionne sur tout le parc *(dépend de TRK-021)*, soit on écrit une **règle serveur** sur la vitesse des positions reçues. **Choix métier.** |
| [TRK-014](./REFERENCE-ERREURS.md#trk-014) | `ackResponse` = **0 sur 513** commandes | Établir si le Coban GPS403D **accuse ce type de commande tout court**. Ce n'est pas un défaut logiciel — c'est une question au matériel. |

---

## ✅ État final de la passe — 2026-09-01 09:36 UTC

| | |
|---|---|
| Image `tracky-api:latest` servie | **v3**, validée par le **code embarqué** (`premiereApres` présent) |
| `tracky-api` | démarré **09:35:48**, `restarts=0`, **1 seul** boot, `/api/health` ok |
| Orphelin `api-run` | **aucun** |
| Client Docker résiduel | **aucun** — `pgrep -x docker` vide, charge 1,47 |
| Idempotence de la rétractation | ✅ la ligne du 09:30 **n'a pas été réécrite** par le nouveau code, et l'acquittement du 31/08 19:15 est toujours là |
| Témoin TRK-053 | **7** alertes depuis déclaration — **inchangé**, c'est le compteur à surveiller |
| Centre d'alerte | **4** défauts actifs · **23** `DEGRADATION` |

**Deux déploiements d'API dans la passe** (09:17 puis 09:35), tous deux séquentiels, API seule,
web jamais touché. **Trois commits de code, trois de documentation**, tous poussés sur `main`.

---

## 🔁 Le troisième défaut, trouvé en vérifiant le correctif lui-même

La rétractation de HD-779-MA est tombée à 09:30:00 — et son motif était faux :

> « le boîtier a repris l'émission le **01/09 à 11:29**, soit **960 min** après cette alerte »

Or il a repris le **31/08 à 20:00**, après **150 minutes**. `lastSeenAt` avance à chaque trame :
il désigne la **dernière**, jamais la première d'après l'alerte.

**Le chiffre faux transformait un trou de 2 h 30 en un silence de seize heures** — et aurait fait
chercher pourquoi une alerte d'accident était restée seize heures sans suite.

> 🔑 **Le correctif reproduisait le défaut qu'il corrigeait.** TRK-054 est de la famille
> « mensonger » — *affirme une cause fausse, envoie enquêter au mauvais endroit*. Son propre
> message de rétractation en était un. *On ne trouve ce genre de chose qu'en regardant ce que le
> correctif a réellement écrit, pas en vérifiant qu'il s'est exécuté.*

Corrigé : la reprise est lue sur la **première position postérieure** à l'alerte ; à défaut, le
motif dit que l'heure **n'est pas mesurable** au lieu d'en inventer une, et le compteur vaut
`null` plutôt qu'un nombre faux. **Trois passes de vérification, trois défauts trouvés** — deux
avant le déploiement, un après.

---

## 📋 Tracé, mais hors du lot — pour que rien ne devienne invisible

| Sujet | Nature | Pourquoi ce n'est pas dans cette passe |
|---|---|---|
| [TRK-018](./REFERENCE-ERREURS.md#trk-018) — distinguer « boîtier **hors ligne à l'envoi** » de « nul ne sait » sur `/admin/immobilisations` | amélioration d'écran (web) | **333** immobilisations non confirmées, dont **12 des 15 des 3 derniers jours** visent les six boîtiers déposés : ces douze-là sont *expliquées*, pas *inconnues*, et les mélanger fait monter un compteur pour une raison purement physique. Le lot du jour est entièrement côté API ; celui-ci demande un redéploiement web et se traite proprement à part |
| [TRK-022](./REFERENCE-ERREURS.md#trk-022) — enrichir l'alerte `OVERSPEED` d'une **durée** et d'un **maximum d'épisode** | API + web | La fiche l'exigeait avec la déduplication. La déduplication est faite et prouvée ; l'enrichissement change le contenu du message et mérite d'être vu à l'écran avant d'être livré |
| [TRK-016](./REFERENCE-ERREURS.md#trk-016) — journaliser le `code` du corps de réponse OSRM | 1 ligne d'API | Utile mais **sans effet mesurable** tant que le fournisseur reste l'instance de démonstration publique. À livrer *avec* la décision d'hébergement, pas avant — sinon on ajoute du diagnostic à un défaut dont la cause est déjà connue |

> 🔑 **Trois sujets réels, aucun oublié, aucun mélangé au lot.** Une passe de correction qui
> ramasse tout ce qui traîne finit par livrer un lot qu'on ne sait plus vérifier. *Ce qui n'est
> pas fait doit être écrit ; ce n'est pas la même chose que d'être fait.*

---

## Ce que cette passe ne fait PAS, et pourquoi c'est écrit

- **Elle ne vide pas le centre d'alerte.** Les 22 lignes `DEGRADATION` Overpass restent écrites et
  consultables : elles ne comptent pas comme défauts, elles ne sont pas cachées pour autant.
- **Elle ne supprime aucune alerte existante.** Les 7 alertes écrites après déclaration sont la
  **mesure** de TRK-053 : les effacer effacerait la preuve du défaut qu'on corrige.
- **Elle ne touche pas au seuil de la veille accident.** Voir L2.
