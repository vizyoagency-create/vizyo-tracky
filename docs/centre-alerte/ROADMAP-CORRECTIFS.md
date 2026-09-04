# Roadmap des correctifs — centre d'alerte Tracky

> **Créée le 2026-09-04**, à la demande du propriétaire, à partir des **17 fiches ouvertes** du
> [référentiel](./REFERENCE-ERREURS.md). Ce fichier dit **quoi faire, dans quel ordre, et ce qui
> est vérifiable aujourd'hui** — le référentiel, lui, dit *pourquoi*. Les deux ne se recopient pas.
>
> **Ce fichier n'est pas le registre d'architecture.** La dette d'infrastructure et de structure
> vit dans `TACHES-AMELIORATION.md` sous des clés `AM-NNN`, avec sa propre règle « une tâche ne
> disparaît jamais ». Ici, uniquement les défauts **vus en production** par le centre d'alerte,
> sous leurs clés `TRK-NNN`. Croisements signalés, jamais dupliqués.

---

## L'ordre, et pourquoi c'est celui-là

Trois critères, appliqués dans cet ordre — **pas** la gravité seule :

1. **Est-ce que ça nuit MAINTENANT, en production ?** Un défaut qui fait échouer la requête d'un
   utilisateur passe avant un défaut qui salit un message.
2. **Est-ce que ça rend le dispositif AVEUGLE ?** Un instrument qui se tait pour une mauvaise
   raison coûte plus cher que le défaut qu'il devait voir : il transforme chaque passage suivant en
   fausse bonne nouvelle. *C'est la leçon de [TRK-026](./REFERENCE-ERREURS.md#trk-026), et elle a
   été repayée le 04/09.*
3. **Le geste est-il connu et borné ?** À nuisance égale, ce qui se corrige en une passe passe
   avant ce qui demande une décision produit ou une intervention terrain.

> ⚠️ **Une conséquence assumée de cet ordre** : TRK-064 (gravité 1) passe avant TRK-053
> (gravité 1) parce que le premier **aveugle un instrument neuf**, quand le second attend seulement
> une occasion de se prouver. *La gravité dit ce que ça coûte ; l'ordre dit ce qui débloque le reste.*

### Les trois états d'une tâche

| État | Ce que ça veut dire |
|---|---|
| ✅ **FAIT** | Codé, testé, commité. **Pas déployé** — le déploiement reste une décision humaine. |
| 🗓️ **WARN** | Rien à coder aujourd'hui. Une **consigne datée** est posée pour l'audit du lendemain. |
| 🤝 **HUMAIN** | Décision produit, action terrain, ou geste hors code. Écrit ici, jamais fait d'office. |

---

## P0 — nuit à la production maintenant

### TRK-063 · gravité 1 · ✅ FAIT ET VÉRIFIÉ EN PRODUCTION *(2026-09-04 01:14)*

**Ce qui se passe** — Deux véhicules sur 44 (`GLA•KC•31`, `KSR•370`) portent une plaque à points
médians. Node refuse un en-tête HTTP hors Latin-1 : **les cinq exports du contrôleur de rapports
répondent 500** pour eux, depuis toujours. Le rapport de vitesse, pièce opposable à un conducteur,
leur est inaccessible.

**Le geste** — Redéployer l'API. **C'est fait** : l'image servie a été reconstruite à **01:14:35**,
soit après le commit `ab6c9701` de 01:11:39, et le correctif est bien présent dans l'image
(`filename*=UTF-8` compté dans `dist/common/utils/telechargement.js`). Le constat d'origine — « image
de 01:02:21, neuf minutes trop tard » — décrivait l'état entre les deux déploiements du 4 septembre.

**Vérification faite** — l'export du trajet `c87259b1` de `GLA•KC•31` répond **200** (76 061
caractères) là où il répondait 500 ; les autres plaques gardent leur nom, le repli ASCII étant
identique à l'ancien nom pour tout ce qui l'était déjà.

---

### TRK-064 · gravité 1 · ✅ FAIT

**Ce qui se passe** — La chaîne d'alerte de vitesse est en production depuis le 04/09 01:03, et
activée sur **0 flotte sur 5, 0 véhicule sur 44**, aucun seuil renseigné — pendant que **145
analyses fraîches portent un excès**. La sentinelle écrite pour dire « un excès n'a pas produit son
alerte » sort immédiatement quand la liste des flottes concernées est vide : **elle ne peut pas
parler**, et rend le même silence qu'une chaîne en parfait état.

