# A6 — Demandes de mission, devis et négociation

> Fonctionnalité en construction sur `feat/depot-partage`. Ce fichier est le **plan
> de référence** : on le suit, on coche, et on y consigne les décisions au fur et à
> mesure. Toute session qui reprend le chantier commence ici.
>
> **État au 2026-08-14 (soir)** — **LES QUATRE DETTES SONT SOLDÉES** et **la modale de
> demande côté dépôt est écrite**. 2025 tests API passent. **Rien n'est déployé.**
>
> | Tranche | État |
> |---|---|
> | T1 modèle de domaine | ✅ |
> | T2 migration + grille par défaut | ✅ vérifiée en local |
> | T3 tarification (API + écran) | ✅ — contrastes corrigés, cf. ci-dessous |
> | T4 moteur de devis | ✅ — c'est `MissionPricingService.tarifPour` |
> | T5 demande côté dépôt — **API** | ✅ permission, service, endpoints, 56 tests |
> | T5 demande côté dépôt — **INTERFACE** | ✅ modale en 5 étapes, devis en direct |
> | T6 négociation — **API** | ✅ même service |
> | T6 négociation — **INTERFACE** | ✅ **un seul fil, les deux camps** |
> | T7 affectation et conversion | ✅ API + écran (véhicule, conducteur, consignes) |
> | T9 e-mails | ✅ **les quatre** : demande, contre-proposition, accord, affectation |
> | **T8 multi-arrêts dans l'agenda** | ✅ saisie, liste, carte du dépôt |
> | **T10 recette** | ✅ **navigateur, 375 px, cycle complet — 8 scénarios** |
>
> **La recette navigateur est AUTOMATISÉE** :
> `apps/web/e2e/a6-demandes-et-negociation.spec.ts`. Elle joue le cycle entier à
> 375 px — le transporteur règle sa grille, le dépôt dépose, le transporteur
> contre-propose, le dépôt accepte, le transporteur affecte — puis rejoue les deux
> écrans en 1280 px. Chaque étape mesure **dans le DOM rendu** : contraste réel,
> débordement horizontal, cibles tactiles ≥ 44 px. Elle est rejouable (empreinte et
> créneau propres à chaque exécution) et se lance ainsi :
>
> ```
> $env:A6_TOKEN_CARRIER = '<jwt>'   # cf. TEST_PLAN T04, jeton signé localement
> $env:A6_TOKEN_DEPOT   = '<jwt>'
> $env:E2E_BASE_URL = 'http://localhost:4211'; $env:E2E_SKIP_DEV_SERVER = '1'
> pnpm --filter @vizyo/tracky-web exec playwright test a6-demandes
> ```
>
> **Ce que la recette a trouvé, et qu'aucun autre contrôle ne voyait :**
>
> 1. **Le simulateur affichait « 202.8 € »** — point décimal anglais, décimale
>    manquante, sur le seul écran dont l'objet est de faire relire un prix. La
>    fonction `euros()` renvoie un NOMBRE pour la liaison d'un `<input type="number">`,
>    et servait aussi à l'affichage. Séparée en `euros()` / `montant()`.
> 2. **Le recalcul de la contre-proposition mentait.** Le transporteur corrigeait
>    48 km en 62 et lisait « Sur 62 km, votre grille donne 79,00 € HT (tranche 0 à
>    50 km) » : le nombre venait de la nouvelle saisie, le prix de l'ancienne. Cause :
>    un `computed()` lisant un champ lié par `ngModel` — un signal ne suit pas une
>    propriété simple, le calcul était figé au premier rendu. **Même piège que dans la
>    modale de demande**, où il avait été attrapé à la relecture ; ici il fallait le
>    navigateur.
> 3. **Le portail `<app-permissions-gate>` intercepte tous les clics** au premier
>    lancement. Sans le neutraliser, aucun parcours automatisé n'est possible — et le
>    message d'erreur ne le nomme jamais.
>
> ⚠️ **Un piège pour la mise en production** : les comptes dépôt créés AVANT la
> permission `missions_request` portent un JSON de permissions où la clé est
> **absente**. Le résolveur teste `perms[clé] === true` : clé absente = refus. Les
> trois comptes de démonstration étaient dans ce cas. L'écran l'annonçait mal — il
> accusait le transporteur de ne pas avoir publié ses tarifs ; il distingue désormais
> le 403 de l'absence de grille.
>
> **Le fil de négociation est UN SEUL composant, partagé par les deux camps**
> (`shared/components/mission-request-thread`). Les deux parties y accèdent tant que
> l'accord n'est pas conclu des deux côtés ; `ACCEPTED` ferme la négociation mais
> laisse le fil consultable — le dépôt doit pouvoir relire ce sur quoi il s'est engagé.
> Ce qui change d'un camp à l'autre n'est pas la structure, ce sont les MOTS, décidés
> au seul endroit `nomDe()`. La coque est `depot-modal`, réutilisée telle quelle côté
> transporteur : en écrire une seconde est exactement ce qui avait cassé
> `mission-dialog` (§ 10).
>
> **Les quatre dettes de l'en-tête, soldées le 2026-08-14 :**
>
> 1. **Expiration des devis** — `MissionStatusService.expirerLesDevis()`, dans le tick
>    d'une minute qui existait déjà. Filtre sur `SUBMITTED` et `NEGOTIATING` seuls, et
>    le statut est **répété dans le `where` de l'écriture** : entre la lecture et la
>    mise à jour, une partie a pu accepter. Une demande `EXPIRED` n'est plus ni
>    négociable, ni acceptable, ni refusable, ni affectable — 5 tests le verrouillent.
> 2. **Alerte grille absente (arbitrage J)** — nouveau type `PRICING_GRID_MISSING`,
>    migration **purement additive** (`ALTER TYPE … ADD VALUE`). Levée depuis
>    `tarifPour`, **fire-and-forget** : ce service est sur un chemin d'écran, une alerte
>    en échec ne doit pas faire échouer un calcul. Dédupliquée 24 h par flotte,
>    acquittée ou non. **Aucun dispatch externe** : légitime pour un SOS, absurde pour
>    un tarif non publié. Seule alerte du catalogue **sans véhicule**.
> 3. **Les deux e-mails manquants** — accord conclu (**aux deux parties**, le seul avis
>    du lot dans ce cas) et mission affectée (au dépôt). Un seul gabarit,
>    `buildMissionQuoteEmail` ; **seul le lien change** d'un camp à l'autre.
>    ⚠️ L'avis générique de `MissionsService.creer` est **coupé** sur le chemin de
>    conversion (`{ notifierDepot: false }`, hors DTO) : sans cela le dépôt recevait
>    deux e-mails dans la même seconde, dont un qui ignore tout de la négociation.
> **⚠️ UN TROU GRAVE, TROUVÉ EN BRANCHANT LES ÉCRANS LE 2026-08-14.**
>
> Le tour 0 porte l'auteur `SYSTEM`. Or `awaiting` et les gardes de `accepter` /
> `contreProposer` comparaient cet auteur aux deux camps — et `SYSTEM` n'est égal à
> aucun des deux. Deux conséquences :
>
> 1. `awaiting` valait `DEPOT` juste après l'envoi : **la file du transporteur n'aurait
>    jamais montré une demande neuve** dans « à traiter ».
> 2. Bien pire : **le dépôt pouvait accepter son propre devis automatique** dans la
>    seconde suivant l'envoi. La demande passait en `ACCEPTED` avec un montant convenu
>    sans que le transporteur ait rien dit — un accord à une seule signature, ce que la
>    garde était précisément censée empêcher.
>
> Corrigé par `campDuTour()` : **`SYSTEM` appartient au camp du DÉPÔT**. Le devis
> automatique est calculé à la demande du dépôt, sur les conditions qu'il vient de
> saisir (arbitrage D) — c'est son offre, et c'est au transporteur d'y répondre.
> 5 tests le verrouillent.
>
> 4. **Contrastes de l'onglet Paramètres** — la garde `verif:contraste` a été étendue
>    aux deux écrans du lot (**84 couples**, contre 46). Elle a trouvé **trois textes
>    sous le seuil** : le texte d'aide et les en-têtes de colonne de l'éditeur de
>    tranches (`--fg-tertiary` → **3,16:1** en clair, **3,75:1** en sombre, sous le
>    seuil dans les DEUX thèmes), et la pastille « Chargement » de la modale de demande
>    (vert de marque brut → **2,71:1** en clair). Corrigés en `--fg-secondary` et
>    `--texte-succes`. Les 84 couples passent.
>
> **Reprendre ici :** l'interface. Deux écrans à écrire, tous deux branchés sur des
> endpoints qui existent et sont testés :
> 1. **Côté dépôt** — la modale de demande en étapes (arbitrage F), avec saisie
>    multi-arrêts et devis affiché en direct. Endpoints : `POST /mission-requests`,
>    `GET /mission-requests`, `/:id`, `/:id/counter`, `/:id/accept`, `/:id/reject`.
> 2. **Côté transporteur** — l'onglet **Demandes** de `/missions` : file d'attente,
>    fil de négociation, correction de la distance, puis `/:id/assign`.
>
> Le § 7bis décrit précisément ce que chaque côté doit voir. Lisez ce fichier en
> entier avant d'écrire une ligne, en particulier le § 2 (arbitrages) et le § 10
> (pièges déjà payés sur ce dépôt).
>
> **Commits :** `63e1749` `17465f9` `6becc27` `04a5284` `9561265` `5eab130`
> `99d8ffc` `a16c453` `e386825` `6f49011` `7e1c083`.
>
> ⚠️ **Quatre dettes connues, à solder avant tout déploiement :**
> 1. L'onglet Paramètres **n'a pas été vérifié dans le navigateur** — ni à 375 px, ni
>    sur les contrastes. La première des trois règles non négociables du chantier
>    n'est donc pas honorée sur cet écran.
> 2. L'alerte au centre d'alertes quand la grille manque (arbitrage J) n'est pas
>    branchée : le service répond `PAS_DE_GRILLE`, mais rien ne remonte côté
>    administration.
> 3. **L'expiration automatique** d'un devis n'est pas branchée. `quoteExpiresAt` est
>    écrit, mais aucune tâche ne fait passer les demandes en `EXPIRED` — à ajouter
>    dans `MissionStatusService`, qui tourne déjà toutes les minutes.
> 4. Deux e-mails manquent : **accord conclu** et **mission affectée**. Les deux
>    moments les plus attendus des deux côtés.