**Le geste** — Faire parler la sentinelle sur son propre angle mort : une ligne `DEGRADATION`,
refroidissement hebdomadaire, quand le réglage vaut zéro partout **alors que des excès sont
mesurés**. *Un garde-fou doit savoir dire qu'il n'a rien à garder.*

**Ce qui reste 🤝 HUMAIN** — décider du réglage par défaut. Activer la chaîne partout sans seuil
réfléchi ramènerait le déluge d'alertes que ce dépôt a déjà payé
([TRK-022](./REFERENCE-ERREURS.md#trk-022), 1 317 en un jour).

---

### TRK-061 · gravité 1 · ✅ FAIT *(volet code)* + 🤝 HUMAIN *(volet compte)*

**Ce qui se passe** — Le compte Anthropic est à sec depuis le 03/09 00:13. Anthropic facture
l'épuisement d'un compte en **HTTP 400**, donc la ligne tombe dans le cas par défaut que le code
commente lui-même « Vraie faute d'appel », sort en `kind: 'http'` — non transitoire — et **le
message de facturation du fournisseur, en anglais, est servi à l'utilisateur** parce que
`AiServiceError` hérite de `ServiceUnavailableException` et que son message *est* le corps HTTP.
Récidive le 04/09 sur un second chemin (`agenda_agent`).

**Le geste (code)** — Une catégorie `provider_unfunded` reconnue sur le corps du 400, **non
transitoire** (elle doit alerter) mais de niveau **`DEGRADATION`** — même raisonnement que pour
Overpass en [TRK-037](./REFERENCE-ERREURS.md#trk-037) : le service est indisponible pour une raison
assumée et externe. Message qui **nomme l'action**, et **deux publics séparés** : corps HTTP
générique pour le client, motif du fournisseur dans les métadonnées de la ligne.

**Le geste 🤝 HUMAIN** — **recharger le compte Anthropic.** Aucun correctif ne le fera.

---

## P1 — défaut réel, correctif écrit, preuve manquante

### TRK-062 · gravité 2 · ✅ FAIT

**Ce qui se passe** — Conséquence du **succès** de [TRK-021](./REFERENCE-ERREURS.md#trk-021) : les
commandes SMS-only partent enfin par SMS, mais elles n'ont plus aucun état terminal. Deux d'entre
elles sont `SENT` depuis **59,6 h et 63,0 h** et occupent **la moitié** de l'écran « commandes en
attente ». Jumeau exact de [TRK-007](./REFERENCE-ERREURS.md#trk-007), réintroduit par un chemin
neuf sans jamais croiser sa correction.

**Le geste** — **Requalifier, ne pas raccourcir.** Le refus de guetter un accusé en 15 s est juste
(réponse réelle mesurée à ~4 h le 19/08). Ce qui manque est une **borne supérieure** : au-delà de
24 h — six fois le pire délai observé — une commande SMS `SENT` devient terminale dans un état
**distinct de `FAILED`** : la commande *est partie*, c'est la réponse qui manque.

**Vérification, double condition** — les commandes SMS de plus de 24 h quittent
`commandes_en_attente`, **et** le total de la famille `shock_*` reste inchangé.

---

### TRK-053 · gravité 1 · 🗓️ WARN

**Ce qui se passe** — Un boîtier déclaré débranché continuait de produire des alarmes. Correctif
**déployé le 01/09 à 09:17**, jamais exercé depuis : le décompte est figé à 7 alertes, toutes du
31/08 donc antérieures au correctif, et les boîtiers concernés sont muets.

**Pourquoi rien à coder** — Le correctif est en ligne. Ce qui manque est une **occasion**, et *un
correctif qui fait taire des boîtiers déjà silencieux ne prouve rien.*

**Consigne pour l'audit du 05/09** — comparer `alertes_depuis_declaration` de `hors_service` à sa
valeur du 04/09 (**7**). Toute alerte neuve sur un véhicule déclaré est une **régression**.

---

### TRK-052 · gravité 2 · 🗓️ WARN

**Ce qui se passe** — Le prédicat de déduplication portait `acknowledgedAt: null` : acquitter une
alerte ré-armait l'alarme. Correctif déployé le 01/09 09:17, non exercé.

**Signal partiel du 04/09** — les **28 alertes de la semaine sont toutes acquittées**, dont 4
depuis le correctif, et **aucun doublon n'est apparu à leur suite**. Encourageant, non concluant :
il faudrait deux alarmes du même type sur le même véhicule pour trancher.

**Consigne pour le 05/09** — chercher une paire d'alertes de même type et même véhicule dont la
première est acquittée : si la seconde suit de moins de 6 h, le correctif n'a pas tenu.

---

### TRK-059 · gravité 2 · 🗓️ WARN

**Ce qui se passe** — La « cible atteinte » qui suit un échec portait une **autre** cible : 46
paires sur 46 en 7 jours. Correctif déployé le 02/09 21:04, non exercé.

**Consigne pour le 05/09** — les deux commandes `fix_continuous` ouvertes le 04/09 à 00:55 et 00:58
sont **postérieures** au correctif. Lire leur issue : le motif de clôture doit citer la cible
**demandée**, pas celle du moment.

---

### TRK-035 · gravité 1 · 🗓️ WARN *(surveillance, rien à coder)*

**Ce qui se passe** — 41 709 alertes effacées hors application en août. Le témoin posé depuis le
21/08 est **armé et muet** : 4 déclencheurs `actif = O`, 0 constat, écart figé à **13 250** au
8ᵉ point consécutif.

**Consigne permanente** — l'écart `ins − del − live` **ne doit jamais croître**. Une hausse signale
un `TRUNCATE`, qui n'incrémente pas `n_tup_del` — c'est exactement ce qui rendait l'effacement du
20/08 invisible. *Croisement : `AM-035` propose d'étendre le témoin aux autres tables de
traçabilité — même sujet, autre registre, pas de recopie.*

---

### TRK-018 · gravité 1 · 🤝 HUMAIN

**Ce qui se passe** — Le repli SMS du coupe-circuit : les commandes partent, **aucune n'est
confirmée**, et la passerelle **n'expose aucun accusé de remise**. Les correctifs 1 à 3 sont
déployés ; l'écran `/admin/immobilisations` suit les immobilisations non confirmées depuis le 26/08.

**Pourquoi ça s'arrête ici** — Le quatrième maillon n'est pas dans notre code : il faut un accusé
de remise **du prestataire SMS**. C'est un sujet contractuel, pas un correctif. TRK-062 en est la
conséquence directe sur le suivi des commandes, et il est traité, lui.

---

## P2 — le message ment ou le compteur dérive

### TRK-060 · gravité 3 · ✅ FAIT

**Ce qui se passe** — La collecte de métriques rend l'erreur de transport **brute** :
`Invalid prisma.$queryRaw() invocation: getaddrinfo EAI_AGAIN tracky-postgres`. Une seule
occurrence (02/09 00:00), aucune récidive en 49 h — l'incident est bénin, **le défaut est le
message** : il envoie instruire une panne de base de données qui n'a jamais eu lieu.

**Le geste** — Nommer la dépendance, la conséquence et ce qui survit, au lieu de recopier la pile.
*Une résolution DNS ratée sur un point de mesure ne dégrade rien d'autre que ce point.*

---

### TRK-065 · gravité 3 · ✅ FAIT *(volet code)* + 🤝 HUMAIN *(volet destinataire)*

**Ce qui se passe** — **Une notification sur trois n'atteint personne** (42 supprimées sur 129 en
7 jours), et les 42 se partagent également entre un **compte technique** qui n'aura jamais
d'appareil et un humain qui se croit prévenu.

**Le geste (code)** — Écarter les comptes techniques du décompte de la sentinelle. Sans ça,
l'instrument criera chaque semaine avec un chiffre **à moitié structurel** — et c'est ainsi qu'un
instrument neuf devient du bruit en trois passages.

**Le geste 🤝 HUMAIN** — prévenir le titulaire du second compte qu'aucun de ses appareils n'est
abonné, ou le sortir de la liste des destinataires.

---

### TRK-014 · gravité 3 · 🗓️ WARN

**Ce qui se passe** — **Aucun boîtier n'a jamais accusé réception d'une commande** : 0 sur 477 en
7 jours, 7ᵉ point consécutif. C'est la question de fond derrière TRK-018 comme TRK-062.

**Pourquoi rien à coder** — La chaîne applicative fait son travail ; c'est le matériel qui ne
répond pas. Y toucher côté logiciel produirait un **faux acquittement**, ce que
[TRK-051](./REFERENCE-ERREURS.md#trk-051) a précisément corrigé.

**Consigne permanente** — surveiller le **total de la famille**, jamais la classe. Le 26/08, un
compteur qui tombait cachait un voisin qui montait.

---

### TRK-016 · gravité 2 · 🗓️ WARN *(chantier, hors passe)*

**Ce qui se passe** — Le recalage cartographique échoue sur **9 trajets sur 10** depuis avril
(91,9 % le 22/08, série ouvrée en plateau).

**Pourquoi pas maintenant** — Ce n'est pas un correctif d'une passe : c'est un chantier de fond sur
le service de recalage, et il croise les lots V2/V3 déployés cette nuit (rattachement des points à
la voie, couverture des limites). **Le mesurer sous le nouveau code avant de le rouvrir.**

**Consigne pour le 05/09** — relever le taux **après** le premier passage d'analyse sous les lots
V1→V7. *Un chantier ouvert sur une mesure périmée est un chantier ouvert pour rien.*

---

### TRK-022 · gravité 2 · 🗓️ WARN *(à clore)*

Requalifié le 03/09 — répondu par le comportement : plancher net à **6,16 h** sur six intervalles
successifs, signature d'une fenêtre de 6 h. **Proposition : passer la fiche à CORRIGÉ** au prochain
passage si aucun doublon n'apparaît. *Décision du propriétaire — un agent n'écarte pas une fiche.*

---

## P3 — terrain et dépendances assumées

| Fiche | État | Ce qu'il faut savoir |
|---|---|---|
| **TRK-037** · g3 | 🤝 HUMAIN | Overpass est un miroir public gratuit. **32 `DEGRADATION` / 0 `ERROR` en 9 jours** — le classement tient, 3ᵉ point. Rien à faire, sinon décider un jour de payer un miroir. |
| **TRK-027** · g2 | 🤝 HUMAIN | Contrepartie assumée de la règle du parking : une antenne morte devient silencieuse dès la 2ᵉ perte au même endroit. Surveillance manuelle. |
| **TRK-001** · g4 | 🤝 HUMAIN | GPS perdu, boîtier vivant. Le sujet du jour est `GLA•KC•31`, **muet depuis 23 h** sans déclaration. Action terrain : antenne, fixation, alimentation. |

---

## 🗓️ Les tests datés en retard — à provoquer ou à requalifier

**La règle du dispositif : un test qui attend depuis plus de 7 jours doit être PROVOQUÉ ou
REQUALIFIÉ.** Le laisser attendre le transforme en fausse bonne nouvelle — *un correctif jamais
exercé rend exactement le même zéro qu'un correctif qui marche.*

| Fiche | Ce qu'il faut provoquer | En attente | Décision proposée |
|---|---|---|---|
| **TRK-032** | une trame `ac alarm` pendant une coupure programmée | 🔴 **13 j** | **REQUALIFIER.** 7 coupures d'alimentation cette semaine, toutes hors plage. L'occasion ne viendra pas d'elle-même : soit on la fabrique en atelier, soit on ferme la fiche en « non reproductible en exploitation ». |
| **TRK-051** | mode fix : badge ambre « cible atteinte (mesurée) » | 🟠 **9 j** | **CONFIER À UN HUMAIN.** C'est un geste d'interface, impossible à provoquer depuis un audit en lecture seule. Trente secondes pour qui a l'écran devant lui. |

---

## Journal d'exécution

*(rempli au fil de la passe du 2026-09-04)*

| # | Fiche | État | Preuve |
|---|---|---|---|
| 1 | TRK-064 | ⏳ en cours | — |
| 2 | TRK-061 | ⏳ en cours | — |
| 3 | TRK-062 | ⏳ en cours | — |
| 4 | TRK-060 | ⏳ en cours | — |
| 5 | TRK-065 | ⏳ en cours | — |