---

## 0bis. Revue complète du lot — 2026-08-14

> Passe de bout en bout : API, interface, isolation, contrats, tests. Ce qui suit est
> **ce qui a été trouvé**, pas ce qui a été écrit — le reste du document dit déjà ce
> qui a été écrit.

### Corrigé pendant la revue

| # | Constat | Gravité |
|---|---|---|
| 1 | **Un CONDUCTEUR lisait toutes les négociations.** `GET /mission-requests` était gardée par `missions_view`, que le rôle DRIVER porte par défaut. Vérifié sur une session réelle : **200, 21 Ko** — noms des dépôts, adresses, montants, messages. Un LECTEUR aussi. Passé à `missions_request` : la capacité de **négocier**, portée par le dépôt, le gestionnaire et l'administrateur — les deux côtés de la table, personne d'autre. Re-vérifié : **403**. | **Haute** |
| 2 | **Le dépôt pouvait accepter son propre devis automatique.** Le tour 0 porte l'auteur `SYSTEM`, égal à aucun des deux camps : la garde laissait passer. Accord à une seule signature. Corrigé par `campDuTour()`. | **Haute** |
| 3 | **On ne pouvait pas créer de mission depuis un téléphone.** `mission-dialog` en `z-index: 61`, barre de navigation basse en `7000` : le bouton « Créer » était couvert, un appui ouvrait « Alertes ». | **Haute** |
| 4 | **Le recalcul d'une contre-proposition mentait** : « Sur 62 km, votre grille donne 79,00 € HT (tranche 0 à 50 km) ». Un `computed()` lisant un champ `ngModel`. | Moyenne |
| 5 | **Le simulateur affichait « 202.8 € »** — point décimal anglais, décimale manquante, sur l'écran dont l'objet est de faire relire un prix. | Moyenne |
| 6 | **Deux textes de l'onglet Paramètres sous le seuil** de contraste, dans les DEUX thèmes (3,16:1 et 3,75:1). | Moyenne |
| 7 | **La croix de fermeture de `mission-dialog` faisait 26 px** — seul moyen de fermer hors iOS. | Moyenne |
| 8 | **Les deux `select` de `mission-dialog` sans nom accessible propre** : le `label` enveloppant le contrôle, le nom calculé avalait la liste des options. Un lecteur d'écran annonçait la flotte entière à chaque prise de focus. | Moyenne |
| 9 | **Les comptes dépôt existants n'ont pas `missions_request`** : clé absente du JSON de permissions, et le résolveur teste `=== true`. L'écran accusait à tort le transporteur de ne pas avoir publié ses tarifs. | Moyenne |

**Le point commun des n° 3, 7 et 8 : `mission-dialog` porte ses propres styles au lieu
de la coque partagée.** Le § 10 le disait déjà. Il avait raison trois fois de plus.

### Vérifié et sain

- **Isolation du dépôt** — `lister` et `chargerAccessible` bornent sur `depotUserId`
  à chaque requête ; un dépôt tiers reçoit `404`, jamais `403` (sonder l'existence
  d'une demande par son identifiant reste impossible). Testé.
- **Liens publics** — leur sélection ne rend que `destLabel`. T8 n'y ajoute rien : la
  tournée complète exposerait les adresses des autres clients du transporteur à un
  destinataire de colis.
- **Ce que le dépôt reçoit** — `DepotMissionDto.stops` porte les **libellés seuls**.
  Le test du « contrat de fuite » couvre le champ.
- **Une demande expirée** ne se négocie, ne s'accepte, ne se refuse et ne s'affecte
  plus. Quatre gardes, quatre tests.
- **L'affectation** est refusée deux fois à un dépôt : par la permission du contrôleur
  (`missions_manage`) et par le service, avant toute écriture.

### Dette restante, assumée

| Sujet | État |
|---|---|
| `estimatedDistanceM` | Toujours nul — décision Q3 : pas de service de routage, et un vol d'oiseau ferait changer de tranche. L'écran le dit. |
| Modifier les arrêts d'une mission existante | **Non fait.** `ModifierMissionEntree` ne porte pas `stops` ; la tournée se fige à la création. `mission-dialog` ne sert qu'à créer. |
| Cibles tactiles de l'**agenda** | 7 boutons sous 44 px (`ag-month-btn` 30, `ag-today-btn` 31, `mp-filtre` 35, `mp-creer` 36…). **Antérieurs à ce lot**, hors périmètre A6, non corrigés. |
| Liste des demandes | Plafond serveur à 200, aucune pagination ni filtre. Suffisant aujourd'hui, à revoir avant un client à fort volume. |
| Suite web | **Un échec non reproductible** observé une fois sur cinq exécutions (353 tests). Quatre passes suivantes vertes ; le test fautif n'a pas pu être nommé. |
| Migration T2 + `PRICING_GRID_MISSING` | Appliquées **en local uniquement**. Rien n'est déployé. |

---

## 1. Ce que la fonctionnalité doit faire

Un **dépôt** — jusqu'ici tiers en lecture seule — peut **demander** une mission. Il
saisit un enlèvement, une ou plusieurs livraisons, un créneau, la marchandise. Le
système propose **immédiatement un devis** calculé sur la grille tarifaire du
transporteur. La demande part au **fleet admin**, qui accepte, refuse ou
**contre-propose**. Le dépôt peut contre-proposer à son tour, autant de fois qu'il
le faut. **Quand les deux parties valident**, le fleet admin **affecte un camion et
un conducteur** — et la mission réelle naît à cet instant.

### Ce qui n'est pas la fonctionnalité

Une demande **n'est pas une mission**. Elle n'immobilise aucun véhicule, ne pose
aucun événement d'agenda, n'ouvre aucun accès à une position. C'est l'invariant qui
tient tout le reste : tant que les deux parties n'ont pas signé, rien n'existe côté
exploitation.

---

## 2. Les arbitrages du client — 2026-08-13

Ils priment sur toute décision antérieure, y compris celles inscrites dans le
schéma lors de la tranche 1.

| # | Décision | Conséquence |
|---|---|---|
| **A** | **Les arrêts multiples existent PARTOUT**, pas seulement sur les demandes. « C'est rare, les missions avec une seule adresse. » | Le modèle `Mission` gagne des arrêts. La création de mission dans `/agenda` doit permettre plusieurs points de livraison. |
| **B** | **L'adresse de chargement est fixe** ; le **retour au dépôt n'est pas obligatoire**. | Un enlèvement, N livraisons, retour optionnel. Modulable, jamais strict. |
| **C** | **Sans grille tarifaire, les demandes ET la création de mission sont désactivées.** | Le verrou est structurel, pas déclaratif. ⚠️ Voir le risque en § 7. |
| **D** | Le devis est proposé **dès la demande**, puis la demande part au fleet admin qui accepte ou contre-propose. | Le tour 0 est automatique et figé ; l'e-mail au transporteur part à l'envoi. |
| **E** | Les kilomètres sont **saisis par le dépôt ET estimés depuis les adresses**. | On garde les deux, plus celui retenu pour le devis. Cf. § 5. |
| **F** | **Bien expliquer les étapes dans les modales.** | La modale de demande est un parcours en étapes nommées, pas un formulaire à vingt champs. |
| **G** | **Une seule prestation** : transport de marchandise. La distance est la **somme de tous les segments**. | Une seule catégorie de tranches. Le modèle garde les catégories : elles ne coûtent rien et évitent une migration le jour où une seconde prestation arrive. |
| **H** | **Le retour n'est compté que si le dépôt l'ajoute** comme dernière adresse. | Aucun segment fantôme. Le dépôt voit exactement ce qu'il paie, et l'écran le lui dit : « ajoutez l'adresse de chargement en dernière livraison pour facturer le retour ». |
| **I** | Une contre-proposition change **le prix ET les conditions** — adresses, créneau, distance. Le prix est **recalculé**, puis **ajustable**. | Chaque tour porte les conditions proposées. L'accord porte sur une **version précise**, jamais sur un montant flottant. |
| **J** | **Grille absente = alerte au centre d'alertes, PAS de blocage.** Les missions restent créables ; seule la tarification disparaît. | Le risque du § 7 s'éteint. |

---

## 3. La grille tarifaire réelle

Fournie par le client le 2026-08-13. **Ce n'est pas un prix au kilomètre** — c'est
une grille par **tranches de distance**, à prix forfaitaire HT.

### 2. Courses Express

| Distance | Tarif HT |
|---|---|
| 0 à 50 km | 79 € |
| 51 à 100 km | 169 € |
| 101 à 150 km | 259 € |
| 151 à 200 km | 349 € |
| 201 à 250 km | 449 € |
| 251 à 300 km | 539 € |
| 301 à 350 km | 629 € |
| 351 à 400 km | 719 € |
| **Plus de 400 km** | **Sur devis** |

### Ce que cette grille impose au modèle

1. **Des tranches, pas un tarif unitaire.** Le modèle de la tranche 1
   (`pricePerKmCents`, `baseFeeCents`…) ne convient pas et doit être remplacé.
2. **« Sur devis » est un état, pas un prix.** Au-delà de 400 km, aucun montant
   n'est calculé : la demande part au transporteur **sans** tour 0 automatique, et
   c'est lui qui chiffre. L'écran doit le dire au dépôt au moment de la saisie —
   pas après l'envoi.
3. **La numérotation « 2. » annonce d'autres prestations.** Le modèle porte donc
   des **catégories** de prestation, chacune avec ses tranches. « Courses Express »
   est la première. ➜ *À demander au client : les sections 1 et 3+.*

---

## 4. Le modèle de données — cible révisée

### 4.1 Les arrêts, partout (arbitrage A)

```
MissionStop
  missionId | requestId   (l'un ou l'autre, jamais les deux)
  position   Int          rang de passage, à partir de 0
  kind       PICKUP | DROPOFF
  label      String
  placeId    FleetPlace?  quand c'est un lieu clé connu
  lat, lng   Float?       quand le géocodage a abouti
  wantedAt   DateTime?    créneau sur cet arrêt
  note       String?
```

> ⚠️ **`Mission.originLabel` et `Mission.destLabel` RESTENT.** Ils deviennent des
> champs **dérivés** : premier et dernier arrêt. Les conserver évite de toucher
> `MissionListeDto`, `MissionEnCoursDto`, l'espace dépôt, les liens publics et
> l'agenda — soit tout ce que le client teste en ce moment. La règle : les arrêts
> sont la source de vérité, les deux libellés en sont le résumé, recalculé à chaque
> écriture.

**Règles de composition** (arbitrage B) :
- Exactement **un** arrêt `PICKUP`, en position 0. C'est l'adresse de chargement.
- **Au moins un** `DROPOFF`. Pas de maximum.
- Le retour au dépôt est un `DROPOFF` **comme un autre** — jamais ajouté d'office.

### 4.2 La tarification

```
MissionPricingSettings          (1 par flotte)
  enabled           Boolean
  vatPct            Int         20 = 20 %
  quoteValidityHours Int        48 par défaut
  quoteFooterNote   String?
  extraStopCents    Int  = 0    supplément par livraison au-delà de la première
  waitingHourCents  Int  = 0    attente sur site, heure entamée
  tiers             MissionPricingTier[]

MissionPricingTier
  settingsId
  category    String            « Courses Express » — libellé libre
  position    Int
  fromKm      Int               borne basse, incluse
  toKm        Int?              borne haute incluse ; NULL = pas de limite
  priceCents  Int?              NULL = « sur devis », aucun calcul automatique
```

Les suppléments sont à **0 par défaut** : modulable, jamais imposé (arbitrage B).

### 4.3 La demande et la négociation

Conservés de la tranche 1, avec ces corrections :
- `MissionRequestStop` **disparaît** au profit de `MissionStop`, partagé.
- `MissionRequest` garde ses trois distances, sa fenêtre souhaitée, son statut, ses
  tours, son montant convenu et son lien vers la mission née.

### 4.4 Les invariants à ne pas perdre

1. **La négociation est un fil.** Chaque proposition est une ligne immuable de
   `MissionQuoteRound`. Le montant courant est le **dernier tour**, jamais un champ
   tenu en parallèle qui divergerait de son historique.
2. **Distances en mètres, montants en centimes**, entiers. Un devis est un calcul
   d'argent ; les flottants dérivent et finissent en facture contestée.
3. **Le devis d'un tour est figé** avec son détail (`breakdown`). Une grille
   modifiée demain ne réécrit pas une offre déjà lue.

---

## 5. Les distances (arbitrage E)

Trois valeurs, et c'est délibéré :

| Champ | Origine |
|---|---|
| `declaredDistanceM` | saisi par le dépôt |
| `estimatedDistanceM` | calculé par le serveur depuis les adresses géocodées |
| `usedDistanceM` | **celui retenu pour le devis**, choisi par le transporteur |

Aucune des deux premières n'a raison d'office : le dépôt connaît ses contraintes de
tournée, le calcul ignore les interdictions de tonnage. Les garder toutes permet de
dire « vous annonciez 40 km, nous en comptons 47 » plutôt que d'imposer un chiffre.

➜ *À vérifier avant de coder : le projet a-t-il déjà un service de géocodage
utilisable (`apps/api/src/geocode/`, `apps/api/src/geocoding/`) ? Si oui, le
réutiliser ; sinon, `estimatedDistanceM` reste nul et l'écran le dit.*

---

## 6. La machine à états

```
DRAFT ──envoi──► SUBMITTED ──┬─► NEGOTIATING ◄──┐
                             │        │         │
                             │        └─contre──┘  (n tours, alternés)
                             │
                             ├─────► ACCEPTED ──affectation──► CONVERTED
                             │
                             ├─────► REJECTED   (motif obligatoire)
                             └─────► EXPIRED    (échéance du devis)
```

- Le **tour 0** est automatique (auteur `SYSTEM`) sauf en « sur devis ».
- **Qui doit répondre** se lit sur l'auteur du dernier tour.
- `ACCEPTED` fige `agreedAmountCents`. Seule l'affectation mène à `CONVERTED`.
- Une demande `CONVERTED` est **immuable**.

---

## 7. Grille absente : alerter, jamais bloquer (arbitrage J)

Le risque signalé plus tôt — couper la création de mission sans grille aurait rendu
`/agenda` inopérant pour un client en pleine recette — est **écarté par la décision
du client**. On alerte, on ne bloque pas.

| Sans grille remplie et activée | |
|---|---|
| Création de mission | **reste ouverte**. Aucun devis proposé, aucun montant affiché. |
| Centre d'alertes | **une alerte est levée**, à destination de l'administration. |
| Demande côté dépôt | **fermée**, avec le motif à l'écran. |

La distinction tient en une phrase : **une mission sans prix reste une mission ; une
demande sans prix n'a pas d'objet.**

---

## 7bis. La tarification vue des deux côtés

> Conception demandée par le client le 2026-08-13 : « imagine comment mettre en place
> ce système avec le détail côté dépôt et côté fleet admin ».

### Le calcul, en une passe

```
1. distance = somme des segments entre arrêts consécutifs, dans l'ordre saisi
              (le retour n'est un segment QUE si le dépôt a ajouté l'adresse
               de chargement en dernière position — arbitrage H)
2. tranche  = la tranche dont [fromKm, toKm] contient la distance
3. si tranche.priceCents est NULL  ─►  « SUR DEVIS », on s'arrête ici
4. total HT = tranche.priceCents  (+ suppléments, à zéro chez ce client)
5. TVA      = total HT × vatPct / 100
6. TTC      = HT + TVA
```

**Les arrondis se font une seule fois, à la fin**, sur des entiers de centimes. Un
arrondi par ligne produit des totaux qui ne retombent pas sur leurs composantes —
le genre d'écart d'un centime qu'un comptable remonte et que personne ne sait
expliquer six mois plus tard.

### Côté dépôt — le client de notre client

Il ne connaît pas la grille et n'a pas à l'apprendre. Ce qu'il doit comprendre :
**combien, et pourquoi.**

| Moment | Ce qu'il voit |
|---|---|
| Il ajoute ses adresses | La distance cumulée se met à jour à chaque ajout, segment par segment : « Fenouillet → Blagnac 12 km · Blagnac → Muret 31 km · **total 43 km** ». |
| Dès la 1re livraison | Le montant estimé, en **TTC** et en **HT**, avec la tranche atteinte nommée : « tranche 0–50 km ». |
| Il approche d'une borne | Un avertissement discret : « 3 km de plus font passer à la tranche suivante, 169 € au lieu de 79 € ». **C'est ce qui évite l'appel** « pourquoi ai-je payé le double pour 2 km ? ». |
| Au-delà de 400 km | « **Sur devis** — le transporteur vous répondra avec un prix. » Affiché **avant** l'envoi, pas après. |
| Il veut le retour facturé | Une aide explicite : « ajoutez votre adresse de chargement comme dernière livraison ». Jamais fait d'office (arbitrage H). |
| Après envoi | Le devis figé, sa date de validité, et le fil de négociation. |

### Côté fleet admin — notre client

Il connaît sa grille. Ce qu'il doit pouvoir faire : **vérifier, corriger, décider.**

| Moment | Ce qu'il voit |
|---|---|
| À la réception | La demande, le devis calculé, et **le détail ligne à ligne** : distance retenue, tranche appliquée, HT, TVA, TTC. |
| Il doute de la distance | Les **trois** valeurs côte à côte — déclarée par le dépôt, estimée par le serveur, retenue. Il change la retenue ; **le prix se recalcule** et reste **ajustable** (arbitrage I). |
| Il corrige une adresse ou le créneau | Même chose : recalcul, puis ajustement libre. |
| Il envoie sa réponse | Un tour de plus dans le fil, avec ses conditions et son message. |
| Dans les Paramètres | L'éditeur de tranches, avec contrôle des trous et des recouvrements, et un **simulateur** : « pour 87 km → 169 € HT ». Une grille qu'on ne peut pas essayer est une grille qu'on règle à l'aveugle. |

### Ce que la négociation doit garder

Chaque tour porte **les conditions complètes proposées**, pas seulement un montant.
Accepter, c'est accepter **une version précise** — adresses, créneau, distance et
prix ensemble. Un accord sur un prix dont les conditions ont bougé entre-temps n'est
pas un accord.

---

## 8. Le plan d'exécution

Chaque tranche est **livrable et testable seule**. On ne passe à la suivante
qu'après contrôles verts.

### T1 — Modèle de domaine ✅ *(commits `63e1749` puis révision du 2026-08-13)*
- [x] `MissionRequest`, `MissionQuoteRound`, `MissionPricingSettings`
- [x] Tranches tarifaires (`MissionPricingTier`) au lieu du prix/km — § 3
- [x] `MissionStop` PARTAGÉ demande + mission — § 4.1
- [x] `Mission.stops` posé ; `originLabel`/`destLabel` conservés, deviennent dérivés
- [x] `prisma validate` vert
- [ ] Reste à T2 : la contrainte CHECK « requestId XOR missionId »

### T2 — Migration et grille par défaut ✅
- [x] Migration `20260813180000_mission_requests_and_quotes`, **purement additive**
- [x] SQL généré **puis filtré** : le diff embarquait 4 `ALTER TABLE` sans rapport
      — dérive préexistante de la base locale — qui auraient altéré des tables de
      production. Aucune colonne existante n'est touchée.
- [x] Contrainte CHECK « un arrêt appartient à une demande **ou** à une mission »,
      testée dans les deux sens (orphelin et double parent : refusés)
- [x] Grille par défaut écrite pour chaque flotte, `enabled = true`
- [x] Appliquée en local : 5 tables, 9 tranches par flotte, valeurs conformes au § 3
- [ ] ⚠️ **Pas encore déployée en production.** Attendre que T3/T4 rendent la
      fonctionnalité utile — livrer des tables mortes pendant la recette du client
      n'apporte rien et ajoute du risque.

> **Règle de sélection d'une tranche**, écrite dans la migration et à respecter dans
> le moteur : la tranche retenue est **la première, par ordre croissant, dont `toKm`
> est supérieur ou égal à la distance** — ou dont `toKm` est nul. Et **non** un
> encadrement `[fromKm, toKm]` : la grille saute de « 0 à 50 » à « 51 à 100 », ce qui
> laisserait 50,4 km sans tranche. `fromKm` sert l'affichage, `toKm` la décision.

### T3 — Tarification : API + onglet Paramètres ✅ *(sous réserve, cf. ci-dessous)*
- [x] `MissionPricingService` : lecture, écriture, validation des tranches
- [x] Endpoints `GET` / `PUT /missions/pricing` + `GET /missions/pricing/simulate`,
      portée `requiredFleetScope` — le super-admin passe par le sélecteur de la barre
- [x] Page `/missions`, onglet **Paramètres** : éditeur de tranches + simulateur
- [x] 43 tests sur le service : chaque borne de la grille réelle, le trou de 50,4 km,
      l'arrondi au supérieur, « sur devis », grille absente ou désactivée, portée
- [x] Build web vert, 315 tests web, gardes littéraux et accents vertes
- [ ] ⚠️ **NON VÉRIFIÉ DANS LE NAVIGATEUR.** Ni à 375 px, ni sur les contrastes, ni
      sur le comportement réel de l'éditeur. La règle des trois non négociables n'est
      donc PAS honorée sur cet écran. **À faire avant tout déploiement.**
- [ ] L'alerte au centre d'alertes quand la grille manque (arbitrage J) — le service
      répond `PAS_DE_GRILLE`, mais rien ne lève encore d'alerte côté administration.

### T4 — Moteur de devis
- [ ] `QuoteEngine` : distance → tranche → montant HT → suppléments → TVA
- [ ] Détail (`breakdown`) ligne à ligne, figé dans le tour
- [ ] « Sur devis » : aucun tour 0, la demande part sans montant
- [ ] Tests : chaque borne du § 3, les deux côtés de 400 km, grille désactivée

### T5 — Demande côté dépôt
- [ ] Permission `missions_request`, ouverte au rôle **DEPOT** — rôle **fermé par
      construction** : `permissionsForTargetRole` réécrit les défauts, `DepotScopeGuard`
      refuse. Ouvrir proprement, ne pas contourner.
- [ ] Endpoints : créer, modifier un brouillon, envoyer, contre-proposer, accepter,
      refuser, lister
- [ ] Périmètre : un dépôt ne voit **que ses** demandes
- [ ] Modale en **étapes expliquées** (arbitrage F) : trajet → marchandise →
      créneau → devis → envoi
- [ ] Saisie multi-arrêts : ajouter, retirer, réordonner
- [ ] Tests d'isolation, sur le modèle de `verif-depot.ts`

### T6 — Négociation côté transporteur
- [ ] Onglet **Demandes** de `/missions` : file d'attente, tri par ancienneté
- [ ] Fil de négociation : tours, auteurs, montants, messages
- [ ] Accepter / contre-proposer / refuser avec motif
- [ ] Correction de `usedDistanceM` avant de deviser
- [ ] Expiration automatique à l'échéance (tâche planifiée, cf. `MissionStatusService`)

### T7 — Affectation et conversion
- [ ] Choix camion + conducteur, en réutilisant `disponibiliteVehicules`
- [ ] Création de la mission par `MissionsService.creer` — le chemin existant
- [ ] Report des arrêts sur la mission ; libellés composés
- [ ] `CONVERTED`, demande immuable

### T8 — Multi-arrêts dans l'agenda (arbitrage A)
- [ ] `mission-dialog` : plusieurs points de livraison
- [ ] Affichage des arrêts sur la fiche mission et l'espace dépôt
- [ ] Non-régression : liens publics, suivi live, agenda

### T9 — E-mails
- [ ] Demande envoyée → fleet admin
- [ ] Devis / contre-proposition → l'autre partie
- [ ] Accord conclu → les deux
- [ ] Mission affectée → dépôt (l'e-mail existant suffit peut-être)

### T10 — Recette
- [ ] Parcours complet, deux comptes réels
- [ ] Mobile 375 px, modales fermables (le piège de la coque non partagée)
- [ ] Contrastes 4,5:1
- [ ] `pnpm verify` + totaux de tests affichés

---

## 9. Questions ouvertes

| # | Question | Réponse du client — 2026-08-13 |
|---|---|---|
| Q1 | Les autres prestations de la grille ? | **Une seule** : transport de marchandise. Distance = somme des segments. ➜ arbitrage G |
| Q2 | Couper la création de mission sans grille ? | **Non.** Alerte au centre d'alertes, tarification masquée, missions intactes. ➜ arbitrage J |
| Q4 | Supplément par arrêt ? | **Non**, les tranches couvrent tout. Mais la contre-proposition doit pouvoir modifier la demande. ➜ arbitrage I |
| — | Le retour est-il toujours compté ? | **Non** — seulement si le dépôt l'ajoute. ➜ arbitrage H |
| — | Que peut modifier une contre-proposition ? | **Prix et conditions.** ➜ arbitrage I |
| — | Le prix se recalcule-t-il après correction ? | **Oui, puis ajustable.** ➜ arbitrage I |

**Reste ouvert :**

| # | Question | Bloque |
|---|---|---|
| ~~Q3~~ | **Vérifié le 2026-08-14. Réponse : non, pas en l'état.** `geocode/` ne fait que du géocodage **inverse** (lat/lng → adresse) via Nominatim ; il ne sait pas transformer une adresse en coordonnées, et encore moins calculer un itinéraire. Des fonctions de distance à vol d'oiseau existent (`security.util`, `trip-stop-detector`, `driver-unlock`) mais **un vol d'oiseau n'est pas une distance routière** — l'écart courant est de 20 à 40 %, ce qui ferait changer de tranche et donc de prix. <br><br>**Décision** : `estimatedDistanceM` reste nul tant qu'un service de routage n'est pas branché, et l'écran le dit. Le dépôt saisit sa distance, le transporteur la corrige. C'est exactement ce que l'arbitrage E prévoit, et cela ne bloque rien. Un routage (OSRM, ORS) reste possible plus tard : le champ existe déjà. | — |
| Q5 | Qui valide côté transporteur : le fleet admin seul, ou toute personne portant `missions_manage` ? **Défaut retenu faute de réponse** : `missions_manage`, cohérent avec la création de mission. | T6 |

---

## 10. Pièges de ce dépôt, à ne pas repayer

- **Aucun accent grave dans un commentaire de `template:` ou `styles:`** — il termine
  le littéral et casse le build. Payé quatre fois sur ce chantier.
- Les variables déclarées dans `@theme inline` ne sont **pas** émises dans `:root`.
- Feuilles mobiles : toujours `max-height: Xvh; max-height: Xdvh;`.
- Enfants de grille et de flex : `min-width: 0`, sinon défilement horizontal.
- Les sept modales du dépôt partagent la coque `depot-modal`, **déjà conforme**.
  Toute nouvelle modale doit l'utiliser plutôt que porter ses propres styles — c'est
  la duplication qui avait cassé `mission-dialog`.
- Le super-admin a `fleetId = null` : toute lecture passe par `requiredFleetScope`,
  toute écriture exige une société choisie.
